"use client";

import { useEffect, useState, useCallback } from "react";
import { useTradingContext } from "@/lib/context";
import { TOP_20_PAIRS } from "@/lib/autoOptimizer";
import { generateSignal } from "@/lib/signalEngine";
import type { MarketRegime } from "@/lib/indicators";
import { cn } from "@/lib/utils";
import { useT } from "@/components/SettingsModal";

const C_UP   = "#00d47e";
const C_DN   = "#ff3355";
const C_GRAY = "#8888b0";

type SortMode = "signal" | "change" | "alpha";

// Regime display config — trend-following strategy
// TRENDING_UP: ideal for BUY signals. TRENDING_DOWN: ideal for SELL signals.
// RANGING: both directions possible. VOLATILE: no trades.
const REGIME_META: Record<MarketRegime, { icon: string; label: string; labelFi: string; color: string; tradeable: boolean }> = {
  TRENDING_UP:  { icon: "↗",  label: "Trend ↑",  labelFi: "Trendi ↑",  color: "#00d47e", tradeable: true  },
  TRENDING_DOWN:{ icon: "↘",  label: "Trend ↓",  labelFi: "Trendi ↓",  color: "#ff3355", tradeable: true  },
  RANGING:      { icon: "〰", label: "Ranging",  labelFi: "Sivuttain", color: "#60a5fa", tradeable: true  },
  VOLATILE:     { icon: "⚡", label: "Volatile", labelFi: "Volatiili", color: "#f59e0b", tradeable: false },
};

interface PairInfo {
  symbol:          string;
  price:           number;
  change24h:       number;
  signalScore:     number;
  signalDirection: "BUY" | "SELL" | "NEUTRAL";
  signalLabel:     string;
  volume:          string;
  regime:          MarketRegime;
  tradeable:       boolean;   // regime=RANGING AND score ≥ minScore
}

// Score thresholds: < 6 = not tradeable, 6-7 = weak, ≥ 8 = strong
function scoreColor(score: number, direction: string): string {
  if (direction === "NEUTRAL" || score < 6) return C_GRAY;
  if (score >= 8) return direction === "BUY" ? C_UP : C_DN;
  return "#f59e0b"; // amber for 6-7 (meets minimum but not strong)
}

const MIN_DISPLAY_SCORE = 6; // mirrors pipeline MIN_SIGNAL_SCORE

export default function Watchlist() {
  const {
    selectedSymbol, setSelectedSymbol, setCandles,
    selectedTimeframe, setLivePrice, setBidAskSpread,
    botConfig, language, setWatchlistPairs,
  } = useTradingContext();
  const t    = useT();
  const isFi = language === "fi";

  const minScore = botConfig?.minSignalScore ?? MIN_DISPLAY_SCORE;

  const [pairs,    setPairs]    = useState<PairInfo[]>(
    TOP_20_PAIRS.map(s => ({
      symbol: s, price: 0, change24h: 0, signalScore: 0,
      signalDirection: "NEUTRAL", signalLabel: "", volume: "—",
      regime: "RANGING", tradeable: false,
    }))
  );
  const [loading,  setLoading]  = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("signal");
  const [filter,   setFilter]   = useState("");

  const load = useCallback(async (symbol: string): Promise<PairInfo> => {
    try {
      const [pr, cr] = await Promise.all([
        fetch(`/api/trading/price?symbol=${symbol}`),
        fetch(`/api/trading/candles?symbol=${symbol}&timeframe=${selectedTimeframe}`),
      ]);
      const [pd, cd] = await Promise.all([pr.json(), cr.json()]);
      const price     = parseFloat(pd.orderBook?.price ?? "0");
      const change24h = parseFloat(pd.stats?.changeRate ?? "0") * 100;
      const volume    = parseFloat(pd.stats?.volValue ?? "0");

      let signalScore     = 0;
      let signalDirection: PairInfo["signalDirection"] = "NEUTRAL";
      let signalLabel     = "";
      let regime: MarketRegime = "RANGING";
      let tradeable       = false;

      if (cd.candles?.length >= 50) {
        // Use pipeline minScore so watchlist reflects actual trade threshold
        const s     = generateSignal(cd.candles, minScore);
        signalScore     = s.score;
        signalDirection = s.direction;
        signalLabel     = s.label;
        regime          = s.regime;
        // Trend-following: tradeable when regime aligns with signal direction
        const allowsBuy  = regime === "TRENDING_UP"   || regime === "RANGING";
        const allowsSell = regime === "TRENDING_DOWN"  || regime === "RANGING";
        tradeable = s.direction !== "NEUTRAL" && s.score >= minScore &&
          ((s.direction === "BUY" && allowsBuy) || (s.direction === "SELL" && allowsSell));
      }

      return {
        symbol, price, change24h, signalScore, signalDirection, signalLabel,
        regime, tradeable,
        volume: volume >= 1_000_000
          ? `$${(volume / 1_000_000).toFixed(1)}M`
          : `$${(volume / 1000).toFixed(0)}K`,
      };
    } catch {
      return {
        symbol, price: 0, change24h: 0, signalScore: 0,
        signalDirection: "NEUTRAL", signalLabel: "", volume: "—",
        regime: "RANGING", tradeable: false,
      };
    }
  }, [selectedTimeframe, minScore]);

  const refresh = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(TOP_20_PAIRS.map(load));
    setPairs(results);
    setWatchlistPairs(results);
    setLoading(false);
  }, [load]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const select = useCallback(async (symbol: string) => {
    setSelectedSymbol(symbol);
    const [cr, pr] = await Promise.all([
      fetch(`/api/trading/candles?symbol=${symbol}&timeframe=${selectedTimeframe}`),
      fetch(`/api/trading/price?symbol=${symbol}`),
    ]);
    const [cd, pd] = await Promise.all([cr.json(), pr.json()]);
    if (cd.candles) setCandles(cd.candles);
    setLivePrice(parseFloat(pd.orderBook?.price ?? "0"));
    const bid = parseFloat(pd.orderBook?.bestBid ?? "0");
    const ask = parseFloat(pd.orderBook?.bestAsk ?? "0");
    if (bid > 0) setBidAskSpread(((ask - bid) / bid) * 100);
  }, [selectedTimeframe, setSelectedSymbol, setCandles, setLivePrice, setBidAskSpread]);

  // Summary counts
  const tradeableCount  = pairs.filter(p => p.tradeable).length;
  const buyCount        = pairs.filter(p => p.tradeable && p.signalDirection === "BUY").length;
  const sellCount       = pairs.filter(p => p.tradeable && p.signalDirection === "SELL").length;
  const trendingUpCount = pairs.filter(p => p.regime === "TRENDING_UP").length;
  const trendingDnCount = pairs.filter(p => p.regime === "TRENDING_DOWN").length;

  // Sort & filter
  const displayed = pairs
    .filter(p => !filter || p.symbol.includes(filter.toUpperCase()))
    .slice()
    .sort((a, b) => {
      if (sortMode === "signal") {
        // Tradeable (RANGING + signal) first, then by score desc
        if (a.tradeable !== b.tradeable) return a.tradeable ? -1 : 1;
        // Among non-tradeable: RANGING before TRENDING before VOLATILE
        const regOrder = (r: MarketRegime) => r === "RANGING" ? 0 : r === "VOLATILE" ? 2 : 1;
        const rDiff = regOrder(a.regime) - regOrder(b.regime);
        if (rDiff !== 0) return rDiff;
        return b.signalScore - a.signalScore;
      }
      if (sortMode === "change") return b.change24h - a.change24h;
      return a.symbol.localeCompare(b.symbol);
    });

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-b-border2 flex-shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="label">{t("watchlist.title")}</span>
          {/* Regime counts */}
          {trendingUpCount > 0 && (
            <span className="text-[8px] px-1.5 py-0.5 rounded font-bold"
              style={{ background: "#00d47e20", color: "#00d47e" }}>
              ↗{trendingUpCount}
            </span>
          )}
          {trendingDnCount > 0 && (
            <span className="text-[8px] px-1.5 py-0.5 rounded font-bold"
              style={{ background: "#ff335520", color: "#ff3355" }}>
              ↘{trendingDnCount}
            </span>
          )}
          {/* Tradeable signals */}
          {tradeableCount > 0 && (
            <>
              <span className="text-[8px] px-1.5 py-0.5 rounded font-bold"
                style={{ background: C_UP + "20", color: C_UP }}>▲{buyCount}</span>
              <span className="text-[8px] px-1.5 py-0.5 rounded font-bold"
                style={{ background: C_DN + "20", color: C_DN }}>▼{sellCount}</span>
            </>
          )}
          {tradeableCount === 0 && (
            <span className="text-[8px] px-1.5 py-0.5 rounded font-bold"
              style={{ background: "#f59e0b20", color: "#f59e0b" }}>
              {isFi ? "Ei signaaleja" : "No signals"}
            </span>
          )}
        </div>
        <button onClick={refresh} disabled={loading}
          className={cn("text-t-muted hover:text-ac-blue transition-colors", loading && "animate-spin")}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" strokeLinecap="round"/>
            <path d="M13.5 2.5v3h-3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {/* ── Sort + filter bar ────────────────────────────────────────────────── */}
      <div className="px-2 py-1.5 flex items-center gap-1.5 border-b border-b-border2 flex-shrink-0">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder={isFi ? "Suodata..." : "Filter..."}
          className="flex-1 text-[9px] bg-tv-bg3 border border-tv-border rounded px-1.5 py-0.5 text-tv-text placeholder:text-tv-text3 focus:outline-none focus:border-tv-blue"
        />
        {(["signal", "change", "alpha"] as SortMode[]).map(m => (
          <button key={m} onClick={() => setSortMode(m)}
            className={cn(
              "text-[8px] px-1.5 py-0.5 rounded transition-colors",
              sortMode === m ? "bg-tv-blue text-white" : "bg-tv-bg3 text-tv-text3 hover:bg-tv-bg2"
            )}>
            {m === "signal" ? (isFi ? "Signaali" : "Signal") : m === "change" ? "24h" : "A–Z"}
          </button>
        ))}
      </div>

      {/* ── Column headers ───────────────────────────────────────────────────── */}
      <div className="px-3 py-1 grid grid-cols-[1fr_auto_auto] gap-2 label border-b border-b-border2 flex-shrink-0 text-[8px]">
        <span>{isFi ? "Pari / Regiimi" : "Pair / Regime"}</span>
        <span className="text-right">{isFi ? "Hinta" : "Price"}</span>
        <span className="text-right">24h</span>
      </div>

      {/* ── Pair rows ────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {displayed.map((p) => {
          const sel      = p.symbol === selectedSymbol;
          const up       = p.change24h >= 0;
          const ticker   = p.symbol.replace("-USDT", "");
          const rm       = REGIME_META[p.regime];
          const sigColor = scoreColor(p.signalScore, p.signalDirection);
          const isStrong = p.signalScore >= 8 && p.signalDirection !== "NEUTRAL";
          const isMeet   = p.signalScore >= minScore && p.signalDirection !== "NEUTRAL";
          const scorePct = Math.round((p.signalScore / 13) * 100);

          const priceStr = p.price > 0
            ? p.price.toLocaleString("en-US", {
                minimumFractionDigits: p.price < 1 ? 6 : p.price < 10 ? 4 : 2,
                maximumFractionDigits: 6,
              })
            : "—";

          return (
            <button
              key={p.symbol}
              onClick={() => select(p.symbol)}
              className={cn(
                "w-full px-3 py-1.5 grid grid-cols-[1fr_auto_auto] gap-2 items-center transition-colors text-left border-l-2",
                sel       ? "bg-b-active border-ac-blue"
                : p.tradeable ? "hover:bg-b-hover border-transparent"
                :              "hover:bg-b-hover border-transparent opacity-75"
              )}
            >
              {/* Left: pair + regime + signal */}
              <div className="flex flex-col gap-0.5 min-w-0">

                {/* Row 1: ticker + tradeable badge */}
                <div className="flex items-center gap-1.5">
                  <span className={cn("text-xs font-semibold", sel ? "text-ac-blue" : "text-t-primary")}>
                    {ticker}
                  </span>
                  {/* Tradeable badge — only shown when actually ready to trade */}
                  {p.tradeable && (
                    <span className="text-[7px] px-1 py-[1px] rounded font-black tracking-wide"
                      style={{ background: sigColor + "25", color: sigColor }}>
                      {p.signalDirection === "BUY" ? "▲ BUY" : "▼ SELL"}
                      {isStrong ? " ⚡" : ""}
                    </span>
                  )}
                </div>

                {/* Row 2: regime pill + score bar */}
                <div className="flex items-center gap-1.5">
                  {/* Regime pill */}
                  <span className="text-[8px] font-medium"
                    style={{ color: rm.tradeable ? rm.color : "#8888b0" }}>
                    {rm.icon} {isFi ? rm.labelFi : rm.label}
                  </span>

                  {/* Score bar — only shown if has any signal at all */}
                  {p.signalScore > 0 && (
                    <div className="flex items-center gap-0.5">
                      <div className="w-12 h-1 bg-tv-bg3 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${scorePct}%`,
                            background: isMeet ? sigColor : "#8888b050",
                          }}
                        />
                      </div>
                      <span className="text-[7px] font-mono"
                        style={{ color: isMeet ? sigColor : "#8888b0" }}>
                        {p.signalScore}/13
                      </span>
                    </div>
                  )}
                </div>

              </div>

              {/* Price */}
              <span className="text-right text-[10px] font-mono text-t-primary whitespace-nowrap">
                {priceStr}
              </span>

              {/* 24h change */}
              <span
                className="text-right text-[10px] font-semibold tabular-nums w-14"
                style={{ color: up ? C_UP : C_DN }}
              >
                {up ? "+" : ""}{p.change24h.toFixed(2)}%
              </span>
            </button>
          );
        })}
      </div>

    </div>
  );
}
