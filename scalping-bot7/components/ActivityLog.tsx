"use client";

/**
 * ActivityLog — collapsible panel showing all bot/trade/optimizer events.
 * Pulls from /api/trading/activity-log (server-side JSON file).
 * Features: live-refresh every 15 s, severity filter, symbol filter, CSV export.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { fetchActivityLog, clearActivityLog, type ActivityEntry, type ActivitySeverity, type ActivityType } from "@/lib/activityLog";
import { useTradingContext } from "@/lib/context";
import { useT } from "@/components/SettingsModal";

const REFRESH_MS = 15_000;

const SEV_STYLE: Record<ActivitySeverity, string> = {
  info:    "text-tv-text2",
  success: "text-tv-green",
  warning: "text-tv-amber",
  error:   "text-tv-red",
};

const SEV_BADGE: Record<ActivitySeverity, string> = {
  info:    "bg-tv-bg3 text-tv-text2",
  success: "bg-tv-green/15 text-tv-green",
  warning: "bg-tv-amber/15 text-tv-amber",
  error:   "bg-tv-red/15 text-tv-red",
};

const TYPE_ICON: Partial<Record<ActivityType, string>> = {
  BOT_START:      "▶",
  BOT_STOP:       "⏹",
  EMERGENCY_STOP: "🔴",
  TRADE_OPEN:     "📈",
  TRADE_CLOSE:    "💰",
  TRADE_TP1:      "✅",
  SIGNAL:         "🔍",
  BACKTEST:       "📊",
  BATCH_SCAN:     "🗂",
  OPTIMIZER:      "🔬",
  SETTINGS:       "⚙️",
  CONNECTION:     "🔗",
  WARNING:        "⚠️",
  ERROR:          "❌",
  SYSTEM:         "🖥",
};

const ALL_SEVERITIES: ActivitySeverity[] = ["info", "success", "warning", "error"];

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString([], { month: "2-digit", day: "2-digit" });
}

function entryToCSV(e: ActivityEntry): string {
  const esc = (s?: string) => `"${(s ?? "").replace(/"/g, '""')}"`;
  return [
    new Date(e.timestamp).toISOString(),
    e.type, e.severity,
    esc(e.title),
    esc(e.detail),
    e.symbol ?? "",
    e.value != null ? e.value.toString() : "",
  ].join(",");
}

export default function ActivityLog() {
  const { language } = useTradingContext();
  const t   = useT();
  const isFi = language === "fi";

  const [open,     setOpen]     = useState(false);
  const [entries,  setEntries]  = useState<ActivityEntry[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [logDir,   setLogDir]   = useState<string>("");
  const [sevFilter,setSevFilter]= useState<Set<ActivitySeverity>>(new Set(ALL_SEVERITIES));
  const [typeFilter,setTypeFilter] = useState<ActivityType | "ALL">("ALL");
  const [symFilter, setSymFilter]  = useState("");
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [lastRefresh, setLastRefresh] = useState(0);
  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  // FIX: preserve scroll position across refreshes
  const listRef       = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // FIX: save scroll position before update
    const savedScroll = listRef.current?.scrollTop ?? 0;
    try {
      const res  = await fetch("/api/trading/activity-log?limit=500");
      const data = await res.json() as { entries: ActivityEntry[]; logDir?: string };
      setEntries(data.entries ?? []);
      if (data.logDir) setLogDir(data.logDir);
      setLastRefresh(Date.now());
    } finally {
      setLoading(false);
      // FIX: restore scroll position after React re-renders
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = savedScroll;
      });
    }
  }, []);

  // Auto-refresh while panel is open
  useEffect(() => {
    if (open) {
      load();
      intervalRef.current = setInterval(load, REFRESH_MS);
    } else {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [open, load]);

  const toggleSev = (s: ActivitySeverity) => {
    setSevFilter(prev => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  // FIX: memoize — don't recompute on every render
  const filtered = useMemo(() => entries.filter(e => {
    if (!sevFilter.has(e.severity)) return false;
    if (typeFilter !== "ALL" && e.type !== typeFilter) return false;
    if (symFilter && !(e.symbol ?? "").toLowerCase().includes(symFilter.toLowerCase())) return false;
    return true;
  }), [entries, sevFilter, typeFilter, symFilter]);

  const handleClear = async () => {
    if (!confirm(isFi ? "Tyhjennä koko loki?" : "Clear the entire log?")) return;
    await clearActivityLog();
    setEntries([]);
  };

  const exportCSV = () => {
    const header = "timestamp,type,severity,title,detail,symbol,value";
    const rows   = filtered.map(entryToCSV).join("\n");
    const blob   = new Blob([header + "\n" + rows], { type: "text/csv" });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement("a");
    a.href       = url;
    a.download   = `activity-log-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // FIX: memoize — both are expensive scans over all entries
  const presentTypes = useMemo(
    () => Array.from(new Set(entries.map(e => e.type))).sort(),
    [entries],
  );

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, success: 0, info: 0 } as Record<ActivitySeverity, number>;
    for (const e of entries) c[e.severity]++;
    return c;
  }, [entries]);

  return (
    <div className="panel border-l-2 border-tv-blue">

      {/* ── Header ── */}
      <button onClick={() => setOpen(v => !v)} className="w-full flex items-center justify-between">
        <span className="text-sm font-semibold text-tv-text uppercase tracking-wide flex items-center gap-2 flex-wrap">
          🖥 {isFi ? "Toimintaloki" : "Activity Log"}
          {entries.length > 0 && (
            <span className="text-[9px] bg-tv-blue/20 text-tv-blue px-1.5 py-0.5 rounded font-semibold normal-case">
              {entries.length}
            </span>
          )}
          {counts.error > 0 && (
            <span className="text-[9px] bg-tv-red/20 text-tv-red px-1.5 py-0.5 rounded font-semibold normal-case">
              {counts.error} {isFi ? "virh." : "err"}
            </span>
          )}
          {counts.warning > 0 && (
            <span className="text-[9px] bg-tv-amber/20 text-tv-amber px-1.5 py-0.5 rounded font-semibold normal-case">
              {counts.warning} {isFi ? "varoit." : "warn"}
            </span>
          )}
          {loading && (
            <span className="text-[9px] bg-tv-bg3 text-tv-text3 px-1.5 py-0.5 rounded animate-pulse normal-case">
              {isFi ? "ladataan…" : "loading…"}
            </span>
          )}
        </span>
        <span className="text-tv-text2 text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-2">

          {/* ── Filter bar ── */}
          <div className="flex flex-wrap gap-1.5 items-center">

            {/* Severity toggles */}
            {ALL_SEVERITIES.map(s => (
              <button key={s}
                onClick={() => toggleSev(s)}
                className={cn("text-[9px] px-1.5 py-0.5 rounded font-semibold border transition-colors uppercase",
                  sevFilter.has(s) ? SEV_BADGE[s] + " border-transparent" : "bg-tv-bg3 text-tv-text3 border-tv-border opacity-50")}>
                {s}
                {counts[s] > 0 && ` (${counts[s]})`}
              </button>
            ))}

            {/* Type filter */}
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value as ActivityType | "ALL")}
              className="text-[9px] bg-tv-bg2 border border-tv-border rounded px-1 py-0.5 text-tv-text2">
              <option value="ALL">{isFi ? "Kaikki tyypit" : "All types"}</option>
              {presentTypes.map(tp => (
                <option key={tp} value={tp}>{TYPE_ICON[tp] ?? ""} {tp}</option>
              ))}
            </select>

            {/* Symbol filter */}
            <input
              type="text"
              placeholder={isFi ? "Symboli…" : "Symbol…"}
              value={symFilter}
              onChange={e => setSymFilter(e.target.value)}
              className="text-[9px] bg-tv-bg2 border border-tv-border rounded px-1.5 py-0.5 text-tv-text w-20" />

            {/* Refresh */}
            <button onClick={load}
              className="text-[9px] px-1.5 py-0.5 rounded border border-tv-border bg-tv-bg3 text-tv-text2 hover:text-tv-text">
              ↻
            </button>

            {/* Export */}
            <button onClick={exportCSV}
              className="text-[9px] px-1.5 py-0.5 rounded border border-tv-border bg-tv-bg3 text-tv-text2 hover:text-tv-text">
              {isFi ? "Vie CSV" : "Export CSV"}
            </button>

            {/* Clear */}
            <button onClick={handleClear}
              className="text-[9px] px-1.5 py-0.5 rounded border border-tv-red/30 bg-tv-red/10 text-tv-red hover:bg-tv-red/20">
              {isFi ? "Tyhjennä" : "Clear"}
            </button>

            {/* Last refresh */}
            {lastRefresh > 0 && (
              <span className="text-[9px] text-tv-text3 ml-auto">
                {isFi ? "Päivitetty" : "Refreshed"} {fmtTime(lastRefresh)}
              </span>
            )}
          </div>

          {/* ── Entry list ── */}
          {filtered.length === 0 ? (
            <div className="text-xs text-tv-text2 py-4 text-center">
              {entries.length === 0
                ? (isFi ? "Ei tapahtumia vielä." : "No entries yet.")
                : (isFi ? "Ei tuloksia suodattimilla." : "No entries match filters.")}
            </div>
          ) : (
            <div ref={listRef} className="space-y-0.5 max-h-72 overflow-y-auto pr-0.5">
              {filtered.map(e => {
                const isExpanded = expanded.has(e.id);
                const hasMeta    = !!(e.detail || e.symbol || e.value != null);
                return (
                  <div key={e.id}
                    onClick={() => hasMeta && toggleExpand(e.id)}
                    className={cn(
                      "rounded px-2 py-1.5 text-[10px] border",
                      SEV_BADGE[e.severity],
                      hasMeta ? "cursor-pointer hover:opacity-90" : "",
                      e.severity === "error"   ? "border-tv-red/20"   :
                      e.severity === "warning" ? "border-tv-amber/20" :
                      e.severity === "success" ? "border-tv-green/20" :
                                                 "border-tv-border",
                    )}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <span className="flex-shrink-0">{TYPE_ICON[e.type] ?? "·"}</span>
                        <span className={cn("font-semibold truncate", SEV_STYLE[e.severity])}>
                          {e.title}
                        </span>
                        {e.symbol && (
                          <span className="flex-shrink-0 text-tv-text3 font-mono">{e.symbol}</span>
                        )}
                        {e.value != null && (
                          <span className={cn("flex-shrink-0 font-mono font-semibold", e.value >= 0 ? "text-tv-green" : "text-tv-red")}>
                            {e.value >= 0 ? "+" : ""}{e.value.toFixed(2)}
                          </span>
                        )}
                      </div>
                      <div className="flex-shrink-0 text-right text-tv-text3 whitespace-nowrap">
                        <span className="hidden sm:inline">{fmtDate(e.timestamp)} </span>
                        {fmtTime(e.timestamp)}
                        {hasMeta && <span className="ml-1">{isExpanded ? "▴" : "▾"}</span>}
                      </div>
                    </div>

                    {isExpanded && e.detail && (
                      <div className="mt-1 pt-1 border-t border-current/10 text-[9px] text-tv-text2 break-words">
                        {e.detail}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Footer: count + log file path ── */}
          <div className="space-y-1">
            <div className="text-[9px] text-tv-text3 text-right">
              {filtered.length} / {entries.length} {isFi ? "tapahtumaa" : "entries"}
              {" · "}{isFi ? "päivittyy 15 s välein" : "auto-refresh every 15 s"}
            </div>
            {logDir && (
              <div className="rounded border border-tv-border bg-tv-bg2 px-2 py-1.5 flex items-start gap-1.5">
                <span className="text-[9px] text-tv-text3 flex-shrink-0 mt-0.5">📁</span>
                <div className="min-w-0">
                  <div className="text-[9px] font-semibold text-tv-text2">
                    {isFi ? "Lokitiedostot tallennetaan:" : "Log files written to:"}
                  </div>
                  <div className="text-[9px] font-mono text-tv-blue break-all">{logDir}</div>
                  <div className="text-[9px] text-tv-text3 mt-0.5">
                    {isFi
                      ? "Tiedoston nimi: scalping-bot-YYYY-MM-DD.log · Seuraa: tail -f scalping-bot-*.log"
                      : "File: scalping-bot-YYYY-MM-DD.log · Watch live: tail -f scalping-bot-*.log"}
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
