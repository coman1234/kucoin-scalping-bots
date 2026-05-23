/**
 * GET  /api/optimize       — get optimizer state / results
 * POST /api/optimize       — { action: "start" | "apply" }
 *   start → kick off grid search in background
 *   apply → apply bestParams to live CONFIG
 */

import { NextRequest, NextResponse } from "next/server";
import { getOptimizerState, startOptimization } from "@/lib/paramOptimizer";
import { updateConfig } from "@/lib/traderConfig";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getOptimizerState());
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { action?: string };

    if (body.action === "start") {
      startOptimization();
      return NextResponse.json({ ok: true, message: "Optimisation started in background. Poll GET /api/optimize for progress." });
    }

    if (body.action === "apply") {
      const state = getOptimizerState();
      if (!state.bestParams) {
        return NextResponse.json({ error: "No optimised params available — run optimisation first" }, { status: 400 });
      }
      updateConfig(state.bestParams);
      return NextResponse.json({ ok: true, message: "Best params applied to live CONFIG", applied: state.bestParams });
    }

    return NextResponse.json({ error: "Unknown action. Use start or apply." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
