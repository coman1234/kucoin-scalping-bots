/**
 * cacheReader.ts — shared /dev/shm reader
 *
 * Copy this file verbatim into every consumer (Bot A, B, C) as lib/cacheReader.ts.
 * It has zero external dependencies beyond Node.js built-ins.
 *
 * Design:
 *  - readCandleFile / readTickerFile / readOrderBookFile return null when the
 *    file is missing, corrupt, or older than the staleness threshold.
 *  - isProducerAlive() checks meta.json heartbeat age.
 *  - All reads are synchronous (fs.readFileSync) to stay non-blocking inside
 *    Next.js API routes which already run in their own async context.
 */

import * as fs   from "node:fs";
import * as os   from "node:os";
import * as path from "node:path";

// ── Resolve SHM root (same logic as producer) ─────────────────────────────────
const SHM_ROOT: string = (() => {
  if (process.platform === "linux") {
    try { fs.accessSync("/dev/shm", fs.constants.R_OK); return "/dev/shm/kucoin-data"; }
    catch { /* fall through */ }
  }
  return path.join(os.tmpdir(), "kucoin-data");
})();

// ── Staleness thresholds (ms) ─────────────────────────────────────────────────
const STALE_TICKER_MS    =  8_000;
const STALE_ORDERBOOK_MS = 15_000;
const STALE_CANDLE_MS    = 90_000;
const PRODUCER_DEAD_MS   = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Candle {
  time: number; open: number; high: number;
  low: number;  close: number; volume: number; turnover: number;
}

export interface CandleFile {
  symbol: string; timeframe: string;
  fetchedAt: number; producerVersion: string;
  candles: Candle[];
}

export interface TickerEntry {
  symbol: string; price: number; bestBid: number; bestAsk: number;
  changeRate: number; vol: number; volValue: number;
}

export interface TickerFile {
  fetchedAt: number; producerVersion: string;
  tickers: Record<string, TickerEntry>;
}

export interface OrderBookLevel { price: number; size: number; }

export interface OrderBookFile {
  symbol: string; fetchedAt: number; producerVersion: string;
  sequence: string; bids: OrderBookLevel[]; asks: OrderBookLevel[];
}

export interface ProducerMeta {
  pid: number; version: string; startedAt: number; heartbeatAt: number;
  lastTickerUpdate: number; lastCandleUpdate: number;
  lastOrderbookUpdate: number; cycleCount: number;
  errorCount: number; shmRoot: string;
}

// ── Generic safe reader ───────────────────────────────────────────────────────

function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Read candles from cache. Returns null if missing, stale, or corrupt. */
export function readCandleFile(symbol: string, timeframe: string): CandleFile | null {
  const p    = path.join(SHM_ROOT, "candles", `${symbol}_${timeframe}.json`);
  const file = readJson<CandleFile>(p);
  if (!file) return null;
  if (Date.now() - file.fetchedAt > STALE_CANDLE_MS) return null;
  return file;
}

/** Read all tickers from cache. Returns null if missing or stale. */
export function readTickerFile(): TickerFile | null {
  const p    = path.join(SHM_ROOT, "ticker", "all.json");
  const file = readJson<TickerFile>(p);
  if (!file) return null;
  if (Date.now() - file.fetchedAt > STALE_TICKER_MS) return null;
  return file;
}

/** Read a single ticker entry. Returns null if pair missing or file stale. */
export function readTicker(symbol: string): TickerEntry | null {
  return readTickerFile()?.tickers[symbol] ?? null;
}

/** Read order book from cache. Returns null if missing or stale. */
export function readOrderBook(symbol: string): OrderBookFile | null {
  const p    = path.join(SHM_ROOT, "orderbook", `${symbol}.json`);
  const file = readJson<OrderBookFile>(p);
  if (!file) return null;
  if (Date.now() - file.fetchedAt > STALE_ORDERBOOK_MS) return null;
  return file;
}

/** Read producer heartbeat. */
export function readMeta(): ProducerMeta | null {
  return readJson<ProducerMeta>(path.join(SHM_ROOT, "meta.json"));
}

/**
 * Returns true when the producer is alive (heartbeat < PRODUCER_DEAD_MS old).
 * Consumers should check this before trusting any cached data.
 */
export function isProducerAlive(): boolean {
  const meta = readMeta();
  if (!meta) return false;
  return Date.now() - meta.heartbeatAt < PRODUCER_DEAD_MS;
}

/** How long ago (ms) the producer last wrote a heartbeat. -1 if unknown. */
export function producerLagMs(): number {
  const meta = readMeta();
  return meta ? Date.now() - meta.heartbeatAt : -1;
}

export { SHM_ROOT };
