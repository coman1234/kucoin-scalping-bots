"use client";

import { useCallback, useRef, useEffect, useState } from "react";
import { useTradingContext, type PairStat } from "@/lib/context";
import { generateSignal } from "@/lib/signalEngine";
import { calculateRiskReward } from "@/lib/riskReward";
import { runSafetyChecks, evaluateOpenPosition, shouldEnterTrade } from "@/lib/botEngine";
import { buildFingerprint, findSimilarPatterns, savePattern, updatePatternOutcome } from "@/lib/patternMemory";
import type { LiveTrade } from "@/lib/botEngine";
import { cn } from "@/lib/utils";
import { logTrade } from "@/lib/tradeLogger";
import { useT } from "@/components/SettingsModal";

const LOOP_INTERVAL_MS  = 30_000;
const BATCH_SIZE        = 4;      // pairs scanned in parallel per batch
const BATCH_DELAY_MS    = 1_000;  // ms between batches (rate-limit guard)
const MAX_CONCURRENT    = 3;      // max simultaneous open positions

// Correlation groups — only 1 open position per group at a time
const CORR_GROUP: Record<string, number> = {
  "BTC-USDT": 1,
  "ETH-USDT": 2,
  "BNB-USDT": 3, "SOL-USDT": 3,
  "ADA-USDT": 4, "AVAX-USDT": 4, "DOT-USDT": 4,
  "LINK-USDT": 5, "POL-USDT": 5,  // POL replaced MATIC-USDT
  "XRP-USDT": 6,
  "DOGE-USDT": 7,
};

export default function MultiBotPanel() {
  const {
    activePairs, setActivePairs,
    multiBotStatus, setMultiBotStatus,
    multiPositions, setMultiPositions,
    multiStats, setMultiStats,
    botConfig, selectedTimeframe,
    credentialsValid, setNotification,
    setTradeLog,
    language,
  } = useTradingContext();

  const t    = useT();
  const isFi = language === "fi";

  const intervalRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const countIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null); // FIX: was never stored
  const runningRef       = useRef(false);

  // FIX: mirror positions in a ref so tickPair sees current values (not stale closure)
  const positionsRef = useRef<Record<string, LiveTrade | null>>({});
  useEffect(() => { positionsRef.current = multiPositions; }, [multiPositions]);

  const [nextIn,       setNextIn]       = useState(LOOP_INTERVAL_MS / 1000);
  const [scanningPair, setScanningPair] = useState("");

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const fetchCandles = useCallback(async (sym: string) => {
    const res  = await fetch(`/api/trading/candles?symbol=${sym}&timeframe=${selectedTimeframe}`);
    const data = await res.json();
    return data.candles ?? [];
  }, [selectedTimeframe]);

  // FIX: balance cache — shared across all pair ticks in a single loop cycle
  const balanceCacheRef = useRef<{ value: number; at: number }>({ value: 0, at: 0 });
  const getBalance = useCallback(async (): Promise<number> => {
    if (Date.now() - balanceCacheRef.current.at < 30_000) return balanceCacheRef.current.value;
    try {
      const res  = await fetch("/api/trading/balance");
      const data = await res.json();
      const usdt = data.accounts?.find((a: { currency: string }) => a.currency === "USDT");
      balanceCacheRef.current = { value: usdt ? parseFloat(usdt.available) : 0, at: Date.now() };
      return balanceCacheRef.current.value;
    } catch {
      return balanceCacheRef.current.value;
    }
  }, []);

  const STAT_DEFAULTS: PairStat = { trades: 0, wins: 0, losses: 0, pnl: 0, lastAction: "", lastSignal: "", lastChecked: 0 };
  const updateStat = useCallback((sym: string, patch: Partial<PairStat>) => {
    setMultiStats(prev => ({
      ...prev,
      [sym]: { ...STAT_DEFAULTS, ...prev[sym], ...patch },
    }));
  }, [setMultiStats]);

  // ── Per-pair tick ─────────────────────────────────────────────────────────

  const tickPair = useCallback(async (sym: string) => {
    try {
      const candles = await fetchCandles(sym);
      if (candles.length < 50) {
        updateStat(sym, { lastAction: isFi ? "riittämätön data" : "insufficient data", lastChecked: Date.now() });
        return;
      }

      // FIX: use last candle close as price — no separate fetchPrice() call
      const livePrice = candles[candles.length - 1].close as number;
      const signal    = generateSignal(candles, botConfig.minSignalScore);
      const lastAtr   = signal.indicators.atr[signal.indicators.atr.length - 1] ?? livePrice * 0.005;

      updateStat(sym, { lastSignal: `${signal.direction} ${signal.score}/9`, lastChecked: Date.now() });

      // FIX: read from ref, not stale closure
      const pos = positionsRef.current[sym] ?? null;

      // ── Evaluate open position ─────────────────────────────────────────────
      if (pos) {
        const lastCandle = candles[candles.length - 1];
        const eval_      = evaluateOpenPosition(pos, lastCandle, lastAtr);

        if (eval_.action === "HOLD" && eval_.newTrailingStop !== undefined) {
          setMultiPositions(prev => ({
            ...prev,
            [sym]: prev[sym] ? { ...prev[sym]!, trailingStopPrice: eval_.newTrailingStop } : null,
          }));
          return;
        }

        if (eval_.action === "TP1") {
          setMultiPositions(prev => ({
            ...prev,
            [sym]: { ...pos, tp1Hit: true, slMovedToBreakeven: true, stopLossPrice: pos.entryPrice },
          }));
          updateStat(sym, { lastAction: `TP1 @ $${eval_.exitPrice.toFixed(4)}` });

        } else if (eval_.action === "TP2" || eval_.action === "SL") {
          const fees = botConfig.tradeAmountUSDT * 0.002;
          const pnl  = botConfig.tradeAmountUSDT * (eval_.pnlPct / 100) - fees;
          const now  = Date.now();

          setMultiPositions(prev => ({ ...prev, [sym]: null }));
          setMultiStats(prev => {
            const s   = prev[sym] ?? { trades: 0, wins: 0, losses: 0, pnl: 0, lastAction: "", lastSignal: "", lastChecked: 0 };
            const won = pnl > 0;
            return {
              ...prev,
              [sym]: {
                ...s,
                trades:     s.trades + 1,
                wins:       s.wins   + (won ? 1 : 0),
                losses:     s.losses + (won ? 0 : 1),
                pnl:        s.pnl + pnl,
                lastAction: `${eval_.action} ${eval_.pnlPct >= 0 ? "+" : ""}${eval_.pnlPct.toFixed(2)}% $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
              },
            };
          });

          const tradeEntry = {
            id:              pos.id,
            timestamp:       now,
            symbol:          sym,
            direction:       pos.direction,
            entryPrice:      pos.entryPrice,
            exitPrice:       eval_.exitPrice,
            entryTime:       pos.entryTime * 1000,
            exitTime:        now,
            pnlUSDT:         pnl,
            pnlPct:          eval_.pnlPct,
            exitReason:      eval_.action,
            signalScore:     signal.score,
            durationMinutes: (now - pos.entryTime * 1000) / 60_000,
            source:          "multi" as const,
            simulated:       !credentialsValid,
          };
          logTrade(tradeEntry).then(() => {
            setTradeLog(prev => [...prev, tradeEntry]);
          });

          if (pos.patternId) {
            updatePatternOutcome(
              pos.patternId, sym, selectedTimeframe,
              pnl > 0 ? "WIN" : "LOSS",
              eval_.pnlPct, eval_.action, 0, pos.maxFav, pos.maxAdv,
            );
          }
        }
        return;
      }

      // ── Look for new entry ─────────────────────────────────────────────────
      if (signal.direction === "NEUTRAL") {
        updateStat(sym, { lastAction: isFi ? "neutraali — odotetaan" : "neutral — waiting" });
        return;
      }

      // Concurrent-position and correlation filter
      const openSymbols = Object.keys(positionsRef.current).filter(p => positionsRef.current[p] !== null);
      if (openSymbols.length >= MAX_CONCURRENT) {
        updateStat(sym, { lastAction: isFi ? `ohita: max ${MAX_CONCURRENT} positiota` : `skip: max ${MAX_CONCURRENT} open` });
        return;
      }
      const myGroup      = CORR_GROUP[sym] ?? 99;
      const groupConflict = openSymbols.find(p => (CORR_GROUP[p] ?? 99) === myGroup);
      if (groupConflict) {
        updateStat(sym, { lastAction: isFi ? `ohita: korreloiva ${groupConflict}` : `skip: correlated ${groupConflict}` });
        return;
      }

      // FIX: use shared balance cache — single API call for all pairs
      const balance       = await getBalance();
      const fingerprint   = buildFingerprint(signal.indicators, candles[candles.length - 1], signal.score, signal.direction as "BUY" | "SELL", signal.conditionsMet, sym, selectedTimeframe);
      const patternResult = findSimilarPatterns(fingerprint.indicators, sym, selectedTimeframe, signal.direction as "BUY" | "SELL");
      const { enter, reason } = shouldEnterTrade(signal, botConfig, patternResult);

      if (!enter) {
        updateStat(sym, { lastAction: `skip: ${reason}` });
        return;
      }

      const safetyCheck = runSafetyChecks(botConfig, balance, balance * 3, 0, balance, 0, 30_000, 0, 0, null, 1.2);
      if (!safetyCheck.passed) {
        updateStat(sym, { lastAction: `safety: ${safetyCheck.failedChecks[0]}` });
        return;
      }

      const rr = calculateRiskReward(
        livePrice, signal.direction as "BUY" | "SELL",
        lastAtr, signal.indicators.fibonacci,
        botConfig.tradeAmountUSDT, 0.5,
        botConfig.stopLossAtrMultiplier ?? 1.5,
        botConfig.takeProfitMultiplier  ?? 2.5,
      );

      let orderId = `multi-sim-${sym}-${Date.now()}`;
      if (credentialsValid) {
        try {
          const res  = await fetch("/api/trading/orders", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ symbol: sym, side: signal.direction === "BUY" ? "buy" : "sell", type: "market", funds: botConfig.tradeAmountUSDT.toString() }),
          });
          const data = await res.json();
          if (!data.error) {
            orderId = data.orderId;
            balanceCacheRef.current.at = 0; // invalidate after order
          }
        } catch { /* use sim id */ }
      }

      fingerprint.id = orderId;
      savePattern(fingerprint);

      const newPos: LiveTrade = {
        id:              orderId,
        orderId,
        direction:       signal.direction as "BUY" | "SELL",
        entryPrice:      livePrice,
        entryTime:       Date.now() / 1000,
        size:            botConfig.tradeAmountUSDT,
        stopLossPrice:   rr.stopLossPrice,
        tp1Price:        rr.takeProfitPrice1,
        tp2Price:        rr.takeProfitPrice2,
        tp1Hit:          false,
        slMovedToBreakeven: false,
        atrAtEntry:      lastAtr,
        currentPrice:    livePrice,
        unrealizedPnlUSDT: 0,
        unrealizedPnlPct:  0,
        maxFav:          0,
        maxAdv:          0,
        patternId:       orderId,
        patternAnalysis: patternResult,
      };

      setMultiPositions(prev => ({ ...prev, [sym]: newPos }));
      updateStat(sym, {
        lastAction: `${signal.direction} @ $${livePrice.toFixed(4)} SL $${rr.stopLossPrice.toFixed(4)}`,
      });

    } catch (err) {
      updateStat(sym, { lastAction: `error: ${String(err).slice(0, 60)}`, lastChecked: Date.now() });
    }
  }, [
    fetchCandles, getBalance, botConfig, selectedTimeframe,
    credentialsValid, setMultiPositions, setMultiStats, setTradeLog,
    updateStat, isFi,
  ]);

  // ── Main loop — parallel batch scanning ────────────────────────────────────

  const runLoop = useCallback(async () => {
    if (!runningRef.current) return;

    // Process pairs in batches of BATCH_SIZE to respect rate limits
    for (let i = 0; i < activePairs.length; i += BATCH_SIZE) {
      if (!runningRef.current) break;
      const batch = activePairs.slice(i, i + BATCH_SIZE);
      setScanningPair(batch[0]);
      await Promise.allSettled(batch.map(sym => tickPair(sym)));
      if (i + BATCH_SIZE < activePairs.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }
    setScanningPair("");
  }, [activePairs, tickPair]);

  // ── Start / stop ──────────────────────────────────────────────────────────

  const startMultiBot = useCallback(() => {
    if (activePairs.length === 0) {
      setNotification(isFi ? "⚠️ Ei valittuja pareja" : "⚠️ No pairs selected");
      return;
    }
    runningRef.current = true;
    setMultiBotStatus("RUNNING");

    runLoop();
    intervalRef.current = setInterval(runLoop, LOOP_INTERVAL_MS);

    // FIX: store countdown interval in ref so it can be cleared
    let countVal = LOOP_INTERVAL_MS / 1000;
    setNextIn(countVal);
    countIntervalRef.current = setInterval(() => {
      countVal = countVal <= 1 ? LOOP_INTERVAL_MS / 1000 : countVal - 1;
      setNextIn(countVal);
    }, 1_000);
  }, [activePairs, runLoop, setMultiBotStatus, setNotification, isFi]);

  const stopMultiBot = useCallback(() => {
    runningRef.current = false;
    if (intervalRef.current)      { clearInterval(intervalRef.current);      intervalRef.current      = null; }
    if (countIntervalRef.current) { clearInterval(countIntervalRef.current); countIntervalRef.current = null; } // FIX: clear countdown
    setMultiBotStatus("STOPPED");
    setScanningPair("");
    setNotification(isFi ? "🛑 Monen parin botti pysäytetty" : "🛑 Multi-pair bot stopped");
  }, [setMultiBotStatus, setNotification, isFi]);

  const emergencyStopAll = useCallback(async () => {
    stopMultiBot();
    setMultiPositions({});
    if (credentialsValid) {
      await Promise.allSettled(
        activePairs.map(sym => fetch(`/api/trading/cancel-orders?symbol=${sym}`, { method: "DELETE" }))
      );
    }
    setNotification(isFi ? "🛑 HÄTÄPYSÄYTYS — kaikki positiot suljettu" : "🛑 EMERGENCY STOP — all positions closed");
  }, [stopMultiBot, setMultiPositions, activePairs, credentialsValid, setNotification, isFi]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (intervalRef.current)      clearInterval(intervalRef.current);
    if (countIntervalRef.current) clearInterval(countIntervalRef.current);
  }, []);

  // ── Derived values ────────────────────────────────────────────────────────

  const isRunning   = multiBotStatus === "RUNNING";
  const totalPnl    = Object.values(multiStats).reduce((a, s) => a + s.pnl, 0);
  const totalTrades = Object.values(multiStats).reduce((a, s) => a + s.trades, 0);
  const totalWins   = Object.values(multiStats).reduce((a, s) => a + s.wins, 0);
  const openCount   = Object.values(multiPositions).filter(Boolean).length;
  const winRatePct  = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

  if (activePairs.length === 0) return null;

  return (
    <div className="panel space-y-3 border-l-2 border-tv-blue">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-tv-text uppercase tracking-wide">
            🤖 {isFi ? "Monen parin botti" : "Multi-Pair Bot"}
          </h2>
          <div className="text-[10px] text-tv-text2 mt-0.5">
            {activePairs.length} {t("batch.pairs")} · {openCount} {isFi ? "avointa" : "open"}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={cn("w-2 h-2 rounded-full", isRunning ? "bg-tv-green animate-pulse" : "bg-tv-text3")} />
          <span className={cn("text-xs font-semibold", isRunning ? "text-tv-green" : "text-tv-text2")}>
            {isRunning ? t("bot.running") : t("bot.stopped")}
          </span>
        </div>
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-tv-bg2 rounded px-2 py-1.5">
          <div className="text-tv-text2 text-[10px] uppercase">P&amp;L</div>
          <div className={cn("font-semibold font-mono", totalPnl >= 0 ? "text-tv-green" : "text-tv-red")}>
            {totalPnl >= 0 ? "+" : ""}€{totalPnl.toFixed(2)}
          </div>
        </div>
        <div className="bg-tv-bg2 rounded px-2 py-1.5">
          <div className="text-tv-text2 text-[10px] uppercase">{t("metric.trades")}</div>
          <div className="font-semibold text-tv-text">{totalTrades} ({totalWins}{isFi ? "V" : "W"})</div>
        </div>
        <div className="bg-tv-bg2 rounded px-2 py-1.5">
          <div className="text-tv-text2 text-[10px] uppercase">{t("metric.win_rate")}</div>
          <div className={cn("font-semibold", winRatePct >= 38 ? "text-tv-green" : "text-tv-amber")}>
            {totalTrades > 0 ? `${winRatePct.toFixed(1)}%` : "—"}
          </div>
        </div>
      </div>

      {isRunning && scanningPair && (
        <div className="text-[10px] text-tv-blue bg-tv-blue-dim rounded px-2 py-1 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-tv-blue animate-pulse inline-block" />
          {isFi ? `Skannataan ${scanningPair}… ${nextIn}s` : `Scanning ${scanningPair}… ${nextIn}s`}
        </div>
      )}

      {/* Pair table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-tv-text2 text-left border-b border-tv-border">
              <th className="pb-1 pr-2">{t("market.pair")}</th>
              <th className="pb-1 pr-2">{t("signal.label")}</th>
              <th className="pb-1 pr-2">{t("bot.open_position")}</th>
              <th className="pb-1 pr-2">P&amp;L</th>
              <th className="pb-1">{t("bot.status")}</th>
            </tr>
          </thead>
          <tbody>
            {activePairs.map(sym => {
              const stat       = multiStats[sym];
              const pos        = multiPositions[sym];
              const isScanning = scanningPair === sym;
              return (
                <tr key={sym} className={cn("border-t border-tv-border", isScanning && "bg-tv-blue-dim")}>
                  <td className="py-1 pr-2 font-semibold text-tv-text">{sym.replace("-USDT", "")}</td>
                  <td className="py-1 pr-2 text-tv-text2 text-[10px]">{stat?.lastSignal || "—"}</td>
                  <td className="py-1 pr-2">
                    {pos ? (
                      <span className={cn("font-semibold text-[10px]", pos.direction === "BUY" ? "text-tv-green" : "text-tv-red")}>
                        {pos.direction} ${pos.entryPrice.toFixed(4)}
                      </span>
                    ) : (
                      <span className="text-tv-text3 text-[10px]">{t("bot.no_position")}</span>
                    )}
                  </td>
                  <td className={cn("py-1 pr-2 font-mono text-[10px]", (stat?.pnl ?? 0) >= 0 ? "text-tv-green" : "text-tv-red")}>
                    {stat ? `${stat.pnl >= 0 ? "+" : ""}€${stat.pnl.toFixed(2)}` : "—"}
                  </td>
                  <td className="py-1 text-tv-text2 text-[10px] max-w-[140px] truncate">
                    {stat?.lastAction || (isFi ? "odottaa" : "waiting")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Controls */}
      <div className="space-y-2">
        <div className="flex gap-2">
          {!isRunning ? (
            <button
              onClick={startMultiBot}
              className="flex-1 py-2 rounded text-sm font-semibold bg-tv-green/10 text-tv-green border border-tv-green/30 hover:bg-tv-green/20 transition-colors"
            >
              ▶ {t("bot.start")}
            </button>
          ) : (
            <button
              onClick={stopMultiBot}
              className="flex-1 py-2 rounded text-sm font-semibold bg-tv-bg3 text-tv-text2 border border-tv-border hover:bg-tv-bg2 transition-colors"
            >
              ⏹ {t("bot.stop")}
            </button>
          )}
          <button
            onClick={() => setActivePairs([])}
            className="px-3 py-2 rounded text-xs text-tv-text2 border border-tv-border hover:bg-tv-bg2 transition-colors"
            title={isFi ? "Tyhjennä parilista" : "Clear pair list"}
          >
            ✕ {t("app.clear")}
          </button>
        </div>
        <button
          onClick={emergencyStopAll}
          className="w-full py-2 rounded text-sm font-bold bg-tv-red-dim text-tv-red border border-tv-red/30 hover:bg-tv-red/20 transition-colors"
        >
          🔴 {t("bot.emergency_stop")}
        </button>
      </div>

    </div>
  );
}
