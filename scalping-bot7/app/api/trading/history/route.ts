import { NextRequest, NextResponse } from "next/server";
import { getOrderHistory, credentialsConfigured } from "@/lib/kucoinPrivate";

export async function GET(req: NextRequest) {
  if (!(await credentialsConfigured())) {
    return NextResponse.json(
      { error: "API credentials not configured" },
      { status: 401 }
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get("symbol") ?? undefined;
    const limit = parseInt(searchParams.get("limit") ?? "50");
    const result = await getOrderHistory(symbol, limit);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch history" },
      { status: 500 }
    );
  }
}
