import type { FibonacciLevels } from "./indicators";

export const HARD_CAP_USDT        = 500;
export const DAILY_DRAWDOWN_LIMIT = 0.05;
export const MIN_RISK_REWARD      = 2.0;

const SL_MAX_PCT = 1.5;
const SL_MIN_PCT = 0.5;
const TP_MAX_PCT = 5.0;
const TP_MIN_PCT = 0.6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface RiskRewardResult {
  entryPrice: number;
  stopLossPrice: number;
  stopLossPct: number;
  takeProfitPrice1: number;
  takeProfitPct1: number;
  takeProfitPrice2: number;
  takeProfitPct2: number;
  riskRewardRatio: number;
  maxLossUSDT: number;
  expectedValueUSDT: number;
  atrValue: number;
}

export function calculateRiskReward(
  entryPrice: number,
  direction: "BUY" | "SELL",
  atrValue: number,
  fibonacci: FibonacciLevels | null,
  tradeAmountUSDT: number,
  winRate = 0.5,
  slAtrMultiplier = 1.5,
  tpMultiplier = 2.5,
  tp1Ratio = 0.33,
): RiskRewardResult {
  if (!entryPrice || entryPrice <= 0) {
    return {
      entryPrice: 0, stopLossPrice: 0, stopLossPct: 0,
      takeProfitPrice1: 0, takeProfitPct1: 0,
      takeProfitPrice2: 0, takeProfitPct2: 0,
      riskRewardRatio: 0, maxLossUSDT: 0, expectedValueUSDT: 0, atrValue,
    };
  }
  if (isNaN(atrValue) || atrValue <= 0) atrValue = entryPrice * 0.005;

  const isBuy = direction === "BUY";

  let slDist = atrValue * slAtrMultiplier;

  const slMinDist = entryPrice * (SL_MIN_PCT / 100);
  const slMaxDist = entryPrice * (SL_MAX_PCT / 100);
  slDist = clamp(slDist, slMinDist, slMaxDist);

  let tpDist = slDist * tpMultiplier;

  if (fibonacci) {
    const fibLevels = Object.values(fibonacci.levels);
    for (const level of fibLevels) {
      const distToFib = Math.abs(level - entryPrice);
      if (isBuy) {
        if (level < entryPrice && slDist > 0 && Math.abs(distToFib - slDist) / slDist < 0.2) slDist = distToFib;
        if (level > entryPrice && tpDist > 0 && Math.abs(distToFib - tpDist) / tpDist < 0.2) tpDist = distToFib;
      } else {
        if (level > entryPrice && slDist > 0 && Math.abs(distToFib - slDist) / slDist < 0.2) slDist = distToFib;
        if (level < entryPrice && tpDist > 0 && Math.abs(distToFib - tpDist) / tpDist < 0.2) tpDist = distToFib;
      }
    }
  }

  slDist = clamp(slDist, slMinDist, slMaxDist);
  tpDist = Math.max(tpDist, slDist * MIN_RISK_REWARD);

  const tpMinDist = entryPrice * (TP_MIN_PCT / 100);
  const tpMaxDist = entryPrice * (TP_MAX_PCT / 100);
  tpDist = clamp(tpDist, tpMinDist, tpMaxDist);

  const rr = tpDist / slDist;

  const slPct          = (slDist / entryPrice) * 100;
  const rawMaxLoss     = tradeAmountUSDT * (slPct / 100);
  const capMultiplier  = rawMaxLoss > HARD_CAP_USDT ? HARD_CAP_USDT / rawMaxLoss : 1;
  const effectiveSize  = tradeAmountUSDT * capMultiplier;

  const stopLossPrice = isBuy ? entryPrice - slDist : entryPrice + slDist;
  const tp1Price = isBuy
    ? entryPrice + tpDist * tp1Ratio
    : entryPrice - tpDist * tp1Ratio;
  const tp2Price = isBuy ? entryPrice + tpDist : entryPrice - tpDist;

  const tp1Pct = (Math.abs(tp1Price - entryPrice) / entryPrice) * 100;
  const tp2Pct = (tpDist / entryPrice) * 100;

  const maxLossUSDT = effectiveSize * (slPct / 100);

  const avgWin       = effectiveSize * ((tp1Pct * 0.5 + tp2Pct * 0.5) / 100);
  const expectedValueUSDT = winRate * avgWin - (1 - winRate) * maxLossUSDT;

  return {
    entryPrice,
    stopLossPrice,
    stopLossPct: slPct,
    takeProfitPrice1: tp1Price,
    takeProfitPct1: tp1Pct,
    takeProfitPrice2: tp2Price,
    takeProfitPct2: tp2Pct,
    riskRewardRatio: rr,
    maxLossUSDT,
    expectedValueUSDT,
    atrValue,
  };
}

export function isSpreadTooWide(
  bidAskSpreadPct: number,
  rr: Pick<RiskRewardResult, "takeProfitPct1">,
): boolean {
  if (bidAskSpreadPct <= 0) return false;
  return bidAskSpreadPct > rr.takeProfitPct1 * 0.10;
}

export interface PositionSizeResult {
  notionalUsdt: number;
  units: number;
  riskUsdt: number;
  capApplied: boolean;
}

export function calculatePositionSize(
  entryPrice: number,
  stopLossPrice: number,
  accountBalance: number,
  riskPct: number = 1.0,
): PositionSizeResult {
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice);
  if (riskPerUnit === 0 || entryPrice === 0) {
    return { notionalUsdt: 0, units: 0, riskUsdt: 0, capApplied: false };
  }

  const riskFromPct = accountBalance * (riskPct / 100);
  const cappedRisk  = Math.min(riskFromPct, HARD_CAP_USDT);
  const capApplied  = cappedRisk < riskFromPct;

  const units        = cappedRisk / riskPerUnit;
  const notionalUsdt = units * entryPrice;

  return { notionalUsdt, units, riskUsdt: cappedRisk, capApplied };
}

export function checkDailyDrawdown(
  dailyStartBalance: number,
  currentBalance: number,
  limitPct: number = DAILY_DRAWDOWN_LIMIT,
): boolean {
  if (dailyStartBalance <= 0) return false;
  const drawdown = (dailyStartBalance - currentBalance) / dailyStartBalance;
  return drawdown >= limitPct;
}

export interface PartialExitState {
  entryPrice: number;
  tp1Price: number;
  tp2Price: number;
  currentSL: number;
  tp1Hit: boolean;
  breakEvenActive: boolean;
  remainingFraction: number;
}

export type PartialExitEvent =
  | { type: "TP1"; exitPrice: number; fraction: number; pnlPerUnit: number; newSL: number }
  | { type: "TP2"; exitPrice: number; fraction: number; pnlPerUnit: number }
  | { type: "SL";  exitPrice: number; fraction: number; pnlPerUnit: number };

export function initPartialExit(
  entryPrice: number,
  stopLossPrice: number,
  tp1Price: number,
  tp2Price: number,
): PartialExitState {
  return {
    entryPrice,
    tp1Price,
    tp2Price,
    currentSL: stopLossPrice,
    tp1Hit: false,
    breakEvenActive: false,
    remainingFraction: 1.0,
  };
}

export function stepPartialExit(
  candleHigh: number,
  candleLow: number,
  direction: "BUY" | "SELL",
  state: PartialExitState,
): PartialExitEvent | null {
  const { entryPrice, tp1Price, tp2Price, currentSL, tp1Hit, remainingFraction } = state;
  if (remainingFraction <= 0) return null;

  const isBuy = direction === "BUY";

  const slHit = isBuy ? candleLow <= currentSL : candleHigh >= currentSL;
  if (slHit) {
    const pnlPerUnit = isBuy ? currentSL - entryPrice : entryPrice - currentSL;
    state.remainingFraction = 0;
    return { type: "SL", exitPrice: currentSL, fraction: remainingFraction, pnlPerUnit };
  }

  if (!tp1Hit) {
    const hit = isBuy ? candleHigh >= tp1Price : candleLow <= tp1Price;
    if (hit) {
      const pnlPerUnit = isBuy ? tp1Price - entryPrice : entryPrice - tp1Price;
      state.tp1Hit         = true;
      state.breakEvenActive = true;
      state.currentSL      = entryPrice;
      state.remainingFraction = 0.5;
      return {
        type: "TP1",
        exitPrice: tp1Price,
        fraction: 0.5,
        pnlPerUnit,
        newSL: entryPrice,
      };
    }
  } else {
    const hit = isBuy ? candleHigh >= tp2Price : candleLow <= tp2Price;
    if (hit) {
      const pnlPerUnit = isBuy ? tp2Price - entryPrice : entryPrice - tp2Price;
      const fraction = state.remainingFraction;
      state.remainingFraction = 0;
      return { type: "TP2", exitPrice: tp2Price, fraction, pnlPerUnit };
    }
  }

  return null;
}

export function formatPct(pct: number, isBuy: boolean): string {
  const sign = isBuy ? "+" : "-";
  return `${sign}${pct.toFixed(2)}%`;
}
