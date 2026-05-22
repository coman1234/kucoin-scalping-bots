/**
 * Atomic file writer for /dev/shm
 *
 * Safety guarantee: writes go to a .tmp sibling file first, then fs.rename()
 * atomically replaces the target.  On Linux, rename(2) is atomic within the
 * same filesystem — readers will always get either the old or the new file,
 * never a partial write.  /dev/shm is a single tmpfs mount, so the guarantee
 * holds for all files under SHM_ROOT.
 *
 * Concurrency: multiple consumers can read the same file simultaneously
 * without locks.  The producer is the ONLY writer; rename serialises itself.
 */

import * as fs   from "node:fs";
import * as path from "node:path";
import { SHM_ROOT } from "./config.js";

// ── Bootstrap directory tree ──────────────────────────────────────────────────

export function ensureDirs(): void {
  for (const sub of ["candles", "ticker", "orderbook"]) {
    fs.mkdirSync(path.join(SHM_ROOT, sub), { recursive: true });
  }
}

// ── Generic atomic write ──────────────────────────────────────────────────────

export function atomicWrite(filePath: string, data: unknown): void {
  const json  = JSON.stringify(data);
  const tmp   = filePath + ".tmp";
  fs.writeFileSync(tmp, json, "utf8");
  fs.renameSync(tmp, filePath);          // atomic on Linux tmpfs
}

// ── Typed write helpers ───────────────────────────────────────────────────────

import type { CandleFile, TickerFile, OrderBookFile, ProducerMeta } from "./types.js";

export function writeCandleFile(file: CandleFile): void {
  const p = path.join(
    SHM_ROOT, "candles",
    `${file.symbol.replace("/", "-")}_${file.timeframe}.json`
  );
  atomicWrite(p, file);
}

export function writeTickerFile(file: TickerFile): void {
  atomicWrite(path.join(SHM_ROOT, "ticker", "all.json"), file);
}

export function writeOrderBookFile(file: OrderBookFile): void {
  const p = path.join(
    SHM_ROOT, "orderbook",
    `${file.symbol.replace("/", "-")}.json`
  );
  atomicWrite(p, file);
}

export function writeMeta(meta: ProducerMeta): void {
  atomicWrite(path.join(SHM_ROOT, "meta.json"), meta);
}

// ── Candle file path (used by consumers to locate files) ─────────────────────
export function candleFilePath(symbol: string, timeframe: string): string {
  return path.join(SHM_ROOT, "candles", `${symbol}_${timeframe}.json`);
}
export function tickerFilePath(): string {
  return path.join(SHM_ROOT, "ticker", "all.json");
}
export function orderbookFilePath(symbol: string): string {
  return path.join(SHM_ROOT, "orderbook", `${symbol}.json`);
}
export function metaFilePath(): string {
  return path.join(SHM_ROOT, "meta.json");
}
