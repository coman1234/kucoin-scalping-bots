"use client";

import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, CandlestickData, LineData, SeriesMarker, Time } from "lightweight-charts";
import { useTradingContext } from "@/lib/context";
import { calculateGaussianChannel } from "@/lib/indicators";
import type { TradeResult } from "@/lib/backtester";

interface ChartProps {
  backtestTrades?: TradeResult[];
  /** Callback kun käyttäjä klikkaa kynttilää — time on Unix-sekunnit */
  onCandleClick?: (timeUnixSec: number) => void;
}

// Adaptive decimal places based on price magnitude
function formatPrice(price: number): string {
  if (!price || isNaN(price)) return "—";
  const abs = Math.abs(price);
  if (abs >= 10000) return price.toFixed(1);
  if (abs >= 1000)  return price.toFixed(2);
  if (abs >= 100)   return price.toFixed(2);
  if (abs >= 10)    return price.toFixed(3);
  if (abs >= 1)     return price.toFixed(4);
  if (abs >= 0.1)   return price.toFixed(5);
  if (abs >= 0.01)  return price.toFixed(6);
  if (abs >= 0.001) return price.toFixed(7);
  return price.toFixed(8);
}

// ▰▰▰▰▱▱▱ filled bar showing how many indicators fired
function scoreBar(score: number, max: number): string {
  const n = Math.min(Math.round(score), max);
  return "▰".repeat(n) + "▱".repeat(Math.max(0, max - n));
}

function sigSize(score: number, max: number): number {
  const r = score / max;
  if (r >= 0.85) return 3;
  if (r >= 0.65) return 2;
  return 1;
}

const BG    = "#000000";
const GRID  = "#0d0d12";
const TEXT  = "#44445a";
const C_UP  = "#00d47e";
const C_DN  = "#ff3355";
const C_EMA9  = "#f59e0b";
const C_EMA21 = "#3d8fff";
const C_BB    = "#a855f7";

const NO_SCALE = {
  priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  autoscaleInfoProvider: (() => null) as () => null,
} as const;

export default function Chart({ backtestTrades, onCandleClick }: ChartProps) {
  const containerRef      = useRef<HTMLDivElement>(null);
  const chartRef          = useRef<IChartApi | null>(null);
  // Stable ref for the callback — avoids re-creating the chart when prop changes
  const onCandleClickRef  = useRef(onCandleClick);
  useEffect(() => { onCandleClickRef.current = onCandleClick; }, [onCandleClick]);
  const candleRef    = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ema9Ref      = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21Ref     = useRef<ISeriesApi<"Line"> | null>(null);
  const bbURef       = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLRef       = useRef<ISeriesApi<"Line"> | null>(null);
  const bbMRef       = useRef<ISeriesApi<"Line"> | null>(null);
  const gcURef       = useRef<ISeriesApi<"Line"> | null>(null);
  const gcLRef       = useRef<ISeriesApi<"Line"> | null>(null);
  const gcMRef       = useRef<ISeriesApi<"Line"> | null>(null);

  const { candles, currentSignal, backtestResults, openPosition } = useTradingContext();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    let alive = true, ro: ResizeObserver | undefined, inst: IChartApi | undefined;

    import("lightweight-charts").then(({ createChart, CrosshairMode, LineStyle }) => {
      if (!alive || !containerRef.current) return;

      const chart = createChart(containerRef.current, {
        layout: { background: { color: BG }, textColor: TEXT, fontSize: 11 },
        grid:   { vertLines: { color: GRID }, horzLines: { color: GRID } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: "#2a2a3f", scaleMargins: { top: 0.12, bottom: 0.08 } },
        timeScale: { borderColor: "#2a2a3f", timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 8 },
        width:  containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      inst = chart;

      const gcU = chart.addLineSeries({ lineWidth: 1, ...NO_SCALE });
      const gcL = chart.addLineSeries({ lineWidth: 1, ...NO_SCALE });
      const gcM = chart.addLineSeries({ color: "#ffffff10", lineWidth: 1, lineStyle: LineStyle.Dashed, ...NO_SCALE });

      const cs = chart.addCandlestickSeries({
        upColor: C_UP, downColor: C_DN, borderUpColor: C_UP, borderDownColor: C_DN,
        wickUpColor: C_UP + "88", wickDownColor: C_DN + "88",
        priceFormat: { type: "custom", formatter: (p: number) => formatPrice(p), minMove: 0.00000001 },
      });

      const e9  = chart.addLineSeries({ color: C_EMA9,  lineWidth: 1, title: "EMA9",  ...NO_SCALE });
      const e21 = chart.addLineSeries({ color: C_EMA21, lineWidth: 1, title: "EMA21", ...NO_SCALE });
      const bbu = chart.addLineSeries({ color: C_BB + "55",  lineWidth: 1, lineStyle: LineStyle.Dashed,       ...NO_SCALE });
      const bbl = chart.addLineSeries({ color: C_BB + "55",  lineWidth: 1, lineStyle: LineStyle.Dashed,       ...NO_SCALE });
      const bbm = chart.addLineSeries({ color: C_BB + "22",  lineWidth: 1, lineStyle: LineStyle.SparseDotted,  ...NO_SCALE });

      chartRef.current = chart; candleRef.current = cs;
      ema9Ref.current = e9;   ema21Ref.current = e21;
      bbURef.current  = bbu;  bbLRef.current  = bbl;  bbMRef.current  = bbm;
      gcURef.current  = gcU;  gcLRef.current  = gcL;  gcMRef.current  = gcM;
      setReady(true);

      // Kynttilän klikkauskuuntelu — lähetetään Unix-sekunnit ylös
      chart.subscribeClick(param => {
        if (param.time !== undefined) {
          onCandleClickRef.current?.(param.time as number);
        }
      });

      ro = new ResizeObserver(() => {
        if (containerRef.current)
          chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      });
      ro.observe(containerRef.current);
    });

    return () => {
      alive = false; setReady(false); ro?.disconnect(); inst?.remove();
      [chartRef, candleRef, ema9Ref, ema21Ref, bbURef, bbLRef, bbMRef, gcURef, gcLRef, gcMRef]
        .forEach((r) => { (r as React.MutableRefObject<null>).current = null; });
    };
  }, []);

  useEffect(() => {
    if (!ready || !candleRef.current || candles.length === 0) return;

    candleRef.current.setData(
      candles.map((c) => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }))
    );

    const gc = calculateGaussianChannel(candles, 50, 4);
    if (gc.mid.length > 1) {
      const up: LineData[] = [], lo: LineData[] = [], mi: LineData[] = [];
      for (let i = 0; i < gc.mid.length; i++) {
        const t  = candles[i].time as Time;
        const lc = gc.isBullish[i] ? C_UP : C_DN;
        up.push({ time: t, value: gc.upper[i], color: lc });
        lo.push({ time: t, value: gc.lower[i], color: lc });
        mi.push({ time: t, value: gc.mid[i] });
      }
      gcURef.current?.setData(up); gcLRef.current?.setData(lo); gcMRef.current?.setData(mi);
    }

    if (currentSignal) {
      const { indicators: ind } = currentSignal;
      const ml = (vals: number[], off: number): LineData[] =>
        vals.map((v, i) => ({ time: candles[i + off]?.time as Time, value: v })).filter((d) => d.time);
      if (ind.ema9.length  > 0) ema9Ref.current?.setData(ml(ind.ema9,  candles.length - ind.ema9.length));
      if (ind.ema21.length > 0) ema21Ref.current?.setData(ml(ind.ema21, candles.length - ind.ema21.length));
      if (ind.bb.upper.length > 0) {
        const off = candles.length - ind.bb.upper.length;
        bbURef.current?.setData(ml(ind.bb.upper, off)); bbLRef.current?.setData(ml(ind.bb.lower, off));
        bbMRef.current?.setData(ml(ind.bb.middle, off));
      }
    }

    const markers: SeriesMarker<Time>[] = [];
    const hasTrades = (backtestTrades ?? backtestResults?.allTrades ?? []).length > 0;

    // GC-kanavan sisääntulot/ulostulot — näytetään vain ilman historiatestimerkintöjä
    if (!hasTrades) {
      for (const i of gc.longEntries) {
        const b = candles[i];
        if (b) markers.push({ time: b.time as Time, position: "belowBar", color: C_UP + "99", shape: "circle", text: "GC▲", size: 1 });
      }
      for (const i of gc.longExits) {
        const b = candles[i];
        if (b) markers.push({ time: b.time as Time, position: "aboveBar", color: C_BB + "99", shape: "circle", text: "GC✕", size: 1 });
      }
    }

    // Historiatesti/erä kauppamerkinnät — sisääntulo pisteytyspalkilla, ulostulo P&L:llä
    for (const t of backtestTrades ?? backtestResults?.allTrades ?? []) {
      const isBuy = t.direction === "BUY";
      const mx    = (t as { maxScore?: number }).maxScore ?? (currentSignal?.maxScore ?? 9);
      const bar   = scoreBar(t.signalScore, mx);
      const entryColor = isBuy
        ? `hsl(152, 100%, ${30 + Math.round((t.signalScore / mx) * 40)}%)`
        : `hsl(348, 100%, ${30 + Math.round((t.signalScore / mx) * 40)}%)`;
      markers.push({
        time:     t.entryTime as Time,
        position: isBuy ? "belowBar" : "aboveBar",
        color:    entryColor,
        shape:    isBuy ? "arrowUp" : "arrowDown",
        text:     `${isBuy ? "BUY" : "SELL"} ${t.signalScore}/${mx} ${bar}`,
        size:     sigSize(t.signalScore, mx),
      });
      markers.push({
        time:     t.exitTime as Time,
        position: isBuy ? "aboveBar" : "belowBar",
        color:    t.pnlUSDT >= 0 ? C_UP + "cc" : C_DN + "cc",
        shape:    isBuy ? "arrowDown" : "arrowUp",
        text:     `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`,
        size:     1,
      });
    }

    // Live-signaali viimeisimmällä kynttilällä
    if (currentSignal && currentSignal.direction !== "NEUTRAL" && candles.length > 0) {
      const last = candles[candles.length - 1];
      const buy  = currentSignal.direction === "BUY";
      const mx   = currentSignal.maxScore ?? 9;
      const bar  = scoreBar(currentSignal.score, mx);
      const star = currentSignal.score >= 7 ? "★ " : "";
      markers.push({
        time:     last.time as Time,
        position: buy ? "belowBar" : "aboveBar",
        color:    buy ? C_UP : C_DN,
        shape:    buy ? "arrowUp" : "arrowDown",
        text:     `${star}${buy ? "BUY" : "SELL"} ${currentSignal.score}/${mx} ${bar}`,
        size:     sigSize(currentSignal.score, mx),
      });
    }

    // Avoimen position merkintä
    if (openPosition) {
      markers.push({
        time:     Math.floor(openPosition.entryTime) as Time,
        position: openPosition.direction === "BUY" ? "belowBar" : "aboveBar",
        color:    C_EMA9,
        shape:    "circle",
        text:     `AVOIN @${formatPrice(openPosition.entryPrice)}`,
        size:     2,
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candleRef.current.setMarkers(markers);

    if (openPosition) {
      for (const { price, color, title, style } of [
        { price: openPosition.stopLossPrice, color: C_DN,      title: "SL",  style: 2 },
        { price: openPosition.tp1Price,      color: C_UP,      title: "TP1", style: 2 },
        { price: openPosition.tp2Price,      color: C_UP + "88", title: "TP2", style: 3 },
      ]) candleRef.current.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    }

    chartRef.current?.timeScale().fitContent();
  }, [candles, currentSignal, ready, backtestTrades, backtestResults, openPosition]);

  const sig = currentSignal;
  const sc  = sig?.direction === "BUY" ? C_UP : sig?.direction === "SELL" ? C_DN : "#44445a";

  return (
    <div className="relative w-full h-full bg-black">
      <div ref={containerRef} className="w-full h-full" />

      {sig && sig.direction !== "NEUTRAL" && (
        <div className="absolute top-2 left-2 z-10 px-2 py-1 rounded text-[11px] font-bold pointer-events-none select-none"
          style={{ background: sc + "20", border: `1px solid ${sc}40`, color: sc }}>
          {sig.label} {sig.score}/{sig.maxScore}
        </div>
      )}

      <div className="absolute top-2 right-2 z-10 flex gap-3 text-[10px] pointer-events-none select-none text-t-muted">
        <span style={{ color: C_UP   }}>── GC ↑</span>
        <span style={{ color: C_DN   }}>── GC ↓</span>
        <span style={{ color: C_EMA9 }}>─ EMA9</span>
        <span style={{ color: C_EMA21}}>─ EMA21</span>
        <span style={{ color: C_BB   }}>╌ BB</span>
      </div>

      {candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center text-t-muted">
            <div className="text-5xl mb-3 opacity-20">📈</div>
            <div className="text-sm">Valitse kaupankäyntipari ladataksesi kaavion</div>
          </div>
        </div>
      )}
    </div>
  );
}
