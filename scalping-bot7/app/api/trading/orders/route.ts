import { NextRequest, NextResponse } from "next/server";
import { placeOrder, credentialsConfigured, type PlaceOrderParams } from "@/lib/kucoinPrivate";
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
    const { symbol, side, type, size, funds, price } = body as {
      symbol: string;
      side: "buy" | "sell";
      type: "market" | "limit";
      size?: string;
      funds?: string;
      price?: string;
    };

    if (!symbol || !side || !type) {
      return NextResponse.json(
        { error: "symbol, side, type required" },
        { status: 400 }
      );
    }

    // Market orders require either size (base currency) or funds (USDT)
    if (type === "market" && !size && !funds) {
      return NextResponse.json(
        { error: "Market orders require either 'size' (base currency) or 'funds' (USDT)" },
        { status: 400 }
      );
    }

    const params: PlaceOrderParams = {
      clientOid: randomUUID(),
      symbol,
      side,
      type,
      ...(size  && { size }),
      ...(funds && { funds }),
      ...(price && { price }),
      timeInForce: "GTC",
    };

    const result = await placeOrder(params);
    return NextResponse.json({ orderId: result.orderId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to place order" },
      { status: 500 }
    );
  }
}
