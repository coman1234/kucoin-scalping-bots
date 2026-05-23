/**
 * GET  /api/backtest?symbol=BTC-USDT&tf=5min
 * POST /api/backtest  { symbols: [...], tf: "5min" }
 *
 * Uses 2-year disk history when available; falls back to SHM cache.
 */

import { NextRequest, NextResponse }           from "next/server";
import { readCandleFile }                      from "@/lib/cacheReader";
import { getCandlesForPair }                   from "@/lib/historicalDataStore";
import { runBacktest, runMultiBacktest }        from "@/lib/backtesterC";
import { CONFIG }                              from "@/lib/traderConfig";
import type { TraderConfig }                   from "@/lib/traderConfig";
import type { CacheCandle }                    from "@/lib/cacheReader";

function parseNum(v: string | null | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseFloat(v);
  return isFinite(n) ? n : fallback;
}

function getCandles(symbol: string, tf: string): CacheCandle[] {
  // 1. Try 2-year disk history first
  const hist = getCandlesForPair(symbol, tf);
  if (hist.length >= 120) return hist;
  // 2. Fall back to SHM cache (live producer)
  const cf = readCandleFile(symbol, tf);
  return cf?.candles ?? [];
}

export async function GET(req: NextRequest) {
  const p       = req.nextUrl.searchParams;
  const symbol  = p.get("symbol") ?? "BTC-USDT";
  const tf      = p.get("tf")     ?? CONFIG.signalTimeframe;

  const cfgOverride: TraderConfig = {
    ...CONFIG,
    slAtrMult:      parseNum(p.get("slAtr"),     CONFIG.slAtrMult),
    tpAtrMult:      parseNum(p.get("tpAtr"),     CONFIG.tpAtrMult),
    minScore:       parseNum(p.get("minScore"),  CONFIG.minScore),
    maxHoldMinutes: parseNum(p.get("maxHold"),   CONFIG.maxHoldMinutes),
  };

  const candles = getCandles(symbol, tf);
  if (candles.length < 60) {
    return NextResponse.json(
      { error: `No candle data for ${symbol}/${tf}. Producer or history not available.` },
      { status: 404 }
    );
  }

  const result = runBacktest(symbol, tf, candles, cfgOverride);
  return NextResponse.json({ ...result, source: candles.length > 10000 ? "disk-history" : "shm-cache" });
}

export async function POST(req: NextRequest) {
  let body: { symbols?: string[]; tf?: string; [key: string]: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const symbols = Array.isArray(body.symbols) && body.symbols.length > 0
    ? body.symbols as string[]
    : ["BTC-USDT"];
  const tf = typeof body.tf === "string" ? body.tf : CONFIG.signalTimeframe;

  const cfgOverride: TraderConfig = {
    ...CONFIG,
    slAtrMult:      parseNum(body.slAtr     as string, CONFIG.slAtrMult),
    tpAtrMult:      parseNum(body.tpAtr     as string, CONFIG.tpAtrMult),
    minScore:       parseNum(body.minScore  as string, CONFIG.minScore),
    maxHoldMinutes: parseNum(body.maxHold   as string, CONFIG.maxHoldMinutes),
  };

  const dataset = symbols.flatMap(symbol => {
    const candles = getCandles(symbol, tf);
    if (candles.length < 60) return [];
    return [{ symbol, timeframe: tf, candles }];
  });

  if (dataset.length === 0) {
    return NextResponse.json({ error: "No candle data available." }, { status: 404 });
  }

  const { results, aggregateWarnings } = runMultiBacktest(dataset, cfgOverride);
  return NextResponse.json({ results, aggregateWarnings });
}
