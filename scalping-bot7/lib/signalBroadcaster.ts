/**
 * signalBroadcaster.ts — writes bot7 signals to /dev/shm for cross-bot consumption
 *
 * Runs a background interval (every BROADCAST_MS) that scans all watched pairs,
 * runs generateSignal() on each, and writes the results to:
 *   /dev/shm/kucoin-data/signals/bot7.json    (Linux)
 *   <tmpdir>/kucoin-data/signals/bot7.json    (Windows / fallback)
 */

import * as fs   from "node:fs";
import * as path from "node:path";

import { generateSignal }           from "./signalEngine";
import { readCandleFile, SHM_ROOT } from "./cacheReader";
import type { KuCoinCandle }        from "./kucoinPublic";

const BROADCAST_MS = 30_000;
const MIN_CANDLES  = 60;
const TIMEFRAME    = "5min";
const MIN_SCORE    = 1;

const WATCH_PAIRS = [
  "BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","DOGE-USDT",
  "XRP-USDT","ADA-USDT","AVAX-USDT","POL-USDT","DOT-USDT",
  "LINK-USDT","UNI-USDT","ATOM-USDT","LTC-USDT","ARB-USDT",
  "NEAR-USDT","APT-USDT","OP-USDT","TRX-USDT","INJ-USDT",
];

export interface BotSignalEntry {
  symbol:    string;
  direction: "BUY" | "SELL" | "NEUTRAL";
  score:     number;
  maxScore:  number;
  label:     string;
}

export interface BotSignalFile {
  writtenAt: number;
  timeframe: string;
  signals:   BotSignalEntry[];
}

let _timer: ReturnType<typeof setInterval> | null = null;

export function startSignalBroadcaster(): void {
  if (_timer) return;
  const outPath = path.join(SHM_ROOT, "signals", "bot7.json");
  console.log(`[signalBroadcaster] Started — ${BROADCAST_MS / 1000}s interval → ${outPath}`);
  void broadcastOnce();
  _timer = setInterval(() => void broadcastOnce(), BROADCAST_MS);
}

export function stopSignalBroadcaster(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
  console.log("[signalBroadcaster] Stopped.");
}

async function broadcastOnce(): Promise<void> {
  const signals: BotSignalEntry[] = [];

  for (const symbol of WATCH_PAIRS) {
    await new Promise(r => setTimeout(r, 1));
    try {
      const cf = readCandleFile(symbol, TIMEFRAME);
      if (!cf || cf.candles.length < MIN_CANDLES) continue;

      const result = generateSignal(cf.candles as KuCoinCandle[], MIN_SCORE);
      signals.push({
        symbol,
        direction: result.direction as "BUY" | "SELL" | "NEUTRAL",
        score:     result.score,
        maxScore:  result.maxScore ?? 13,
        label:     result.label ?? "",
      });
    } catch {
      // skip pair on transient error
    }
  }

  const outDir  = path.join(SHM_ROOT, "signals");
  const outFile = path.join(outDir, "bot7.json");
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* already exists */ }

  const payload: BotSignalFile = {
    writtenAt: Date.now(),
    timeframe: TIMEFRAME,
    signals,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload));

  const nonNeutral = signals.filter(s => s.direction !== "NEUTRAL").length;
  console.log(`[signalBroadcaster] Wrote ${signals.length} signals (${nonNeutral} non-neutral) → ${outFile}`);
}
