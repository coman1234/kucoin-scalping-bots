import { KUCOIN_BASE_URL, REQUEST_TIMEOUT_MS, CANDLES_TO_STORE } from "./config.js";
import type { Candle, TickerEntry, OrderBookLevel } from "./types.js";

// ── Low-level HTTP helper ─────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${KUCOIN_BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      signal:  ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    const json = await res.json() as { code: string; data: T; msg?: string };
    if (json.code !== "200000") throw new Error(`KuCoin code ${json.code}: ${json.msg ?? ""}`);
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

// ── Candles ───────────────────────────────────────────────────────────────────

type RawCandle = [string, string, string, string, string, string, string];

export async function fetchCandles(
  symbol:    string,
  timeframe: string,
): Promise<Candle[]> {
  const raw = await get<RawCandle[]>(
    `/api/v1/market/candles?symbol=${encodeURIComponent(symbol)}&type=${timeframe}`
  );

  // KuCoin returns newest-first; reverse to chronological
  const candles: Candle[] = raw
    .map(c => ({
      time:     parseInt(c[0], 10),
      open:     parseFloat(c[1]),
      close:    parseFloat(c[2]),   // KuCoin: [time,open,close,high,low,vol,turnover]
      high:     parseFloat(c[3]),
      low:      parseFloat(c[4]),
      volume:   parseFloat(c[5]),
      turnover: parseFloat(c[6]),
    }))
    .reverse();

  // Keep only the most recent CANDLES_TO_STORE to bound file size
  return candles.slice(-CANDLES_TO_STORE);
}

// ── All tickers in one request ────────────────────────────────────────────────

interface RawTicker {
  symbol:     string;
  last:       string;
  bestBid:    string;
  bestAsk:    string;
  changeRate: string;
  vol:        string;
  volValue:   string;
}

export async function fetchAllTickers(
  symbols: string[]
): Promise<Record<string, TickerEntry>> {
  const data = await get<{ ticker: RawTicker[] }>("/api/v1/market/allTickers");
  const symbolSet = new Set(symbols);
  const result: Record<string, TickerEntry> = {};

  for (const t of data.ticker) {
    if (!symbolSet.has(t.symbol)) continue;
    result[t.symbol] = {
      symbol:     t.symbol,
      price:      parseFloat(t.last)       || 0,
      bestBid:    parseFloat(t.bestBid)    || 0,
      bestAsk:    parseFloat(t.bestAsk)    || 0,
      changeRate: parseFloat(t.changeRate) || 0,
      vol:        parseFloat(t.vol)        || 0,
      volValue:   parseFloat(t.volValue)   || 0,
    };
  }
  return result;
}

// ── Order book (level 2, top 20 levels) ──────────────────────────────────────

interface RawOrderBook {
  sequence: string;
  bids:     [string, string][];
  asks:     [string, string][];
}

export async function fetchOrderBook(
  symbol: string
): Promise<{ sequence: string; bids: OrderBookLevel[]; asks: OrderBookLevel[] }> {
  const data = await get<RawOrderBook>(
    `/api/v1/market/orderbook/level2_20?symbol=${encodeURIComponent(symbol)}`
  );
  return {
    sequence: data.sequence,
    bids: data.bids.map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) })),
    asks: data.asks.map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) })),
  };
}
