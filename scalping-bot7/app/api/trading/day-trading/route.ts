import { NextRequest, NextResponse } from "next/server";
import {
  initDayTrading,
  startDayTrading,
  stopDayTrading,
  getDayTradingState,
  getDayTradingLog,
  getDayTradingConfig,
} from "@/lib/dayTradingEngine";

// Auto-init on first request — promise lock prevents double-init under concurrent requests
let initPromise: Promise<void> | null = null;
async function ensureInited() {
  if (!initPromise) {
    initPromise = initDayTrading();
  }
  await initPromise;
}

export async function GET() {
  await ensureInited();
  return NextResponse.json({
    state:  getDayTradingState(),
    log:    getDayTradingLog(),
    config: getDayTradingConfig(),
  });
}

export async function POST(req: NextRequest) {
  await ensureInited();
  let body: { action: string; closeAll?: boolean };
  try {
    body = await req.json() as { action: string; closeAll?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  switch (body.action) {
    case "start": {
      const result = await startDayTrading();
      return NextResponse.json(result);
    }
    case "stop": {
      await stopDayTrading(body.closeAll ?? false);
      return NextResponse.json({ ok: true });
    }
    case "stop_close_all": {
      await stopDayTrading(true);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
