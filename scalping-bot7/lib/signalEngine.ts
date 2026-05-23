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
  rsiOversoldThreshold:   45,
  rsiOverboughtThreshold: 55,
  volumeMultiplier:       1.2,
};

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

  if (ind.rsi.length < 2 || ind.ema9.length < 2 || ind.ema21.length < 2) {
    return {
      buyScore: 0, sellScore: 0,
      buyMet: [], sellMet: [],
      buyFailed: ["Insufficient indicator history (need 50+ candles)"],
      sellFailed: ["Insufficient indicator history (need 50+ candles)"],
    };
  }

  const lastRsi      = ind.rsi[ind.rsi.length - 1];
  const lastBBUpper  = ind.bb.upper[ind.bb.upper.length - 1];
  const lastBBLower  = ind.bb.lower[ind.bb.lower.length - 1];
  const lastBBMiddle = ind.bb.middle[ind.bb.middle.length - 1];
  const lastVolMA    = ind.volumeMA[ind.volumeMA.length - 1];
  const lastVol      = lastCandle.volume;
  const lastEma9     = ind.ema9[ind.ema9.length - 1];
  const lastEma21    = ind.ema21[ind.ema21.length - 1];
  const lastHist     = ind.macd.histogram[ind.macd.histogram.length - 1] ?? 0;
  const prevHist     = ind.macd.histogram[ind.macd.histogram.length - 2] ?? 0;
  const lastObv      = ind.obv  && ind.obv.length  > 0 ? ind.obv[ind.obv.length - 1]   : 0;
  const lastObvMA    = ind.obvMA && ind.obvMA.length > 0 ? ind.obvMA[ind.obvMA.length - 1] : 0;
  const obvReady     = ind.obvMA && ind.obvMA.length >= 20;

  const macdCross = detectCross(ind.macd.macd, ind.macd.signal);

  const fibNear             = ind.fibonacci ? nearestFibLevel(price, ind.fibonacci, 1.5) : null;
  const fibSupportLevels    = ["0.382", "0.500", "0.618"];
  const fibResistanceLevels = ["0.618", "0.786"];
  const isFibSupport        = fibNear && fibSupportLevels.includes(fibNear.key);
  const isFibResistance     = fibNear && fibResistanceLevels.includes(fibNear.key);

  const bbRange     = (lastBBUpper ?? 0) - (lastBBLower ?? 0);
  const bbLowerZone = (lastBBLower ?? 0) + bbRange * 0.33;
  const bbUpperZone = (lastBBUpper ?? 0) - bbRange * 0.33;

  const prevRsi   = ind.rsi[ind.rsi.length - 2] ?? lastRsi;

  const buyMet:    string[] = [];
  const buyFailed: string[] = [];
  let buyScore = 0;

  if (lastRsi !== undefined && lastRsi > opts.rsiOversoldThreshold && lastRsi < 70) {
    buyScore++; buyMet.push(`RSI ${lastRsi.toFixed(0)} in momentum zone (${opts.rsiOversoldThreshold}–70) — upside momentum`);
  } else {
    buyFailed.push(`RSI ${lastRsi?.toFixed(0) ?? "–"} outside BUY momentum zone (need ${opts.rsiOversoldThreshold}–70)`);
  }

  if (lastHist > 0 && lastHist > prevHist) {
    buyScore++; buyMet.push(`MACD positive & accelerating ↑ (${prevHist.toFixed(5)} → ${lastHist.toFixed(5)})`);
  } else {
    buyFailed.push(`MACD not accelerating upward (hist ${lastHist.toFixed(5)}, prev ${prevHist.toFixed(5)})`);
  }

  if (lastBBMiddle !== undefined && price > lastBBMiddle) {
    buyScore++; buyMet.push(`Price above BB midline (${price.toFixed(4)} > ${lastBBMiddle.toFixed(4)}) — trend strength`);
  } else {
    buyFailed.push(`Price below BB midline (${price.toFixed(4)} ≤ ${(lastBBMiddle ?? 0).toFixed(4)}) — no trend strength`);
  }

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

  if (lastVolMA && lastVol > lastVolMA * opts.volumeMultiplier) {
    buyScore++; buyMet.push(`Volume ${(lastVol / lastVolMA).toFixed(1)}× above average — institutional participation`);
  } else {
    buyFailed.push(`Volume not elevated (< ${opts.volumeMultiplier}× MA)`);
  }

  if (isFibSupport && fibNear && !isNaN(fibNear.distance)) {
    buyScore++; buyMet.push(`Fib pullback entry ${fibNear.key} (${(fibNear.distance * 100).toFixed(2)}% away) — trend continuation setup`);
  } else {
    buyFailed.push("Not at Fibonacci pullback level");
  }

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

  if (obvReady && lastObvMA !== 0 && lastObv > lastObvMA) {
    buyScore++; buyMet.push(`OBV (${lastObv.toFixed(0)}) above OBV-MA (${lastObvMA.toFixed(0)}) — net buying pressure, institutional accumulation`);
  } else if (!obvReady) {
    buyFailed.push("OBV not ready (need 20+ candles)");
  } else {
    buyFailed.push(`OBV (${lastObv.toFixed(0)}) below OBV-MA (${lastObvMA.toFixed(0)}) — net selling pressure`);
  }

  if (ind.regime === "TRENDING_UP" || ind.regime === "RANGING") {
    buyScore++; buyMet.push(`Market regime: ${ind.regime} — trend-following BUY conditions met`);
  } else {
    buyFailed.push(`Market regime: ${ind.regime} — need TRENDING_UP or RANGING for BUY`);
  }

  const prevHist2 = ind.macd.histogram[ind.macd.histogram.length - 3] ?? prevHist;
  if (lastHist > 0 && prevHist <= 0) {
    buyScore++; buyMet.push(`MACD just crossed zero ↑ (${prevHist.toFixed(5)} → ${lastHist.toFixed(5)}) — fresh momentum reversal`);
  }

  const buyBodySize  = Math.abs(lastCandle.close - lastCandle.open);
  const buyRange     = lastCandle.high - lastCandle.low;
  const buyBodyRatio = buyRange > 0 ? buyBodySize / buyRange : 0;
  if (lastCandle.close > lastCandle.open && buyBodyRatio >= 0.40) {
    buyScore++; buyMet.push(`Bullish candle body ${(buyBodyRatio * 100).toFixed(0)}% of range — buyers committed ≥40%`);
  } else {
    buyFailed.push(`Candle body: ${(buyBodyRatio * 100).toFixed(0)}% of range, ${lastCandle.close > lastCandle.open ? "bullish" : "bearish"} — need bullish ≥40%`);
  }

  const sellMet:    string[] = [];
  const sellFailed: string[] = [];
  let sellScore = 0;

  if (lastRsi !== undefined && lastRsi < opts.rsiOverboughtThreshold && lastRsi > 30) {
    sellScore++; sellMet.push(`RSI ${lastRsi.toFixed(0)} in bearish zone (30–${opts.rsiOverboughtThreshold}) — downside momentum`);
  } else {
    sellFailed.push(`RSI ${lastRsi?.toFixed(0) ?? "–"} outside SELL momentum zone (need 30–${opts.rsiOverboughtThreshold})`);
  }

  if (lastHist < 0 && lastHist < prevHist) {
    const tag = macdCross === "bearish" ? "MACD bearish crossover + deepening" : "MACD histogram negative & deepening ↓";
    sellScore++; sellMet.push(tag);
  } else {
    sellFailed.push(`MACD not deepening downward (hist ${lastHist.toFixed(5)}, prev ${prevHist.toFixed(5)})`);
  }

  if (lastBBMiddle !== undefined && price < lastBBMiddle) {
    sellScore++; sellMet.push(`Price below BB midline (${price.toFixed(4)} < ${lastBBMiddle.toFixed(4)}) — bearish momentum`);
  } else {
    sellFailed.push(`Price above BB midline (${price.toFixed(4)} ≥ ${(lastBBMiddle ?? 0).toFixed(4)}) — no bearish momentum`);
  }

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

  if (lastVolMA && lastVol > lastVolMA * opts.volumeMultiplier) {
    sellScore++; sellMet.push(`Volume ${(lastVol / lastVolMA).toFixed(1)}× above average — institutional participation`);
  } else {
    sellFailed.push(`Volume not elevated (< ${opts.volumeMultiplier}× MA)`);
  }

  if (isFibResistance && fibNear && !isNaN(fibNear.distance)) {
    sellScore++; sellMet.push(`Fib resistance entry ${fibNear.key} (${(fibNear.distance * 100).toFixed(2)}% away) — trend continuation setup`);
  } else {
    sellFailed.push("Not at Fibonacci resistance level");
  }

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

  if (obvReady && lastObvMA !== 0 && lastObv < lastObvMA) {
    sellScore++; sellMet.push(`OBV (${lastObv.toFixed(0)}) below OBV-MA (${lastObvMA.toFixed(0)}) — net selling pressure, institutional distribution`);
  } else if (!obvReady) {
    sellFailed.push("OBV not ready (need 20+ candles)");
  } else {
    sellFailed.push(`OBV (${lastObv.toFixed(0)}) above OBV-MA (${lastObvMA.toFixed(0)}) — net buying pressure, not bearish`);
  }

  if (ind.regime === "TRENDING_DOWN" || ind.regime === "RANGING") {
    sellScore++; sellMet.push(`Market regime: ${ind.regime} — trend-following SELL conditions met`);
  } else {
    sellFailed.push(`Market regime: ${ind.regime} — need TRENDING_DOWN or RANGING for SELL`);
  }

  if (lastHist < 0 && prevHist >= 0) {
    sellScore++; sellMet.push(`MACD just crossed zero ↓ (${prevHist.toFixed(5)} → ${lastHist.toFixed(5)}) — fresh bearish momentum`);
  }

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
  if (direction === "BUY")  return score >= 8 ? "STRONG BUY"  : "WEAK BUY";
  return score >= 8 ? "STRONG SELL" : "WEAK SELL";
}

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

  let prelimDirection: "BUY" | "SELL" | "NEUTRAL" =
    buyScore > sellScore && buyScore > 0 ? "BUY"
    : sellScore > buyScore && sellScore > 0 ? "SELL"
    : "NEUTRAL";

  const wickSignal = detectWickPattern(candles, prelimDirection);

  let direction: SignalResult["direction"] = "NEUTRAL";
  let score = 0;
  let conditionsMet:    string[] = [];
  let conditionsFailed: string[] = [];

  if (buyScore > sellScore && buyScore >= minScore) {
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

  if (wickSignal) {
    if (wickSignal.type === "DOJI") {
      score = Math.max(0, score - 1);
      conditionsFailed.push(
        `DOJI detected (strength ${(wickSignal.strength * 100).toFixed(0)}%) — market indecision, confidence reduced`,
      );
    } else if (wickSignal.aligns) {
      score = Math.min(MAX_SCORE, score + 1);
      conditionsMet.push(
        `Lepikkö wick: ${wickSignal.type} (strength ${(wickSignal.strength * 100).toFixed(0)}%) confirms ${direction}`,
      );
    } else {
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

export interface HumanAdvice {
  headline:            string;
  detail:              string;
  confidence:          number;
  recommendedRiskUSDT: number;
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

  if (lastRsi > 70 && direction === "BUY") {
    warnings.push(fi
      ? `RSI ${lastRsi.toFixed(0)} on nousemassa yliostoon. Odota vetäytymistä alle 70 ennen ostoa.`
      : `RSI ${lastRsi.toFixed(0)} approaching overbought. Wait for a pullback below 70 before buying.`
    );
  }

  if (lastRsi < 30 && direction === "SELL") {
    warnings.push(fi
      ? `RSI ${lastRsi.toFixed(0)} on lähellä ylilyyntiä. Lyhyeksi myynti riskialtista näin matalalla tasolla.`
      : `RSI ${lastRsi.toFixed(0)} near oversold. Short selling risky at this level — bounce risk.`
    );
  }

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

  const targetProfitPct = Math.abs(takeProfitPrice - entryPrice) / entryPrice * 100;
  if (bidAskSpreadPct > 0 && bidAskSpreadPct > targetProfitPct * 0.10) {
    warnings.push(fi
      ? `Osto-myyntiväli (${bidAskSpreadPct.toFixed(3)}%) syö yli 10% tavoitellusta voitosta. Kauppa epäkannattava.`
      : `Bid-ask spread (${bidAskSpreadPct.toFixed(3)}%) eats >10% of target profit. Trade not worthwhile.`
    );
  }

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

  const confidence = Math.max(1, Math.min(5, Math.round((score / maxScore) * 5)));
  const recommendedRiskUSDT = Math.round(tradeAmountUSDT * (confidence / 5) * 10) / 10;

  return { headline, detail, confidence, recommendedRiskUSDT, warnings };
}

export function calculateEV(
  winRate: number,
  avgWinPct: number,
  avgLossPct: number,
): number {
  return winRate * avgWinPct - (1 - winRate) * avgLossPct;
}

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
  const gcLower  = precomp.gcLower[i];
  const gcUpper  = precomp.gcUpper[i];
  const gcIsBull = precomp.gcIsBull[i];
  const regime   = precomp.regime[i];

  if (isNaN(rsi) || isNaN(ema9) || isNaN(ema21) || isNaN(macdHist)) {
    return { direction: "NEUTRAL", score: 0 };
  }

  const bbMid    = precomp.bbMiddle[i];

  const lastObvFast   = precomp.obv[i]   ?? 0;
  const lastObvMAFast = precomp.obvMA[i];
  const obvFastReady  = !isNaN(lastObvMAFast) && lastObvMAFast !== 0;

  const fib             = precomp.fibonacci;
  const fibNear         = fib ? nearestFibLevel(price, fib, 1.5) : null;
  const isFibSupport    = fibNear && ["0.382","0.500","0.618"].includes(fibNear.key);
  const isFibResistance = fibNear && ["0.618","0.786"].includes(fibNear.key);

  const prevEma9fast  = precomp.ema9[i - 1]  ?? ema9;
  const prevEma21fast = precomp.ema21[i - 1] ?? ema21;
  const emaCrossUpFast = prevEma9fast <= prevEma21fast && ema9 > ema21;
  const prevMacdHistFast = precomp.macdHist[i - 1] ?? macdHist;

  let buyScore = 0;
  if (rsi > opts.rsiOversoldThreshold && rsi < 70) buyScore++;
  if (macdHist > 0 && macdHist > prevMacdHistFast) buyScore++;
  if (!isNaN(bbMid) && price > bbMid) buyScore++;
  if (ema9 > ema21) buyScore++;
  if (emaCrossUpFast) buyScore++;
  if (!isNaN(volumeMA) && volumeMA > 0 && vol > volumeMA * opts.volumeMultiplier) buyScore++;
  if (isFibSupport) buyScore++;
  if (!isNaN(gcLower) && gcIsBull) {
    const prevClose   = candles[i - 1].close;
    const gcPrevLower = precomp.gcLower[i - 1];
    if (!isNaN(gcPrevLower) && prevClose <= gcPrevLower && price > gcLower) buyScore++;
    else if (price > gcLower) buyScore++;
  }
  if (obvFastReady && lastObvFast > lastObvMAFast) buyScore++;
  if (regime === 0 || regime === 2) buyScore++;
  if (macdHist > 0 && prevMacdHistFast <= 0) buyScore++;
  const c11fast = candles[i];
  const body11  = Math.abs(c11fast.close - c11fast.open);
  const range11 = c11fast.high - c11fast.low;
  if (c11fast.close > c11fast.open && range11 > 0 && body11 / range11 >= 0.40) buyScore++;

  const emaCrossDownFast = prevEma9fast >= prevEma21fast && ema9 < ema21;

  let sellScore = 0;
  if (rsi < opts.rsiOverboughtThreshold && rsi > 30) sellScore++;
  if (macdHist < 0 && macdHist < prevMacdHistFast) sellScore++;
  if (!isNaN(bbMid) && price < bbMid) sellScore++;
  if (ema9 < ema21) sellScore++;
  if (emaCrossDownFast) sellScore++;
  if (!isNaN(volumeMA) && volumeMA > 0 && vol > volumeMA * opts.volumeMultiplier) sellScore++;
  if (isFibResistance) sellScore++;
  if (!isNaN(gcUpper) && !gcIsBull && price < gcUpper) sellScore++;
  if (obvFastReady && lastObvFast < lastObvMAFast) sellScore++;
  if (regime === 1 || regime === 2) sellScore++;
  if (macdHist < 0 && prevMacdHistFast >= 0) sellScore++;
  if (c11fast.close < c11fast.open && range11 > 0 && body11 / range11 >= 0.40) sellScore++;

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

export function computeAdaptiveThreshold(
  winRate: number,
  currentThreshold: number,
): number {
  if (winRate > 0.60) return Math.max(3, currentThreshold - 1);
  if (winRate < 0.45) return Math.min(9, currentThreshold + 1);
  return currentThreshold;
}
