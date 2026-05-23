/**
 * GET /api/trading/candle-analysis/log
 *
 * Palauttaa tämän päivän kynttilä-analyysit JSONL-lokista.
 * Query: ?date=YYYY-MM-DD (oletus: tänään) &limit=50
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";

export const dynamic = "force-dynamic";

const LOG_DIR = path.join(process.cwd(), "log");

export async function GET(req: NextRequest) {
  const p     = req.nextUrl.searchParams;
  const limit = parseInt(p.get("limit") ?? "100", 10);
  const d     = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const date  = p.get("date") ?? today;

  const file = path.join(LOG_DIR, `candle-analysis-${date}.jsonl`);
  try {
    const raw   = await fs.readFile(file, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    // Return last `limit` entries, newest first
    const entries = lines
      .slice(-limit)
      .reverse()
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return NextResponse.json({ date, entries, total: lines.length });
  } catch {
    return NextResponse.json({ date, entries: [], total: 0 });
  }
}