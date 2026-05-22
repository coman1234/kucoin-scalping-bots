import {
  EMA,
  RSI,
  MACD,
  ATR,
  ADX,
  BollingerBands,
} from "technicalindicators";
import type { KuCoinCandle, RegimeLabel } from "./types";

// ── Public result types ───────────────────────────────────────────────────────
export interface IndicatorResult {
  ema9:  number[];
  ema21: number[];
  rsi:   number[];
  macd: { macd: number[]; signal: number[]; histogram: number[] };
  atr:   number[];
  adx:   number[];
  bbUpper: number[];
  bbMid:   number[];
  bbLower: number[];
  bbBandwidth: number[];
  volume: number[];
}

export interface RegimeResult {
  regime: RegimeLabel;
  adx: number;
  atrPct: number;
  bbBandwidth: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Pad an array with NaN at the front so its length equals `targetLen`.
 * This ensures every indicator array aligns 1:1 with the candle array.
 */
function padFront(arr: (number | undefined | null)[], targetLen: number): number[] {
  const padCount = targetLen - arr.length;
  const padding  = Array<number>(Math.max(0, padCount)).fill(NaN);
  return [
    ...padding,
    ...arr.map((v) => (v == null || isNaN(v as number) ? NaN : (v as number))),
  ];
}

function closes(candles: KuCoinCandle[]): number[] {
  return candles.map((c) => c.close);
}

function highs(candles: KuCoinCandle[]): number[] {
  return candles.map((c) => c.high);
}

function lows(candles: KuCoinCandle[]): number[] {
  return candles.map((c) => c.low);
}

// ── Main indicator calculation ────────────────────────────────────────────────
export function calculateIndicators(candles: KuCoinCandle[]): IndicatorResult {
  const n  = candles.length;
  const cl = closes(candles);
  const hi = highs(candles);
  const lo = lows(candles);

  // EMA 9
  const ema9Raw  = EMA.calculate({ period: 9,  values: cl });
  const ema9     = padFront(ema9Raw, n);

  // EMA 21
  const ema21Raw = EMA.calculate({ period: 21, values: cl });
  const ema21    = padFront(ema21Raw, n);

  // RSI 14
  const rsiRaw   = RSI.calculate({ period: 14, values: cl });
  const rsi      = padFront(rsiRaw, n);

  // MACD (12, 26, 9)
  const macdRaw  = MACD.calculate({
    values:          cl,
    fastPeriod:      12,
    slowPeriod:      26,
    signalPeriod:    9,
    SimpleMAOscillator: false,
    SimpleMASignal:     false,
  });
  const macdLine  = padFront(macdRaw.map((v) => v.MACD       ?? NaN), n);
  const signalLine= padFront(macdRaw.map((v) => v.signal     ?? NaN), n);
  const histogram = padFront(macdRaw.map((v) => v.histogram  ?? NaN), n);

  // ATR 14
  const atrRaw   = ATR.calculate({ period: 14, high: hi, low: lo, close: cl });
  const atr      = padFront(atrRaw, n);

  // ADX 14
  const adxRaw   = ADX.calculate({ period: 14, high: hi, low: lo, close: cl });
  const adxArr   = padFront(adxRaw.map((v) => v.adx ?? NaN), n);

  // Bollinger Bands (20, 2)
  const bbRaw    = BollingerBands.calculate({ period: 20, stdDev: 2, values: cl });
  const bbUpper  = padFront(bbRaw.map((v) => v.upper  ?? NaN), n);
  const bbMid    = padFront(bbRaw.map((v) => v.middle ?? NaN), n);
  const bbLower  = padFront(bbRaw.map((v) => v.lower  ?? NaN), n);

  // BB Bandwidth = (upper - lower) / middle
  const bbBandwidth = bbUpper.map((u, i) => {
    const mid = bbMid[i];
    const lo2 = bbLower[i];
    if (isNaN(u) || isNaN(mid) || isNaN(lo2) || mid === 0) return NaN;
    return (u - lo2) / mid;
  });

  // Volume (pass-through, already aligned)
  const volume = candles.map((c) => c.volume);

  return {
    ema9,
    ema21,
    rsi,
    macd: { macd: macdLine, signal: signalLine, histogram },
    atr,
    adx: adxArr,
    bbUpper,
    bbMid,
    bbLower,
    bbBandwidth,
    volume,
  };
}

// ── Regime classification ─────────────────────────────────────────────────────
export function classifyRegime(
  candles: KuCoinCandle[],
  indicators: IndicatorResult
): RegimeResult {
  const last = candles.length - 1;
  if (last < 0) {
    return { regime: "unknown", adx: NaN, atrPct: NaN, bbBandwidth: NaN };
  }

  const close       = candles[last].close;
  const adx         = indicators.adx[last];
  const ema21       = indicators.ema21[last];
  const atrVal      = indicators.atr[last];
  const bbBandwidth = indicators.bbBandwidth[last];

  const atrPct = close > 0 && !isNaN(atrVal) ? atrVal / close : NaN;

  let regime: RegimeLabel = "ranging"; // default

  if (!isNaN(adx) && !isNaN(ema21)) {
    if (adx > 25 && close > ema21) {
      regime = "trending_up";
    } else if (adx > 25 && close < ema21) {
      regime = "trending_down";
    } else if (!isNaN(atrPct) && atrPct > 0.03) {
      regime = "volatile";
    }
    // else: ranging (already set)
  } else {
    regime = "unknown";
  }

  return { regime, adx, atrPct, bbBandwidth };
}
