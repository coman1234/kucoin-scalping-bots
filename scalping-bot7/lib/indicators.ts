import {
  EMA,
  BollingerBands,
  RSI,
  MACD,
  ATR,
} from "technicalindicators";
import type { KuCoinCandle } from "./kucoinPublic";

export type MarketRegime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "VOLATILE";

export interface IndicatorResult {
  ema9: number[];
  ema21: number[];
  bb: { upper: number[]; middle: number[]; lower: number[] };
  rsi: number[];
  macd: { macd: number[]; signal: number[]; histogram: number[] };
  volumeMA: number[];
  atr: number[];
  fibonacci: FibonacciLevels | null;
  gaussianChannel: GaussianChannelResult | null;
  vwap: number[];
  obv: number[];
  obvMA: number[];
  adx: number[];
  plusDI: number[];
  minusDI: number[];
  regime: MarketRegime;
}

export interface FibonacciLevels {
  high: number;
  low: number;
  range: number;
  levels: {
    "0.000": number;
    "0.236": number;
    "0.382": number;
    "0.500": number;
    "0.618": number;
    "0.786": number;
    "1.000": number;
  };
}

function simpleMA(values: number[], period: number): number[] {
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result.push(sum / period);
  }
  return result;
}

export function calculateVWAP(candles: KuCoinCandle[]): number[] {
  const result: number[] = [];
  let cumTPV = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    result.push(cumVol > 0 ? cumTPV / cumVol : c.close);
  }
  return result;
}

export function calculateOBV(
  candles: KuCoinCandle[],
  maPeriod = 20,
): { obv: number[]; obvMA: number[] } {
  const obv: number[] = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const vol  = candles[i].volume;
    const prev = obv[i - 1];
    if (candles[i].close > candles[i - 1].close)      obv[i] = prev + vol;
    else if (candles[i].close < candles[i - 1].close) obv[i] = prev - vol;
    else                                               obv[i] = prev;
  }
  const obvMA = simpleMA(obv, maPeriod);
  return { obv, obvMA };
}

export function calculateADX(
  candles: KuCoinCandle[],
  period = 14
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  if (candles.length < period * 2 + 2) return { adx: [], plusDI: [], minusDI: [] };

  const rawPlusDM: number[] = [];
  const rawMinusDM: number[] = [];
  const rawTR: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const dn = p.low - c.low;
    rawPlusDM.push(up > dn && up > 0 ? up : 0);
    rawMinusDM.push(dn > up && dn > 0 ? dn : 0);
    rawTR.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }

  function wilderSmooth(arr: number[]): number[] {
    if (arr.length < period) return [];
    const out: number[] = [];
    let s = 0;
    for (let j = 0; j < period; j++) s += arr[j];
    out.push(s);
    for (let i = period; i < arr.length; i++) {
      s = s - s / period + arr[i];
      out.push(s);
    }
    return out;
  }

  const sTR = wilderSmooth(rawTR);
  const sPlusDM = wilderSmooth(rawPlusDM);
  const sMinusDM = wilderSmooth(rawMinusDM);
  const n = sTR.length;

  const plusDI: number[] = [];
  const minusDI: number[] = [];
  const dx: number[] = [];

  for (let i = 0; i < n; i++) {
    const pdi = sTR[i] > 0 ? (100 * sPlusDM[i]) / sTR[i] : 0;
    const mdi = sTR[i] > 0 ? (100 * sMinusDM[i]) / sTR[i] : 0;
    plusDI.push(pdi);
    minusDI.push(mdi);
    const dsum = pdi + mdi;
    dx.push(dsum > 0 ? (100 * Math.abs(pdi - mdi)) / dsum : 0);
  }

  const adx: number[] = [];
  if (dx.length >= period) {
    let adxVal = 0;
    for (let j = 0; j < period; j++) adxVal += dx[j];
    adxVal /= period;
    adx.push(adxVal);
    for (let i = period; i < dx.length; i++) {
      adxVal = (adxVal * (period - 1) + dx[i]) / period;
      adx.push(adxVal);
    }
  }

  const adxLen = adx.length;
  return {
    adx,
    plusDI: plusDI.slice(-adxLen),
    minusDI: minusDI.slice(-adxLen),
  };
}

export function detectMarketRegime(
  adxResult: { adx: number[]; plusDI: number[]; minusDI: number[] },
  atr: number[],
  price: number
): MarketRegime {
  if (price <= 0 || atr.length === 0) return "RANGING";

  const lastAtr = atr[atr.length - 1];
  const atrPct = (lastAtr / price) * 100;

  if (atrPct > 3) return "VOLATILE";

  if (adxResult.adx.length === 0) return "RANGING";

  const lastAdx = adxResult.adx[adxResult.adx.length - 1];
  const lastPDI = adxResult.plusDI[adxResult.plusDI.length - 1] ?? 0;
  const lastMDI = adxResult.minusDI[adxResult.minusDI.length - 1] ?? 0;

  if (lastAdx > 25) {
    return lastPDI >= lastMDI ? "TRENDING_UP" : "TRENDING_DOWN";
  }

  return "RANGING";
}

export function calculateIndicators(candles: KuCoinCandle[]): IndicatorResult {
  const closes  = candles.map((c) => c.close);
  const highs   = candles.map((c) => c.high);
  const lows    = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const ema9  = EMA.calculate({ period: 9,  values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });

  const bbRaw = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const bbUpper = new Array<number>(bbRaw.length);
  const bbMiddle = new Array<number>(bbRaw.length);
  const bbLower = new Array<number>(bbRaw.length);
  for (let i = 0; i < bbRaw.length; i++) {
    bbUpper[i] = bbRaw[i].upper; bbMiddle[i] = bbRaw[i].middle; bbLower[i] = bbRaw[i].lower;
  }
  const bb = { upper: bbUpper, middle: bbMiddle, lower: bbLower };

  const rsi = RSI.calculate({ period: 14, values: closes });

  const macdRaw = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const macdLine = new Array<number>(macdRaw.length);
  const macdSig  = new Array<number>(macdRaw.length);
  const macdHist = new Array<number>(macdRaw.length);
  for (let i = 0; i < macdRaw.length; i++) {
    macdLine[i] = macdRaw[i].MACD      ?? 0;
    macdSig[i]  = macdRaw[i].signal    ?? 0;
    macdHist[i] = macdRaw[i].histogram ?? 0;
  }
  const macd = { macd: macdLine, signal: macdSig, histogram: macdHist };

  const volumeMA = simpleMA(volumes, 20);
  const atrRaw   = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const fibonacci = calculateFibonacci(candles.slice(-100));
  const gaussianChannel = candles.length >= 50 ? calculateGaussianChannel(candles) : null;

  const vwap      = calculateVWAP(candles);
  const obvResult = calculateOBV(candles);
  const adxResult = calculateADX(candles);
  const price     = closes[closes.length - 1] ?? 0;
  const regime    = detectMarketRegime(adxResult, atrRaw, price);

  return {
    ema9, ema21, bb, rsi, macd, volumeMA, atr: atrRaw, fibonacci, gaussianChannel,
    vwap,
    obv:  obvResult.obv,
    obvMA: obvResult.obvMA,
    adx:     adxResult.adx,
    plusDI:  adxResult.plusDI,
    minusDI: adxResult.minusDI,
    regime,
  };
}

function calculateFibonacci(candles: KuCoinCandle[]): FibonacciLevels | null {
  if (candles.length < 2) return null;
  let high = -Infinity, low = Infinity;
  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low  < low)  low  = c.low;
  }
  const range = high - low;
  if (range === 0) return null;
  return {
    high, low, range,
    levels: {
      "0.000": high,
      "0.236": high - range * 0.236,
      "0.382": high - range * 0.382,
      "0.500": high - range * 0.5,
      "0.618": high - range * 0.618,
      "0.786": high - range * 0.786,
      "1.000": low,
    },
  };
}

export function detectCross(seriesA: number[], seriesB: number[]): "bullish" | "bearish" | null {
  const len = Math.min(seriesA.length, seriesB.length);
  if (len < 2) return null;
  const prevA = seriesA[len - 2]; const prevB = seriesB[len - 2];
  const currA = seriesA[len - 1]; const currB = seriesB[len - 1];
  if (prevA <= prevB && currA > currB) return "bullish";
  if (prevA >= prevB && currA < currB) return "bearish";
  return null;
}

export function isNearLevel(price: number, level: number, tolerancePct = 0.3): boolean {
  return Math.abs((price - level) / level) * 100 <= tolerancePct;
}

export function volumeSpike(currentVol: number, volMA: number): boolean {
  return volMA > 0 && currentVol > volMA * 1.5;
}

export function priceChangePercent(candles: KuCoinCandle[], periods: number): number {
  if (candles.length < periods + 1) return 0;
  const recent = candles[candles.length - 1].close;
  const past   = candles[candles.length - 1 - periods].close;
  return ((recent - past) / past) * 100;
}

export interface GaussianChannelResult {
  upper: number[];
  lower: number[];
  mid: number[];
  isBullish: boolean[];
  longEntries: number[];
  longExits: number[];
}

export function calculateGaussianChannel(
  candles: KuCoinCandle[],
  period = 50,
  poles  = 4
): GaussianChannelResult {
  if (candles.length < period) {
    return { upper: [], lower: [], mid: [], isBullish: [], longEntries: [], longExits: [] };
  }

  const n     = candles.length;
  const hlc3  = new Array<number>(n);
  const highs = new Array<number>(n);
  const lows  = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    hlc3[i]  = (c.high + c.low + c.close) / 3;
    highs[i] = c.high;
    lows[i]  = c.low;
  }

  const beta  = (1 - Math.cos(2 * Math.PI / period)) / (Math.pow(Math.sqrt(2), 2 / poles) - 1);
  const alpha = -beta + Math.sqrt(beta * beta + 2 * beta);
  const decay = 1 - alpha;

  function gaussPass(values: number[]): number[] {
    const len = values.length;
    let src = values.slice(0);
    let dst = new Array<number>(len);
    for (let p = 0; p < poles; p++) {
      dst[0] = src[0];
      for (let i = 1; i < len; i++) {
        dst[i] = alpha * src[i] + decay * dst[i - 1];
      }
      const tmp = src; src = dst; dst = tmp;
    }
    return src;
  }

  const mid   = gaussPass(hlc3);
  const upper = gaussPass(highs);
  const lower = gaussPass(lows);

  const isBullish = mid.map((v, i) => i === 0 ? true : v >= mid[i - 1]);

  const longEntries: number[] = [];
  const longExits:   number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close; const currClose = candles[i].close;
    const prevLower = lower[i - 1];         const currLower = lower[i];
    const currUpper = upper[i];             const prevUpper = upper[i - 1];
    if (prevClose <= prevLower && currClose > currLower && isBullish[i]) longEntries.push(i);
    if (prevClose >= prevUpper && currClose < currUpper && !isBullish[i]) longExits.push(i);
  }

  return { upper, lower, mid, isBullish, longEntries, longExits };
}

export function nearestFibLevel(
  price: number,
  fib: FibonacciLevels,
  tolerancePct = 0.3
): { level: number; key: string; distance: number } | null {
  const entries = Object.entries(fib.levels) as [string, number][];
  for (const [key, lvl] of entries) {
    const distance = Math.abs((price - lvl) / lvl);
    if (distance * 100 <= tolerancePct) return { level: lvl, key, distance };
  }
  return null;
}

export interface AlignedIndicators {
  ema9:     number[];
  ema21:    number[];
  rsi:      number[];
  macdHist: number[];
  macdMacd: number[];
  macdSig:  number[];
  bbUpper:  number[];
  bbMiddle: number[];
  bbLower:  number[];
  volumeMA: number[];
  atr:      number[];
  vwap:     number[];
  obv:      number[];
  obvMA:    number[];
  gcUpper:  number[];
  gcLower:  number[];
  gcMid:    number[];
  gcIsBull: boolean[];
  fibonacci: FibonacciLevels | null;
  regime:   number[];
  adx:      number[];
  n:        number;
}

export function precomputeIndicators(candles: KuCoinCandle[]): AlignedIndicators {
  const n       = candles.length;
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const ema9Raw  = EMA.calculate({ period: 9,  values: closes });
  const ema21Raw = EMA.calculate({ period: 21, values: closes });
  const bbRaw    = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const rsiRaw   = RSI.calculate({ period: 14, values: closes });
  const macdRaw  = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const volMAraw = simpleMA(volumes, 20);
  const atrRaw   = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const vwapArr  = calculateVWAP(candles);
  const obvRaw   = calculateOBV(candles);
  const adxRaw   = calculateADX(candles);
  const gcRaw    = n >= 50 ? calculateGaussianChannel(candles) : null;
  const fibonacci = calculateFibonacci(candles.slice(-100));

  function align(arr: number[]): number[] {
    if (arr.length === n) return arr;
    const out = new Array<number>(n).fill(NaN);
    const off = n - arr.length;
    for (let k = 0; k < arr.length; k++) out[off + k] = arr[k];
    return out;
  }

  const atr    = align(atrRaw);
  const adxArr = align(adxRaw.adx);
  const pdiArr = align(adxRaw.plusDI);
  const mdiArr = align(adxRaw.minusDI);

  const regime = new Array<number>(n).fill(2);
  for (let i = 0; i < n; i++) {
    const price = closes[i]; const a = atr[i];
    if (!price || isNaN(a)) continue;
    if ((a / price) * 100 > 3) { regime[i] = 3; continue; }
    const adx = adxArr[i];
    if (isNaN(adx)) continue;
    if (adx > 25) regime[i] = pdiArr[i] >= mdiArr[i] ? 0 : 1;
  }

  const gcUpper   = gcRaw ? align(gcRaw.upper) : new Array<number>(n).fill(NaN);
  const gcLower   = gcRaw ? align(gcRaw.lower) : new Array<number>(n).fill(NaN);
  const gcMid     = gcRaw ? align(gcRaw.mid)   : new Array<number>(n).fill(NaN);
  const gcIsBull: boolean[] = new Array<boolean>(n).fill(false);
  if (gcRaw) {
    const off = n - gcRaw.isBullish.length;
    for (let k = 0; k < gcRaw.isBullish.length; k++) gcIsBull[off + k] = gcRaw.isBullish[k];
  }

  const bbUpperRaw  = new Array<number>(bbRaw.length);
  const bbMiddleRaw = new Array<number>(bbRaw.length);
  const bbLowerRaw  = new Array<number>(bbRaw.length);
  for (let i = 0; i < bbRaw.length; i++) {
    bbUpperRaw[i]  = bbRaw[i].upper;
    bbMiddleRaw[i] = bbRaw[i].middle;
    bbLowerRaw[i]  = bbRaw[i].lower;
  }

  const macdHistRaw = new Array<number>(macdRaw.length);
  const macdMacdRaw = new Array<number>(macdRaw.length);
  const macdSigRaw  = new Array<number>(macdRaw.length);
  for (let i = 0; i < macdRaw.length; i++) {
    macdHistRaw[i] = macdRaw[i].histogram ?? 0;
    macdMacdRaw[i] = macdRaw[i].MACD      ?? 0;
    macdSigRaw[i]  = macdRaw[i].signal    ?? 0;
  }

  return {
    ema9:     align(ema9Raw),
    ema21:    align(ema21Raw),
    rsi:      align(rsiRaw),
    macdHist: align(macdHistRaw),
    macdMacd: align(macdMacdRaw),
    macdSig:  align(macdSigRaw),
    bbUpper:  align(bbUpperRaw),
    bbMiddle: align(bbMiddleRaw),
    bbLower:  align(bbLowerRaw),
    volumeMA: align(volMAraw),
    atr, vwap: vwapArr,
    obv:   obvRaw.obv,
    obvMA: align(obvRaw.obvMA),
    gcUpper, gcLower, gcMid, gcIsBull,
    fibonacci, regime, adx: adxArr, n,
  };
}
