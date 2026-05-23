import type { KuCoinCandle } from "./kucoinPublic";
import {
  calculateIndicators,
  detectCross,
  volumeSpike,
  nearestFibLevel,
  type IndicatorResult,
  type MarketRegime,
} from "./indicators";

// ── Lepikkö Wick / Price-Action Signals ──────────────────────────────────────
// Buyer/seller exhaustion is read from wick geometry:
//   Hammer          — long lower wick → sellers exhausted, buyers defended
//   Shooting Star   — long upper wick → buyers exhausted, sellers rejected
//   Engulfing       — body engulfs prior candle → momentum acceleration
//   Doji            — body ≈ 0 → equilibrium / indecision
//
// MAX_SCORE breakdown: 9 base conditions + 1 EMA crossover bonus + 1 MACD zero-cross + 1 candle body = 13
// Wick detection adds/subtracts ±1 within MAX_SCORE cap (aligned wick +1, doji −1).
// A doji cuts the score by 1 (exhaustion signal without committed direction).
// ─────────────────────────────────────────────────────────────────────────────

export type WickType =
  | "BULLISH_HAMMER"
  | "BEARISH_SHOOTING_STAR"
  | "BULLISH_ENGULFING"
  | "BEARISH_ENGULFING"
  | "DOJI";

export interface WickSignal {
  type: WickType;
  /** 0–1: wick prominence; larger = more pronounced exhaustion */
  strength: number;
  /** true when the pattern confirms the primary indicator direction */
  aligns: boolean;
}

// Tuning constants (Lepikkö methodology)
const WICK_BODY_RATIO    = 2.0;   // wick must be ≥ 2× body for hammer / shooting star
const WICK_RANGE_SHARE   = 0.55;  // wick must occupy ≥ 55% of total high-low range
const DOJI_RANGE_SHARE   = 0.10;  // body < 10% of range → classified as doji
const ENGULF_TOLERANCE   = 0.02;  // 2% allowance for near-engulf situations

export function detectWickPattern(
  candles: KuCoinCandle[],
  signalDirection: "BUY" | "SELL" | "NEUTRAL",
): WickSignal | null {
  if (candles.length < 2) return null;

  const c    = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const body       = Math.abs(c.close - c.open);
  const upperWick  = c.high - Math.max(c.close, c.open);
  const lowerWick  = Math.min(c.close, c.open) - c.low;
  const totalRange = c.high - c.low;
  if (totalRange === 0) return null;

  const prevBody = Math.abs(prev.close - prev.open);

  // Doji — body is negligible; market indecision / momentum loss
  if (body / totalRange < DOJI_RANGE_SHARE) {
    const strength = 1 - body / totalRange;
    return { type: "DOJI", strength, aligns: false };
  }

  // Bullish hammer — long lower wick, small body near the top of the candle
  if (
    lowerWick >= body * WICK_BODY_RATIO &&
    upperWick <= body * 0.5 &&
    lowerWick / totalRange >= WICK_RANGE_SHARE
  ) {
    const strength = Math.min(lowerWick / (body + 1e-10), 4) / 4;
    return {
      type: "BULLISH_HAMMER",
      strength,
      aligns: signalDirection === "BUY",
    };
  }

  // Bearish shooting star — long upper wick, small body near the bottom
  if (
    upperWick >= body * WICK_BODY_RATIO &&
    lowerWick <= body * 0.5 &&
    upperWick / totalRange >= WICK_RANGE_SHARE
  ) {
    const strength = Math.min(upperWick / (body + 1e-10), 4) / 4;
    return {
      type: "BEARISH_SHOOTING_STAR",
      strength,
      aligns: signalDirection === "SELL",
    };
  }

  // Bullish engulfing — current bullish body engulfs previous bearish body
  if (
    c.close > c.open &&
    prev.close < prev.open &&
    c.open  <= prev.close * (1 + ENGULF_TOLERANCE) &&
    c.close >= prev.open  * (1 - ENGULF_TOLERANCE)
  ) {
    const strength = Math.min(body / (prevBody + 1e-10), 2) / 2;
    return {
      type: "BULLISH_ENGULFING",
      strength,
      aligns: signalDirection === "BUY",
    };
  }

  // Bearish engulfing — current bearish body engulfs previous bullish body
  if (
    c.close < c.open &&
    prev.close > prev.open &&
    c.open  >= prev.close * (1 - ENGULF_TOLERANCE) &&
    c.close <= prev.open  * (1 + ENGULF_TOLERANCE)
  ) {
    const strength = Math.min(body / (prevBody + 1e-10), 2) / 2;
    return {
      type: "BEARISH_ENGULFING",
      strength,
      aligns: signalDirection === "SELL",
    };
  }

  return null;
}

// ── Signal types ──────────────────────────────────────────────────────────────

export interface SignalResult {
  direction: "BUY" | "SELL" | "NEUTRAL";
  score: number;
  maxScore: number;
  strengthPct: number;
  label: "STRONG BUY" | "WEAK BUY" | "NEUTRAL" | "WEAK SELL" | "STRONG SELL";
  conditionsMet: string[];
  conditionsFailed: string[];
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  fibLevel: number | null;
  timestamp: number;
  indicators: IndicatorResult;
  rawBuyScore: number;
  rawSellScore: number;
  regime: MarketRegime;
  /** Lepikkö wick / price-action confirmation — null when no pattern detected */
  wickSignal: WickSignal | null;
}

// MAX_SCORE = 9 base + 1 EMA crossover + 1 MACD acceleration + 1 wick + 1 candle body = 13
const MAX_SCORE = 13;

// ── Configurable signal options ───────────────────────────────────────────────

export interface SignalOptions {
  /** RSI must be ABOVE this for BUY momentum zone (default 45). Range 45–70. */
  rsiOversoldThreshold?: number;
  /** RSI must be BELOW this for SELL momentum zone (default 55). Range 30–55. */
  rsiOverboughtThreshold?: number;
  /** Volume must exceed MA × this multiplier (default 1.2) */
  volumeMultiplier?: number;
}

const DEFAULT_OPTS: Required<SignalOptions> = {
  rsiOversoldThreshold:   45,   // BUY: RSI must be above this (momentum zone, not oversold)
  rsiOverboughtThreshold: 55,   // SELL: RSI must be below this (bearish momentum zone)
  volumeMultiplier:       1.2,
};

// ── Trend-following momentum signal (9 base + 3 bonus) ───────────────────────
// ALL 9 conditions follow trend-following logic — they fire when price is
// moving IN the direction of the trend, not against it.
// Switched from mean-reversion after 5 consecutive pipeline runs with WR 45-48%
// (mean-reversion signals are anti-predictive in trending crypto markets).
//
//  1. RSI zone    — RSI in momentum zone (45–70 BUY, 30–55 SELL) — not extreme
//  2. MACD hist   — positive & accelerating (BUY) / negative & deepening (SELL)
//  3. BB midline  — price above/below BB middle band = trend strength
//  4. EMA align   — EMA9 > EMA21 required (strict, no extreme-bounce exception)
//  5. Volume      — elevated = institutional participation confirmation
//  6. Fibonacci   — pullback to fib retracement level = trend entry point
//  7. Gaussian Ch — LazyBear trend filter
//  8. VWAP        — price ABOVE vwap = strength (BUY) / BELOW = weakness (SELL)
//  9. Regime      — TRENDING_UP or RANGING for BUY / TRENDING_DOWN or RANGING for SELL
// Bonus:
// 4b. EMA crossover  — fresh cross (+1)
// 10. MACD zero-cross — histogram just flipped sign (+1, distinct from cond 2)
// +1  Wick pattern   — confirming hammer/engulf/shooting star
// 11. Candle body    — body ≥ 40% of range = committed directional close
// ─────────────────────────────────────────────────────────────────────────────

function scoreDirection(
  candles: KuCoinCandle[],
  ind: IndicatorResult,
  opts: Required<SignalOptions>,
): {
  buyScore: number; sellScore: number;
  buyMet: string[]; sellMet: string[];
  buyFailed: string[]; sellFailed: string[];
} {
  const price      = candles[candles.length - 1].close;
  const lastCandle = candles[candles.length - 1];

  const lastRsi      = ind.rsi[ind.rsi.length - 1];
  const lastBBUpper  = ind.bb.upper[ind.bb.upper.length - 1];
  const lastBBLower  = ind.bb.lower[ind.bb.lower.length - 1];
  const lastBBMiddle = ind.bb.middle[ind.bb.middle.length - 1];
  const lastVolMA    = ind.volumeMA[ind.volumeMA.length - 1];
  const lastVol      = lastCandle.volume;
  const lastVwap     = ind.vwap[ind.vwap.length - 1] ?? 0;
  const lastEma9     = ind.ema9[ind.ema9.length - 1];
  const lastEma21    = ind.ema21[ind.ema21.length - 1];
  const lastHist     = ind.macd.histogram[ind.macd.histogram.length - 1] ?? 0;
  const prevHist     = ind.macd.histogram[ind.macd.histogram.length - 2] ?? 0;

  const macdCross = detectCross(ind.macd.macd, ind.macd.signal);

  const fibNear             = ind.fibonacci ? nearestFibLevel(price, ind.fibonacci, 1.5) : null;
  const fibSupportLevels    = ["0.382", "0.500", "0.618"];
  const fibResistanceLevels = ["0.618", "0.786"];
  const isFibSupport        = fibNear && fibSupportLevels.includes(fibNear.key);
  const isFibResistance     = fibNear && fibResistanceLevels.includes(fibNear.key);

  const bbRange     = (lastBBUpper ?? 0) - (lastBBLower ?? 0);
  const bbLowerZone = (lastBBLower ?? 0) + bbRange * 0.33;
  const bbUpperZone = (lastBBUpper ?? 0) - bbRange * 0.33;

  // prevRsi declared here so RSI direction check (condition 1) can use it.
  const prevRsi   = ind.rsi[ind.rsi.length - 2] ?? lastRsi;

  const buyMet:    string[] = [];
  const buyFailed: string[] = [];
  let buyScore = 0;

  // 1. RSI momentum zone — BUY when RSI is in the active momentum range (not oversold extreme).
  // Trend-following: RSI 45–70 = price has upward momentum but is not yet exhausted.
  // RSI < 40 (old oversold threshold) = catching falling knives in trending markets → anti-predictive.
  if (lastRsi !== undefined && lastRsi > opts.rsiOversoldThreshold && lastRsi < 70) {
    buyScore++; buyMet.push(`RSI ${lastRsi.toFixed(0)} in momentum zone (${opts.rsiOversoldThreshold}–70) — upside momentum`);
  } else {
    buyFailed.push(`RSI ${lastRsi?.toFixed(0) ?? "–"} outside BUY momentum zone (need ${opts.rsiOversoldThreshold}–70)`);
  }

  // 2. MACD histogram — positive AND accelerating = momentum actively building.
  if (lastHist > 0 && lastHist > prevHist) {
    buyScore++; buyMet.push(`MACD positive & accelerating ↑ (${prevHist.toFixed(5)} → ${lastHist.toFixed(5)})`);
  } else {
    buyFailed.push(`MACD not accelerating upward (hist ${lastHist.toFixed(5)}, prev ${prevHist.toFixed(5)})`);
  }

  // 3. Bollinger Band midline — price ABOVE BB middle = trend strength.
  // Trend-following: price above BB midline confirms upward momentum.
  // Mean-reversion (lower zone) contradicted by RSI momentum zone → anti-predictive.
  if (lastBBMiddle !== undefined && price > lastBBMiddle) {
    buyScore++; buyMet.push(`Price above BB midline (${price.toFixed(4)} > ${lastBBMiddle.toFixed(4)}) — trend strength`);
  } else {
    buyFailed.push(`Price below BB midline (${price.toFixed(4)} ≤ ${(lastBBMiddle ?? 0).toFixed(4)}) — no trend strength`);
  }

  // 4. EMA alignment — EMA9 > EMA21 required (strict, no extreme-oversold exception).
  // Trend-following requires confirmed trend direction. The "extreme bounce" override
  // was a mean-reversion remnant — removed because it fires in counter-trend conditions.
  const prevEma9  = ind.ema9[ind.ema9.length - 2]   ?? lastEma9;
  const prevEma21 = ind.ema21[ind.ema21.length - 2]  ?? lastEma21;
  const emaCrossUp = prevEma9 <= prevEma21 && lastEma9 > lastEma21;

  if (lastEma9 > lastEma21) {
    buyScore++;
    if (emaCrossUp) {
      buyScore++;
      buyMet.push(`EMA9 crossed EMA21 upward ↑ — fresh bullish crossover (trigger candle)`);
    } else {
      buyMet.push(`EMA9 (${lastEma9.toFixed(4)}) > EMA21 (${lastEma21.toFixed(4)}) — uptrend confirmed`);
    }
  } else {
    buyFailed.push(`EMA9 < EMA21 — no uptrend, trend-following BUY blocked`);
  }

  // 5. Volume — elevated = institutional participation, trend conviction
  if (lastVolMA && lastVol > lastVolMA * opts.volumeMultiplier) {
    buyScore++; buyMet.push(`Volume ${(lastVol / lastVolMA).toFixed(1)}× above average — institutional participation`);
  } else {
    buyFailed.push(`Volume not elevated (< ${opts.volumeMultiplier}× MA)`);
  }

  // 6. Fibonacci — pullback to fib retracement level = ideal trend entry point.
  // In trend-following, 38.2% and 50% retracements are classic pullback entries.
  if (isFibSupport) {
    buyScore++; buyMet.push(`Fib pullback entry ${fibNear!.key} (${(fibNear!.distance * 100).toFixed(2)}% away) — trend continuation setup`);
  } else {
    buyFailed.push("Not at Fibonacci pullback level");
  }

  // 7. Gaussian Channel
  if (ind.gaussianChannel) {
    const gc          = ind.gaussianChannel;
    const gcLen       = gc.lower.length;
    const prevClose   = candles[candles.length - 2]?.close ?? price;
    const gcLower     = gc.lower[gcLen - 1];
    const gcPrevLower = gc.lower[gcLen - 2] ?? gcLower;
    const isBull      = gc.isBullish[gcLen - 1];
    if (isBull && prevClose <= gcPrevLower && price > gcLower) {
      buyScore++; buyMet.push("Gaussian Channel bullish crossover");
    } else if (isBull && price > gcLower) {
      buyScore++; buyMet.push("Price above Gaussian lower band (bullish channel)");
    } else {
      buyFailed.push("No Gaussian Channel bullish signal");
    }
  } else {
    buyFailed.push("Gaussian Channel not ready (need 50+ candles)");
  }

  // 8. VWAP — trend-following: price ABOVE VWAP = trading above fair value = bullish strength.
  // Flipped from mean-reversion (was: price BELOW VWAP). In trending markets, price above
  // VWAP signals institutional buying pressure and trend continuation.
  if (lastVwap > 0 && price > lastVwap) {
    buyScore++; buyMet.push(`Price above VWAP (${lastVwap.toFixed(4)}) — above fair value, bullish momentum`);
  } else {
    buyFailed.push(`Price below VWAP (${lastVwap.toFixed(4)}) — no bullish VWAP confirmation`);
  }

  // 9. Market Regime — TRENDING_UP or RANGING for trend-following BUY.
  // TRENDING_UP: primary condition for trend-following entries.
  // RANGING: acceptable since ranging markets can have directional momentum bursts.
  // TRENDING_DOWN: blocked (counter-trend BUY in downtrend = high-risk).
  // VOLATILE: always blocked (unpredictable, no reliable signal).
  if (ind.regime === "TRENDING_UP" || ind.regime === "RANGING") {
    buyScore++; buyMet.push(`Market regime: ${ind.regime} — trend-following BUY conditions met`);
  } else {
    buyFailed.push(`Market regime: ${ind.regime} — need TRENDING_UP or RANGING for BUY`);
  }

  // 10. MACD zero-crossing bonus — histogram just turned positive this candle (fresh momentum shift).
  // Distinct from condition 2 (positive+accelerating): this fires only on the FIRST positive bar
  // after a negative phase, catching the earliest momentum reversal signal.
  const prevHist2 = ind.macd.histogram[ind.macd.histogram.length - 3] ?? prevHist;
  if (lastHist > 0 && prevHist <= 0) {
    buyScore++; buyMet.push(`MACD just crossed zero ↑ (${prevHist.toFixed(5)} → ${lastHist.toFixed(5)}) — fresh momentum reversal`);
  }

  // 11. Candle body confirmation — body occupies ≥ 40% of candle range → buyers committed at close.
  // Raw price-action condition that adds genuine directional edge independent of indicator lags.
  const buyBodySize  = Math.abs(lastCandle.close - lastCandle.open);
  const buyRange     = lastCandle.high - lastCandle.low;
  const buyBodyRatio = buyRange > 0 ? buyBodySize / buyRange : 0;
  if (lastCandle.close > lastCandle.open && buyBodyRatio >= 0.40) {
    buyScore++; buyMet.push(`Bullish candle body ${(buyBodyRatio * 100).toFixed(0)}% of range — buyers committed ≥40%`);
  } else {
    buyFailed.push(`Candle body: ${(buyBodyRatio * 100).toFixed(0)}% of range, ${lastCandle.close > lastCandle.open ? "bullish" : "bearish"} — need bullish ≥40%`);
  }

    // ── SELL ─────────────────────────────────────────────────────────────────────

  const sellMet:    string[] = [];
  const sellFailed: string[] = [];
  let sellScore = 0;

  // 1. RSI bearish momentum zone — SELL when RSI is in downside momentum range.
  // Trend-following: RSI 30–55 = price has downward momentum, not yet oversold.
  // RSI > 60 (old overbought threshold) = selling exhausted tops in trending markets → anti-predictive.
  if (lastRsi !== undefined && lastRsi < opts.rsiOverboughtThreshold && lastRsi > 30) {
    sellScore++; sellMet.push(`RSI ${lastRsi.toFixed(0)} in bearish zone (30–${opts.rsiOverboughtThreshold}) — downside momentum`);
  } else {
    sellFailed.push(`RSI ${lastRsi?.toFixed(0) ?? "–"} outside SELL momentum zone (need 30–${opts.rsiOverboughtThreshold})`);
  }

  // 2. MACD histogram — negative AND deepening = downward momentum actively building.
  if (lastHist < 0 && lastHist < prevHist) {
    const tag = macdCross === "bearish" ? "MACD bearish crossover + deepening" : "MACD histogram negative & deepening ↓";
    sellScore++; sellMet.push(tag);
  } else {
    sellFailed.push(`MACD not deepening downward (hist ${lastHist.toFixed(5)}, prev ${prevHist.toFixed(5)})`);
  }

  // 3. Bollinger Band midline — price BELOW BB middle = trend weakness / bearish momentum.
  // Trend-following: price below BB midline confirms downward momentum.
  if (lastBBMiddle !== undefined && price < lastBBMiddle) {
    sellScore++; sellMet.push(`Price below BB midline (${price.toFixed(4)} < ${lastBBMiddle.toFixed(4)}) — bearish momentum`);
  } else {
    sellFailed.push(`Price above BB midline (${price.toFixed(4)} ≥ ${(lastBBMiddle ?? 0).toFixed(4)}) — no bearish momentum`);
  }

  // 4. EMA alignment — EMA9 < EMA21 required (strict, no extreme-overbought exception).
  const prevEma9sell  = ind.ema9[ind.ema9.length - 2]   ?? lastEma9;
  const prevEma21sell = ind.ema21[ind.ema21.length - 2]  ?? lastEma21;
  const emaCrossDown  = prevEma9sell >= prevEma21sell && lastEma9 < lastEma21;

  if (lastEma9 < lastEma21) {
    sellScore++;
    if (emaCrossDown) {
      sellScore++;
      sellMet.push(`EMA9 crossed EMA21 downward ↓ — fresh bearish crossover (trigger candle)`);
    } else {
      sellMet.push(`EMA9 (${lastEma9.toFixed(4)}) < EMA21 (${lastEma21.toFixed(4)}) — downtrend confirmed`);
    }
  } else {
    sellFailed.push(`EMA9 > EMA21 — no downtrend, trend-following SELL blocked`);
  }

  // 5. Volume — elevated = institutional selling, trend conviction
  if (lastVolMA && lastVol > lastVolMA * opts.volumeMultiplier) {
    sellScore++; sellMet.push(`Volume ${(lastVol / lastVolMA).toFixed(1)}× above average — institutional participation`);
  } else {
    sellFailed.push(`Volume not elevated (< ${opts.volumeMultiplier}× MA)`);
  }

  // 6. Fibonacci resistance — rally to fib level in downtrend = ideal SELL entry point.
  if (isFibResistance) {
    sellScore++; sellMet.push(`Fib resistance entry ${fibNear!.key} (${(fibNear!.distance * 100).toFixed(2)}% away) — trend continuation setup`);
  } else {
    sellFailed.push("Not at Fibonacci resistance level");
  }

  // 7. Gaussian Channel
  if (ind.gaussianChannel) {
    const gc      = ind.gaussianChannel;
    const gcLen   = gc.upper.length;
    const gcUpper = gc.upper[gcLen - 1];
    const isBull  = gc.isBullish[gcLen - 1];
    if (!isBull && price < gcUpper) {
      sellScore++; sellMet.push("Price below Gaussian upper band (bearish channel)");
    } else {
      sellFailed.push("No Gaussian Channel bearish signal");
    }
  } else {
    sellFailed.push("Gaussian Channel not ready");
  }

  // 8. VWAP — trend-following: price BELOW VWAP = trading below fair value = bearish weakness.
  // Flipped from mean-reversion (was: price ABOVE VWAP). Price below VWAP confirms
  // that sellers are dominant and price lacks support at fair value.
  if (lastVwap > 0 && price < lastVwap) {
    sellScore++; sellMet.push(`Price below VWAP (${lastVwap.toFixed(4)}) — below fair value, bearish momentum`);
  } else {
    sellFailed.push(`Price above VWAP (${lastVwap.toFixed(4)}) — no bearish VWAP confirmation`);
  }

  // 9. Market Regime — TRENDING_DOWN or RANGING for trend-following SELL.
  // TRENDING_DOWN: primary condition for trend-following short entries.
  // RANGING: acceptable for momentum breakdown signals.
  // TRENDING_UP: blocked (counter-trend SELL in uptrend = high-risk).
  // VOLATILE: always blocked.
  if (ind.regime === "TRENDING_DOWN" || ind.regime === "RANGING") {
    sellScore++; sellMet.push(`Market regime: ${ind.regime} — trend-following SELL conditions met`);
  } else {
    sellFailed.push(`Market regime: ${ind.regime} — need TRENDING_DOWN or RANGING for SELL`);
  }

  // 10. MACD zero-crossing bonus (SELL) — histogram just turned negative (fresh downward shift).
  if (lastHist < 0 && prevHist >= 0) {
    sellScore++; sellMet.push(`MACD just crossed zero ↓ (${prevHist.toFixed(5)} → ${lastHist.toFixed(5)}) — fresh bearish momentum`);
  }

  // 11. Candle body confirmation — body ≥ 40% of range → sellers committed at close.
  const sellBodySize  = Math.abs(lastCandle.close - lastCandle.open);
  const sellRange     = lastCandle.high - lastCandle.low;
  const sellBodyRatio = sellRange > 0 ? sellBodySize / sellRange : 0;
  if (lastCandle.close < lastCandle.open && sellBodyRatio >= 0.40) {
    sellScore++; sellMet.push(`Bearish candle body ${(sellBodyRatio * 100).toFixed(0)}% of range — sellers committed ≥40%`);
  } else {
    sellFailed.push(`Candle body: ${(sellBodyRatio * 100).toFixed(0)}% of range, ${lastCandle.close < lastCandle.open ? "bearish" : "bullish"} — need bearish ≥40%`);
  }

  return { buyScore, sellScore, buyMet, sellMet, buyFailed, sellFailed };
}

function getLabel(
  direction: "BUY" | "SELL" | "NEUTRAL",
  score: number,
): SignalResult["label"] {
  if (direction === "NEUTRAL") return "NEUTRAL";
  // Strong threshold: ≥8/13 (~62%) → STRONG
  if (direction === "BUY")  return score >= 8 ? "STRONG BUY"  : "WEAK BUY";
  return score >= 8 ? "STRONG SELL" : "WEAK SELL";
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function generateSignal(
  candles: KuCoinCandle[],
  minScore = 4,
  options?: SignalOptions,
): SignalResult {
  const opts: Required<SignalOptions> = { ...DEFAULT_OPTS, ...options };
  const ind   = calculateIndicators(candles);
  const price = candles[candles.length - 1].close;

  const { buyScore, sellScore, buyMet, sellMet, buyFailed, sellFailed } =
    scoreDirection(candles, ind, opts);

  const lastAtr = ind.atr[ind.atr.length - 1] ?? price * 0.005;
  const fibNear = ind.fibonacci ? nearestFibLevel(price, ind.fibonacci, 1.5) : null;

  // Determine preliminary direction (needed before wick detection)
  let prelimDirection: "BUY" | "SELL" | "NEUTRAL" =
    buyScore >= sellScore && buyScore > 0 ? "BUY"
    : sellScore > buyScore ? "SELL"
    : "NEUTRAL";

  // ── Lepikkö wick detection ─────────────────────────────────────────────────
  const wickSignal = detectWickPattern(candles, prelimDirection);

  let direction: SignalResult["direction"] = "NEUTRAL";
  let score = 0;
  let conditionsMet:    string[] = [];
  let conditionsFailed: string[] = [];

  if (buyScore >= sellScore && buyScore >= minScore) {
    direction = "BUY"; score = buyScore;
    conditionsMet = [...buyMet]; conditionsFailed = buyFailed;
  } else if (sellScore > buyScore && sellScore >= minScore) {
    direction = "SELL"; score = sellScore;
    conditionsMet = [...sellMet]; conditionsFailed = sellFailed;
  } else if (buyScore > sellScore) {
    direction = "BUY"; score = buyScore;
    conditionsMet = [...buyMet]; conditionsFailed = buyFailed;
  } else {
    score = Math.max(buyScore, sellScore);
    conditionsMet    = buyScore >= sellScore ? [...buyMet]    : [...sellMet];
    conditionsFailed = buyScore >= sellScore ? buyFailed : sellFailed;
  }

  // Apply wick signal to score
  if (wickSignal) {
    if (wickSignal.type === "DOJI") {
      // Doji = indecision / exhaustion warning — reduce score by 1
      score = Math.max(0, score - 1);
      conditionsFailed.push(
        `DOJI detected (strength ${(wickSignal.strength * 100).toFixed(0)}%) — market indecision, confidence reduced`,
      );
    } else if (wickSignal.aligns) {
      // Confirming wick pattern — add the 10th bonus point
      score = Math.min(MAX_SCORE, score + 1);
      conditionsMet.push(
        `Lepikkö wick: ${wickSignal.type} (strength ${(wickSignal.strength * 100).toFixed(0)}%) confirms ${direction}`,
      );
    } else {
      // Counter-directional wick — warn but don't penalise score
      conditionsFailed.push(
        `Lepikkö wick: ${wickSignal.type} counter to signal — monitor for reversal`,
      );
    }
  }

  const slDist = lastAtr * 1.5;
  const tpDist = slDist * 2.5;
  const stopLossPrice   = direction === "BUY" ? price - slDist : price + slDist;
  const takeProfitPrice = direction === "BUY" ? price + tpDist : price - tpDist;

  return {
    direction, score, maxScore: MAX_SCORE,
    strengthPct: Math.round((score / MAX_SCORE) * 100),
    label: getLabel(direction, score),
    conditionsMet, conditionsFailed,
    entryPrice: price, takeProfitPrice, stopLossPrice,
    fibLevel: fibNear?.level ?? null,
    timestamp: Date.now(), indicators: ind,
    rawBuyScore: buyScore, rawSellScore: sellScore,
    regime: ind.regime,
    wickSignal,
  };
}

// ── Human-readable advice generator ──────────────────────────────────────────
// Translates technical numbers into plain language for non-professional users.
// Output is language-aware (Finnish / English based on lang param).

export interface HumanAdvice {
  /** One-line headline, e.g. "Vahva ostopaine havaittu" */
  headline:            string;
  /** 1–2 sentence plain-language explanation */
  detail:              string;
  /** 1–5 star confidence rating derived from score/maxScore */
  confidence:          number;
  /** Suggested trade size in USDT based on confidence */
  recommendedRiskUSDT: number;
  /** Warning messages that should block or delay the trade */
  warnings:            string[];
}

export function generateHumanAdvice(
  signal:             SignalResult,
  tradeAmountUSDT:    number,
  bidAskSpreadPct:    number = 0,
  lang:               "fi" | "en" = "fi",
): HumanAdvice {
  const fi = lang === "fi";
  const { direction, score, maxScore, indicators, entryPrice, takeProfitPrice } = signal;

  const lastRsi  = indicators.rsi[indicators.rsi.length - 1];
  const ema9     = indicators.ema9[indicators.ema9.length - 1];
  const ema21    = indicators.ema21[indicators.ema21.length - 1];
  const prevEma9 = indicators.ema9[indicators.ema9.length - 2]  ?? ema9;
  const prevEma21= indicators.ema21[indicators.ema21.length - 2] ?? ema21;

  const warnings: string[] = [];

  // ── RSI overbought warning — momentum fading, exit risk ───────────────────
  if (lastRsi > 70 && direction === "BUY") {
    warnings.push(fi
      ? `RSI ${lastRsi.toFixed(0)} on nousemassa yliostoon. Odota vetäytymistä alle 70 ennen ostoa.`
      : `RSI ${lastRsi.toFixed(0)} approaching overbought. Wait for a pullback below 70 before buying.`
    );
  }

  // ── RSI oversold warning — momentum fading for shorts ─────────────────────
  if (lastRsi < 30 && direction === "SELL") {
    warnings.push(fi
      ? `RSI ${lastRsi.toFixed(0)} on lähellä ylilyyntiä. Lyhyeksi myynti riskialtista näin matalalla tasolla.`
      : `RSI ${lastRsi.toFixed(0)} near oversold. Short selling risky at this level — bounce risk.`
    );
  }

  // ── Counter-trend warning ──────────────────────────────────────────────────
  const ema9cur  = indicators.ema9[indicators.ema9.length - 1];
  const ema21cur = indicators.ema21[indicators.ema21.length - 1];
  if (direction === "BUY" && ema9cur < ema21cur) {
    warnings.push(fi
      ? "EMA9 < EMA21 — trendi on laskeva. Osta vain jos muut signaalit ovat erittäin vahvat."
      : "EMA9 < EMA21 — trend is downward. Only buy if other signals are very strong."
    );
  }
  if (direction === "SELL" && ema9cur > ema21cur) {
    warnings.push(fi
      ? "EMA9 > EMA21 — trendi on nouseva. Lyhyt myynti nousevaan trendiin on korkea riski."
      : "EMA9 > EMA21 — trend is upward. Shorting into an uptrend is high risk."
    );
  }

  // ── Spread profitability check ─────────────────────────────────────────────
  const targetProfitPct = Math.abs(takeProfitPrice - entryPrice) / entryPrice * 100;
  if (bidAskSpreadPct > 0 && bidAskSpreadPct > targetProfitPct * 0.10) {
    warnings.push(fi
      ? `Osto-myyntiväli (${bidAskSpreadPct.toFixed(3)}%) syö yli 10% tavoitellusta voitosta. Kauppa epäkannattava.`
      : `Bid-ask spread (${bidAskSpreadPct.toFixed(3)}%) eats >10% of target profit. Trade not worthwhile.`
    );
  }

  // ── Headline & detail based on signal ─────────────────────────────────────
  const emaCrossUp   = prevEma9 <= prevEma21 && ema9 > ema21;
  const emaCrossDown = prevEma9 >= prevEma21 && ema9 < ema21;

  let headline: string;
  let detail: string;

  if (emaCrossUp && direction === "BUY") {
    headline = fi ? "📈 Vahva ostopaine havaittu" : "📈 Strong buying pressure detected";
    detail   = fi
      ? "EMA 9 leikkasi EMA 21:n ylöspäin — nousutrendi todennäköisesti alkamassa."
      : "EMA 9 crossed EMA 21 upward — an uptrend is likely beginning.";
  } else if (emaCrossDown && direction === "SELL") {
    headline = fi ? "📉 Myyntipaine voimistuu" : "📉 Selling pressure increasing";
    detail   = fi
      ? "EMA 9 leikkasi EMA 21:n alaspäin — laskutrendi todennäköisesti alkamassa."
      : "EMA 9 crossed EMA 21 downward — a downtrend is likely beginning.";
  } else if (direction === "BUY" && lastRsi !== undefined && lastRsi >= 40 && lastRsi <= 60) {
    headline = fi ? "🟢 Ostotilaisuus käynnissä" : "🟢 Buy opportunity in progress";
    detail   = fi
      ? `RSI (${lastRsi.toFixed(0)}) on terveellä alueella 40–60 ja EMA-trendi on nouseva.`
      : `RSI (${lastRsi.toFixed(0)}) is in the healthy 40–60 zone with a rising EMA trend.`;
  } else if (direction === "SELL" && lastRsi !== undefined && lastRsi > 75) {
    headline = fi ? "🔴 Markkina ylikuumentunut — myy" : "🔴 Market overheated — sell signal";
    detail   = fi
      ? `RSI (${lastRsi.toFixed(0)}) ylittää 75. Kurssin nousuvoima hiipuu.`
      : `RSI (${lastRsi.toFixed(0)}) exceeds 75. Upward momentum is fading.`;
  } else if (direction === "BUY") {
    headline = fi ? "🟡 Heikko ostosignaali" : "🟡 Weak buy signal";
    detail   = fi
      ? `${score} ehdosta ${maxScore} täyttyi. Odota vahvempaa signaalia ennen kauppaa.`
      : `${score} of ${maxScore} conditions met. Consider waiting for a stronger signal.`;
  } else if (direction === "SELL") {
    headline = fi ? "🟡 Heikko myyntisignaali" : "🟡 Weak sell signal";
    detail   = fi
      ? `${score} ehdosta ${maxScore} täyttyi. Harkitse odottamista.`
      : `${score} of ${maxScore} conditions met. Consider waiting.`;
  } else {
    headline = fi ? "⏸ Ei selvää signaalia" : "⏸ No clear signal";
    detail   = fi
      ? "Markkina on epäselvässä tilassa. Odota selvempää suuntaa."
      : "Market direction is unclear. Wait for a clearer setup.";
  }

  // ── Confidence (1–5 stars) ─────────────────────────────────────────────────
  const confidence = Math.max(1, Math.min(5, Math.round((score / maxScore) * 5)));

  // ── Recommended risk: scale trade size by confidence ──────────────────────
  // 1 star → 20% of base amount, 5 stars → 100%
  const recommendedRiskUSDT = Math.round(tradeAmountUSDT * (confidence / 5) * 10) / 10;

  return { headline, detail, confidence, recommendedRiskUSDT, warnings };
}

// ── Expected Value Calculator ─────────────────────────────────────────────────
// EV = (winRate × avgWin) − (lossRate × avgLoss)

export function calculateEV(
  winRate: number,
  avgWinPct: number,
  avgLossPct: number,
): number {
  return winRate * avgWinPct - (1 - winRate) * avgLossPct;
}

// ── Fast signal for backtester hot-loop ──────────────────────────────────────
// Uses pre-computed indicator arrays (one per candle) instead of calling
// calculateIndicators on a growing slice every iteration. Same scoring logic
// as generateSignal; returns direction + score (no indicator detail objects).

import type { AlignedIndicators } from "./indicators";

export function generateSignalFast(
  i: number,
  candles: KuCoinCandle[],
  precomp: AlignedIndicators,
  minScore: number,
  opts: Required<SignalOptions>,
): { direction: "BUY" | "SELL" | "NEUTRAL"; score: number } {
  if (i < 1) return { direction: "NEUTRAL", score: 0 };

  const price    = candles[i].close;
  const ema9     = precomp.ema9[i];
  const ema21    = precomp.ema21[i];
  const rsi      = precomp.rsi[i];
  const macdHist = precomp.macdHist[i];
  const bbUpper  = precomp.bbUpper[i];
  const bbLower  = precomp.bbLower[i];
  const volumeMA = precomp.volumeMA[i];
  const vol      = candles[i].volume;
  const vwap     = precomp.vwap[i] ?? 0;
  const gcLower  = precomp.gcLower[i];
  const gcUpper  = precomp.gcUpper[i];
  const gcIsBull = precomp.gcIsBull[i];
  const regime   = precomp.regime[i]; // 0=TU 1=TD 2=RG 3=VL

  if (isNaN(rsi) || isNaN(ema9) || isNaN(ema21) || isNaN(macdHist)) {
    return { direction: "NEUTRAL", score: 0 };
  }

  const bbMid   = precomp.bbMiddle[i];

  const fib             = precomp.fibonacci;
  const fibNear         = fib ? nearestFibLevel(price, fib, 1.5) : null;
  const isFibSupport    = fibNear && ["0.382","0.500","0.618"].includes(fibNear.key);
  const isFibResistance = fibNear && ["0.618","0.786"].includes(fibNear.key);

  // ── BUY (9 base + 3 bonus conditions = 12 max before wick) ──────────────
  const prevEma9fast  = precomp.ema9[i - 1]  ?? ema9;
  const prevEma21fast = precomp.ema21[i - 1] ?? ema21;
  const emaCrossUpFast = prevEma9fast <= prevEma21fast && ema9 > ema21;
  const prevMacdHistFast = precomp.macdHist[i - 1] ?? macdHist;

  let buyScore = 0;
  if (rsi > opts.rsiOversoldThreshold && rsi < 70) buyScore++;                             // 1 RSI momentum zone (45–70) — trend-following
  if (macdHist > 0 && macdHist > prevMacdHistFast) buyScore++;                            // 2 MACD positive + accelerating
  if (!isNaN(bbMid) && price > bbMid) buyScore++;                                          // 3 Price above BB midline — trend strength
  if (ema9 > ema21) buyScore++;                                                             // 4 EMA uptrend (strict, no exception)
  if (emaCrossUpFast) buyScore++;                                                           // 4b EMA crossover bonus
  if (!isNaN(volumeMA) && volumeMA > 0 && vol > volumeMA * opts.volumeMultiplier) buyScore++; // 5 Vol
  if (isFibSupport) buyScore++;                                                             // 6 Fib pullback entry
  if (!isNaN(gcLower) && gcIsBull) {                                                        // 7 GC
    const prevClose   = candles[i - 1].close;
    const gcPrevLower = precomp.gcLower[i - 1];
    if (!isNaN(gcPrevLower) && prevClose <= gcPrevLower && price > gcLower) buyScore++;
    else if (price > gcLower) buyScore++;
  }
  if (vwap > 0 && price > vwap) buyScore++;                                                 // 8 VWAP above = bullish strength (trend-following)
  if (regime === 0 || regime === 2) buyScore++;                                             // 9 Regime: TRENDING_UP(0) or RANGING(2) — TRENDING_DOWN/VOLATILE blocked
  if (macdHist > 0 && prevMacdHistFast <= 0) buyScore++;                                   // 10 MACD just crossed zero upward
  const c11fast = candles[i];
  const body11  = Math.abs(c11fast.close - c11fast.open);
  const range11 = c11fast.high - c11fast.low;
  if (c11fast.close > c11fast.open && range11 > 0 && body11 / range11 >= 0.40) buyScore++; // 11 Body

  // ── SELL (9 base + 3 bonus conditions = 12 max before wick) ──────────────
  const emaCrossDownFast = prevEma9fast >= prevEma21fast && ema9 < ema21;

  let sellScore = 0;
  if (rsi < opts.rsiOverboughtThreshold && rsi > 30) sellScore++;                          // 1 RSI bearish zone (30–55) — trend-following
  if (macdHist < 0 && macdHist < prevMacdHistFast) sellScore++;                            // 2 MACD negative + deepening
  if (!isNaN(bbMid) && price < bbMid) sellScore++;                                          // 3 Price below BB midline — bearish momentum
  if (ema9 < ema21) sellScore++;                                                             // 4 EMA downtrend (strict, no exception)
  if (emaCrossDownFast) sellScore++;                                                        // 4b EMA crossover bonus
  if (!isNaN(volumeMA) && volumeMA > 0 && vol > volumeMA * opts.volumeMultiplier) sellScore++; // 5 Vol
  if (isFibResistance) sellScore++;                                                         // 6 Fib resistance entry
  if (!isNaN(gcUpper) && !gcIsBull && price < gcUpper) sellScore++;                        // 7 GC
  if (vwap > 0 && price < vwap) sellScore++;                                                // 8 VWAP below = bearish weakness (trend-following)
  if (regime === 1 || regime === 2) sellScore++;                                            // 9 Regime: TRENDING_DOWN(1) or RANGING(2) — TRENDING_UP/VOLATILE blocked
  if (macdHist < 0 && prevMacdHistFast >= 0) sellScore++;                                  // 10 MACD just crossed zero downward
  if (c11fast.close < c11fast.open && range11 > 0 && body11 / range11 >= 0.40) sellScore++; // 11 Body
  // ── Wick adjustment (2-candle check, cheap) ───────────────────────────────
  const prelimDir: "BUY" | "SELL" | "NEUTRAL" =
    buyScore >= sellScore && buyScore > 0 ? "BUY" : sellScore > buyScore ? "SELL" : "NEUTRAL";
  const wick = detectWickPattern([candles[i - 1], candles[i]], prelimDir);

  let direction: "BUY" | "SELL" | "NEUTRAL" = "NEUTRAL";
  let score = 0;
  if (buyScore >= sellScore && buyScore >= minScore)       { direction = "BUY";  score = buyScore; }
  else if (sellScore > buyScore && sellScore >= minScore)  { direction = "SELL"; score = sellScore; }
  else if (buyScore > sellScore)                           { direction = "BUY";  score = buyScore; }
  else                                                     { score = Math.max(buyScore, sellScore); }

  if (wick) {
    if (wick.type === "DOJI")   score = Math.max(0,  score - 1);
    else if (wick.aligns)       score = Math.min(MAX_SCORE, score + 1);
  }

  return { direction, score };
}

// ── Adaptive threshold helper ─────────────────────────────────────────────────

export function computeAdaptiveThreshold(
  winRate: number,
  currentThreshold: number,
): number {
  if (winRate > 0.60) return Math.max(3, currentThreshold - 1);
  if (winRate < 0.45) return Math.min(9, currentThreshold + 1);
  return currentThreshold;
}
