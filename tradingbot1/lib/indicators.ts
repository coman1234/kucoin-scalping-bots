// ─── Pure indicator math — no side effects, all functions are deterministic ──
import { Candle, FibonacciLevels, Indicators } from './types';

// ── Exponential Moving Average ───────────────────────────────────────────────
export function calculateEMA(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];

  // seed with SMA of first `period` values
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(seed);

  for (let i = period; i < values.length; i++) {
    result.push(values[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
}

// ── Bollinger Bands ──────────────────────────────────────────────────────────
export function calculateBollingerBands(
  values: number[],
  period = 20,
  stdDevMult = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const upper: number[] = [];
  const middle: number[] = [];
  const lower: number[] = [];

  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + (v - sma) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    middle.push(sma);
    upper.push(sma + stdDevMult * std);
    lower.push(sma - stdDevMult * std);
  }
  return { upper, middle, lower };
}

// ── RSI ──────────────────────────────────────────────────────────────────────
export function calculateRSI(values: number[], period = 14): number[] {
  if (values.length < period + 1) return [];
  const result: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rsi = (avg: number, loss: number) =>
    loss === 0 ? 100 : 100 - 100 / (1 + avg / loss);

  result.push(rsi(avgGain, avgLoss));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    result.push(rsi(avgGain, avgLoss));
  }
  return result;
}

// ── MACD ─────────────────────────────────────────────────────────────────────
export function calculateMACD(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const emaFast = calculateEMA(values, fast);
  const emaSlow = calculateEMA(values, slow);
  const offset = slow - fast; // emaFast is longer by this many elements

  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset] - emaSlow[i]);
  }

  const signalLine = calculateEMA(macdLine, signal);
  const sigOffset = macdLine.length - signalLine.length;
  const histogram = signalLine.map((s, i) => macdLine[i + sigOffset] - s);

  return { macdLine, signalLine, histogram };
}

// ── Volume SMA ───────────────────────────────────────────────────────────────
export function calculateVolumeMA(volumes: number[], period = 20): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < volumes.length; i++) {
    const slice = volumes.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

// ── ATR (Wilder) ─────────────────────────────────────────────────────────────
export function calculateATR(candles: Candle[], period = 14): number[] {
  if (candles.length < period + 1) return [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [atr];

  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result.push(atr);
  }
  return result;
}

// ── Auto Fibonacci (swing high/low over lookback candles) ────────────────────
export function calculateAutoFibonacci(
  candles: Candle[],
  lookback = 50
): FibonacciLevels {
  const slice = candles.slice(-lookback);
  const swingHigh = Math.max(...slice.map((c) => c.high));
  const swingLow = Math.min(...slice.map((c) => c.low));
  const range = swingHigh - swingLow;

  const lastClose = candles[candles.length - 1].close;
  const trend: 'UP' | 'DOWN' =
    lastClose > (swingHigh + swingLow) / 2 ? 'UP' : 'DOWN';

  return {
    level0: swingLow,
    level236: swingLow + range * 0.236,
    level382: swingLow + range * 0.382,
    level500: swingLow + range * 0.5,
    level618: swingLow + range * 0.618,
    level786: swingLow + range * 0.786,
    level100: swingHigh,
    trend,
  };
}

// ── Compute all indicators from a candle array ───────────────────────────────
export function computeIndicators(candles: Candle[]): Indicators | null {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const ema9Arr = calculateEMA(closes, 9);
  const ema21Arr = calculateEMA(closes, 21);
  const bbArr = calculateBollingerBands(closes, 20, 2);
  const rsiArr = calculateRSI(closes, 14);
  const macdObj = calculateMACD(closes, 12, 26, 9);
  const volMAArr = calculateVolumeMA(volumes, 20);
  const atrArr = calculateATR(candles, 14);

  // need at least 50 candles for reliable values
  if (
    !ema9Arr.length || !ema21Arr.length || !bbArr.upper.length ||
    !rsiArr.length || !macdObj.histogram.length || !volMAArr.length ||
    !atrArr.length
  ) return null;

  return {
    ema9: ema9Arr[ema9Arr.length - 1],
    ema21: ema21Arr[ema21Arr.length - 1],
    bbUpper: bbArr.upper[bbArr.upper.length - 1],
    bbMiddle: bbArr.middle[bbArr.middle.length - 1],
    bbLower: bbArr.lower[bbArr.lower.length - 1],
    rsi: rsiArr[rsiArr.length - 1],
    macdLine: macdObj.macdLine[macdObj.macdLine.length - 1],
    macdSignal: macdObj.signalLine[macdObj.signalLine.length - 1],
    macdHistogram: macdObj.histogram[macdObj.histogram.length - 1],
    volumeMA: volMAArr[volMAArr.length - 1],
    atr: atrArr[atrArr.length - 1],
    fibLevels: calculateAutoFibonacci(candles, 50),
  };
}
