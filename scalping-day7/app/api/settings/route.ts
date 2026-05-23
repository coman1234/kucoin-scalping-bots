/**
 * GET  /api/settings  — returns current TraderConfig snapshot
 * POST /api/settings  — patches the live CONFIG object (no restart needed)
 */
import { NextRequest, NextResponse } from "next/server";
import { getConfigSnapshot, updateConfig } from "@/lib/traderConfig";
import type { TraderConfig } from "@/lib/traderConfig";

export const dynamic = "force-dynamic";

const ALLOWED_KEYS: (keyof TraderConfig)[] = [
  "feeRatePct", "minScore", "maxSpreadPct", "emaTrendFast", "emaTrendSlow",
  "rsiBullLo", "rsiBullHi", "rsiBearLo", "rsiBearHi",
  "slAtrMult", "tpAtrMult", "beBroughtAt", "maxHoldMinutes",
  "riskPctPerTrade", "dailyDrawdownPct", "maxTradesPerDay",
  "maxOpenPositions", "maxNotionalPct", "minTradeUsdt", "confluenceMinScore",
];

export async function GET() {
  return NextResponse.json(getConfigSnapshot());
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Partial<TraderConfig>;
    const patch: Partial<TraderConfig> = {};

    for (const key of ALLOWED_KEYS) {
      const val = body[key];
      if (val !== undefined && typeof val === "number" && isFinite(val)) {
        (patch as Record<string, number>)[key] = val;
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    updateConfig(patch);
    return NextResponse.json({ ok: true, updated: patch, config: getConfigSnapshot() });
  } catch (e) {
    console.error("[/api/settings]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
