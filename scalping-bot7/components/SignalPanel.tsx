"use client";

import { useState, useEffect } from "react";
import { useTradingContext, type WatchlistPair } from "@/lib/context";
import { calculateRiskReward } from "@/lib/riskReward";
import { generateHumanAdvice } from "@/lib/signalEngine";
import { findSimilarPatterns, buildFingerprint } from "@/lib/patternMemory";
import { cn } from "@/lib/utils";
import { useT } from "@/components/SettingsModal";

const C_UP = "#00d47e";
const C_DN = "#ff3355";

// Maps indicator categories to keywords found in condition strings
const INDICATOR_GROUPS = [
  { name: "trend",    icon: "📈", label: "EMA Trend",    labelFi: "EMA-trendi",   keywords: ["ema", "crossover", "trend"] },
  { name: "regime",   icon: "〰", label: "Regime",       labelFi: "Regiimi",      keywords: ["regime", "ranging", "volatile"] },
  { name: "rsi",      icon: "📊", label: "RSI",          labelFi: "RSI",          keywords: ["rsi"] },
  { name: "macd",     icon: "⚡", label: "MACD",         labelFi: "MACD",         keywords: ["macd"] },
  { name: "bb",       icon: "📉", label: "Bollinger",    labelFi: "Bollinger",    keywords: ["bollinger", "bb ", "band"] },
  { name: "volume",   icon: "📦", label: "Volume",       labelFi: "Volyymi",      keywords: ["volume", "vol "] },
  { name: "vwap",     icon: "⚖", label: "VWAP",         labelFi: "VWAP",         keywords: ["vwap"] },
  { name: "fib",      icon: "🌀", label: "Fibonacci",    labelFi: "Fibonacci",    keywords: ["fibonacci", "fib"] },
  { name: "candle",   icon: "🕯", label: "Candle",       labelFi: "Kynttilä",     keywords: ["body", "wick", "hammer", "engulf", "doji", "candle"] },
] as const;

export default function SignalPanel() {
  const { currentSignal, botConfig, selectedSymbol, selectedTimeframe, candles, language, bidAskSpread, watchlistPairs, credentialsValid } = useTradingContext();
  const t    = useT();
  const isFi = language === "fi";

  const [showConditions, setShowConditions] = useState(false);

  if (!currentSignal) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-6">
        <div className="text-3xl opacity-20">📡</div>
        <div className="text-xs text-tv-text2">{t("signal.waiting")}</div>
      </div>
    );
  }

  const { direction, score, strengthPct, label, conditionsMet, conditionsFailed, indicators, regime } = currentSignal;

  // Tradeable = signal direction aligns with regime (trend-following strategy).
  // BUY valid in TRENDING_UP or RANGING; SELL valid in TRENDING_DOWN or RANGING.
  // VOLATILE always blocked. Counter-trend direction blocked.
  const regimeAllowsBuy  = regime === "TRENDING_UP"   || regime === "RANGING";
  const regimeAllowsSell = regime === "TRENDING_DOWN"  || regime === "RANGING";
  const tradeable = direction !== "NEUTRAL" && score >= (botConfig?.minSignalScore ?? 6) &&
    ((direction === "BUY" && regimeAllowsBuy) || (direction === "SELL" && regimeAllowsSell));

  const atr = indicators.atr[indicators.atr.length - 1] ?? currentSignal.entryPrice * 0.005;
  const rr  = calculateRiskReward(
    currentSignal.entryPrice,
    direction === "NEUTRAL" ? "BUY" : direction,
    atr, indicators.fibonacci, botConfig?.tradeAmountUSDT ?? 100, 0.5,
  );

  let pa = null;
  if (direction !== "NEUTRAL" && candles.length > 0) {
    const fp = buildFingerprint(indicators, candles[candles.length - 1], score, direction as "BUY" | "SELL", conditionsMet, selectedSymbol, selectedTimeframe);
    pa = findSimilarPatterns(fp.indicators, selectedSymbol, selectedTimeframe, direction as "BUY" | "SELL");
  }

  // EV = winRate × avgWin − lossRate × avgLoss  (all in USDT)
  const ev = pa
    ? pa.winRate / 100 * (rr.maxLossUSDT * rr.riskRewardRatio) - (1 - pa.winRate / 100) * rr.maxLossUSDT
    : rr.expectedValueUSDT;

  const buy  = direction === "BUY";
  const sell = direction === "SELL";
  const sc   = buy ? C_UP : sell ? C_DN : "#8888b0";

  const advice = generateHumanAdvice(
    currentSignal, botConfig?.tradeAmountUSDT ?? 100, bidAskSpread,
    (language ?? "fi") as "fi" | "en",
  );
  const stars = "★".repeat(advice.confidence) + "☆".repeat(5 - advice.confidence);

  // Regime display — trend-following strategy
  const regimeLabel = regime === "TRENDING_UP"
    ? (isFi ? "↗ Nouseva trendi — osto-signaali aktiivinen" : "↗ Trending up — BUY signals active")
    : regime === "TRENDING_DOWN"
    ? (isFi ? "↘ Laskeva trendi — myyntisignaali aktiivinen" : "↘ Trending down — SELL signals active")
    : regime === "RANGING"
    ? (isFi ? "〰 Sivuttaisliike — molemmat suunnat mahdollisia" : "〰 Ranging — both directions possible")
    : (isFi ? "⚡ Volatiili — ei kauppoja" : "⚡ Volatile — no trades");
  const regimeColor = regime === "TRENDING_UP"  ? "#00d47e"
    : regime === "TRENDING_DOWN" ? "#ff3355"
    : regime === "RANGING"       ? "#60a5fa"
    : "#ff3355";

  return (
    <div className="flex flex-col">

      {/* ── Regime status bar ───────────────────────────────────────────── */}
      <div className="px-3 py-1.5 flex items-center justify-between border-b border-tv-border text-[10px] font-semibold"
        style={{ background: regimeColor + "12", color: regimeColor }}>
        <span>{regimeLabel}</span>
        {tradeable && (
          <span className="text-[9px] px-1.5 py-0.5 rounded font-black"
            style={{ background: regimeColor + "25", color: regimeColor }}>
            ✓ {isFi ? "KAUPPAVALMIS" : "TRADEABLE"}
          </span>
        )}
        {!tradeable && direction !== "NEUTRAL" && regime !== "VOLATILE" && (
          <span className="text-[9px] text-tv-text3">
            {score}/{botConfig?.minSignalScore ?? 6} {isFi ? "tarvitaan" : "needed"}
          </span>
        )}
      </div>

      {/* ── Hero: direction + strength ──────────────────────────────────── */}
      <div
        className="px-4 py-4 text-center border-b border-tv-border"
        style={{ background: sc + "08" }}
      >
        {/* Direction label */}
        <div className="text-2xl font-black tracking-tight mb-1" style={{ color: sc }}>
          {buy ? "▲ " : sell ? "▼ " : ""}{label}
        </div>

        {/* Score bar */}
        <div className="flex items-center gap-2 justify-center mt-2">
          <span className="text-[11px] text-tv-text2 font-mono">{score}/{currentSignal.maxScore}</span>
          <div className="flex-1 max-w-[120px] h-2 bg-tv-bg3 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${strengthPct}%`, background: sc }} />
          </div>
          <span className="text-[11px] font-semibold" style={{ color: sc }}>{strengthPct}%</span>
        </div>

        {/* Confidence stars + time */}
        <div className="flex items-center justify-between mt-3">
          <span className={cn("text-[13px] tracking-widest", buy ? "text-tv-green" : sell ? "text-tv-red" : "text-tv-text3")}>
            {stars}
          </span>
          <span className="text-[10px] text-tv-text2">
            {new Date(currentSignal.timestamp).toLocaleTimeString()}
          </span>
        </div>
      </div>

      {/* ── AI Advice ───────────────────────────────────────────────────── */}
      <div className={cn(
        "mx-3 mt-3 rounded-lg border px-3 py-2.5 space-y-1.5",
        buy  ? "bg-emerald-50 border-emerald-200"  :
        sell ? "bg-red-50 border-red-200"           :
               "bg-slate-50 border-slate-200"
      )}>
        <div className="text-[12px] font-semibold text-tv-text leading-snug">
          {advice.headline}
        </div>
        <div className="text-[10px] text-tv-text2 leading-snug">
          {advice.detail}
        </div>
        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-tv-text2">
            {isFi ? "Suos. riski:" : "Suggested risk:"}{" "}
            <span className="font-semibold text-tv-text">${advice.recommendedRiskUSDT}</span>
          </span>
        </div>
        {advice.warnings.map((w, i) => (
          <div key={i} className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
            ⚠ {w}
          </div>
        ))}
      </div>

      {/* ── Price levels ─────────────────────────────────────────────────── */}
      <div className="mx-3 mt-3 rounded-lg border border-tv-border overflow-hidden">
        <div className="grid grid-cols-2 divide-x divide-tv-border">
          <LevelCell label={isFi ? "Hinta" : "Entry"}  value={`$${currentSignal.entryPrice.toFixed(4)}`} />
          <LevelCell label="Stop Loss" value={`$${rr.stopLossPrice.toFixed(4)}`} pct={`−${rr.stopLossPct.toFixed(2)}%`} color={C_DN} />
        </div>
        <div className="grid grid-cols-2 divide-x divide-tv-border border-t border-tv-border">
          <LevelCell label="TP1 (50%)" value={`$${rr.takeProfitPrice1.toFixed(4)}`} pct={`+${rr.takeProfitPct1.toFixed(2)}%`} color={C_UP} />
          <LevelCell label="TP2 (50%)" value={`$${rr.takeProfitPrice2.toFixed(4)}`} pct={`+${rr.takeProfitPct2.toFixed(2)}%`} color={C_UP} />
        </div>
      </div>

      {/* ── Key metrics ──────────────────────────────────────────────────── */}
      <div className="mx-3 mt-2 grid grid-cols-3 gap-2">
        <MetricChip
          label="R/R"
          value={`1:${rr.riskRewardRatio.toFixed(1)}`}
          valueClass={rr.riskRewardRatio >= 2 ? "text-tv-green" : "text-amber-500"}
        />
        <MetricChip
          label={isFi ? "Riski" : "Risk"}
          value={`$${rr.maxLossUSDT.toFixed(2)}`}
          valueClass="text-tv-red"
        />
        <MetricChip
          label={`EV${!pa ? "*" : ""}`}
          value={`${ev >= 0 ? "+" : ""}$${ev.toFixed(2)}`}
          valueClass={ev >= 0 ? "text-tv-green" : "text-tv-red"}
        />
      </div>

      {!pa && (
        <div className="mx-3 mt-1 text-[9px] text-tv-text3 italic">
          * {isFi ? "50% WR oletus — kasvaa historiadatan myötä" : "Assumes 50% WR — improves with history"}
        </div>
      )}

      {currentSignal.fibLevel && (
        <div className="mx-3 mt-2 text-[11px] rounded px-2 py-1 border"
          style={{ background: "#a855f715", borderColor: "#a855f730", color: "#a855f7" }}>
          Fibonacci: ${currentSignal.fibLevel.toFixed(4)}
        </div>
      )}

      {/* ── Indicator group overview ──────────────────────────────────────── */}
      <div className="mx-3 mt-3">
        <div className="text-[9px] uppercase tracking-wide text-tv-text3 mb-1.5">
          {isFi ? "Indikaattoriryhmät" : "Indicator groups"}
        </div>
        <div className="grid grid-cols-2 gap-1">
          {INDICATOR_GROUPS.map(g => {
            const met    = conditionsMet.some(c   => g.keywords.some(k => c.toLowerCase().includes(k)));
            const failed = conditionsFailed.some(c => g.keywords.some(k => c.toLowerCase().includes(k)));
            const status = met ? "met" : failed ? "failed" : "na";
            return (
              <div key={g.name} className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-[9px] font-medium",
                status === "met"    ? "bg-tv-bg2 border border-tv-green/30" :
                status === "failed" ? "bg-tv-bg2 border border-tv-border opacity-60" :
                                      "bg-tv-bg2 border border-tv-border opacity-40"
              )}>
                <span>{g.icon}</span>
                <span style={{ color: status === "met" ? C_UP : status === "failed" ? "#8888b0" : "#8888b050" }}>
                  {status === "met" ? "✓" : "✗"}
                </span>
                <span className="text-tv-text2">{isFi ? g.labelFi : g.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Conditions toggle ─────────────────────────────────────────────── */}
      <div className="mx-3 mt-2">
        <button
          onClick={() => setShowConditions(v => !v)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded border border-tv-border bg-tv-bg2 hover:bg-tv-hover transition-colors text-[11px] text-tv-text2"
        >
          <span className="font-semibold">
            {isFi ? "Kaikki ehdot" : "All conditions"}
            {" "}
            <span className="text-tv-green font-normal">✓{conditionsMet.length}</span>
            {" "}
            <span className="text-tv-text3 font-normal">✗{conditionsFailed.length}</span>
          </span>
          <span className="text-[10px]">{showConditions ? "▲" : "▼"}</span>
        </button>

        {showConditions && (
          <div className="mt-1.5 space-y-0.5">
            {conditionsMet.map((c) => (
              <div key={c} className="flex items-start gap-1.5 text-[10px]">
                <span style={{ color: C_UP }} className="mt-0.5 flex-shrink-0">✓</span>
                <span className="text-tv-text leading-tight">{c}</span>
              </div>
            ))}
            {conditionsFailed.map((c) => (
              <div key={c} className="flex items-start gap-1.5 text-[10px]">
                <span className="text-tv-text3 mt-0.5 flex-shrink-0">✗</span>
                <span className="text-tv-text2 leading-tight">{c}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Recommendations ───────────────────────────────────────────────── */}
      <Recommendations watchlistPairs={watchlistPairs} credentialsValid={credentialsValid} isFi={isFi} />

    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LevelCell({ label, value, pct, color }: {
  label: string; value: string; pct?: string; color?: string;
}) {
  return (
    <div className="px-3 py-2.5">
      <div className="text-[9px] uppercase tracking-wide text-tv-text3 mb-0.5">{label}</div>
      <div className="font-mono font-semibold text-[12px]" style={{ color: color ?? "inherit" }}>
        {value}
      </div>
      {pct && (
        <div className="text-[10px] mt-0.5" style={{ color: color ?? "inherit", opacity: 0.7 }}>
          {pct}
        </div>
      )}
    </div>
  );
}

function MetricChip({ label, value, valueClass }: {
  label: string; value: string; valueClass?: string;
}) {
  return (
    <div className="bg-tv-bg2 border border-tv-border rounded-lg px-2 py-2 text-center">
      <div className="text-[8px] uppercase tracking-wide text-tv-text3 mb-1">{label}</div>
      <div className={cn("font-bold text-[12px] font-mono", valueClass ?? "text-tv-text")}>{value}</div>
    </div>
  );
}

// ── Recommendations ────────────────────────────────────────────────────────────
// BUY: any Top20 pair that is tradeable + BUY direction (regime-aligned, score ≥ min)
// SELL: tradeable + SELL direction AND user currently holds that currency in wallet

interface WalletHolding { currency: string; available: string; }

function Recommendations({ watchlistPairs, credentialsValid, isFi }: {
  watchlistPairs: WatchlistPair[];
  credentialsValid: boolean;
  isFi: boolean;
}) {
  const [holdings, setHoldings] = useState<WalletHolding[]>([]);
  const [open, setOpen]         = useState(true);

  // Fetch non-zero wallet holdings (non-USDT) — only when credentials are available
  useEffect(() => {
    if (!credentialsValid) { setHoldings([]); return; }
    let cancelled = false;
    const fetch_ = async () => {
      try {
        const res  = await fetch("/api/trading/balance");
        if (!res.ok) return;
        const data = await res.json() as { accounts?: WalletHolding[] };
        if (!cancelled) {
          // Keep non-USDT accounts with available > 0.0001
          setHoldings((data.accounts ?? []).filter(
            a => a.currency !== "USDT" && parseFloat(a.available) > 0.0001
          ));
        }
      } catch { /* ignore */ }
    };
    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [credentialsValid]);

  const buyRecs  = watchlistPairs
    .filter(p => p.tradeable && p.signalDirection === "BUY")
    .sort((a, b) => b.signalScore - a.signalScore);

  const heldCurrencies = new Set(holdings.map(h => h.currency));
  const sellRecs = watchlistPairs
    .filter(p => p.tradeable && p.signalDirection === "SELL" &&
      heldCurrencies.has(p.symbol.replace("-USDT", "")))
    .sort((a, b) => b.signalScore - a.signalScore);

  const hasRecs = buyRecs.length > 0 || sellRecs.length > 0;

  return (
    <div className="mx-3 mt-2 mb-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 rounded border border-tv-border bg-tv-bg2 hover:bg-tv-hover transition-colors text-[11px] text-tv-text2"
      >
        <span className="font-semibold">
          {isFi ? "Suositukset" : "Recommendations"}
          {" "}
          {buyRecs.length > 0 && (
            <span className="text-tv-green font-normal">▲{buyRecs.length}</span>
          )}
          {sellRecs.length > 0 && (
            <span className="text-tv-red font-normal ml-1">▼{sellRecs.length}</span>
          )}
          {!hasRecs && (
            <span className="text-tv-text3 font-normal">—</span>
          )}
        </span>
        <span className="text-[10px]">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-1.5 space-y-1">
          {!hasRecs && (
            <div className="text-[10px] text-tv-text3 px-2 py-2 italic">
              {isFi
                ? "Ei suosituksia juuri nyt — päivittyy 30 s välein"
                : "No recommendations right now — updates every 30 s"}
            </div>
          )}

          {buyRecs.length > 0 && (
            <div className="space-y-1">
              <div className="text-[9px] uppercase tracking-wide text-tv-text3 px-1 pt-1">
                {isFi ? "🟢 Osto-ehdotukset" : "🟢 Buy suggestions"}
              </div>
              {buyRecs.map(p => (
                <RecRow key={p.symbol} pair={p} direction="BUY" isFi={isFi} />
              ))}
            </div>
          )}

          {sellRecs.length > 0 && (
            <div className="space-y-1 mt-1">
              <div className="text-[9px] uppercase tracking-wide text-tv-text3 px-1">
                {isFi ? "🔴 Myynti-ehdotukset (omistuksesi)" : "🔴 Sell suggestions (your holdings)"}
              </div>
              {sellRecs.map(p => {
                const holding = holdings.find(h => h.currency === p.symbol.replace("-USDT", ""));
                return (
                  <RecRow key={p.symbol} pair={p} direction="SELL" isFi={isFi}
                    holdingQty={holding ? parseFloat(holding.available) : undefined} />
                );
              })}
            </div>
          )}

          {!credentialsValid && (
            <div className="text-[9px] text-tv-text3 px-2 py-1 italic">
              {isFi
                ? "ℹ Myyntisuositukset vaativat API-avaimen (lompakko-omistukset)"
                : "ℹ Sell suggestions require API key (wallet holdings)"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecRow({ pair, direction, isFi, holdingQty }: {
  pair: WatchlistPair; direction: "BUY" | "SELL"; isFi: boolean; holdingQty?: number;
}) {
  const isBuy  = direction === "BUY";
  const color  = isBuy ? C_UP : C_DN;
  const name   = pair.symbol.replace("-USDT", "");
  const regime = pair.regime === "TRENDING_UP"   ? (isFi ? "↗ Trendi" : "↗ Trend") :
                 pair.regime === "TRENDING_DOWN"  ? (isFi ? "↘ Trendi" : "↘ Trend") :
                 pair.regime === "RANGING"        ? (isFi ? "〰 Sivuttain" : "〰 Ranging") :
                                                    (isFi ? "⚡ Volatiili" : "⚡ Volatile");
  return (
    <div className="flex items-center justify-between rounded px-2 py-1.5 text-[10px]"
      style={{ background: color + "12", border: `1px solid ${color}30` }}>
      <div className="flex items-center gap-1.5">
        <span className="font-bold" style={{ color }}>{isBuy ? "▲" : "▼"}</span>
        <span className="font-semibold text-tv-text">{name}</span>
        <span className="text-tv-text3">{regime}</span>
        {holdingQty !== undefined && (
          <span className="text-tv-text2">{holdingQty.toFixed(4)}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-tv-text2 font-mono">
          ${pair.price < 0.01 ? pair.price.toFixed(6) : pair.price < 1 ? pair.price.toFixed(4) : pair.price.toFixed(2)}
        </span>
        <span className="font-semibold font-mono" style={{ color }}>
          {pair.signalScore}/13
        </span>
      </div>
    </div>
  );
}
