/**
 * GET  /api/backtest?symbol=BTC-USDT&tf=5min
 * POST /api/backtest   { symbols: ["BTC-USDT","ETH-USDT"], tf: "5min" }
 */
import { NextRequest, NextResponse } from "next/server";
import { readCandleFile }            from "@/lib/cacheReader";
import { runBacktest, runMultiBacktest } from "@/lib/backtesterC";
import { CONFIG }                    from "@/lib/traderConfig";
import type { TraderConfig }         from "@/lib/traderConfig";

function parseNum(v: string | null | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseFloat(v);
  return isFinite(n) ? n : fallback;
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

  const cf = readCandleFile(symbol, tf);
  if (!cf || cf.candles.length < 60) {
    return NextResponse.json(
      { error: `No candle data for ${symbol}/${tf}. Producer may not be running.` },
      { status: 404 }
    );
  }

  const result = runBacktest(symbol, tf, cf.candles, cfgOverride);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  let body: { symbols?: string[]; tf?: string; [key: string]: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const symbols  = Array.isArray(body.symbols) && body.symbols.length > 0
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
    const cf = readCandleFile(symbol, tf);
    if (!cf || cf.candles.length < 60) return [];
    return [{ symbol, timeframe: tf, candles: cf.candles }];
  });

  if (dataset.length === 0) {
    return NextResponse.json(
      { error: "No candle data available for any of the requested symbols." },
      { status: 404 }
    );
  }

  const { results, aggregateWarnings } = runMultiBacktest(dataset, cfgOverride);
  return NextResponse.json({ results, aggregateWarnings });
}
