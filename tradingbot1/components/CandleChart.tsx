'use client';

import { useEffect, useRef, useCallback } from 'react';

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Overlay {
  ema9: number | null;
  ema21: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbMiddle: number | null;
}

interface Props {
  candles: Candle[];
  overlays: Overlay[];
  openPosition?: {
    direction: string;
    entryPrice: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
  } | null;
}

export default function CandleChart({ candles, overlays, openPosition }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<{ candle: any; ema9: any; ema21: any; bbU: any; bbL: any; bbM: any } | null>(null);

  const initChart = useCallback(async () => {
    if (!containerRef.current || chartRef.current) return;
    const { createChart } = await import('lightweight-charts');

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0f1520' },
        textColor: '#6b7e9a',
      },
      grid: {
        vertLines: { color: '#1a2535' },
        horzLines: { color: '#1a2535' },
      },
      crosshair: {
        vertLine: { color: '#2e4060', labelBackgroundColor: '#0f1520' },
        horzLine: { color: '#2e4060', labelBackgroundColor: '#0f1520' },
      },
      timeScale: {
        borderColor: '#1e2d40',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: { borderColor: '#1e2d40' },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    const ema9Series = chart.addLineSeries({ color: '#3b82f6', lineWidth: 1, priceLineVisible: false });
    const ema21Series = chart.addLineSeries({ color: '#f97316', lineWidth: 1, priceLineVisible: false });
    const bbUSeries = chart.addLineSeries({ color: 'rgba(100,120,160,0.5)', lineWidth: 1, lineStyle: 2, priceLineVisible: false });
    const bbLSeries = chart.addLineSeries({ color: 'rgba(100,120,160,0.5)', lineWidth: 1, lineStyle: 2, priceLineVisible: false });
    const bbMSeries = chart.addLineSeries({ color: 'rgba(100,120,160,0.25)', lineWidth: 1, lineStyle: 3, priceLineVisible: false });

    chartRef.current = chart;
    seriesRef.current = { candle: candleSeries, ema9: ema9Series, ema21: ema21Series, bbU: bbUSeries, bbL: bbLSeries, bbM: bbMSeries };

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    initChart();
    return () => {
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [initChart]);

  // Update data whenever candles change
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;
    const { candle, ema9, ema21, bbU, bbL, bbM } = seriesRef.current;

    const candleData = candles.map((c) => ({
      time: Math.floor(c.timestamp / 1000) as unknown as string,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    candle.setData(candleData);

    const withTime = (arr: (number | null)[], key: keyof Overlay) =>
      candles
        .map((c, i) => ({ time: Math.floor(c.timestamp / 1000), value: overlays[i]?.[key] ?? null }))
        .filter((d): d is { time: number; value: number } => d.value !== null);

    ema9.setData(withTime([], 'ema9'));
    ema21.setData(withTime([], 'ema21'));
    bbU.setData(withTime([], 'bbUpper'));
    bbL.setData(withTime([], 'bbLower'));
    bbM.setData(withTime([], 'bbMiddle'));

    // Add position lines
    if (openPosition) {
      candle.createPriceLine({ price: openPosition.entryPrice, color: '#e2e8f0', lineWidth: 1, lineStyle: 0, title: 'ENTRY' });
      candle.createPriceLine({ price: openPosition.stopLoss, color: '#ef4444', lineWidth: 1, lineStyle: 2, title: 'SL' });
      candle.createPriceLine({ price: openPosition.tp1, color: '#22c55e', lineWidth: 1, lineStyle: 2, title: 'TP1' });
      candle.createPriceLine({ price: openPosition.tp2, color: '#86efac', lineWidth: 1, lineStyle: 2, title: 'TP2' });
    }

    chartRef.current?.timeScale().scrollToRealTime();
  }, [candles, overlays, openPosition]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {/* Legend */}
      <div style={{
        position: 'absolute', top: 8, left: 10,
        display: 'flex', gap: 12, fontSize: 10, pointerEvents: 'none',
      }}>
        {[
          { color: '#3b82f6', label: 'EMA9' },
          { color: '#f97316', label: 'EMA21' },
          { color: 'rgba(100,120,160,0.7)', label: 'BB(20)' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />
            <span style={{ color: 'var(--dim)' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
