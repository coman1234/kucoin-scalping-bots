import { NextRequest, NextResponse } from "next/server";
import { getCandles } from "@/lib/kucoinPublic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const timeframe = searchParams.get("timeframe") ?? "1min";
  const startAt = searchParams.get("startAt");
  const endAt = searchParams.get("endAt");

  if (!symbol) {
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  }

  try {
    const candles = await getCandles(
      symbol,
      timeframe,
      startAt ? parseInt(startAt) : undefined,
      endAt ? parseInt(endAt) : undefined
    );
    return NextResponse.json({ candles });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch candles" },
      { status: 500 }
    );
  }
}
