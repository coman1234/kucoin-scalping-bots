import { NextRequest, NextResponse } from "next/server";
import { getOrderBook, get24hStats } from "@/lib/kucoinPublic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");

  if (!symbol) {
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  }

  try {
    const [orderBook, stats] = await Promise.all([
      getOrderBook(symbol),
      get24hStats(symbol),
    ]);
    return NextResponse.json({ orderBook, stats });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch price" },
      { status: 500 }
    );
  }
}
