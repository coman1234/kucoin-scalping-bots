"use client";

import { useEffect, useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PairParams {
  emaFast?: number;
  emaSlow?: number;
  rsiPeriod?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  atrMultiplierSL?: number;
  atrMultiplierTP?: number;
  [key: string]: unknown;
}

interface PairData {
  symbol: string;
  regime: string;
  bestPF: number;
  confidence: number;
  params: PairParams | null;
}

interface DayStatus {
  pairs: PairData[];
  timestamp: number;
}

interface Position {
  symbol: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  size: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  unrealizedPnl?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function regimeColor(regime: string): string {
  switch (regime) {
    case "trending_up":   return "text-green-400";
    case "trending_down": return "text-red-400";
    case "ranging":       return "text-yellow-400";
    case "volatile":      return "text-orange-400";
    default:              return "text-gray-400";
  }
}

function regimeLabel(regime: string): string {
  switch (regime) {
    case "trending_up":   return "TREND ↑";
    case "trending_down": return "TREND ↓";
    case "ranging":       return "RANGE";
    case "volatile":      return "VOLATILE";
    default:              return regime || "—";
  }
}

function regimeBadge(regime: string): string {
  switch (regime) {
    case "trending_up":   return "bg-green-800 text-green-100";
    case "trending_down": return "bg-red-800 text-red-100";
    case "ranging":       return "bg-yellow-700 text-yellow-100";
    case "volatile":      return "bg-orange-700 text-orange-100";
    default:              return "bg-gray-700 text-gray-300";
  }
}

function pfColor(pf: number): string {
  if (pf >= 1.5) return "text-green-400";
  if (pf >= 1.2) return "text-yellow-400";
  return "text-red-400";
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

// ── Trade Confirmation Modal ──────────────────────────────────────────────────

interface ModalProps {
  pair: PairData;
  onClose: () => void;
  onConfirm: (sym: string, dir: "BUY" | "SELL") => void;
}

function TradeModal({ pair, onClose, onConfirm }: ModalProps) {
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-sm shadow-2xl">
        <h2 className="text-lg font-bold mb-1">{pair.symbol}</h2>
        <p className="text-xs text-gray-400 mb-4">
          Regime:{" "}
          <span className={`font-semibold ${regimeColor(pair.regime)}`}>
            {regimeLabel(pair.regime)}
          </span>
          {" · "}
          PF:{" "}
          <span className={pfColor(pair.bestPF)}>{pair.bestPF.toFixed(2)}</span>
        </p>

        {/* Params summary */}
        {pair.params && (
          <div className="mb-4 p-3 bg-gray-800 rounded-lg text-xs font-mono space-y-0.5">
            {Object.entries(pair.params)
              .slice(0, 6)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-gray-400">{k}</span>
                  <span className="text-gray-200">{String(v)}</span>
                </div>
              ))}
          </div>
        )}

        {/* Direction selector */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setDirection("BUY")}
            className={`flex-1 py-2 rounded-lg font-semibold text-sm transition-colors ${
              direction === "BUY"
                ? "bg-green-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            BUY
          </button>
          <button
            onClick={() => setDirection("SELL")}
            className={`flex-1 py-2 rounded-lg font-semibold text-sm transition-colors ${
              direction === "SELL"
                ? "bg-red-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            SELL
          </button>
        </div>

        <p className="text-xs text-yellow-400 mb-4">
          This will submit a live trade order using current best params for this pair.
        </p>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onConfirm(pair.symbol, direction);
              onClose();
            }}
            className={`flex-1 py-2 rounded-lg font-semibold text-sm transition-colors ${
              direction === "BUY"
                ? "bg-green-600 hover:bg-green-500"
                : "bg-red-600 hover:bg-red-500"
            }`}
          >
            Confirm {direction}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Position Row ──────────────────────────────────────────────────────────────

function PositionRow({ pos }: { pos: Position }) {
  const pnl = pos.unrealizedPnl ?? 0;
  return (
    <div className="flex items-center justify-between p-3 bg-gray-800 rounded-lg text-sm">
      <div>
        <span className="font-mono font-bold text-gray-100">{pos.symbol}</span>
        <span
          className={`ml-2 text-xs font-semibold ${
            pos.direction === "BUY" ? "text-green-400" : "text-red-400"
          }`}
        >
          {pos.direction}
        </span>
      </div>
      <div className="text-right">
        <div className={`font-mono font-semibold ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
          {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} USDT
        </div>
        <div className="text-xs text-gray-500">@ {pos.entryPrice}</div>
      </div>
    </div>
  );
}

// ── Pair Card ─────────────────────────────────────────────────────────────────

function PairCard({
  pair,
  onTrade,
}: {
  pair: PairData;
  onTrade: (pair: PairData) => void;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex flex-col gap-2">
      {/* Symbol + regime */}
      <div className="flex items-center justify-between">
        <span className="font-mono font-bold text-sm text-gray-100">
          {pair.symbol.replace("-USDT", "")}
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${regimeBadge(pair.regime)}`}>
          {regimeLabel(pair.regime)}
        </span>
      </div>

      {/* PF + confidence */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">PF</span>
        <span className={`font-mono font-semibold ${pfColor(pair.bestPF)}`}>
          {pair.bestPF > 0 ? pair.bestPF.toFixed(2) : "—"}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">Confidence</span>
        <span className="font-mono text-gray-300">
          {pair.confidence > 0 ? `${(pair.confidence * 100).toFixed(0)}%` : "—"}
        </span>
      </div>

      {/* Key params */}
      {pair.params && (
        <div className="text-xs text-gray-500 font-mono leading-tight">
          {pair.params.emaFast && pair.params.emaSlow && (
            <div>EMA {pair.params.emaFast}/{pair.params.emaSlow}</div>
          )}
          {pair.params.rsiPeriod && (
            <div>
              RSI {pair.params.rsiPeriod} ({pair.params.rsiOversold}/
              {pair.params.rsiOverbought})
            </div>
          )}
        </div>
      )}

      {/* Trade button */}
      <button
        onClick={() => onTrade(pair)}
        className="mt-auto w-full py-1.5 text-xs font-semibold rounded-md bg-indigo-700 hover:bg-indigo-600 transition-colors"
      >
        Trade
      </button>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DayPage() {
  const [status, setStatus] = useState<DayStatus | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [modalPair, setModalPair] = useState<PairData | null>(null);
  const [tradeMsg, setTradeMsg] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, posRes] = await Promise.all([
        fetch("/api/day/status"),
        fetch("/api/day/positions"),
      ]);
      if (statusRes.ok) {
        const j: DayStatus = await statusRes.json();
        setStatus(j);
      }
      if (posRes.ok) {
        const p: Position[] = await posRes.json();
        setPositions(p);
      }
      setLastFetch(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 10_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const handleConfirm = async (sym: string, dir: "BUY" | "SELL") => {
    try {
      const res = await fetch("/api/day/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym, direction: dir }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      const msg =
        data && typeof data === "object" && "message" in data
          ? String((data as Record<string, unknown>).message)
          : "Order submitted";
      setTradeMsg(`${dir} ${sym}: ${msg}`);
      setTimeout(() => setTradeMsg(null), 6000);
      await fetchAll();
    } catch (e) {
      setTradeMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setTradeMsg(null), 6000);
    }
  };

  const pairs = status?.pairs ?? [];

  // Sort: trending first, then by PF desc
  const sorted = [...pairs].sort((a, b) => {
    const regime_order = (r: string) =>
      r === "trending_up" ? 0
      : r === "trending_down" ? 1
      : r === "volatile" ? 2
      : 3;
    const ro = regime_order(a.regime) - regime_order(b.regime);
    if (ro !== 0) return ro;
    return b.bestPF - a.bestPF;
  });

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            DayTrader7 — Regime-Aware Positions
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Polls every 10s
            {lastFetch && ` · last update ${lastFetch.toLocaleTimeString()}`}
          </p>
        </div>
        <button
          onClick={fetchAll}
          className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-900/40 border border-red-700 rounded-lg text-sm text-red-300">
          Error: {error}
        </div>
      )}

      {/* Trade message */}
      {tradeMsg && (
        <div className="mb-4 p-3 bg-indigo-900/50 border border-indigo-700 rounded-lg text-sm text-indigo-200">
          {tradeMsg}
        </div>
      )}

      {/* Open Positions */}
      {positions.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
            Open Positions ({positions.length})
          </h2>
          <div className="space-y-2">
            {positions.map((p) => (
              <PositionRow key={p.symbol} pos={p} />
            ))}
          </div>
        </div>
      )}

      {/* Stats bar */}
      {pairs.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-3 text-xs">
          {(["trending_up", "trending_down", "ranging", "volatile"] as const).map((r) => {
            const count = pairs.filter((p) => p.regime === r).length;
            if (!count) return null;
            return (
              <span key={r} className={`px-2 py-1 rounded font-semibold ${regimeBadge(r)}`}>
                {regimeLabel(r)} ×{count}
              </span>
            );
          })}
          <span className="px-2 py-1 rounded bg-gray-800 text-gray-300">
            {pairs.length} pairs
          </span>
        </div>
      )}

      {/* Pair grid */}
      {sorted.length === 0 ? (
        <div className="text-center text-gray-500 py-16">
          {status ? "No pair data from datalake" : "Loading..."}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {sorted.map((pair) => (
            <PairCard key={pair.symbol} pair={pair} onTrade={setModalPair} />
          ))}
        </div>
      )}

      {/* Last update */}
      {status?.timestamp && (
        <p className="text-xs text-gray-700 text-center mt-6">
          Data timestamp: {fmtTime(status.timestamp)}
        </p>
      )}

      {/* Modal */}
      {modalPair && (
        <TradeModal
          pair={modalPair}
          onClose={() => setModalPair(null)}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}
