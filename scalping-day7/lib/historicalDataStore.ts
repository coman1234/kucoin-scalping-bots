/**
 * historicalDataStore.ts — read-only adapter for bot6's 2-year candle history.
 * Points to KUCOIN_HISTORY_DIR (default: bot6's data/history on server).
 * Uses CacheCandle format (identical structure to KuCoinCandle).
 */

import * as fs   from "node:fs";
import * as path from "node:path";
import type { CacheCandle } from "./cacheReader";

export const HISTORY_DIR: string =
  process.env.KUCOIN_HISTORY_DIR ??
  path.join(process.cwd(), "data", "history");

// ── In-memory cache ───────────────────────────────────────────────────────────
const _cache = new Map<string, CacheCandle[]>();

function cacheKey(symbol: string, tf: string): string { return `${symbol}::${tf}`; }

function filePath(symbol: string, tf: string): string {
  const safe = symbol.replace(/[^A-Za-z0-9\-_]/g, "_");
  return path.join(HISTORY_DIR, safe, `${tf}.json`);
}

interface StoredFile { symbol: string; timeframe: string; updatedAt: number; candles: CacheCandle[]; }

function _load(symbol: string, tf: string): void {
  const key = cacheKey(symbol, tf);
  try {
    const raw  = fs.readFileSync(filePath(symbol, tf), "utf8");
    const data = JSON.parse(raw) as StoredFile;
    const sorted = (data.candles ?? []).slice().sort((a, b) => a.time - b.time);
    const MAX_CACHED = 25_920;  // ~90 days of 5min candles
    _cache.set(key, sorted.length > MAX_CACHED ? sorted.slice(sorted.length - MAX_CACHED) : sorted);
  } catch {
    _cache.set(key, []);
  }
}

export function getCandlesForPair(symbol: string, tf: string, fromTs?: number, toTs?: number): CacheCandle[] {
  const key = cacheKey(symbol, tf);
  if (!_cache.has(key)) _load(symbol, tf);
  let c = _cache.get(key) ?? [];
  if (fromTs !== undefined) c = c.filter(x => x.time >= fromTs);
  if (toTs   !== undefined) c = c.filter(x => x.time <= toTs);
  return c;
}

export function getLastCandleTime(symbol: string, tf: string): number | null {
  const key = cacheKey(symbol, tf);
  if (!_cache.has(key)) _load(symbol, tf);
  const arr = _cache.get(key) ?? [];
  return arr.length > 0 ? arr[arr.length - 1].time : null;
}

export function getCandleCount(symbol: string, tf: string): number {
  const key = cacheKey(symbol, tf);
  if (!_cache.has(key)) _load(symbol, tf);
  return (_cache.get(key) ?? []).length;
}

export interface PairStoreStatus {
  symbol: string; timeframe: string; candleCount: number;
  firstDate: string | null; lastDate: string | null;
  coverageDays: number; ok: boolean;
}

export function getStoreStatus(pairs: string[], timeframes = ["5min", "15min"]): PairStoreStatus[] {
  return pairs.flatMap(symbol =>
    timeframes.map(tf => {
      const key = cacheKey(symbol, tf);
      if (!_cache.has(key)) _load(symbol, tf);
      const arr    = _cache.get(key) ?? [];
      const count  = arr.length;
      const firstTs = count > 0 ? arr[0].time              : null;
      const lastTs  = count > 0 ? arr[count - 1].time      : null;
      const coverage = (firstTs && lastTs) ? (lastTs - firstTs) / 86_400 : 0;
      const toDate = (ts: number | null) => ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
      return {
        symbol, timeframe: tf, candleCount: count,
        firstDate: toDate(firstTs), lastDate: toDate(lastTs),
        coverageDays: Math.round(coverage),
        ok: count >= 1000,
      };
    })
  );
}
