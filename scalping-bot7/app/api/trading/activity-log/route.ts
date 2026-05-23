import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { writeToFileLog, writeLogSeparator, LOG_DIR } from "@/lib/serverLogger";

export type ActivityType =
  | "BOT_START" | "BOT_STOP" | "EMERGENCY_STOP"
  | "TRADE_OPEN" | "TRADE_CLOSE" | "TRADE_TP1"
  | "SIGNAL"
  | "BACKTEST" | "BATCH_SCAN" | "OPTIMIZER"
  | "SETTINGS" | "CONNECTION"
  | "WARNING" | "ERROR" | "SYSTEM";

export type ActivitySeverity = "info" | "success" | "warning" | "error";

export interface ActivityEntry {
  id:        string;
  timestamp: number;           // unix ms
  type:      ActivityType;
  severity:  ActivitySeverity;
  title:     string;
  detail?:   string;
  symbol?:   string;
  value?:    number;           // P&L, win rate, etc.
}

const LOG_PATH    = path.join(process.cwd(), "data", "activity-log.json");
const MAX_ENTRIES = 1000;

async function readLog(): Promise<ActivityEntry[]> {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf-8");
    return JSON.parse(raw) as ActivityEntry[];
  } catch {
    return [];
  }
}

async function writeLog(entries: ActivityEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.writeFile(LOG_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

// GET — return entries (newest first) + log directory path
export async function GET(req: NextRequest) {
  const limit   = parseInt(req.nextUrl.searchParams.get("limit") ?? "200");
  const entries = await readLog();
  return NextResponse.json({
    entries: entries.slice(-limit).reverse(),
    total:   entries.length,
    logDir:  LOG_DIR,          // lets the UI display the path to the user
  });
}

// POST — append one entry to JSON store AND ~/log/ flat file
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Omit<ActivityEntry, "id" | "timestamp">;
    const entry: ActivityEntry = {
      id:        `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      ...body,
    };

    // 1. JSON store (Activity Log panel in the UI)
    const entries = await readLog();
    entries.push(entry);
    await writeLog(entries.slice(-MAX_ENTRIES));

    // 2. Flat text file in ~/log/ (tail -f friendly)
    if (entry.type === "BOT_START") {
      // Session-start separator so logs are easy to scan
      await writeLogSeparator(`BOT SESSION STARTED — ${entry.title}`);
    } else {
      await writeToFileLog(entry);
    }

    return NextResponse.json({ ok: true, id: entry.id });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE — clear the JSON store (flat files are kept for auditing)
export async function DELETE() {
  await writeLog([]);
  return NextResponse.json({ ok: true });
}
