/**
 * indicators.ts — lightweight TA for the day-trading engine
 * Uses the same `technicalindicators` library as Bot A/B.
 */

import { EMA, BollingerBands, RSI, ATR, MACD } from "technicalindicators";
import type { CacheCandle } from "./cacheReader";

// ── Simple moving average ─────────────────────────────────────────────────────
export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out.push(sum / period);
  }
  return out;
}

// ── OBV ───────────────────────────────────────────────────────────────────────
export function obv(candles: CacheCandle[], maPeriod = 20): { obv: number[]; obvMA: number[] } {
  const o = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const vol  = candles[i].volume;
    const prev = o[i - 1];
    if      (candles[i].close > candles[i - 1].close) o[i] = prev + vol;
    else if (candles[i].close < candles[i - 1].close) o[i] = prev - vol;
    else                                               o[i] = prev;
  }
  return { obv: o, obvMA: sma(o, maPeriod) };
}

// ── Bollinger Band bandwidth ──────────────────────────────────────────────────
export interface BBResult {
  upper: number[]; middle: number[]; lower: number[];
  bandwidth: number[];   // (upper - lower) / middle
  bwMA: number[];        // 20-period MA of bandwidth (squeeze reference)
  squeeze: boolean[];    // true when bandwidth < bwMA (pre-breakout coil)
}

export function bollingerBands(closes: number[], period = 20, stdDev = 2): BBResult {
  const raw = BollingerBands.calculate({ period, values: closes, stdDev });
  const upper:  number[] = [];
  const middle: number[] = [];
  const lower:  number[] = [];
  const bandwidth: number[] = [];
  for (const b of raw) {
    upper.push(b.upper); middle.push(b.middle); lower.push(b.lower);
    bandwidth.push(b.middle > 0 ? (b.upper - b.lower) / b.middle : 0);
  }
  const bwMA   = sma(bandwidth, period);
  const offset = bandwidth.length - bwMA.length;
  const squeeze = bandwidth.map((bw, i) => {
    const j = i - offset;
    return j >= 0 ? bw < bwMA[j] : false;
  });
  return { upper, middle, lower, bandwidth, bwMA, squeeze };
}

// ── ATR (with MA for volatility expansion detection) ──────────────────────────
export interface ATRResult {
  atr:   number[];   // raw ATR
  atrMA: number[];   // 20-period MA of ATR
  expanding: boolean[];  // true when atr > atrMA × threshold
}

export function atrResult(candles: CacheCandle[], period = 14, maPeriod = 20, threshold = 1.2): ATRResult {
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const atr    = ATR.calculate({ period, high: highs, low: lows, close: closes });
  const atrMA  = sma(atr, maPeriod);
  const offset = atr.length - atrMA.length;
  const expanding = atr.map((v, i) => {
    const j = i - offset;
    return j >= 0 ? v > atrMA[j] * threshold : false;
  });
  return { atr, atrMA, expanding };
}

// ── RSI ───────────────────────────────────────────────────────────────────────
export function rsi(closes: number[], period = 14): number[] {
  return RSI.calculate({ period, values: closes });
}

// ── MACD histogram ────────────────────────────────────────────────────────────
export function macdHistogram(closes: number[]): number[] {
  const raw = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  return raw.map(r => r.histogram ?? 0);
}

// ── EMA ───────────────────────────────────────────────────────────────────────
export function ema(values: number[], period: number): number[] {
  return EMA.calculate({ period, values });
}

// ── Unified indicator bundle ──────────────────────────────────────────────────
export interface IndicatorBundle {
  closes:  number[];
  bb:      BBResult;
  atr:     ATRResult;
  rsi:     number[];
  ema9:    number[];
  ema21:   number[];
  macdH:   number[];
  obv:     { obv: number[]; obvMA: number[] };
}

export function computeBundle(candles: CacheCandle[]): IndicatorBundle | null {
  if (candles.length < 60) return null;
  const closes = candles.map(c => c.close);
  return {
    closes,
    bb:    bollingerBands(closes),
    atr:   atrResult(candles),
    rsi:   rsi(closes),
    ema9:  ema(closes, 9),
    ema21: ema(closes, 21),
    macdH: macdHistogram(closes),
    obv:   obv(candles),
  };
}
