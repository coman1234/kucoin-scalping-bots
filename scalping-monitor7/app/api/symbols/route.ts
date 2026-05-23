import { NextResponse } from "next/server";
import { getSymbols } from "@/lib/kucoinPublic";

export async function GET() {
  try {
    const symbols = await getSymbols();
    // Return only USDT pairs that are enabled for trading
    const usdtPairs = symbols.filter(
      (s) => s.quoteCurrency === "USDT" && s.enableTrading
    );
    return NextResponse.json({ symbols: usdtPairs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch symbols" },
      { status: 500 }
    );
  }
}
