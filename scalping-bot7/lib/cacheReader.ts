/**
 * cacheReader.ts — /dev/shm consumer for scalping-bot7 (Bot A)
 * SOURCE OF TRUTH: data-producer/src/cacheReader.ts — keep in sync.
 */

import * as fs   from "node:fs";
import * as os   from "node:os";
import * as path from "node:path";

export const SHM_ROOT: string = (() => {
  if (process.platform === "linux") {
    try { fs.accessSync("/dev/shm", fs.constants.R_OK); return "/dev/shm/kucoin-data"; }
    catch { /* fall through */ }
  }
  return path.join(os.tmpdir(), "kucoin-data");
})();

const STALE_TICKER_MS    =  8_000;
const STALE_ORDERBOOK_MS = 15_000;
const STALE_CANDLE_MS    = 90_000;
const PRODUCER_DEAD_MS   = 10_000;

export interface CacheCandle {
  time: number; open: number; high: number;
  low: number;  close: number; volume: number; turnover: number;
}
export interface CandleFile {
  symbol: string; timeframe: string;
  fetchedAt: number; producerVersion: string;
  candles: CacheCandle[];
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
  lastOrderbookUpdate: number; cycleCount: number; errorCount: number; shmRoot: string;
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; }
  catch { return null; }
}

export function readCandleFile(symbol: string, timeframe: string): CandleFile | null {
  const f = readJson<CandleFile>(path.join(SHM_ROOT, "candles", `${symbol}_${timeframe}.json`));
  if (!f || Date.now() - f.fetchedAt > STALE_CANDLE_MS) return null;
  return f;
}
export function readTickerFile(): TickerFile | null {
  const f = readJson<TickerFile>(path.join(SHM_ROOT, "ticker", "all.json"));
  if (!f || Date.now() - f.fetchedAt > STALE_TICKER_MS) return null;
  return f;
}
export function readTicker(symbol: string): TickerEntry | null {
  return readTickerFile()?.tickers[symbol] ?? null;
}
export function readOrderBook(symbol: string): OrderBookFile | null {
  const f = readJson<OrderBookFile>(path.join(SHM_ROOT, "orderbook", `${symbol}.json`));
  if (!f || Date.now() - f.fetchedAt > STALE_ORDERBOOK_MS) return null;
  return f;
}
export function readMeta(): ProducerMeta | null {
  return readJson<ProducerMeta>(path.join(SHM_ROOT, "meta.json"));
}
export function isProducerAlive(): boolean {
  const m = readMeta(); return !!m && Date.now() - m.heartbeatAt < PRODUCER_DEAD_MS;
}
export function producerLagMs(): number {
  const m = readMeta(); return m ? Date.now() - m.heartbeatAt : -1;
}
