/**
 * paramOptimizer.ts — Fast pre-computation Heitkoetter parameter grid search
 *
 * Architecture vs previous sliding-window approach:
 *   OLD: for each of 25,920 candles × 576 combos → call computeBundle() (heavy)
 *        = 14,929,920 heavy indicator computations → timed out in 86 min at 10%
 *
 *   NEW: 1. Call computeBundle() ONCE per pair on full 25,920-candle array → O(n)
 *        2. Pre-filter to gate-passing candles → Feature[] (only G1+G2 passing)
 *        3. Grid search: per combo, evaluate only C2 RSI threshold + minScore
 *           on pre-filtered Feature[], then simulate exit → O(signals × maxCandles)
 *
 * Expected runtime: ~30 s for 576 combos × 5 pairs (vs 14 h+ with old approach)
 */

import * as fs            from "node:fs";
import * as path          from "node:path";
import type { CacheCandle }  from "./cacheReader";
import { computeBundle }     from "./indicators";
import { CONFIG, type TraderConfig } from "./traderConfig";
import { getCandlesForPair }          from "./historicalDataStore";

// ── Disk persistence ───────────────────────────────────────────────────────
const STATE_FILE   = path.join(process.cwd(), "data", "optimizer-state.json");
const RESULTS_FILE = path.join(process.cwd(), "data", "optimizer-results.json");

function _flushState(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state), "utf8");
  } catch { /* non-critical */ }
}

// ── Optimisation config ────────────────────────────────────────────────────
export const OPT_PAIRS = [
  "BTC-USDT", "ETH-USDT", "SOL-USDT", "ADA-USDT", "AVAX-USDT",
];
export const OPT_TF    = "5min";
const HISTORY_DAYS     = 90;                              // 90 d ≈ 25,920 candles
const CANDLES_PER_PAIR = Math.ceil(HISTORY_DAYS * 24 * 12);
const MIN_CANDLES      = 500;
const OOS_SPLIT        = 0.6;   // 60 % IS / 40 % OOS

// ── Parameter grid ─────────────────────────────────────────────────────────
const GRID = {
  slAtrMult: [0.75, 1.0, 1.25, 1.5],
  tpAtrMult: [1.0,  1.5, 2.0,  2.5],
  minScore:  [1, 2, 3],
  rsiBullLo: [45, 50],
  rsiBullHi: [68, 72],
  rsiBearLo: [28, 32],
  rsiBearHi: [45, 50],
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
  score:       number;      // oosPF × oosWR × max(0, 1 − degradation)
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
  results:    OptimResult[];
  bestParams: Partial<TraderConfig> | null;
  error:      string | null;
}

let _state: OptimizerState = {
  running: false, total: 0, done: 0, pct: 0, phase: "idle",
  startedAt: null, finishedAt: null,
  results: [], bestParams: null, error: null,
};

export function getOptimizerState(): OptimizerState {
  if (_state.running) return { ..._state };
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as OptimizerState;
    }
  } catch { /* fall through */ }
  return { ..._state };
}

// ── Pre-computed per-candle feature ────────────────────────────────────────
/**
 * One entry per candle where G1 (EMA trend) AND G2 (BB breakout) both pass.
 * Fixed booleans c1 / c3 are computed once here.
 * Variable c2 (RSI zone) is evaluated per combo inside _evalCombo().
 */
interface Feature {
  i:     number;           // source candle index
  dir:   "BUY" | "SELL";
  rsi:   number;           // raw RSI — checked against per-combo thresholds
  atr:   number;           // ATR value — for SL/TP sizing
  close: number;           // entry price
  c1:    boolean;          // ATR elevated + expanding (fixed per candle)
  c3:    boolean;          // OBV aligned + vol surge  (fixed per candle)
}

/**
 * Call computeBundle ONCE on the full candle array, then walk the resulting
 * indicator arrays to build Feature[] (only gate-passing candles included).
 */
function _precompute(candles: CacheCandle[]): Feature[] {
  const ind = computeBundle(candles);
  if (!ind) return [];

  const n = candles.length;

  // Indicator arrays (may be shorter than n due to warmup)
  const ema9Arr  = ind.ema9             as number[];
  const ema21Arr = ind.ema21            as number[];
  const bbUp     = ind.bb.upper         as number[];
  const bbLo     = ind.bb.lower         as number[];
  const rsiArr   = ind.rsi              as number[];
  const atrArr   = ind.atr.atr          as number[];
  const atrMAArr = ind.atr.atrMA        as number[];
  const expArr   = ind.atr.expanding    as boolean[];
  const obvArr   = ind.obv.obv          as number[];
  const obvMAArr = ind.obv.obvMA        as number[];

  // Offset = how many leading candles each array has "consumed" during warmup.
  // For an array of length L computed from n candles: offset = n - L.
  // array[idx] then corresponds to candle[idx + offset].
  const ema9Off  = n - ema9Arr.length;   // emaTrendFast − 1 = 8
  const ema21Off = n - ema21Arr.length;  // emaTrendSlow − 1 = 20
  const bbOff    = n - bbUp.length;      // BB period − 1 = 19
  const rsiOff   = n - rsiArr.length;    // RSI period = 14
  const atrOff   = n - atrArr.length;    // ATR period − 1 = 13
  const atrMAOff = n - atrMAArr.length;  // atrOff + (MA period − 1) = 32
  const obvOff   = n - obvArr.length;    // typically 0 (OBV has no warmup)
  const obvMAOff = n - obvMAArr.length;  // OBV MA period − 1 = 19

  // First candle index where ALL indicator values are available
  const minI = Math.max(ema9Off, ema21Off, bbOff, rsiOff, atrMAOff, obvOff, obvMAOff, 60);

  const features: Feature[] = [];

  for (let i = minI; i < n; i++) {
    const close = candles[i].close;
    const bbu   = bbUp[i - bbOff];
    const bbl   = bbLo[i - bbOff];

    // G2: Bollinger Band breakout gate
    const g2Bull = close > bbu;
    const g2Bear = close < bbl;
    if (!g2Bull && !g2Bear) continue;

    // G1: EMA trend alignment gate
    const ema9  = ema9Arr[i  - ema9Off];
    const ema21 = ema21Arr[i - ema21Off];
    const buyGate  = ema9 > ema21 && g2Bull;
    const sellGate = ema9 < ema21 && g2Bear;
    if (!buyGate && !sellGate) continue;

    const dir: "BUY" | "SELL" = buyGate ? "BUY" : "SELL";

    // C1: ATR elevated AND expanding (both sub-conditions from indicators.ts)
    const atrVal    = atrArr[i  - atrOff];
    const atrMA     = atrMAArr[i - atrMAOff];
    const expanding = expArr[i  - atrMAOff] ?? false;
    const c1        = atrVal > atrMA && expanding;

    // C2 raw material: store RSI for per-combo threshold check in _evalCombo
    const rsi = rsiArr[i - rsiOff];

    // C3: OBV trend direction + volume surge ≥ 1.3× 20-candle average
    const obvVal = obvArr[i  - obvOff];
    const obvMA  = obvMAArr[i - obvMAOff];
    const vol    = candles[i].volume;
    let volSum   = 0;
    const vStart = Math.max(0, i - 19);
    for (let v = vStart; v <= i; v++) volSum += candles[v].volume;
    const volAvg   = volSum / (i - vStart + 1);
    const volSurge = vol > volAvg * 1.3;

    const c3 = dir === "BUY"
      ? (obvVal > obvMA && volSurge)
      : (obvVal < obvMA && volSurge);

    features.push({ i, dir, rsi, atr: atrVal, close, c1, c3 });
  }

  return features;
}

/** Evaluate one combo on pre-computed features. O(signals × maxCandles). */
function _evalCombo(
  features:    Feature[],
  candles:     CacheCandle[],
  combo:       Partial<TraderConfig>,
  oosStartIdx: number,
  maxCandles:  number,
): { oosPF: number; oosWR: number; isPF: number; isWR: number; trades: number } {

  const slMult  = (combo.slAtrMult  as number) ?? 1.0;
  const tpMult  = (combo.tpAtrMult  as number) ?? 1.5;
  const minSc   = (combo.minScore   as number) ?? 2;
  const rblLo   = (combo.rsiBullLo  as number) ?? 50;
  const rblHi   = (combo.rsiBullHi  as number) ?? 70;
  const rbrLo   = (combo.rsiBearLo  as number) ?? 30;
  const rbrHi   = (combo.rsiBearHi  as number) ?? 50;

  const isTrades:  number[] = [];
  const oosTrades: number[] = [];
  let skipUntil = 0;

  for (const f of features) {
    if (f.i < skipUntil) continue;

    // C2: RSI momentum window — thresholds vary per combo
    const c2 = f.dir === "BUY"
      ? (f.rsi > rblLo && f.rsi < rblHi)
      : (f.rsi < rbrHi && f.rsi > rbrLo);

    const score = (f.c1 ? 1 : 0) + (c2 ? 1 : 0) + (f.c3 ? 1 : 0);
    if (score < minSc) continue;

    const isBuy = f.dir === "BUY";
    const entry = f.close;
    const sl    = isBuy ? entry - f.atr * slMult : entry + f.atr * slMult;
    const tp    = isBuy ? entry + f.atr * tpMult : entry - f.atr * tpMult;

    let exitReason: "TP" | "SL" | "TIME" = "TIME";
    let held = maxCandles;

    const limit = Math.min(candles.length - 1, f.i + maxCandles);
    for (let j = f.i + 1; j <= limit; j++) {
      const { high, low } = candles[j];
      if (isBuy) {
        if (low  <= sl) { exitReason = "SL"; held = j - f.i; break; }
        if (high >= tp) { exitReason = "TP"; held = j - f.i; break; }
      } else {
        if (high >= sl) { exitReason = "SL"; held = j - f.i; break; }
        if (low  <= tp) { exitReason = "TP"; held = j - f.i; break; }
      }
    }

    let pnlR: number;
    if (exitReason === "TP") {
      pnlR = tpMult / slMult;
    } else if (exitReason === "SL") {
      pnlR = -1.0;
    } else {
      const exitIdx   = Math.min(f.i + held, candles.length - 1);
      const exitPrice = candles[exitIdx].close;
      const risk      = Math.abs(entry - sl);
      pnlR = risk > 0
        ? (isBuy ? (exitPrice - entry) : (entry - exitPrice)) / risk
        : 0;
    }

    if (!isFinite(pnlR)) pnlR = 0;
    if (f.i < oosStartIdx) isTrades.push(pnlR);
    else                   oosTrades.push(pnlR);

    skipUntil = f.i + held + 1;
  }

  function metrics(arr: number[]) {
    if (arr.length === 0) return { pf: 0, wr: 0 };
    const wins = arr.filter(r => r > 0);
    const gp   = wins.reduce((s, r) => s + r, 0);
    const gl   = Math.abs(arr.filter(r => r <= 0).reduce((s, r) => s + r, 0));
    return {
      pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0),
      wr: wins.length / arr.length,
    };
  }

  const is  = metrics(isTrades);
  const oos = metrics(oosTrades);
  return { oosPF: oos.pf, oosWR: oos.wr, isPF: is.pf, isWR: is.wr,
           trades: isTrades.length + oosTrades.length };
}

// ── Public API ─────────────────────────────────────────────────────────────
export function startOptimization(): void {
  if (_state.running) return;
  _state = {
    running: true, total: 0, done: 0, pct: 0, phase: "Starting…",
    startedAt: Date.now(), finishedAt: null,
    results: [], bestParams: null, error: null,
  };
  setImmediate(() => {
    void _run().catch(e => {
      console.error("[paramOptimizer] FATAL:", e);
      _state.error      = String(e);
      _state.running    = false;
      _state.phase      = "Error: " + String(e).slice(0, 200);
      _state.finishedAt = Date.now();
      _flushState();
    });
  });
}

// ── Core loop ──────────────────────────────────────────────────────────────
async function _run(): Promise<void> {

  // Build parameter grid
  const combos: Partial<TraderConfig>[] = [];
  for (const sl of GRID.slAtrMult) {
    for (const tp of GRID.tpAtrMult) {
      if (tp <= sl) continue;                    // skip useless combos
      for (const ms of GRID.minScore) {
        for (const rbl of GRID.rsiBullLo) {
          for (const rbh of GRID.rsiBullHi) {
            for (const rrl of GRID.rsiBearLo) {
              for (const rrh of GRID.rsiBearHi) {
                if (rrh <= rrl) continue;
                combos.push({
                  slAtrMult: sl, tpAtrMult: tp, minScore: ms,
                  rsiBullLo: rbl, rsiBullHi: rbh,
                  rsiBearLo: rrl, rsiBearHi: rrh,
                });
              }
            }
          }
        }
      }
    }
  }

  // Pre-compute features per pair (the expensive part — done once)
  _state.phase = "Pre-computing indicator arrays…";
  _flushState();

  const minutesPerCandle = ({ "1min": 1, "3min": 3, "5min": 5, "15min": 15, "1hour": 60 } as Record<string, number>)[OPT_TF] ?? 5;
  const maxCandles = Math.ceil(CONFIG.maxHoldMinutes / minutesPerCandle);

  interface PairEntry { candles: CacheCandle[]; features: Feature[]; oosStartIdx: number; }
  const pairMap = new Map<string, PairEntry>();

  for (const sym of OPT_PAIRS) {
    const all = getCandlesForPair(sym, OPT_TF);
    const sub = all.length > CANDLES_PER_PAIR ? all.slice(all.length - CANDLES_PER_PAIR) : all;
    if (sub.length < MIN_CANDLES) {
      console.warn(`[paramOptimizer] ${sym}: only ${sub.length} candles — skipping`);
      continue;
    }
    const features    = _precompute(sub);
    const oosStartIdx = Math.floor(sub.length * OOS_SPLIT);
    pairMap.set(sym, { candles: sub, features, oosStartIdx });
    console.log(`[paramOptimizer] ${sym}: ${sub.length} candles → ${features.length} gate signals (${Math.round(features.length / sub.length * 100)}% pass rate)`);
    await new Promise(r => setTimeout(r, 0)); // yield after each heavy precompute
  }

  if (pairMap.size === 0) {
    throw new Error("No history found. Check KUCOIN_HISTORY_DIR env var / historicalDataStore.");
  }

  _state.total = combos.length * pairMap.size;
  _state.phase = `Grid search: ${combos.length} combos × ${pairMap.size} pairs`;
  console.log(`[paramOptimizer] ${_state.phase}`);
  _flushState();

  const allResults: OptimResult[] = [];
  let batchCount = 0;

  for (const combo of combos) {
    let sumOosPF = 0, sumOosWR = 0, sumIsPF = 0, sumIsWR = 0, sumTrades = 0;
    let n = 0;

    for (const [, pd] of pairMap) {
      const r = _evalCombo(pd.features, pd.candles, combo, pd.oosStartIdx, maxCandles);
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
    const isWR  = sumIsWR  / n;
    const degr  = isPF > 0 ? (isPF - oosPF) / isPF : 1;
    const score = oosPF * oosWR * Math.max(0, 1 - degr);

    const pfPass = oosPF >= (CONFIG.benchmarkPfMin ?? 1.3) && oosPF <= (CONFIG.benchmarkPfMax ?? 2.5);
    const wrPass = oosWR >= (CONFIG.benchmarkWrMin ?? 0.55) && oosWR <= (CONFIG.benchmarkWrMax ?? 0.80);

    allResults.push({
      params: combo, oosPF, oosWR, isPF, isWR,
      totalTrades: sumTrades, degradation: degr, score,
      overallPass: pfPass && wrPass && degr < 0.30,
    });

    _state.pct = Math.round((_state.done / _state.total) * 100);
    batchCount++;
    if (batchCount >= 10) {
      batchCount = 0;
      const top = [...allResults].sort((a, b) => b.score - a.score).slice(0, 5);
      _state.results    = top;
      _state.bestParams = top.length > 0 ? top[0].params : null;
      _flushState();
      await new Promise(r => setTimeout(r, 0));   // yield event loop
    }
  }

  // Final ranking
  allResults.sort((a, b) => b.score - a.score);
  _state.results    = allResults.slice(0, 20);
  _state.bestParams = allResults.length > 0 ? allResults[0].params : null;

  const passing = allResults.filter(r => r.overallPass).length;
  _state.phase      = `Complete — ${passing}/${allResults.length} combos passed Heitkoetter benchmarks`;
  _state.running    = false;
  _state.finishedAt = Date.now();
  _flushState();

  console.log(`[paramOptimizer] ${_state.phase}`);
  if (_state.bestParams) {
    console.log(`[paramOptimizer] Best:`, JSON.stringify(_state.bestParams));
    const top1 = allResults[0];
    console.log(`[paramOptimizer] OOS PF=${top1.oosPF.toFixed(2)} WR=${(top1.oosWR*100).toFixed(1)}% IS PF=${top1.isPF.toFixed(2)} Degr=${(top1.degradation*100).toFixed(1)}%`);
  }

  // Persist full results
  try {
    fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({
      runAt: Date.now(), pairs: OPT_PAIRS, tf: OPT_TF,
      top20: allResults.slice(0, 20),
      bestParams: _state.bestParams,
    }, null, 2));
    console.log(`[paramOptimizer] Saved → ${RESULTS_FILE}`);
  } catch (e) {
    console.warn("[paramOptimizer] Save failed:", e);
  }
}
