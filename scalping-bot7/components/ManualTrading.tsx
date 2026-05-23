"use client";

import { useCallback, useEffect, useState } from "react";
import { useTradingContext } from "@/lib/context";
import { TOP_20_PAIRS } from "@/lib/autoOptimizer";
import { cn } from "@/lib/utils";

interface RecentOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  amount: string;
  timestamp: number;
  status: "ok" | "error";
  error?: string;
}

export default function ManualTrading() {
  const { language, credentialsValid } = useTradingContext();
  const isFi = language === "fi";

  const [symbol, setSymbol]           = useState("BTC-USDT");
  const [amount, setAmount]           = useState("100");
  const [usdtBalance, setUsdtBalance] = useState<number | null>(null);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [loading, setLoading]         = useState(false);
  const [confirm, setConfirm]         = useState<{ side: "buy" | "sell" } | null>(null);

  // Fetch USDT balance
  const fetchBalance = useCallback(async () => {
    if (!credentialsValid) return;
    try {
      const res = await fetch("/api/trading/balance");
      if (!res.ok) return;
      const data = await res.json() as { accounts?: { currency: string; available: string }[] };
      const usdt = data.accounts?.find(a => a.currency === "USDT");
      if (usdt) setUsdtBalance(parseFloat(usdt.available));
    } catch { /* ignore */ }
  }, [credentialsValid]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  const placeOrder = useCallback(async (side: "buy" | "sell") => {
    if (loading) return;
    setLoading(true);
    setConfirm(null);

    const entry: RecentOrder = {
      id:        `m-${Date.now()}`,
      symbol,
      side,
      amount,
      timestamp: Date.now(),
      status:    "ok",
    };

    try {
      const res = await fetch("/api/trading/orders", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          symbol,
          side,
          type:  "market",
          funds: amount,   // spend/receive USDT
        }),
      });
      const data = await res.json() as { orderId?: string; error?: string };
      if (data.error) {
        entry.status = "error";
        entry.error  = data.error;
      } else {
        entry.id = data.orderId ?? entry.id;
      }
    } catch (err) {
      entry.status = "error";
      entry.error  = String(err);
    }

    setRecentOrders(prev => [entry, ...prev].slice(0, 5));
    setLoading(false);
    fetchBalance();
  }, [symbol, amount, loading, fetchBalance]);

  const handleClick = (side: "buy" | "sell") => {
    if (!credentialsValid) return;
    // First click: set confirm state; second click: execute
    if (confirm?.side === side) {
      placeOrder(side);
    } else {
      setConfirm({ side });
    }
  };

  return (
    <div className="panel space-y-3">

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-tv-text uppercase tracking-wide">
          {isFi ? "Manuaalikauppa" : "Manual Trading"}
        </h2>
        {usdtBalance !== null && (
          <span className="text-xs text-tv-text3 font-mono">
            USDT {usdtBalance.toFixed(2)}
          </span>
        )}
      </div>

      {/* Warning */}
      <div className="text-[9px] text-tv-amber bg-tv-amber/10 border border-tv-amber/30 rounded px-2 py-1">
        {isFi
          ? "⚠ Manuaalit toimeksiannot suoritetaan välittömästi KuCoinissa"
          : "⚠ Manual orders execute immediately on KuCoin"}
      </div>

      {!credentialsValid && (
        <div className="text-[10px] text-tv-text3 bg-tv-bg2 border border-tv-border rounded px-2 py-1.5 text-center">
          {isFi ? "Aseta API-avaimet ensin asetuksista" : "Configure API credentials in settings first"}
        </div>
      )}

      {credentialsValid && (
        <>
          {/* Symbol selector */}
          <div>
            <label className="block text-[9px] uppercase tracking-wide text-tv-text3 mb-1">
              {isFi ? "Pari" : "Symbol"}
            </label>
            <select
              value={symbol}
              onChange={e => { setSymbol(e.target.value); setConfirm(null); }}
              className="w-full text-xs bg-tv-bg2 border border-tv-border rounded px-2 py-1 text-tv-text focus:outline-none focus:border-tv-purple/50"
            >
              {TOP_20_PAIRS.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Amount */}
          <div>
            <label className="block text-[9px] uppercase tracking-wide text-tv-text3 mb-1">
              {isFi ? "Määrä (USDT)" : "Amount (USDT)"}
            </label>
            <input
              type="number"
              min="1"
              step="10"
              value={amount}
              onChange={e => { setAmount(e.target.value); setConfirm(null); }}
              className="w-full text-xs bg-tv-bg2 border border-tv-border rounded px-2 py-1 text-tv-text font-mono focus:outline-none focus:border-tv-purple/50"
            />
          </div>

          {/* Confirm hint */}
          {confirm && (
            <div className={cn(
              "text-[9px] text-center font-semibold px-2 py-1 rounded border animate-pulse",
              confirm.side === "buy"
                ? "bg-tv-green/10 border-tv-green/30 text-tv-green"
                : "bg-tv-red/10 border-tv-red/30 text-tv-red"
            )}>
              {isFi
                ? `Paina ${confirm.side === "buy" ? "OSTA" : "MYYNTI"} uudelleen vahvistukseksi`
                : `Click ${confirm.side === "buy" ? "BUY" : "SELL"} again to confirm`}
            </div>
          )}

          {/* BUY / SELL buttons */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => handleClick("buy")}
              disabled={loading}
              className={cn(
                "py-2 rounded text-xs font-bold transition-colors border",
                confirm?.side === "buy"
                  ? "bg-tv-green text-white border-tv-green"
                  : "bg-tv-green/10 text-tv-green border-tv-green/30 hover:bg-tv-green/20",
                loading && "opacity-50 cursor-not-allowed"
              )}
            >
              {loading ? "..." : (isFi ? "OSTA" : "BUY")}
            </button>
            <button
              onClick={() => handleClick("sell")}
              disabled={loading}
              className={cn(
                "py-2 rounded text-xs font-bold transition-colors border",
                confirm?.side === "sell"
                  ? "bg-tv-red text-white border-tv-red"
                  : "bg-tv-red/10 text-tv-red border-tv-red/30 hover:bg-tv-red/20",
                loading && "opacity-50 cursor-not-allowed"
              )}
            >
              {loading ? "..." : (isFi ? "MYYNTI" : "SELL")}
            </button>
          </div>

          {/* Recent orders */}
          {recentOrders.length > 0 && (
            <div className="space-y-1">
              <div className="text-[9px] uppercase tracking-wide text-tv-text3">
                {isFi ? "Viimeisimmät toimeksiannot" : "Recent orders"}
              </div>
              {recentOrders.map(o => (
                <div
                  key={o.id}
                  className={cn(
                    "flex items-center gap-1.5 text-[9px] px-2 py-1 rounded",
                    o.status === "ok"    ? "bg-tv-bg2" : "bg-tv-red/10"
                  )}
                >
                  <span className={cn(
                    "font-bold",
                    o.side === "buy" ? "text-tv-green" : "text-tv-red"
                  )}>
                    {o.side.toUpperCase()}
                  </span>
                  <span className="text-tv-text2">{o.symbol}</span>
                  <span className="font-mono text-tv-text3">${o.amount}</span>
                  <span className="flex-1" />
                  {o.status === "error"
                    ? <span className="text-tv-red truncate">{o.error}</span>
                    : <span className="text-tv-green">✓</span>
                  }
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
