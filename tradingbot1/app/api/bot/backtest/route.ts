import { NextRequest, NextResponse } from 'next/server';
import { getEngineInstance } from '@/lib/engineSingleton';
import { fetchCandles } from '@/lib/kuCoinClient';
import { optimiseParameters } from '@/lib/backtester';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const engine = getEngineInstance();

    let candles = engine.getCandles(1500);
    if (candles.length < 100) {
      candles = await fetchCandles(engine.config.symbol, engine.config.interval, 1500);
    }

    if (body.optimise) {
      const result = optimiseParameters(candles);
      return NextResponse.json({
        mode: 'optimise',
        bestParams: result.bestParams,
        bestResult: { ...result.bestResult, trades: undefined },
        gridSize: result.grid.length,
      });
    }

    const result = engine.runQuickBacktest();
    return NextResponse.json({
      mode: 'quick',
      totalTrades: result.totalTrades,
      winRate: result.winRate,
      ev: result.ev,
      totalPnL: result.totalPnL,
      maxDrawdown: result.maxDrawdown,
      sharpeRatio: result.sharpeRatio,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
