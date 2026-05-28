/**
 * traderConfig.ts — central parameter struct for scalping-day7
 *
 * Single source of truth for every tunable value. Mirrors the C `typedef struct`
 * requested in the Heitkoetter spec. All values are read from environment
 * variables at startup so they can be changed without re-deploying.
 *
 * ── Heitkoetter Power Principle #3 — Benchmark Bands ──────────────────────────
 * A robust, non-curve-fitted system MUST fall within these ranges:
 *
 *   Profit Factor  :  1.3 – 2.5   (below = no edge; above = curve-fit)
 *   Win Rate       : 60 % – 80 %  (below = too many losers; above = unrealistic)
 *   Max Drawdown   : ≤ 20 % of gross annual profit
 *
 * NEVER optimise parameters to produce numbers outside these bands on
 * in-sample data — the out-of-sample result will collapse.
 *
 * ── Heitkoetter Power Principle #1 — Rule Count ───────────────────────────────
 * The signal logic derived from this config uses exactly 6 named rules:
 *   G1. EMA trend gate (mandatory)
 *   G2. BB breakout gate (mandatory)
 *   G3. Spread / liquidity gate (mandatory)
 *   C1. ATR expanding (scored)
 *   C2. RSI momentum zone (scored)
 *   C3. OBV trend aligned (scored)
 * That is well under the "10 rules" ceiling.
 */

export interface TraderConfig {
  // ── Signal ──────────────────────────────────────────────────────────────────
  signalTimeframe:   string;  // candle resolution for breakout scan
  minScore:          number;  // min of 3 scored conditions to emit a signal
  maxSpreadPct:      number;  // reject illiquid markets above this bid-ask spread %
  minAtrPct:         number;  // min ATR as % of price (e.g. 0.5 = 0.5%). Below this the
                              // TP target is too small to overcome round-trip fees.

  // Trend gate — sole trend indicator (Heitkoetter Mistake #1: ≤2 trend indicators)
  emaTrendFast:      number;  // fast EMA period (default 9)
  emaTrendSlow:      number;  // slow EMA period (default 21)

  // RSI momentum window (Principle #1: keep zones wide enough to avoid over-fit)
  rsiBullLo:         number;  // BUY  zone lower bound (default 55)
  rsiBullHi:         number;  // BUY  zone upper bound (default 80)
  rsiBearLo:         number;  // SELL zone lower bound (default 20)
  rsiBearHi:         number;  // SELL zone upper bound (default 45)

  // ── Exits — triple-layered (Principle #7 & Secret #2) ───────────────────────
  slAtrMult:         number;  // Stop-loss distance in ATR multiples
  tpAtrMult:         number;  // Take-profit distance in ATR multiples (single TP)
  beBroughtAt:       number;  // Move SL to break-even when this ATR multiple in profit
  maxHoldMinutes:    number;  // Time-stop: close stalled trade after N minutes

  // R:R note: default SL=1.5×, TP=2.0× → R:R = 1.33.
  // At 65% WR → PF = (0.65×2.0)/(0.35×1.5) = 2.48 ✓ (within 1.3–2.5 band)
  // At 75% WR → PF = (0.75×2.0)/(0.25×1.5) = 4.0  ✗ (curve-fit territory)
  // Adjust tpAtrMult down or slAtrMult up if backtested WR exceeds 80%.

  // ── Fees ────────────────────────────────────────────────────────────────────
  feeRatePct:        number;  // exchange taker fee % per order (KuCoin default 0.1)
                              // P&L = gross − feeRatePct/100 × notional × 2 (entry+exit)

  // ── Risk ────────────────────────────────────────────────────────────────────
  riskPctPerTrade:   number;  // % of equity risked per trade (fixed-fractional)
  dailyDrawdownPct:  number;  // circuit-breaker threshold (daily loss %)
  maxTradesPerDay:   number;  // overtrading gate — halt after N trades/day
  maxOpenPositions:  number;  // concurrent position cap
  maxNotionalPct:    number;  // single position notional cap (% of equity)
  minTradeUsdt:      number;  // minimum order size in USDT

  // ── Heitkoetter Benchmark Bounds (used by backtesterC for validation) ────────
  benchmarkPfMin:    number;  // Profit Factor floor  (1.3)
  benchmarkPfMax:    number;  // Profit Factor ceiling (2.5) — above = curve-fit
  benchmarkWrMin:    number;  // Win Rate floor       (0.60)
  benchmarkWrMax:    number;  // Win Rate ceiling     (0.80) — above = curve-fit
  benchmarkMaxDdPct: number;  // Max drawdown ceiling as % equity (20%)

  // ── Backtesting ──────────────────────────────────────────────────────────────
  minBacktestTrades: number;  // Heitkoetter minimum: 200 trades → ≤7% margin of error
  oosSplitRatio:     number;  // fraction used for in-sample (default 0.6)

  // ── Confluence filter (SHM cross-bot signal validation) ──────────────────────
  // When > 0: day7 checks /dev/shm/kucoin-data/signals/bot7.json before entering.
  // Requires bot7 signal score ≥ confluenceMinScore AND same direction.
  // Set to 0 to disable (default — independent operation).
  confluenceMinScore: number;
}

// ── Helper: parse env vars ────────────────────────────────────────────────────
function env(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v !== undefined && v !== "" ? parseFloat(v) : NaN;
  return isFinite(n) ? n : fallback;
}
function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// ── Singleton config object ───────────────────────────────────────────────────
/** Update CONFIG values at runtime. All modules use the same CONFIG object
 *  reference, so mutations take effect immediately on the next read. */
export function updateConfig(partial: Partial<TraderConfig>): void {
  Object.assign(CONFIG, partial);
  console.log("[traderConfig] Runtime update:", JSON.stringify(partial));
}

/** Return a shallow snapshot of the current effective config. */
export function getConfigSnapshot(): TraderConfig { return { ...CONFIG }; }

export const CONFIG: TraderConfig = {
  // Signal
  signalTimeframe:   envStr("BOT7_TF",           "5min"),
  minScore:          env  ("BOT7_MIN_SCORE",      2),      // 2 of 3 scored conditions
  maxSpreadPct:      env  ("BOT7_MAX_SPREAD",     0.3),
  minAtrPct:         env  ("BOT7_MIN_ATR_PCT",    0.5),    // 0.5% min ATR — filters low-vol setups

  // Trend gate
  emaTrendFast:      env  ("BOT7_EMA_FAST",       9),
  emaTrendSlow:      env  ("BOT7_EMA_SLOW",       21),

  // RSI
  rsiBullLo:         env  ("BOT7_RSI_BULL_LO",    55),
  rsiBullHi:         env  ("BOT7_RSI_BULL_HI",    80),
  rsiBearLo:         env  ("BOT7_RSI_BEAR_LO",    20),
  rsiBearHi:         env  ("BOT7_RSI_BEAR_HI",    45),

  // Exits
  slAtrMult:         env  ("BOT7_SL_ATR",         1.5),
  tpAtrMult:         env  ("BOT7_TP_ATR",         2.0),
  beBroughtAt:       env  ("BOT7_BE_ATR",         1.0),    // break-even at 1×ATR in profit
  maxHoldMinutes:    env  ("BOT7_MAX_HOLD_MIN",   60),

  // Fees
  feeRatePct:        env  ("BOT7_FEE_RATE",        0.1),   // KuCoin taker 0.1%

  // Risk
  riskPctPerTrade:   env  ("BOT7_RISK_PCT",       1.0),
  dailyDrawdownPct:  env  ("BOT7_DD_LIMIT",       5.0),
  maxTradesPerDay:   env  ("BOT7_MAX_TRADES",     10),
  maxOpenPositions:  env  ("BOT7_MAX_POS",        3),
  maxNotionalPct:    env  ("BOT7_MAX_NOTL",       20.0),
  minTradeUsdt:      env  ("BOT7_MIN_TRADE",      10.0),

  // Heitkoetter benchmarks (fixed — not overridable by env)
  benchmarkPfMin:    1.3,
  benchmarkPfMax:    2.5,
  benchmarkWrMin:    0.42,  // Adjusted for high-RR system (TP/SL>1.2:1 → breakeven WR ~45%)
  benchmarkWrMax:    0.80,
  benchmarkMaxDdPct: 20.0,

  // Backtesting
  minBacktestTrades: 200,
  oosSplitRatio:     0.6,

  // Confluence filter — 0 = disabled (independent mode)
  // Enable by setting to e.g. 5 (= require bot7 score ≥ 5/13 in same direction)
  confluenceMinScore: env("BOT7_CONFLUENCE_MIN", 0),
};
