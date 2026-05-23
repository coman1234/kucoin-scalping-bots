"use client";

/**
 * AutoOptimizer — Multi-pair parallel optimizer
 *
 * Phase 1: Fetches 14 days of candle data for all 20 pairs simultaneously.
 * Phase 2: Tests 576 parameter combinations; early-stops when combined
 *          out-of-sample win rate exceeds 50% and PF > 1.2.
 * Uses walk-forward 70/30 split to prevent overfitting.
 */

import { useState, useCallback, useRef, useEffect, type MutableRefObject } from "react";
import { useTradingContext } from "@/lib/context";
import {
  buildParamGrid,
  runParamSet,
  pickBest,
  TOP_20_PAIRS,
  type OptimizerCandidate,
  WIN_RATE_TARGET,
  PROFIT_FACTOR_TARGET,
} from "@/lib/autoOptimizer";
import type { KuCoinCandle } from "@/lib/kucoinPublic";
import { cn } from "@/lib/utils";
import { useT } from "@/components/SettingsModal";
import { logActivity } from "@/lib/activityLog";

// ── Tuning constants ──────────────────────────────────────────────────────────
const BATCH_SIZE            = 8;           // combinations per UI-yield cycle
const FETCH_DAYS            = 14;          // days of history to pull per pair
const MIN_TRADES_TO_TRIGGER = 5;
const MIN_REOPT_INTERVAL_MS = 60 * 60 * 1000;
const SCHEDULE_INTERVAL_MS  = 24 * 60 * 60 * 1000;
const CONSECUTIVE_LOSS_LIMIT = 5;
const WIN_RATE_FLOOR        = 33;   // re-optimize when live drops below break-even
const DIVERGENCE_THRESHOLD  = 10;

// ── localStorage persistence ──────────────────────────────────────────────────
const STORAGE_KEY = "scalping_optimizerState";

interface PersistedOptimizerState {
  best: OptimizerCandidate | null;
  candidates: OptimizerCandidate[];   // top-8 only
  status: string;
  applied: boolean;
  feedbackEnabled: boolean;
  feedbackLog: FeedbackEvent[];
  lastOptAt: number;
  lastBestWinRate: number;
}

interface FeedbackEvent {
  time: number;
  reason: string;
  resultWinRate: number | null;
}

type FetchStatus = "idle" | "loading" | "ok" | "error";

interface Props {
  autoRunRef?: MutableRefObject<(() => void) | null>;
}

export default function AutoOptimizer({ autoRunRef }: Props) {
  const {
    selectedTimeframe,
    botConfig, setBotConfig,
    tradeLog,
    botStatus, multiBotStatus,
    language,
  } = useTradingContext();
  const t   = useT();
  const isFi = language === "fi";

  // ── UI state ──────────────────────────────────────────────────────────────
  const [open,            setOpen]            = useState(false);
  const [phase,           setPhase]           = useState<"idle" | "fetching" | "optimizing" | "done">("idle");
  const [pairStatus,      setPairStatus]      = useState<Record<string, FetchStatus>>({});
  const [candlesMap,      setCandlesMap]      = useState<Record<string, KuCoinCandle[]>>({});
  const [pairsReady,      setPairsReady]      = useState(0);
  const [progress,        setProgress]        = useState(0);
  const [total,           setTotal]           = useState(576);
  const [candidates,      setCandidates]      = useState<OptimizerCandidate[]>([]);
  const [best,            setBest]            = useState<OptimizerCandidate | null>(null);
  const [status,          setStatus]          = useState("");
  const [applied,         setApplied]         = useState(false);
  const [feedbackEnabled, setFeedbackEnabled] = useState(false);
  const [feedbackLog,     setFeedbackLog]     = useState<FeedbackEvent[]>([]);
  const [pendingReason,   setPendingReason]   = useState("");

  const abortRef           = useRef(false);
  const runningRef         = useRef(false);
  const lastOptAtRef       = useRef<number>(0);
  const lastBestWinRateRef = useRef<number>(0);

  // ── Restore state from localStorage on mount ─────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<PersistedOptimizerState>;
      if (s.best)                   { setBest(s.best); setPhase("done"); }
      if (s.candidates?.length)     setCandidates(s.candidates);
      if (s.status)                 setStatus(s.status);
      if (s.applied   != null)      setApplied(s.applied);
      if (s.feedbackEnabled != null) setFeedbackEnabled(s.feedbackEnabled);
      if (s.feedbackLog?.length)    setFeedbackLog(s.feedbackLog);
      if (s.lastOptAt)              lastOptAtRef.current       = s.lastOptAt;
      if (s.lastBestWinRate)        lastBestWinRateRef.current = s.lastBestWinRate;
    } catch { /* corrupt storage — ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Apply best config ─────────────────────────────────────────────────────
  const applyConfig = useCallback((c: OptimizerCandidate) => {
    setBotConfig({
      ...botConfig,
      minSignalScore:        c.params.minSignalScore,
      stopLossAtrMultiplier: c.params.stopLossAtrMultiplier,
      takeProfitMultiplier:  c.params.takeProfitMultiplier,
    });
    setApplied(true);
  }, [botConfig, setBotConfig]);

  // ── Phase 1: Fetch all 20 pairs in parallel ───────────────────────────────
  const fetchAllPairs = useCallback(async (): Promise<Record<string, KuCoinCandle[]> | null> => {
    setPhase("fetching");
    abortRef.current = false;
    const initStatus: Record<string, FetchStatus> = {};
    TOP_20_PAIRS.forEach(p => { initStatus[p] = "loading"; });
    setPairStatus(initStatus);
    setPairsReady(0);

    const endAt   = Math.floor(Date.now() / 1000);
    const startAt = endAt - FETCH_DAYS * 24 * 3600;

    const fetchPair = async (sym: string): Promise<[string, KuCoinCandle[]]> => {
      try {
        const res  = await fetch(
          `/api/trading/candles?symbol=${sym}&timeframe=${selectedTimeframe}&startAt=${startAt}&endAt=${endAt}`
        );
        const data = await res.json();
        const candles: KuCoinCandle[] = data.candles ?? [];
        setPairStatus(prev => ({ ...prev, [sym]: candles.length >= 80 ? "ok" : "error" }));
        setPairsReady(prev => prev + 1);
        return [sym, candles];
      } catch {
        setPairStatus(prev => ({ ...prev, [sym]: "error" }));
        setPairsReady(prev => prev + 1);
        return [sym, []];
      }
    };

    // Truly parallel fetch — all 20 at once
    const entries = await Promise.all(TOP_20_PAIRS.map(fetchPair));
    const map: Record<string, KuCoinCandle[]> = {};
    let validPairs = 0;
    for (const [sym, candles] of entries) {
      if (candles.length >= 80) { map[sym] = candles; validPairs++; }
    }

    if (validPairs < 3) {
      setStatus(isFi
        ? `⚠️ Vain ${validPairs} paria saatavilla — tarvitaan vähintään 3`
        : `⚠️ Only ${validPairs} pairs available — need at least 3`);
      setPhase("idle");
      runningRef.current = false;
      return null;
    }

    setCandlesMap(map);
    return map;
  }, [selectedTimeframe, isFi]);

  // ── Phase 2: Grid search with early-stop ─────────────────────────────────
  const runOptimizer = useCallback(async (triggerReason?: string) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setProgress(0);
    setCandidates([]);
    setBest(null);
    setApplied(false);

    const label = triggerReason ? `[Auto] ${triggerReason}` : (isFi ? "Manuaalinen" : "Manual");
    setStatus(`🔍 ${label}`);

    try {
      // ── Phase 1: fetch ───────────────────────────────────────────────────
      const map = await fetchAllPairs();
      if (!map || abortRef.current) {
        runningRef.current = false;
        return;
      }

      const validCount = Object.keys(map).length;
      setPhase("optimizing");

      // ── Phase 2: optimise ────────────────────────────────────────────────
      const grid = buildParamGrid();
      setTotal(grid.length);
      setStatus(isFi
        ? `🔬 Testataan ${grid.length} yhdistelmää × ${validCount} paria (walk-forward 70/30)...`
        : `🔬 Testing ${grid.length} combinations × ${validCount} pairs (walk-forward 70/30)...`);

      const allResults: OptimizerCandidate[] = [];
      let earlyStop = false;

      for (let i = 0; i < grid.length; i += BATCH_SIZE) {
        if (abortRef.current) break;

        const batch = grid.slice(i, Math.min(i + BATCH_SIZE, grid.length));
        for (const params of batch) {
          const candidate = runParamSet(map, botConfig.tradeAmountUSDT, params, selectedTimeframe);
          allResults.push(candidate);

          // Early-stop: first config that clears both targets
          if (candidate.meetsTarget) {
            earlyStop = true;
          }
        }

        const done = Math.min(i + BATCH_SIZE, grid.length);
        setProgress(done);
        const cur = pickBest(allResults);
        setBest(cur);
        setCandidates([...allResults]);

        if (cur) {
          setStatus(cur.meetsTarget
            ? (isFi
                ? `✅ ${WIN_RATE_TARGET}%+ löydetty! Win: ${cur.winRate.toFixed(1)}% · PF: ${cur.profitFactor.toFixed(2)} · ${cur.pairsWithTarget}/${validCount} paria tavoitteessa`
                : `✅ ${WIN_RATE_TARGET}%+ found! Win: ${cur.winRate.toFixed(1)}% · PF: ${cur.profitFactor.toFixed(2)} · ${cur.pairsWithTarget}/${validCount} pairs on target`)
            : (isFi
                ? `Testataan ${done}/${grid.length}... paras: ${cur.winRate.toFixed(1)}% · PF: ${cur.profitFactor.toFixed(2)}`
                : `Testing ${done}/${grid.length}... best: ${cur.winRate.toFixed(1)}% · PF: ${cur.profitFactor.toFixed(2)}`));
        }

        await new Promise(r => setTimeout(r, 0));  // yield to UI

        // Early stop after scanning at least 1 full batch past the target
        if (earlyStop && done >= i + BATCH_SIZE * 2) break;
      }

      const finalBest = pickBest(allResults);
      setBest(finalBest);
      setPhase("done");
      lastOptAtRef.current = Date.now();

      if (finalBest) {
        lastBestWinRateRef.current = finalBest.winRate;
        applyConfig(finalBest);

        logActivity({
          type: "OPTIMIZER",
          severity: finalBest.meetsTarget ? "success" : "warning",
          title: finalBest.meetsTarget
            ? `Optimizer: ${finalBest.winRate.toFixed(1)}% win · PF ${finalBest.profitFactor.toFixed(2)} · ${finalBest.pairsWithTarget}/${finalBest.pairResults.length} pairs`
            : `Optimizer best: ${finalBest.winRate.toFixed(1)}% (below ${WIN_RATE_TARGET}% target)`,
          detail: `Score ${finalBest.params.minSignalScore}/9 · SL×${finalBest.params.stopLossAtrMultiplier} · TP×${finalBest.params.takeProfitMultiplier} · RSI<${finalBest.params.rsiOversoldThreshold} · Vol×${finalBest.params.volumeMultiplier} · ${finalBest.totalTrades} trades · Sharpe ${finalBest.sharpeRatio.toFixed(2)}${triggerReason ? ` · Trigger: ${triggerReason}` : ""}`,
          value: finalBest.winRate,
        });

        const msg = finalBest.meetsTarget
          ? (isFi
              ? `✅ Valmis — ${finalBest.winRate.toFixed(1)}% osuma · PF ${finalBest.profitFactor.toFixed(2)} · ${finalBest.pairsWithTarget}/${validCount} paria. Parametrit otettu käyttöön.`
              : `✅ Done — ${finalBest.winRate.toFixed(1)}% win rate · PF ${finalBest.profitFactor.toFixed(2)} · ${finalBest.pairsWithTarget}/${validCount} pairs. Parameters applied.`)
          : (isFi
              ? `⚠️ Paras: ${finalBest.winRate.toFixed(1)}% (alle ${WIN_RATE_TARGET}% tavoitteen). Otettu käyttöön joka tapauksessa.`
              : `⚠️ Best: ${finalBest.winRate.toFixed(1)}% (below ${WIN_RATE_TARGET}% target). Applied anyway.`);
        setStatus(msg);

        if (triggerReason) {
          setFeedbackLog(prev => [
            { time: Date.now(), reason: triggerReason, resultWinRate: finalBest.winRate },
            ...prev.slice(0, 9),
          ]);
        }
      } else {
        setStatus(isFi ? "❌ Kelvollisia tuloksia ei löydy." : "❌ No valid results found.");
      }
    } catch (err) {
      setStatus(`❌ ${err}`);
      setPhase("idle");
    }

    runningRef.current = false;
  }, [selectedTimeframe, botConfig, applyConfig, fetchAllPairs, isFi]);

  // ── Register autoRunRef so AutoPilot can trigger optimization ────────────
  useEffect(() => {
    if (autoRunRef) autoRunRef.current = () => runOptimizer("AutoPilot");
    return () => { if (autoRunRef) autoRunRef.current = null; };
  }, [autoRunRef, runOptimizer]);

  // ── Auto-open panel when optimization is running ──────────────────────────
  useEffect(() => {
    if (phase === "fetching" || phase === "optimizing") setOpen(true);
  }, [phase]);

  // ── Feedback-loop: watches tradeLog ──────────────────────────────────────
  useEffect(() => {
    if (!feedbackEnabled) return;
    if (tradeLog.length < MIN_TRADES_TO_TRIGGER) return;
    const now = Date.now();
    if (now - lastOptAtRef.current < MIN_REOPT_INTERVAL_MS) return;

    let consecutiveLosses = 0;
    for (let i = tradeLog.length - 1; i >= 0; i--) {
      if (tradeLog[i].pnlUSDT <= 0) consecutiveLosses++;
      else break;
    }
    const recent        = tradeLog.slice(-10);
    const recentWinRate = recent.length >= MIN_TRADES_TO_TRIGGER
      ? (recent.filter(t => t.pnlUSDT > 0).length / recent.length) * 100
      : 100;
    const divergence = lastBestWinRateRef.current > 0
      ? lastBestWinRateRef.current - recentWinRate : 0;
    const scheduledDue  = lastOptAtRef.current > 0 && now - lastOptAtRef.current >= SCHEDULE_INTERVAL_MS;

    let reason = "";
    if (consecutiveLosses >= CONSECUTIVE_LOSS_LIMIT)
      reason = isFi ? `${consecutiveLosses} peräkkäistä tappiota` : `${consecutiveLosses} consecutive losses`;
    else if (recent.length >= 10 && recentWinRate < WIN_RATE_FLOOR)
      reason = isFi ? `live-osuma laski ${recentWinRate.toFixed(0)}%:iin` : `live win rate dropped to ${recentWinRate.toFixed(0)}%`;
    else if (divergence >= DIVERGENCE_THRESHOLD && recent.length >= 10)
      reason = isFi
        ? `live ${recentWinRate.toFixed(0)}% vs historiatesti ${lastBestWinRateRef.current.toFixed(0)}%`
        : `live ${recentWinRate.toFixed(0)}% vs backtest ${lastBestWinRateRef.current.toFixed(0)}%`;
    else if (scheduledDue)
      reason = isFi ? "24 h aikataulutettu uudelleenajo" : "24-hour scheduled re-run";

    if (reason) setPendingReason(reason);
  }, [tradeLog, feedbackEnabled, isFi]);

  useEffect(() => {
    if (!pendingReason || runningRef.current) return;
    const r = pendingReason;
    setPendingReason("");
    runOptimizer(r);
  }, [pendingReason, runOptimizer]);

  // ── Persist optimizer results to localStorage (survives page refresh) ─────
  // Only writes when idle/done — avoids hammering storage during optimization.
  useEffect(() => {
    if (!best || phase === "fetching" || phase === "optimizing") return;
    try {
      const state: PersistedOptimizerState = {
        best,
        candidates: [...candidates].sort((a, b) => b.score - a.score).slice(0, 8),
        status,
        applied,
        feedbackEnabled,
        feedbackLog,
        lastOptAt:       lastOptAtRef.current,
        lastBestWinRate: lastBestWinRateRef.current,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* storage full — ignore */ }
  }, [best, candidates, status, applied, feedbackEnabled, feedbackLog, phase]);

  // ── Derived display values ────────────────────────────────────────────────
  const isRunning     = phase === "fetching" || phase === "optimizing";
  const pct           = total > 0 ? Math.round((progress / total) * 100) : 0;
  const sortedTop     = [...candidates].sort((a, b) => b.score - a.score).slice(0, 8);
  const targetCount   = candidates.filter(c => c.meetsTarget).length;
  const isActive      = botStatus === "RUNNING" || multiBotStatus === "RUNNING";
  const pairsLoaded   = Object.keys(candlesMap).length;

  const recentLive    = tradeLog.slice(-10);
  const liveWinRate   = recentLive.length >= 5
    ? (recentLive.filter(t => t.pnlUSDT > 0).length / recentLive.length) * 100
    : null;
  let liveLosses = 0;
  for (let i = tradeLog.length - 1; i >= 0; i--) {
    if (tradeLog[i].pnlUSDT <= 0) liveLosses++;
    else break;
  }

  return (
    <div className="panel border-l-2 border-tv-purple">

      {/* ── Header ── */}
      <button onClick={() => setOpen(v => !v)} className="w-full flex items-center justify-between">
        <span className="text-sm font-semibold text-tv-text uppercase tracking-wide flex items-center gap-2 flex-wrap">
          🔬 {t("optimizer.title")}
          {feedbackEnabled && (
            <span className="text-[9px] bg-tv-purple/20 text-tv-purple px-1.5 py-0.5 rounded font-semibold normal-case">
              {isFi ? "PALAUTESILMUKKA PÄÄLLÄ" : "FEEDBACK LOOP ON"}
            </span>
          )}
          {isRunning && (
            <span className="text-[9px] bg-tv-blue/20 text-tv-blue px-1.5 py-0.5 rounded animate-pulse normal-case">
              {phase === "fetching"
                ? (isFi ? `HAETAAN ${pairsReady}/20` : `FETCHING ${pairsReady}/20`)
                : (isFi ? `OPTIMOIDAAN ${pct}%` : `OPTIMIZING ${pct}%`)}
            </span>
          )}
          {phase === "done" && best?.meetsTarget && (
            <span className="text-[9px] bg-tv-green/20 text-tv-green px-1.5 py-0.5 rounded font-semibold normal-case">
              ✅ {best.winRate.toFixed(1)}%
            </span>
          )}
        </span>
        <span className="text-tv-text2 text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">

          {/* ── Coverage badge ── */}
          <div className="text-[10px] text-tv-text2 flex items-center gap-2 flex-wrap">
            <span className="font-semibold">
              {isFi ? "🌐 Kaikki 20 paria — samanaikaisesti" : "🌐 All 20 pairs — simultaneously"}
            </span>
            {pairsLoaded > 0 && !isRunning && (
              <span className="text-tv-green">{pairsLoaded}/20 {isFi ? "ladattu" : "loaded"}</span>
            )}
            <span className="text-tv-text3">
              · {isFi ? "Walk-forward 70/30 split · 576 yhdistelmää" : "Walk-forward 70/30 split · 576 combinations"}
            </span>
          </div>

          {/* ── Pair fetch progress ── */}
          {phase === "fetching" && (
            <div>
              <div className="text-[10px] text-tv-text2 mb-1.5">
                {isFi ? `Haetaan ${FETCH_DAYS} päivän data (${pairsReady}/20)...` : `Fetching ${FETCH_DAYS}-day history (${pairsReady}/20)...`}
              </div>
              <div className="grid grid-cols-10 gap-1">
                {TOP_20_PAIRS.map(sym => {
                  const s = pairStatus[sym] ?? "loading";
                  return (
                    <div key={sym}
                      title={sym}
                      className={cn("rounded text-[8px] font-bold py-0.5 text-center truncate",
                        s === "ok"      ? "bg-tv-green/20 text-tv-green" :
                        s === "error"   ? "bg-tv-red/20 text-tv-red" :
                        s === "loading" ? "bg-tv-blue/10 text-tv-blue animate-pulse" :
                                          "bg-tv-bg3 text-tv-text3")}>
                      {sym.replace("-USDT", "")}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Optimization progress ── */}
          {phase === "optimizing" && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[10px] text-tv-text2">
                <span>{progress}/{total} {isFi ? "yhdistelmää" : "combinations"}</span>
                <span className="text-tv-green">{targetCount} {isFi ? `≥${WIN_RATE_TARGET}%` : `≥${WIN_RATE_TARGET}%`}</span>
                <span>{pct}%</span>
              </div>
              <div className="h-2 bg-tv-bg3 rounded overflow-hidden">
                <div className="h-full bg-tv-purple transition-all duration-100" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[10px] text-tv-text3">
                {isFi
                  ? `⚡ Pysähtyy heti kun osuma > ${WIN_RATE_TARGET}% & PF > ${PROFIT_FACTOR_TARGET}`
                  : `⚡ Stops as soon as win rate > ${WIN_RATE_TARGET}% & PF > ${PROFIT_FACTOR_TARGET}`}
              </div>
            </div>
          )}

          {/* ── Status message ── */}
          {status && (
            <div className={cn("text-xs rounded px-2 py-1.5 border",
              best?.meetsTarget && !isRunning
                ? "bg-tv-green/10 text-tv-green border-tv-green/30"
                : isRunning
                  ? "bg-tv-blue/10 text-tv-blue border-tv-blue/30"
                  : "bg-tv-bg2 text-tv-text2 border-tv-border")}>
              {status}
            </div>
          )}

          {/* ── Best result card ── */}
          {best && (
            <div className={cn("rounded p-2.5 space-y-2 border text-xs",
              best.meetsTarget
                ? "bg-tv-green/10 border-tv-green/30"
                : "bg-tv-amber/10 border-tv-amber/30")}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-tv-text">
                  {best.meetsTarget
                    ? (isFi ? "✅ Paras — tavoite saavutettu" : "✅ Best — target reached")
                    : (isFi ? "⚠️ Paras saatavilla" : "⚠️ Best available")}
                </span>
                {applied && (
                  <span className="text-[10px] bg-tv-green/20 text-tv-green px-1.5 py-0.5 rounded font-semibold">
                    {isFi ? "KÄYTÖSSÄ" : "ACTIVE"}
                  </span>
                )}
              </div>

              {/* Params row */}
              <div className="grid grid-cols-3 gap-x-3 gap-y-1">
                <Stat label={isFi ? "Min pisteet" : "Min score"}   value={`${best.params.minSignalScore}/9`} />
                <Stat label={isFi ? "RSI osto/myynti" : "RSI buy/sell"}
                  value={`<${best.params.rsiOversoldThreshold} / >${best.params.rsiOverboughtThreshold}`} />
                <Stat label={isFi ? "Volyymi kerroin" : "Vol multiplier"}  value={`${best.params.volumeMultiplier}×`} />
                <Stat label="SL×ATR"  value={`${best.params.stopLossAtrMultiplier}×`} />
                <Stat label="TP×SL"   value={`${best.params.takeProfitMultiplier}×`} />
                <Stat label={isFi ? "Parit tavoitteessa" : "Pairs on target"}
                  value={`${best.pairsWithTarget}/${best.pairResults.length}`}
                  cls={best.pairsWithTarget >= 5 ? "text-tv-green" : "text-tv-amber"} />
              </div>

              {/* Metrics row */}
              <div className="grid grid-cols-4 gap-x-3 gap-y-1 pt-1 border-t border-tv-border/50">
                <Stat label={t("metric.win_rate")}      value={`${best.winRate.toFixed(1)}%`}
                  cls={best.winRate >= WIN_RATE_TARGET ? "text-tv-green" : "text-tv-amber"} />
                <Stat label={t("metric.profit_factor")} value={best.profitFactor.toFixed(2)}
                  cls={best.profitFactor >= 1.5 ? "text-tv-green" : best.profitFactor >= 1 ? "text-tv-amber" : "text-tv-red"} />
                <Stat label={t("metric.trades")}        value={String(best.totalTrades)} />
                <Stat label={t("metric.sharpe")}        value={best.sharpeRatio.toFixed(2)}
                  cls={best.sharpeRatio >= 1 ? "text-tv-green" : "text-tv-text"} />
                <Stat label={t("metric.total_return")}  value={`${best.totalReturnPct >= 0 ? "+" : ""}${best.totalReturnPct.toFixed(1)}%`}
                  cls={best.totalReturnPct >= 0 ? "text-tv-green" : "text-tv-red"} />
                <Stat label={t("metric.max_drawdown")}  value={`-${best.maxDrawdownPct.toFixed(1)}%`}
                  cls={best.maxDrawdownPct < 10 ? "text-tv-green" : best.maxDrawdownPct < 20 ? "text-tv-amber" : "text-tv-red"} />
              </div>

              {/* Per-pair mini breakdown */}
              {best.pairResults.length > 0 && (
                <div>
                  <div className="text-[9px] text-tv-text2 uppercase font-semibold mb-1">
                    {isFi ? "Per-pari tulokset (validointijakso)" : "Per-pair results (validation period)"}
                  </div>
                  <div className="grid grid-cols-4 gap-0.5">
                    {[...best.pairResults]
                      .sort((a, b) => b.winRate - a.winRate)
                      .map(p => (
                        <div key={p.symbol}
                          className={cn("rounded px-1.5 py-1 text-[9px]",
                            p.meetsTarget ? "bg-tv-green/10 border border-tv-green/20" : "bg-tv-bg3 border border-tv-border")}>
                          <div className="font-bold text-tv-text">{p.symbol.replace("-USDT", "")}</div>
                          <div className={cn("font-mono", p.meetsTarget ? "text-tv-green" : "text-tv-text2")}>
                            {p.winRate.toFixed(0)}% · {p.trades}t
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Top-8 combinations table ── */}
          {sortedTop.length > 0 && !isRunning && (
            <div>
              <div className="text-[10px] text-tv-text2 mb-1 font-semibold uppercase">
                {isFi ? "Top 8 — klikkaa ottaaksesi käyttöön" : "Top 8 — click a row to apply"}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-tv-text2 border-b border-tv-border">
                      <th className="pb-1 pr-1 text-left">{isFi ? "Pist." : "Sc."}</th>
                      <th className="pb-1 pr-1 text-left">RSI</th>
                      <th className="pb-1 pr-1 text-left">Vol×</th>
                      <th className="pb-1 pr-1 text-left">SL×</th>
                      <th className="pb-1 pr-1 text-left">TP×</th>
                      <th className="pb-1 pr-1 text-right">{isFi ? "Osuma%" : "Win%"}</th>
                      <th className="pb-1 pr-1 text-right">PF</th>
                      <th className="pb-1 pr-1 text-right">{isFi ? "Kaupat" : "Trades"}</th>
                      <th className="pb-1 text-right">{isFi ? "Parit" : "Pairs"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTop.map((c, idx) => (
                      <tr key={idx}
                        onClick={() => applyConfig(c)}
                        title={isFi ? "Klikkaa ottaaksesi käyttöön" : "Click to apply"}
                        className={cn("border-t border-tv-border cursor-pointer hover:bg-tv-hover",
                          c.meetsTarget ? "text-tv-green" : "text-tv-text2")}>
                        <td className="py-0.5 pr-1">{c.params.minSignalScore}</td>
                        <td className="py-0.5 pr-1">&lt;{c.params.rsiOversoldThreshold}</td>
                        <td className="py-0.5 pr-1">{c.params.volumeMultiplier}</td>
                        <td className="py-0.5 pr-1">{c.params.stopLossAtrMultiplier}</td>
                        <td className="py-0.5 pr-1">{c.params.takeProfitMultiplier}</td>
                        <td className="py-0.5 pr-1 text-right font-mono">{c.winRate.toFixed(1)}%</td>
                        <td className="py-0.5 pr-1 text-right font-mono">{c.profitFactor.toFixed(2)}</td>
                        <td className="py-0.5 pr-1 text-right">{c.totalTrades}</td>
                        <td className="py-0.5 text-right">{c.pairsWithTarget}/{c.pairResults.length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Feedback loop toggle ── */}
          <div className={cn("rounded p-2 border text-xs flex items-start justify-between gap-2",
            feedbackEnabled ? "bg-tv-purple/10 border-tv-purple/30" : "bg-tv-bg2 border-tv-border")}>
            <div className="space-y-0.5 flex-1">
              <div className="font-semibold text-tv-text">
                🔁 {feedbackEnabled ? t("optimizer.feedback_on") : t("optimizer.feedback_off")}
              </div>
              <div className="text-[10px] text-tv-text2">
                {isFi
                  ? <>Auto-käynnistyy: ≥{CONSECUTIVE_LOSS_LIMIT} tappiota peräkkäin · live &lt;{WIN_RATE_FLOOR}% · ero &gt;{DIVERGENCE_THRESHOLD}% · 24 h välein</>
                  : <>Auto-triggers: ≥{CONSECUTIVE_LOSS_LIMIT} consecutive losses · live &lt;{WIN_RATE_FLOOR}% · gap &gt;{DIVERGENCE_THRESHOLD}% · every 24 h</>}
              </div>
              {feedbackEnabled && liveWinRate !== null && (
                <div className="mt-1 flex gap-3 flex-wrap">
                  <span className={cn("font-mono font-semibold", liveWinRate >= WIN_RATE_TARGET ? "text-tv-green" : "text-tv-amber")}>
                    Live: {liveWinRate.toFixed(0)}%
                  </span>
                  {lastBestWinRateRef.current > 0 && (
                    <span className="text-tv-text2">{isFi ? "Historiatesti" : "Backtest"}: {lastBestWinRateRef.current.toFixed(0)}%</span>
                  )}
                  {liveLosses >= 3 && (
                    <span className="text-tv-red font-semibold">
                      {isFi ? `${liveLosses} tappiota peräkkäin` : `${liveLosses} consecutive losses`}
                    </span>
                  )}
                </div>
              )}
              {!isActive && feedbackEnabled && (
                <div className="text-tv-amber text-[10px] mt-0.5">
                  {isFi ? "⚠ Botti ei käynnissä — palautesilmukka odottaa kauppoja" : "⚠ Bot not running — feedback loop waiting for trades"}
                </div>
              )}
            </div>
            <button
              onClick={() => setFeedbackEnabled(v => !v)}
              className={cn("flex-shrink-0 px-2 py-1 rounded text-[10px] font-semibold border transition-colors",
                feedbackEnabled
                  ? "bg-tv-purple/20 text-tv-purple border-tv-purple/40 hover:bg-tv-purple/30"
                  : "bg-tv-bg3 text-tv-text2 border-tv-border hover:text-tv-text")}>
              {feedbackEnabled ? t("app.off") : t("app.on")}
            </button>
          </div>

          {/* ── Feedback history ── */}
          {feedbackLog.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-tv-text2 font-semibold uppercase">
                {isFi ? "Automaattinen optimointihistoria" : "Auto-optimization history"}
              </div>
              {feedbackLog.map((e, i) => (
                <div key={i} className="text-[10px] text-tv-text2 flex justify-between">
                  <span>{new Date(e.time).toLocaleTimeString()} — {e.reason}</span>
                  {e.resultWinRate !== null && (
                    <span className={e.resultWinRate >= WIN_RATE_TARGET ? "text-tv-green" : "text-tv-amber"}>
                      → {e.resultWinRate.toFixed(1)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Run / Stop button ── */}
          <div className="flex gap-2">
            <button
              onClick={isRunning
                ? () => { abortRef.current = true; }
                : () => runOptimizer()}
              className={cn("flex-1 py-2 rounded text-sm font-semibold border transition-colors",
                isRunning
                  ? "bg-tv-red/10 text-tv-red border-tv-red/30 hover:bg-tv-red/20"
                  : "bg-tv-purple/10 text-tv-purple border-tv-purple/30 hover:bg-tv-purple/20")}>
              {isRunning
                ? (phase === "fetching"
                    ? `⏹ ${isFi ? "Pysäytä" : "Stop"} (${isFi ? `haetaan ${pairsReady}/20` : `fetching ${pairsReady}/20`})`
                    : `⏹ ${isFi ? "Pysäytä" : "Stop"} (${pct}%)`)
                : candidates.length > 0
                    ? (isFi ? "🔄 Optimoi uudelleen (20 paria)" : "🔄 Re-optimize (20 pairs)")
                    : (isFi ? "🔬 Aja — 20 paria × 576 yhdistelmää" : "🔬 Run — 20 pairs × 576 combinations")}
            </button>
          </div>

          {/* ── Info footer ── */}
          <div className="text-[10px] text-tv-text2 border border-tv-border rounded px-2 py-1.5">
            {isFi
              ? <><strong>ℹ️ Metodologia:</strong> Lepikkö &quot;Trade Like a Pro&quot; · 7 indikaattoria (trendi, momentum, volatiliteetti, volyymi) · Walk-forward 70/30 · Varhaispysähdys kun tavoite saavutettu</>
              : <><strong>ℹ️ Methodology:</strong> Lepikkö &quot;Trade Like a Pro&quot; · 7 indicators (trend, momentum, volatility, volume) · Walk-forward 70/30 · Early-stop when target reached</>}
          </div>

        </div>
      )}
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="text-[9px] text-tv-text2 uppercase tracking-wide">{label}</div>
      <div className={cn("text-xs font-semibold", cls ?? "text-tv-text")}>{value}</div>
    </div>
  );
}
