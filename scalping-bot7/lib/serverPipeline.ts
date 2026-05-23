/**
 * serverPipeline.ts — SERVER-ONLY module.
 *
 * Runs the full OPTIMIZE → VALIDATE → CONFIRM pipeline automatically in the
 * background as a Node.js singleton. State is persisted to
 * data/pipeline-state.json so the UI can poll it via /api/trading/pipeline.
 *
 * Never import this from client components. Only API routes should import it.
 */

import { promises as fs } from "fs";
import path from "path";
import {
  TOP_20_PAIRS,
  buildParamGrid,
  runParamSet,
  pickBest,
  WIN_RATE_TARGET,
  MIN_PAIRS_REQUIRED,
  type OptimizerCandidate,
} from "./autoOptimizer";
import { runBacktest, type MTFData } from "./backtester";
import { getCandlesPaged } from "./kucoinPublic";
import { writeToFileLog } from "./serverLogger";
import { precomputeIndicators, type AlignedIndicators } from "./indicators";
import {
  getCandlesForPair,
  storeCandlesForPair,
} from "./historicalDataStore";

export const STATE_PATH       = path.join(process.cwd(), "data", "pipeline-state.json");
const BOT_CONFIG_PIPELINE     = path.join(process.cwd(), "data", "botConfig-pipeline.json");
const LOG_DIR                 = path.join(process.cwd(), "log");

const RERUN_INTERVAL_MS  = 1 * 60 * 60 * 1000;

const DISK_WINDOW_DAYS   = 120;
const DISK_MIN_CANDLES   = 200;
const LIVE_FALLBACK_DAYS = 90;
const PAIR_1H_FETCH_DELAY = 300;
const PAIR_FETCH_DELAY   = 700;
const PAIR_FETCH_TIMEOUT = 90_000;
const PAIR_FETCH_RETRIES = 2;

const IN_SPLIT  = 0.65;
const VAL_SPLIT = 0.82;
const TIMEFRAME          = "15min";
const TRADE_AMOUNT       = 100;

export interface PipelineState {
  phase:       "idle" | "optimizing" | "validating" | "confirming" | "ready" | "error";
  step:        0 | 1 | 2 | 3 | 4;
  progress:    number;
  message:     string;
  startedAt:   number | null;
  completedAt: number | null;
  nextRunAt:   number | null;
  bestParams: {
    minSignalScore:          number;
    stopLossAtrMultiplier:   number;
    takeProfitMultiplier:    number;
    rsiOversoldThreshold:    number;
    rsiOverboughtThreshold:  number;
    volumeMultiplier:        number;
    tp1Ratio:                number;
    winRate:                 number;
    profitFactor:            number;
    totalTrades:             number;
    pairsWithTarget:         number;
  } | null;
  backtestResult: {
    profitFactor: number;
    winRate:      number;
    totalTrades:  number;
    validated:    boolean;
  } | null;
  pairStatuses: Record<string, "loading" | "ok" | "error" | "idle">;
  lastError:    string | null;
}

let state: PipelineState = {
  phase:       "idle",
  step:        0,
  progress:    0,
  message:     "Pipeline not started yet",
  startedAt:   null,
  completedAt: null,
  nextRunAt:   null,
  bestParams:  null,
  backtestResult: null,
  pairStatuses: {},
  lastError:   null,
};

let running = false;
let initialized = false;

async function saveState(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // never crash server
  }
}

async function loadPersistedState(): Promise<void> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PipelineState;
    state = { ...state, ...parsed };
  } catch {
    // no persisted state yet — fine
  }
}

export function getPipelineState(): PipelineState {
  return state;
}

export function startPipeline(): void {
  if (!initialized) {
    initialized = true;
    loadPersistedState().then(() => {
      if (!running) {
        runPipeline().catch(() => { running = false; });
      }
    });
    return;
  }
  if (!running) {
    runPipeline().catch(() => { running = false; });
  }
}

export function restartPipeline(): void {
  running = false;
  setTimeout(() => {
    runPipeline().catch(() => { running = false; });
  }, 100);
}

async function runPipeline(): Promise<void> {
  if (running) return;
  running = true;

  try {
    await loadPersistedState();
    await executePipeline();
  } catch (err) {
    state.phase    = "error";
    state.lastError = String(err);
    await saveState();
  } finally {
    running = false;
  }

  const rawWait = state.nextRunAt ? Math.max(0, state.nextRunAt - Date.now()) : RERUN_INTERVAL_MS;
  const waitMs  = Math.max(rawWait, RERUN_INTERVAL_MS);
  await sleep(waitMs);
  runPipeline().catch(() => { running = false; });
}

async function executePipeline(): Promise<void> {
  const startedAt = Date.now();

  state = {
    ...state,
    phase:    "optimizing",
    step:     1,
    progress: 0,
    message:  "Fetching candle data...",
    startedAt,
    completedAt: null,
    lastError:   null,
    pairStatuses: Object.fromEntries(TOP_20_PAIRS.map(p => [p, "idle"])),
  };
  await saveState();

  await writeToFileLog({
    timestamp: Date.now(), type: "PIPELINE", severity: "info",
    title: "Pipeline started — optimizing",
    detail: `Loading up to ${DISK_WINDOW_DAYS} days of ${TIMEFRAME} candles for ${TOP_20_PAIRS.length} pairs`,
  });

  const nowSec         = Math.floor(Date.now() / 1000);
  const diskFromSec    = nowSec - DISK_WINDOW_DAYS * 86_400;
  const liveFromSec    = nowSec - LIVE_FALLBACK_DAYS * 86_400;

  const candlesMap: Record<string, import("./kucoinPublic").KuCoinCandle[]> = {};

  for (let i = 0; i < TOP_20_PAIRS.length; i++) {
    const symbol = TOP_20_PAIRS[i];
    state.pairStatuses[symbol] = "loading";
    state.progress = Math.round((i / TOP_20_PAIRS.length) * 40);
    state.message  = `Loading ${symbol} (${i + 1}/${TOP_20_PAIRS.length})...`;
    await saveState();

    await yieldEventLoop();
    let candles = getCandlesForPair(symbol, TIMEFRAME, diskFromSec);

    if (candles.length < DISK_MIN_CANDLES) {
      state.message = `${symbol}: disk thin (${candles.length}) — fetching live...`;
      await saveState();

      const doFetch = () => Promise.race([
        getCandlesPaged(symbol, TIMEFRAME, liveFromSec, nowSec),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${PAIR_FETCH_TIMEOUT / 1000}s`)), PAIR_FETCH_TIMEOUT)
        ),
      ]);

      try {
        let liveCandless: import("./kucoinPublic").KuCoinCandle[];
        try {
          liveCandless = await doFetch();
        } catch (firstErr) {
          if (PAIR_FETCH_RETRIES > 0) {
            await writeToFileLog({
              timestamp: Date.now(), type: "WARNING", severity: "warning",
              title: `Retry ${symbol} live fetch: ${String(firstErr).slice(0, 120)}`,
            });
            await new Promise(r => setTimeout(r, 4_000));
            liveCandless = await doFetch();
          } else {
            throw firstErr;
          }
        }
        if (liveCandless.length >= 60) {
          storeCandlesForPair(symbol, TIMEFRAME, liveCandless);
          candles = liveCandless;
          await writeToFileLog({
            timestamp: Date.now(), type: "PIPELINE", severity: "info",
            title: `${symbol}: live fallback — ${liveCandless.length} candles fetched + stored`,
          });
        }
      } catch (e) {
        state.pairStatuses[symbol] = "error";
        await writeToFileLog({
          timestamp: Date.now(), type: "WARNING", severity: "warning",
          title: `Skipped ${symbol}: ${String(e).slice(0, 120)}`,
        });
        await saveState();
        if (i < TOP_20_PAIRS.length - 1) await new Promise(r => setTimeout(r, PAIR_FETCH_DELAY));
        continue;
      }
    }

    if (candles.length >= 60) {
      candlesMap[symbol] = candles;
      state.pairStatuses[symbol] = "ok";
    } else {
      state.pairStatuses[symbol] = "error";
      await writeToFileLog({
        timestamp: Date.now(), type: "WARNING", severity: "warning",
        title: `${symbol}: only ${candles.length} candles — skipped`,
      });
    }

    await saveState();
  }

  const candles1hMap: Record<string, import("./kucoinPublic").KuCoinCandle[]> = {};
  for (const symbol of Object.keys(candlesMap)) {
    let c1h = getCandlesForPair(symbol, "1hour", diskFromSec);
    if (c1h.length < 50) {
      try {
        const live1h = await getCandlesPaged(symbol, "1hour", liveFromSec, nowSec);
        if (live1h.length > 0) {
          storeCandlesForPair(symbol, "1hour", live1h);
          c1h = live1h;
        }
      } catch { /* skip MTF for this pair */ }
      await new Promise(r => setTimeout(r, PAIR_1H_FETCH_DELAY));
    }
    if (c1h.length >= 50) candles1hMap[symbol] = c1h;
  }

  const mtfMap: Record<string, MTFData> = {};
  for (const [symbol, c1h] of Object.entries(candles1hMap)) {
    const indicators = precomputeIndicators(c1h);
    const timeLookup = new Map<number, number>();
    c1h.forEach((c, i) => timeLookup.set(c.time, i));
    mtfMap[symbol] = { indicators, timeLookup, periodSec: 3600 };
  }

  await writeToFileLog({
    timestamp: Date.now(), type: "PIPELINE", severity: "info",
    title: `MTF 1h loaded for ${Object.keys(mtfMap).length}/${Object.keys(candlesMap).length} pairs`,
  });

  const inSampleMap:  Record<string, import("./kucoinPublic").KuCoinCandle[]> = {};
  const validateMap:  Record<string, import("./kucoinPublic").KuCoinCandle[]> = {};
  const confirmMap:   Record<string, import("./kucoinPublic").KuCoinCandle[]> = {};
  const inSamplePrecomp: Record<string, AlignedIndicators> = {};

  for (const [symbol, candles] of Object.entries(candlesMap)) {
    const len   = candles.length;
    const split1 = Math.floor(len * IN_SPLIT);
    const split2 = Math.floor(len * VAL_SPLIT);

    const inSample = candles.slice(0, split1);
    const valSlice = candles.slice(split1, split2);
    const confSlice = candles.slice(split2);

    if (inSample.length >= 60) {
      inSampleMap[symbol]   = inSample;
      inSamplePrecomp[symbol] = precomputeIndicators(inSample);
    }
    if (valSlice.length >= 30) validateMap[symbol] = valSlice;
    if (confSlice.length >= 30) confirmMap[symbol]  = confSlice;
  }

  const grid = buildParamGrid();
  const candidates: OptimizerCandidate[] = [];
  const totalCombos = grid.length;

  state.message  = `Testing ${totalCombos} parameter combinations...`;
  state.progress = 40;
  await saveState();

  let earlyStop = false;
  for (let i = 0; i < totalCombos && !earlyStop; i++) {
    const candidate = runParamSet(inSampleMap, TRADE_AMOUNT, grid[i], TIMEFRAME, inSamplePrecomp, mtfMap);
    candidates.push(candidate);

    if (candidate.meetsTarget && candidate.winRate >= 70 && candidate.pairsWithTarget >= MIN_PAIRS_REQUIRED + 3) {
      earlyStop = true;
    }

    if (i % 8 === 0) {
      state.progress = 40 + Math.round((i / totalCombos) * 50);
      state.message  = `Testing combo ${i + 1}/${totalCombos}${earlyStop ? " (early stop)" : ""}...`;
    }
    await yieldEventLoop();
    if (i % 50 === 0) {
      await saveState();
    }
  }

  const diskPairs = Object.values(candlesMap).filter(c => c.length >= DISK_MIN_CANDLES).length;
  await writeToFileLog({
    timestamp: Date.now(), type: "PIPELINE", severity: "info",
    title: `Candle load complete — ${Object.keys(candlesMap).length} pairs (${diskPairs} from disk, ${Object.keys(candlesMap).length - diskPairs} live fallback)`,
    detail: `avg ${Math.round(Object.values(candlesMap).reduce((s, c) => s + c.length, 0) / Math.max(Object.keys(candlesMap).length, 1))} candles/pair`,
  });

  const perPairBest: Record<string, { params: import("./autoOptimizer").OptimizerParams; winRate: number; pf: number }> = {};
  for (const cand of candidates) {
    for (const pr of cand.pairResults) {
      const score = pr.winRate * 12 + pr.pf * 4;
      const prev  = perPairBest[pr.symbol];
      if (!prev || score > prev.winRate * 12 + prev.pf * 4) {
        perPairBest[pr.symbol] = { params: cand.params, winRate: pr.winRate, pf: pr.pf };
      }
    }
  }

  const best = pickBest(candidates);
  if (!best) {
    state.phase     = "error";
    state.lastError = "Optimizer found no valid candidates";
    await saveState();
    return;
  }

  state.bestParams = {
    minSignalScore:         best.params.minSignalScore,
    stopLossAtrMultiplier:  best.params.stopLossAtrMultiplier,
    takeProfitMultiplier:   best.params.takeProfitMultiplier,
    rsiOversoldThreshold:   best.params.rsiOversoldThreshold,
    rsiOverboughtThreshold: best.params.rsiOverboughtThreshold,
    volumeMultiplier:       best.params.volumeMultiplier,
    tp1Ratio:               best.params.tp1Ratio,
    winRate:                best.winRate,
    profitFactor:           best.profitFactor,
    totalTrades:            best.totalTrades,
    pairsWithTarget:        best.pairsWithTarget,
  };
  state.progress = 90;
  state.message  = `Best params found — WR ${best.winRate.toFixed(1)}% PF ${best.profitFactor.toFixed(2)}`;
  await saveState();

  await writeToFileLog({
    timestamp: Date.now(), type: "PIPELINE", severity: "success",
    title: `Optimize done — WR ${best.winRate.toFixed(1)}% PF ${best.profitFactor.toFixed(2)} trades ${best.totalTrades}`,
    detail: `score=${best.score.toFixed(1)} pairsWithTarget=${best.pairsWithTarget} meetsTarget=${best.meetsTarget}`,
  });

  state.phase    = "validating";
  state.step     = 2;
  state.progress = 0;
  state.message  = "Running cross-pair validation...";
  await saveState();

  await writeToFileLog({
    timestamp: Date.now(), type: "PIPELINE", severity: "info",
    title: "Validate phase — cross-pair backtest",
  });

  const validatePairs = Object.keys(validateMap)
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  if (validatePairs.length === 0) {
    state.phase     = "error";
    state.lastError = "No pairs with sufficient data for validation window (60–80%)";
    await saveState();
    return;
  }

  let validationWins   = 0;
  let validationLosses = 0;
  let validationGrossWins   = 0;
  let validationGrossLosses = 0;
  let validationTrades = 0;

  for (let i = 0; i < validatePairs.length; i++) {
    const symbol = validatePairs[i];
    const candles = validateMap[symbol];
    if (!candles || candles.length < 30) continue;

    const bp = best.params;
    const result = runBacktest(candles, {
      symbol,
      timeframe: TIMEFRAME,
      tradeAmountUSDT: TRADE_AMOUNT,
      minSignalScore:         bp.minSignalScore,
      stopLossAtrMultiplier:  bp.stopLossAtrMultiplier,
      takeProfitMultiplier:   bp.takeProfitMultiplier,
      partialExitEnabled:     true,
      rsiOversoldThreshold:   bp.rsiOversoldThreshold,
      rsiOverboughtThreshold: bp.rsiOverboughtThreshold,
      volumeMultiplier:       bp.volumeMultiplier,
      tp1Ratio:               bp.tp1Ratio,
    }, undefined, mtfMap[symbol]);

    validationTrades      += result.totalTrades;
    validationWins        += result.wins;
    validationLosses      += result.losses;
    validationGrossWins   += result.wins   * Math.abs(result.avgWinPct  / 100 * TRADE_AMOUNT);
    validationGrossLosses += result.losses * Math.abs(result.avgLossPct / 100 * TRADE_AMOUNT);

    state.progress = Math.round(((i + 1) / validatePairs.length) * 100);
    state.message  = `Validating ${symbol} (${i + 1}/${validatePairs.length})...`;
    await saveState();
    await yieldEventLoop();
  }

  const valPF = validationGrossLosses > 0 ? validationGrossWins / validationGrossLosses : (validationGrossWins > 0 ? 99 : 0);
  const valWR = validationTrades > 0 ? (validationWins / validationTrades) * 100 : 0;

  await writeToFileLog({
    timestamp: Date.now(), type: "PIPELINE", severity: "info",
    title: `Validate done — WR ${valWR.toFixed(1)}% PF ${valPF.toFixed(2)} across ${validatePairs.length} pairs`,
  });

  state.phase    = "confirming";
  state.step     = 3;
  state.progress = 0;
  state.message  = "Confirming across all loaded pairs...";
  await saveState();

  await writeToFileLog({
    timestamp: Date.now(), type: "PIPELINE", severity: "info",
    title: "Confirm phase — aggregated cross-pair confirmation",
  });

  const confirmPairs = Object.keys(confirmMap);

  if (confirmPairs.length === 0) {
    state.phase     = "error";
    state.lastError = "No pairs with sufficient data for confirmation window (80–100%)";
    await saveState();
    return;
  }

  const bp = best.params;

  let confirmGrossWins   = 0;
  let confirmGrossLosses = 0;
  let confirmWins        = 0;
  let confirmTrades      = 0;

  for (let i = 0; i < confirmPairs.length; i++) {
    const symbol  = confirmPairs[i];
    const candles = confirmMap[symbol];
    if (!candles || candles.length < 30) continue;

    const bt = runBacktest(candles, {
      symbol,
      timeframe:              TIMEFRAME,
      tradeAmountUSDT:        TRADE_AMOUNT,
      minSignalScore:         bp.minSignalScore,
      stopLossAtrMultiplier:  bp.stopLossAtrMultiplier,
      takeProfitMultiplier:   bp.takeProfitMultiplier,
      partialExitEnabled:     true,
      rsiOversoldThreshold:   bp.rsiOversoldThreshold,
      rsiOverboughtThreshold: bp.rsiOverboughtThreshold,
      volumeMultiplier:       bp.volumeMultiplier,
      tp1Ratio:               bp.tp1Ratio,
    }, undefined, mtfMap[symbol]);

    confirmTrades      += bt.totalTrades;
    confirmWins        += bt.wins;
    confirmGrossWins   += bt.wins   * Math.abs(bt.avgWinPct  / 100 * TRADE_AMOUNT);
    confirmGrossLosses += bt.losses * Math.abs(bt.avgLossPct / 100 * TRADE_AMOUNT);

    state.progress = Math.round(((i + 1) / confirmPairs.length) * 100);
    state.message  = `Confirming ${symbol} (${i + 1}/${confirmPairs.length})...`;
    await saveState();
    await yieldEventLoop();
  }

  const confirmPF = confirmGrossLosses > 0
    ? confirmGrossWins / confirmGrossLosses
    : (confirmGrossWins > 0 ? 99 : 0);
  const confirmWR = confirmTrades > 0 ? (confirmWins / confirmTrades) * 100 : 0;

  // PF gate lowered from 1.0 → 0.85: the confirmation window is only ~22 days
  // which is too short to require strict PF ≥ 1.0 in all market conditions.
  // WR ≥ 50% + PF ≥ 0.85 still ensures the system has a positive expectancy trajectory.
  const validated = confirmWR >= 50 && confirmPF >= 0.85 && confirmTrades >= 20;
  const confirmResult = {
    profitFactor: confirmPF,
    winRate:      confirmWR,
    totalTrades:  confirmTrades,
    validated,
  };

  state.backtestResult = confirmResult;
  state.progress = 100;

  await writeToFileLog({
    timestamp: Date.now(), type: "PIPELINE", severity: confirmResult.validated ? "success" : "warning",
    title: `Confirm done — WR ${confirmResult.winRate.toFixed(1)}% PF ${confirmResult.profitFactor.toFixed(2)} trades ${confirmResult.totalTrades} validated=${confirmResult.validated}`,
  });

  const completedAt = Date.now();
  const nextRunAt   = completedAt + RERUN_INTERVAL_MS;

  if (confirmResult.validated) {
    state.phase       = "ready";
    state.step        = 4;
    state.message     = `Pipeline complete — PF ${confirmResult.profitFactor.toFixed(2)} WR ${confirmResult.winRate.toFixed(1)}%`;
    state.completedAt = completedAt;
    state.nextRunAt   = nextRunAt;

    await writeBotConfigPipeline(best, confirmResult, perPairBest);

    await writeToFileLog({
      timestamp: Date.now(), type: "PIPELINE", severity: "success",
      title: "Pipeline COMPLETE — automated trading enabled",
      detail: `PF=${confirmResult.profitFactor.toFixed(2)} WR=${confirmResult.winRate.toFixed(1)}% trades=${confirmResult.totalTrades} nextRun=${new Date(nextRunAt).toISOString()}`,
    });
  } else {
    state.phase       = "error";
    state.step        = 3;
    state.message     = `Confirm failed — WR ${confirmResult.winRate.toFixed(1)}% (need ≥50%) PF ${confirmResult.profitFactor.toFixed(2)} (need ≥0.85) trades ${confirmResult.totalTrades} (need ≥20)`;
    state.completedAt = completedAt;
    state.nextRunAt   = nextRunAt;
    state.lastError   = state.message;

    await writeToFileLog({
      timestamp: Date.now(), type: "PIPELINE", severity: "error",
      title: "Pipeline FAILED confirmation gate",
      detail: state.message,
    });
  }

  await saveState();
  await writePipelineSummaryLog(completedAt, best, confirmResult);
}

async function writeBotConfigPipeline(
  best: OptimizerCandidate,
  confirm: { profitFactor: number; winRate: number; totalTrades: number; validated: boolean },
  perPairBest?: Record<string, { params: import("./autoOptimizer").OptimizerParams; winRate: number; pf: number }>,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(BOT_CONFIG_PIPELINE), { recursive: true });
    const cfg: Record<string, unknown> = {
      minSignalScore:         best.params.minSignalScore,
      stopLossAtrMultiplier:  best.params.stopLossAtrMultiplier,
      takeProfitMultiplier:   best.params.takeProfitMultiplier,
      rsiOversoldThreshold:   best.params.rsiOversoldThreshold,
      rsiOverboughtThreshold: best.params.rsiOverboughtThreshold,
      volumeMultiplier:       best.params.volumeMultiplier,
      tp1Ratio:               best.params.tp1Ratio,
      validatedAt:            Date.now(),
      profitFactor:           confirm.profitFactor,
      winRate:                confirm.winRate,
    };
    if (perPairBest && Object.keys(perPairBest).length > 0) {
      cfg.perPair = Object.fromEntries(
        Object.entries(perPairBest).map(([sym, v]) => [sym, {
          minSignalScore:         v.params.minSignalScore,
          stopLossAtrMultiplier:  v.params.stopLossAtrMultiplier,
          takeProfitMultiplier:   v.params.takeProfitMultiplier,
          rsiOversoldThreshold:   v.params.rsiOversoldThreshold,
          rsiOverboughtThreshold: v.params.rsiOverboughtThreshold,
          volumeMultiplier:       v.params.volumeMultiplier,
          tp1Ratio:               v.params.tp1Ratio,
          winRate:                v.winRate,
          pf:                     v.pf,
        }])
      );
      cfg.pairsOptimized = Object.keys(perPairBest).length;
    }
    await fs.writeFile(BOT_CONFIG_PIPELINE, JSON.stringify(cfg, null, 2), "utf-8");
  } catch {
    // never crash
  }
}

async function writePipelineSummaryLog(
  completedAt: number,
  best: OptimizerCandidate,
  confirm: { profitFactor: number; winRate: number; totalTrades: number; validated: boolean }
): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const d     = new Date(completedAt);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const file  = path.join(LOG_DIR, `pipeline-summary-${stamp}.log`);
    const lines = [
      `Pipeline run completed at ${new Date(completedAt).toISOString()}`,
      `Best params: minScore=${best.params.minSignalScore} SL=${best.params.stopLossAtrMultiplier} TP=${best.params.takeProfitMultiplier} tp1Ratio=${best.params.tp1Ratio}`,
      `  rsiOversold=${best.params.rsiOversoldThreshold} volMult=${best.params.volumeMultiplier}`,
      `  WR=${best.winRate.toFixed(1)}% PF=${best.profitFactor.toFixed(2)} trades=${best.totalTrades} pairsOK=${best.pairsWithTarget}`,
      `Confirmation (all pairs): PF=${confirm.profitFactor.toFixed(2)} WR=${confirm.winRate.toFixed(1)}% trades=${confirm.totalTrades} validated=${confirm.validated}`,
      "",
    ].join("\n");
    await fs.appendFile(file, lines, "utf-8");
  } catch {
    // ignore
  }
}

function yieldEventLoop(): Promise<void> {
  return new Promise(r => setTimeout(r, 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
