// ─── Signal Engine — 6-point scoring + Lepikkö wick detection ───────────────
//
// Score breakdown (max 6):
//   [1] EMA trend alignment     — EMA9/EMA21 cross
//   [2] BB position             — price vs band extremes
//   [3] RSI momentum            — directional bias + exhaustion zones
//   [4] MACD histogram          — momentum acceleration
//   [5] Volume confirmation     — vol > MA20
//   [6] Fibonacci support/res   — proximity to key fib level
//
// Wick detection (Lepikkö): hammer / shooting star / doji pattern recognition
// applied as a confidence multiplier rather than a seventh score point.

import { Candle, Direction, Indicators } from './types';
import { computeIndicators } from './indicators';

export interface WickAnalysis {
  pattern: 'HAMMER' | 'SHOOTING_STAR' | 'DOJI' | 'NONE';
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: number; // 0.0 – 1.0, ratio of rejection wick to full range
}

export interface ScoreResult {
  score: number;         // 0 – 6
  direction: Direction;
  breakdown: Record<string, number>;
  wick: WickAnalysis;
  confidence: number;    // score + wick boost, normalised 0–1
  indicators: Indicators;
}

// ── Wick / Shadow detection (Lepikkö price-action method) ────────────────────
//
// Lepikkö teaches that exhaustion is visible in the candle structure:
//   • Lower wick ≥ 2× body = buyers absorbed sellers → bullish
//   • Upper wick ≥ 2× body = sellers absorbed buyers → bearish
//   • Body < 15% of total range = doji (indecision / reversal warning)
//
export function detectWick(candle: Candle): WickAnalysis {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (range === 0) return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0 };

  const upperWick =
    candle.high - Math.max(candle.open, candle.close);
  const lowerWick =
    Math.min(candle.open, candle.close) - candle.low;
  const bodyRatio = body / range;

  // Doji: tiny body
  if (bodyRatio < 0.1) {
    return {
      pattern: 'DOJI',
      direction: 'NEUTRAL',
      strength: 1 - bodyRatio,
    };
  }

  // Hammer: long lower wick, small upper wick, body in upper third
  if (lowerWick >= body * 2 && upperWick <= body * 0.5) {
    return {
      pattern: 'HAMMER',
      direction: 'BULLISH',
      strength: lowerWick / range,
    };
  }

  // Shooting Star: long upper wick, small lower wick, body in lower third
  if (upperWick >= body * 2 && lowerWick <= body * 0.5) {
    return {
      pattern: 'SHOOTING_STAR',
      direction: 'BEARISH',
      strength: upperWick / range,
    };
  }

  return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0 };
}

// ── Proximity helper: true if price is within `pct`% of a level ─────────────
function near(price: number, level: number, pct = 0.004): boolean {
  return Math.abs(price - level) / price <= pct;
}

// ── 6-point Signal Scorer ────────────────────────────────────────────────────
export function scoreSignal(
  candles: Candle[],
  prevIndicators?: Indicators
): ScoreResult | null {
  if (candles.length < 50) return null;

  const ind = computeIndicators(candles);
  if (!ind) return null;

  const latest = candles[candles.length - 1];
  const price = latest.close;
  const breakdown: Record<string, number> = {};

  // ── [1] EMA Trend Alignment ──────────────────────────────────────────────
  // Bullish: EMA9 > EMA21 (fast above slow — trend is up)
  // Bearish: EMA9 < EMA21
  let emaScore = 0;
  let emaBias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (ind.ema9 > ind.ema21 * 1.001) {
    emaScore = 1;
    emaBias = 'LONG';
  } else if (ind.ema9 < ind.ema21 * 0.999) {
    emaScore = 1;
    emaBias = 'SHORT';
  }
  breakdown['ema'] = emaScore;

  // ── [2] Bollinger Band Position ──────────────────────────────────────────
  // Price touching/crossing lower band → mean-reversion LONG opportunity
  // Price touching/crossing upper band → mean-reversion SHORT opportunity
  let bbScore = 0;
  let bbBias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  const bbRange = ind.bbUpper - ind.bbLower;
  if (bbRange > 0) {
    const bbPos = (price - ind.bbLower) / bbRange; // 0 = lower band, 1 = upper
    if (bbPos <= 0.15) {
      bbScore = 1;
      bbBias = 'LONG';
    } else if (bbPos >= 0.85) {
      bbScore = 1;
      bbBias = 'SHORT';
    }
  }
  breakdown['bb'] = bbScore;

  // ── [3] RSI Momentum ─────────────────────────────────────────────────────
  // Oversold (<35) → LONG reversal; Overbought (>65) → SHORT reversal
  // Midline cross (prev <50, now >50) = momentum flip LONG and vice versa
  let rsiScore = 0;
  let rsiBias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (ind.rsi < 35) {
    rsiScore = 1;
    rsiBias = 'LONG';
  } else if (ind.rsi > 65) {
    rsiScore = 1;
    rsiBias = 'SHORT';
  } else if (prevIndicators) {
    if (prevIndicators.rsi < 50 && ind.rsi >= 50) {
      rsiScore = 1;
      rsiBias = 'LONG';
    } else if (prevIndicators.rsi > 50 && ind.rsi <= 50) {
      rsiScore = 1;
      rsiBias = 'SHORT';
    }
  }
  breakdown['rsi'] = rsiScore;

  // ── [4] MACD Histogram Crossover ─────────────────────────────────────────
  // Rising histogram (momentum accelerating) → bias direction of histogram sign
  let macdScore = 0;
  let macdBias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (ind.macdHistogram > 0 && ind.macdLine > 0) {
    macdScore = 1;
    macdBias = 'LONG';
  } else if (ind.macdHistogram < 0 && ind.macdLine < 0) {
    macdScore = 1;
    macdBias = 'SHORT';
  } else if (prevIndicators) {
    // Zero-line cross — the most powerful MACD signal
    if (prevIndicators.macdHistogram < 0 && ind.macdHistogram > 0) {
      macdScore = 1;
      macdBias = 'LONG';
    } else if (prevIndicators.macdHistogram > 0 && ind.macdHistogram < 0) {
      macdScore = 1;
      macdBias = 'SHORT';
    }
  }
  breakdown['macd'] = macdScore;

  // ── [5] Volume Confirmation ───────────────────────────────────────────────
  // Volume must exceed 20-period MA for signal validity
  const volScore = latest.volume > ind.volumeMA ? 1 : 0;
  breakdown['volume'] = volScore;

  // ── [6] Fibonacci Level Proximity ────────────────────────────────────────
  const fib = ind.fibLevels;
  const keyLevels = [fib.level236, fib.level382, fib.level500, fib.level618, fib.level786];
  let fibScore = 0;
  let fibBias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  for (const level of keyLevels) {
    if (near(price, level)) {
      fibScore = 1;
      // In an uptrend, touching fib support = LONG; downtrend = SHORT
      fibBias = fib.trend === 'UP' ? 'LONG' : 'SHORT';
      break;
    }
  }
  breakdown['fib'] = fibScore;

  // ── Direction consensus (majority vote across scoring dimensions) ─────────
  const biasVotes = [emaBias, bbBias, rsiBias, macdBias, fibBias];
  const longVotes = biasVotes.filter((b) => b === 'LONG').length;
  const shortVotes = biasVotes.filter((b) => b === 'SHORT').length;
  const direction: Direction =
    longVotes > shortVotes ? 'LONG' : shortVotes > longVotes ? 'SHORT' : 'NEUTRAL';

  // ── Wick analysis (Lepikkö exhaustion signal) ─────────────────────────────
  const wick = detectWick(latest);

  // Score tally
  const rawScore = emaScore + bbScore + rsiScore + macdScore + volScore + fibScore;

  // Wick alignment bonus: +0.5 added to confidence if wick direction matches bias
  const wickAligned =
    (direction === 'LONG' && wick.direction === 'BULLISH') ||
    (direction === 'SHORT' && wick.direction === 'BEARISH');
  const wickBoost = wickAligned ? wick.strength * 0.5 : 0;

  const confidence = Math.min(1, (rawScore / 6 + wickBoost));

  return {
    score: rawScore,
    direction,
    breakdown,
    wick,
    confidence,
    indicators: ind,
  };
}

// ── Convenience: batch score across a sliding window ─────────────────────────
export function batchScore(
  candles: Candle[],
  minBars = 50
): ScoreResult[] {
  const results: ScoreResult[] = [];
  for (let i = minBars; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const prev = i > minBars
      ? computeIndicators(candles.slice(0, i))
      : undefined;
    const result = scoreSignal(window, prev ?? undefined);
    if (result) results.push(result);
  }
  return results;
}
