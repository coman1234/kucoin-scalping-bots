/**
 * paramOptimizer.ts — Heitkoetter parameter grid search for scalping-day7
 *
 * Uses 2 years of disk history from bot6.
 * Grid: slAtrMult × tpAtrMult × minScore × RSI zones = ~768 combinations.
 * Fast O(n) sliding-window backtest (no O(n²) slice).
 * Runs in the background; poll getOptimizerState() for progress.
 */

import * as fs          from "node:fs";
import * as path        from "node:path";
import type { CacheCandle } from "./cacheReader";
import { detectBreakout }   from "./breakoutDetector";
import { CONFIG, type TraderConfig, updateConfig } from "./traderConfig";
import { getCandlesForPair }                       from "./historicalDataStore";

// ── Optimisation pairs & timeframe ─────────────────────────────────────────
export const OPT_PAIRS = [
  "BTC-USDT","ETH-USDT","SOL-USDT","ADA-USDT","AVAX-USDT",
];
export const OPT_TF     = "5min";
const HISTORY_DAYS      = 90;          // 90 days ≈ 25,920 5min candles/pair
const CANDLES_PER_PAIR  = Math.ceil(HISTORY_DAYS * 24 * 12);  // 25,920
const INDICATOR_WINDOW  = 100;         // sliding window passed to detectBreakout

// ── Parameter grid ─────────────────────────────────────────────────────────
const GRID = {
  slAtrMult:  [0.75, 1.0, 1.25, 1.5],
  tpAtrMult:  [1.0, 1.5, 2.0, 2.5],
  minScore:   [1, 2, 3],
  rsiBullLo:  [45, 50],
  rsiBullHi:  [68, 72],
  rsiBearLo:  [28, 32],
  rsiBearHi:  [45, 50],
};

// ── Result types ────────────────────────────────────────────────────────────
export interface OptimResult {
  params:      Partial<TraderConfig>;
  oosPF:       number;
  oosWR:       number;
  isPF:        number;
  isWR:        number;
  totalTrades: number;
  degradation: number;
  score:       number;     // composite = oosPF * oosWR * max(0, 1 - degradation)
  overallPass: boolean;
}

export interface OptimizerState {
  running:    boolean;
  total:      number;
  done:       number;
  pct:        number;
  phase:      string;
  startedAt:  number | null;
  finishedAt: number | null;
  results:    OptimResult[];     // top 20
  bestParams: Partial<TraderConfig> | null;
  error:      string | null;
}

let _state: OptimizerState = {
  running: false, total: 0, done: 0, pct: 0, phase: "idle",
  startedAt: null, finishedAt: null,
  results: [], bestParams: null, error: null,
};

export function getOptimizerState(): OptimizerState {
  return { ..._state };
}

export function startOptimization(): void {
  if (_state.running) return;
  _state = {
    running: true, total: 0, done: 0, pct: 0, phase: "Loading history",
    startedAt: Date.now(), finishedAt: null,
    results: [], bestParams: null, error: null,
  };
  // Use setImmediate so the HTTP response is sent before sync FS reads begin
  setImmediate(() => {
    void _run().catch(e => {
      _state.error     = String(e);
      _state.running   = false;
      _state.phase     = "Error: " + String(e).slice(0, 80);
      _state.finishedAt = Date.now();
    });
  });
}

// ── Fast O(n) single-pair backtest (sliding indicator window) ───────────────
function _fastBacktest(
  symbol:      string,
  tf:          string,
  candles:     CacheCandle[],
  cfg:         TraderConfig,
): { oosPF: number; oosWR: number; isPF: number; isWR: number; trades: number } {

  const minutesPerCandle = tf === "1min" ? 1 : tf === "3min" ? 3 : tf === "5min" ? 5 :
                           tf === "15min" ? 15 : tf === "1hour" ? 60 : 5;
  const maxCandles   = Math.ceil(cfg.maxHoldMinutes / minutesPerCandle);
  const oosStartIdx  = Math.floor(candles.length * cfg.oosSplitRatio);

  const isTrades: number[]  = [];
  const oosTrades: number[] = [];
  let skipUntil = 0;

  for (let i = 60; i < candles.length - maxCandles - 1; i++) {
    if (i < skipUntil) continue;

    // Sliding window — only last INDICATOR_WINDOW candles
    const hist = candles.slice(Math.max(0, i - INDICATOR_WINDOW + 1), i + 1);
    const sig  = detectBreakout(symbol, tf, hist, null);
    if (!sig) continue;

    const isBuy   = sig.direction === "BUY";
    const entry   = candles[i].close;
    const sl      = isBuy ? entry - sig.atr * cfg.slAtrMult : entry + sig.atr * cfg.slAtrMult;
    const tp      = isBuy ? entry + sig.atr * cfg.tpAtrMult : entry - sig.atr * cfg.tpAtrMult;

    let exitReason: "TP" | "SL" | "TIME" = "TIME";
    let held = maxCandles;
    for (let j = i + 1; j < candles.length && j <= i + maxCandles; j++) {
      const { high, low } = candles[j];
      if (isBuy) {
        if (low  <= sl) { exitReason = "SL"; held = j - i; break; }
        if (high >= tp) { exitReason = "TP"; held = j - i; break; }
      } else {
        if (high >= sl) { exitReason = "SL"; held = j - i; break; }
        if (low  <= tp) { exitReason = "TP"; held = j - i; break; }
      }
    }

    const exitIdx   = Math.min(i + held, candles.length - 1);
    const exitPrice = exitReason === "TP" ? tp : exitReason === "SL" ? sl : candles[exitIdx].close;
    let pnlR: number;
    if (exitReason === "TP") {
      pnlR = cfg.tpAtrMult / cfg.slAtrMult;
    } else if (exitReason === "SL") {
      pnlR = -1.0;
    } else {
      pnlR = isBuy
        ? (exitPrice - entry) / (sl > 0 ? Math.abs(entry - sl) : 1)
        : (entry - exitPrice) / (sl > 0 ? Math.abs(sl - entry) : 1);
    }

    if (!isFinite(pnlR)) pnlR = 0;
    if (i < oosStartIdx) isTrades.push(pnlR);
    else                 oosTrades.push(pnlR);

    skipUntil = i + held + 1;
  }

  function m(arr: number[]) {
    if (arr.length === 0) return { pf: 0, wr: 0 };
    const wins = arr.filter(r => r > 0);
    const gp   = wins.reduce((s, r) => s + r, 0);
    const gl   = Math.abs(arr.filter(r => r <= 0).reduce((s, r) => s + r, 0));
    return {
      pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0),
      wr: wins.length / arr.length,
    };
  }

  const is  = m(isTrades);
  const oos = m(oosTrades);
  return { oosPF: oos.pf, oosWR: oos.wr, isPF: is.pf, isWR: is.wr, trades: isTrades.length + oosTrades.length };
}

// ── Core optimisation loop ─────────────────────────────────────────────────
async function _run(): Promise<void> {

  // Build combos
  const combos: Partial<TraderConfig>[] = [];
  for (const sl of GRID.slAtrMult) {
    for (const tp of GRID.tpAtrMult) {
      if (tp <= sl) continue;
      for (const ms of GRID.minScore) {
        for (const rbl of GRID.rsiBullLo) {
          for (const rbh of GRID.rsiBullHi) {
            if (rbh <= rbl) continue;
            for (const rrl of GRID.rsiBearLo) {
              for (const rrh of GRID.rsiBearHi) {
                if (rrh <= rrl) continue;
                combos.push({ slAtrMult: sl, tpAtrMult: tp, minScore: ms,
                              rsiBullLo: rbl, rsiBullHi: rbh,
                              rsiBearLo: rrl, rsiBearHi: rrh });
              }
            }
          }
        }
      }
    }
  }

  // Load data
  const pairData = new Map<string, CacheCandle[]>();
  for (const sym of OPT_PAIRS) {
    const all = getCandlesForPair(sym, OPT_TF);
    const sub = all.length > CANDLES_PER_PAIR ? all.slice(all.length - CANDLES_PER_PAIR) : all;
    if (sub.length >= 500) pairData.set(sym, sub);
  }

  if (pairData.size === 0) {
    throw new Error(`No history found at KUCOIN_HISTORY_DIR. Check env var / data path.`);
  }

  _state.total = combos.length * pairData.size;
  _state.phase = `Grid search: ${combos.length} combos × ${pairData.size} pairs`;
  console.log(`[paramOptimizer] ${_state.phase}`);

  const allResults: OptimResult[] = [];
  let batchSize = 0;

  for (const combo of combos) {
    const cfg: TraderConfig = { ...CONFIG, ...combo };

    let sumOosPF = 0, sumOosWR = 0, sumIsPF = 0, sumIsWR = 0, sumTrades = 0;
    let n = 0;

    for (const [sym, candles] of pairData) {
      const r = _fastBacktest(sym, OPT_TF, candles, cfg);
      sumOosPF  += r.oosPF;
      sumOosWR  += r.oosWR;
      sumIsPF   += r.isPF;
      sumIsWR   += r.isWR;
      sumTrades += r.trades;
      n++;
      _state.done++;
    }

    if (n === 0) continue;

    const oosPF = sumOosPF / n;
    const oosWR = sumOosWR / n;
    const isPF  = sumIsPF  / n;
    const degr  = isPF > 0 ? (isPF - oosPF) / isPF : 1;
    const score = oosPF * oosWR * Math.max(0, 1 - degr);

    const { benchmarkPfMin, benchmarkPfMax, benchmarkWrMin, benchmarkWrMax } = CONFIG;
    const pfPass = oosPF >= benchmarkPfMin && oosPF <= benchmarkPfMax;
    const wrPass = oosWR >= benchmarkWrMin && oosWR <= benchmarkWrMax;

    allResults.push({
      params: combo, oosPF, oosWR, isPF, isWR: sumIsWR / n,
      totalTrades: sumTrades, degradation: degr, score,
      overallPass: pfPass && wrPass && degr < 0.30,
    });

    // Update state & yield every 10 combos
    _state.pct = Math.round((_state.done / _state.total) * 100);
    batchSize++;
    if (batchSize >= 10) {
      batchSize = 0;
      const top = [...allResults].sort((a, b) => b.score - a.score).slice(0, 5);
      _state.results = top;
      if (top.length > 0) _state.bestParams = top[0].params;
      await new Promise(r => setTimeout(r, 0));  // yield to event loop
    }
  }

  // Final ranking
  allResults.sort((a, b) => b.score - a.score);
  _state.results    = allResults.slice(0, 20);
  _state.bestParams = allResults.length > 0 ? allResults[0].params : null;

  const passing = allResults.filter(r => r.overallPass).length;
  _state.phase     = `Complete — ${passing}/${allResults.length} combos passed Heitkoetter benchmarks`;
  _state.running   = false;
  _state.finishedAt = Date.now();

  console.log(`[paramOptimizer] ${_state.phase}`);
  if (_state.bestParams) {
    console.log(`[paramOptimizer] Best params:`, JSON.stringify(_state.bestParams));
  }

  // Persist to disk
  try {
    const out = path.join(process.cwd(), "data", "optimizer-results.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      runAt: Date.now(), pairs: OPT_PAIRS, tf: OPT_TF, top20: allResults.slice(0, 20),
      bestParams: _state.bestParams,
    }, null, 2));
    console.log(`[paramOptimizer] Results saved to ${out}`);
  } catch (e) {
    console.warn("[paramOptimizer] Save failed:", e);
  }
}
