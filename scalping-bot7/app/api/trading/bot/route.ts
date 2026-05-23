import { NextRequest, NextResponse } from "next/server";
import {
  getBotState,
  startBot,
  stopBot,
  emergencyStop,
  initBot,
} from "@/lib/serverBot";
import { startSignalBroadcaster } from "@/lib/signalBroadcaster";

// Auto-init once per process
let initialized = false;

async function ensureInit() {
  if (!initialized) {
    initialized = true;
    await initBot();
    // Start SHM signal broadcaster so scalping-day6 can read confluence signals
    startSignalBroadcaster();
  }
}

export async function GET() {
  await ensureInit();
  return NextResponse.json(getBotState());
}

export async function POST(req: NextRequest) {
  await ensureInit();

  const body = await req.json() as {
    action: "start" | "stop" | "emergency_stop" | "set_symbol";
    symbol?: string;
    timeframe?: string;
  };

  switch (body.action) {
    case "start":
      await startBot(body.symbol, body.timeframe);
      return NextResponse.json(getBotState());

    case "stop":
      await stopBot("User requested stop");
      return NextResponse.json(getBotState());

    case "emergency_stop":
      await emergencyStop();
      return NextResponse.json(getBotState());

    case "set_symbol": {
      // Only allowed while stopped
      const state = getBotState();
      if (state.status === "running") {
        return NextResponse.json({ error: "Stop the bot before changing symbol" }, { status: 400 });
      }
      // Symbol will be applied on next startBot call — just acknowledge
      return NextResponse.json({ ok: true, symbol: body.symbol });
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
