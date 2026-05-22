import { NextResponse } from "next/server";
import { readAllTickers, readRegime, readBestParams, isProducerAlive } from "@/lib/shmReader";

export async function GET() {
  const tickerFile = readAllTickers();
  const producerAlive = isProducerAlive();

  if (!tickerFile) {
    return NextResponse.json({
      pairs: [],
      producerAlive,
      fetchedAt: null,
      warning: "No ticker data in SHM cache",
    });
  }

  const pairs = Object.values(tickerFile.tickers).map((ticker) => {
    const regime = readRegime(ticker.symbol);
    const params = readBestParams(ticker.symbol);

    return {
      symbol:     ticker.symbol,
      price:      ticker.price,
      changeRate: ticker.changeRate,
      regime:     regime?.regime ?? "unknown",
      confidence: params?.confidence ?? 0,
      bestPF:     params?.metrics?.profitFactor ?? 0,
      winRate:    params?.metrics?.winRate ?? 0,
      trades:     params?.metrics?.trades ?? 0,
    };
  });

  // Sort by volume value descending (most traded first)
  pairs.sort((a, b) => {
    const va = tickerFile.tickers[a.symbol]?.volValue ?? 0;
    const vb = tickerFile.tickers[b.symbol]?.volValue ?? 0;
    return vb - va;
  });

  return NextResponse.json({
    pairs,
    producerAlive,
    fetchedAt: tickerFile.fetchedAt,
    count: pairs.length,
  });
}
