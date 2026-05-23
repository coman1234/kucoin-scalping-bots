"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useTradingContext } from "@/lib/context";
import { runBacktest, type BacktestConfig, type BacktestResults } from "@/lib/backtester";
import { cn } from "@/lib/utils";
import { useT } from "@/components/SettingsModal";

const MIN_PF_TO_TRADE = 1.2;
const MIN_TRADES_TO_TRADE = 5;

const DEFAULT_PAIRS = [
  "BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "BNB-USDT",
  "DOGE-USDT", "ADA-USDT", "AVAX-USDT", "LINK-USDT", "DOT-USDT",
  "MATIC-USDT", "UNI-USDT", "LTC-USDT", "ATOM-USDT", "FIL-USDT",
  "NEAR-USDT", "APT-USDT", "ARB-USDT", "OP-USDT", "TRX-USDT",
];

interface PairResult {
  symbol:       string;
  status:       "pending" | "running" | "done" | "error";
  trades:       number;
  winRate:      number;
  profitFactor: number;
  maxDrawdown:  number;
  returnPct:    number;
  sharpe:       number;
  candles:      number;
}

type SortKey = keyof Pick<PairResult, "symbol" | "trades" | "winRate" | "profitFactor" | "maxDrawdown" | "returnPct" | "sharpe">;

export default function BatchBacktester() {
  const { selectedTimeframe, setSelectedSymbol, botConfig, setBotConfig, setBacktestResults, setActivePairs, setNotification, language } = useTradingContext();
  const t = useT();
  const isFi = language === "fi";

  const [open, setOpen]           = useState(false);
  const [running, setRunning]     = useState(false);
  const [results, setResults]     = useState<PairResult[]>([]);
  const [current, setCurrent]     = useState("");
  const [done, setDone]           = useState(0);
  const [total, setTotal]         = useState(0);
  const [sortKey, setSortKey]     = useState<SortKey>("profitFactor");
  const [sortAsc, setSortAsc]     = useState(false);
  const [days, setDays]           = useState(3);
  const [minScore, setMinScore]   = useState(botConfig.minSignalScore);
  const [pairs, setPairs]         = useState<string[]>(DEFAULT_PAIRS);
  const [pairInput, setPairInput] = useState("");
  const abortRef = useRef(false);

  // Auto-sync minScore when optimizer applies new parameters
  useEffect(() => {
    setMinScore(botConfig.minSignalScore);
  }, [botConfig.minSignalScore]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  };

  const runBatch = useCallback(async () => {
    abortRef.current = false;
    setRunning(true);
    setDone(0);
    setTotal(pairs.length);
    setCurrent("");

    const endAt   = Math.floor(Date.now() / 1000);
    const startAt = endAt - days * 24 * 3600;

    const config: BacktestConfig = {
      symbol: "",
      timeframe: selectedTimeframe,
      tradeAmountUSDT: botConfig.tradeAmountUSDT,
      minSignalScore: minScore,
      takeProfitMultiplier: 2.5,
      stopLossAtrMultiplier: 1.5,
      partialExitEnabled: botConfig.partialExitEnabled,
    };

    // Initialise rows
    setResults(pairs.map((sym) => ({
      symbol: sym, status: "pending",
      trades: 0, winRate: 0, profitFactor: 0,
      maxDrawdown: 0, returnPct: 0, sharpe: 0, candles: 0,
    })));

    let bestPF = 0;
    let bestResults: BacktestResults | null = null;
    let bestSym = "";

    for (let i = 0; i < pairs.length; i++) {
      if (abortRef.current) break;
      const sym = pairs[i];
      setCurrent(sym);

      // Mark as running
      setResults((prev) => prev.map((r) => r.symbol === sym ? { ...r, status: "running" } : r));

      try {
        const res  = await fetch(`/api/trading/candles?symbol=${sym}&timeframe=${selectedTimeframe}&startAt=${startAt}&endAt=${endAt}`);
        const data = await res.json();
        const candles = data.candles ?? [];

        if (candles.length < 60) {
          setResults((prev) => prev.map((r) => r.symbol === sym ? { ...r, status: "error", candles: candles.length } : r));
        } else {
          const bt = await new Promise<BacktestResults>((resolve) => {
            setTimeout(() => resolve(runBacktest(candles, { ...config, symbol: sym })), 0);
          });

          if (bt.profitFactor > bestPF && bt.totalTrades >= 5) {
            bestPF = bt.profitFactor;
            bestResults = bt;
            bestSym = sym;
          }

          setResults((prev) => prev.map((r) => r.symbol === sym ? {
            ...r,
            status:       "done",
            candles:      candles.length,
            trades:       bt.totalTrades,
            winRate:      bt.winRate,
            profitFactor: bt.profitFactor,
            maxDrawdown:  bt.maxDrawdownPct,
            returnPct:    bt.totalReturnPct,
            sharpe:       bt.sharpeRatio,
          } : r));
        }
      } catch {
        setResults((prev) => prev.map((r) => r.symbol === sym ? { ...r, status: "error" } : r));
      }

      setDone(i + 1);
      // Small yield to keep UI responsive
      await new Promise((r) => setTimeout(r, 10));
    }

    // Auto-select best pair for single-pair bot
    if (bestSym && bestResults) {
      setSelectedSymbol(bestSym);
      setBacktestResults(bestResults);
      if (bestResults.profitFactor >= 1.2 && bestResults.totalTrades >= 10) {
        setBotConfig({ ...botConfig, backtestValidated: true });
      }
    }

    setCurrent("");
    setRunning(false);
  }, [pairs, days, minScore, selectedTimeframe, botConfig, setBotConfig, setSelectedSymbol, setBacktestResults]);

  const stopBatch = () => { abortRef.current = true; };

  const addPair = () => {
    const p = pairInput.trim().toUpperCase();
    if (p && !pairs.includes(p)) { setPairs((prev) => [...prev, p]); }
    setPairInput("");
  };

  const removePair = (sym: string) => setPairs((prev) => prev.filter((p) => p !== sym));

  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  const sorted = [...results]
    .filter((r) => r.status === "done" || r.status === "running" || r.status === "pending" || r.status === "error")
    .sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return 1;
      if (b.status === "pending" && a.status !== "pending") return -1;
      const av = a[sortKey] as number | string;
      const bv = b[sortKey] as number | string;
      if (typeof av === "string") return sortAsc ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });

  const bestRow = sorted.find((r) => r.status === "done" && r.profitFactor === Math.max(...results.filter((x) => x.status === "done").map((x) => x.profitFactor)));

  return (
    <div className="panel">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-sm font-semibold text-tv-text uppercase tracking-wide"
      >
        <span>🔍 {t("batch.title")}</span>
        <span className="text-tv-text2">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4">

          {/* Optimizer sync indicator */}
          {minScore === botConfig.minSignalScore ? (
            <div className="text-[9px] bg-tv-purple/10 border border-tv-purple/20 text-tv-purple rounded px-2 py-1 flex items-center gap-1.5">
              <span>🔬</span>
              <span>{isFi ? "Min. pisteet synkronoitu automaattisesti optimoijalta" : "Min score auto-synced from optimizer"}</span>
            </div>
          ) : (
            <div className="flex items-center justify-between text-[9px] bg-tv-amber/10 border border-tv-amber/20 text-tv-amber rounded px-2 py-1">
              <span>{isFi ? "⚠ Min. pisteet muokattu manuaalisesti" : "⚠ Min score manually adjusted"}</span>
              <button onClick={() => setMinScore(botConfig.minSignalScore)} className="underline hover:no-underline font-semibold ml-2">
                {isFi ? "Palauta" : "Restore"}
              </button>
            </div>
          )}

          {/* Settings row */}
          <div className="flex flex-wrap gap-4 text-xs">
            <div className="space-y-1">
              <div className="flex justify-between gap-4">
                <span className="text-tv-text2">{t("batch.test_period")}</span>
                <span className="font-semibold text-tv-text">{days} {t("batch.days")}</span>
              </div>
              <input type="range" min={3} max={30} step={1} value={days}
                onChange={(e) => setDays(+e.target.value)}
                className="w-36 cursor-pointer" />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between gap-4">
                <span className="text-tv-text2">{t("backtest.min_score_label")}</span>
                <span className="font-semibold text-tv-text">{minScore}/13</span>
              </div>
              <input type="range" min={2} max={10} step={1} value={minScore}
                onChange={(e) => setMinScore(+e.target.value)}
                className="w-36 cursor-pointer" />
            </div>
          </div>

          {/* Pairs list management */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-tv-text2 uppercase tracking-wide">{t("batch.pairs_to_scan")} ({pairs.length})</span>
              <button onClick={() => setPairs(DEFAULT_PAIRS)} className="text-tv-blue hover:underline text-[10px]">{t("batch.restore_defaults")}</button>
            </div>
            <div className="flex flex-wrap gap-1">
              {pairs.map((p) => (
                <span key={p} className="inline-flex items-center gap-0.5 bg-tv-bg2 border border-tv-border rounded px-1.5 py-0.5 text-[10px] text-tv-text">
                  {p}
                  <button onClick={() => removePair(p)} className="text-tv-text3 hover:text-tv-red ml-0.5">×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={pairInput}
                onChange={(e) => setPairInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && addPair()}
                placeholder={t("batch.add_pair_placeholder")}
                className="flex-1 text-xs bg-tv-bg2 border border-tv-border rounded px-2 py-1 text-tv-text placeholder:text-tv-text3 focus:outline-none focus:border-tv-blue"
              />
              <button onClick={addPair} className="text-xs px-3 py-1 bg-tv-bg2 border border-tv-border rounded hover:bg-tv-bg3 text-tv-text transition-colors">
                {t("batch.add")}
              </button>
            </div>
          </div>

          {/* Aja / Pysäytä -painike */}
          <div className="flex gap-2">
            <button
              onClick={running ? stopBatch : runBatch}
              className={cn(
                "flex-1 py-2 rounded text-sm font-semibold transition-colors",
                running
                  ? "bg-tv-red-dim text-tv-red border border-tv-red/30 hover:bg-tv-red/20"
                  : "bg-tv-blue/10 text-tv-blue border border-tv-blue/30 hover:bg-tv-blue/20"
              )}
            >
              {running ? `⏹ ${t("batch.stop")}` : `▶ ${t("batch.scan")} ${pairs.length} ${t("batch.pairs")} (${days}${t("batch.days")})`}
            </button>
          </div>

          {/* Edistyminen */}
          {(running || done > 0) && (
            <div className={cn(
              "rounded-lg border px-3 py-2.5 space-y-2",
              running ? "bg-tv-blue-dim border-tv-blue/30" : "bg-tv-green-dim border-tv-green/30"
            )}>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  {running && <span className="w-2 h-2 rounded-full bg-tv-blue animate-pulse inline-block" />}
                  {!running && <span className="text-tv-green">✓</span>}
                  <span className={cn("font-semibold", running ? "text-tv-blue" : "text-tv-green")}>
                    {running
                      ? (isFi ? `Testataan ${current}…` : `Testing ${current}…`)
                      : (isFi ? `Skannaus valmis — ${done} paria analysoitu` : `Scan complete — ${done} pairs analyzed`)}
                  </span>
                </div>
                <span className={cn("font-mono font-bold", running ? "text-tv-blue" : "text-tv-green")}>
                  {done}/{total} · {progress}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-tv-border overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all duration-300", running ? "bg-tv-blue" : "bg-tv-green")}
                  style={{ width: `${progress}%` }}
                />
              </div>
              {bestRow && (
                <div className="text-[10px] text-tv-text2">
                  {isFi ? "Paras tähän mennessä:" : "Best so far:"} <span className="font-semibold text-tv-green">{bestRow.symbol}</span>
                  {" "}— PF {bestRow.profitFactor.toFixed(2)}, WR {bestRow.winRate.toFixed(1)}%, {isFi ? "Tuotto" : "Return"} {bestRow.returnPct >= 0 ? "+" : ""}{bestRow.returnPct.toFixed(1)}%
                </div>
              )}
            </div>
          )}

          {/* Tulostetaulukko */}
          {results.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-tv-text2 text-left border-b border-tv-border">
                    {([
                      ["symbol",       t("batch.col_pair")],
                      ["trades",       t("metric.trades")],
                      ["winRate",      t("batch.col_winrate")],
                      ["profitFactor", "PF"],
                      ["maxDrawdown",  "DD%"],
                      ["returnPct",    isFi ? "Tuotto%" : "Return%"],
                      ["sharpe",       "Sharpe"],
                    ] as [SortKey, string][]).map(([key, label]) => (
                      <th key={key} className="pb-1.5 pr-3 cursor-pointer hover:text-tv-text select-none whitespace-nowrap"
                        onClick={() => toggleSort(key)}>
                        {label}{sortKey === key ? (sortAsc ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                    <th className="pb-1.5">{t("batch.col_action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const isBest = r === bestRow;
                    return (
                      <tr key={r.symbol} className={cn(
                        "border-t border-tv-border",
                        isBest && "bg-tv-green-dim",
                        r.status === "running" && "bg-tv-blue-dim",
                        r.status === "error" && "opacity-40",
                        r.status === "pending" && "opacity-30",
                      )}>
                        <td className="py-1 pr-3 font-semibold text-tv-text">
                          {r.symbol}
                          {isBest && <span className="ml-1 text-[9px] text-tv-green font-bold">{t("batch.best_label")}</span>}
                          {r.status === "running" && <span className="ml-1 text-[9px] text-tv-blue animate-pulse">●</span>}
                          {r.status === "error" && <span className="ml-1 text-[9px] text-tv-red">{t("batch.no_data")}</span>}
                        </td>
                        <td className="py-1 pr-3 text-tv-text2">{r.status === "done" ? r.trades : "—"}</td>
                        <td className={cn("py-1 pr-3 font-mono", r.winRate >= 50 ? "text-tv-green" : r.winRate > 0 ? "text-tv-amber" : "text-tv-text2")}>
                          {r.status === "done" ? `${r.winRate.toFixed(1)}%` : "—"}
                        </td>
                        <td className={cn("py-1 pr-3 font-mono font-semibold",
                          r.profitFactor >= 1.5 ? "text-tv-green" : r.profitFactor >= 1.2 ? "text-tv-amber" : r.profitFactor > 0 ? "text-tv-red" : "text-tv-text2")}>
                          {r.status === "done" ? r.profitFactor.toFixed(2) : "—"}
                        </td>
                        <td className={cn("py-1 pr-3 font-mono", r.maxDrawdown > 15 ? "text-tv-red" : r.maxDrawdown > 10 ? "text-tv-amber" : "text-tv-green")}>
                          {r.status === "done" ? `-${r.maxDrawdown.toFixed(1)}%` : "—"}
                        </td>
                        <td className={cn("py-1 pr-3 font-mono", r.returnPct >= 0 ? "text-tv-green" : "text-tv-red")}>
                          {r.status === "done" ? `${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(1)}%` : "—"}
                        </td>
                        <td className={cn("py-1 pr-3 font-mono", r.sharpe >= 1 ? "text-tv-green" : r.sharpe >= 0 ? "text-tv-amber" : "text-tv-red")}>
                          {r.status === "done" ? r.sharpe.toFixed(2) : "—"}
                        </td>
                        <td className="py-1">
                          {r.status === "done" && (
                            <button
                              onClick={() => setSelectedSymbol(r.symbol)}
                              className="text-[10px] px-2 py-0.5 rounded bg-tv-blue/10 text-tv-blue border border-tv-blue/30 hover:bg-tv-blue/20 transition-colors"
                            >
                              {t("batch.select")}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Käy parhaiden parformen kanssa -painike */}
          {!running && results.some((r) => r.status === "done") && (() => {
            const validated = results.filter(
              (r) => r.status === "done" && r.profitFactor >= MIN_PF_TO_TRADE && r.trades >= MIN_TRADES_TO_TRADE
            );
            if (validated.length === 0) return null;
            return (
              <div className="bg-tv-green-dim border border-tv-green/30 rounded-lg px-3 py-2.5 space-y-2">
                <div className="text-xs font-semibold text-tv-green">
                  ✅ {isFi
                    ? `${validated.length} paria läpäisi validoinnin (PF ≥ ${MIN_PF_TO_TRADE}, kauppoja ≥ ${MIN_TRADES_TO_TRADE})`
                    : `${validated.length} pairs passed validation (PF ≥ ${MIN_PF_TO_TRADE}, trades ≥ ${MIN_TRADES_TO_TRADE})`}
                </div>
                <div className="flex flex-wrap gap-1">
                  {validated.map((r) => (
                    <span key={r.symbol} className="text-[10px] bg-white border border-tv-green/30 text-tv-green rounded px-1.5 py-0.5 font-semibold">
                      {r.symbol.replace("-USDT", "")} PF {r.profitFactor.toFixed(2)}
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => {
                    const syms = validated.map((r) => r.symbol);
                    setActivePairs(syms);
                    setNotification(t("batch.multibot_loaded").replace("{n}", String(syms.length)));
                  }}
                  className="w-full py-2 rounded text-sm font-bold bg-tv-green/10 text-tv-green border border-tv-green/40 hover:bg-tv-green/20 transition-colors"
                >
                  🤖 {isFi ? `Käy parhaiden ${validated.length} parin kanssa` : `Trade with best ${validated.length} pairs`}
                </button>
              </div>
            );
          })()}

        </div>
      )}
    </div>
  );
}
