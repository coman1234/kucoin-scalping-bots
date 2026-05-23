"use client";

/**
 * DataStorePanel — shows historical candle store coverage + download controls.
 *
 * Polls /api/trading/history-sync every 4 s when a job is running,
 * every 60 s when idle.
 *
 * Layout:
 *   Header row  — total candles, disk size, last sync badge
 *   Action row  — "Full Download (2y)" | "Sync New"
 *   Progress    — only when a job is active
 *   Pair grid   — 20 pairs × coverage days + staleness indicator
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// ── API types (mirrors lib/historicalDataStore.ts + lib/historicalDownloader.ts) ─
interface PairStoreStatus {
  symbol:       string;
  timeframe:    string;
  candleCount:  number;
  firstTs:      number | null;
  lastTs:       number | null;
  coverageDays: number;
  staleDays:    number;
}

interface StoreStatus {
  pairs:        PairStoreStatus[];
  totalCandles: number;
  diskSizeMb:   number;
  lastSyncAt:   number | null;
}

interface DownloadProgress {
  pair:       string;
  pairIndex:  number;
  totalPairs: number;
  status:     "downloading" | "ok" | "error" | "skipped";
  message:    string;
  newCandles: number;
}

interface DownloadState {
  running:    boolean;
  mode:       "full" | "incremental" | null;
  progress:   DownloadProgress | null;
  startedAt:  number | null;
  finishedAt: number | null;
  lastError:  string | null;
  pairsOk:    number;
  pairsErr:   number;
}

interface SyncResponse {
  storeStatus:   StoreStatus;
  downloadState: DownloadState;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function fmtDays(n: number): string {
  if (n >= 365) return `${(n / 365).toFixed(1)}y`;
  return `${Math.round(n)}d`;
}

function staleBadge(staleDays: number): { label: string; cls: string } {
  if (staleDays < 0.2)  return { label: "live",  cls: "bg-emerald-100 text-emerald-700" };
  if (staleDays < 1)    return { label: "<1d",   cls: "bg-emerald-100 text-emerald-700" };
  if (staleDays < 3)    return { label: `${staleDays.toFixed(0)}d`, cls: "bg-amber-100 text-amber-700" };
  if (staleDays < 14)   return { label: `${staleDays.toFixed(0)}d`, cls: "bg-orange-100 text-orange-700" };
  if (staleDays < 999)  return { label: `${staleDays.toFixed(0)}d`, cls: "bg-red-100 text-red-600" };
  return { label: "none", cls: "bg-slate-100 text-slate-500" };
}

function coverageFill(days: number): string {
  const pct = Math.min(days / 730, 1);
  if (pct > 0.8) return "bg-emerald-400";
  if (pct > 0.4) return "bg-amber-400";
  if (pct > 0.1) return "bg-orange-400";
  return "bg-red-400";
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function DataStorePanel() {
  const [data, setData]       = useState<SyncResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = async () => {
    try {
      const r = await fetch("/api/trading/history-sync");
      if (r.ok) { setData(await r.json() as SyncResponse); setErr(null); }
      else      { setErr(`HTTP ${r.status}`); }
    } catch (e) { setErr(String(e)); }
  };

  // Poll every 4 s when running, 60 s when idle
  useEffect(() => {
    void fetchStatus();
    const tick = () => {
      const running = data?.downloadState.running ?? false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => void fetchStatus(), running ? 4_000 : 60_000);
    };
    tick();
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.downloadState.running]);

  const triggerAction = async (action: "full-download" | "sync") => {
    setLoading(true);
    try {
      await fetch("/api/trading/history-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await fetchStatus();
    } finally { setLoading(false); }
  };

  const ds   = data?.downloadState;
  const ss   = data?.storeStatus;
  const running  = ds?.running ?? false;
  const progress = ds?.progress;

  // Progress bar value 0–100
  const progPct = progress
    ? Math.round((progress.pairIndex / Math.max(progress.totalPairs - 1, 1)) * 100)
    : 0;

  return (
    <div className="text-[11px] text-tv-text space-y-2">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="font-bold text-tv-text">📦 Historical Store</span>
          {ss && (
            <span className="text-tv-text3">
              {(ss.totalCandles / 1_000).toFixed(0)}k candles
              {" · "}
              {ss.diskSizeMb < 1
                ? `${(ss.diskSizeMb * 1024).toFixed(0)} KB`
                : `${ss.diskSizeMb.toFixed(1)} MB`}
            </span>
          )}
        </div>
        {ss?.lastSyncAt && (
          <span className="text-tv-text3 text-[10px]">
            synced {fmtDate(ss.lastSyncAt)}
          </span>
        )}
      </div>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {err && (
        <div className="rounded px-2 py-1 bg-red-50 border border-red-200 text-red-600 text-[10px]">
          {err}
        </div>
      )}

      {/* ── Action buttons ─────────────────────────────────────────────────── */}
      <div className="flex gap-1.5">
        <button
          onClick={() => void triggerAction("full-download")}
          disabled={running || loading}
          className={cn(
            "flex-1 rounded px-2 py-1 text-[10px] font-semibold border transition-colors",
            running || loading
              ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed"
              : "bg-tv-blue text-white border-tv-blue hover:bg-blue-700"
          )}
        >
          {running && ds?.mode === "full" ? "⏳ Downloading…" : "⬇ Full Download (2y)"}
        </button>
        <button
          onClick={() => void triggerAction("sync")}
          disabled={running || loading}
          className={cn(
            "flex-1 rounded px-2 py-1 text-[10px] font-semibold border transition-colors",
            running || loading
              ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed"
              : "bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700"
          )}
        >
          {running && ds?.mode === "incremental" ? "⏳ Syncing…" : "↻ Sync New"}
        </button>
      </div>

      {/* ── Progress bar ───────────────────────────────────────────────────── */}
      {running && progress && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-tv-text3">
            <span className={cn(
              "font-medium",
              progress.status === "error"   ? "text-red-500"
            : progress.status === "skipped" ? "text-amber-500"
            : "text-tv-text"
            )}>
              {progress.message}
            </span>
            <span>{progress.pairIndex + 1}/{progress.totalPairs}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
            <div
              className="h-full rounded-full bg-tv-blue transition-all duration-500"
              style={{ width: `${progPct}%` }}
            />
          </div>
          {ds && (
            <div className="flex gap-2 text-[10px] text-tv-text3">
              <span className="text-emerald-600">✓ {ds.pairsOk}</span>
              {ds.pairsErr > 0 && <span className="text-red-500">✗ {ds.pairsErr}</span>}
              {ds.startedAt && (
                <span className="ml-auto">
                  {((Date.now() - ds.startedAt) / 1000).toFixed(0)}s elapsed
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Last job result ─────────────────────────────────────────────────── */}
      {!running && ds?.finishedAt && (
        <div className={cn(
          "rounded px-2 py-1 text-[10px]",
          ds.lastError
            ? "bg-red-50 border border-red-200 text-red-600"
            : "bg-emerald-50 border border-emerald-200 text-emerald-700"
        )}>
          {ds.lastError
            ? `Last job error: ${ds.lastError.slice(0, 100)}`
            : `Last ${ds.mode ?? "job"} complete — ${ds.pairsOk} ok${ds.pairsErr > 0 ? `, ${ds.pairsErr} err` : ""} @ ${fmtDate(ds.finishedAt)}`
          }
        </div>
      )}

      {/* ── Pair coverage grid ───────────────────────────────────────────────── */}
      {ss && ss.pairs.length > 0 && (
        <div className="space-y-0.5">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 text-[9px] font-semibold text-tv-text3 uppercase tracking-wide pb-0.5 border-b border-tv-border">
            <span>Pair</span>
            <span className="text-right">Coverage</span>
            <span className="text-right">Candles</span>
            <span className="text-right">Stale</span>
          </div>
          {ss.pairs.map(p => {
            const stale = staleBadge(p.staleDays);
            const pct   = Math.min((p.coverageDays / 730) * 100, 100);
            return (
              <div key={`${p.symbol}-${p.timeframe}`}
                   className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 items-center py-0.5">
                <div className="flex items-center gap-1 min-w-0">
                  <div className="flex-1 relative h-1 bg-slate-100 rounded-full overflow-hidden max-w-[60px]">
                    <div
                      className={cn("absolute left-0 top-0 h-full rounded-full", coverageFill(p.coverageDays))}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-tv-text truncate leading-none">
                    {p.symbol.replace("-USDT", "")}
                  </span>
                </div>
                <span className="text-right text-[10px] text-tv-text2 tabular-nums">
                  {p.coverageDays > 0 ? fmtDays(p.coverageDays) : "—"}
                </span>
                <span className="text-right text-[10px] text-tv-text3 tabular-nums">
                  {p.candleCount > 0 ? `${(p.candleCount / 1000).toFixed(0)}k` : "0"}
                </span>
                <span className={cn(
                  "text-right text-[9px] font-medium px-1 rounded tabular-nums",
                  stale.cls
                )}>
                  {stale.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {!ss && !err && (
        <div className="text-tv-text3 text-[10px] text-center py-2">Loading store status…</div>
      )}

    </div>
  );
}
