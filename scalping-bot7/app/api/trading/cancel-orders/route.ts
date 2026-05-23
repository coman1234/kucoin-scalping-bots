import { NextRequest, NextResponse } from "next/server";
import { cancelAllOrders, credentialsConfigured } from "@/lib/kucoinPrivate";

export async function DELETE(req: NextRequest) {
  if (!(await credentialsConfigured())) {
    return NextResponse.json(
      { error: "API credentials not configured" },
      { status: 401 }
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get("symbol") ?? undefined;
    const result = await cancelAllOrders(symbol);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to cancel orders" },
      { status: 500 }
    );
  }
}
