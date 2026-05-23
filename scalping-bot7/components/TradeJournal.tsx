"use client";

import { useEffect, useMemo, useState } from "react";
import { useTradingContext } from "@/lib/context";
import type { TradeResult } from "@/lib/backtester";
import type { TradeLogEntry } from "@/lib/tradeLogger";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { useT } from "@/components/SettingsModal";

// ── CSV helpers ───────────────────────────────────────────────────────────────

function downloadCSV(trades: TradeResult[]) {
  const headers = [
    "#", "DateTime", "Pair", "Direction", "Entry", "Exit",
    "SL Hit?", "TP1 Hit?", "TP2 Hit?", "P&L (USDT)", "P&L (%)",
    "Duration (min)", "Signal Score", "R/R", "Exit Reason", "Conditions Met",
  ];
  const rows = trades.map((tr, i) => [
    i + 1,
    new Date(tr.entryTime * 1000).toISOString(),
    tr.symbol,
    tr.direction,
    tr.entryPrice.toFixed(6),
    tr.exitPrice.toFixed(6),
    tr.slHit  ? "Y" : "N",
    tr.tp1Hit ? "Y" : "N",
    tr.tp2Hit ? "Y" : "N",
    tr.pnlUSDT.toFixed(4),
    tr.pnlPct.toFixed(4),
    tr.durationMinutes.toFixed(0),
    tr.signalScore,
    tr.riskRewardRatio.toFixed(2),
    tr.exitReason,
    `"${tr.conditionsMet.join("; ")}"`,
  ]);
  exportBlob([headers, ...rows], `trades_${today()}.csv`);
}

function downloadLiveCSV(trades: TradeLogEntry[]) {
  const headers = [
    "#", "DateTime", "Pair", "Direction", "Entry", "Exit",
    "P&L (USDT)", "P&L (%)", "Duration (min)", "Signal Score",
    "Exit Reason", "Source", "Simulated",
  ];
  const rows = trades.map((tr, i) => [
    i + 1,
    new Date(tr.entryTime).toISOString(),
    tr.symbol,
    tr.direction,
    tr.entryPrice.toFixed(6),
    tr.exitPrice.toFixed(6),
    tr.pnlUSDT.toFixed(4),
    tr.pnlPct.toFixed(4),
    tr.durationMinutes.toFixed(0),
    tr.signalScore,
    tr.exitReason,
    tr.source,
    tr.simulated ? "Y" : "N",
  ]);
  exportBlob([headers, ...rows], `live_trades_${today()}.csv`);
}

function exportBlob(rows: (string | number)[][], filename: string) {
  const csv  = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function today() { return new Date().toISOString().split("T")[0]; }

// ── Component ─────────────────────────────────────────────────────────────────

export default function TradeJournal() {
  const { backtestResults, tradeLog, language } = useTradingContext();
  // FIX: renamed from `t` to `tr_` to avoid shadowing in map callbacks
  const tr_ = useT();
  const isFi = language === "fi";

  const [tab,           setTab]           = useState<"live" | "backtest">("live");
  const [filterDir,     setFilterDir]     = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [filterOutcome, setFilterOutcome] = useState<"ALL" | "WIN" | "LOSS">("ALL");
  const [open,          setOpen]          = useState(true);

  // ── Server-bot trades (data/trades.json via API) ───────────────────────────
  const [serverTrades,    setServerTrades]    = useState<TradeLogEntry[]>([]);
  const [serverTradesAt,  setServerTradesAt]  = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const res  = await fetch(`/api/trading/trades?since=${serverTradesAt}&limit=200`);
        const data = await res.json() as { trades: TradeLogEntry[] };
        if (data.trades.length > 0) {
          setServerTrades(prev => {
            // Merge by id — avoid duplicates
            const existing = new Set(prev.map(t => t.id));
            const fresh    = data.trades.filter(t => !existing.has(t.id));
            return [...prev, ...fresh].sort((a, b) => a.timestamp - b.timestamp);
          });
          setServerTradesAt(Date.now());
        }
      } catch { /* ignore */ }
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Merge context tradeLog (browser bot / multi-bot) + server trades, deduplicated
  const allLiveTrades = useMemo<TradeLogEntry[]>(() => {
    const seen    = new Set<string>();
    const merged  = [...tradeLog, ...serverTrades].filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
    return merged.sort((a, b) => a.timestamp - b.timestamp);
  }, [tradeLog, serverTrades]);

  // ── FIX: memoized filter results ──────────────────────────────────────────
  const filteredLive = useMemo(() => {
    return allLiveTrades.filter(tr => {
      if (filterDir     !== "ALL" && tr.direction !== filterDir) return false;
      if (filterOutcome === "WIN"  && tr.pnlUSDT <= 0) return false;
      if (filterOutcome === "LOSS" && tr.pnlUSDT >  0) return false;
      return true;
    });
  }, [allLiveTrades, filterDir, filterOutcome]);

  const liveStats = useMemo(() => {
    const wins        = filteredLive.filter(tr => tr.pnlUSDT > 0);
    const losses      = filteredLive.filter(tr => tr.pnlUSDT <= 0);
    const totalPnl    = filteredLive.reduce((a, tr) => a + tr.pnlUSDT, 0);
    const grossWins   = wins.reduce((a, tr) => a + tr.pnlUSDT, 0);
    const grossLosses = Math.abs(losses.reduce((a, tr) => a + tr.pnlUSDT, 0));
    return {
      winRate:    filteredLive.length > 0 ? (wins.length / filteredLive.length) * 100 : 0,
      totalPnl,
      pf:         grossLosses > 0 ? grossWins / grossLosses : 0,
      expectancy: filteredLive.length > 0 ? totalPnl / filteredLive.length : 0,
    };
  }, [filteredLive]);

  // FIX: memoized reversed list so we don't recreate on every render
  const filteredLiveReversed = useMemo(
    () => [...filteredLive].reverse().slice(0, 100),
    [filteredLive],
  );

  const allBacktest = backtestResults?.allTrades ?? [];
  const filteredBT  = useMemo(() => {
    return allBacktest.filter(tr => {
      if (filterDir     !== "ALL" && tr.direction !== filterDir) return false;
      if (filterOutcome === "WIN"  && tr.pnlUSDT <= 0) return false;
      if (filterOutcome === "LOSS" && tr.pnlUSDT >  0) return false;
      return true;
    });
  }, [allBacktest, filterDir, filterOutcome]);

  const btStats = useMemo(() => {
    const wins        = filteredBT.filter(tr => tr.pnlUSDT > 0);
    const losses      = filteredBT.filter(tr => tr.pnlUSDT <= 0);
    const totalPnl    = filteredBT.reduce((a, tr) => a + tr.pnlUSDT, 0);
    const grossWins   = wins.reduce((a, tr) => a + tr.pnlUSDT, 0);
    const grossLosses = Math.abs(losses.reduce((a, tr) => a + tr.pnlUSDT, 0));
    return {
      winRate:    filteredBT.length > 0 ? (wins.length / filteredBT.length) * 100 : 0,
      totalPnl,
      pf:         grossLosses > 0 ? grossWins / grossLosses : 0,
      expectancy: filteredBT.length > 0 ? totalPnl / filteredBT.length : 0,
    };
  }, [filteredBT]);

  const filteredBTReversed = useMemo(
    () => filteredBT.slice(-50).reverse(),
    [filteredBT],
  );

  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setOpen(v => !v)}
          className="text-sm font-semibold text-tv-text uppercase tracking-wide flex items-center gap-2"
        >
          📋 {tr_("journal.title")}
          <span className="text-tv-text2 text-xs">{open ? "▲" : "▼"}</span>
        </button>
        <div className="flex items-center gap-2">
          <select
            value={filterDir}
            onChange={e => setFilterDir(e.target.value as typeof filterDir)}
            className="text-xs bg-tv-bg2 border border-tv-border rounded px-1.5 py-1 text-tv-text"
          >
            <option value="ALL">{tr_("journal.all")}</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
          <select
            value={filterOutcome}
            onChange={e => setFilterOutcome(e.target.value as typeof filterOutcome)}
            className="text-xs bg-tv-bg2 border border-tv-border rounded px-1.5 py-1 text-tv-text"
          >
            <option value="ALL">{tr_("journal.all")}</option>
            <option value="WIN">{tr_("journal.wins")}</option>
            <option value="LOSS">{tr_("journal.losses")}</option>
          </select>
          {tab === "live" && filteredLive.length > 0 && (
            <button
              onClick={() => downloadLiveCSV(filteredLive)}
              className="text-xs text-tv-text2 hover:text-tv-text border border-tv-border rounded px-2 py-1"
            >
              {isFi ? "↓ CSV" : "↓ CSV"}
            </button>
          )}
          {tab === "backtest" && filteredBT.length > 0 && (
            <button
              onClick={() => downloadCSV(filteredBT)}
              className="text-xs text-tv-text2 hover:text-tv-text border border-tv-border rounded px-2 py-1"
            >
              {isFi ? "↓ CSV" : "↓ CSV"}
            </button>
          )}
        </div>
      </div>

      {open && (
        <>
          {/* Tab selector */}
          <div className="flex gap-1 mb-3">
            <button
              onClick={() => setTab("live")}
              className={cn(
                "text-xs px-3 py-1 rounded font-semibold border transition-colors",
                tab === "live"
                  ? "bg-tv-blue/15 text-tv-blue border-tv-blue/40"
                  : "bg-tv-bg2 text-tv-text2 border-tv-border hover:text-tv-text"
              )}
            >
              {tr_("journal.live")}
              {allLiveTrades.length > 0 && (
                <span className="ml-1 opacity-70">({allLiveTrades.length})</span>
              )}
              {serverTrades.length > 0 && (
                <span className="ml-1 text-[9px] text-tv-purple">
                  {serverTrades.length} bot
                </span>
              )}
            </button>
            <button
              onClick={() => setTab("backtest")}
              className={cn(
                "text-xs px-3 py-1 rounded font-semibold border transition-colors",
                tab === "backtest"
                  ? "bg-tv-blue/15 text-tv-blue border-tv-blue/40"
                  : "bg-tv-bg2 text-tv-text2 border-tv-border hover:text-tv-text"
              )}
            >
              {tr_("journal.backtest")}
              {allBacktest.length > 0 && (
                <span className="ml-1 opacity-70">({allBacktest.length})</span>
              )}
            </button>
          </div>

          {/* ── Live trades tab ─────────────────────────────────────────────── */}
          {tab === "live" && (
            filteredLive.length === 0 ? (
              <div className="text-xs text-tv-text2 text-center py-6">
                {isFi ? "Ei kauppoja vielä" : "No trades yet — trades appear here when the bot closes positions"}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-tv-text2 text-left border-b border-tv-border">
                        <th className="pb-1.5 pr-2">#</th>
                        <th className="pb-1.5 pr-2">{isFi ? "Päivä" : "Date"}</th>
                        <th className="pb-1.5 pr-2">{tr_("market.pair")}</th>
                        <th className="pb-1.5 pr-2">{tr_("journal.direction")}</th>
                        <th className="pb-1.5 pr-2">{tr_("signal.entry")}</th>
                        <th className="pb-1.5 pr-2">{isFi ? "Ulos" : "Exit"}</th>
                        <th className="pb-1.5 pr-2">P&amp;L $</th>
                        <th className="pb-1.5 pr-2">P&amp;L %</th>
                        <th className="pb-1.5 pr-2">{tr_("metric.duration")}</th>
                        <th className="pb-1.5 pr-2">{isFi ? "Lähde" : "Source"}</th>
                        <th className="pb-1.5">{tr_("signal.exit")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* FIX: renamed `t` → `trade` to avoid shadowing useT() */}
                      {filteredLiveReversed.map((trade, idx) => {
                        const isWin = trade.pnlUSDT > 0;
                        return (
                          <tr
                            key={trade.id}
                            className={cn(
                              "border-t border-tv-border hover:bg-tv-hover",
                              isWin ? "text-tv-green" : "text-tv-red"
                            )}
                          >
                            <td className="py-1 pr-2 text-tv-text2">{filteredLive.length - idx}</td>
                            <td className="py-1 pr-2 font-mono text-tv-text2">
                              {format(new Date(trade.entryTime), "MM/dd HH:mm")}
                            </td>
                            <td className="py-1 pr-2 text-tv-text2 text-[10px]">{trade.symbol.replace("-USDT", "")}</td>
                            <td className="py-1 pr-2 font-semibold">{trade.direction}</td>
                            <td className="py-1 pr-2 font-mono">${trade.entryPrice.toFixed(4)}</td>
                            <td className="py-1 pr-2 font-mono">${trade.exitPrice.toFixed(4)}</td>
                            <td className="py-1 pr-2 font-mono">
                              {trade.pnlUSDT >= 0 ? "+" : ""}${trade.pnlUSDT.toFixed(2)}
                            </td>
                            <td className="py-1 pr-2 font-mono">
                              {trade.pnlPct >= 0 ? "+" : ""}{trade.pnlPct.toFixed(2)}%
                            </td>
                            <td className="py-1 pr-2 text-tv-text2">{trade.durationMinutes.toFixed(0)}m</td>
                            <td className="py-1 pr-2 text-tv-text2 text-[10px]">
                              {trade.source}{trade.simulated ? " (sim)" : ""}
                            </td>
                            <td className="py-1 text-tv-text2 text-[10px]">{trade.exitReason}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <SummaryFooter
                  count={filteredLive.length}
                  {...liveStats}
                />
              </>
            )
          )}

          {/* ── Backtest tab ────────────────────────────────────────────────── */}
          {tab === "backtest" && (
            filteredBT.length === 0 ? (
              <div className="text-xs text-tv-text2 text-center py-6">
                {isFi ? "Aja historiatesti nähdäksesi simuloidun kauppahistorian" : "Run a backtest to see simulated trade history here"}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-tv-text2 text-left border-b border-tv-border">
                        <th className="pb-1.5 pr-2">#</th>
                        <th className="pb-1.5 pr-2">{isFi ? "Päivä" : "Date"}</th>
                        <th className="pb-1.5 pr-2">{tr_("journal.direction")}</th>
                        <th className="pb-1.5 pr-2">{tr_("signal.entry")}</th>
                        <th className="pb-1.5 pr-2">{isFi ? "Ulos" : "Exit"}</th>
                        <th className="pb-1.5 pr-2">SL</th>
                        <th className="pb-1.5 pr-2">TP1</th>
                        <th className="pb-1.5 pr-2">TP2</th>
                        <th className="pb-1.5 pr-2">P&amp;L $</th>
                        <th className="pb-1.5 pr-2">P&amp;L %</th>
                        <th className="pb-1.5 pr-2">{tr_("metric.duration")}</th>
                        <th className="pb-1.5 pr-2">R/R</th>
                        <th className="pb-1.5">{tr_("signal.exit")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredBTReversed.map((trade, idx) => {
                        const isWin = trade.pnlUSDT > 0;
                        const isBE  = trade.pnlUSDT === 0;
                        return (
                          <tr
                            key={trade.id}
                            className={cn(
                              "border-t border-tv-border hover:bg-tv-hover",
                              isWin ? "text-tv-green" : isBE ? "text-tv-amber" : "text-tv-red"
                            )}
                          >
                            <td className="py-1 pr-2 text-tv-text2">{filteredBT.length - idx}</td>
                            <td className="py-1 pr-2 font-mono text-tv-text2">
                              {format(new Date(trade.entryTime * 1000), "MM/dd HH:mm")}
                            </td>
                            <td className="py-1 pr-2 font-semibold">{trade.direction}</td>
                            <td className="py-1 pr-2 font-mono">${trade.entryPrice.toFixed(4)}</td>
                            <td className="py-1 pr-2 font-mono">${trade.exitPrice.toFixed(4)}</td>
                            <td className="py-1 pr-2 text-tv-text2">{trade.slHit  ? "✓" : "—"}</td>
                            <td className="py-1 pr-2 text-tv-text2">{trade.tp1Hit ? "✓" : "—"}</td>
                            <td className="py-1 pr-2 text-tv-text2">{trade.tp2Hit ? "✓" : "—"}</td>
                            <td className="py-1 pr-2 font-mono">
                              {trade.pnlUSDT >= 0 ? "+" : ""}${trade.pnlUSDT.toFixed(2)}
                            </td>
                            <td className="py-1 pr-2 font-mono">
                              {trade.pnlPct >= 0 ? "+" : ""}{trade.pnlPct.toFixed(2)}%
                            </td>
                            <td className="py-1 pr-2 text-tv-text2">{trade.durationMinutes.toFixed(0)}m</td>
                            <td className="py-1 pr-2 text-tv-text2">1:{trade.riskRewardRatio.toFixed(1)}</td>
                            <td className="py-1 text-tv-text2 text-[10px]">{trade.exitReason}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <SummaryFooter
                  count={filteredBT.length}
                  {...btStats}
                />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}

// ── Summary footer ────────────────────────────────────────────────────────────

function SummaryFooter({
  count, winRate, totalPnl, pf, expectancy,
}: { count: number; winRate: number; totalPnl: number; pf: number; expectancy: number }) {
  const tr_ = useT();
  const { language } = useTradingContext();
  const isFi = language === "fi";
  return (
    <div className="mt-3 pt-2 border-t border-tv-border grid grid-cols-5 gap-2 text-xs">
      <div>
        <div className="text-tv-text2">{tr_("metric.trades")}</div>
        <div className="font-semibold text-tv-text">{count}</div>
      </div>
      <div>
        <div className="text-tv-text2">{tr_("metric.win_rate")}</div>
        {/* FIX: 38% is break-even at R:R 2:1, not 50% */}
        <div className={cn("font-semibold", winRate >= 38 ? "text-tv-green" : "text-tv-amber")}>
          {winRate.toFixed(1)}%
        </div>
      </div>
      <div>
        <div className="text-tv-text2">{isFi ? "P&L yhteensä" : "Total P&L"}</div>
        <div className={cn("font-semibold font-mono", totalPnl >= 0 ? "text-tv-green" : "text-tv-red")}>
          {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
        </div>
      </div>
      <div>
        <div className="text-tv-text2">{tr_("metric.profit_factor")}</div>
        <div className={cn("font-semibold", pf >= 1.5 ? "text-tv-green" : pf >= 1 ? "text-tv-amber" : "text-tv-red")}>
          {pf > 0 ? pf.toFixed(2) : "—"}
        </div>
      </div>
      <div>
        <div className="text-tv-text2">{tr_("metric.expectancy")}</div>
        <div className={cn("font-semibold font-mono", expectancy >= 0 ? "text-tv-green" : "text-tv-red")}>
          {expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)}
        </div>
      </div>
    </div>
  );
}
