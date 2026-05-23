"use client";

import { useEffect, useState, useCallback } from "react";
import { useTradingContext } from "@/lib/context";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawAccount {
  currency: string;
  available: string;
  holds: string;
}

interface PriceRow {
  price:     number;
  change24h: number;   // decimal, e.g. 0.032 = +3.2%
}

interface HoldingRow {
  currency:     string;
  available:    number;
  availableRaw: string;   // exact string from KuCoin — used as size for sell orders
  holds:        number;
  price:        number;
  change24h:    number;
  valueUSDT:    number;
  isUSDT:       boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmt(n: number, decimals: number): string {
  if (n === 0) return "0";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPrice(p: number): string {
  if (p === 0) return "—";
  if (p < 0.0001) return `$${p.toFixed(8)}`;
  if (p < 0.01)   return `$${p.toFixed(6)}`;
  if (p < 1)      return `$${p.toFixed(4)}`;
  if (p < 100)    return `$${p.toFixed(2)}`;
  return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtUSDT(v: number): string {
  if (v < 0.01) return "<$0.01";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ALLOC_COLORS = [
  "#3b82f6","#8b5cf6","#f59e0b","#ef4444","#06b6d4","#ec4899",
];

// ── Main component ────────────────────────────────────────────────────────────

export default function Portfolio() {
  const { language, credentialsValid } = useTradingContext();
  const isFi = language === "fi";

  const [holdings,    setHoldings]    = useState<HoldingRow[]>([]);
  const [lastUpdate,  setLastUpdate]  = useState<number>(0);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  // Per-currency sell state: "idle" | "selling" | "done" | "error:msg"
  const [sellState,   setSellState]   = useState<Record<string, string>>({});

  // ── Load portfolio ──────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!credentialsValid) return;
    setLoading(true);
    setError(null);
    try {
      const balRes  = await fetch("/api/trading/balance");
      if (!balRes.ok) throw new Error(`Balance ${balRes.status}`);
      const balData = await balRes.json() as { accounts?: RawAccount[] };
      const rawAccs = (balData.accounts ?? []).filter(
        a => (parseFloat(a.available) || 0) + (parseFloat(a.holds) || 0) > 0
      );

      if (rawAccs.length === 0) { setHoldings([]); setLoading(false); return; }

      // Fetch prices for non-USDT in parallel
      const nonUsdt  = rawAccs.filter(a => a.currency !== "USDT");
      const priceMap = new Map<string, PriceRow>();
      await Promise.all(nonUsdt.map(async (a) => {
        try {
          const res  = await fetch(`/api/trading/price?symbol=${a.currency}-USDT`);
          if (!res.ok) return;
          const data = await res.json() as {
            orderBook?: { price?: string };
            stats?:     { changeRate?: string };
          };
          const price     = parseFloat(data.orderBook?.price    ?? "0");
          const change24h = parseFloat(data.stats?.changeRate   ?? "0");
          if (price > 0) priceMap.set(a.currency, { price, change24h });
        } catch { /* skip pairs not on KuCoin spot */ }
      }));

      const rows: HoldingRow[] = rawAccs.map(a => {
        const isUSDT     = a.currency === "USDT";
        const available  = parseFloat(a.available) || 0;
        const holds      = parseFloat(a.holds)     || 0;
        const p          = priceMap.get(a.currency);
        const price      = isUSDT ? 1 : (p?.price ?? 0);
        return {
          currency:     a.currency,
          available,
          availableRaw: a.available,   // preserve exact string for order placement
          holds,
          price,
          change24h:    isUSDT ? 0 : (p?.change24h ?? 0),
          valueUSDT:    (available + holds) * price,
          isUSDT,
        };
      }).sort((x, y) => y.valueUSDT - x.valueUSDT);

      setHoldings(rows);
      setLastUpdate(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Virhe");
    } finally {
      setLoading(false);
    }
  }, [credentialsValid]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // ── Sell all of a currency ──────────────────────────────────────────────────
  const sellAll = useCallback(async (h: HoldingRow) => {
    const symbol  = `${h.currency}-USDT`;
    const estUSDT = fmtUSDT(h.valueUSDT);

    const confirmed = window.confirm(
      isFi
        ? `Myy KAIKKI ${h.currency} (≈${estUSDT}) markkinahintaan USDT:ksi?\n\nToimeksianto toteutetaan välittömästi KuCoinissa.`
        : `Sell ALL ${h.currency} (≈${estUSDT}) at market price to USDT?\n\nOrder will be placed immediately on KuCoin.`
    );
    if (!confirmed) return;

    setSellState(s => ({ ...s, [h.currency]: "selling" }));

    try {
      // Re-fetch fresh balance immediately before order to get exact available string
      const balRes  = await fetch("/api/trading/balance");
      if (!balRes.ok) throw new Error(`Balance refetch ${balRes.status}`);
      const balData  = await balRes.json() as { accounts?: RawAccount[] };
      const freshAcc = (balData.accounts ?? []).find(a => a.currency === h.currency);
      const sizeStr  = freshAcc?.available ?? h.availableRaw;

      if (!sizeStr || parseFloat(sizeStr) <= 0) {
        throw new Error(isFi ? "Ei myytävää" : "Nothing to sell");
      }

      const res  = await fetch("/api/trading/orders", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ symbol, side: "sell", type: "market", size: sizeStr }),
      });
      const json = await res.json() as { orderId?: string; error?: string };
      if (json.error) throw new Error(json.error);

      setSellState(s => ({ ...s, [h.currency]: "done" }));
      // Reload portfolio after brief delay (order needs a moment to settle)
      setTimeout(load, 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Virhe";
      setSellState(s => ({ ...s, [h.currency]: `error:${msg}` }));
    }
  }, [isFi, load]);

  // ── Derived totals ──────────────────────────────────────────────────────────
  const totalUSDT      = holdings.reduce((s, h) => s + h.valueUSDT, 0);
  const usdtCash       = holdings.find(h => h.isUSDT)?.available ?? 0;
  const cryptoValue    = totalUSDT - usdtCash;
  const cryptoHoldings = holdings.filter(h => !h.isUSDT && h.valueUSDT >= 0.01);

  // ── Not logged in ───────────────────────────────────────────────────────────
  if (!credentialsValid) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-6">
        <div className="text-3xl opacity-20">💼</div>
        <div className="text-xs text-tv-text2">
          {isFi ? "Aseta API-avaimet nähdäksesi salkkusi" : "Set API keys to view your portfolio"}
        </div>
      </div>
    );
  }

  if (loading && holdings.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-tv-text3 text-xs">
        {isFi ? "Ladataan..." : "Loading..."}
      </div>
    );
  }

  return (
    <div className="flex flex-col pb-4">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="px-3 py-2.5 border-b border-tv-border flex items-center justify-between">
        <div>
          <div className="text-[10px] text-tv-text3 uppercase tracking-wide">
            {isFi ? "Kokonaisarvo" : "Total value"}
          </div>
          <div className="text-[18px] font-black text-tv-text font-mono">
            {fmtUSDT(totalUSDT)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <div className="text-[10px] text-tv-text3">
            <span className="text-tv-text2">{isFi ? "Käteinen" : "Cash"} </span>
            <span className="font-mono text-tv-text">{fmtUSDT(usdtCash)}</span>
          </div>
          <div className="text-[10px] text-tv-text3">
            <span className="text-tv-text2">{isFi ? "Krypto" : "Crypto"} </span>
            <span className="font-mono text-tv-text">{fmtUSDT(cryptoValue)}</span>
          </div>
          {lastUpdate > 0 && (
            <button onClick={load} disabled={loading}
              className="text-[9px] text-tv-text3 hover:text-tv-text2 transition-colors mt-0.5">
              {loading ? "⟳" : `↻ ${new Date(lastUpdate).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2 text-[10px] text-tv-red bg-red-50 border border-red-200 rounded px-2 py-1.5">
          ⚠ {error}
        </div>
      )}

      {/* ── USDT cash row ───────────────────────────────────────────────────── */}
      {usdtCash > 0 && (
        <div className="px-3 pt-3 pb-1">
          <div className="flex items-center justify-between px-2.5 py-2 rounded-lg border border-tv-border bg-tv-bg2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center text-[11px] font-bold text-emerald-600">
                $
              </div>
              <div>
                <div className="text-[12px] font-semibold text-tv-text">USDT</div>
                <div className="text-[9px] text-tv-text3">{isFi ? "Käteinen" : "Cash"}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[12px] font-mono font-semibold text-tv-text">
                {fmtAmt(usdtCash, 2)}
              </div>
              <div className="text-[10px] font-mono text-tv-text2">{fmtUSDT(usdtCash)}</div>
            </div>
          </div>
        </div>
      )}

      {/* ── Crypto holdings ─────────────────────────────────────────────────── */}
      {cryptoHoldings.length > 0 && (
        <div className="px-3 pt-2 space-y-1.5">
          <div className="text-[9px] uppercase tracking-wide text-tv-text3 px-1">
            {isFi ? "Kryptot" : "Crypto holdings"}
          </div>

          {cryptoHoldings.map(h => {
            const changePct   = h.change24h * 100;
            const up          = changePct >= 0;
            const hasLocked   = h.holds > 0;
            const amtDecimals = h.available < 1 ? (h.available < 0.001 ? 8 : 4) : 2;
            const st          = sellState[h.currency] ?? "idle";
            const isSelling   = st === "selling";
            const isDone      = st === "done";
            const sellError   = st.startsWith("error:") ? st.slice(6) : null;

            return (
              <div key={h.currency}
                className="rounded-lg border border-tv-border bg-tv-bg2 overflow-hidden">

                {/* Main row */}
                <div className="flex items-center justify-between px-2.5 py-2">

                  {/* Left: icon + name + price */}
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-tv-bg3 flex items-center justify-center text-[10px] font-bold text-tv-text2">
                      {h.currency.slice(0, 2)}
                    </div>
                    <div>
                      <div className="text-[12px] font-semibold text-tv-text">{h.currency}</div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] font-mono text-tv-text2">
                          {fmtPrice(h.price)}
                        </span>
                        {h.change24h !== 0 && (
                          <span className={cn("text-[9px] font-mono font-semibold",
                            up ? "text-tv-green" : "text-tv-red")}>
                            {up ? "+" : ""}{changePct.toFixed(2)}%
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right: amount + value */}
                  <div className="text-right">
                    <div className="text-[12px] font-mono font-semibold text-tv-text">
                      {fmtAmt(h.available, amtDecimals)}
                    </div>
                    {hasLocked && (
                      <div className="text-[9px] font-mono text-amber-500">
                        +{fmtAmt(h.holds, amtDecimals)} {isFi ? "lukittu" : "locked"}
                      </div>
                    )}
                    <div className={cn("text-[10px] font-mono font-semibold",
                      up && h.change24h !== 0 ? "text-tv-green" :
                      !up && h.change24h !== 0 ? "text-tv-red" : "text-tv-text2")}>
                      {fmtUSDT(h.valueUSDT)}
                    </div>
                  </div>
                </div>

                {/* Sell bar */}
                <div className="border-t border-tv-border/60 px-2.5 py-1.5 flex items-center justify-between gap-2">

                  {/* Status message */}
                  <div className="text-[9px]">
                    {isDone && (
                      <span className="text-tv-green font-semibold">
                        ✓ {isFi ? "Myyty" : "Sold"}
                      </span>
                    )}
                    {sellError && (
                      <span className="text-tv-red" title={sellError}>
                        ✗ {sellError.length > 30 ? sellError.slice(0, 28) + "…" : sellError}
                      </span>
                    )}
                    {!isDone && !sellError && (
                      <span className="text-tv-text3 italic">
                        {isFi ? "Markkinamyynti → USDT" : "Market sell → USDT"}
                      </span>
                    )}
                  </div>

                  {/* Sell button */}
                  <button
                    onClick={() => sellAll(h)}
                    disabled={isSelling || isDone}
                    className={cn(
                      "text-[10px] font-bold px-2.5 py-1 rounded border transition-colors",
                      isSelling || isDone
                        ? "opacity-40 cursor-not-allowed bg-tv-bg3 border-tv-border text-tv-text3"
                        : "bg-red-500/15 border-red-500/40 text-tv-red hover:bg-red-500/25 active:bg-red-500/35"
                    )}
                  >
                    {isSelling
                      ? (isFi ? "⟳ Myydään…" : "⟳ Selling…")
                      : isDone
                      ? (isFi ? "✓ Myyty"    : "✓ Sold")
                      : (isFi ? "🔴 Myy kaikki" : "🔴 Sell all")}
                  </button>
                </div>

              </div>
            );
          })}
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {holdings.length === 0 && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-12 gap-2 text-center px-6">
          <div className="text-3xl opacity-20">📭</div>
          <div className="text-xs text-tv-text2">
            {isFi ? "Salkku on tyhjä" : "Portfolio is empty"}
          </div>
        </div>
      )}

      {/* ── Allocation bar ──────────────────────────────────────────────────── */}
      {totalUSDT > 0 && cryptoHoldings.length > 0 && (
        <div className="px-3 pt-3">
          <div className="text-[9px] uppercase tracking-wide text-tv-text3 px-1 mb-1.5">
            {isFi ? "Allokaatio" : "Allocation"}
          </div>
          <div className="h-3 rounded-full overflow-hidden flex bg-tv-bg3">
            {usdtCash > 0 && (
              <div
                className="h-full bg-emerald-500/70 transition-all"
                style={{ width: `${(usdtCash / totalUSDT) * 100}%` }}
                title={`USDT ${((usdtCash / totalUSDT) * 100).toFixed(1)}%`}
              />
            )}
            {cryptoHoldings.slice(0, 6).map((h, i) => (
              <div key={h.currency}
                className="h-full transition-all"
                style={{
                  width:      `${(h.valueUSDT / totalUSDT) * 100}%`,
                  background: ALLOC_COLORS[i % ALLOC_COLORS.length],
                  opacity:    0.75,
                }}
                title={`${h.currency} ${((h.valueUSDT / totalUSDT) * 100).toFixed(1)}%`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {usdtCash > 0 && (
              <div className="flex items-center gap-1 text-[9px] text-tv-text2">
                <div className="w-2 h-2 rounded-full bg-emerald-500/70" />
                USDT {((usdtCash / totalUSDT) * 100).toFixed(0)}%
              </div>
            )}
            {cryptoHoldings.slice(0, 6).map((h, i) => (
              <div key={h.currency} className="flex items-center gap-1 text-[9px] text-tv-text2">
                <div className="w-2 h-2 rounded-full"
                  style={{ background: ALLOC_COLORS[i % ALLOC_COLORS.length] }} />
                {h.currency} {((h.valueUSDT / totalUSDT) * 100).toFixed(0)}%
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
