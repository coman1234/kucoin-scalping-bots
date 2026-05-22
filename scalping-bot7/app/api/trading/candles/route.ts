/**
 * /api/trading/candles — Bot7 (scalping-bot7)
 *
 * Cache-first strategy:
 *  1. Try /dev/shm/kucoin-data (producer cache) — zero KuCoin API calls
 *  2. Fall back to direct KuCoin fetch only when:
 *     • Producer is down / cache stale
 *     • Custom date-range requested (backtester / optimizer)
 */

import { NextRequest, NextResponse } from "next/server";
import { getCandles, getCandlesPaged } from "@/lib/kucoinPublic";
import { readCandles, isProducerAlive } from "@/lib/shmReader";

// ── Server-side in-memory fallback cache (used only when producer is down) ────
interface MemCacheEntry { candles: unknown[]; fetchedAt: number; }
const memCache = new Map<string, MemCacheEntry>();
const MEM_TTL_MS = 20_000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol    = searchParams.get("symbol");
  const timeframe = searchParams.get("timeframe") ?? "1min";
  const startAt   = searchParams.get("startAt");
  const endAt     = searchParams.get("endAt");

  if (!symbol) {
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  }

  // Date-range requests (backtest / optimizer) always go direct to KuCoin
  if (startAt && endAt) {
    try {
      const candles = await getCandlesPaged(
        symbol, timeframe, parseInt(startAt), parseInt(endAt)
      );
      return NextResponse.json({ candles, count: candles.length, source: "kucoin-direct" });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed" }, { status: 500 }
      );
    }
  }

  // ── 1. Try producer SHM cache ────────────────────────────────────────────────
  const cached = readCandles(symbol, timeframe);
  if (cached) {
    return NextResponse.json({
      candles:  cached.candles,
      count:    cached.candles.length,
      source:   "shm-cache",
      cacheAge: Date.now() - cached.fetchedAt,
    });
  }

  // ── 2. Producer down — use in-memory fallback or KuCoin ─────────────────────
  const producerStatus = isProducerAlive()
    ? "alive"
    : "dead";

  const memKey = `${symbol}:${timeframe}`;
  const memHit = memCache.get(memKey);
  if (memHit && Date.now() - memHit.fetchedAt < MEM_TTL_MS) {
    return NextResponse.json({
      candles:         memHit.candles,
      count:           memHit.candles.length,
      source:          "mem-fallback",
      producerStatus,
      warning:         "Producer cache stale — serving in-memory fallback",
    });
  }

  // ── 3. Last resort: direct KuCoin call ───────────────────────────────────────
  try {
    const candles = await getCandles(symbol, timeframe);
    memCache.set(memKey, { candles, fetchedAt: Date.now() });
    return NextResponse.json({
      candles,
      count:         candles.length,
      source:        "kucoin-fallback",
      producerStatus,
      warning:       "Producer cache unavailable — fetched directly from KuCoin",
    });
  } catch (err) {
    // If even KuCoin fails, return stale mem cache rather than a hard 500
    if (memHit) {
      return NextResponse.json({
        candles:  memHit.candles,
        count:    memHit.candles.length,
        source:   "mem-stale",
        warning:  "Producer + KuCoin both unavailable — serving stale data",
      });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch candles" },
      { status: 503 }
    );
  }
}
