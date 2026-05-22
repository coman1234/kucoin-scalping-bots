// ─── Shared domain types for EV-Momentum Pro ───────────────────────────────

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FibonacciLevels {
  level0: number;    // swing low
  level236: number;
  level382: number;
  level500: number;
  level618: number;
  level786: number;
  level100: number;  // swing high
  trend: 'UP' | 'DOWN';
}

export interface Indicators {
  ema9: number;
  ema21: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  rsi: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  volumeMA: number;
  atr: number;
  fibLevels: FibonacciLevels;
}

export type Direction = 'LONG' | 'SHORT' | 'NEUTRAL';
export type TradeStatus = 'OPEN' | 'CLOSED_WIN' | 'CLOSED_LOSS' | 'CLOSED_BE';
export type ExitReason = 'TP1' | 'TP2' | 'SL' | 'BREAKEVEN' | 'EOD';

export interface TradePosition {
  id: string;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  size: number;         // total position size in USD
  remainingSize: number;
  breakEvenActive: boolean;
  status: TradeStatus;
  entryTime: number;
  exitTime?: number;
  exitPrice?: number;
  pnl: number;
  signalScore: number;
}

export interface BacktestParams {
  signalThreshold: number;  // minimum score (0-6) to enter
  atrMultiplierSL: number;  // SL = entry ± ATR * multiplier
  atrMultiplierTP: number;  // TP1 = entry ± ATR * multiplier (must be ≥ 2x SL)
  maxTradeUSD: number;      // hard cap per trade
  dailyDrawdownLimit: number; // fraction e.g. 0.05 = 5%
}

export interface BacktestResult {
  params: BacktestParams;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  ev: number;
  totalPnL: number;
  maxDrawdown: number;
  sharpeRatio: number;
  trades: TradePosition[];
}
