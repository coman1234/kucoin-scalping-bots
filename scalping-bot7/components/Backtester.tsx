"use client";

import { useState, useCallback, useRef, useEffect, useMemo, type MutableRefObject } from "react";
import { useTradingContext } from "@/lib/context";
import { runBacktest, type BacktestConfig } from "@/lib/backtester";
import type { KuCoinCandle } from "@/lib/kucoinPublic";
import { cn } from "@/lib/utils";
import { useT } from "@/components/SettingsModal";

type Phase =
  | "idle"
  | "fetching"
  | "simulating"
  | "computing"
  | "done"
  | "error";

interface Props {
  autoRunRef?: MutableRefObject<(() => void) | null>;
}

export default function Backtester({ autoRunRef }: Props) {
  const { selectedSymbol, selectedTimeframe, botConfig, setBotConfig, setBacktestResults, backtestResults, language } =
    useTradingContext();
  const t = useT();
  const isFi = language === "fi";

  const PHASE_LABELS: Record<Phase, string> = {
    idle:       t("app.finish"),
    fetching:   t("backtest.fetching"),
    simulating: t("backtest.simulating"),
    computing:  t("backtest.computing"),
    done:       t("backtest.done"),
    error:      t("app.error"),
  };

  const [open, setOpen]       = useState(false);
  const [running, setRunning] = useState(false);
  const [phase, setPhase]     = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [candleCount, setCandleCount] = useState(0);
  const [tradeCount, setTradeCount]   = useState(0);
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [config, setConfig] = useState<BacktestConfig>({
    symbol: selectedSymbol,
    timeframe: selectedTimeframe,
    tradeAmountUSDT: botConfig.tradeAmountUSDT,
    minSignalScore: botConfig.minSignalScore,
    takeProfitMultiplier: botConfig.takeProfitMultiplier ?? 2.5,
    stopLossAtrMultiplier: botConfig.stopLossAtrMultiplier ?? 1.5,
    partialExitEnabled: botConfig.partialExitEnabled,
  });

  // Auto-sync sliders when the optimizer applies new parameters
  useEffect(() => {
    setConfig(prev => ({
      ...prev,
      minSignalScore:        botConfig.minSignalScore,
      takeProfitMultiplier:  botConfig.takeProfitMultiplier  ?? prev.takeProfitMultiplier,
      stopLossAtrMultiplier: botConfig.stopLossAtrMultiplier ?? prev.stopLossAtrMultiplier,
    }));
  }, [botConfig.minSignalScore, botConfig.takeProfitMultiplier, botConfig.stopLossAtrMultiplier]);

  // Detect whether sliders currently match the optimizer output
  const syncedFromOptimizer = useMemo(() =>
    config.minSignalScore        === botConfig.minSignalScore &&
    config.takeProfitMultiplier  === (botConfig.takeProfitMultiplier  ?? config.takeProfitMultiplier) &&
    config.stopLossAtrMultiplier === (botConfig.stopLossAtrMultiplier ?? config.stopLossAtrMultiplier),
  [config, botConfig]);

  // Animate progress bar toward a target value
  const animateToward = useCallback((target: number, durationMs: number) => {
    if (progressRef.current) clearInterval(progressRef.current);
    const steps  = Math.max(1, Math.round(durationMs / 50));
    let   step   = 0;
    progressRef.current = setInterval(() => {
      step++;
      setProgress((prev) => {
        const next = prev + (target - prev) * (step / steps);
        return step >= steps ? target : next;
      });
      if (step >= steps && progressRef.current) {
        clearInterval(progressRef.current);
        progressRef.current = null;
      }
    }, 50);
  }, []);

  useEffect(() => () => { if (progressRef.current) clearInterval(progressRef.current); }, []);

  const runTest = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    setCandleCount(0);
    setTradeCount(0);
    setPhase("fetching");

    try {
      // ── Phase 1: fetch candles (paginated — KuCoin caps at 1500/request) ──────
      // 14 days gives enough trades for meaningful statistics.
      // For 5min × 14d = 4 032 candles (3 requests); 1min × 14d = 14 requests.
      const days    = 14;
      const endAt   = Math.floor(Date.now() / 1000);
      const startAt = endAt - days * 24 * 3600;

      // Estimate number of API pages so the progress bar reflects real work
      const TF_SEC: Record<string, number> = {
        "1min": 60, "3min": 180, "5min": 300, "15min": 900,
        "30min": 1800, "1hour": 3600, "4hour": 14400, "1day": 86400,
      };
      const tfSec          = TF_SEC[selectedTimeframe] ?? 300;
      const totalExpected  = Math.ceil((days * 86400) / tfSec);
      const pagesExpected  = Math.max(1, Math.ceil(totalExpected / 1500));
      // Reserve 0–60% for fetching, 60–90% for simulation, 90–100% computing
      const pctPerPage = 60 / pagesExpected;

      const res  = await fetch(
        `/api/trading/candles?symbol=${selectedSymbol}&timeframe=${selectedTimeframe}&startAt=${startAt}&endAt=${endAt}`
      );
      const data = await res.json();
      const candles: KuCoinCandle[] = data.candles ?? [];

      setCandleCount(candles.length);
      setProgress(60);

      if (candles.length < 60) {
        setPhase("error");
        setRunning(false);
        return;
      }

      // ── Phase 2: run backtest simulation ─────────────────────────────────────
      setPhase("simulating");
      animateToward(90, Math.min(3000, candles.length * 0.8));

      const results = await new Promise<ReturnType<typeof runBacktest>>((resolve) => {
        setTimeout(() => {
          resolve(runBacktest(candles, { ...config, symbol: selectedSymbol, timeframe: selectedTimeframe }));
        }, 0);
      });

      setTradeCount(results.totalTrades);

      // ── Phase 3: finalise ─────────────────────────────────────────────────────
      setPhase("computing");
      setProgress(90);
      await new Promise((r) => setTimeout(r, 200));
      setProgress(100);

      setBacktestResults(results);
      if (results.profitFactor >= 1.05 && results.totalTrades >= 10) {
        setBotConfig({ ...botConfig, backtestValidated: true });
      }

      // Persist to server log
      if (results.allTrades.length > 0) {
        fetch("/api/trading/backtest-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: selectedSymbol,
            timeframe: selectedTimeframe,
            runAt: Date.now(),
            days,
            summary: {
              totalTrades: results.totalTrades,
              winRate: results.winRate,
              profitFactor: results.profitFactor,
              totalReturnPct: results.totalReturnPct,
              maxDrawdownPct: results.maxDrawdownPct,
            },
            trades: results.allTrades,
          }),
        }).catch(() => null);
      }

      // Suppress unused variable (kept for future per-page progress wiring)
      void pctPerPage;

      setPhase("done");
    } catch {
      setPhase("error");
    } finally {
      setRunning(false);
      if (progressRef.current) clearInterval(progressRef.current);
    }
  }, [selectedSymbol, selectedTimeframe, config, botConfig, setBotConfig, setBacktestResults, animateToward]);

  // ── Register autoRunRef so AutoPilot can trigger backtesting ─────────────
  useEffect(() => {
    if (autoRunRef) autoRunRef.current = runTest;
    return () => { if (autoRunRef) autoRunRef.current = null; };
  }, [autoRunRef, runTest]);

  const r = backtestResults;

  return (
    <div className="panel">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-sm font-semibold text-tv-text uppercase tracking-wide"
      >
        <span>📊 {t("backtest.title")}</span>
        <span className="text-tv-text2">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4">

          {/* Optimizer sync indicator */}
          {syncedFromOptimizer ? (
            <div className="text-[9px] bg-tv-purple/10 border border-tv-purple/20 text-tv-purple rounded px-2 py-1 flex items-center gap-1.5">
              <span>🔬</span>
              <span>{t("backtest.synced_from_optimizer") ?? (isFi ? "Parametrit synkronoitu automaattisesti optimoijalta" : "Parameters auto-synced from optimizer")}</span>
            </div>
          ) : (
            <div className="flex items-center justify-between text-[9px] bg-tv-amber/10 border border-tv-amber/20 text-tv-amber rounded px-2 py-1">
              <span>{isFi ? "⚠ Muokattu manuaalisesti" : "⚠ Manually adjusted"}</span>
              <button
                onClick={() => setConfig(prev => ({
                  ...prev,
                  minSignalScore:        botConfig.minSignalScore,
                  takeProfitMultiplier:  botConfig.takeProfitMultiplier  ?? prev.takeProfitMultiplier,
                  stopLossAtrMultiplier: botConfig.stopLossAtrMultiplier ?? prev.stopLossAtrMultiplier,
                }))}
                className="underline hover:no-underline font-semibold"
              >
                {isFi ? "Palauta optimoijan arvot" : "Restore optimizer values"}
              </button>
            </div>
          )}

          {/* Asetusliukusäätimet */}
          <div className="flex flex-col gap-3">
            <Slider
              label={t("backtest.min_score_label")}
              value={config.minSignalScore}
              min={2} max={10} step={1}
              onChange={(v) => setConfig((c) => ({ ...c, minSignalScore: v }))}
              format={(v) => `${v}/13`}
            />
            <Slider
              label={t("backtest.tp_multiplier_label")}
              value={config.takeProfitMultiplier}
              min={1.5} max={4} step={0.25}
              onChange={(v) => setConfig((c) => ({ ...c, takeProfitMultiplier: v }))}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <Slider
              label={t("backtest.sl_multiplier_label")}
              value={config.stopLossAtrMultiplier}
              min={0.5} max={3} step={0.25}
              onChange={(v) => setConfig((c) => ({ ...c, stopLossAtrMultiplier: v }))}
              format={(v) => `${v.toFixed(2)}×`}
            />
          </div>

          {/* Ajopainike */}
          <button
            onClick={runTest}
            disabled={running}
            className={cn(
              "w-full py-2 rounded text-sm font-semibold transition-colors",
              running
                ? "bg-tv-bg3 text-tv-text3 cursor-not-allowed"
                : "bg-tv-blue/10 text-tv-blue border border-tv-blue/30 hover:bg-tv-blue/20"
            )}
          >
            {running ? t("backtest.running_verb") : `▶ ${isFi ? "Aja — viimeiset 14 päivää" : "Run — last 14 days"}`}
          </button>

          {/* ── Tilaruutu ──────────────────────────────────────────── */}
          {phase !== "idle" && (
            <div className={cn(
              "rounded-lg border px-3 py-2.5 space-y-2",
              phase === "error"
                ? "bg-tv-red-dim border-tv-red/30"
                : phase === "done"
                ? "bg-tv-green-dim border-tv-green/30"
                : "bg-tv-blue-dim border-tv-blue/30"
            )}>
              {/* Tilaotsikko */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  {running && (
                    <span className="inline-block w-2 h-2 rounded-full bg-tv-blue animate-pulse" />
                  )}
                  {phase === "done" && <span className="text-tv-green">✓</span>}
                  {phase === "error" && <span className="text-tv-red">✕</span>}
                  <span className={cn(
                    "font-semibold",
                    phase === "error" ? "text-tv-red" :
                    phase === "done"  ? "text-tv-green" :
                    "text-tv-blue"
                  )}>
                    {PHASE_LABELS[phase]}
                  </span>
                </div>
                <span className={cn(
                  "font-mono font-bold tabular-nums",
                  phase === "error" ? "text-tv-red" :
                  phase === "done"  ? "text-tv-green" :
                  "text-tv-blue"
                )}>
                  {Math.round(progress)}%
                </span>
              </div>

              {/* Edistymispalkki */}
              <div className="h-1.5 rounded-full bg-tv-border overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-200",
                    phase === "error" ? "bg-tv-red" :
                    phase === "done"  ? "bg-tv-green" :
                    "bg-tv-blue"
                  )}
                  style={{ width: `${Math.round(progress)}%` }}
                />
              </div>

              {/* Kontekstitieto */}
              {(candleCount > 0 || tradeCount > 0) && (
                <div className="flex gap-3 text-[10px] text-tv-text2 flex-wrap">
                  {candleCount > 0 && (
                    <span>
                      {candleCount.toLocaleString()} {t("market.candles").toLowerCase()}
                      {" "}({isFi ? "14 pv" : "14 d"})
                    </span>
                  )}
                  {tradeCount > 0 && (
                    <span className={tradeCount >= 10 ? "text-tv-green" : "text-tv-amber"}>
                      {tradeCount} {t("metric.trades").toLowerCase()}
                      {tradeCount < 10 ? (isFi ? " — tarvitaan 10" : " — need 10") : " ✓"}
                    </span>
                  )}
                </div>
              )}

              {phase === "error" && (
                <div className="text-xs text-tv-red">
                  {t("backtest.not_enough_data")}
                </div>
              )}
            </div>
          )}

          {/* Varoitukset */}
          {r?.warnings.map((w, i) => (
            <div key={i} className="text-xs bg-tv-amber-dim border border-tv-amber/30 text-tv-amber rounded px-2 py-1.5">
              {w}
            </div>
          ))}

          {/* Tulokset */}
          {r && (
            <div className="space-y-3">
              {r.profitFactor >= 1.05 && r.totalTrades >= 10 ? (
                <div className="flex items-center justify-between gap-2 bg-tv-green-dim border border-tv-green/30 text-tv-green rounded px-2 py-1.5">
                  <span className="text-xs">✅ {t("backtest.validated_unlocked")}</span>
                  <button
                    onClick={() => setBotConfig({ ...botConfig, backtestValidated: false })}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-tv-green/40 hover:bg-tv-green/20 flex-shrink-0 font-semibold"
                  >
                    {isFi ? "Nollaa validointi" : "Reset validation"}
                  </button>
                </div>
              ) : (
                <div className="text-xs bg-tv-amber/10 border border-tv-amber/30 text-tv-amber rounded px-2 py-1.5 space-y-0.5">
                  <div className="font-semibold">
                    {isFi ? "⚠ Botti ei vielä vapautettu — vaatimukset:" : "⚠ Bot not unlocked yet — requirements:"}
                  </div>
                  <div className="flex gap-3 flex-wrap">
                    <span className={r.totalTrades >= 10 ? "text-tv-green" : "text-tv-red"}>
                      {r.totalTrades >= 10 ? "✓" : "✗"} {isFi ? `Kauppoja ${r.totalTrades}/10` : `Trades ${r.totalTrades}/10`}
                    </span>
                    <span className={r.profitFactor >= 1.2 ? "text-tv-green" : "text-tv-red"}>
                      {r.profitFactor >= 1.05 ? "✓" : "✗"} {isFi ? `PF ${r.profitFactor.toFixed(2)}/1.05` : `PF ${r.profitFactor.toFixed(2)}/1.05`}
                    </span>
                  </div>
                  {r.totalTrades < 10 && (
                    <div className="text-[10px] text-tv-amber/80">
                      {isFi
                        ? `Kauppoja liian vähän (${r.totalTrades}). Kokeile madaltaa min. pisteet -asetusta tai käytä lyhyempää aikaväliä (esim. 5min tai 1min).`
                        : `Too few trades (${r.totalTrades}). Try lowering the min score slider or switching to a shorter timeframe (e.g. 5min or 1min).`}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-xs">
                <ResultCard label={t("metric.total_trades")}  value={String(r.totalTrades)} />
                <ResultCard label={t("metric.win_rate")}  value={`${r.winRate.toFixed(1)}%`}
                  color={r.winRate >= 38 ? "green" : r.winRate >= 33 ? "yellow" : "red"} />
                <ResultCard label={t("metric.profit_factor")}    value={r.profitFactor > 0 ? r.profitFactor.toFixed(2) : "—"}
                  color={r.profitFactor >= 1.5 ? "green" : r.profitFactor >= 1.05 ? "yellow" : "red"} />
                <ResultCard label={t("metric.max_drawdown")}   value={`-${r.maxDrawdownPct.toFixed(1)}%`}
                  color={r.maxDrawdownPct <= 10 ? "green" : r.maxDrawdownPct <= 15 ? "yellow" : "red"} />
                <ResultCard label={t("metric.total_return")}   value={`${r.totalReturnPct >= 0 ? "+" : ""}${r.totalReturnPct.toFixed(1)}%`}
                  color={r.totalReturnPct >= 0 ? "green" : "red"} />
                <ResultCard label={t("metric.expectancy")}       value={`${r.expectancy >= 0 ? "+" : ""}€${r.expectancy.toFixed(2)}${t("metric.per_trade")}`}
                  color={r.expectancy >= 0 ? "green" : "red"} />
                <ResultCard label={t("metric.sharpe")}       value={r.sharpeRatio.toFixed(2)}
                  color={r.sharpeRatio >= 1 ? "green" : r.sharpeRatio >= 0 ? "yellow" : "red"} />
                <ResultCard label={t("metric.avg_duration")} value={`${r.avgTradeDurationMinutes.toFixed(0)} min`} />
                <ResultCard label={t("metric.avg_win")}      value={`+${r.avgWinPct.toFixed(2)}%`} color="green" />
                <ResultCard label={t("metric.avg_loss")}     value={`-${r.avgLossPct.toFixed(2)}%`} color="red" />
              </div>

              {r.equityCurve.length > 1 && <EquityCurve data={r.equityCurve} label={t("backtest.equity_curve")} />}

              <div>
                <div className="text-xs text-tv-text2 mb-1.5 uppercase tracking-wide">{t("backtest.recent_trades")}</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-tv-text2 text-left">
                        <th className="pb-1">#</th>
                        <th className="pb-1">{t("backtest.col_direction")}</th>
                        <th className="pb-1">P&amp;L%</th>
                        <th className="pb-1">{t("signal.exit")}</th>
                        <th className="pb-1">{t("backtest.col_score")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.allTrades.slice(-15).reverse().map((t, i) => (
                        <tr key={i} className={cn(
                          "border-t border-tv-border",
                          t.pnlUSDT > 0 ? "text-tv-green" : t.pnlUSDT < 0 ? "text-tv-red" : "text-tv-amber"
                        )}>
                          <td className="py-0.5 text-tv-text2">{r.allTrades.length - i}</td>
                          <td className="py-0.5">{t.direction}</td>
                          <td className="py-0.5 font-mono">{t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%</td>
                          <td className="py-0.5 text-tv-text2">{t.exitReason}</td>
                          <td className="py-0.5 text-tv-text2">{t.signalScore}/13</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}

function Slider({
  label, value, min, max, step, onChange, format,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        <span className="text-tv-text2">{label}</span>
        <span className="text-tv-blue font-bold">{format(value)}</span>
      </div>
      <div className="relative h-4 flex items-center">
        {/* Track background */}
        <div className="absolute w-full h-1.5 rounded-full bg-tv-bg3" />
        {/* Filled portion */}
        <div
          className="absolute h-1.5 rounded-full bg-tv-blue/60"
          style={{ width: `${pct}%` }}
        />
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute w-full opacity-0 cursor-pointer h-4"
          style={{ WebkitAppearance: "none" }}
        />
        {/* Visible thumb */}
        <div
          className="absolute w-3.5 h-3.5 rounded-full bg-tv-blue border-2 border-white shadow pointer-events-none"
          style={{ left: `calc(${pct}% - 7px)` }}
        />
      </div>
    </div>
  );
}

function ResultCard({ label, value, color }: { label: string; value: string; color?: "green" | "red" | "yellow" }) {
  const colorClass =
    color === "green"  ? "text-tv-green" :
    color === "red"    ? "text-tv-red" :
    color === "yellow" ? "text-tv-amber" :
    "text-tv-text";
  return (
    <div className="bg-tv-bg2 rounded px-2 py-1.5">
      <div className="text-tv-text2 text-[10px] uppercase tracking-wide">{label}</div>
      <div className={cn("font-semibold text-sm mt-0.5", colorClass)}>{value}</div>
    </div>
  );
}

function EquityCurve({ data, label }: { data: { time: number; balance: number }[]; label: string }) {
  const minBal = Math.min(...data.map((d) => d.balance));
  const maxBal = Math.max(...data.map((d) => d.balance));
  const range  = maxBal - minBal || 1;
  const W = 400, H = 80, P = 4;

  const points = data.map((d, i) => {
    const x = P + (i / (data.length - 1)) * (W - P * 2);
    const y = P + (1 - (d.balance - minBal) / range) * (H - P * 2);
    return `${x},${y}`;
  }).join(" ");

  const isProfit = data[data.length - 1].balance >= data[0].balance;

  return (
    <div className="bg-tv-bg2 rounded p-2">
      <div className="text-xs text-tv-text2 mb-1">{label}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
        <polyline points={points} fill="none"
          stroke={isProfit ? "#26a69a" : "#ef5350"} strokeWidth="1.5" />
        <line x1={P} y1={H - P} x2={W - P} y2={H - P}
          stroke="#e0e3eb" strokeWidth="0.5" />
      </svg>
      <div className="flex justify-between text-[10px] text-tv-text2 mt-1">
        <span>€{minBal.toFixed(0)}</span>
        <span>€{maxBal.toFixed(0)}</span>
      </div>
    </div>
  );
}
