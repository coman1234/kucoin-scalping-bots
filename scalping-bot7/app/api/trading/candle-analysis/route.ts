/**
 * GET /api/trading/candle-analysis
 *
 * Ajaa signaalimoottorin historian tallennettua dataa käyttäen
 * täsmälleen valitulle kynttilän ajanhetkelle.
 *
 * Query-parametrit:
 *   symbol   — esim. "BTC-USDT"
 *   ts       — Unix-sekunnit (kynttilän aika, 15min-tarkkuudella)
 *   timeframe — "15min" (oletus)
 *
 * Vastaus: täydellinen signaalitulos + kaikki indikaattoriarvot.
 * Kirjoittaa lokimerkinnän tiedostoon log/candle-analysis-YYYY-MM-DD.jsonl.
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getCandlesForPair } from "@/lib/historicalDataStore";
import { generateSignal } from "@/lib/signalEngine";

export const dynamic = "force-dynamic";

const LOG_DIR = path.join(process.cwd(), "log");
const WINDOW  = 200;   // candles before clicked bar fed to signal engine

export async function GET(req: NextRequest) {
  const p  = req.nextUrl.searchParams;
  const symbol    = p.get("symbol") ?? "BTC-USDT";
  const ts        = parseInt(p.get("ts") ?? "0", 10);
  const timeframe = p.get("timeframe") ?? "15min";

  if (!ts) return NextResponse.json({ error: "ts required" }, { status: 400 });

  // ── Load historical candles from disk store ──────────────────────────────
  const allCandles = getCandlesForPair(symbol, timeframe);
  if (allCandles.length < 10) {
    return NextResponse.json(
      { error: `No stored ${timeframe} data for ${symbol}. Run a full download first.` },
      { status: 404 },
    );
  }

  // Find the candle at ts (exact or nearest earlier)
  let idx = allCandles.findIndex(c => c.time === ts);
  if (idx === -1) {
    // Find nearest candle at or before ts
    idx = allCandles.reduce(
      (best, c, i) => c.time <= ts && c.time > (allCandles[best]?.time ?? 0) ? i : best,
      0,
    );
  }
  if (idx < 5) {
    return NextResponse.json({ error: "Not enough history before this candle" }, { status: 400 });
  }

  // Slice up to WINDOW candles ending at idx (inclusive)
  const start  = Math.max(0, idx - WINDOW + 1);
  const slice  = allCandles.slice(start, idx + 1);
  const candle = slice[slice.length - 1];

  // ── Run signal engine ────────────────────────────────────────────────────
  const signal = generateSignal(slice, 1);  // minScore=1 so we always get scores

  // Extract key indicator values from the signal result
  const ind = signal.indicators;
  const lastI = (arr: number[]) => arr.length > 0 ? arr[arr.length - 1] : null;

  const analysis = {
    symbol,
    timeframe,
    candleTime:   candle.time,           // Unix seconds
    candleTimeIso: new Date(candle.time * 1000).toISOString(),
    candle: {
      open:   candle.open,
      high:   candle.high,
      low:    candle.low,
      close:  candle.close,
      volume: candle.volume,
    },
    direction:        signal.direction,
    score:            signal.score,
    maxScore:         signal.maxScore,
    strengthPct:      signal.strengthPct,
    label:            signal.label,
    conditionsMet:    signal.conditionsMet,
    conditionsFailed: signal.conditionsFailed,
    regime:           signal.regime,
    wickSignal:       signal.wickSignal,
    entryPrice:       signal.entryPrice,
    stopLossPrice:    signal.stopLossPrice,
    takeProfitPrice:  signal.takeProfitPrice,
    // Key indicator snapshots at this candle
    indicators: {
      ema9:       lastI(ind.ema9),
      ema21:      lastI(ind.ema21),
      rsi:        lastI(ind.rsi),
      macdHist:   lastI(ind.macd?.histogram ?? []),
      atr:        lastI(ind.atr),
      adx:        "adx" in ind ? lastI((ind as {adx: number[]}).adx) : null,
      obv:        lastI(ind.obv ?? []),
      obvMA:      lastI(ind.obvMA ?? []),
    },
    candleIndex:  idx,
    totalCandles: allCandles.length,
    loggedAt:     Date.now(),
  };

  // ── Write to JSONL log ───────────────────────────────────────────────────
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const d     = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const file  = path.join(LOG_DIR, `candle-analysis-${stamp}.jsonl`);
    await fs.appendFile(file, JSON.stringify(analysis) + "\n", "utf-8");
  } catch {
    // Never crash the response over a log write failure
  }

  return NextResponse.json(analysis);
}