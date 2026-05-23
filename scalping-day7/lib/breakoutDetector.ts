/**
 * breakoutDetector.ts — Heitkoetter-compliant 6-rule signal engine
 *
 * ── Heitkoetter Power Principle #1 (≤10 rules) ───────────────────────────────
 * Exactly 6 named rules — well below the ceiling:
 *
 *   Mandatory gates (ALL must pass — not scored):
 *     G1. EMA trend alignment: EMA_fast > EMA_slow (BUY) or < (SELL)
 *         → sole trend indicator; eliminates buys in downtrends / sells in uptrends
 *         → fixes Heitkoetter "Deadly Mistake #1: no clean trend identification"
 *     G2. BB breakout: close > upper band (BUY) or < lower band (SELL)
 *     G3. Spread ≤ maxSpreadPct (execution quality gate — skip illiquid markets)
 *
 *   Scored conditions (need CONFIG.minScore of 3):
 *     C1. ATR expanding  — volatility confirms breakout has energy
 *     C2. RSI momentum   — not overbought/oversold; in the momentum window
 *     C3. OBV trend      — volume accumulation confirms direction
 *
 * ── What was removed vs v1 ────────────────────────────────────────────────────
 * • BB Squeeze removed: was a second BB-derived condition; created false signals
 *   in wide-ranging markets and was often true at the same time as the BB
 *   breakout (circular confirmation).
 * • OB imbalance removed from scoring: L2 book latency differs from candle data;
 *   mixing them introduced timing inconsistency. Kept only as spread quality gate.
 * • EMA9/EMA21 moved from orphaned computation to G1 (mandatory trend gate).
 *   MACD-H is still computed in the bundle but not used here — intentionally
 *   left available for the backtester to optionally test.
 */

import type { CacheCandle }   from "./cacheReader";
import { computeBundle }      from "./indicators";
import { analyzeOrderBook }   from "./orderbookAnalyzer";
import type { OrderBookFile } from "./cacheReader";
import type { BreakoutSignal, Direction } from "./types";
import { CONFIG }             from "./traderConfig";

// ── Signal detection ──────────────────────────────────────────────────────────
/**
 * Evaluate breakout conditions for one symbol / timeframe pair.
 * Returns BreakoutSignal or null if any mandatory gate fails or score < minScore.
 */
export function detectBreakout(
  symbol:    string,
  timeframe: string,
  candles:   CacheCandle[],
  book:      OrderBookFile | null,
): BreakoutSignal | null {
  if (candles.length < 60) return null;

  const ind = computeBundle(candles);
  if (!ind) return null;

  const last = (arr: number[]): number => arr[arr.length - 1] ?? 0;

  const close   = last(ind.closes);
  const bbUpper = last(ind.bb.upper);
  const bbLower = last(ind.bb.lower);
  const atrVal  = last(ind.atr.atr);
  const atrMA   = last(ind.atr.atrMA);
  const atrExp  = ind.atr.expanding[ind.atr.expanding.length - 1] ?? false;
  const rsiVal  = last(ind.rsi);
  const obvLast = last(ind.obv.obv);
  const obvMA   = last(ind.obv.obvMA);
  const ema9    = last(ind.ema9);
  const ema21   = last(ind.ema21);

  // Volume: 20-candle average for surge detection (C3 gate)
  const volSlice  = candles.slice(-20);
  const volumeAvg = volSlice.reduce((s, c) => s + c.volume, 0) / volSlice.length;
  const currentVol = candles[candles.length - 1].volume;
  const volumeSurge = currentVol > volumeAvg * 1.3;   // ≥30 % above average

  // ── G3: Spread / liquidity gate ──────────────────────────────────────────────
  const ob = analyzeOrderBook(book);
  if (ob && ob.spreadPct > CONFIG.maxSpreadPct) return null;
  const imbalance = ob?.imbalance ?? 0;

  // ── G2: BB breakout gate ─────────────────────────────────────────────────────
  const buyBreakout  = close > bbUpper;
  const sellBreakout = close < bbLower;
  if (!buyBreakout && !sellBreakout) return null;

  const dir: Direction = buyBreakout ? "BUY" : "SELL";

  // ── G1: EMA trend gate ───────────────────────────────────────────────────────
  // CRITICAL: prevents buying into downtrends and selling into uptrends.
  // This is the sole trend filter — keeping it as one indicator (Mistake #1 fix).
  if (dir === "BUY"  && ema9 <= ema21) return null;
  if (dir === "SELL" && ema9 >= ema21) return null;

  // ── Scored conditions C1–C3 ──────────────────────────────────────────────────
  const reasons: string[] = [
    dir === "BUY" ? "BB upper breakout" : "BB lower breakout",
    `EMA${CONFIG.emaTrendFast}(${ema9.toFixed(2)}) ${dir === "BUY" ? ">" : "<"} EMA${CONFIG.emaTrendSlow}(${ema21.toFixed(2)}) — trend aligned`,
  ];
  let score = 0;

  // C1. ATR elevated AND expanding — volatility must be above its own trend,
  //     not just ticking up. Filters flat-market false breakouts.
  const atrElevated = atrVal > atrMA && atrExp;
  if (atrElevated) {
    score++;
    reasons.push(
      `ATR ${atrVal.toFixed(4)} > ATR-MA ${atrMA.toFixed(4)} + expanding — volatility breakout confirmed`
    );
  }

  // C2. RSI Momentum — in the valid zone, not extreme
  const rsiValid = dir === "BUY"
    ? rsiVal > CONFIG.rsiBullLo && rsiVal < CONFIG.rsiBullHi
    : rsiVal < CONFIG.rsiBearHi && rsiVal > CONFIG.rsiBearLo;
  if (rsiValid) {
    score++;
    reasons.push(dir === "BUY"
      ? `RSI ${rsiVal.toFixed(1)} in bull zone (${CONFIG.rsiBullLo}–${CONFIG.rsiBullHi})`
      : `RSI ${rsiVal.toFixed(1)} in bear zone (${CONFIG.rsiBearLo}–${CONFIG.rsiBearHi})`);
  }

  // C3. OBV trend + volume surge — requires BOTH smart-money direction AND
  //     a real volume spike (≥1.3× avg). OBV alone can reflect a stale trend;
  //     without a surge the breakout lacks institutional conviction.
  const obvAligned = dir === "BUY" ? obvLast > obvMA : obvLast < obvMA;
  if (obvAligned && volumeSurge) {
    score++;
    const surgeX = volumeAvg > 0 ? (currentVol / volumeAvg).toFixed(1) : "?";
    reasons.push(dir === "BUY"
      ? `OBV bullish + vol ${surgeX}× avg — institutional accumulation`
      : `OBV bearish + vol ${surgeX}× avg — institutional distribution`);
  } else if (obvAligned) {
    reasons.push(`OBV aligned but no volume surge (${(currentVol / (volumeAvg || 1)).toFixed(1)}× avg < 1.3×) — not scored`);
  }

  // ── Minimum score gate ────────────────────────────────────────────────────────
  if (score < CONFIG.minScore) return null;

  return {
    symbol,
    timeframe,
    direction:   dir,
    score,
    maxScore:    3,
    reasons,
    entryPrice:  close,
    atr:         atrVal,
    bbUpper,
    bbLower,
    bbSqueeze:   false,  // removed from logic — field kept for API compat
    obvBullish:  dir === "BUY" ? (obvLast > obvMA) : !(obvLast < obvMA),
    obImbalance: imbalance,
    timestamp:   Date.now(),
  };
}

/**
 * Scan multiple symbols/timeframes; return all valid signals sorted by score.
 */
export function scanAll(
  dataset: Array<{
    symbol:    string;
    timeframe: string;
    candles:   CacheCandle[];
    book:      OrderBookFile | null;
  }>,
): BreakoutSignal[] {
  const signals: BreakoutSignal[] = [];
  for (const item of dataset) {
    const sig = detectBreakout(item.symbol, item.timeframe, item.candles, item.book);
    if (sig) signals.push(sig);
  }
  signals.sort((a, b) => b.score - a.score);
  return signals;
}
