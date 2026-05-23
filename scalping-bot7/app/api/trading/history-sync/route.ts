/**
 * /api/trading/history-sync
 *
 * GET  — returns the current data-store coverage and download job state
 * POST — triggers a background download/sync job
 *        body: { action: "sync" | "full-download" }
 *
 * "sync"          → incremental: only fetches candles newer than stored
 * "full-download" → bulk: fetches 2 years for all 20 pairs (one-time setup)
 */

import { NextRequest, NextResponse } from "next/server";
import { getStoreStatus }            from "@/lib/historicalDataStore";
import {
  getDownloadState,
  startFullDownload,
  startIncrementalSync,
} from "@/lib/historicalDownloader";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    storeStatus:   getStoreStatus(),
    downloadState: getDownloadState(),
  });
}

export async function POST(req: NextRequest) {
  let body: { action?: string };
  try { body = await req.json() as { action?: string }; }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }

  if (body.action === "full-download") {
    startFullDownload();
    return NextResponse.json({ ok: true, started: "full-download" });
  }

  if (body.action === "sync") {
    startIncrementalSync();
    return NextResponse.json({ ok: true, started: "sync" });
  }

  return NextResponse.json({ error: "unknown action — use 'sync' or 'full-download'" }, { status: 400 });
}
