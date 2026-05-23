/**
 * historicalDataStore.ts — persistent on-disk candle store for the optimizer pipeline.
 *
 * Stores KuCoinCandle arrays as JSON files:
 *   data/history/{SYMBOL}/{timeframe}.json
 *
 * Design:
 *   - Atomic writes (tmp → rename) prevent corrupt reads after crash/restart
 *   - In-memory LRU cache per symbol+tf — disk is only read once per session
 *   - storeCandlesForPair() merges + deduplicates by timestamp before writing
 *   - All timestamps are Unix SECONDS (matching KuCoin API convention)
 */

import * as fs   from "node:fs";
import * as path from "node:path";
import type { KuCoinCandle } from "./kucoinPublic";
import { TOP_20_PAIRS }     from "./autoOptimizer";

// ── Paths & config ────────────────────────────────────────────────────────────
export const HISTORY_DIR      = process.env.KUCOIN_HISTORY_DIR ?? path.join(process.cwd(), "data", "history");

/** Timeframes the pipeline downloads and stores — 15min primary + 1hour/4hour for MTF confirmation */
export const STORE_TIMEFRAMES = ["5min", "15min", "1hour", "4hour"] as const;
export type  StoreTimeframe   = (typeof STORE_TIMEFRAMES)[number];

// ── In-memory cache ───────────────────────────────────────────────────────────
const _cache = new Map<string, KuCoinCandle[]>();

function cacheKey(symbol: string, tf: string): string {
  return `${symbol}::${tf}`;
}

function storeFilePath(symbol: string, tf: string): string {
  const safeSym = symbol.replace(/[^A-Za-z0-9\-_]/g, "_");
  return path.join(HISTORY_DIR, safeSym, `${tf}.json`);
}

// ── Disk I/O ──────────────────────────────────────────────────────────────────
interface StoredFile {
  symbol:    string;
  timeframe: string;
  updatedAt: number;
  candles:   KuCoinCandle[];
}

function _loadFromDisk(symbol: string, tf: string): void {
  const key = cacheKey(symbol, tf);
  const fp  = storeFilePath(symbol, tf);
  try {
    const raw    = fs.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw) as StoredFile;
    const sorted = (parsed.candles ?? []).slice().sort((a, b) => a.time - b.time);
    _cache.set(key, sorted);
  } catch {
    _cache.set(key, []);
  }
}

function _writeToDisk(symbol: string, tf: string, candles: KuCoinCandle[]): void {
  const fp  = storeFilePath(symbol, tf);
  const dir = path.dirname(fp);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const payload: StoredFile = { symbol, timeframe: tf, updatedAt: Date.now(), candles };
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, fp);
  } catch (e) {
    console.error(`[historicalDataStore] Write failed ${symbol}/${tf}:`, e);
  }
}

function _mergeSorted(existing: KuCoinCandle[], incoming: KuCoinCandle[]): KuCoinCandle[] {
  if (incoming.length === 0) return existing;
  const seen = new Set<number>(existing.map(c => c.time));
  const combined = [...existing, ...incoming.filter(c => !seen.has(c.time))];
  combined.sort((a, b) => a.time - b.time);
  return combined;
}

// ── Public read API ───────────────────────────────────────────────────────────

export function getCandlesForPair(
  symbol:  string,
  tf:      string,
  fromTs?: number,
  toTs?:   number,
): KuCoinCandle[] {
  const key = cacheKey(symbol, tf);
  if (!_cache.has(key)) _loadFromDisk(symbol, tf);
  let candles = _cache.get(key) ?? [];
  if (fromTs !== undefined) candles = candles.filter(c => c.time >= fromTs);
  if (toTs   !== undefined) candles = candles.filter(c => c.time <= toTs);
  return candles;
}

export function getLastCandleTime(symbol: string, tf: string): number | null {
  const key = cacheKey(symbol, tf);
  if (!_cache.has(key)) _loadFromDisk(symbol, tf);
  const arr = _cache.get(key) ?? [];
  return arr.length > 0 ? arr[arr.length - 1].time : null;
}

export function getCandleCount(symbol: string, tf: string): number {
  const key = cacheKey(symbol, tf);
  if (!_cache.has(key)) _loadFromDisk(symbol, tf);
  return (_cache.get(key) ?? []).length;
}

// ── Public write API ──────────────────────────────────────────────────────────

export function storeCandlesForPair(
  symbol:     string,
  tf:         string,
  newCandles: KuCoinCandle[],
): void {
  if (newCandles.length === 0) return;
  const key = cacheKey(symbol, tf);
  if (!_cache.has(key)) _loadFromDisk(symbol, tf);
  const existing = _cache.get(key) ?? [];
  const merged   = _mergeSorted(existing, newCandles);
  _cache.set(key, merged);
  _writeToDisk(symbol, tf, merged);
}

export function evictCache(): void {
  _cache.clear();
}

// ── Store status ──────────────────────────────────────────────────────────────

export interface PairStoreStatus {
  symbol:       string;
  timeframe:    string;
  candleCount:  number;
  firstTs:      number | null;
  lastTs:       number | null;
  coverageDays: number;
  staleDays:    number;
}

export interface StoreStatus {
  pairs:        PairStoreStatus[];
  totalCandles: number;
  diskSizeMb:   number;
  lastSyncAt:   number | null;
}

export function getStoreStatus(): StoreStatus {
  const pairs: PairStoreStatus[] = [];
  let totalCandles  = 0;
  let diskSizeBytes = 0;

  for (const symbol of TOP_20_PAIRS) {
    for (const tf of STORE_TIMEFRAMES) {
      const key = cacheKey(symbol, tf);
      if (!_cache.has(key)) _loadFromDisk(symbol, tf);
      const candles = _cache.get(key) ?? [];
      const count   = candles.length;

      const firstTs    = count > 0 ? candles[0].time * 1000              : null;
      const lastTs     = count > 0 ? candles[count - 1].time * 1000      : null;
      const coverage   = (firstTs && lastTs) ? (lastTs - firstTs) / 86_400_000 : 0;
      const staleDays  = lastTs ? (Date.now() - lastTs) / 86_400_000 : 999;

      pairs.push({ symbol, timeframe: tf, candleCount: count, firstTs, lastTs,
                   coverageDays: coverage, staleDays });
      totalCandles += count;

      try { diskSizeBytes += fs.statSync(storeFilePath(symbol, tf)).size; } catch { /* missing */ }
    }
  }

  const maxLastTs  = pairs
    .filter(p => p.lastTs !== null)
    .reduce<number>((m, p) => Math.max(m, p.lastTs!), 0);
  const lastSyncAt = maxLastTs > 0 ? maxLastTs : null;

  return { pairs, totalCandles, diskSizeMb: diskSizeBytes / 1_048_576, lastSyncAt };
}
