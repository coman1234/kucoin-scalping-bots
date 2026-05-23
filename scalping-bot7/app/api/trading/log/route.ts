import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export interface TradeLogEntry {
  id:              string;
  timestamp:       number;   // unix ms — when trade closed
  symbol:          string;
  direction:       "BUY" | "SELL";
  entryPrice:      number;
  exitPrice:       number;
  entryTime:       number;   // unix ms
  exitTime:        number;   // unix ms
  pnlUSDT:         number;
  pnlPct:          number;
  exitReason:      string;
  signalScore:     number;
  durationMinutes: number;
  source:          "single" | "multi";
  simulated:       boolean;
}

const LOG_PATH = path.join(process.cwd(), "data", "trades.json");

async function readLog(): Promise<TradeLogEntry[]> {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf-8");
    return JSON.parse(raw) as TradeLogEntry[];
  } catch {
    return [];
  }
}

async function writeLog(entries: TradeLogEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.writeFile(LOG_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

// GET — return all logged trades
export async function GET() {
  const entries = await readLog();
  return NextResponse.json({ trades: entries });
}

// POST — append one trade
export async function POST(req: NextRequest) {
  try {
    const entry = await req.json() as TradeLogEntry;
    const entries = await readLog();
    entries.push(entry);
    await writeLog(entries);
    return NextResponse.json({ ok: true, total: entries.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE — clear the log (admin reset)
export async function DELETE() {
  await writeLog([]);
  return NextResponse.json({ ok: true });
}
