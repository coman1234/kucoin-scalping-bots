"use client";

import type { KuCoinCandle } from "./kucoinPublic";
import { generateSignal, type SignalResult } from "./signalEngine";
import { calculateRiskReward, type RiskRewardResult } from "./riskReward";
import { analyzePerformance } from "./optimizer";
import {
  buildFingerprint,
  findSimilarPatterns,
  savePattern,
  updatePatternOutcome,
  type PatternFingerprint,
  type PatternAnalysis,
} from "./patternMemory";
import type { TradeResult } from "./backtester";

export interface BotConfig {
  tradingPair: string;
  timeframe: string;
  tradeAmountUSDT: number;
  maxOpenTrades: 1;
  minSignalScore: number;
  stopLossAtrMultiplier: number;
  takeProfitMultiplier: number;
  partialExitEnabled: boolean;
  backtestValidated: boolean;
}

export interface LiveTrade {
  id: string;
  orderId: string;
  stopOrderId?: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  entryTime: number;
  size: number;
  stopLossPrice: number;
  tp1Price: number;
  tp2Price: number;
  tp1Hit: boolean;
  slMovedToBreakeven: boolean;
  trailingStopPrice?: number;  // active trailing stop level (moves in favour)
  atrAtEntry?: number;         // ATR when trade was opened, used for trail distance
  currentPrice: number;
  unrealizedPnlUSDT: number;
  unrealizedPnlPct: number;
  maxFav: number;
  maxAdv: number;
  patternId?: string;
  patternAnalysis?: PatternAnalysis;
}

export interface PerformanceMetrics {
  sessionStartBalance: number;
  currentBalance: number;
  todayPnL: number;
  todayPnLPct: number;
  sessionTrades: number;
  sessionWins: number;
  sessionLosses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  expectancy: number;
  currentStreak: number;
  maxConsecutiveLosses: number;
  adaptiveThreshold: number;
  tpMultiplier: number;
}

export interface SafetyCheckResult {
  passed: boolean;
  failedChecks: string[];
}

export type BotStatus = "STOPPED" | "RUNNING" | "PAUSED" | "ERROR";

export interface BotDecisionLog {
  timestamp: number;
  action: "SIGNAL_CHECKED" | "BUY_PLACED" | "SELL_PLACED" | "SL_HIT" | "TP1_HIT" | "TP2_HIT" | "SKIPPED" | "SAFETY_FAIL" | "OPTIMIZATION";
  details: string;
  signalScore?: number;
  price?: number;
}

// Safety check: run before any order
export function runSafetyChecks(
  config: BotConfig,
  currentBalance: number,
  totalPortfolioValue: number,
  todayStartBalance: number,
  currentBalance_today: number,
  lastTradeTime: number,
  candleIntervalMs: number,
  volatility5min: number,
  bidAskSpreadPct: number,
  openPosition: LiveTrade | null,
  backtestProfitFactor: number
): SafetyCheckResult {
  const failed: string[] = [];

  if (currentBalance < config.tradeAmountUSDT) {
    failed.push(`Insufficient balance: ${currentBalance.toFixed(2)} < ${config.tradeAmountUSDT}`);
  }

  if (config.tradeAmountUSDT > totalPortfolioValue * 0.3) {
    failed.push("Trade amount > 30% of portfolio");
  }

  if (config.tradeAmountUSDT > 500) {
    failed.push("Trade amount exceeds $500 hard cap");
  }

  const dailyLossPct = ((todayStartBalance - currentBalance_today) / todayStartBalance) * 100;
  if (dailyLossPct > 5) {
    failed.push(`Daily loss limit reached: -${dailyLossPct.toFixed(1)}% > 5%`);
  }

  const cooldownMs = candleIntervalMs * 2;
  if (Date.now() - lastTradeTime < cooldownMs) {
    failed.push("Cooldown active — waiting 2 candles since last trade");
  }

  if (volatility5min > 3) {
    failed.push(`Market too volatile: ${volatility5min.toFixed(1)}% > 3%`);
  }

  if (bidAskSpreadPct > 0.5) {
    failed.push(`Spread too wide: ${bidAskSpreadPct.toFixed(2)}% > 0.5%`);
  }

  if (!config.backtestValidated || backtestProfitFactor < 1.2) {
    failed.push("Backtest not validated or profit factor < 1.2");
  }

  if (openPosition !== null) {
    failed.push("Position already open — max 1 trade at a time");
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

export function updatePerformanceMetrics(
  metrics: PerformanceMetrics,
  closedTrade: TradeResult,
  recentTrades: TradeResult[],
  currentThreshold: number,
  currentTpMultiplier: number
): PerformanceMetrics {
  const updated = { ...metrics };
  updated.sessionTrades++;
  updated.currentBalance += closedTrade.pnlUSDT;
  updated.todayPnL += closedTrade.pnlUSDT;

  if (closedTrade.pnlUSDT > 0) {
    updated.sessionWins++;
    updated.currentStreak = updated.currentStreak > 0 ? updated.currentStreak + 1 : 1;
  } else {
    updated.sessionLosses++;
    const streak = updated.currentStreak < 0 ? updated.currentStreak - 1 : -1;
    updated.currentStreak = streak;
    if (Math.abs(streak) > updated.maxConsecutiveLosses) {
      updated.maxConsecutiveLosses = Math.abs(streak);
    }
  }

  updated.winRate =
    updated.sessionTrades > 0
      ? (updated.sessionWins / updated.sessionTrades) * 100
      : 0;
  updated.todayPnLPct =
    ((updated.currentBalance - updated.sessionStartBalance) /
      updated.sessionStartBalance) *
    100;

  const wins = recentTrades.filter((t) => t.pnlUSDT > 0);
  const losses = recentTrades.filter((t) => t.pnlUSDT <= 0);
  updated.avgWinPct =
    wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  updated.avgLossPct =
    losses.length > 0
      ? losses.reduce((a, t) => a + Math.abs(t.pnlPct), 0) / losses.length
      : 0;

  const grossWins = wins.reduce((a, t) => a + t.pnlUSDT, 0);
  const grossLosses = Math.abs(losses.reduce((a, t) => a + t.pnlUSDT, 0));
  updated.profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;

  updated.expectancy =
    recentTrades.length > 0
      ? recentTrades.reduce((a, t) => a + t.pnlUSDT, 0) / recentTrades.length
      : 0;

  // Run adaptive optimization every 20 trades
  if (updated.sessionTrades % 20 === 0 && updated.sessionTrades > 0) {
    const last20 = recentTrades.slice(-20);
    const opt = analyzePerformance(last20, currentThreshold, currentTpMultiplier);
    updated.adaptiveThreshold = opt.newThreshold;
    updated.tpMultiplier = opt.newTpMultiplier;
  }

  return updated;
}

export function evaluateOpenPosition(
  position: LiveTrade,
  currentCandle: { high: number; low: number; close: number },
  currentAtr?: number
): {
  action: "TP1" | "TP2" | "SL" | "HOLD";
  exitPrice: number;
  pnlPct: number;
  newTrailingStop?: number;
} {
  const isBuy = position.direction === "BUY";
  const { high, low, close } = currentCandle;

  // ── Trailing stop management (activates after TP1 is hit) ─────────────────
  let effectiveSL = position.slMovedToBreakeven ? position.entryPrice : position.stopLossPrice;
  let newTrailingStop: number | undefined;

  if (position.tp1Hit && currentAtr) {
    const trailAtr = currentAtr * 1.5;
    const candidateTrail = isBuy ? close - trailAtr : close + trailAtr;

    // Only ratchet in the favourable direction
    const existingTrail = position.trailingStopPrice;
    if (isBuy) {
      if (existingTrail === undefined || candidateTrail > existingTrail) {
        newTrailingStop = candidateTrail;
      }
      const bestTrail = newTrailingStop ?? existingTrail;
      if (bestTrail !== undefined && bestTrail > effectiveSL) effectiveSL = bestTrail;
    } else {
      if (existingTrail === undefined || candidateTrail < existingTrail) {
        newTrailingStop = candidateTrail;
      }
      const bestTrail = newTrailingStop ?? existingTrail;
      if (bestTrail !== undefined && bestTrail < effectiveSL) effectiveSL = bestTrail;
    }
  } else if (position.trailingStopPrice !== undefined) {
    // Use previously set trailing stop even if no new ATR
    if (isBuy  && position.trailingStopPrice > effectiveSL) effectiveSL = position.trailingStopPrice;
    if (!isBuy && position.trailingStopPrice < effectiveSL) effectiveSL = position.trailingStopPrice;
  }

  // ── TP2 (only after TP1) ──────────────────────────────────────────────────
  if (position.tp1Hit) {
    const tp2Hit = isBuy ? high >= position.tp2Price : low <= position.tp2Price;
    if (tp2Hit) {
      const pnlPct = isBuy
        ? (position.tp2Price - position.entryPrice) / position.entryPrice * 100
        : (position.entryPrice - position.tp2Price) / position.entryPrice * 100;
      return { action: "TP2", exitPrice: position.tp2Price, pnlPct, newTrailingStop };
    }
  }

  // ── TP1 ───────────────────────────────────────────────────────────────────
  if (!position.tp1Hit) {
    const tp1Hit = isBuy ? high >= position.tp1Price : low <= position.tp1Price;
    if (tp1Hit) {
      const pnlPct = isBuy
        ? (position.tp1Price - position.entryPrice) / position.entryPrice * 100
        : (position.entryPrice - position.tp1Price) / position.entryPrice * 100;
      return { action: "TP1", exitPrice: position.tp1Price, pnlPct, newTrailingStop };
    }
  }

  // ── Stop-loss (static, breakeven, or trailing) ────────────────────────────
  const slHit = isBuy ? low <= effectiveSL : high >= effectiveSL;
  if (slHit) {
    const pnlPct = isBuy
      ? (effectiveSL - position.entryPrice) / position.entryPrice * 100
      : (position.entryPrice - effectiveSL) / position.entryPrice * 100;
    return { action: "SL", exitPrice: effectiveSL, pnlPct, newTrailingStop };
  }

  return { action: "HOLD", exitPrice: close, pnlPct: 0, newTrailingStop };
}

// ── Kelly Criterion position sizing ──────────────────────────────────────────
// Returns the USDT amount to risk, scaled by half-Kelly fraction (capped 25%-100% of base)
export function kellyPositionSize(
  winRate: number,    // 0-100
  avgWinPct: number,  // average win as positive %
  avgLossPct: number, // average loss as positive %
  baseAmount: number
): number {
  if (avgLossPct <= 0 || winRate <= 0 || winRate >= 100) return baseAmount;
  const p = winRate / 100;
  const b = avgWinPct / avgLossPct; // win/loss ratio
  const kelly = (b * p - (1 - p)) / b;
  const halfKelly = Math.max(0, kelly * 0.5);
  const fraction = Math.min(halfKelly, 1.0);
  // Floor at 25% so we never go completely silent after a bad streak
  return Math.max(baseAmount * 0.25, baseAmount * fraction);
}

export function shouldEnterTrade(
  signal: SignalResult,
  config: BotConfig,
  patternAnalysis: PatternAnalysis
): { enter: boolean; adjustedScore: number; reason: string } {
  const adjustedScore = signal.score + patternAnalysis.patternBonus;

  if (patternAnalysis.recommendation === "SKIP") {
    return {
      enter: false,
      adjustedScore,
      reason: `Pattern SKIP: ${patternAnalysis.recommendationReason}`,
    };
  }

  if (adjustedScore < config.minSignalScore) {
    return {
      enter: false,
      adjustedScore,
      reason: `Score ${adjustedScore.toFixed(1)} < threshold ${config.minSignalScore}`,
    };
  }

  if (signal.direction === "NEUTRAL") {
    return { enter: false, adjustedScore, reason: "Signal is NEUTRAL" };
  }

  return {
    enter: true,
    adjustedScore,
    reason: `Score ${adjustedScore.toFixed(1)} >= threshold ${config.minSignalScore}`,
  };
}
