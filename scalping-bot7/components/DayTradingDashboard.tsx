"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useTradingContext } from "@/lib/context";
import { useT } from "@/components/SettingsModal";
import type { DayTradePosition, ClosedDayTrade, DayTradingState } from "@/lib/dayTradingEngine";

const C_UP   = "#00d47e";
const C_DN   = "#ff3355";
const C_GRAY = "#8888b0";

// ── Types matching the API response ──────────────────────────────────────────
interface DayTradingConfig {
  MAX_POSITIONS:          number;
  RISK_PCT_PER_TRADE:     number;
  MAX_TRADE_USDT:         number;
  MAX_DAILY_LOSS_PCT:     number;
  MAX_CONSECUTIVE_LOSSES: number;
  SCAN_INTERVAL_MS:       number;
  SCORE_BOOST:            number;
  ASIA_SCORE_BOOST:       number;
  // Live session data
  session:       string;   // "Asia" | "EU/US"
  isAsiaSession: boolean;
  maxTradeUSDT:  number;   // current effective cap (may be halved in Asia)
}

interface ApiResponse {
  state:  DayTradingState;
  log:    ClosedDayTrade[];
  config: DayTradingConfig;
}

function pct(v: number, digits = 2): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}
function usd(v: number, digits = 2): string {
  return `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(digits)}`;
}
function dur(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatChip({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-tv-bg2 border border-tv-border rounded-lg px-2 py-1.5 text-center min-w-0">
      <div className="text-[8px] uppercase tracking-wide text-tv-text3 mb-0.5">{label}</div>
      <div className={cn("font-bold text-[12px] font-mono truncate", valueClass ?? "text-tv-text")}>{value}</div>
    </div>
  );
}

function PositionCard({ pos, isFi }: { pos: DayTradePosition; isFi: boolean }) {
  const isBuy    = pos.direction === "BUY";
  const color    = isBuy ? C_UP : C_DN;
  const pnlPos   = pos.unrealizedPnlPct >= 0;
  const pnlCol   = pnlPos ? C_UP : C_DN;
  const isPortfolio = pos.portfolioImport === true;

  const elapsed = Date.now() - pos.entryTime;
  const tp1Pct  = ((Math.abs(pos.tp1Price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
  const tp2Pct  = ((Math.abs(pos.tp2Price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
  const slPct   = ((Math.abs(pos.stopLossPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);

  // Progress to TP1 (0–100%)
  const distToTp1   = Math.abs(pos.tp1Price - pos.entryPrice);
  const movedToTp1  = Math.abs(pos.currentPrice - pos.entryPrice);
  const progressPct = distToTp1 > 0 ? Math.min(100, Math.max(0, (movedToTp1 / distToTp1) * 100)) : 0;

  return (
    <div className="border border-tv-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-1.5 flex items-center justify-between"
        style={{ background: color + "15", borderBottom: `1px solid ${color}30` }}>
        <div className="flex items-center gap-2">
          <span className="font-bold text-[11px]" style={{ color }}>
            {isBuy ? "▲" : "▼"} {pos.direction}
          </span>
          <span className="font-mono font-semibold text-[11px] text-tv-text">
            {pos.symbol.replace("-USDT", "")}
          </span>
          {isPortfolio ? (
            <span className="text-[8px] px-1 py-0.5 rounded font-bold"
              style={{ background: "#60a5fa20", color: "#60a5fa" }}>
              📦 {isFi ? "SALKKU" : "WALLET"}
            </span>
          ) : (
            <span className="text-[8px] px-1 py-0.5 rounded"
              style={{ background: color + "20", color }}>
              {pos.signalScore}/13
            </span>
          )}
        </div>
        <div className="text-[9px] text-tv-text3">{dur(elapsed)}</div>
      </div>

      {/* Price levels */}
      <div className="px-3 py-2 space-y-1.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-tv-text3">Entry</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-tv-text3 text-[9px]">${pos.sizeUSDT.toFixed(0)} kiinni</span>
            <span className="font-mono text-tv-text">${pos.entryPrice.toFixed(4)}</span>
          </div>
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-tv-text3">Now</span>
          <span className="font-mono font-semibold" style={{ color: pnlCol }}>
            ${pos.currentPrice.toFixed(4)}
          </span>
        </div>

        {/* Progress bar to TP1 */}
        {!pos.tp1Hit && (
          <div className="space-y-0.5">
            <div className="flex justify-between text-[8px] text-tv-text3">
              <span>→ TP1 (+{tp1Pct}%)</span>
              <span>{progressPct.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 bg-tv-bg3 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all"
                style={{ width: `${progressPct}%`, background: color }} />
            </div>
          </div>
        )}
        {pos.tp1Hit && (
          <div className="text-[9px] text-tv-green font-semibold">✓ TP1 ({isFi ? "SL→breakeveniin" : "SL→breakeven"})</div>
        )}

        {/* SL / TP2 */}
        <div className="flex gap-2 text-[9px]">
          <span className="text-tv-red">SL {slPct}%</span>
          <span className="text-tv-text3">·</span>
          <span className="text-tv-text3">TP2 +{tp2Pct}%</span>
        </div>

        {/* P&L */}
        <div className="flex items-center justify-between pt-1 border-t border-tv-border">
          <span className="text-[9px] text-tv-text3">P&L</span>
          <span className="font-mono font-bold text-[11px]" style={{ color: pnlCol }}>
            {pct(pos.unrealizedPnlPct)} / {usd(pos.unrealizedPnlUSDT)}
          </span>
        </div>
      </div>
    </div>
  );
}

function TradeRow({ trade, isFi }: { trade: ClosedDayTrade; isFi: boolean }) {
  const win        = trade.pnlUSDT >= 0;
  const color      = win ? C_UP : C_DN;
  const reasonIcon = trade.exitReason === "TP2"    ? "🎯" :
                     trade.exitReason === "TP1"    ? "½🎯" :
                     trade.exitReason === "TRAIL"  ? "📌" :
                     trade.exitReason === "MANUAL" ? "✋" : "🛑";

  // Price display: format to 4-6 significant digits
  const fmtPrice = (p: number) => p < 1 ? p.toFixed(5) : p < 100 ? p.toFixed(3) : p.toFixed(1);

  return (
    <div className={cn(
      "px-3 py-1.5 border-b border-tv-border",
      win ? "bg-tv-green/5" : "bg-tv-red/5"
    )}>
      {/* Row 1: direction, pair, time, duration, reason, P&L */}
      <div className="flex items-center gap-2 text-[10px]">
        <span className="text-[11px]" style={{ color }}>{trade.direction === "BUY" ? "▲" : "▼"}</span>
        <span className="font-semibold text-tv-text w-14 truncate">{trade.symbol.replace("-USDT", "")}</span>
        <span className="text-tv-text3 text-[8px]">{timeStr(trade.exitTime)}</span>
        <span className="text-[9px] text-tv-text3">{trade.durationMin}m</span>
        <span className="text-[10px]">{reasonIcon}</span>
        <span className="ml-auto font-mono font-bold" style={{ color }}>{pct(trade.pnlPct, 2)}</span>
        <span className="font-mono text-[9px]" style={{ color }}>{usd(trade.pnlUSDT)}</span>
      </div>
      {/* Row 2: entry→exit prices + size */}
      <div className="flex items-center gap-1.5 mt-0.5 text-[8px] text-tv-text3">
        <span>{isFi ? "Sisään" : "In"} {fmtPrice(trade.entryPrice)}</span>
        <span>→</span>
        <span style={{ color }}>{fmtPrice(trade.exitPrice)}</span>
        <span className="ml-1 opacity-60">${trade.sizeUSDT.toFixed(0)}</span>
        {trade.signalScore > 0 && (
          <span className="ml-auto opacity-60">{trade.signalScore}/13</span>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DayTradingDashboard() {
  const { language } = useTradingContext();
  const t     = useT();
  const isFi  = language === "fi";

  const [data,    setData]    = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch("/api/trading/day-trading");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as ApiResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch error");
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 10_000);
    return () => clearInterval(id);
  }, [fetch_]);

  const action = useCallback(async (act: string, extra?: object) => {
    setLoading(true);
    try {
      const res = await fetch("/api/trading/day-trading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: act, ...extra }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (json.error) setError(json.error);
      else { setError(null); await fetch_(); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setLoading(false);
    }
  }, [fetch_]);

  if (!data) {
    return (
      <div className="flex items-center justify-center py-12 text-tv-text3 text-xs">
        {isFi ? "Ladataan..." : "Loading..."}
      </div>
    );
  }

  const { state, log, config } = data;
  const ds   = state.dailyStats;
  const isRunning = state.status === "running";
  const isHalted  = state.status === "halted";
  const isStopped = state.status === "stopped";

  const winRate = ds.trades > 0 ? (ds.wins / ds.trades) * 100 : 0;
  // Profit factor: grossWins / grossLosses. Cap display at 9.9 if no losses yet (all wins so far)
  const pf      = ds.grossLosses > 0 ? ds.grossWins / ds.grossLosses
                : ds.grossWins   > 0 ? 9.99
                : 0;

  // Rolling WR: last 20 closed trades (live indicator of recent performance vs backtest)
  const rolling20    = log.slice(-20);
  const rolling20WR  = rolling20.length >= 5
    ? (rolling20.filter(t => t.pnlUSDT >= 0).length / rolling20.length) * 100
    : null;

  // Drawdown warning thresholds
  const drawdownPct       = ds.pnlPct < 0 ? Math.abs(ds.pnlPct) : 0;
  const drawdownWarnLevel = config.MAX_DAILY_LOSS_PCT * 0.5;   // warn at 50% of limit
  const drawdownCritLevel = config.MAX_DAILY_LOSS_PCT * 0.85;  // critical at 85% of limit

  const statusColor = isRunning ? C_UP : isHalted ? C_DN : C_GRAY;
  const statusLabel = isRunning
    ? (isFi ? "● KÄYNNISSÄ" : "● RUNNING")
    : isHalted
    ? (isFi ? "⛔ PYSÄYTETTY" : "⛔ HALTED")
    : (isFi ? "○ PYSÄYTETTY" : "○ STOPPED");

  const inCooldown    = state.cooldownUntil !== null && Date.now() < state.cooldownUntil;
  const cooldownSecsLeft = inCooldown
    ? Math.ceil((state.cooldownUntil! - Date.now()) / 1000)
    : 0;

  return (
    <div className="flex flex-col pb-4">

      {/* ── Status header ─────────────────────────────────────────────────── */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-tv-border"
        style={{ background: statusColor + "12" }}>
        <div className="flex flex-col">
          <span className="text-[11px] font-black" style={{ color: statusColor }}>
            {statusLabel}
          </span>
          {state.haltReason && (
            <span className="text-[9px] text-tv-red">{state.haltReason}</span>
          )}
          {inCooldown && (
            <span className="text-[9px] text-amber-500">
              {isFi ? `Jäähdytysaika: ${cooldownSecsLeft}s` : `Cooldown: ${cooldownSecsLeft}s`}
            </span>
          )}
        </div>

        <div className="flex gap-1.5">
          {(isStopped || isHalted) && (
            <button
              onClick={() => action("start")}
              disabled={loading}
              className="text-[10px] font-bold px-2.5 py-1 rounded bg-tv-green text-white hover:bg-tv-green/80 disabled:opacity-50 transition-colors"
            >
              {isFi ? "Käynnistä" : "Start"}
            </button>
          )}
          {isRunning && (
            <>
              <button
                onClick={() => action("stop")}
                disabled={loading}
                className="text-[10px] font-bold px-2 py-1 rounded bg-tv-bg3 border border-tv-border text-tv-text hover:bg-tv-hover disabled:opacity-50"
              >
                {isFi ? "Pysäytä" : "Stop"}
              </button>
              <button
                onClick={() => { if (confirm(isFi ? "Sulje kaikki avoimet positiot?" : "Close all open positions?")) action("stop_close_all"); }}
                disabled={loading}
                className="text-[10px] font-bold px-2 py-1 rounded bg-red-500/20 border border-red-500/40 text-tv-red hover:bg-red-500/30 disabled:opacity-50"
              >
                {isFi ? "Pysäytä + sulje" : "Stop + close all"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Error banner ──────────────────────────────────────────────────── */}
      {(error || state.lastError) && (
        <div className="mx-3 mt-2 px-2 py-1.5 rounded border border-amber-400/40 bg-amber-50 text-amber-700 text-[10px]">
          ⚠ {error || state.lastError}
        </div>
      )}

      {/* ── Drawdown warning ──────────────────────────────────────────────── */}
      {drawdownPct >= drawdownWarnLevel && !isHalted && (
        <div className={cn(
          "mx-3 mt-2 px-2.5 py-1.5 rounded border text-[10px] font-semibold",
          drawdownPct >= drawdownCritLevel
            ? "border-red-500/50 bg-red-500/10 text-red-400"
            : "border-amber-500/50 bg-amber-500/10 text-amber-400"
        )}>
          {drawdownPct >= drawdownCritLevel ? "🚨" : "⚠"}&nbsp;
          {isFi
            ? `Päivärajoite: ${ds.pnlPct.toFixed(2)}% / −${config.MAX_DAILY_LOSS_PCT}%`
            : `Daily limit: ${ds.pnlPct.toFixed(2)}% / −${config.MAX_DAILY_LOSS_PCT}%`}
        </div>
      )}

      {/* ── Session badge ─────────────────────────────────────────────────── */}
      {config.isAsiaSession && isRunning && (
        <div className="mx-3 mt-1.5 px-2.5 py-1 rounded border border-amber-400/30 bg-amber-400/8 text-[9px] text-amber-400 flex items-center gap-1">
          🌙 {isFi ? "Aasia-sessio — isompi signaalikynnys, pienempi positio" : `Asia session — +${config.ASIA_SCORE_BOOST} signal pts, $${config.maxTradeUSDT} max trade`}
        </div>
      )}

      {/* ── Daily P&L hero ────────────────────────────────────────────────── */}
      <div className="mx-3 mt-3 rounded-lg border border-tv-border overflow-hidden">
        <div className="px-4 py-3 text-center border-b border-tv-border">
          <div className="text-[9px] uppercase tracking-wide text-tv-text3 mb-1">
            {isFi ? "Päivän P&L" : "Day P&L"}
          </div>
          <div className={cn(
            "text-2xl font-black font-mono",
            ds.pnlUSDT >= 0 ? "text-tv-green" : "text-tv-red"
          )}>
            {usd(ds.pnlUSDT, 2)}
          </div>
          <div className={cn("text-[11px] font-semibold", ds.pnlPct >= 0 ? "text-tv-green" : "text-tv-red")}>
            {pct(ds.pnlPct)}
          </div>
          {ds.dayStartBalance > 0 && (
            <div className="text-[9px] text-tv-text3 mt-1">
              {isFi ? "Alku" : "Start"}: ${ds.dayStartBalance.toFixed(2)}
            </div>
          )}
        </div>

        {/* Daily limit bar */}
        <div className="px-3 py-2">
          <div className="flex justify-between text-[8px] text-tv-text3 mb-1">
            <span>{isFi ? "Päiväraja" : "Daily limit"} −{config.MAX_DAILY_LOSS_PCT}%</span>
            <span style={{ color: ds.pnlPct < 0 ? C_DN : C_GRAY }}>
              {ds.pnlPct.toFixed(2)}% / −{config.MAX_DAILY_LOSS_PCT}%
            </span>
          </div>
          <div className="h-1.5 bg-tv-bg3 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(100, Math.max(0, (Math.abs(Math.min(0, ds.pnlPct)) / config.MAX_DAILY_LOSS_PCT) * 100))}%`,
                background: ds.pnlPct < -1.5 ? C_DN : "#f59e0b",
              }} />
          </div>
        </div>
      </div>

      {/* ── Key stats ─────────────────────────────────────────────────────── */}
      <div className="mx-3 mt-2 grid grid-cols-4 gap-1.5">
        <StatChip label={isFi ? "Kaupat" : "Trades"} value={String(ds.trades)} />
        <StatChip
          label="WR"
          value={ds.trades > 0 ? `${winRate.toFixed(0)}%` : "–"}
          valueClass={winRate >= 50 ? "text-tv-green" : winRate > 0 ? "text-amber-500" : "text-tv-text"}
        />
        <StatChip
          label="PF"
          value={pf > 0 ? pf.toFixed(2) : "–"}
          valueClass={pf >= 1.1 ? "text-tv-green" : pf >= 1.0 ? "text-amber-500" : pf > 0 ? "text-tv-red" : "text-tv-text"}
        />
        <StatChip
          label={isFi ? "Putki" : "Streak"}
          value={ds.consecutiveLosses > 0 ? `${ds.consecutiveLosses}L` : ds.wins > 0 ? `${ds.wins}W` : "–"}
          valueClass={ds.consecutiveLosses >= 2 ? "text-tv-red" : "text-tv-text"}
        />
      </div>

      {/* Second row: rolling WR + best/worst */}
      <div className="mx-3 mt-1.5 grid grid-cols-3 gap-1.5">
        <StatChip
          label={isFi ? "L20 WR" : "L20 WR"}
          value={rolling20WR !== null ? `${rolling20WR.toFixed(0)}%` : "–"}
          valueClass={rolling20WR === null ? "text-tv-text"
            : rolling20WR >= 55 ? "text-tv-green"
            : rolling20WR >= 50 ? "text-amber-500"
            : "text-tv-red"}
        />
        <StatChip
          label={isFi ? "Paras" : "Best"}
          value={ds.bestTrade > 0 ? `+${ds.bestTrade.toFixed(2)}%` : "–"}
          valueClass="text-tv-green"
        />
        <StatChip
          label={isFi ? "Huonoin" : "Worst"}
          value={ds.worstTrade < 0 ? `${ds.worstTrade.toFixed(2)}%` : "–"}
          valueClass="text-tv-red"
        />
      </div>

      {/* ── Config info ───────────────────────────────────────────────────── */}
      <div className="mx-3 mt-2 px-2.5 py-2 rounded-lg border border-tv-border bg-tv-bg2 text-[9px] text-tv-text3 space-y-0.5">
        <div className="flex justify-between">
          <span>{isFi ? "Samanaikaiset positiot" : "Max concurrent"}</span>
          <div className="flex items-center gap-1 font-mono text-tv-text">
            <span>{state.openPositions.filter(p => !p.portfolioImport).length}/{config.MAX_POSITIONS}</span>
            {state.openPositions.filter(p => p.portfolioImport).length > 0 && (
              <span style={{ color: "#60a5fa" }}>
                +{state.openPositions.filter(p => p.portfolioImport).length}📦
              </span>
            )}
          </div>
        </div>
        <div className="flex justify-between">
          <span>{isFi ? "Riski/kauppa" : "Risk/trade"}</span>
          <span className="font-mono text-tv-text">{config.RISK_PCT_PER_TRADE}% / max ${config.MAX_TRADE_USDT}</span>
        </div>
        {state.params && (
          <>
            <div className="flex justify-between">
              <span>{isFi ? "Min. signaali" : "Min. signal"}</span>
              <span className="font-mono text-tv-text">{state.params.minSignalScore}+{config.SCORE_BOOST}/13</span>
            </div>
            <div className="flex justify-between">
              <span>SL / TP</span>
              <span className="font-mono text-tv-text">{state.params.stopLossAtrMultiplier}×ATR / {state.params.takeProfitMultiplier}×</span>
            </div>
            {state.params.winRate > 0 && (
              <div className="flex justify-between">
                <span>{isFi ? "Pipeline WR" : "Pipeline WR"}</span>
                <span className={cn("font-mono", state.params.winRate >= 50 ? "text-tv-green" : "text-amber-500")}>
                  {state.params.winRate.toFixed(1)}% / PF {state.params.profitFactor.toFixed(2)}
                </span>
              </div>
            )}
          </>
        )}
        <div className="flex justify-between">
          <span>{isFi ? "Skannausväli" : "Scan interval"}</span>
          <span className="font-mono text-tv-text">{config.SCAN_INTERVAL_MS / 1000}s</span>
        </div>
        {state.lastScanAt && (
          <div className="flex justify-between">
            <span>{isFi ? "Viimeisin skannaus" : "Last scan"}</span>
            <span className="font-mono text-tv-text">{timeStr(state.lastScanAt)}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span>{isFi ? "Sessio" : "Session"}</span>
          <span className={cn(
            "font-mono font-semibold",
            config.isAsiaSession ? "text-amber-400" : "text-tv-green"
          )}>
            {config.isAsiaSession ? "🌙" : "☀"} {config.session}
            {config.isAsiaSession && ` (max $${config.maxTradeUSDT})`}
          </span>
        </div>
      </div>

      {/* ── Open positions ────────────────────────────────────────────────── */}
      <div className="mx-3 mt-3">
        <div className="text-[9px] uppercase tracking-wide text-tv-text3 mb-2">
          {isFi ? "Avoimet positiot" : "Open positions"}
          {state.openPositions.length > 0 && (
            <span className="ml-1.5 text-tv-text font-semibold">{state.openPositions.length}</span>
          )}
        </div>

        {state.openPositions.length === 0 ? (
          <div className="text-center py-4 text-[10px] text-tv-text3">
            {isRunning
              ? (isFi ? "Skannataan signaaleja..." : "Scanning for signals...")
              : (isFi ? "Ei avoimia positioita" : "No open positions")}
          </div>
        ) : (
          <div className="space-y-2">
            {state.openPositions.map(pos => (
              <PositionCard key={pos.id} pos={pos} isFi={isFi} />
            ))}
          </div>
        )}
      </div>

      {/* ── Trade log ─────────────────────────────────────────────────────── */}
      {log.length > 0 && (
        <div className="mx-3 mt-3">
          <div className="text-[9px] uppercase tracking-wide text-tv-text3 mb-1.5">
            {isFi ? "Tämän päivän kaupat" : "Today's trades"}
            <span className="ml-1.5 text-tv-text font-semibold">{log.length}</span>
          </div>
          <div className="border border-tv-border rounded-lg overflow-hidden">
            {[...log].reverse().slice(0, 20).map(trade => (
              <TradeRow key={trade.id} trade={trade} isFi={isFi} />
            ))}
            {log.length > 20 && (
              <div className="text-center text-[9px] text-tv-text3 py-1">
                {log.length - 20} {isFi ? "aiempaa kauppaa" : "earlier trades"}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
