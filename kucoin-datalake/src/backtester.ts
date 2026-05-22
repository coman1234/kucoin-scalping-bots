import type { KuCoinCandle, ParamCombo, BacktestMetrics, RegimeLabel } from "./types";
import { calculateIndicators, classifyRegime, type IndicatorResult } from "./indicators";

// ─── Internal trade record ────────────────────────────────────────────────────

type TradeDir = "BUY" | "SELL";

interface ClosedTrade {
  dir: TradeDir;
  entry: number;
  exit: number;
  entryTime: number;
  exitTime: number;
  pnlR: number; // profit/loss in R-multiples
}

// ─── Signal scoring ───────────────────────────────────────────────────────────

/**
 * Score a potential entry at bar index `i`.
 * Max score ≈ 8 points.
 * Direction context: isBuy = true for long, false for short.
 */
function scoreBar(
  i: number,
  isBuy: boolean,
  ind: IndicatorResult,
  candles: KuCoinCandle[]
): number {
  let score = 0;

  // 1. EMA cross (2 pts) — already confirmed by the caller, always counts
  score += 2;

  // 2. RSI zone (1 pt)
  const rsi = ind.rsi[i];
  if (!isNaN(rsi)) {
    if (isBuy && rsi < 65 && rsi > 30) score += 1;
    if (!isBuy && rsi > 35 && rsi < 70) score += 1;
  }

  // 3. MACD direction (1 pt)
  const macdVal = ind.macd.macd[i];
  if (!isNaN(macdVal)) {
    if (isBuy && macdVal > 0) score += 1;
    if (!isBuy && macdVal < 0) score += 1;
  }

  // 4. ADX strength (1 pt)
  const adxVal = ind.adx[i];
  if (!isNaN(adxVal) && adxVal > 20) score += 1;

  // 5. BB not in squeeze (1 pt)
  const bw = ind.bbBandwidth[i];
  if (!isNaN(bw) && bw >= 0.02) score += 1;

  // 6. Volume spike (1 pt) — compare to a rolling 20-bar average
  const vol = ind.volume[i];
  if (i >= 20) {
    let volSum = 0;
    for (let j = i - 20; j < i; j++) volSum += ind.volume[j];
    const volAvg = volSum / 20;
    if (volAvg > 0 && vol > volAvg * 1.3) score += 1;
  }

  // 7. Candle body direction (1 pt)
  const c = candles[i];
  if (isBuy && c.close > c.open) score += 1;
  if (!isBuy && c.close < c.open) score += 1;

  return score;
}

// ─── Trade simulation ─────────────────────────────────────────────────────────

function simulateTrades(
  candles: KuCoinCandle[],
  params: ParamCombo,
  ind: IndicatorResult
): ClosedTrade[] {
  const trades: ClosedTrade[] = [];

  interface Position {
    dir: TradeDir;
    entry: number;
    sl: number;
    tp: number;
    entryTime: number;
    slDist: number; // distance entry→sl in price (always positive)
  }

  let pos: Position | null = null;

  const n = candles.length;

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const atr = ind.atr[i];
    const safeAtr = !isNaN(atr) && atr > 0 ? atr : c.close * 0.002;

    // ── Check exit for open position ───────────────────────────────────────
    if (pos) {
      let exitPrice: number | null = null;
      let exitR = 0;

      if (pos.dir === "BUY") {
        if (c.low <= pos.sl) {
          exitPrice = pos.sl;
          exitR = -1;
        } else if (c.high >= pos.tp) {
          exitPrice = pos.tp;
          exitR = (pos.tp - pos.entry) / pos.slDist;
        }
      } else {
        if (c.high >= pos.sl) {
          exitPrice = pos.sl;
          exitR = -1;
        } else if (c.low <= pos.tp) {
          exitPrice = pos.tp;
          exitR = (pos.entry - pos.tp) / pos.slDist;
        }
      }

      if (exitPrice !== null) {
        trades.push({
          dir: pos.dir,
          entry: pos.entry,
          exit: exitPrice,
          entryTime: pos.entryTime,
          exitTime: c.time,
          pnlR: exitR,
        });
        pos = null;
      }
    }

    // ── Detect EMA9/EMA21 cross ────────────────────────────────────────────
    const ema9Cur  = ind.ema9[i];
    const ema9Prev = ind.ema9[i - 1];
    const ema21Cur  = ind.ema21[i];
    const ema21Prev = ind.ema21[i - 1];

    if (isNaN(ema9Cur) || isNaN(ema9Prev) || isNaN(ema21Cur) || isNaN(ema21Prev)) continue;

    const crossUp   = ema9Prev <= ema21Prev && ema9Cur > ema21Cur;
    const crossDown = ema9Prev >= ema21Prev && ema9Cur < ema21Cur;

    if (!crossUp && !crossDown) continue;

    // ── ADX filter ─────────────────────────────────────────────────────────
    const adxVal = ind.adx[i];
    if (params.adxThreshold > 0 && !isNaN(adxVal) && adxVal < params.adxThreshold) continue;

    // ── BB squeeze filter ──────────────────────────────────────────────────
    if (params.bbSqueezeFilter) {
      const bw = ind.bbBandwidth[i];
      if (!isNaN(bw) && bw < 0.02) continue;
    }

    // ── RSI conditions for entry ───────────────────────────────────────────
    const rsi = ind.rsi[i];
    const rsiOk = isNaN(rsi) || (crossUp ? rsi < 70 : rsi > 30);
    if (!rsiOk) continue;

    // ── Score ──────────────────────────────────────────────────────────────
    const isBuy = crossUp;
    const score = scoreBar(i, isBuy, ind, candles);
    if (score < params.minSignalScore) continue;

    // ── Close opposing position on opposite signal ─────────────────────────
    if (pos) {
      const oppositeExit = (isBuy && pos.dir === "SELL") || (!isBuy && pos.dir === "BUY");
      if (oppositeExit) {
        const slDist = pos.slDist;
        const pnlR =
          pos.dir === "BUY"
            ? (c.close - pos.entry) / slDist
            : (pos.entry - c.close) / slDist;
        trades.push({
          dir: pos.dir,
          entry: pos.entry,
          exit: c.close,
          entryTime: pos.entryTime,
          exitTime: c.time,
          pnlR,
        });
        pos = null;
      }
    }

    // ── Open new position ──────────────────────────────────────────────────
    if (!pos) {
      const entry = c.close;
      const slDist = safeAtr * params.stopLossAtrMultiplier;
      const tpDist = safeAtr * params.takeProfitMultiplier;

      if (isBuy) {
        pos = {
          dir: "BUY",
          entry,
          sl: entry - slDist,
          tp: entry + tpDist,
          entryTime: c.time,
          slDist,
        };
      } else {
        pos = {
          dir: "SELL",
          entry,
          sl: entry + slDist,
          tp: entry - tpDist,
          entryTime: c.time,
          slDist,
        };
      }
    }
  }

  return trades;
}

// ─── Metrics computation ──────────────────────────────────────────────────────

function computeMetrics(
  trades: ClosedTrade[],
  symbol: string,
  params: ParamCombo,
  isOOS: boolean,
  regime: RegimeLabel,
  candleCount: number
): BacktestMetrics {
  if (trades.length === 0) {
    return {
      symbol, params,
      trades: 0, wins: 0,
      winRate: 0, profitFactor: 0,
      expectancy: 0, maxDrawdownPct: 0,
      totalR: 0, sharpe: 0,
      regime, testedAt: Date.now(),
      candleCount, isOOS,
    };
  }

  const wins   = trades.filter((t) => t.pnlR > 0);
  const losses = trades.filter((t) => t.pnlR <= 0);

  const winRate      = wins.length / trades.length;
  const sumWins      = wins.reduce((s, t) => s + t.pnlR, 0);
  const sumLosses    = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? 999 : 0;
  const totalR       = trades.reduce((s, t) => s + t.pnlR, 0);
  const expectancy   = totalR / trades.length;

  // Max drawdown on equity curve (in R)
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnlR;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdownPct = maxDD * 100;

  // Sharpe (annualized, using per-trade R as return unit)
  const mean     = expectancy;
  const variance = trades.reduce((s, t) => s + (t.pnlR - mean) ** 2, 0) / trades.length;
  const stdDev   = Math.sqrt(variance);
  const sharpe   = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

  return {
    symbol, params,
    trades:       trades.length,
    wins:         wins.length,
    winRate,
    profitFactor,
    expectancy,
    maxDrawdownPct,
    totalR,
    sharpe,
    regime,
    testedAt:     Date.now(),
    candleCount,
    isOOS,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function runBacktest(
  candles: KuCoinCandle[],
  params: ParamCombo,
  oosRatio: number,
  symbol: string = ""
): { isMetrics: BacktestMetrics; oosMetrics: BacktestMetrics } {
  const makeEmpty = (oos: boolean): BacktestMetrics => ({
    symbol, params,
    trades: 0, wins: 0,
    winRate: 0, profitFactor: 0,
    expectancy: 0, maxDrawdownPct: 0,
    totalR: 0, sharpe: 0,
    regime: "unknown",
    testedAt: Date.now(),
    candleCount: 0, isOOS: oos,
  });

  if (candles.length < 50) {
    return { isMetrics: makeEmpty(false), oosMetrics: makeEmpty(true) };
  }

  // Split in-sample / out-of-sample
  const splitIdx  = Math.max(30, Math.floor(candles.length * (1 - oosRatio)));
  const isCandles  = candles.slice(0, splitIdx);
  const oosCandles = candles.slice(splitIdx);

  // Detect regime from the full set (last 50 candles)
  const fullInd = calculateIndicators(candles.slice(-50));
  const { regime } = classifyRegime(candles.slice(-50), fullInd);

  const runSlice = (slice: KuCoinCandle[], oos: boolean): BacktestMetrics => {
    if (slice.length < 30) return { ...makeEmpty(oos), regime };
    const ind    = calculateIndicators(slice);
    const trades = simulateTrades(slice, params, ind);
    return computeMetrics(trades, symbol, params, oos, regime, slice.length);
  };

  return {
    isMetrics:  runSlice(isCandles, false),
    oosMetrics: runSlice(oosCandles, true),
  };
}
