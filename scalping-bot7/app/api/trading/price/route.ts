import { NextRequest, NextResponse } from "next/server";
import { readTicker } from "@/lib/shmReader";
import { getOrderBook, get24hStats } from "@/lib/kucoinPublic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "BTC-USDT";

  const ticker = readTicker(symbol);
  if (ticker) {
    return NextResponse.json({
      orderBook: {
        price:   String(ticker.price),
        bestBid: String(ticker.bestBid),
        bestAsk: String(ticker.bestAsk),
      },
      stats: {
        changeRate: String(ticker.changeRate),
        vol:        String(ticker.vol),
        volValue:   String(ticker.volValue),
      },
      source: "cache",
    });
  }

  // SHM miss — fall back to KuCoin
  try {
    const [orderBook, stats] = await Promise.all([
      getOrderBook(symbol),
      get24hStats(symbol),
    ]);
    return NextResponse.json({ orderBook, stats, source: "kucoin" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch price" },
      { status: 503 }
    );
  }
}
