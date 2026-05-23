// ── Candle (identical to KuCoinCandle) ────────────────────────────────────────
export interface Candle {
  time: number; open: number; high: number;
  low: number; close: number; volume: number; turnover: number;
}

// ── Signal ────────────────────────────────────────────────────────────────────
export type Direction = "BUY" | "SELL" | "NEUTRAL";

export interface BreakoutSignal {
  symbol:       string;
  timeframe:    string;
  direction:    Direction;
  score:        number;          // 0–5 conditions met
  maxScore:     number;          // always 5
  reasons:      string[];        // conditions that fired
  entryPrice:   number;
  atr:          number;
  bbUpper:      number;
  bbLower:      number;
  bbSqueeze:    boolean;
  obvBullish:   boolean;
  obImbalance:  number;          // [-1, +1] from order book
  timestamp:    number;          // Unix ms
}

// ── Position ──────────────────────────────────────────────────────────────────
export type PositionState = "OPEN" | "PARTIAL" | "CLOSED";

export interface Position {
  id:              string;       // unique trade ID
  symbol:          string;
  direction:       Direction;
  entryPrice:      number;       // actual fill price (not signal price)
  entryTime:       number;       // Unix ms
  entryOrderId?:   string;       // KuCoin orderId for the entry — used to poll fill
  size:            number;       // USDT notional
  atrAtEntry:      number;       // ATR value at entry — used for break-even calc
  stopLossPrice:   number;
  tp1Price:        number;       // single TP price (tp2Price kept for compat only)
  tp2Price:        number;
  tp1Hit:          boolean;      // repurposed: true = break-even SL activated
  state:           PositionState;
  exitPrice?:          number;
  exitTime?:           number;
  pnlUsdt?:            number;
  pnlPct?:             number;
  exitReason?:         "TP1" | "TP2" | "SL" | "TIME_STOP" | "KILL_SWITCH" | "MANUAL";
  unrealizedPnlUsdt?:  number;   // mark-to-market P&L (open positions only)
  unrealizedPct?:      number;   // unrealized P&L as % of notional
  signalScore:     number;
  riskUsdt:        number;       // actual $ at risk
}

// ── Risk state ────────────────────────────────────────────────────────────────
export interface RiskState {
  accountEquity:       number;   // current balance estimate
  dailyStartEquity:    number;
  dailyPnlUsdt:        number;
  dailyPnlPct:         number;
  circuitBreakerActive: boolean; // true = no new trades
  killSwitchActive:    boolean;  // true = flatten all + halt
  totalTradesDay:      number;
  winsDay:             number;
  lossesDay:           number;
  maxDrawdownPct:      number;
  openPositions:       number;
  lastUpdated:         number;   // Unix ms
}

// ── Producer health ───────────────────────────────────────────────────────────
export interface ProducerHealth {
  alive:     boolean;
  lagMs:     number;
  cycleCount: number;
  errorCount: number;
  shmRoot:   string;
}

// ── Activity event (entry + exit feed) ───────────────────────────────────────
/** One entry in the chronological activity feed — covers both opens and closes. */
export interface ActivityEvent {
  time:        number;
  type:        "ENTERED" | "CLOSED";
  symbol:      string;
  direction:   Direction;
  price:       number;
  sizeUsdt:    number;    // notional at entry
  exitReason?: "TP1" | "TP2" | "SL" | "TIME_STOP" | "KILL_SWITCH" | "MANUAL";
  grossPnl?:   number;    // price move only
  feesUsdt?:   number;    // round-trip exchange fees
  netPnl?:     number;    // grossPnl − feesUsdt
  positionId:  string;
}

// ── Simulation / trading mode state ──────────────────────────────────────────
export type TradingMode = "LIVE" | "SIM" | "DRY";

export interface SimulationStats {
  active:      boolean;
  trades:      number;
  wins:        number;
  losses:      number;
  pnlUsdt:     number;
  pnlPct:      number;      // vs start equity
  startEquity: number;
  startedAt:   number;      // Unix ms
}

// ── Wallet ────────────────────────────────────────────────────────────────────
export interface WalletEntry {
  currency:   string;
  balance:    number;     // amount held (base currency for crypto, USDT for stablecoin)
  valueUsdt:  number;     // current estimated value in USDT
  priceUsdt?: number;     // live price (undefined for USDT itself)
  inOpenPos?: boolean;    // true when this holding is locked in an open position
}

export interface WalletState {
  entries:     WalletEntry[];
  totalUsdt:   number;    // sum of all valueUsdt
  usdtFree:    number;    // USDT not tied up in open positions
  usdtLocked:  number;    // USDT locked in open positions
  lastUpdated: number;    // Unix ms
}

// ── Dashboard state (sent to UI via API) ─────────────────────────────────────
export interface DashboardState {
  producerHealth:  ProducerHealth;
  riskState:       RiskState;
  openPositions:   Position[];
  recentTrades:    Position[];        // last 50 closed
  activityLog:     ActivityEvent[];   // last 100 events (entries + exits)
  activeSignals:   BreakoutSignal[];
  timestamp:       number;
  tradingActive:   boolean;           // is the main loop running?
  mode:            TradingMode;       // LIVE | SIM | DRY
  simulation:      SimulationStats;
  wallet:          WalletState;       // portfolio / wallet snapshot
  bot6SignalsAgeMs: number;           // ms since bot6 SHM signals were written; -1 = not available
}
