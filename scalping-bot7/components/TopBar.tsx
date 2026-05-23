"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useTradingContext } from "@/lib/context";
import { SUPPORTED_TIMEFRAMES } from "@/lib/kucoinPublic";
import { generateSignal } from "@/lib/signalEngine";
import { formatPrice, cn } from "@/lib/utils";
import SettingsModal, { useT } from "@/components/SettingsModal";

export default function TopBar() {
  const {
    selectedSymbol, setSelectedSymbol, selectedTimeframe, setSelectedTimeframe,
    setCandles, livePrice, setLivePrice, setBidAskSpread,
    botStatus, setCurrentSignal, notification, setNotification,
    credentialsValid,
  } = useTradingContext();

  const t = useT();
  const [showSettings, setShowSettings] = useState(false);
  const [usdtBalance, setUsdtBalance]   = useState<number | null>(null);
  const [countdown, setCountdown]   = useState(30);
  const [connected, setConnected]   = useState(false);
  const [change24h, setChange24h]   = useState(0);
  const [flash, setFlash]           = useState<"up" | "down" | null>(null);
  const prevPriceRef                = useRef(0);

  // ── Intracandle velocity monitor ─────────────────────────────────────────
  // Tracks rolling 30s price polls. Fires an alert when price moves faster
  // than normal within a candle — catches flash drops/spikes before candle close.
  // Thresholds: 0.6% in 60s or 1.0% in 150s = high-velocity move.
  type PricePoint = { price: number; time: number };
  const priceHistoryRef = useRef<PricePoint[]>([]);
  const [velocityAlert, setVelocityAlert] = useState<{
    dir: "UP" | "DOWN"; pct: number; secs: number;
  } | null>(null);

  // Pipeline status badge — poll every 60 s
  const [pipeWR, setPipeWR] = useState<number | null>(null);
  const [pipePF, setPipePF] = useState<number | null>(null);
  const [pipeOK, setPipeOK] = useState<boolean | null>(null);
  useEffect(() => {
    const fetchPipe = async () => {
      try {
        const res  = await fetch("/api/trading/pipeline");
        if (!res.ok) return;
        const data = await res.json() as {
          phase: string;
          backtestResult?: { winRate: number; profitFactor: number; validated: boolean } | null;
        };
        if (data.phase === "ready" && data.backtestResult) {
          setPipeWR(data.backtestResult.winRate);
          setPipePF(data.backtestResult.profitFactor);
          setPipeOK(data.backtestResult.winRate >= 50 && data.backtestResult.profitFactor >= 1.0);
        }
      } catch { /* ignore */ }
    };
    fetchPipe();
    const id = setInterval(fetchPipe, 60_000);
    return () => clearInterval(id);
  }, []);

  // Combobox state
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [filter, setFilter]         = useState(selectedSymbol);
  const [open, setOpen]             = useState(false);
  const comboRef                    = useRef<HTMLDivElement>(null);

  // Load symbol list from KuCoin once
  useEffect(() => {
    fetch("/api/trading/symbols")
      .then((r) => r.json())
      .then((d) => {
        const list: string[] = (d.symbols ?? []).map((s: { symbol: string }) => s.symbol).sort();
        setAllSymbols(list);
      })
      .catch(() => {});
  }, []);

  // Fetch USDT balance — once on mount and every 60 s
  useEffect(() => {
    if (!credentialsValid) return;
    const fetchBalance = async () => {
      try {
        const res  = await fetch("/api/trading/balance");
        if (!res.ok) return;
        const data = await res.json() as { accounts?: { currency: string; available: string }[] };
        const usdt = data.accounts?.find(a => a.currency === "USDT");
        if (usdt) setUsdtBalance(parseFloat(usdt.available));
      } catch { /* ignore */ }
    };
    fetchBalance();
    const id = setInterval(fetchBalance, 60_000);
    return () => clearInterval(id);
  }, [credentialsValid]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter(selectedSymbol); // reset filter to current if user didn't pick
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selectedSymbol]);

  const filteredSymbols = allSymbols
    .filter((s) => s.includes(filter.toUpperCase()))
    .slice(0, 80);

  const selectSymbol = useCallback((sym: string) => {
    setSelectedSymbol(sym);
    setFilter(sym);
    setOpen(false);
  }, [setSelectedSymbol]);

  const loadData = useCallback(async (sym: string, tf: string) => {
    try {
      const [pr, cr] = await Promise.all([
        fetch(`/api/trading/price?symbol=${sym}`),
        fetch(`/api/trading/candles?symbol=${sym}&timeframe=${tf}`),
      ]);
      const [pd, cd] = await Promise.all([pr.json(), cr.json()]);

      const price = parseFloat(pd.orderBook?.price ?? "0");
      if (price > 0 && prevPriceRef.current > 0) {
        setFlash(price >= prevPriceRef.current ? "up" : "down");
        setTimeout(() => setFlash(null), 600);
      }
      prevPriceRef.current = price;
      setLivePrice(price);
      setChange24h(parseFloat(pd.stats?.changeRate ?? "0") * 100);

      // ── Velocity monitoring — intracandle flash move detection ──────────
      if (price > 0) {
        const now = Date.now();
        const hist = priceHistoryRef.current;
        hist.push({ price, time: now });
        // Keep only last 10 samples (~5 min at 30s intervals)
        if (hist.length > 10) hist.shift();

        // Check velocity over 60s window (last 2 polls) and 150s window (last 5 polls)
        let alert: typeof velocityAlert = null;
        const windows: [number, number][] = [[2, 60], [5, 150]];  // [samples, seconds]
        const thresholds: [number, number][] = [[0.60, 60], [1.00, 150]]; // % per seconds
        for (let w = 0; w < windows.length; w++) {
          const [samples] = windows[w];
          const [threshPct] = thresholds[w];
          if (hist.length >= samples) {
            const old   = hist[hist.length - samples];
            const secs  = Math.round((now - old.time) / 1000);
            const pct   = ((price - old.price) / old.price) * 100;
            if (Math.abs(pct) >= threshPct && secs > 0) {
              alert = { dir: pct > 0 ? "UP" : "DOWN", pct: Math.abs(pct), secs };
              break; // use fastest window that triggered
            }
          }
        }
        setVelocityAlert(alert);
      }

      const bid = parseFloat(pd.orderBook?.bestBid ?? "0");
      const ask = parseFloat(pd.orderBook?.bestAsk ?? "0");
      if (bid > 0) setBidAskSpread(((ask - bid) / bid) * 100);

      if (cd.candles?.length >= 50) {
        setCandles(cd.candles);
        setCurrentSignal(generateSignal(cd.candles, 4));
      }
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, [setLivePrice, setBidAskSpread, setCandles, setCurrentSignal]);  // prevPrice removed → now a ref

  useEffect(() => {
    // Reset velocity history when pair or timeframe changes — avoid cross-pair false alerts
    priceHistoryRef.current = [];
    setVelocityAlert(null);
    loadData(selectedSymbol, selectedTimeframe);
  }, [selectedSymbol, selectedTimeframe, loadData]);

  useEffect(() => {
    setCountdown(30);
    const t = setInterval(() => {
      setCountdown((c) => { if (c <= 1) { loadData(selectedSymbol, selectedTimeframe); return 30; } return c - 1; });
    }, 1_000);
    return () => clearInterval(t);
  }, [selectedSymbol, selectedTimeframe, loadData]);

  useEffect(() => {
    if (!notification) return;
    const t = setTimeout(() => setNotification(""), 5000);
    return () => clearTimeout(t);
  }, [notification, setNotification]);

  const up = change24h >= 0;
  const priceColor = flash === "up" ? "text-tv-green" : flash === "down" ? "text-tv-red" : "text-tv-text";

  return (
    <div className="h-[44px] flex-shrink-0 flex items-center gap-3 px-4 bg-white border-b border-tv-border">

      {/* Logo + build stamp */}
      <div className="flex items-center gap-2 select-none">
        <div className="w-6 h-6 rounded bg-tv-green-dim flex items-center justify-center">
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-tv-green fill-current">
            <path d="M8 1L1 14h14L8 1z" />
          </svg>
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-sm font-bold text-tv-text tracking-tight">KuCoin Bot</span>
          <BuildStamp />
        </div>
      </div>

      <div className="h-4 w-px bg-tv-border" />

      {/* Kaupankäyntipari-combobox */}
      <div ref={comboRef} className="relative">
        <input
          value={filter}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setFilter(e.target.value.toUpperCase()); setOpen(true); }}
          className="bg-tv-bg2 border border-tv-border rounded px-2 py-1 text-xs font-semibold text-tv-text w-32 focus:outline-none focus:border-tv-blue focus:ring-1 focus:ring-tv-blue/20 placeholder:text-tv-text3"
          placeholder={t("topbar.search_placeholder")}
        />
        {/* dropdown arrow indicator */}
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-tv-text3 text-[10px] pointer-events-none">▾</span>

        {open && (
          <div className="absolute top-full left-0 mt-1 w-48 max-h-64 overflow-y-auto bg-white border border-tv-border rounded shadow-dropdown z-50">
            {allSymbols.length === 0 && (
              <div className="px-3 py-2 text-xs text-tv-text2">{t("topbar.loading_pairs")}</div>
            )}
            {filteredSymbols.length === 0 && allSymbols.length > 0 && (
              <div className="px-3 py-2 text-xs text-tv-text2">{t("topbar.no_pairs")}</div>
            )}
            {filteredSymbols.map((sym) => (
              <button
                key={sym}
                onMouseDown={(e) => { e.preventDefault(); selectSymbol(sym); }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-xs transition-colors",
                  sym === selectedSymbol
                    ? "bg-tv-blue-dim text-tv-blue font-semibold"
                    : "text-tv-text hover:bg-tv-hover"
                )}
              >
                {sym}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Reaaliaikainen hinta */}
      {livePrice > 0 && (
        <div className="flex items-baseline gap-2">
          <span className={cn("text-xl font-bold font-mono transition-colors duration-300", priceColor)}>
            {formatPrice(livePrice)}
          </span>
          <span className={cn("text-xs font-semibold tabular-nums", up ? "text-tv-green" : "text-tv-red")}>
            {up ? "▲" : "▼"} {Math.abs(change24h).toFixed(2)}%
          </span>
        </div>
      )}

      <div className="h-4 w-px bg-tv-border" />

      {/* Aikavälit */}
      <div className="flex items-center gap-0.5">
        {SUPPORTED_TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
            onClick={() => setSelectedTimeframe(tf.value)}
            className={cn(
              "px-2 py-1 rounded text-[11px] font-semibold transition-all",
              selectedTimeframe === tf.value
                ? "bg-tv-blue text-white shadow-sm"
                : "text-tv-text2 hover:bg-tv-bg2 hover:text-tv-text"
            )}
          >
            {tf.label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* ── Intracandle velocity alert ───────────────────────────────────── */}
      {velocityAlert && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded border animate-pulse",
            velocityAlert.dir === "DOWN"
              ? "bg-red-500/15 border-red-500/50 text-red-400"
              : "bg-emerald-500/15 border-emerald-500/50 text-emerald-400"
          )}
          title={`Hintaliike: ${velocityAlert.dir === "DOWN" ? "−" : "+"}${velocityAlert.pct.toFixed(2)}% / ${velocityAlert.secs}s`}
        >
          <span>{velocityAlert.dir === "DOWN" ? "⚡ SYÖKSY" : "⚡ PIIKKI"}</span>
          <span className="font-mono">
            {velocityAlert.dir === "DOWN" ? "−" : "+"}{velocityAlert.pct.toFixed(2)}%
          </span>
          <span className="text-[9px] opacity-70">{velocityAlert.secs}s</span>
        </div>
      )}

      {/* Ilmoitustoast */}
      {notification && (
        <div className="text-[11px] bg-tv-purple-dim text-tv-purple border border-tv-purple/30 rounded px-2.5 py-1 max-w-[240px] truncate">
          {notification}
        </div>
      )}

      {/* Päivityslaskin */}
      <div className="flex items-center gap-1 text-tv-text2 text-[11px]">
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" strokeLinecap="round"/>
          <path d="M13.5 2.5v3h-3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {countdown}s
      </div>

      <div className="h-4 w-px bg-tv-border" />

      {/* Botin tila */}
      <div className={cn(
        "text-[11px] font-semibold px-2.5 py-1 rounded border transition-colors",
        botStatus === "RUNNING"
          ? "text-tv-green border-tv-green/30 bg-tv-green-dim"
          : "text-tv-text2 border-tv-border bg-tv-bg2"
      )}>
        {botStatus === "RUNNING" ? "● LIVE" : "○ IDLE"}
      </div>

      {/* Yhteys */}
      <div className="flex items-center gap-1.5">
        <div className={cn("w-1.5 h-1.5 rounded-full", connected ? "bg-tv-green" : "bg-tv-red")} />
        <span className="text-[11px] text-tv-text2">{connected ? t("topbar.connected") : t("topbar.offline")}</span>
      </div>

      {/* USDT balance */}
      {usdtBalance !== null && (
        <>
          <div className="h-4 w-px bg-tv-border" />
          <div className="flex items-center gap-1 text-[11px]">
            <span className="text-tv-text3">USDT</span>
            <span className="font-mono font-semibold text-tv-text">{usdtBalance.toFixed(2)}</span>
          </div>
        </>
      )}

      {/* Pipeline status badge */}
      {pipeWR !== null && pipePF !== null && (
        <>
          <div className="h-4 w-px bg-tv-border" />
          <div
            className={cn(
              "flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border",
              pipeOK
                ? "bg-tv-green/10 border-tv-green/30 text-tv-green"
                : "bg-amber-500/10 border-amber-400/40 text-amber-600"
            )}
            title={pipeOK ? "Pipeline OK — automated trading enabled" : "Pipeline below target — check optimizer"}
          >
            <span>{pipeOK ? "●" : "◑"}</span>
            <span className="font-mono">WR {pipeWR.toFixed(1)}%</span>
            <span className="text-[9px] opacity-70">PF {pipePF.toFixed(2)}</span>
          </div>
        </>
      )}

      {/* Asetukset */}
      <button
        onClick={() => setShowSettings(true)}
        className="text-tv-text2 hover:text-tv-text px-2 py-1 rounded hover:bg-tv-bg3 transition-colors text-base"
        aria-label="Settings"
        title="Asetukset / Settings"
      >
        ⚙️
      </button>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

    </div>
  );
}

// ── Build stamp ───────────────────────────────────────────────────────────────
// NEXT_PUBLIC_BUILD_TIME is injected at compile time by next.config.ts → env.
// Hovering shows the full ISO timestamp; the badge shows a short human date.
function BuildStamp() {
  const raw  = process.env.NEXT_PUBLIC_BUILD_TIME ?? "";
  const name = process.env.NEXT_PUBLIC_APP_NAME   ?? "bot";
  if (!raw) return null;

  const d     = new Date(raw);
  const dd    = String(d.getDate()).padStart(2, "0");
  const mm    = String(d.getMonth() + 1).padStart(2, "0");
  const hh    = String(d.getHours()).padStart(2, "0");
  const min   = String(d.getMinutes()).padStart(2, "0");
  const label = `${name} · ${dd}.${mm}. ${hh}:${min}`;

  return (
    <span
      className="text-[8px] text-tv-text3 font-mono tracking-tight"
      title={`Käännetty / Built: ${raw}`}
    >
      {label}
    </span>
  );
}
