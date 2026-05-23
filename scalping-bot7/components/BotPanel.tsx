"use client";

/**
 * BotPanel — server-bot status display.
 *
 * All trading logic runs in lib/serverBot.ts (Node.js process).
 * This component only:
 *   - Polls /api/trading/bot every 5 s (running) or 30 s (stopped)
 *   - POSTs start / stop / emergency_stop commands
 *   - Shows live position P&L, session stats, last signal
 *
 * Bot can only be STARTED once the pipeline phase === "ready".
 */

import { useCallback, useEffect, useState } from "react";
import { useTradingContext } from "@/lib/context";
import { cn } from "@/lib/utils";

// ── Types (mirrors serverBot.ts — kept here to avoid importing server code) ────

interface BotOpenPosition {
  id:                string;
  direction:         "BUY" | "SELL";
  entryPrice:        number;
  entryTime:         number;
  size:              number;
  sizeUSDT:          number;
  stopLossPrice:     number;
  tp1Price:          number;
  tp2Price:          number;
  tp1Hit:            boolean;
  slMovedToBreakeven: boolean;
  trailingStopPrice?: number;
  atrAtEntry:        number;
  currentPrice:      number;
  unrealizedPnlPct:  number;
  unrealizedPnlUSDT: number;
}

interface BotState {
  status:       "stopped" | "running" | "error";
  symbol:       string;
  timeframe:    string;
  startedAt:    number | null;
  lastTickAt:   number | null;
  nextTickAt:   number | null;
  openPosition: BotOpenPosition | null;
  lastSignal: {
    direction: "BUY" | "SELL" | "NEUTRAL";
    score:     number;
    label:     string;
    timestamp: number;
  } | null;
  params: {
    minSignalScore:         number;
    stopLossAtrMultiplier:  number;
    takeProfitMultiplier:   number;
    winRate:                number;
    profitFactor:           number;
    tradeAmountUSDT:        number;
  } | null;
  sessionStats: {
    trades:    number;
    wins:      number;
    losses:    number;
    pnlUSDT:   number;
  };
  lastError:  string | null;
}

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS   = 30_000;

function formatAge(ms: number | null): string {
  if (!ms) return "—";
  const age = Date.now() - ms;
  const s   = Math.floor(age / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function formatCountdown(ms: number | null): string {
  if (!ms) return "—";
  const left = ms - Date.now();
  if (left <= 0) return "now";
  const s = Math.floor(left / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Pipeline phase type (from PipelineStatus) ─────────────────────────────────
interface PipelineSnap {
  phase: "idle" | "optimizing" | "validating" | "confirming" | "ready" | "error";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BotPanel() {
  const { language, credentialsValid } = useTradingContext();
  const isFi = language === "fi";

  const [botState,  setBotState]  = useState<BotState | null>(null);
  const [pipePhase, setPipePhase] = useState<PipelineSnap["phase"]>("idle");
  const [busy,      setBusy]      = useState(false);
  const [confirmES, setConfirmES] = useState(false); // two-click guard for emergency stop

  // ── Tick to trigger re-renders for live countdowns/ages ───────────────────
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  // ── Poll bot state ─────────────────────────────────────────────────────────
  const fetchBotState = useCallback(async () => {
    try {
      const res = await fetch("/api/trading/bot");
      if (res.ok) setBotState(await res.json() as BotState);
    } catch { /* ignore */ }
  }, []);

  // ── Poll pipeline phase (to gate START button) ─────────────────────────────
  const fetchPipePhase = useCallback(async () => {
    try {
      const res = await fetch("/api/trading/pipeline");
      if (res.ok) {
        const data = await res.json() as PipelineSnap;
        setPipePhase(data.phase);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchBotState();
    fetchPipePhase();
    const isActive = botState?.status === "running";
    const interval = setInterval(() => {
      fetchBotState();
      fetchPipePhase();
    }, isActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botState?.status]);

  // ── Command helpers ────────────────────────────────────────────────────────
  const sendCommand = useCallback(async (
    action: "start" | "stop" | "emergency_stop",
    extra?: { symbol?: string; timeframe?: string }
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/trading/bot", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action, ...extra }),
      });
      if (res.ok) setBotState(await res.json() as BotState);
    } catch { /* ignore */ } finally {
      setBusy(false);
    }
  }, [busy]);

  const handleStart         = () => sendCommand("start");
  const handleStop          = () => sendCommand("stop");
  const handleEmergencyStop = () => {
    if (!confirmES) { setConfirmES(true); return; }
    setConfirmES(false);
    sendCommand("emergency_stop");
  };

  // ── Derived values ─────────────────────────────────────────────────────────
  const isRunning   = botState?.status === "running";
  const canStart    = pipePhase === "ready" && !isRunning && credentialsValid;
  const pos         = botState?.openPosition ?? null;
  const stats       = botState?.sessionStats;
  const winRate     = stats && stats.trades > 0 ? (stats.wins / stats.trades * 100) : null;

  // ── Loading skeleton ───────────────────────────────────────────────────────
  if (!botState) {
    return (
      <div className="panel animate-pulse">
        <div className="h-4 bg-tv-bg3 rounded w-1/2 mb-2" />
        <div className="h-3 bg-tv-bg3 rounded w-3/4" />
      </div>
    );
  }

  return (
    <div className="panel space-y-3">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-tv-text uppercase tracking-wide">
          {isFi ? "Botti" : "Bot"}
          <span className="ml-1.5 text-[9px] font-normal text-tv-text3 normal-case">
            {botState.symbol} · {botState.timeframe}
          </span>
        </h2>
        <div className="flex items-center gap-1.5">
          <div className={cn(
            "w-2 h-2 rounded-full",
            isRunning                        ? "bg-tv-green animate-pulse"
            : botState.status === "error"    ? "bg-tv-red"
            : "bg-tv-text3"
          )} />
          <span className={cn(
            "text-xs font-semibold uppercase",
            isRunning                        ? "text-tv-green"
            : botState.status === "error"    ? "text-tv-red"
            : "text-tv-text3"
          )}>
            {isFi
              ? (isRunning ? "Käynnissä" : botState.status === "error" ? "Virhe" : "Pysäytetty")
              : (isRunning ? "Running"   : botState.status === "error" ? "Error"  : "Stopped")}
          </span>
        </div>
      </div>

      {/* ── Error banner ──────────────────────────────────────────────────────── */}
      {botState.status === "error" && botState.lastError && (
        <div className="text-[9px] text-tv-red bg-tv-red/10 border border-tv-red/30 rounded px-2 py-1.5 truncate">
          {botState.lastError}
        </div>
      )}

      {/* ── Pipeline gate warning ─────────────────────────────────────────────── */}
      {!isRunning && pipePhase !== "ready" && (
        <div className="text-[9px] text-tv-amber bg-tv-amber/10 border border-tv-amber/30 rounded px-2 py-1.5">
          {isFi
            ? "⏳ Odottaa pipeline-validointia ennen käynnistystä"
            : "⏳ Waiting for pipeline validation before start"}
        </div>
      )}

      {/* ── Credentials warning ──────────────────────────────────────────────── */}
      {!credentialsValid && (
        <div className="text-[9px] text-tv-text3 bg-tv-bg2 border border-tv-border rounded px-2 py-1.5">
          {isFi ? "API-avaimet puuttuvat — botti ei voi kaupata" : "API credentials missing — bot cannot trade"}
        </div>
      )}

      {/* ── Active params summary ────────────────────────────────────────────── */}
      {botState.params && (
        <div className="grid grid-cols-3 gap-1 text-[9px]">
          <ParamChip label="Score≥" value={String(botState.params.minSignalScore)} />
          <ParamChip label="SL×"    value={botState.params.stopLossAtrMultiplier.toFixed(1)} />
          <ParamChip label="TP×"    value={botState.params.takeProfitMultiplier.toFixed(1)} />
          <ParamChip label="WR"     value={`${botState.params.winRate?.toFixed(1) ?? "—"}%`}
            valueClass={botState.params.winRate >= 38 ? "text-tv-green" : "text-tv-amber"} />
          <ParamChip label="PF"     value={botState.params.profitFactor?.toFixed(2) ?? "—"}
            valueClass={botState.params.profitFactor >= 1.2 ? "text-tv-green" : "text-tv-amber"} />
          <ParamChip label="USDT"   value={`$${botState.params.tradeAmountUSDT}`} />
        </div>
      )}

      {/* ── Open position card ───────────────────────────────────────────────── */}
      {pos && (
        <div className="bg-tv-bg2 rounded p-2 space-y-1 text-xs border border-tv-border">
          <div className="flex justify-between items-center">
            <span className={cn("font-bold text-[10px]", pos.direction === "BUY" ? "text-tv-green" : "text-tv-red")}>
              {pos.direction} {botState.symbol}
            </span>
            <span className={cn("font-semibold", pos.unrealizedPnlPct >= 0 ? "text-tv-green" : "text-tv-red")}>
              {pos.unrealizedPnlPct >= 0 ? "+" : ""}{pos.unrealizedPnlPct.toFixed(2)}%
              <span className="text-[9px] font-normal text-tv-text3 ml-1">
                (${pos.unrealizedPnlUSDT.toFixed(2)})
              </span>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
            <Row label={isFi ? "Hinta" : "Entry"}  value={`$${pos.entryPrice.toFixed(4)}`} />
            <Row label="Current"                    value={`$${pos.currentPrice.toFixed(4)}`} />
            <Row label="SL"  valueClass="text-tv-red"   value={`$${pos.stopLossPrice.toFixed(4)}`} />
            <Row label="TP1" valueClass="text-tv-green" value={`$${pos.tp1Price.toFixed(4)}${pos.tp1Hit ? " ✓" : ""}`} />
            <Row label="TP2" valueClass="text-tv-green" value={`$${pos.tp2Price.toFixed(4)}`} />
            <Row label={isFi ? "Koko" : "Size"}     value={`$${pos.sizeUSDT.toFixed(0)}`} />
          </div>
          {pos.trailingStopPrice && (
            <div className="text-[9px] text-tv-purple">
              Trailing SL: ${pos.trailingStopPrice.toFixed(4)}
            </div>
          )}
        </div>
      )}

      {/* ── Session stats ────────────────────────────────────────────────────── */}
      {stats && stats.trades > 0 && (
        <div className="grid grid-cols-2 gap-1">
          <StatChip
            label={isFi ? "Voittosuhde" : "Win rate"}
            value={winRate !== null ? `${winRate.toFixed(1)}%` : "—"}
            valueClass={winRate !== null && winRate >= 38 ? "text-tv-green" : "text-tv-amber"}
          />
          <StatChip
            label={isFi ? "Session P&L" : "Session P&L"}
            value={`${stats.pnlUSDT >= 0 ? "+" : ""}$${stats.pnlUSDT.toFixed(2)}`}
            valueClass={stats.pnlUSDT >= 0 ? "text-tv-green" : "text-tv-red"}
          />
          <StatChip label={isFi ? "Kaupat" : "Trades"}
            value={`${stats.trades} (${stats.wins}W ${stats.losses}L)`} />
          <StatChip label={isFi ? "Seuraava tik" : "Next tick"}
            value={formatCountdown(botState.nextTickAt)} />
        </div>
      )}

      {/* ── Last signal ──────────────────────────────────────────────────────── */}
      {botState.lastSignal && (
        <div className="flex items-center justify-between text-[9px] bg-tv-bg2 rounded px-2 py-1 border border-tv-border">
          <span className="text-tv-text3">{isFi ? "Viimeisin signaali" : "Last signal"}</span>
          <span className={cn(
            "font-semibold",
            botState.lastSignal.direction === "BUY"  ? "text-tv-green"
            : botState.lastSignal.direction === "SELL" ? "text-tv-red"
            : "text-tv-text3"
          )}>
            {botState.lastSignal.direction} {botState.lastSignal.score}/9
          </span>
          <span className="text-tv-text3">{formatAge(botState.lastSignal.timestamp)}</span>
        </div>
      )}

      {/* ── Tick timing ──────────────────────────────────────────────────────── */}
      {isRunning && (
        <div className="flex justify-between text-[8px] text-tv-text3">
          <span>{isFi ? "Edellinen tik: " : "Last tick: "}{formatAge(botState.lastTickAt)}</span>
          <span>{isFi ? "Seuraava: " : "Next: "}{formatCountdown(botState.nextTickAt)}</span>
        </div>
      )}

      {/* ── Controls ─────────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        {!isRunning ? (
          <button
            onClick={handleStart}
            disabled={!canStart || busy}
            className={cn(
              "w-full py-2 rounded text-xs font-bold border transition-colors",
              canStart && !busy
                ? "bg-tv-green/10 text-tv-green border-tv-green/30 hover:bg-tv-green/20"
                : "bg-tv-bg3 text-tv-text3 border-tv-border cursor-not-allowed"
            )}
          >
            {busy ? "..." : `▶ ${isFi ? "Käynnistä botti" : "Start Bot"}`}
          </button>
        ) : (
          <button
            onClick={handleStop}
            disabled={busy}
            className={cn(
              "w-full py-2 rounded text-xs font-bold border transition-colors",
              "bg-tv-bg3 text-tv-text2 border-tv-border hover:bg-tv-bg2",
              busy && "opacity-50 cursor-not-allowed"
            )}
          >
            {busy ? "..." : `⏹ ${isFi ? "Pysäytä" : "Stop"}`}
          </button>
        )}

        <button
          onClick={handleEmergencyStop}
          disabled={busy}
          className={cn(
            "w-full py-2 rounded text-xs font-bold border transition-colors",
            confirmES
              ? "bg-tv-red text-white border-tv-red animate-pulse"
              : "bg-tv-red/10 text-tv-red border-tv-red/30 hover:bg-tv-red/20",
            busy && "opacity-50 cursor-not-allowed"
          )}
        >
          {confirmES
            ? (isFi ? "🔴 Vahvista hätäpysäytys?" : "🔴 Confirm emergency stop?")
            : `🔴 ${isFi ? "Hätäpysäytys" : "Emergency Stop"}`}
        </button>

        {confirmES && (
          <button
            onClick={() => setConfirmES(false)}
            className="w-full py-1 rounded text-[9px] text-tv-text3 border border-tv-border hover:bg-tv-bg2 transition-colors"
          >
            {isFi ? "Peruuta" : "Cancel"}
          </button>
        )}
      </div>

    </div>
  );
}

// ── Small sub-components ──────────────────────────────────────────────────────

function ParamChip({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-tv-bg2 rounded px-1.5 py-1 text-center border border-tv-border">
      <div className="text-[8px] text-tv-text3 uppercase">{label}</div>
      <div className={cn("font-semibold text-[9px] mt-0.5", valueClass ?? "text-tv-text")}>{value}</div>
    </div>
  );
}

function StatChip({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-tv-bg2 rounded px-2 py-1 border border-tv-border">
      <div className="text-[8px] text-tv-text3 uppercase tracking-wide">{label}</div>
      <div className={cn("font-semibold text-xs mt-0.5", valueClass ?? "text-tv-text")}>{value}</div>
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <>
      <span className="text-tv-text3">{label}</span>
      <span className={cn("font-mono text-right", valueClass ?? "text-tv-text")}>{value}</span>
    </>
  );
}
