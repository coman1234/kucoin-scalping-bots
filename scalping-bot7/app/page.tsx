"use client";
import React, { useEffect, useState, useCallback } from "react";
import { useTradingContext } from "@/lib/context";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WatchlistPair {
  symbol: string;
  price: number;
  changeRate: number;
  regime: string;
  confidence: number;
  bestPF: number;
  winRate: number;
  trades: number;
}

interface OptimizerStatus {
  running: boolean;
  runId: number;
  pairsDone: number;
  pairsTotal: number;
  currentPair: string;
  nextRunAt: number;
  lastRunDurationMs: number;
  totalOptimizations: number;
  error?: string;
}

interface BalanceInfo {
  usdtAvailable: string;
  usdtTotal: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

function fmtPct(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(2)}%`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function fmtNextRun(ts: number): string {
  if (!ts) return "—";
  const diff = ts - Date.now();
  if (diff <= 0) return "soon";
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function regimeColor(regime: string): string {
  switch (regime?.toLowerCase()) {
    case "trending":    return "text-green-400";
    case "ranging":     return "text-yellow-400";
    case "breakout":    return "text-blue-400";
    case "volatile":    return "text-orange-400";
    default:            return "text-gray-400";
  }
}

function regimeBadge(regime: string): string {
  switch (regime?.toLowerCase()) {
    case "trending":    return "bg-green-900/40 text-green-300 border border-green-700";
    case "ranging":     return "bg-yellow-900/40 text-yellow-300 border border-yellow-700";
    case "breakout":    return "bg-blue-900/40 text-blue-300 border border-blue-700";
    case "volatile":    return "bg-orange-900/40 text-orange-300 border border-orange-700";
    default:            return "bg-gray-800 text-gray-400 border border-gray-700";
  }
}

function confidenceBar(confidence: number): React.ReactNode {
  const pct = Math.min(100, Math.max(0, confidence * 100));
  const color = pct >= 70 ? "bg-green-500" : pct >= 40 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-400">{pct.toFixed(0)}%</span>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TopBar({ balance, credentialsValid, producerAlive }: {
  balance: BalanceInfo | null;
  credentialsValid: boolean;
  producerAlive: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-6 py-3 bg-gray-900 border-b border-gray-800">
      <div className="flex items-center gap-3">
        <span className="text-xl font-bold text-white">🤖 Scalping Bot7</span>
        <span className="text-xs px-2 py-0.5 rounded bg-purple-900/60 text-purple-300 border border-purple-700 font-mono">
          UCB1 Self-Learning
        </span>
        <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700 font-mono">
          v1.0
        </span>
      </div>

      <div className="flex items-center gap-4 text-sm">
        {/* Producer status */}
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${producerAlive ? "bg-green-400 animate-pulse" : "bg-red-500"}`} />
          <span className={producerAlive ? "text-green-400" : "text-red-400"}>
            {producerAlive ? "Producer live" : "Producer down"}
          </span>
        </div>

        {/* Balance */}
        {credentialsValid && balance ? (
          <div className="flex items-center gap-1 text-gray-300">
            <span className="text-gray-500">USDT:</span>
            <span className="font-mono font-semibold text-white">{parseFloat(balance.usdtAvailable).toFixed(2)}</span>
            <span className="text-gray-600">/ {parseFloat(balance.usdtTotal).toFixed(2)}</span>
          </div>
        ) : (
          <span className="text-gray-600 text-xs">{credentialsValid ? "Loading balance…" : "No credentials"}</span>
        )}

        {/* Credentials indicator */}
        <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border ${
          credentialsValid
            ? "bg-green-900/30 text-green-400 border-green-800"
            : "bg-red-900/30 text-red-400 border-red-800"
        }`}>
          {credentialsValid ? "✓ API Ready" : "✗ No API Keys"}
        </div>
      </div>
    </div>
  );
}

function OptimizerCard({ status }: { status: OptimizerStatus | null }) {
  if (!status) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-gray-400 mb-2">UCB1 Optimizer</h2>
        <p className="text-xs text-gray-600">Loading optimizer status…</p>
      </div>
    );
  }

  return (
    <div className={`bg-gray-900 border rounded-lg p-4 ${status.running ? "border-purple-700" : "border-gray-800"}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300">UCB1 Optimizer</h2>
        <span className={`text-xs px-2 py-0.5 rounded border font-mono ${
          status.running
            ? "bg-purple-900/40 text-purple-300 border-purple-700 animate-pulse"
            : "bg-gray-800 text-gray-500 border-gray-700"
        }`}>
          {status.running ? "RUNNING" : "IDLE"}
        </span>
      </div>

      {status.error ? (
        <p className="text-xs text-red-400">{status.error}</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-gray-500 mb-0.5">Run ID</div>
            <div className="font-mono text-gray-200">#{status.runId ?? "—"}</div>
          </div>
          <div>
            <div className="text-gray-500 mb-0.5">Progress</div>
            <div className="font-mono text-gray-200">
              {status.pairsDone ?? 0} / {status.pairsTotal ?? 0}
              {status.pairsTotal > 0 && (
                <span className="text-gray-500 ml-1">
                  ({Math.round((status.pairsDone / status.pairsTotal) * 100)}%)
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-gray-500 mb-0.5">Current Pair</div>
            <div className="font-mono text-purple-300">{status.currentPair || "—"}</div>
          </div>
          <div>
            <div className="text-gray-500 mb-0.5">Next Run</div>
            <div className="font-mono text-gray-200">{fmtNextRun(status.nextRunAt)}</div>
          </div>
          <div>
            <div className="text-gray-500 mb-0.5">Last Duration</div>
            <div className="font-mono text-gray-200">
              {status.lastRunDurationMs ? fmtDuration(status.lastRunDurationMs) : "—"}
            </div>
          </div>
          <div>
            <div className="text-gray-500 mb-0.5">Total Opts</div>
            <div className="font-mono text-gray-200">{status.totalOptimizations ?? 0}</div>
          </div>
        </div>
      )}

      {/* Progress bar */}
      {status.running && status.pairsTotal > 0 && (
        <div className="mt-3 h-1 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-purple-500 rounded-full transition-all duration-500"
            style={{ width: `${Math.round((status.pairsDone / status.pairsTotal) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function WatchlistTable({ pairs, loading }: { pairs: WatchlistPair[]; loading: boolean }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-gray-300">Watchlist — SHM Cache</h2>
        {loading && <span className="text-xs text-gray-600 animate-pulse">Refreshing…</span>}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500">
              <th className="text-left px-4 py-2">Symbol</th>
              <th className="text-right px-4 py-2">Price</th>
              <th className="text-right px-4 py-2">24h</th>
              <th className="text-left px-4 py-2">Regime</th>
              <th className="text-left px-4 py-2">Confidence</th>
              <th className="text-right px-4 py-2">Best PF</th>
              <th className="text-right px-4 py-2">Win Rate</th>
              <th className="text-right px-4 py-2">Trades</th>
            </tr>
          </thead>
          <tbody>
            {pairs.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-8 text-gray-600">
                  {loading ? "Loading watchlist…" : "No data — is the data producer running?"}
                </td>
              </tr>
            ) : (
              pairs.map((p) => (
                <tr key={p.symbol} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-2.5 font-mono font-semibold text-white">{p.symbol}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-gray-200">{fmtPrice(p.price)}</td>
                  <td className={`px-4 py-2.5 text-right font-mono ${p.changeRate >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {fmtPct(p.changeRate)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${regimeBadge(p.regime)}`}>
                      {p.regime || "unknown"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{confidenceBar(p.confidence)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">
                    <span className={p.bestPF >= 1.5 ? "text-green-400" : p.bestPF >= 1 ? "text-yellow-400" : "text-red-400"}>
                      {p.bestPF > 0 ? p.bestPF.toFixed(2) : "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono">
                    <span className={p.winRate >= 0.55 ? "text-green-400" : p.winRate >= 0.45 ? "text-yellow-400" : "text-red-400"}>
                      {p.winRate > 0 ? `${(p.winRate * 100).toFixed(1)}%` : "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-gray-400">{p.trades > 0 ? p.trades : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CredentialsForm({ onSave }: {
  onSave: (key: string, secret: string, pass: string) => void;
}) {
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [pass, setPass] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (key && secret && pass) onSave(key, secret, pass);
  }

  return (
    <div className="bg-gray-900 border border-yellow-800 rounded-lg p-6 max-w-md">
      <h2 className="text-base font-semibold text-yellow-300 mb-1">KuCoin API Credentials</h2>
      <p className="text-xs text-gray-500 mb-4">
        Required for balance and order placement. Credentials are stored only in your browser&apos;s localStorage.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">API Key</label>
          <input
            type="text"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="Your KuCoin API key"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-yellow-600"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">API Secret</label>
          <input
            type="password"
            value={secret}
            onChange={e => setSecret(e.target.value)}
            placeholder="Your KuCoin API secret"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-yellow-600"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Passphrase</label>
          <input
            type="password"
            value={pass}
            onChange={e => setPass(e.target.value)}
            placeholder="Your KuCoin API passphrase"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-yellow-600"
          />
        </div>
        <button
          type="submit"
          disabled={!key || !secret || !pass}
          className="w-full py-2 px-4 bg-yellow-700 hover:bg-yellow-600 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold rounded transition-colors"
        >
          Save Credentials
        </button>
      </form>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { apiKey, setApiKey, apiSecret, setApiSecret, passphrase, setPassphrase, credentialsValid } =
    useTradingContext();

  const [watchlist, setWatchlist] = useState<WatchlistPair[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [optimizerStatus, setOptimizerStatus] = useState<OptimizerStatus | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [producerAlive, setProducerAlive] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // ── Fetch watchlist ────────────────────────────────────────────────────────
  const fetchWatchlist = useCallback(async () => {
    setWatchlistLoading(true);
    try {
      const res = await fetch("/api/trading/watchlist");
      if (res.ok) {
        const data = await res.json() as { pairs: WatchlistPair[]; producerAlive: boolean };
        setWatchlist(data.pairs ?? []);
        setProducerAlive(data.producerAlive ?? false);
        setLastUpdate(new Date());
      }
    } catch { /* silently ignore */ }
    finally { setWatchlistLoading(false); }
  }, []);

  // ── Fetch optimizer status ─────────────────────────────────────────────────
  const fetchOptimizer = useCallback(async () => {
    try {
      const res = await fetch("/api/trading/optimizer");
      if (res.ok) {
        const data = await res.json() as OptimizerStatus;
        setOptimizerStatus(data);
      }
    } catch { /* silently ignore */ }
  }, []);

  // ── Fetch balance ──────────────────────────────────────────────────────────
  const fetchBalance = useCallback(async () => {
    if (!credentialsValid) return;
    try {
      const res = await fetch("/api/trading/balance");
      if (res.ok) {
        const data = await res.json() as { accounts: Array<{ currency: string; type: string; available: string; balance: string }> };
        const usdt = (data.accounts ?? []).find(a => a.currency === "USDT" && a.type === "trade");
        if (usdt) {
          setBalance({ usdtAvailable: usdt.available, usdtTotal: usdt.balance });
        }
      }
    } catch { /* silently ignore */ }
  }, [credentialsValid]);

  // ── Initial load ───────────────────────────────────────────────────────────
  useEffect(() => {
    fetchWatchlist();
    fetchOptimizer();
  }, [fetchWatchlist, fetchOptimizer]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  // ── Polling every 5s ───────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      fetchWatchlist();
      fetchOptimizer();
    }, 5_000);
    return () => clearInterval(id);
  }, [fetchWatchlist, fetchOptimizer]);

  useEffect(() => {
    if (!credentialsValid) return;
    const id = setInterval(fetchBalance, 30_000);
    return () => clearInterval(id);
  }, [credentialsValid, fetchBalance]);

  // ── Save credentials ───────────────────────────────────────────────────────
  function handleSaveCredentials(key: string, secret: string, pass: string) {
    setApiKey(key);
    setApiSecret(secret);
    setPassphrase(pass);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      <TopBar balance={balance} credentialsValid={credentialsValid} producerAlive={producerAlive} />

      <main className="flex-1 p-4 sm:p-6 space-y-4 max-w-screen-2xl mx-auto w-full">

        {/* Status bar */}
        <div className="flex items-center justify-between text-xs text-gray-600">
          <span>
            Data source: <span className="text-gray-400">SHM cache (/dev/shm)</span>
            {" "}·{" "}
            Polling: <span className="text-gray-400">5s</span>
          </span>
          {lastUpdate && (
            <span>Last update: <span className="text-gray-400">{lastUpdate.toLocaleTimeString()}</span></span>
          )}
        </div>

        {/* Optimizer status */}
        <OptimizerCard status={optimizerStatus} />

        {/* Watchlist */}
        <WatchlistTable pairs={watchlist} loading={watchlistLoading} />

        {/* Credentials setup if not configured */}
        {!credentialsValid && (
          <div>
            <div className="mb-3 flex items-center gap-2">
              <div className="h-px flex-1 bg-gray-800" />
              <span className="text-xs text-gray-600">Optional: Configure API for balance & trading</span>
              <div className="h-px flex-1 bg-gray-800" />
            </div>
            <CredentialsForm onSave={handleSaveCredentials} />
          </div>
        )}

        {/* Footer */}
        <div className="text-xs text-gray-700 text-center pt-4 border-t border-gray-900">
          Scalping Bot7 · UCB1 Self-Learning · Port 3001 · Reads SHM only · Never calls KuCoin directly
          {apiKey && <span className="ml-2 text-gray-800">· API key: {apiKey.slice(0, 6)}…</span>}
        </div>
      </main>
    </div>
  );
}
