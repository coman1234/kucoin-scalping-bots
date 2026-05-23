import { NextRequest, NextResponse } from "next/server";
import { getPipelineState, startPipeline, restartPipeline } from "@/lib/serverPipeline";

// Delayed auto-start: wait 30 s after first GET so the server can serve
// the initial page load before the heavy optimization blocks the event loop.
// (Immediate auto-start caused 3+ minute UI hangs on page load.)
let autoStartScheduled = false;

export async function GET() {
  const state = getPipelineState();

  if (!autoStartScheduled) {
    autoStartScheduled = true;
    const isRecentlyDone =
      state.phase === "ready" &&
      state.nextRunAt !== null &&
      state.nextRunAt > Date.now();

    if (!isRecentlyDone) {
      setTimeout(() => startPipeline(), 30_000);  // 30 s grace period
    }
  }

  return NextResponse.json(state);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { action: string };

  if (body.action === "start") {
    startPipeline();
    return NextResponse.json({ ok: true });
  }

  if (body.action === "restart") {
    restartPipeline();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
