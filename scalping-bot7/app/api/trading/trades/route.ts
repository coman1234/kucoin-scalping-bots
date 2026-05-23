import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const TRADES_PATH = path.join(process.cwd(), "data", "trades.json");

interface TradeRecord {
  id:              string;
  timestamp:       number;
  symbol:          string;
  direction:       "BUY" | "SELL";
  entryPrice:      number;
  exitPrice:       number;
  entryTime:       number;
  exitTime:        number;
  pnlUSDT:         number;
  pnlPct:          number;
  exitReason:      string;
  signalScore:     number;
  durationMinutes: number;
  source:          string;
  simulated:       boolean;
}

export async function GET(req: NextRequest) {
  const since = parseInt(req.nextUrl.searchParams.get("since") ?? "0");
  const limit  = parseInt(req.nextUrl.searchParams.get("limit") ?? "200");

  try {
    const raw    = await fs.readFile(TRADES_PATH, "utf-8");
    let trades   = JSON.parse(raw) as TradeRecord[];

    if (since > 0) trades = trades.filter(t => t.timestamp > since);

    // Return newest first, capped at limit
    const slice  = trades.slice(-limit).reverse();
    return NextResponse.json({ trades: slice, total: trades.length });
  } catch {
    return NextResponse.json({ trades: [], total: 0 });
  }
}
