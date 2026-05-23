import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export interface BacktestRun {
  id:         string;
  symbol:     string;
  timeframe:  string;
  runAt:      number;  // unix ms
  days:       number;
  summary: {
    totalTrades:    number;
    winRate:        number;
    profitFactor:   number;
    totalReturnPct: number;
    maxDrawdownPct: number;
  };
  trades: unknown[];
}

const LOG_PATH = path.join(process.cwd(), "data", "backtest-trades.json");

async function readLog(): Promise<BacktestRun[]> {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf-8");
    return JSON.parse(raw) as BacktestRun[];
  } catch {
    return [];
  }
}

async function writeLog(runs: BacktestRun[]): Promise<void> {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.writeFile(LOG_PATH, JSON.stringify(runs, null, 2), "utf-8");
}

// GET — return all backtest runs
export async function GET() {
  const runs = await readLog();
  return NextResponse.json({ runs, total: runs.length });
}

// POST — append one backtest run
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const run: BacktestRun = {
      id:        `bt_${Date.now()}`,
      symbol:    body.symbol,
      timeframe: body.timeframe,
      runAt:     body.runAt ?? Date.now(),
      days:      body.days ?? 3,
      summary:   body.summary,
      trades:    body.trades ?? [],
    };
    const runs = await readLog();
    // Keep last 50 runs to avoid unbounded growth
    runs.push(run);
    const trimmed = runs.slice(-50);
    await writeLog(trimmed);
    return NextResponse.json({ ok: true, id: run.id, totalRuns: trimmed.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE — clear all backtest logs
export async function DELETE() {
  await writeLog([]);
  return NextResponse.json({ ok: true });
}
