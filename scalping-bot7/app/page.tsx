"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTradingContext } from "@/lib/context";
import { generateCommentary } from "@/lib/commentary";
import { cn } from "@/lib/utils";
import TopBar        from "@/components/TopBar";
import SignalPanel   from "@/components/SignalPanel";
import BotPanel      from "@/components/BotPanel";
import ManualTrading from "@/components/ManualTrading";
import Watchlist     from "@/components/Watchlist";
import PatternMemory from "@/components/PatternMemory";
import MultiBotPanel from "@/components/MultiBotPanel";
import SubCharts     from "@/components/SubCharts";
import SetupWizard   from "@/components/SetupWizard";
import TradingWorkflow     from "@/components/TradingWorkflow";
import DayTradingDashboard from "@/components/DayTradingDashboard";
import Portfolio           from "@/components/Portfolio";
import CandleAnalysis, { type CandleAnalysisResult } from "@/components/CandleAnalysis";

const Chart = dynamic(() => import("@/components/Chart"), { ssr: false });

// ── Colour based on signal direction ────────────────────────────────────────
function bannerStyle(text: string) {
  if (text.startsWith("🚀") || text.startsWith("📈"))
    return { bg: "bg-emerald-50",  border: "border-emerald-300", text: "text-emerald-700" };
  if (text.startsWith("🔴") || text.startsWith("📉"))
    return { bg: "bg-red-50",      border: "border-red-300",     text: "text-red-700" };
  if (text.startsWith("🔍") || text.startsWith("⚠️"))
    return { bg: "bg-amber-50",    border: "border-amber-300",   text: "text-amber-700" };
  return { bg: "bg-slate-50",    border: "border-slate-200",   text: "text-slate-600" };
}

function MarketTicker() {
  const { currentSignal, candles, language } = useTradingContext();
  const lang = (language ?? "fi") as "fi" | "en";
  const [text, setText] = useState(() =>
    lang === "fi" ? "Ladataan markkinadataa..." : "Loading market data..."
  );
  const [animKey, setAnimKey] = useState(0);
  const tickerRef = useRef<HTMLDivElement>(null);
  const spanRef   = useRef<HTMLSpanElement>(null);
  const animRef   = useRef<Animation | null>(null);

  useEffect(() => {
    const next = generateCommentary(currentSignal ?? null, candles, lang);
    if (next !== text) {
      setText(next);
      setAnimKey(k => k + 1);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSignal, candles, lang]);

  useEffect(() => {
    const ticker = tickerRef.current;
    const span   = spanRef.current;
    if (!ticker || !span) return;
    animRef.current?.cancel();
    const containerW = ticker.clientWidth;
    const contentW   = span.scrollWidth;
    const totalDist  = containerW + contentW;
    const duration   = (totalDist / 80) * 1000;
    animRef.current = span.animate(
      [{ transform: `translateX(${containerW}px)` }, { transform: `translateX(-${contentW}px)` }],
      { duration, iterations: Infinity, easing: "linear" }
    );
    return () => { animRef.current?.cancel(); };
  }, [animKey]);

  const style = bannerStyle(text);

  return (
    <div
      className={`flex-shrink-0 ${style.bg} border-b ${style.border} h-[22px] overflow-hidden relative`}
      ref={tickerRef}
    >
      <span
        key={animKey}
        ref={spanRef}
        className={`absolute top-0 whitespace-nowrap text-[11px] font-medium leading-[22px] px-4 ${style.text}`}
        style={{ willChange: "transform" }}
      >
        {text}
      </span>
    </div>
  );
}

// ── Sidebar tab definitions ──────────────────────────────────────────────────
type SidebarTab = "signal" | "bot" | "market" | "daytrade" | "portfolio";

const TABS: { id: SidebarTab; icon: string; labelFi: string; labelEn: string }[] = [
  { id: "signal",    icon: "📊", labelFi: "Sig.",    labelEn: "Sig."  },
  { id: "bot",       icon: "🤖", labelFi: "Botti",   labelEn: "Bot"   },
  { id: "market",    icon: "🌐", labelFi: "Mkt",     labelEn: "Mkt"   },
  { id: "daytrade",  icon: "📈", labelFi: "Day",     labelEn: "Day"   },
  { id: "portfolio", icon: "💼", labelFi: "Salkku",  labelEn: "Port." },
];

export default function TradingDashboard() {
  const { setupComplete, language, selectedSymbol } = useTradingContext();
  const isFi = language === "fi";
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("signal");

  // ── Bottom panel collapse & sub-chart height ──────────────────────────────
  const [workflowOpen,   setWorkflowOpen]   = useState(true);
  const [subChartHeight, setSubChartHeight] = useState(120);   // px, user-draggable
  const resizingRef  = useRef(false);
  const resizeStartY = useRef(0);
  const resizeStartH = useRef(0);

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    resizingRef.current  = true;
    resizeStartY.current = e.clientY;
    resizeStartH.current = subChartHeight;
    e.preventDefault();
  }, [subChartHeight]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = e.clientY - resizeStartY.current;
      setSubChartHeight(Math.max(60, Math.min(300, resizeStartH.current + delta)));
    };
    const onUp = () => { resizingRef.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // ── Kynttilän klikkausanalyysi ────────────────────────────────────────────
  const [candleAnalysis,    setCandleAnalysis]    = useState<CandleAnalysisResult | null>(null);
  const [candleInspecting,  setCandleInspecting]  = useState(false);

  const handleCandleClick = useCallback(async (timeUnixSec: number) => {
    if (!selectedSymbol || candleInspecting) return;
    setCandleInspecting(true);
    try {
      const res = await fetch(
        `/api/trading/candle-analysis?symbol=${encodeURIComponent(selectedSymbol)}&ts=${timeUnixSec}&timeframe=15min`
      );
      if (res.ok) {
        const data = await res.json() as CandleAnalysisResult;
        setCandleAnalysis(data);
      }
    } catch { /* ignore */ }
    finally { setCandleInspecting(false); }
  }, [selectedSymbol, candleInspecting]);

  if (!setupComplete) return <SetupWizard />;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-tv-bg font-sans">
      <TopBar />
      <MarketTicker />

      <div className="flex flex-1 min-h-0">

        {/* ── Center ──────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Main chart — gets most of the vertical space */}
          <div className="flex-1 min-h-0 border-b border-tv-border relative">
            <Chart onCandleClick={handleCandleClick} />
            {/* Latauksen indikaattori kynttilää klikatessa */}
            {candleInspecting && (
              <div className="absolute bottom-2 left-2 z-20 px-2 py-1 rounded text-[11px] pointer-events-none select-none"
                style={{ background: "#1a1a2e99", color: "#8888aa", border: "1px solid #2a2a3f" }}>
                Ladataan analyysiä…
              </div>
            )}
            {/* Analyysipaneeli — liukuu kaavion päälle */}
            {candleAnalysis && !candleInspecting && (
              <CandleAnalysis
                analysis={candleAnalysis}
                onClose={() => setCandleAnalysis(null)}
              />
            )}
          </div>

          {/* Sub-indicators (RSI / MACD) — height user-resizable via drag handle */}
          <div className="flex-shrink-0 border-b border-tv-border bg-tv-bg2" style={{ height: `${subChartHeight}px` }}>
            <SubCharts mode="detail" />
          </div>

          {/* Drag handle between sub-charts and workflow panel */}
          <div
            className="flex-shrink-0 h-[6px] bg-tv-bg3 border-y border-tv-border cursor-row-resize hover:bg-tv-blue/20 transition-colors flex items-center justify-center group select-none"
            onMouseDown={onResizeMouseDown}
            title={isFi ? "Vedä muuttaaksesi korkeutta" : "Drag to resize"}
          >
            <div className="w-8 h-[2px] rounded bg-tv-border group-hover:bg-tv-blue/60 transition-colors" />
          </div>

          {/* Pipeline + Backtester + Trade Journal — collapsible */}
          <div className={cn(
            "flex-shrink-0 bg-white border-t border-tv-border transition-all overflow-hidden",
            workflowOpen ? "overflow-y-auto" : "h-[28px]"
          )} style={workflowOpen ? { maxHeight: "260px" } : {}}>
            {/* Collapse header */}
            <div
              className="sticky top-0 z-10 flex items-center justify-between bg-tv-bg2 border-b border-tv-border px-2 py-1 cursor-pointer select-none"
              onClick={() => setWorkflowOpen(v => !v)}
            >
              <span className="text-[10px] font-bold uppercase tracking-wide text-tv-text2">
                🤖 {isFi ? "Automaattinen optimoija & Backtester" : "Auto-Optimizer & Backtester"}
              </span>
              <span className="text-[11px] text-tv-text3 ml-2">{workflowOpen ? "▾" : "▸"}</span>
            </div>
            {workflowOpen && (
              <div className="p-2">
                <TradingWorkflow />
              </div>
            )}
          </div>

        </div>

        {/* ── Right sidebar — tab-based ────────────────────────────────── */}
        <div className="w-[284px] min-w-[284px] border-l border-tv-border flex flex-col bg-white flex-shrink-0">

          {/* Tab bar */}
          <div className="flex flex-shrink-0 border-b border-tv-border bg-tv-bg2">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setSidebarTab(tab.id)}
                className={cn(
                  "flex-1 py-1.5 flex flex-col items-center gap-0.5 text-[9px] font-semibold transition-colors",
                  sidebarTab === tab.id
                    ? "bg-white text-tv-blue border-b-2 border-tv-blue"
                    : "text-tv-text2 hover:text-tv-text hover:bg-tv-hover"
                )}
              >
                <span className="text-[13px] leading-none">{tab.icon}</span>
                <span className="uppercase tracking-wide">{isFi ? tab.labelFi : tab.labelEn}</span>
              </button>
            ))}
          </div>

          {/* Tab content — scrollable */}
          <div className="flex-1 overflow-y-auto">

            {sidebarTab === "signal" && (
              <SignalPanel />
            )}

            {sidebarTab === "bot" && (
              <div className="space-y-0">
                <MultiBotPanel />
                <div className="h-px bg-tv-border mx-3" />
                <BotPanel />
                <div className="h-px bg-tv-border mx-3" />
                <ManualTrading />
              </div>
            )}

            {sidebarTab === "market" && (
              <div className="space-y-0">
                <Watchlist />
                <div className="h-px bg-tv-border mx-3" />
                <PatternMemory />
              </div>
            )}

            {sidebarTab === "daytrade" && (
              <DayTradingDashboard />
            )}

            {sidebarTab === "portfolio" && (
              <Portfolio />
            )}

          </div>

          {/* Persistent mini-status bar at bottom of sidebar */}
          <SidebarStatusBar isFi={isFi} activeTab={sidebarTab} onTabChange={setSidebarTab} />

        </div>

      </div>
    </div>
  );
}

// ── Persistent mini-status bar at bottom of sidebar ─────────────────────────
function SidebarStatusBar({
  isFi, activeTab: _activeTab, onTabChange,
}: {
  isFi: boolean;
  activeTab: SidebarTab;
  onTabChange: (t: SidebarTab) => void;
}) {
  const { currentSignal, multiBotStatus } = useTradingContext();

  const dir   = currentSignal?.direction ?? "NEUTRAL";
  const score = currentSignal?.score ?? 0;
  const maxSc = currentSignal?.maxScore ?? 13;

  const dirColor =
    dir === "BUY"  ? "text-tv-green" :
    dir === "SELL" ? "text-tv-red"   : "text-tv-text3";

  const botRunning = multiBotStatus === "RUNNING";

  return (
    <div className="flex-shrink-0 border-t border-tv-border bg-tv-bg2 px-3 py-1.5 flex items-center justify-between text-[10px]">
      {/* Signal summary — click to switch to signal tab */}
      <button
        onClick={() => onTabChange("signal")}
        className={cn("flex items-center gap-1.5 font-semibold hover:opacity-80 transition-opacity", dirColor)}
      >
        <span>{dir === "BUY" ? "▲" : dir === "SELL" ? "▼" : "●"}</span>
        <span>{dir}</span>
        {dir !== "NEUTRAL" && <span className="text-[9px] opacity-70">{score}/{maxSc}</span>}
      </button>

      {/* Bot status pill — click to switch to bot tab */}
      <button
        onClick={() => onTabChange("bot")}
        className={cn(
          "flex items-center gap-1 px-2 py-0.5 rounded-full border font-semibold hover:opacity-80 transition-opacity",
          botRunning
            ? "bg-tv-green/10 border-tv-green/30 text-tv-green"
            : "bg-tv-bg3 border-tv-border text-tv-text3"
        )}
      >
        <span className={cn("w-1.5 h-1.5 rounded-full", botRunning ? "bg-tv-green animate-pulse" : "bg-tv-text3")} />
        <span>{botRunning ? (isFi ? "Live" : "Live") : (isFi ? "Idle" : "Idle")}</span>
      </button>
    </div>
  );
}
