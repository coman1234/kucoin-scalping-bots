// ─── Backtesting Engine ──────────────────────────────────────────────────────
//
// Iterates through up to 1500 candles, applies the full signal pipeline,
// simulates trade execution with partial exits, and reports EV / win-rate.
//
// Optimiser: grid-searches signalThreshold + ATR multipliers, returns the
// parameter set with the best EV that also achieves >50% win rate.
//
// Safety rules active during backtest mirror live trading:
//   • $500 hard cap per trade
//   • 5% daily drawdown halt
//   • No position held past SL (anti-anchoring)

import { Candle, BacktestParams, BacktestResult, TradePosition, Direction } from './types';
import { scoreSignal } from './signalEngine';
import { computeIndicators } from './indicators';
import {
  calculateTradeParams,
  evaluatePosition,
  buildPosition,
  updateDailyRisk,
  canOpenTrade,
  calculateEV,
  HARD_CAP_USD,
  DAILY_DRAWDOWN_LIMIT,
} from './riskReward';
import {
  buildFingerprintFull,
  storePattern,
  recordOutcome,
  clearStore,
} from './patternMemory';

const DEFAULT_ACCOUNT_USD = 10_000;
const WARM_UP_BARS = 50; // minimum candles before we start scoring

// ── Single backtest run ───────────────────────────────────────────────────────
export function runBacktest(
  candles: Candle[],
  params: BacktestParams,
  symbol = 'UNKNOWN',
  startingCapital = DEFAULT_ACCOUNT_USD
): BacktestResult {
  clearStore();

  const limited = candles.slice(-1500); // cap at 1500 candles
  const trades: TradePosition[] = [];
  let openPosition: TradePosition | null = null;
  let prevIndicators = computeIndicators(limited.slice(0, WARM_UP_BARS));
  let tradeIdCounter = 0;

  // Daily drawdown tracking (reset each calendar day)
  let dailyState = {
    startingCapital,
    currentCapital: startingCapital,
    dailyLoss: 0,
    isBreached: false,
  };
  let lastDayTimestamp = 0;

  for (let i = WARM_UP_BARS; i < limited.length; i++) {
    const window = limited.slice(0, i + 1);
    const candle = limited[i];

    // ── Day boundary reset ──────────────────────────────────────────────────
    const dayTs = Math.floor(candle.timestamp / 86400000);
    if (dayTs !== lastDayTimestamp) {
      dailyState = {
        startingCapital: dailyState.currentCapital,
        currentCapital: dailyState.currentCapital,
        dailyLoss: 0,
        isBreached: false,
      };
      lastDayTimestamp = dayTs;
    }

    // ── Manage open position ────────────────────────────────────────────────
    if (openPosition) {
      const result = evaluatePosition(
        openPosition,
        candle.close,
        candle.high,
        candle.low
      );

      if (result.action === 'PARTIAL_EXIT') {
        openPosition.remainingSize -= result.sizeExited;
        openPosition.breakEvenActive = true;
        openPosition.stopLoss = result.newStopLoss!;
        openPosition.pnl += result.pnl;
        dailyState = updateDailyRisk(dailyState, result.pnl);
      } else if (result.action === 'FULL_EXIT') {
        openPosition.remainingSize = 0;
        openPosition.pnl += result.pnl;
        openPosition.exitPrice = result.exitPrice;
        openPosition.exitTime = candle.timestamp;
        openPosition.status = result.pnl >= 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS';

        dailyState = updateDailyRisk(dailyState, result.pnl);

        recordOutcome(openPosition.id, {
          status: openPosition.status,
          pnl: openPosition.pnl,
          holdBars: i - limited.findIndex((c) => c.timestamp === openPosition!.entryTime),
          rMultiple: openPosition.pnl /
            Math.max(0.01, Math.abs(openPosition.entryPrice - openPosition.stopLoss) *
              (openPosition.size / openPosition.entryPrice)),
        });

        trades.push({ ...openPosition });
        openPosition = null;
      }
    }

    // ── Entry logic (only if flat and daily drawdown not breached) ──────────
    if (!openPosition && canOpenTrade(dailyState)) {
      const result = scoreSignal(window, prevIndicators ?? undefined);
      if (result && result.score >= params.signalThreshold && result.direction !== 'NEUTRAL') {
        const ind = result.indicators;
        const tradeParams = calculateTradeParams(
          candle.close,
          result.direction,
          ind.atr,
          dailyState.currentCapital,
          params.atrMultiplierSL,
          params.atrMultiplierTP
        );

        if (tradeParams && tradeParams.positionSizeUSD <= params.maxTradeUSD) {
          const id = `trade-${++tradeIdCounter}`;
          openPosition = buildPosition(
            id, symbol, result.direction, tradeParams,
            candle.timestamp, result.score
          );

          const fp = buildFingerprintFull(
            id, symbol, result.direction, result.score,
            ind, candle.close, candle.volume,
            result.wick.strength,
            result.wick.direction === 'BULLISH' ? 1 :
              result.wick.direction === 'BEARISH' ? -1 : 0,
            candle.timestamp
          );
          storePattern(fp);
        }
      }
    }

    prevIndicators = computeIndicators(window) ?? prevIndicators;
  }

  // Close any trade still open at end of candle set (EOD)
  if (openPosition) {
    const lastCandle = limited[limited.length - 1];
    openPosition.exitPrice = lastCandle.close;
    openPosition.exitTime = lastCandle.timestamp;
    const eodPnl =
      openPosition.direction === 'LONG'
        ? ((lastCandle.close - openPosition.entryPrice) / openPosition.entryPrice) *
          openPosition.remainingSize
        : ((openPosition.entryPrice - lastCandle.close) / openPosition.entryPrice) *
          openPosition.remainingSize;
    openPosition.pnl += eodPnl;
    openPosition.status = openPosition.pnl >= 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS';
    trades.push({ ...openPosition });
  }

  return computeMetrics(trades, params, startingCapital);
}

// ── Compute aggregate statistics from closed trades ──────────────────────────
function computeMetrics(
  trades: TradePosition[],
  params: BacktestParams,
  startingCapital: number
): BacktestResult {
  const closed = trades.filter((t) => t.status !== 'OPEN');
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);

  const winRate = closed.length > 0 ? wins.length / closed.length : 0;
  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const ev = calculateEV(winRate, avgWin, avgLoss);
  const totalPnL = closed.reduce((s, t) => s + t.pnl, 0);

  // Max drawdown (peak-to-trough on running capital)
  let peak = startingCapital;
  let runningCapital = startingCapital;
  let maxDrawdown = 0;
  for (const t of closed) {
    runningCapital += t.pnl;
    if (runningCapital > peak) peak = runningCapital;
    const dd = (peak - runningCapital) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Simplified Sharpe (daily returns, assuming 1 trade = 1 period)
  const returns = closed.map((t) => t.pnl / startingCapital);
  const meanReturn = returns.length > 0
    ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1) : 1;
  const sharpeRatio = variance > 0 ? (meanReturn / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  return {
    params,
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    ev,
    totalPnL,
    maxDrawdown,
    sharpeRatio,
    trades,
  };
}

// ── Adaptive Parameter Optimiser ─────────────────────────────────────────────
//
// Grid-searches the parameter space every `reoptimiseEvery` trades.
// Returns the best params by EV, subject to winRate > 0.50.
// Runs on the last `windowCandles` candles to stay recent.
//
export interface OptimiserConfig {
  reoptimiseEvery: number;   // default 20
  windowCandles: number;     // default 300
  signalThresholds: number[];
  atrSLMultipliers: number[];
  atrTPMultipliers: number[];
}

export const DEFAULT_OPTIMISER_CONFIG: OptimiserConfig = {
  reoptimiseEvery: 20,
  windowCandles: 300,
  signalThresholds: [3, 4, 5],
  atrSLMultipliers: [1.0, 1.5, 2.0],
  atrTPMultipliers: [2.5, 3.0, 3.5, 4.0],
};

export function optimiseParameters(
  candles: Candle[],
  config: OptimiserConfig = DEFAULT_OPTIMISER_CONFIG,
  startingCapital = DEFAULT_ACCOUNT_USD
): { bestParams: BacktestParams; bestResult: BacktestResult; grid: BacktestResult[] } {
  const window = candles.slice(-config.windowCandles);
  const grid: BacktestResult[] = [];

  for (const threshold of config.signalThresholds) {
    for (const sl of config.atrSLMultipliers) {
      for (const tp of config.atrTPMultipliers) {
        if (tp < sl * 2) continue; // enforce minimum 2:1 R:R at param level

        const params: BacktestParams = {
          signalThreshold: threshold,
          atrMultiplierSL: sl,
          atrMultiplierTP: tp,
          maxTradeUSD: HARD_CAP_USD,
          dailyDrawdownLimit: DAILY_DRAWDOWN_LIMIT,
        };

        const result = runBacktest(window, params, 'OPT', startingCapital);
        if (result.totalTrades >= 5) { // need at least 5 trades to be meaningful
          grid.push(result);
        }
      }
    }
  }

  // Rank: positive EV AND winRate > 50%, then sort by EV descending
  const qualified = grid.filter((r) => r.winRate > 0.5 && r.ev > 0);
  const ranked = qualified.sort((a, b) => b.ev - a.ev);

  const bestResult = ranked[0] ?? grid.sort((a, b) => b.ev - a.ev)[0];
  const bestParams = bestResult?.params ?? {
    signalThreshold: 4,
    atrMultiplierSL: 1.5,
    atrMultiplierTP: 3.0,
    maxTradeUSD: HARD_CAP_USD,
    dailyDrawdownLimit: DAILY_DRAWDOWN_LIMIT,
  };

  return { bestParams, bestResult, grid };
}

// ── Convenience: run optimiser on a rolling basis ─────────────────────────────
//
// Call this every `reoptimiseEvery` completed trades to keep parameters fresh.
// Returns updated params to inject into the live signal engine.
//
export function adaptiveOptimise(
  candles: Candle[],
  completedTradeCount: number,
  currentParams: BacktestParams,
  config: OptimiserConfig = DEFAULT_OPTIMISER_CONFIG
): BacktestParams {
  if (completedTradeCount > 0 && completedTradeCount % config.reoptimiseEvery === 0) {
    const { bestParams } = optimiseParameters(candles, config);
    return bestParams;
  }
  return currentParams;
}
