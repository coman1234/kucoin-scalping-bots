import { NextRequest, NextResponse } from "next/server";
import { placeStopOrder, credentialsConfigured, type StopOrderParams } from "@/lib/kucoinPrivate";
import { randomUUID } from "crypto";

export async function POST(req: NextRequest) {
  if (!(await credentialsConfigured())) {
    return NextResponse.json(
      { error: "API credentials not configured" },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const { symbol, side, size, stopPrice, price } = body as {
      symbol: string;
      side: "buy" | "sell";
      size: string;
      stopPrice: string;
      price?: string;
    };

    if (!symbol || !side || !size || !stopPrice) {
      return NextResponse.json(
        { error: "symbol, side, size, stopPrice required" },
        { status: 400 }
      );
    }

    const params: StopOrderParams = {
      clientOid: randomUUID(),
      symbol,
      side,
      type: price ? "limit" : "market",
      size,
      stopPrice,
      stop: "loss",
      stopPriceType: "TP",
      ...(price && { price }),
    };

    const result = await placeStopOrder(params);
    return NextResponse.json({ orderId: result.orderId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to place stop order" },
      { status: 500 }
    );
  }
}
