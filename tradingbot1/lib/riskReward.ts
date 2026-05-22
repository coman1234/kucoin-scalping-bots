// ─── Risk/Reward Engine ──────────────────────────────────────────────────────
//
// Rules enforced:
//   • SL = entry ± (ATR × multiplier), floored at 0.3% of price
//   • TP1 ≥ 2× SL distance  (minimum 1:2 R:R)
//   • TP2 ≥ 3× SL distance  (trail for full position exit)
//   • Hard cap: max $500 notional per trade
//   • Partial exit: sell 50% at TP1, move SL to breakeven
//   • Daily drawdown guard: 5% of starting capital — reject new trades if breached
//   • No anchoring: once SL is breached, position is closed immediately

import { Direction, TradePosition, ExitReason } from './types';

export const HARD_CAP_USD = 500;
export const DAILY_DRAWDOWN_LIMIT = 0.05; // 5%
export const MIN_RR_RATIO = 2.0;

export interface TradeParams {
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  positionSizeUSD: number;
  riskAmountUSD: number;
  rewardAmountTP1: number;
  rewardAmountTP2: number;
  rrRatio: number;
}

export interface PartialExitResult {
  action: 'PARTIAL_EXIT' | 'FULL_EXIT' | 'HOLD' | 'STOP_HIT';
  exitReason: ExitReason;
  exitPrice: number;
  sizeExited: number;
  newStopLoss?: number;
  pnl: number;
}

export interface DailyRiskState {
  startingCapital: number;
  currentCapital: number;
  dailyLoss: number;
  isBreached: boolean;
}

// ── Calculate trade parameters (ATR-based dynamic stops) ────────────────────
export function calculateTradeParams(
  entryPrice: number,
  direction: Direction,
  atr: number,
  accountUSD: number,
  atrMultiplierSL = 1.5,
  atrMultiplierTP = 3.0
): TradeParams | null {
  if (direction === 'NEUTRAL') return null;

  const slDistance = Math.max(atr * atrMultiplierSL, entryPrice * 0.003);
  const tp1Distance = Math.max(atr * atrMultiplierTP, slDistance * MIN_RR_RATIO);
  const tp2Distance = tp1Distance * 1.5; // TP2 is 50% further than TP1

  // Guarantee minimum R:R
  if (tp1Distance < slDistance * MIN_RR_RATIO) return null;

  const isLong = direction === 'LONG';
  const stopLoss = isLong ? entryPrice - slDistance : entryPrice + slDistance;
  const tp1 = isLong ? entryPrice + tp1Distance : entryPrice - tp1Distance;
  const tp2 = isLong ? entryPrice + tp2Distance : entryPrice - tp2Distance;

  // Position sizing: risk max 1% of account OR $500 cap, whichever is smaller
  const riskFraction = 0.01;
  const riskAmountRaw = Math.min(accountUSD * riskFraction, HARD_CAP_USD * 0.02);
  const positionSizeUSD = Math.min(
    (riskAmountRaw / slDistance) * entryPrice,
    HARD_CAP_USD
  );
  const riskAmountUSD = (positionSizeUSD * slDistance) / entryPrice;
  const rrRatio = tp1Distance / slDistance;

  return {
    entryPrice,
    stopLoss,
    tp1,
    tp2,
    positionSizeUSD,
    riskAmountUSD,
    rewardAmountTP1: (positionSizeUSD * tp1Distance) / entryPrice,
    rewardAmountTP2: (positionSizeUSD * tp2Distance) / entryPrice,
    rrRatio,
  };
}

// ── Evaluate an open position against current price ──────────────────────────
// Implements the two-stage exit protocol:
//   Stage 1: Close 50% at TP1, move SL to breakeven
//   Stage 2: Close remaining 50% at TP2 or if BE-SL is triggered
//
// Anti-anchoring: SL is enforced immediately — no exception for "almost back"
//
export function evaluatePosition(
  position: TradePosition,
  currentPrice: number,
  currentHigh: number,
  currentLow: number
): PartialExitResult {
  const isLong = position.direction === 'LONG';

  // ── Stop-loss hit (no anchoring: cut immediately) ─────────────────────────
  const slBreached = isLong
    ? currentLow <= position.stopLoss
    : currentHigh >= position.stopLoss;

  if (slBreached) {
    const exitPrice = position.stopLoss;
    const pnl = calculatePnL(
      position.entryPrice,
      exitPrice,
      position.remainingSize,
      isLong
    );
    return {
      action: 'FULL_EXIT',
      exitReason: position.breakEvenActive ? 'BREAKEVEN' : 'SL',
      exitPrice,
      sizeExited: position.remainingSize,
      pnl,
    };
  }

  // ── TP2 hit — full exit on remaining position ─────────────────────────────
  const tp2Hit = isLong
    ? currentHigh >= position.tp2
    : currentLow <= position.tp2;

  if (tp2Hit && position.breakEvenActive) {
    const exitPrice = position.tp2;
    const pnl = calculatePnL(
      position.entryPrice,
      exitPrice,
      position.remainingSize,
      isLong
    );
    return {
      action: 'FULL_EXIT',
      exitReason: 'TP2',
      exitPrice,
      sizeExited: position.remainingSize,
      pnl,
    };
  }

  // ── TP1 hit — partial exit, activate breakeven stop ──────────────────────
  const tp1Hit = isLong
    ? currentHigh >= position.tp1
    : currentLow <= position.tp1;

  if (tp1Hit && !position.breakEvenActive) {
    const halfSize = position.size * 0.5;
    const pnl = calculatePnL(position.entryPrice, position.tp1, halfSize, isLong);
    return {
      action: 'PARTIAL_EXIT',
      exitReason: 'TP1',
      exitPrice: position.tp1,
      sizeExited: halfSize,
      newStopLoss: position.entryPrice, // move SL to breakeven
      pnl,
    };
  }

  return {
    action: 'HOLD',
    exitReason: 'TP1', // placeholder
    exitPrice: currentPrice,
    sizeExited: 0,
    pnl: 0,
  };
}

// ── Daily drawdown guard ──────────────────────────────────────────────────────
export function updateDailyRisk(
  state: DailyRiskState,
  pnl: number
): DailyRiskState {
  const currentCapital = state.currentCapital + pnl;
  const dailyLoss = state.startingCapital - currentCapital;
  const isBreached = dailyLoss / state.startingCapital >= DAILY_DRAWDOWN_LIMIT;
  return { ...state, currentCapital, dailyLoss, isBreached };
}

export function canOpenTrade(state: DailyRiskState): boolean {
  return !state.isBreached;
}

// ── Expected Value calculator ─────────────────────────────────────────────────
export function calculateEV(
  winRate: number,
  avgWin: number,
  avgLoss: number
): number {
  return winRate * avgWin - (1 - winRate) * avgLoss;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function calculatePnL(
  entry: number,
  exit: number,
  sizeUSD: number,
  isLong: boolean
): number {
  const priceDelta = isLong ? exit - entry : entry - exit;
  return (priceDelta / entry) * sizeUSD;
}

// ── Build a fresh TradePosition from entry params ─────────────────────────────
export function buildPosition(
  id: string,
  symbol: string,
  direction: Direction,
  params: TradeParams,
  entryTime: number,
  signalScore: number
): TradePosition {
  return {
    id,
    symbol,
    direction,
    entryPrice: params.entryPrice,
    stopLoss: params.stopLoss,
    tp1: params.tp1,
    tp2: params.tp2,
    size: params.positionSizeUSD,
    remainingSize: params.positionSizeUSD,
    breakEvenActive: false,
    status: 'OPEN',
    entryTime,
    pnl: 0,
    signalScore,
  };
}
