// Candle from KuCoin API (raw)
export interface KuCoinCandle {
  time: number;      // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

// Supported timeframes
export type Timeframe = "1min" | "5min" | "15min" | "1hour" | "4hour" | "1day";

// Market regime classification
export type RegimeLabel = "trending_up" | "trending_down" | "ranging" | "volatile" | "unknown";

// Optimizer parameter combo
export interface ParamCombo {
  minSignalScore: number;
  stopLossAtrMultiplier: number;
  takeProfitMultiplier: number;
  adxThreshold: number;
  bbSqueezeFilter: boolean;
  timeframe: Timeframe;
}

// Single backtest trade result
export interface TradeResult {
  entryTime: number;
  exitTime: number;
  direction: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  rMultiple: number;
  regime: RegimeLabel;
}

// Backtest summary metrics
export interface BacktestMetrics {
  symbol: string;
  params: ParamCombo;
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPct: number;
  totalR: number;
  sharpe: number;
  regime: RegimeLabel;
  testedAt: number;
  candleCount: number;
  isOOS: boolean;   // true = out-of-sample validation split
}

// Best params per symbol (written to /dev/shm/datalake/params/{SYMBOL}.json)
export interface BestParams {
  symbol: string;
  params: ParamCombo;
  metrics: BacktestMetrics;
  updatedAt: number;
  optimizationRun: number;
  confidence: number;    // 0–1 based on OOS profitFactor
  regime: RegimeLabel;
}

// Regime snapshot (written to /dev/shm/datalake/regime/{SYMBOL}.json)
export interface RegimeSnapshot {
  symbol: string;
  regime: RegimeLabel;
  adx: number;
  atrPct: number;
  bbBandwidth: number;
  updatedAt: number;
}

// Optimizer run status (written to /dev/shm/datalake/optimizer-status.json)
export interface OptimizerStatus {
  running: boolean;
  runId: number;
  startedAt: number;
  pairsDone: number;
  pairsTotal: number;
  currentPair: string;
  combosPerSymbol: number;
  workersActive: number;
  pairProgress: Record<string, {
    done: number;
    total: number;
    status: "pending" | "running" | "done" | "error";
    bestPF: number;
    bestWR: number;
  }>;
  nextRunAt: number;
  lastRunDurationMs: number;
  totalOptimizations: number;
}

// SQLite learning record
export interface LearningRecord {
  id?: number;
  symbol: string;
  regime: RegimeLabel;
  paramsKey: string;      // JSON.stringify(ParamCombo)
  winRate: number;
  profitFactor: number;
  expectancy: number;
  trades: number;
  testedAt: number;
  runId: number;
  isOOS: number;          // 0 or 1
}

// UCB1 score per params combo
export interface UCBScore {
  paramsKey: string;
  regime: RegimeLabel;
  totalTrials: number;
  totalScore: number;
  avgScore: number;
  ucbValue: number;
}

// Data lake health check
export interface DatalakeHealth {
  status: "ok" | "degraded" | "error";
  historySymbols: number;
  oldestDataAt: number;
  newestDataAt: number;
  dbSizeBytes: number;
  shmWritable: boolean;
  lastOptimizerRun: number;
  uptime: number;
}

// Historical data file stored on disk
export interface HistoricalFile {
  symbol: string;
  timeframe: Timeframe;
  fetchedAt: number;
  candles: KuCoinCandle[];
}

// Worker thread message types
export interface WorkerRequest {
  taskId: string;
  symbol: string;
  candles: KuCoinCandle[];
  params: ParamCombo;
  oosRatio: number;    // e.g. 0.3 = last 30% is out-of-sample
}
export interface WorkerResponse {
  taskId: string;
  symbol: string;
  params: ParamCombo;
  isMetrics: BacktestMetrics;
  oosMetrics: BacktestMetrics;
  error?: string;
}
