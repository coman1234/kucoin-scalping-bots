import { Worker } from "worker_threads";
import * as path from "path";
import {
  WORKER_COUNT,
  OPTIMIZER_INTERVAL,
  OOS_RATIO,
  MIN_PF_GATE,
  MIN_TRADES,
  WATCH_PAIRS,
  PARAM_GRID,
  DOWNLOAD_TIMEFRAMES,
} from "./config";
import { loadCandles } from "./historical";
import { LearningDB } from "./learningDB";
import { writeBestParams, writeRegimeSnapshot, writeOptimizerStatus } from "./shmWriter";
import { calculateIndicators, classifyRegime } from "./indicators";
import type {
  ParamCombo,
  WorkerRequest,
  WorkerResponse,
  OptimizerStatus,
  BestParams,
  RegimeSnapshot,
  KuCoinCandle,
} from "./types";

// ─── Cartesian product helper ─────────────────────────────────────────────────

function cartesian<T extends Record<string, unknown[]>>(grid: T): Record<keyof T, unknown>[] {
  const keys = Object.keys(grid) as (keyof T)[];
  const results: Record<keyof T, unknown>[] = [{}] as Record<keyof T, unknown>[];

  for (const key of keys) {
    const newResults: Record<keyof T, unknown>[] = [];
    for (const existing of results) {
      for (const val of grid[key]) {
        newResults.push({ ...existing, [key]: val });
      }
    }
    results.length = 0;
    results.push(...newResults);
  }
  return results;
}

function buildParamGrid(): ParamCombo[] {
  return cartesian(PARAM_GRID as Record<string, unknown[]>) as unknown as ParamCombo[];
}

function paramsKey(p: ParamCombo): string {
  return JSON.stringify(p);
}

// ─── Status management ────────────────────────────────────────────────────────

let _status: OptimizerStatus = {
  running:         false,
  runId:           0,
  startedAt:       0,
  pairsDone:       0,
  pairsTotal:      WATCH_PAIRS.length,
  currentPair:     "",
  combosPerSymbol: 0,
  workersActive:   0,
  pairProgress:    {},
  nextRunAt:       0,
  lastRunDurationMs: 0,
  totalOptimizations: 0,
};

export function getStatus(): OptimizerStatus {
  return { ..._status };
}

function pushStatus(update: Partial<OptimizerStatus>): void {
  _status = { ..._status, ...update };
  try { writeOptimizerStatus(_status); } catch { /* non-fatal */ }
}

// ─── Worker pool ──────────────────────────────────────────────────────────────

const WORKER_SCRIPT = path.join(__dirname, "optimizer.worker.js");

function runWorkerPool(requests: WorkerRequest[]): Promise<WorkerResponse[]> {
  return new Promise((resolve) => {
    const results: WorkerResponse[] = [];
    const queue = [...requests];
    let inFlight = 0;
    let idx = 0;

    if (queue.length === 0) { resolve([]); return; }

    function spawnNext() {
      while (inFlight < WORKER_COUNT && idx < queue.length) {
        const req = queue[idx++];
        inFlight++;

        const worker = new Worker(WORKER_SCRIPT);
        worker.on("message", (resp: WorkerResponse) => {
          results.push(resp);
          inFlight--;
          _status.workersActive = inFlight;
          if (idx < queue.length) {
            spawnNext();
          } else if (inFlight === 0) {
            resolve(results);
          }
        });
        worker.on("error", (err) => {
          console.error("[optimizer] Worker error:", err.message);
          inFlight--;
          _status.workersActive = inFlight;
          if (idx < queue.length) {
            spawnNext();
          } else if (inFlight === 0) {
            resolve(results);
          }
        });
        worker.postMessage(req);
      }
      _status.workersActive = inFlight;
    }

    spawnNext();
  });
}

// ─── Single symbol optimization ───────────────────────────────────────────────

async function optimizeSymbol(
  symbol: string,
  db: LearningDB,
  runId: number
): Promise<void> {
  // Load candles for each configured timeframe; pick the best one (most candles)
  let bestCandles: KuCoinCandle[] = [];
  let bestTf = DOWNLOAD_TIMEFRAMES[0];

  for (const tf of DOWNLOAD_TIMEFRAMES) {
    const c = loadCandles(symbol, tf);
    if (c && c.length > bestCandles.length) {
      bestCandles = c;
      bestTf = tf;
    }
  }

  if (bestCandles.length < 100) {
    console.warn(`[optimizer] ${symbol}: insufficient candles (${bestCandles.length}) — skipping`);
    return;
  }

  // Detect current regime
  const recentCandles = bestCandles.slice(-100);
  const ind = calculateIndicators(recentCandles);
  const { regime, adx, atrPct, bbBandwidth } = classifyRegime(recentCandles, ind);

  // Write regime snapshot immediately
  const regimeSnap: RegimeSnapshot = {
    symbol,
    regime,
    adx,
    atrPct,
    bbBandwidth,
    updatedAt: Date.now(),
  };
  writeRegimeSnapshot(regimeSnap);

  // Build full param grid
  const allCombos = buildParamGrid();

  // Get UCB1 scores — sort scored combos by UCB1 (exploitation first), then unscored (exploration)
  const ucbScores = db.getUCBScores(symbol, regime, 0);
  const ucbMap = new Map(ucbScores.map((s) => [s.paramsKey, s.ucbValue]));

  const scoredCombos = allCombos
    .filter((p) => ucbMap.has(paramsKey(p)))
    .sort((a, b) => (ucbMap.get(paramsKey(b)) ?? 0) - (ucbMap.get(paramsKey(a)) ?? 0));

  const unscoredCombos = allCombos.filter((p) => !ucbMap.has(paramsKey(p)));
  const orderedCombos  = [...scoredCombos, ...unscoredCombos];

  pushStatus({
    currentPair: symbol,
    combosPerSymbol: orderedCombos.length,
    pairProgress: {
      ..._status.pairProgress,
      [symbol]: { done: 0, total: orderedCombos.length, status: "running", bestPF: 0, bestWR: 0 },
    },
  });

  // Build worker requests
  const requests: WorkerRequest[] = orderedCombos.map((params, i) => ({
    taskId: `${symbol}-${i}`,
    symbol,
    candles: bestCandles,
    params,
    oosRatio: OOS_RATIO,
  }));

  // Run through worker pool
  const responses = await runWorkerPool(requests);

  // Save results to DB
  let bestOosPF = 0;
  let bestCombo: WorkerResponse | null = null;
  let combosDone = 0;

  for (const resp of responses) {
    combosDone++;

    if (resp.error) continue;

    // Filter: IS must have enough trades and meet PF gate
    if (resp.isMetrics.trades < MIN_TRADES) continue;
    if (resp.isMetrics.profitFactor < MIN_PF_GATE) continue;

    // Save IS record
    db.insertRecord({
      symbol,
      regime,
      paramsKey:    paramsKey(resp.params),
      winRate:      resp.isMetrics.winRate,
      profitFactor: resp.isMetrics.profitFactor,
      expectancy:   resp.isMetrics.expectancy,
      trades:       resp.isMetrics.trades,
      testedAt:     resp.isMetrics.testedAt,
      runId,
      isOOS:        0,
    });

    // Save OOS record
    if (resp.oosMetrics.trades > 0) {
      db.insertRecord({
        symbol,
        regime,
        paramsKey:    paramsKey(resp.params),
        winRate:      resp.oosMetrics.winRate,
        profitFactor: resp.oosMetrics.profitFactor,
        expectancy:   resp.oosMetrics.expectancy,
        trades:       resp.oosMetrics.trades,
        testedAt:     resp.oosMetrics.testedAt,
        runId,
        isOOS:        1,
      });
    }

    // Track best OOS combo
    const oosPF = resp.oosMetrics.profitFactor;
    if (oosPF > bestOosPF && resp.oosMetrics.trades >= MIN_TRADES) {
      bestOosPF  = oosPF;
      bestCombo  = resp;
    }
  }

  // Write best params to SHM
  if (bestCombo) {
    const confidence = Math.min(1, (bestOosPF - 1) / 2); // 0 at PF=1, 1 at PF=3
    const best: BestParams = {
      symbol,
      params:          bestCombo.params,
      metrics:         bestCombo.oosMetrics,
      updatedAt:       Date.now(),
      optimizationRun: runId,
      confidence,
      regime,
    };
    writeBestParams(best);
  }

  pushStatus({
    pairProgress: {
      ..._status.pairProgress,
      [symbol]: {
        done:   combosDone,
        total:  orderedCombos.length,
        status: "done",
        bestPF: bestOosPF,
        bestWR: bestCombo?.oosMetrics.winRate ?? 0,
      },
    },
  });

  console.log(
    `[optimizer] ${symbol} done: ${combosDone}/${orderedCombos.length} combos, ` +
    `best OOS PF=${bestOosPF.toFixed(3)}, regime=${regime}`
  );
}

// ─── Full optimization cycle ──────────────────────────────────────────────────

export async function runNow(): Promise<void> {
  if (_status.running) {
    console.warn("[optimizer] Already running — skipping concurrent run");
    return;
  }

  const db = new LearningDB();
  const runId = db.startRun();
  const startedAt = Date.now();
  let pairsDone = 0;
  let totalCombos = 0;

  pushStatus({
    running:     true,
    runId,
    startedAt,
    pairsDone:   0,
    pairsTotal:  WATCH_PAIRS.length,
    currentPair: "",
    pairProgress: {},
  });

  console.log(`[optimizer] Run #${runId} started — ${WATCH_PAIRS.length} pairs`);

  for (const symbol of WATCH_PAIRS) {
    try {
      await optimizeSymbol(symbol, db, runId);
    } catch (err) {
      console.error(`[optimizer] Error for ${symbol}:`, err);
      pushStatus({
        pairProgress: {
          ..._status.pairProgress,
          [symbol]: {
            done: 0, total: 0,
            status: "error",
            bestPF: 0, bestWR: 0,
          },
        },
      });
    }
    pairsDone++;
    totalCombos += _status.pairProgress[symbol]?.total ?? 0;

    pushStatus({ pairsDone, totalOptimizations: _status.totalOptimizations + 1 });
  }

  const duration = Date.now() - startedAt;
  db.finishRun(runId, pairsDone, totalCombos);
  db.close();

  pushStatus({
    running:           false,
    currentPair:       "",
    workersActive:     0,
    lastRunDurationMs: duration,
    nextRunAt:         Date.now() + OPTIMIZER_INTERVAL,
  });

  console.log(
    `[optimizer] Run #${runId} finished in ${(duration / 1000).toFixed(1)}s — ` +
    `${pairsDone} pairs, ${totalCombos} combos`
  );
}

// ─── Interval loop ─────────────────────────────────────────────────────────────

let _intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startOptimizer(): void {
  console.log(
    `[optimizer] Starting interval loop: every ${OPTIMIZER_INTERVAL / 1000 / 60} min`
  );

  // Run once at startup (defer slightly so the downloader can seed history first)
  setTimeout(() => {
    runNow().catch((e) => console.error("[optimizer] Startup run failed:", e));
  }, 10_000);

  _intervalHandle = setInterval(() => {
    runNow().catch((e) => console.error("[optimizer] Scheduled run failed:", e));
  }, OPTIMIZER_INTERVAL);
}

export function stopOptimizer(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}
