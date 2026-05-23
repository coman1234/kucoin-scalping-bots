/**
 * GET /api/dashboard — full dashboard snapshot
 */
import { NextResponse } from "next/server";
import { getDayTrader } from "@/lib/dayTrader";

let started = false;

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const trader = getDayTrader();
    if (!started) {
      trader.start();
      started = true;
    }
    return NextResponse.json(trader.getDashboard());
  } catch (e) {
    console.error("[/api/dashboard]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
