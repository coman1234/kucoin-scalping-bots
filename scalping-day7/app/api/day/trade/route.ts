import { NextRequest, NextResponse } from "next/server";

interface TradeRequest {
  symbol: string;
  direction: "BUY" | "SELL";
}

/**
 * POST /api/day/trade
 * Submits a manual trade order.
 * In production this should be wired to the KuCoin private API.
 */
export async function POST(req: NextRequest) {
  let body: TradeRequest;
  try {
    body = (await req.json()) as TradeRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { symbol, direction } = body;
  if (!symbol || !direction) {
    return NextResponse.json(
      { error: "symbol and direction are required" },
      { status: 400 }
    );
  }
  if (direction !== "BUY" && direction !== "SELL") {
    return NextResponse.json(
      { error: "direction must be BUY or SELL" },
      { status: 400 }
    );
  }

  // TODO: wire up KuCoin private API and risk manager
  // For now, acknowledge the request.
  console.log(`[day7/trade] Manual ${direction} on ${symbol} requested`);

  return NextResponse.json({
    message: `${direction} order for ${symbol} queued (not yet wired to exchange)`,
    symbol,
    direction,
    timestamp: Date.now(),
  });
}
