export const KUCOIN_BASE_URL =
  process.env.KUCOIN_BASE_URL || "https://api.kucoin.com";

// ── API call logger ───────────────────────────────────────────────────────────
// Writes one line per KuCoin HTTP request to log/api-calls-YYYY-MM-DD.log.
// Uses dynamic require() so webpack does NOT bundle fs/path into the browser
// bundle (kucoinPublic.ts is imported by some client components for types).
// Fire-and-forget (never awaited) — zero latency impact on callers.

function _p2(n: number) { return String(n).padStart(2, "0"); }

function _logApiCall(
  endpoint:  string,
  elapsedMs: number,
  status:    "ok" | "err" | "timeout",
  detail?:   string,
): void {
  // Only runs in Node.js — silently skipped in browser/edge runtime
  if (typeof window !== "undefined") return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs   = require("fs")   as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require("path") as typeof import("path");

    const d    = new Date();
    const ts   = `${d.getFullYear()}-${_p2(d.getMonth()+1)}-${_p2(d.getDate())} ` +
                 `${_p2(d.getHours())}:${_p2(d.getMinutes())}:${_p2(d.getSeconds())}`;
    const ms   = String(elapsedMs).padStart(5);
    const st   = status.toUpperCase().padEnd(7);
    const ep   = endpoint.length > 90 ? endpoint.slice(0, 90) + "…" : endpoint;
    const det  = detail ? ` | ${detail}` : "";
    const line = `[${ts}] [${ms}ms] [${st}] ${ep}${det}\n`;

    const date  = `${d.getFullYear()}-${_p2(d.getMonth()+1)}-${_p2(d.getDate())}`;
    const logDir = nodePath.join(process.cwd(), "log");
    const logFile = nodePath.join(logDir, `api-calls-${date}.log`);
    nodeFs.mkdirSync(logDir, { recursive: true });
    nodeFs.appendFileSync(logFile, line, "utf8");
  } catch { /* never crash callers */ }
}

export interface KuCoinCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

export interface KuCoinOrderBook {
  price: string;
  size: string;
  bestBid: string;
  bestBidSize: string;
  bestAsk: string;
  bestAskSize: string;
  time: number;
}

export interface KuCoinStats24h {
  symbol: string;
  high: string;
  vol: string;
  volValue: string;
  last: string;
  low: string;
  buy: string;
  sell: string;
  changeRate: string;
  changePrice: string;
  averagePrice: string;
  time: number;
}

export interface KuCoinSymbol {
  symbol: string;
  name: string;
  baseCurrency: string;
  quoteCurrency: string;
  isMarginEnabled: boolean;
  enableTrading: boolean;
  baseMinSize: string;
  quoteMinSize: string;
  baseMaxSize: string;
  quoteMaxSize: string;
  baseIncrement: string;
  quoteIncrement: string;
  priceIncrement: string;
}

// 30 s per request — candle page fetches on slow connections can exceed 12 s.
// The old 12 s limit caused AbortError on the first page of 2-year history downloads.
const PUBLIC_TIMEOUT_MS = 30_000;

async function publicGet<T>(urlPath: string): Promise<T> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), PUBLIC_TIMEOUT_MS);
  const t0         = Date.now();

  try {
    const res = await fetch(`${KUCOIN_BASE_URL}${urlPath}`, {
      headers: { "Content-Type": "application/json" },
      next:    { revalidate: 0 },
      signal:  controller.signal,
    });
    if (!res.ok) {
      _logApiCall(urlPath, Date.now() - t0, "err", `HTTP ${res.status}`);
      throw new Error(`KuCoin API error ${res.status}: ${urlPath}`);
    }
    const json = await res.json();
    if (json.code !== "200000") {
      _logApiCall(urlPath, Date.now() - t0, "err", `code ${json.code}: ${json.msg}`);
      throw new Error(`KuCoin API error code ${json.code}: ${json.msg}`);
    }
    _logApiCall(urlPath, Date.now() - t0, "ok",
      Array.isArray(json.data) ? `${(json.data as unknown[]).length} rows` : undefined);
    return json.data as T;
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      _logApiCall(urlPath, Date.now() - t0, "timeout", `>${PUBLIC_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getSymbols(): Promise<KuCoinSymbol[]> {
  return publicGet<KuCoinSymbol[]>("/api/v1/symbols");
}

// Seconds per KuCoin timeframe label
const TF_SECONDS: Record<string, number> = {
  "1min": 60, "3min": 180, "5min": 300, "15min": 900,
  "30min": 1800, "1hour": 3600, "4hour": 14400, "1day": 86400,
};

// KuCoin hard limit per single candles request
const KUCOIN_MAX_CANDLES = 1500;

// timeframe: "1min" | "3min" | "5min" | "15min" | "30min" | "1hour" | "4hour" | "1day"
export async function getCandles(
  symbol: string,
  timeframe: string,
  startAt?: number,
  endAt?: number
): Promise<KuCoinCandle[]> {
  let url = `/api/v1/market/candles?symbol=${encodeURIComponent(symbol)}&type=${timeframe}`;
  if (startAt) url += `&startAt=${startAt}`;
  if (endAt) url += `&endAt=${endAt}`;

  // Raw format: [time, open, close, high, low, volume, turnover]
  const raw = await publicGet<string[][]>(url);

  // KuCoin returns newest-first, reverse for chronological order
  return raw
    .map((c) => ({
      time: parseInt(c[0]),
      open: parseFloat(c[1]),
      close: parseFloat(c[2]),
      high: parseFloat(c[3]),
      low: parseFloat(c[4]),
      volume: parseFloat(c[5]),
      turnover: parseFloat(c[6]),
    }))
    .reverse();
}

/**
 * Paginated candle fetch — transparently splits long date ranges into multiple
 * KuCoin requests (each capped at 1500 candles) and stitches them together.
 *
 * Use this whenever you need more than ~1500 candles (e.g. 14-day backtests).
 * For 5min × 14 days = 4032 candles → 3 requests.
 * For 1min × 14 days = 20160 candles → 14 requests.
 */
export async function getCandlesPaged(
  symbol: string,
  timeframe: string,
  startAt: number,
  endAt: number
): Promise<KuCoinCandle[]> {
  const tfSec     = TF_SECONDS[timeframe] ?? 300;
  const windowSec = KUCOIN_MAX_CANDLES * tfSec;   // seconds covered per request

  const allCandles: KuCoinCandle[] = [];
  let windowStart = startAt;

  let pageCount = 0;

  while (windowStart < endAt) {
    const windowEnd = Math.min(endAt, windowStart + windowSec);

    // Rate-limit guard: small pause between page requests (except the first)
    if (pageCount > 0) await new Promise(r => setTimeout(r, 150));
    pageCount++;

    const batch = await getCandles(symbol, timeframe, windowStart, windowEnd);
    allCandles.push(...batch);
    // Advance past the last received candle to avoid duplicates on next page
    if (batch.length > 0) {
      windowStart = batch[batch.length - 1].time + tfSec;
    } else {
      // No data in this window — skip it and move forward
      windowStart = windowEnd + tfSec;
    }
  }

  // Deduplicate by timestamp (safety net) and ensure chronological order
  const seen = new Set<number>();
  return allCandles
    .filter(c => { const fresh = !seen.has(c.time); seen.add(c.time); return fresh; })
    .sort((a, b) => a.time - b.time);
}

export async function getOrderBook(symbol: string): Promise<KuCoinOrderBook> {
  return publicGet<KuCoinOrderBook>(
    `/api/v1/market/orderbook/level1?symbol=${encodeURIComponent(symbol)}`
  );
}

export async function get24hStats(symbol: string): Promise<KuCoinStats24h> {
  return publicGet<KuCoinStats24h>(
    `/api/v1/market/stats?symbol=${encodeURIComponent(symbol)}`
  );
}

export const SUPPORTED_TIMEFRAMES = [
  { value: "1min", label: "1m" },
  { value: "3min", label: "3m" },
  { value: "5min", label: "5m" },
  { value: "15min", label: "15m" },
  { value: "30min", label: "30m" },
  { value: "1hour", label: "1h" },
  { value: "4hour", label: "4h" },
  { value: "1day", label: "1D" },
];

export const DEFAULT_WATCHLIST = [
  "BTC-USDT",
  "ETH-USDT",
  "SOL-USDT",
  "BNB-USDT",
  "XRP-USDT",
  "ADA-USDT",
  "AVAX-USDT",
  "DOGE-USDT",
];
