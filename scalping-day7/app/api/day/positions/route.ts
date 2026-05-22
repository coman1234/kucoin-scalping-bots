import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function shmPath(sub: string): string {
  const base = process.platform === "linux" ? "/dev/shm" : os.tmpdir();
  return path.join(base, sub);
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

interface Position {
  symbol: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  size: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  unrealizedPnl?: number;
}

export async function GET() {
  // Read open positions from SHM (written by the trading engine)
  const positions =
    readJson<Position[]>(shmPath("datalake/day7-positions.json")) ?? [];

  return NextResponse.json(positions, {
    headers: { "Cache-Control": "no-store" },
  });
}
