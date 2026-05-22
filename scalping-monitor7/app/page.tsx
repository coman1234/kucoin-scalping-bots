"use client";

import { useEffect, useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OptimizerStatus {
  running?: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  phase?: string;
  progress?: number;
  message?: string;
}

interface ProducerMeta {
  startedAt?: number;
  lastTickAt?: number;
  pairsConnected?: number;
  tickCount?: number;
}

interface RegimeData {
  regime?: string;
  confidence?: number;
  updatedAt?: number;
}

interface MonitorStatus {
  optimizerStatus: OptimizerStatus | null;
  producerMeta: ProducerMeta | null;
  regimes: Record<string, RegimeData | null>;
  timestamp: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAIRS = [
  "BTC-USDT", "ETH-USDT", "SOL-USDT", "BNB-USDT", "DOGE-USDT",
  "XRP-USDT", "ADA-USDT", "AVAX-USDT", "POL-USDT", "DOT-USDT",
  "LINK-USDT", "UNI-USDT", "ATOM-USDT", "LTC-USDT", "BCH-USDT",
  "NEAR-USDT", "FIL-USDT", "APT-USDT", "ARB-USDT", "OP-USDT",
];

const SERVICES = [
  { name: "data-producer",     port: null },
  { name: "kucoin-datalake",   port: 3010 },
  { name: "scalping-bot7",     port: 3001 },
  { name: "scalping-monitor7", port: 3100 },
  { name: "scalping-day7",     port: 3002 },
];

// ── Regime colour mapping ──────────────────────────────────────────────────────

function regimeChip(regime: string | undefined): { label: string; cls: string } {
  switch (regime) {
    case "trending_up":
      return { label: "TREND ↑", cls: "bg-green-700 text-green-100" };
    case "trending_down":
      return { label: "TREND ↓", cls: "bg-red-700 text-red-100" };
    case "ranging":
      return { label: "RANGE", cls: "bg-yellow-600 text-yellow-100" };
    case "volatile":
      return { label: "VOLATILE", cls: "bg-orange-600 text-orange-100" };
    default:
      return { label: regime ?? "—", cls: "bg-gray-700 text-gray-300" };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

function fmtAge(ts: number | undefined): string {
  if (!ts) return "—";
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ServiceRow({ name, port }: { name: string; port: number | null }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-800">
      <span className="text-sm font-mono text-gray-200">{name}</span>
      <div className="flex items-center gap-3">
        {port && (
          <span className="text-xs text-gray-500">:{port}</span>
        )}
        <span className="text-xs text-gray-400">—</span>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
        {title}
      </h2>
      {children}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MonitorPage() {
  const [data, setData] = useState<MonitorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/monitor/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: MonitorStatus = await res.json();
      setData(json);
      setLastFetch(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 10_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const opt = data?.optimizerStatus;
  const prod = data?.producerMeta;
  const regimes = data?.regimes ?? {};

  // Count regime types
  const regimeCounts = PAIRS.reduce<Record<string, number>>((acc, sym) => {
    const r = regimes[sym]?.regime ?? "unknown";
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Monitor7 — System Overview
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Polls every 10s
            {lastFetch && ` · last update ${lastFetch.toLocaleTimeString()}`}
          </p>
        </div>
        <button
          onClick={fetchStatus}
          className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-900/40 border border-red-700 rounded-lg text-sm text-red-300">
          Error: {error}
        </div>
      )}

      {/* Top row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">

        {/* Data Producer */}
        <Card title="Data Producer">
          {prod ? (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Pairs connected</span>
                <span className="font-mono">{prod.pairsConnected ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Tick count</span>
                <span className="font-mono">{prod.tickCount?.toLocaleString() ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Last tick</span>
                <span className="font-mono text-xs">{fmtAge(prod.lastTickAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Started</span>
                <span className="font-mono text-xs">{fmtTime(prod.startedAt)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No data — SHM not available</p>
          )}
        </Card>

        {/* Optimizer */}
        <Card title="Optimizer (Datalake)">
          {opt ? (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Status</span>
                <span className={`font-semibold ${opt.running ? "text-green-400" : "text-gray-400"}`}>
                  {opt.running ? "RUNNING" : opt.phase?.toUpperCase() ?? "IDLE"}
                </span>
              </div>
              {opt.progress !== undefined && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Progress</span>
                  <span className="font-mono">{opt.progress}%</span>
                </div>
              )}
              {opt.message && (
                <div className="text-xs text-gray-400 truncate">{opt.message}</div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-400">Last run</span>
                <span className="text-xs font-mono">{fmtAge(opt.lastRunAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Next run</span>
                <span className="text-xs font-mono">{fmtTime(opt.nextRunAt)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No optimizer data</p>
          )}
        </Card>

        {/* Regime summary */}
        <Card title="Regime Summary (20 pairs)">
          <div className="space-y-1 text-sm">
            {Object.entries(regimeCounts).map(([r, count]) => {
              const chip = regimeChip(r);
              return (
                <div key={r} className="flex items-center justify-between">
                  <span className={`text-xs px-2 py-0.5 rounded font-semibold ${chip.cls}`}>
                    {chip.label}
                  </span>
                  <span className="font-mono text-gray-300">{count}</span>
                </div>
              );
            })}
            {Object.keys(regimeCounts).length === 0 && (
              <p className="text-gray-500">No regime data yet</p>
            )}
          </div>
        </Card>
      </div>

      {/* Services row */}
      <div className="mb-4">
        <Card title="PM2 Services">
          <div className="divide-y divide-gray-800">
            {SERVICES.map((s) => (
              <ServiceRow key={s.name} name={s.name} port={s.port} />
            ))}
          </div>
          <p className="text-xs text-gray-600 mt-2">
            Live PM2 status not available from browser. Use <code className="text-gray-400">./bot.sh status</code> on server.
          </p>
        </Card>
      </div>

      {/* Regime heatmap */}
      <Card title="Regime Heatmap — 20 Pairs">
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2">
          {PAIRS.map((sym) => {
            const rd = regimes[sym];
            const chip = regimeChip(rd?.regime);
            return (
              <div
                key={sym}
                className="bg-gray-800 rounded-lg p-2 flex flex-col gap-1"
              >
                <span className="text-xs font-mono font-bold text-gray-200">
                  {sym.replace("-USDT", "")}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded text-center font-semibold ${chip.cls}`}
                >
                  {chip.label}
                </span>
                {rd?.confidence !== undefined && (
                  <span className="text-xs text-gray-500 text-center">
                    {(rd.confidence * 100).toFixed(0)}%
                  </span>
                )}
                {rd?.updatedAt && (
                  <span className="text-xs text-gray-600 text-center">
                    {fmtAge(rd.updatedAt)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <p className="text-xs text-gray-700 text-center mt-6">
        Monitor7 · bot7 ecosystem · data from /dev/shm
      </p>
    </div>
  );
}
