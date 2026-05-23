"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTradingContext } from "@/lib/context";
import { cn } from "@/lib/utils";

// Type mirrors PipelineState from lib/serverPipeline — kept client-side to avoid
// importing the server-only fs module into the browser bundle.
interface PipelineState {
  phase:       "idle" | "optimizing" | "validating" | "confirming" | "ready" | "error";
  step:        0 | 1 | 2 | 3 | 4;
  progress:    number;
  message:     string;
  startedAt:   number | null;
  completedAt: number | null;
  nextRunAt:   number | null;
  bestParams: {
    minSignalScore:          number;
    stopLossAtrMultiplier:   number;
    takeProfitMultiplier:    number;
    rsiOversoldThreshold:    number;
    rsiOverboughtThreshold:  number;
    volumeMultiplier:        number;
    winRate:                 number;   // in-sample WR — use backtestResult.winRate for OOS!
    profitFactor:            number;
    totalTrades:             number;
    pairsWithTarget:         number;
  } | null;
  backtestResult: {
    profitFactor: number;
    winRate:      number;   // OOS confirmed WR — the real number to show the user
    totalTrades:  number;
    validated:    boolean;
  } | null;
  pairStatuses: Record<string, "loading" | "ok" | "error" | "idle">;
  lastError:    string | null;
}

// WR history entry stored in localStorage
interface WRHistoryEntry {
  ts:          number;
  wr:          number;
  pf:          number;
  trades:      number;
  validated:   boolean;
}

const HISTORY_KEY    = "pipeline_wr_history";
const MAX_HISTORY    = 10;
const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS   = 30_000;
// Data window constants (must match lib/serverPipeline.ts)
const FETCH_DAYS     = 42;
const IN_PCT         = 60;
const VAL_PCT        = 20;
const CONFIRM_PCT    = 20;

const STEPS = [
  {
    num: 1 as const,
    icon: "🔬",
    labelEn: "OPTIMIZE",
    labelFi: "OPTIMOI",
    descEn: "20 pairs · 108 combos",
    descFi: "20 paria · 108 yhdistelmää",
    phase: "optimizing",
  },
  {
    num: 2 as const,
    icon: "🔍",
    labelEn: "VALIDATE",
    labelFi: "VALIDOI",
    descEn: "OOS cross-pair check",
    descFi: "OOS monipari-tarkistus",
    phase: "validating",
  },
  {
    num: 3 as const,
    icon: "📊",
    labelEn: "CONFIRM",
    labelFi: "VAHVISTA",
    descEn: "PF ≥ 1.05 gate",
    descFi: "PF ≥ 1.05 portti",
    phase: "confirming",
  },
  {
    num: 4 as const,
    icon: "🖥",
    labelEn: "MONITOR",
    labelFi: "SEURAA",
    descEn: "Trading active",
    descFi: "Kaupankäynti aktiivinen",
    phase: "ready",
  },
] as const;

function formatCountdown(ms: number, isFi: boolean): string {
  if (ms <= 0) return isFi ? "nyt" : "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatETR(startedAt: number | null, progress: number, isFi: boolean): string | null {
  if (!startedAt || progress <= 2) return null;
  const elapsed   = Date.now() - startedAt;
  const totalEst  = (elapsed / progress) * 100;
  const remaining = totalEst - elapsed;
  if (remaining <= 0) return null;
  const m = Math.floor(remaining / 60_000);
  const s = Math.floor((remaining % 60_000) / 1_000);
  const label = isFi ? "jäljellä" : "left";
  if (m > 0) return `~${m}m ${s}s ${label}`;
  return `~${s}s ${label}`;
}

function formatDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function loadHistory(): WRHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as WRHistoryEntry[];
  } catch { return []; }
}

function saveHistory(entries: WRHistoryEntry[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries)); } catch { /* ignore */ }
}

// ── Inline sparkline SVG ──────────────────────────────────────────────────────
function Sparkline({ data, width = 80, height = 24 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) return null;
  const min  = Math.min(...data, 45);
  const max  = Math.max(...data, 55);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (width - 2) + 1;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = data[data.length - 1];
  const col  = last >= 50 ? "#00d47e" : "#ff3355";
  return (
    <svg width={width} height={height} className="flex-shrink-0">
      <polyline points={pts.join(" ")} fill="none" stroke={col} strokeWidth="1.5" strokeLinejoin="round" />
      {/* 50% reference line */}
      <line
        x1="0" y1={(height - 2 - ((50 - min) / range) * (height - 4)).toFixed(1)}
        x2={width} y2={(height - 2 - ((50 - min) / range) * (height - 4)).toFixed(1)}
        stroke="#8888b030" strokeWidth="1" strokeDasharray="2,2"
      />
    </svg>
  );
}

export default function PipelineStatus() {
  const { language } = useTradingContext();
  const isFi = language === "fi";

  const [pipeState, setPipeState] = useState<PipelineState | null>(null);
  const [now,       setNow]       = useState(() => Date.now());
  const [history,   setHistory]   = useState<WRHistoryEntry[]>([]);
  const [showParams, setShowParams] = useState(false);

  // Track last completed run so we don't double-append to history
  const lastCompletedAt = useRef<number | null>(null);

  // Load history from localStorage on mount
  useEffect(() => { setHistory(loadHistory()); }, []);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/trading/pipeline");
      if (res.ok) {
        const data = await res.json() as PipelineState;
        setPipeState(data);

        // Append to WR history when a new run completes
        if (
          data.phase === "ready" &&
          data.backtestResult &&
          data.completedAt &&
          data.completedAt !== lastCompletedAt.current
        ) {
          lastCompletedAt.current = data.completedAt;
          setHistory(prev => {
            const entry: WRHistoryEntry = {
              ts:        data.completedAt!,
              wr:        data.backtestResult!.winRate,
              pf:        data.backtestResult!.profitFactor,
              trades:    data.backtestResult!.totalTrades,
              validated: data.backtestResult!.validated,
            };
            // Avoid duplicate entries for the same run
            if (prev.length > 0 && prev[prev.length - 1].ts === entry.ts) return prev;
            const next = [...prev, entry].slice(-MAX_HISTORY);
            saveHistory(next);
            return next;
          });
        }
      }
    } catch { /* ignore */ }
  }, []);

  // Polling — faster while active
  useEffect(() => {
    fetchState();
    const active = pipeState?.phase === "optimizing" ||
                   pipeState?.phase === "validating"  ||
                   pipeState?.phase === "confirming";
    const interval = setInterval(fetchState, active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeState?.phase]);

  // Tick every second for smooth countdowns and ETR
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const handleRestart = async () => {
    try {
      await fetch("/api/trading/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      fetchState();
    } catch { /* ignore */ }
  };

  if (!pipeState) {
    return (
      <div className="bg-tv-bg2 border border-tv-border rounded p-3 text-xs text-tv-text3 text-center animate-pulse">
        {isFi ? "Ladataan pipeline-tilaa..." : "Loading pipeline state..."}
      </div>
    );
  }

  const currentStep = pipeState.step;
  const phase       = pipeState.phase;
  const oosWR       = pipeState.backtestResult?.winRate   ?? 0;
  const oosPF       = pipeState.backtestResult?.profitFactor ?? 0;
  const wrGood      = oosWR >= 50;
  const pfGood      = oosPF >= 1.0;
  const bothGood    = wrGood && pfGood;

  return (
    <div className="space-y-2">

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-tv-text">
            🤖 {isFi ? "Automaattinen optimoija" : "Auto-Optimizer"}
          </div>
          <div className="text-[9px] text-tv-text3 mt-0.5">
            {isFi
              ? `${FETCH_DAYS}pv data · ${IN_PCT}/${VAL_PCT}/${CONFIRM_PCT}% split · 6h välein`
              : `${FETCH_DAYS}d data · ${IN_PCT}/${VAL_PCT}/${CONFIRM_PCT}% split · every 6h`}
          </div>
        </div>
        {(phase === "idle" || phase === "error" || phase === "ready") && (
          <button
            onClick={handleRestart}
            className="text-[9px] px-2 py-1 rounded bg-tv-bg2 border border-tv-border text-tv-text2 hover:bg-tv-bg3 transition-colors flex-shrink-0"
          >
            {isFi ? "▶ Aja nyt" : "▶ Run now"}
          </button>
        )}
      </div>

      {/* ── Step indicators ──────────────────────────────────────────────────── */}
      <div className="flex items-stretch gap-0.5 text-[9px] font-bold uppercase tracking-wide">
        {STEPS.map((s, i) => {
          const isDone   = currentStep > s.num;
          const isActive = phase === s.phase || (s.num === 4 && phase === "ready");
          const isPulse  = phase === s.phase && phase !== "ready";

          return (
            <div key={s.num} className="flex items-center flex-1 min-w-0">
              <div className={cn(
                "flex-1 flex flex-col items-center justify-center gap-0.5 px-1 py-1.5 rounded border",
                isDone
                  ? "bg-tv-green/10 border-tv-green/30 text-tv-green"
                  : isActive
                    ? "bg-tv-purple/10 border-tv-purple/30 text-tv-purple"
                    : "bg-tv-bg2 border-tv-border text-tv-text3"
              )}>
                <span className={cn("whitespace-nowrap", isPulse && "animate-pulse")}>
                  {s.icon} {isFi ? s.labelFi : s.labelEn}
                </span>
                <span className="text-[8px] font-normal opacity-70 text-center leading-tight">
                  {isFi ? s.descFi : s.descEn}
                </span>
                {isDone && <span className="text-[9px] font-bold text-tv-green">✓</span>}
              </div>
              {i < STEPS.length - 1 && (
                <span className="text-tv-text3 text-[10px] px-0.5 flex-shrink-0">›</span>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Progress bar (while active) ──────────────────────────────────────── */}
      {(phase === "optimizing" || phase === "validating" || phase === "confirming") && (
        <div className="space-y-1">
          <div className="flex justify-between text-[9px] text-tv-text3">
            <span className="truncate mr-1">{pipeState.message}</span>
            <span className="flex items-center gap-1.5 flex-shrink-0">
              {formatETR(pipeState.startedAt, pipeState.progress, isFi) && (
                <span className="text-tv-text3 opacity-60">
                  {formatETR(pipeState.startedAt, pipeState.progress, isFi)}
                </span>
              )}
              <span className="font-mono font-semibold text-tv-purple">{pipeState.progress}%</span>
            </span>
          </div>
          <div className="h-1.5 bg-tv-bg3 rounded overflow-hidden">
            <div
              className="h-full bg-tv-purple rounded transition-all duration-500"
              style={{ width: `${pipeState.progress}%` }}
            />
          </div>
          {/* Pair statuses */}
          <div className="flex flex-wrap gap-0.5 mt-0.5">
            {Object.entries(pipeState.pairStatuses).map(([sym, status]) => (
              <span key={sym} className={cn(
                "text-[7px] px-1 py-0.5 rounded",
                status === "ok"      && "bg-tv-green/10 text-tv-green",
                status === "loading" && "bg-tv-purple/10 text-tv-purple animate-pulse",
                status === "error"   && "bg-tv-red/10 text-tv-red",
                status === "idle"    && "bg-tv-bg3 text-tv-text3",
              )}>
                {sym.replace("-USDT", "")}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Ready banner with OOS results ────────────────────────────────────── */}
      {phase === "ready" && pipeState.backtestResult && (
        <div className={cn(
          "rounded border px-2.5 py-2 space-y-1.5",
          bothGood
            ? "bg-tv-green/10 border-tv-green/30"
            : "bg-amber-500/10 border-amber-500/30"
        )}>
          {/* Headline row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-base">{bothGood ? "✅" : "⚠️"}</span>
              <div>
                <div className={cn("text-[10px] font-semibold", bothGood ? "text-tv-green" : "text-amber-600")}>
                  {isFi ? "OOS-vahvistettu tulos" : "OOS confirmed result"}
                </div>
                <div className="text-[8px] text-tv-text3 mt-0.5">
                  {isFi ? "Vahvistusikkuna:" : "Confirm window:"}
                  {" "}{(FETCH_DAYS * CONFIRM_PCT / 100).toFixed(1)}{isFi ? " pv" : " days"}
                  {" · "}{pipeState.backtestResult.totalTrades} {isFi ? "kauppaa" : "trades"}
                </div>
              </div>
            </div>
            <button
              onClick={() => setShowParams(p => !p)}
              className="text-[8px] text-tv-text3 hover:text-tv-text transition-colors px-1"
              title={isFi ? "Näytä parametrit" : "Show parameters"}
            >
              {showParams ? "▲" : "▼"} {isFi ? "parametrit" : "params"}
            </button>
          </div>

          {/* Big metrics row */}
          <div className="grid grid-cols-3 gap-1.5">
            <div className={cn(
              "rounded px-2 py-1.5 text-center",
              wrGood ? "bg-tv-green/15" : "bg-tv-red/10"
            )}>
              <div className={cn("text-[18px] font-bold font-mono leading-none", wrGood ? "text-tv-green" : "text-tv-red")}>
                {oosWR.toFixed(1)}%
              </div>
              <div className="text-[8px] text-tv-text3 mt-0.5">
                {isFi ? "Voittosuhde" : "Win Rate"}
              </div>
              <div className={cn("text-[8px] font-semibold mt-0.5", wrGood ? "text-tv-green" : "text-tv-red")}>
                {wrGood ? "✓ ≥50%" : "✗ <50%"}
              </div>
            </div>
            <div className={cn(
              "rounded px-2 py-1.5 text-center",
              pfGood ? "bg-tv-green/15" : "bg-tv-red/10"
            )}>
              <div className={cn("text-[18px] font-bold font-mono leading-none", pfGood ? "text-tv-green" : "text-tv-red")}>
                {oosPF.toFixed(2)}
              </div>
              <div className="text-[8px] text-tv-text3 mt-0.5">
                {isFi ? "Tuottokerroin" : "Profit Factor"}
              </div>
              <div className={cn("text-[8px] font-semibold mt-0.5", pfGood ? "text-tv-green" : "text-tv-red")}>
                {pfGood ? "✓ ≥1.0" : "✗ <1.0"}
              </div>
            </div>
            <div className="bg-tv-bg2 rounded px-2 py-1.5 text-center">
              <div className="text-[18px] font-bold font-mono leading-none text-tv-blue">
                {pipeState.bestParams?.pairsWithTarget ?? 0}
                <span className="text-[10px] text-tv-text3">/20</span>
              </div>
              <div className="text-[8px] text-tv-text3 mt-0.5">
                {isFi ? "Paria ≥50% WR" : "Pairs ≥50% WR"}
              </div>
              <div className="text-[8px] text-tv-blue mt-0.5">
                {isFi ? "OOS paria" : "OOS pairs"}
              </div>
            </div>
          </div>

          {/* Collapsible best params */}
          {showParams && pipeState.bestParams && (
            <div className="pt-1 border-t border-tv-border/50">
              <div className="text-[8px] text-tv-text3 mb-1 font-semibold uppercase tracking-wide">
                {isFi ? "Parhaat parametrit" : "Best params"}
              </div>
              <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[9px]">
                <Param l="minScore" v={String(pipeState.bestParams.minSignalScore)} />
                <Param l="SL×" v={pipeState.bestParams.stopLossAtrMultiplier.toFixed(1)} />
                <Param l="TP×" v={pipeState.bestParams.takeProfitMultiplier.toFixed(1)} />
                <Param l="RSI<" v={String(pipeState.bestParams.rsiOversoldThreshold)} />
                <Param l="Vol×" v={pipeState.bestParams.volumeMultiplier.toFixed(1)} />
                <Param l="IS WR" v={`${pipeState.bestParams.winRate.toFixed(0)}%`} note="IS" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── WR History sparkline ─────────────────────────────────────────────── */}
      {history.length >= 2 && (
        <div className="bg-tv-bg2 border border-tv-border rounded px-2.5 py-1.5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[8px] text-tv-text3 uppercase tracking-wide font-semibold">
              {isFi ? `WR-historia (${history.length} ajoa)` : `WR history (${history.length} runs)`}
            </span>
            <span className="text-[8px] text-tv-text3">
              50% <span className="text-tv-text3 opacity-50">— tavoite</span>
            </span>
          </div>
          <div className="flex items-end gap-2">
            <Sparkline data={history.map(h => h.wr)} width={90} height={28} />
            <div className="flex-1 grid grid-cols-3 gap-1">
              {history.slice(-3).map((h, i) => (
                <div key={i} className={cn(
                  "text-center rounded px-1 py-0.5",
                  h.wr >= 50 ? "bg-tv-green/10" : "bg-tv-red/10"
                )}>
                  <div className={cn("text-[9px] font-mono font-bold", h.wr >= 50 ? "text-tv-green" : "text-tv-red")}>
                    {h.wr.toFixed(1)}%
                  </div>
                  <div className="text-[7px] text-tv-text3">
                    PF {h.pf.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Error banner ─────────────────────────────────────────────────────── */}
      {phase === "error" && (
        <div className="flex items-center gap-2 bg-tv-red/10 border border-tv-red/30 rounded px-2.5 py-1.5">
          <span className="text-tv-red text-base flex-shrink-0">❌</span>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] text-tv-red font-semibold">
              {isFi ? "Pipeline epäonnistui" : "Pipeline failed"}
            </div>
            {pipeState.lastError && (
              <div className="text-[9px] text-tv-red/70 mt-0.5 truncate">{pipeState.lastError}</div>
            )}
          </div>
          <button
            onClick={handleRestart}
            className="flex-shrink-0 text-[9px] font-semibold px-2 py-1 rounded bg-tv-red/20 text-tv-red border border-tv-red/30 hover:bg-tv-red/30 transition-colors"
          >
            {isFi ? "Käynnistä uudelleen" : "Restart"}
          </button>
        </div>
      )}

      {/* ── Idle message ─────────────────────────────────────────────────────── */}
      {(phase === "idle") && (
        <div className="flex items-center gap-2 bg-tv-bg2 border border-tv-border rounded px-2.5 py-1.5">
          <span className="text-tv-text3 text-sm flex-shrink-0">⏳</span>
          <div className="text-[10px] text-tv-text2">
            {isFi ? "Pipeline käynnistyy..." : "Pipeline starting..."}
          </div>
        </div>
      )}

      {/* ── Footer: timestamps & next run ────────────────────────────────────── */}
      <div className="flex justify-between text-[8px] text-tv-text3">
        <span>
          {pipeState.completedAt
            ? (isFi ? "Valmistui: " : "Completed: ") + formatDate(pipeState.completedAt)
            : pipeState.startedAt
              ? (isFi ? "Käynnissä: " : "Started: ") + formatDate(pipeState.startedAt)
              : ""}
        </span>
        {pipeState.nextRunAt && (
          <span>
            {isFi ? "Seuraava ajo: " : "Next run: "}
            {pipeState.nextRunAt > now
              ? formatCountdown(pipeState.nextRunAt - now, isFi)
              : (isFi ? "pian" : "soon")}
          </span>
        )}
      </div>

    </div>
  );
}

function Param({ l, v, note }: { l: string; v: string; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="text-tv-text3">{l}</span>
      <span className="font-mono font-semibold text-tv-text">
        {v}
        {note && <span className="text-[7px] text-tv-text3 ml-0.5">{note}</span>}
      </span>
    </div>
  );
}
