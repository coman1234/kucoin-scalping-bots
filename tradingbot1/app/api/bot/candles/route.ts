import { NextRequest, NextResponse } from 'next/server';
import { getEngineInstance } from '@/lib/engineSingleton';
import { fetchCandles } from '@/lib/kuCoinClient';
import { computeIndicators } from '@/lib/indicators';
import { calculateEMA, calculateBollingerBands } from '@/lib/indicators';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '200'), 500);
    const engine = getEngineInstance();
    let candles = engine.getCandles(limit);

    // If engine has no candles yet, fetch directly
    if (candles.length === 0) {
      candles = await fetchCandles(
        engine.config.symbol,
        engine.config.interval,
        limit
      );
    }

    // Compute overlay data for chart
    const closes = candles.map((c) => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const bb = calculateBollingerBands(closes, 20, 2);

    // Align all series to candle length
    const offset9 = closes.length - ema9.length;
    const offset21 = closes.length - ema21.length;
    const offsetBB = closes.length - bb.upper.length;

    const overlays = candles.map((_, i) => ({
      ema9: i >= offset9 ? ema9[i - offset9] : null,
      ema21: i >= offset21 ? ema21[i - offset21] : null,
      bbUpper: i >= offsetBB ? bb.upper[i - offsetBB] : null,
      bbLower: i >= offsetBB ? bb.lower[i - offsetBB] : null,
      bbMiddle: i >= offsetBB ? bb.middle[i - offsetBB] : null,
    }));

    return NextResponse.json({ candles, overlays });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
