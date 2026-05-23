"use client";

/**
 * CandleAnalysis — liukuleva paneeli, joka näyttää kynttilää klikkaamalla
 * saadun signaalimoottorin analyysin.
 *
 * Käyttö:
 *   <CandleAnalysis analysis={analysis} onClose={() => setAnalysis(null)} />
 */

import { useState } from "react";

// ── Tyypit ────────────────────────────────────────────────────────────────────
export interface CandleAnalysisResult {
  symbol:           string;
  timeframe:        string;
  candleTime:       number;
  candleTimeIso:    string;
  candle:           { open: number; high: number; low: number; close: number; volume: number };
  direction:        "BUY" | "SELL" | "NEUTRAL";
  score:            number;
  maxScore:         number;
  strengthPct:      number;
  label:            string;
  conditionsMet:    string[];
  conditionsFailed: string[];
  regime:           string;
  wickSignal:       { type: string; strength: number; aligns: boolean } | null;
  entryPrice:       number;
  stopLossPrice:    number;
  takeProfitPrice:  number;
  indicators: {
    ema9:     number | null;
    ema21:    number | null;
    rsi:      number | null;
    macdHist: number | null;
    atr:      number | null;
    adx:      number | null;
    obv:      number | null;
    obvMA:    number | null;
  };
  candleIndex:  number;
  totalCandles: number;
  loggedAt:     number;
}

// ── Apufunktiot ───────────────────────────────────────────────────────────────
function fmt(n: number | null, decimals = 4): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 10000) return n.toFixed(1);
  if (Math.abs(n) >= 100)   return n.toFixed(2);
  return n.toFixed(decimals);
}

function fmtTs(isoStr: string): string {
  const d = new Date(isoStr);
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function dirColor(dir: string) {
  if (dir === "BUY")  return "#00d47e";
  if (dir === "SELL") return "#ff3355";
  return "#8888aa";
}

function scoreBars(score: number, max: number): string {
  const n = Math.min(Math.round(score), max);
  return "▰".repeat(n) + "▱".repeat(Math.max(0, max - n));
}

// ── Pääkomponentti ────────────────────────────────────────────────────────────
export default function CandleAnalysis({
  analysis,
  onClose,
}: {
  analysis: CandleAnalysisResult;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "conditions" | "indicators">("overview");
  const dc  = dirColor(analysis.direction);
  const ind = analysis.indicators;

  const tabCls = (t: typeof tab) =>
    `px-3 py-1 text-[11px] font-semibold rounded-t border-b-2 transition ${
      tab === t
        ? "border-current text-current"
        : "border-transparent text-[#8888aa] hover:text-[#bbbbcc]"
    }`;

  return (
    <div
      className="absolute top-2 right-2 z-30 w-[340px] rounded-xl border shadow-2xl flex flex-col"
      style={{ background: "#0d0d14", borderColor: "#2a2a3f", color: "#ccccdd", fontFamily: "monospace" }}
    >
      {/* ── Otsikkorivi ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: "#2a2a3f" }}>
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold" style={{ color: dc }}>
            {analysis.direction !== "NEUTRAL" ? (analysis.direction === "BUY" ? "▲" : "▼") : "○"}
            &nbsp;{analysis.label}
          </span>
          <span className="text-[11px]" style={{ color: "#8888aa" }}>
            {analysis.symbol} · {fmtTs(analysis.candleTimeIso)}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-[18px] leading-none hover:opacity-70 transition"
          style={{ color: "#8888aa" }}
        >
          ×
        </button>
      </div>

      {/* ── Pisteet ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 py-2 border-b" style={{ borderColor: "#2a2a3f" }}>
        <span className="text-[22px] font-black" style={{ color: dc }}>
          {analysis.score}/{analysis.maxScore}
        </span>
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] tracking-widest" style={{ color: dc }}>
            {scoreBars(analysis.score, analysis.maxScore)}
          </span>
          <span className="text-[10px]" style={{ color: "#8888aa" }}>
            {analysis.strengthPct}% · Regime: {analysis.regime}
            {analysis.wickSignal ? ` · ${analysis.wickSignal.type.replace("_", " ")}` : ""}
          </span>
        </div>
        {/* Logitieto */}
        <div className="ml-auto text-[9px] text-right" style={{ color: "#555566" }}>
          <div>Tallennettu lokiin</div>
          <div>{new Date(analysis.loggedAt).toLocaleTimeString("fi-FI")}</div>
        </div>
      </div>

      {/* ── Välilehdet ──────────────────────────────────────────────────── */}
      <div className="flex gap-0 px-2 pt-2 border-b" style={{ borderColor: "#2a2a3f" }}>
        {(["overview", "conditions", "indicators"] as const).map(t => (
          <button
            key={t}
            className={tabCls(t)}
            style={{ color: tab === t ? dc : undefined }}
            onClick={() => setTab(t)}
          >
            {t === "overview"    ? "Yleiskuva"  :
             t === "conditions"  ? `Ehdot (${analysis.conditionsMet.length}✓ ${analysis.conditionsFailed.length}✗)` :
             "Indikaattorit"}
          </button>
        ))}
      </div>

      {/* ── Sisältö ──────────────────────────────────────────────────────── */}
      <div className="overflow-y-auto" style={{ maxHeight: "360px" }}>

        {/* Yleiskuva */}
        {tab === "overview" && (
          <div className="p-3 space-y-2 text-[12px]">
            {/* Kynttilätiedot */}
            <div className="grid grid-cols-4 gap-1 text-[11px]" style={{ color: "#8888aa" }}>
              {[
                ["Open",   fmt(analysis.candle.open)],
                ["High",   fmt(analysis.candle.high)],
                ["Low",    fmt(analysis.candle.low)],
                ["Close",  fmt(analysis.candle.close)],
              ].map(([l, v]) => (
                <div key={l} className="flex flex-col items-center rounded p-1" style={{ background: "#1a1a2e" }}>
                  <span className="text-[9px] uppercase tracking-wide">{l}</span>
                  <span className="font-mono text-[11px]" style={{ color: "#ccccdd" }}>{v}</span>
                </div>
              ))}
            </div>

            {/* SL / TP */}
            <div className="grid grid-cols-2 gap-1 text-[11px]">
              <div className="rounded p-1.5 text-center" style={{ background: "#2a1a1e" }}>
                <div style={{ color: "#ff3355" }} className="text-[9px] uppercase tracking-wide">Stop-loss</div>
                <div className="font-mono" style={{ color: "#ff7788" }}>{fmt(analysis.stopLossPrice)}</div>
              </div>
              <div className="rounded p-1.5 text-center" style={{ background: "#1a2e1a" }}>
                <div style={{ color: "#00d47e" }} className="text-[9px] uppercase tracking-wide">Take-profit</div>
                <div className="font-mono" style={{ color: "#00d47e" }}>{fmt(analysis.takeProfitPrice)}</div>
              </div>
            </div>

            {/* Pikaindikaattorit */}
            <div className="grid grid-cols-3 gap-1 text-[11px]">
              {[
                ["RSI",    ind.rsi  != null ? ind.rsi.toFixed(1) : "—"],
                ["EMA9",   fmt(ind.ema9,  4)],
                ["EMA21",  fmt(ind.ema21, 4)],
                ["MACD",   ind.macdHist != null ? (ind.macdHist >= 0 ? "+" : "") + ind.macdHist.toFixed(5) : "—"],
                ["ADX",    ind.adx   != null ? ind.adx.toFixed(1) : "—"],
                ["ATR",    fmt(ind.atr, 6)],
              ].map(([l, v]) => (
                <div key={l} className="rounded p-1 flex justify-between" style={{ background: "#1a1a2e" }}>
                  <span style={{ color: "#8888aa" }}>{l}</span>
                  <span className="font-mono" style={{ color: "#ccccdd" }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Ehdot */}
        {tab === "conditions" && (
          <div className="p-3 space-y-1 text-[11px]">
            {analysis.conditionsMet.length > 0 && (
              <>
                <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: "#00d47e" }}>
                  ✓ Täyttyneet ({analysis.conditionsMet.length})
                </div>
                {analysis.conditionsMet.map((c, i) => (
                  <div key={i} className="flex gap-1.5 rounded px-2 py-1" style={{ background: "#0d1f14" }}>
                    <span style={{ color: "#00d47e" }}>✓</span>
                    <span style={{ color: "#aaccaa" }}>{c}</span>
                  </div>
                ))}
              </>
            )}
            {analysis.conditionsFailed.length > 0 && (
              <>
                <div className="text-[10px] uppercase tracking-wide mt-2 mb-1" style={{ color: "#ff3355" }}>
                  ✗ Puuttuvat ({analysis.conditionsFailed.length})
                </div>
                {analysis.conditionsFailed.map((c, i) => (
                  <div key={i} className="flex gap-1.5 rounded px-2 py-1" style={{ background: "#1f0d10" }}>
                    <span style={{ color: "#ff3355" }}>✗</span>
                    <span style={{ color: "#ccaaaa" }}>{c}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* Indikaattorit */}
        {tab === "indicators" && (
          <div className="p-3 space-y-1 text-[11px]">
            {[
              ["EMA 9",     fmt(ind.ema9)],
              ["EMA 21",    fmt(ind.ema21)],
              ["RSI",       ind.rsi != null ? ind.rsi.toFixed(2) : "—"],
              ["MACD hist", ind.macdHist != null ? ind.macdHist.toFixed(6) : "—"],
              ["ADX",       ind.adx != null ? ind.adx.toFixed(2) : "—"],
              ["ATR",       ind.atr != null ? ind.atr.toFixed(6) : "—"],
              ["OBV",       ind.obv != null ? ind.obv.toFixed(0) : "—"],
              ["OBV MA",    ind.obvMA != null ? ind.obvMA.toFixed(0) : "—"],
              ["Regime",    analysis.regime],
              ["Wick",      analysis.wickSignal ? `${analysis.wickSignal.type} ${(analysis.wickSignal.strength*100).toFixed(0)}%` : "—"],
            ].map(([l, v]) => (
              <div key={l} className="flex justify-between rounded px-2 py-1" style={{ background: "#1a1a2e" }}>
                <span style={{ color: "#8888aa" }}>{l}</span>
                <span className="font-mono" style={{ color: "#ccccdd" }}>{v}</span>
              </div>
            ))}
            <div className="text-[9px] mt-2 text-right" style={{ color: "#555566" }}>
              Kynttilä {analysis.candleIndex + 1} / {analysis.totalCandles} · {analysis.timeframe}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
