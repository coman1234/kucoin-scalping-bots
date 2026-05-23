/**
 * Multi-pair parallel optimizer — Lepikkö "Trade Like a Pro" methodology
 */

import type { KuCoinCandle } from "./kucoinPublic";
import { runBacktest, type MTFData } from "./backtester";
import type { AlignedIndicators } from "./indicators";

export const WIN_RATE_TARGET      = 50;
export const PROFIT_FACTOR_TARGET = 1.1;
export const MIN_TRADES_REQUIRED  = 30;
export const MIN_PAIRS_REQUIRED   = 4;

export const TOP_20_PAIRS: string[] = [
  "BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "BNB-USDT",
  "DOGE-USDT", "ADA-USDT", "AVAX-USDT", "LINK-USDT", "DOT-USDT",
  "POL-USDT", "UNI-USDT", "LTC-USDT", "ATOM-USDT", "ARB-USDT",
  "NEAR-USDT", "APT-USDT", "OP-USDT", "TRX-USDT", "INJ-USDT",
];

export interface OptimizerParams {
  minSignalScore: number;
  stopLossAtrMultiplier: number;
  takeProfitMultiplier: number;
  rsiOversoldThreshold: number;
  rsiOverboughtThreshold: number;
  volumeMultiplier: number;
  tp1Ratio: number;
}

export interface PairStat {
  symbol:      string;
  winRate:     number;
  trades:      number;
  pf:          number;
  returnPct:   number;
  meetsTarget: boolean;
}

export interface OptimizerCandidate {
  params:          OptimizerParams;
  winRate:         number;
  profitFactor:    number;
  totalTrades:     number;
  totalReturnPct:  number;
  maxDrawdownPct:  number;
  sharpeRatio:     number;
  score:           number;
  meetsTarget:     boolean;
  pairsWithTarget: number;
  pairResults:     PairStat[];
}

export function buildParamGrid(): OptimizerParams[] {
  const grid: OptimizerParams[] = [];

  const tp1Ratios        = [0.25, 0.33];
  const minScores        = [6, 7, 8];
  const slMultipliers    = [1.5, 2.0, 2.5];
  const tpMultipliers    = [2.0, 2.5, 3.0];
  const rsiOversolds     = [40, 45, 50];
  const rsiOverboughts   = [55, 60, 65];
  const volMultipliers   = [1.2, 1.5];

  for (const tp1 of tp1Ratios)
    for (const minSignalScore of minScores)
      for (const sl of slMultipliers)
        for (const tp of tpMultipliers)
          for (const rsiOS of rsiOversolds)
            for (const rsiOB of rsiOverboughts)
              for (const vol of volMultipliers) {
                if (rsiOB <= rsiOS) continue;
                grid.push({
                  minSignalScore,
                  stopLossAtrMultiplier:  sl,
                  takeProfitMultiplier:   tp,
                  rsiOversoldThreshold:   rsiOS,
                  rsiOverboughtThreshold: rsiOB,
                  volumeMultiplier:       vol,
                  tp1Ratio:               tp1,
                });
              }

  return grid;
}

export function runParamSet(
  candlesMap: Record<string, KuCoinCandle[]>,
  tradeAmountUSDT: number,
  params: OptimizerParams,
  timeframe = "5min",
  precomputedMap?: Record<string, AlignedIndicators>,
  mtfMap?: Record<string, MTFData>,
): OptimizerCandidate {
  const pairResults: PairStat[] = [];
  let totalWins        = 0;
  let totalLosses      = 0;
  let totalGrossWins   = 0;
  let totalGrossLosses = 0;
  let maxDDMax         = 0;
  let returnSum        = 0;
  const allTradePcts: number[] = [];

  for (const [symbol, allCandles] of Object.entries(candlesMap)) {
    if (allCandles.length < 60) continue;

    const result = runBacktest(allCandles, {
      symbol,
      timeframe,
      tradeAmountUSDT,
      minSignalScore:         params.minSignalScore,
      takeProfitMultiplier:   params.takeProfitMultiplier,
      stopLossAtrMultiplier:  params.stopLossAtrMultiplier,
      partialExitEnabled:     true,
      rsiOversoldThreshold:   params.rsiOversoldThreshold,
      rsiOverboughtThreshold: params.rsiOverboughtThreshold,
      volumeMultiplier:       params.volumeMultiplier,
      tp1Ratio:               params.tp1Ratio,
    }, precomputedMap?.[symbol], mtfMap?.[symbol]);

    if (result.totalTrades < 2) continue;

    const grossW = result.wins   * Math.abs(result.avgWinPct  / 100 * tradeAmountUSDT);
    const grossL = result.losses * Math.abs(result.avgLossPct / 100 * tradeAmountUSDT);

    pairResults.push({
      symbol,
      winRate:     result.winRate,
      trades:      result.totalTrades,
      pf:          result.profitFactor,
      returnPct:   result.totalReturnPct,
      meetsTarget: result.winRate >= WIN_RATE_TARGET,
    });

    totalWins        += result.wins;
    totalLosses      += result.losses;
    totalGrossWins   += grossW;
    totalGrossLosses += grossL;
    maxDDMax          = Math.max(maxDDMax, result.maxDrawdownPct);
    returnSum        += result.totalReturnPct;
    for (const t of result.allTrades) allTradePcts.push(t.pnlPct);
  }

  const totalTrades = totalWins + totalLosses;
  const winRate     = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const pf          = totalGrossLosses > 0 ? totalGrossWins / totalGrossLosses
                    : totalGrossWins  > 0  ? 99 : 0;

  const avgRet   = allTradePcts.length > 0
    ? allTradePcts.reduce((a, b) => a + b, 0) / allTradePcts.length : 0;
  const variance = allTradePcts.length > 1
    ? allTradePcts.reduce((a, b) => a + (b - avgRet) ** 2, 0) / (allTradePcts.length - 1) : 0;
  const sharpe   = variance > 0 ? avgRet / Math.sqrt(variance) : 0;

  const pairsWithTarget = pairResults.filter(p => p.meetsTarget).length;
  const meetsTarget     =
    winRate     >= WIN_RATE_TARGET      &&
    pf          >= PROFIT_FACTOR_TARGET &&
    totalTrades >= MIN_TRADES_REQUIRED  &&
    pairResults.length >= MIN_PAIRS_REQUIRED;

  const score = winRate * 12 + pf * 4 + sharpe * 2;

  return {
    params,
    winRate,
    profitFactor:   pf,
    totalTrades,
    totalReturnPct: pairResults.length > 0 ? returnSum / pairResults.length : 0,
    maxDrawdownPct: maxDDMax,
    sharpeRatio:    sharpe,
    score,
    meetsTarget,
    pairsWithTarget,
    pairResults,
  };
}

export function pickBest(candidates: OptimizerCandidate[]): OptimizerCandidate | null {
  if (candidates.length === 0) return null;
  const meeting = candidates.filter(c => c.meetsTarget);
  const pool    = meeting.length > 0 ? meeting : candidates;
  return pool.reduce((best, c) => c.score > best.score ? c : best);
}
