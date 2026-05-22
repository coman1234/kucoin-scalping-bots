// ── Canonical types shared between producer and all consumers ─────────────────
// Consumers import from their local copy of cacheReader.ts which re-exports these.

export interface Candle {
  time:     number;   // Unix seconds
  open:     number;
  high:     number;
  low:      number;
  close:    number;
  volume:   number;
  turnover: number;
}

export interface CandleFile {
  symbol:          string;
  timeframe:       string;
  fetchedAt:       number;   // Unix ms
  producerVersion: string;
  candles:         Candle[]; // chronological (oldest → newest)
}

export interface TickerEntry {
  symbol:     string;
  price:      number;
  bestBid:    number;
  bestAsk:    number;
  changeRate: number;   // e.g. 0.023 = +2.3%
  vol:        number;   // base-currency 24h volume
  volValue:   number;   // quote-currency 24h volume
}

export interface TickerFile {
  fetchedAt:       number;
  producerVersion: string;
  tickers:         Record<string, TickerEntry>;  // keyed by symbol
}

export interface OrderBookLevel {
  price: number;
  size:  number;
}

export interface OrderBookFile {
  symbol:          string;
  fetchedAt:       number;
  producerVersion: string;
  sequence:        string;
  bids:            OrderBookLevel[];  // sorted best (highest) first
  asks:            OrderBookLevel[];  // sorted best (lowest) first
}

export interface ProducerMeta {
  pid:                 number;
  version:             string;
  startedAt:           number;
  heartbeatAt:         number;   // last heartbeat write (Unix ms)
  lastTickerUpdate:    number;
  lastCandleUpdate:    number;
  lastOrderbookUpdate: number;
  cycleCount:          number;
  errorCount:          number;
  shmRoot:             string;
}
