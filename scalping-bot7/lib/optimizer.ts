import type { TradeResult } from "./backtester";

export interface OptimizationResult {
  previousThreshold: number;
  newThreshold: number;
  thresholdChanged: boolean;
  previousTpMultiplier: number;
  newTpMultiplier: number;
  tpMultiplierChanged: boolean;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  consecutiveLosses: number;
  reason: string;
  notification: string;
}

export function analyzePerformance(
  last20Trades: TradeResult[],
  currentThreshold: number,
  currentTpMultiplier: number
): OptimizationResult {
  if (last20Trades.length === 0) {
    return {
      previousThreshold: currentThreshold,
      newThreshold: currentThreshold,
      thresholdChanged: false,
      previousTpMultiplier: currentTpMultiplier,
      newTpMultiplier: currentTpMultiplier,
      tpMultiplierChanged: false,
      winRate: 0,
      profitFactor: 0,
      expectancy: 0,
      consecutiveLosses: 0,
      reason: "Insufficient trades",
      notification: "",
    };
  }

  const wins = last20Trades.filter((t) => t.pnlUSDT > 0);
  const losses = last20Trades.filter((t) => t.pnlUSDT <= 0);
  const winRate = (wins.length / last20Trades.length) * 100;
  const grossWins = wins.reduce((a, t) => a + t.pnlUSDT, 0);
  const grossLosses = Math.abs(losses.reduce((a, t) => a + t.pnlUSDT, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;
  const expectancy = last20Trades.reduce((a, t) => a + t.pnlUSDT, 0) / last20Trades.length;

  const avgWinPct = wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((a, t) => a + Math.abs(t.pnlPct), 0) / losses.length : 0;

  // Count consecutive losses from the end
  let consecutiveLosses = 0;
  for (let i = last20Trades.length - 1; i >= 0; i--) {
    if (last20Trades[i].pnlUSDT <= 0) consecutiveLosses++;
    else break;
  }

  let newThreshold = currentThreshold;
  let newTpMultiplier = currentTpMultiplier;
  const reasons: string[] = [];

  // Threshold adjustment — target 55% win rate
  if (winRate > 65 && profitFactor > 1.5) {
    newThreshold = Math.max(3, currentThreshold - 1);
    reasons.push(`Win rate ${winRate.toFixed(0)}% > 65% → loosen threshold to get more trades`);
  } else if (winRate < 50 || profitFactor < 1.0) {
    newThreshold = Math.min(8, currentThreshold + 1);
    reasons.push(`Win rate ${winRate.toFixed(0)}% < 50% → tighten threshold (target 55%)`);
  }

  // R/R adjustment
  if (avgWinPct > 0 && avgLossPct > 0 && avgWinPct / avgLossPct < 1.5) {
    newTpMultiplier = Math.min(4.0, currentTpMultiplier + 0.25);
    reasons.push(`R/R ratio ${(avgWinPct / avgLossPct).toFixed(2)} < 1.5 → increase TP multiplier`);
  }

  if (consecutiveLosses > 4) {
    newTpMultiplier = Math.max(1.5, currentTpMultiplier - 0.25);
    reasons.push(`${consecutiveLosses} consecutive losses → tighten TP`);
  }

  const reason = reasons.join("; ") || "Performance within acceptable range — no changes";

  let notification = "";
  if (newThreshold !== currentThreshold || newTpMultiplier !== currentTpMultiplier) {
    const parts: string[] = [];
    if (newThreshold !== currentThreshold) {
      parts.push(`threshold ${currentThreshold}→${newThreshold}`);
    }
    if (newTpMultiplier !== currentTpMultiplier) {
      parts.push(`TP multiplier ${currentTpMultiplier.toFixed(2)}→${newTpMultiplier.toFixed(2)}`);
    }
    notification = `🔧 Strategy adjusted: ${parts.join(", ")} (win rate ${winRate.toFixed(0)}%)`;
  }

  return {
    previousThreshold: currentThreshold,
    newThreshold,
    thresholdChanged: newThreshold !== currentThreshold,
    previousTpMultiplier: currentTpMultiplier,
    newTpMultiplier,
    tpMultiplierChanged: newTpMultiplier !== currentTpMultiplier,
    winRate,
    profitFactor,
    expectancy,
    consecutiveLosses,
    reason,
    notification,
  };
}

export function getAdaptiveThreshold(winRate: number, currentThreshold: number): number {
  if (winRate > 65) return Math.max(3, currentThreshold - 1);
  if (winRate < 50) return Math.min(8, currentThreshold + 1);
  return currentThreshold;
}
