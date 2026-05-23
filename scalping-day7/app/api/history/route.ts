/**
 * GET /api/history — check historical data coverage
 * Returns per-pair candle counts and date ranges from the disk store.
 */

import { NextResponse } from "next/server";
import { getStoreStatus, HISTORY_DIR } from "@/lib/historicalDataStore";

export const dynamic = "force-dynamic";

const WATCH_PAIRS = [
  "BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","DOGE-USDT",
  "XRP-USDT","ADA-USDT","AVAX-USDT","DOT-USDT",
  "LINK-USDT","UNI-USDT","ATOM-USDT","LTC-USDT","BCH-USDT",
  "NEAR-USDT","APT-USDT","ARB-USDT","OP-USDT",
];

export async function GET() {
  const status = getStoreStatus(WATCH_PAIRS, ["5min"]);
  const totalCandles = status.reduce((s, p) => s + p.candleCount, 0);
  const pairsOk      = status.filter(p => p.ok).length;
  return NextResponse.json({
    historyDir: HISTORY_DIR,
    totalCandles,
    pairsOk,
    pairsTotal: status.length,
    pairs: status,
    timestamp: Date.now(),
  });
}
