/**
 * backtesterC.ts — Heitkoetter-compliant backtesting engine for scalping-day6
 *
 * ── Heitkoetter Part 3 Requirements ──────────────────────────────────────────
 * ✓ Requirement #1: minimum 200 distinct trades → ≤7% statistical margin of error
 * ✓ Requirement #2: OOS split — parameters tuned on in-sample (60%), validated
 *                   on a completely untouched out-of-sample window (40%).
 *                   OOS degradation > 30% flags potential curve-fit.
 *
 * ── No lookahead bias ─────────────────────────────────────────────────────────
 * Each signal is evaluated using only candles[0..i] (the history the live bot
 * would have seen). The exit is determined by scanning forward candles[i+1..]
 * checking high/low against SL and TP — same order the exchange would match.
 *
 * ── Heitkoetter Benchmark Validation ─────────────────────────────────────────
 * Results are flagged PASS/FAIL against:
 *   Profit Factor   1.3 – 2.5    (outside = no edge or curve-fit)
 *   Win Rate        60% – 80%    (outside = system unreliable or over-fit)
 *   Max Drawdown    ≤ 20% equity (rough cap — Heitkoetter uses % of yearly profit)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   import { runBacktest } from "@/lib/backtesterC";
 *   const result = runBacktest("BTC-USDT", "5min", candles);
 *   // result.combined.pfPass && result.combined.wrPass → safe to go live
 *   // result.warnings → curve-fit alerts
 */

import type { CacheCandle } from "./cacheReader";
import { detectBreakout }   from "./breakoutDetector";
import { CONFIG, type TraderConfig } from "./traderConfig";

// ── Data types ────────────────────────────────────────────────────────────────

export interface BacktestTrade {
  symbol:       string;
  direction:    "BUY" | "SELL" | "NEUTRAL";
  entryTime:    number;       // Unix ms (candle timestamp)
  entryCandle:  number;       // index into candle array
  entryPrice:   number;
  slPrice:      number;
  tpPrice:      number;
  exitPrice:    number;
  exitReason:   "TP" | "SL" | "TIME_STOP";
  pnlPct:       number;       // % of entry price
  pnlR:         number;       // R-multiples (+tpAtrMult/slAtrMult = TP, -1.0 = SL)
  candlesHeld:  number;
  score:        number;       // signal score at entry
}

export interface BacktestMetrics {
  trades:          number;
  wins:            number;
  losses:          number;
  winRate:         number;    // 0–1
  profitFactor:    number;
  maxDrawdownPct:  number;    // peak-to-trough drawdown on equity curve
  avgWinR:         number;
  avgLossR:        number;
  expectancy:      number;    // expected R per trade
  totalR:          number;
  grossProfit:     number;    // sum of positive R
  grossLoss:       number;    // sum of negative R (absolute)
  // Heitkoetter benchmark verdict
  pfPass:          boolean;   // PF within 1.3–2.5
  wrPass:          boolean;   // WR within 60%–80%
  ddPass:          boolean;   // MaxDD ≤ benchmarkMaxDdPct
  overallPass:     boolean;   // all three pass
}

export interface BacktestResult {
  symbol:       string;
  timeframe:    string;
  config:       Pick<TraderConfig, "slAtrMult" | "tpAtrMult" | "minScore" | "maxHoldMinutes" | "rsiBullLo" | "rsiBullHi" | "rsiBearLo" | "rsiBearHi">;
  candlesTotal: number;
  oosStartIdx:  number;       // candle index where OOS window begins
  inSample:     BacktestMetrics;
  outOfSample:  BacktestMetrics;
  combined:     BacktestMetrics;
  trades:       BacktestTrade[];
  warnings:     string[];
}

// ── Simulation helpers ────────────────────────────────────────────────────────

/**
 * Given an entry at candle[entryIdx], look forward for SL or TP.
 * Uses candle high/low (same as KuCoin would match a stop/limit order).
 * Returns as soon as the first level is breached — no re-entry.
 */
function simulateExit(
  candles:    CacheCandle[],
  entryIdx:   number,
  isBuy:      boolean,
  slPrice:    number,
  tpPrice:    number,
  maxCandles: number,    // time-stop window
): { exitPrice: number; exitReason: "TP" | "SL" | "TIME_STOP"; candlesHeld: number } {
  for (let j = entryIdx + 1; j < candles.length && j <= entryIdx + maxCandles; j++) {
    const { high, low, close } = candles[j];

    if (isBuy) {
      // Both SL and TP could be hit in the same candle — conservative: SL wins
      if (low  <= slPrice) return { exitPrice: slPrice, exitReason: "SL", candlesHeld: j - entryIdx };
      if (high >= tpPrice) return { exitPrice: tpPrice, exitReason: "TP", candlesHeld: j - entryIdx };
    } else {
      if (high >= slPrice) return { exitPrice: slPrice, exitReason: "SL", candlesHeld: j - entryIdx };
      if (low  <= tpPrice) return { exitPrice: tpPrice, exitReason: "TP", candlesHeld: j - entryIdx };
    }

    // Last candle in time-stop window — exit at close
    if (j === entryIdx + maxCandles) {
      return { exitPrice: close, exitReason: "TIME_STOP", candlesHeld: maxCandles };
    }
  }

  // Reached end of data before exit — close at last available price
  const lastIdx = Math.min(entryIdx + maxCandles, candles.length - 1);
  return {
    exitPrice:   candles[lastIdx].close,
    exitReason:  "TIME_STOP",
    candlesHeld: lastIdx - entryIdx,
  };
}

// ── Metrics calculation ───────────────────────────────────────────────────────

function calcMetrics(trades: BacktestTrade[], cfg: TraderConfig): BacktestMetrics {
  if (trades.length === 0) {
    return {
      trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0,
      maxDrawdownPct: 0, avgWinR: 0, avgLossR: 0, expectancy: 0,
      totalR: 0, grossProfit: 0, grossLoss: 0,
      pfPass: false, wrPass: false, ddPass: false, overallPass: false,
    };
  }

  const wins   = trades.filter(t => t.pnlR > 0);
  const losses = trades.filter(t => t.pnlR <= 0);

  const grossProfit = wins.reduce  ((s, t) => s + t.pnlR, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const winRate      = wins.length / trades.length;
  const totalR       = grossProfit - grossLoss;
  const expectancy   = totalR / trades.length;
  const avgWinR      = wins.length   > 0 ? grossProfit / wins.length   : 0;
  const avgLossR     = losses.length > 0 ? grossLoss   / losses.length : 0;

  // Equity curve → max drawdown
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnlR * cfg.riskPctPerTrade / 100;  // as fraction of initial equity
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const pfPass = profitFactor >= cfg.benchmarkPfMin && profitFactor <= cfg.benchmarkPfMax;
  const wrPass = winRate      >= cfg.benchmarkWrMin && winRate      <= cfg.benchmarkWrMax;
  const ddPass = maxDD        <= cfg.benchmarkMaxDdPct;

  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate, profitFactor, maxDrawdownPct: maxDD,
    avgWinR, avgLossR, expectancy, totalR,
    grossProfit, grossLoss,
    pfPass, wrPass, ddPass,
    overallPass: pfPass && wrPass && ddPass,
  };
}

// ── Main backtest runner ──────────────────────────────────────────────────────

/**
 * Run the full strategy simulation on one symbol + timeframe.
 *
 * @param symbol    e.g. "BTC-USDT"
 * @param timeframe e.g. "5min"
 * @param candles   Full historical candle array (oldest → newest)
 * @param cfg       Optional config override (defaults to live CONFIG)
 */
export function runBacktest(
  symbol:    string,
  timeframe: string,
  candles:   CacheCandle[],
  cfg:       TraderConfig = CONFIG,
): BacktestResult {
  const warnings:   string[]        = [];
  const allTrades:  BacktestTrade[] = [];
  const oosStartIdx = Math.floor(candles.length * cfg.oosSplitRatio);

  // Time-stop in candles: assuming 5-min TF; adjust for other TFs
  const minutesPerCandle = timeframe === "1min"  ? 1
                         : timeframe === "3min"  ? 3
                         : timeframe === "5min"  ? 5
                         : timeframe === "15min" ? 15
                         : timeframe === "1hour" ? 60 : 5;
  const maxCandles = Math.ceil(cfg.maxHoldMinutes / minutesPerCandle);

  if (candles.length < 120) {
    warnings.push(`Only ${candles.length} candles available — need 120+ for meaningful results`);
  }

  // ── Sliding-window scan (no lookahead) ───────────────────────────────────────
  // At candle i, the detector sees candles[0..i] only. No future data leaks in.
  let skipUntil = 0;   // candle index after which the next entry is allowed

  for (let i = 60; i < candles.length - maxCandles - 1; i++) {
    if (i < skipUntil) continue;  // inside an open trade — don't re-enter

    // Detect signal using only history up to and including candle i
    const hist = candles.slice(0, i + 1);
    const sig  = detectBreakout(symbol, timeframe, hist, null);
    if (!sig) continue;

    const isBuy     = sig.direction === "BUY";
    const entry     = candles[i].close;  // enter at close of signal candle
    const slPrice   = isBuy ? entry - sig.atr * cfg.slAtrMult : entry + sig.atr * cfg.slAtrMult;
    const tpPrice   = isBuy ? entry + sig.atr * cfg.tpAtrMult : entry - sig.atr * cfg.tpAtrMult;

    const result = simulateExit(candles, i, isBuy, slPrice, tpPrice, maxCandles);

    const pnlR = result.exitReason === "TP"
      ? cfg.tpAtrMult / cfg.slAtrMult                        // +R (e.g. +1.33)
      : result.exitReason === "SL"
      ? -1.0                                                 // -1R
      : isBuy                                                // TIME_STOP: partial
        ? (result.exitPrice - entry) / (entry - slPrice)
        : (entry - result.exitPrice) / (slPrice - entry);

    const pnlPct = isBuy
      ? (result.exitPrice - entry) / entry * 100
      : (entry - result.exitPrice) / entry * 100;

    allTrades.push({
      symbol,
      direction:    sig.direction,
      entryTime:    candles[i].time,
      entryCandle:  i,
      entryPrice:   entry,
      slPrice,
      tpPrice,
      exitPrice:    result.exitPrice,
      exitReason:   result.exitReason,
      pnlPct,
      pnlR:         isFinite(pnlR) ? pnlR : 0,
      candlesHeld:  result.candlesHeld,
      score:        sig.score,
    });

    // Skip forward until after this trade closes — no overlapping trades
    skipUntil = i + result.candlesHeld + 1;
  }

  // ── Statistical validity warning ──────────────────────────────────────────────
  if (allTrades.length < cfg.minBacktestTrades) {
    warnings.push(
      `⚠️ Only ${allTrades.length} trades found — ` +
      `Heitkoetter requires ${cfg.minBacktestTrades} for ≤7% margin of error. ` +
      `Supply more historical data (e.g. 90+ days of 5-min candles).`
    );
  }

  // ── Split trades by IS / OOS window ──────────────────────────────────────────
  const isTrades  = allTrades.filter(t => t.entryCandle <  oosStartIdx);
  const oosTrades = allTrades.filter(t => t.entryCandle >= oosStartIdx);

  const inSampleMetrics    = calcMetrics(isTrades,  cfg);
  const outOfSampleMetrics = calcMetrics(oosTrades, cfg);
  const combinedMetrics    = calcMetrics(allTrades, cfg);

  // ── Curve-fit detector ────────────────────────────────────────────────────────
  if (isTrades.length >= 10 && oosTrades.length >= 10) {
    const pfIS  = inSampleMetrics.profitFactor;
    const pfOOS = outOfSampleMetrics.profitFactor;
    if (pfIS > 0) {
      const degradation = (pfIS - pfOOS) / pfIS;
      if (degradation > 0.3) {
        warnings.push(
          `⚠️ Curve-fit risk: OOS Profit Factor ${pfOOS.toFixed(2)} is ` +
          `${(degradation * 100).toFixed(0)}% below IS ${pfIS.toFixed(2)}. ` +
          `Parameters may be overfit to historical data. Review CONFIG settings.`
        );
      }
    }

    // Win rate collapse in OOS
    const wrIS  = inSampleMetrics.winRate;
    const wrOOS = outOfSampleMetrics.winRate;
    if (wrIS > 0 && (wrIS - wrOOS) / wrIS > 0.2) {
      warnings.push(
        `⚠️ Win rate collapsed OOS: IS=${(wrIS * 100).toFixed(1)}% → OOS=${(wrOOS * 100).toFixed(1)}%. ` +
        `Consider widening RSI bands or reducing minScore.`
      );
    }
  }

  // ── Heitkoetter benchmark summary ─────────────────────────────────────────────
  if (allTrades.length >= 20) {
    const m = combinedMetrics;
    if (!m.pfPass) warnings.push(
      `PF=${m.profitFactor.toFixed(2)} outside [${cfg.benchmarkPfMin}–${cfg.benchmarkPfMax}]. ` +
      (m.profitFactor < cfg.benchmarkPfMin
        ? "System has no edge — do not go live."
        : "Over-optimised — will not hold out-of-sample.")
    );
    if (!m.wrPass) warnings.push(
      `Win rate=${(m.winRate * 100).toFixed(1)}% outside [${(cfg.benchmarkWrMin * 100).toFixed(0)}%–${(cfg.benchmarkWrMax * 100).toFixed(0)}%]. ` +
      (m.winRate < cfg.benchmarkWrMin
        ? "Too many losses — tighten entry filter (raise minScore or add conditions)."
        : "Suspiciously high — check for lookahead bias or over-fitting.")
    );
    if (!m.ddPass) warnings.push(
      `Max drawdown=${m.maxDrawdownPct.toFixed(1)}% exceeds ${cfg.benchmarkMaxDdPct}%. ` +
      "Reduce riskPctPerTrade or tighten slAtrMult."
    );
  }

  return {
    symbol,
    timeframe,
    config: {
      slAtrMult:      cfg.slAtrMult,
      tpAtrMult:      cfg.tpAtrMult,
      minScore:       cfg.minScore,
      maxHoldMinutes: cfg.maxHoldMinutes,
      rsiBullLo:      cfg.rsiBullLo,
      rsiBullHi:      cfg.rsiBullHi,
      rsiBearLo:      cfg.rsiBearLo,
      rsiBearHi:      cfg.rsiBearHi,
    },
    candlesTotal: candles.length,
    oosStartIdx,
    inSample:     inSampleMetrics,
    outOfSample:  outOfSampleMetrics,
    combined:     combinedMetrics,
    trades:       allTrades,
    warnings,
  };
}

/**
 * Run backtest across multiple symbols and aggregate results.
 * Useful for checking if the strategy edge is consistent across pairs.
 */
export function runMultiBacktest(
  dataset: Array<{ symbol: string; timeframe: string; candles: CacheCandle[] }>,
  cfg: TraderConfig = CONFIG,
): { results: BacktestResult[]; aggregateWarnings: string[] } {
  const results = dataset.map(d => runBacktest(d.symbol, d.timeframe, d.candles, cfg));
  const warnings: string[] = [];

  const combined = results.flatMap(r => r.trades);
  if (combined.length > 0) {
    const agg = {
      avgPF: results.reduce((s, r) => s + r.combined.profitFactor, 0) / results.length,
      avgWR: results.reduce((s, r) => s + r.combined.winRate,       0) / results.length,
    };
    if (agg.avgPF < 1.3)  warnings.push(`Aggregate PF ${agg.avgPF.toFixed(2)} < 1.3 — no consistent edge across pairs.`);
    if (agg.avgWR < 0.60) warnings.push(`Aggregate WR ${(agg.avgWR * 100).toFixed(1)}% < 60% — signal quality too low.`);
  }

  return { results, aggregateWarnings: warnings };
}
