/**
 * POST /api/trading — trading control endpoints
 */
import { NextRequest, NextResponse } from "next/server";
import { getDayTrader } from "@/lib/dayTrader";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body   = await req.json() as { action?: string; startEquity?: number };
    const trader = getDayTrader();

    switch (body.action) {
      case "kill":
        await trader.activateKillSwitch();
        return NextResponse.json({ ok: true, message: "Kill switch activated — all positions flattened" });
      case "unkill":
        trader.deactivateKillSwitch();
        return NextResponse.json({ ok: true, message: "Kill switch deactivated" });
      case "stop":
        trader.stop();
        return NextResponse.json({ ok: true, message: "Day-trader loop stopped" });
      case "start":
        trader.start();
        return NextResponse.json({ ok: true, message: "Day-trader loop started" });
      case "start_sim": {
        const equity = typeof body.startEquity === "number" ? body.startEquity : 1000;
        trader.startSimulation(equity);
        return NextResponse.json({ ok: true, message: `Simulation started with $${equity} virtual equity` });
      }
      case "stop_sim":
        trader.stopSimulation();
        return NextResponse.json({ ok: true, message: "Simulation stopped" });
      case "restart_sim": {
        // stop + start with fresh counters (resets stale totalTradesDay etc.)
        trader.stopSimulation();
        const equity2 = typeof body.startEquity === "number" ? body.startEquity : 1000;
        trader.startSimulation(equity2);
        return NextResponse.json({ ok: true, message: `Simulation restarted with $${equity2} virtual equity — risk counters reset` });
      }
      case "start_live":
        trader.startLiveTrading();
        return NextResponse.json({ ok: true, message: "LIVE trading activated — real orders will be sent to KuCoin" });
      case "stop_live":
        trader.stopLiveTrading();
        return NextResponse.json({ ok: true, message: "LIVE trading deactivated" });
      default:
        return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (e) {
    console.error("[/api/trading]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
