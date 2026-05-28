/**
 * riskManager.ts — position sizing, circuit breakers, kill-switch for scalping-day6
 *
 * Position sizing: fixed fractional (1% risk per trade by default).
 * Circuit breaker: halt new trades when daily drawdown ≥ DAILY_DRAWDOWN_LIMIT.
 * Kill switch:     flatten ALL positions + halt until manually reset.
 *
 * State is kept in memory and persisted to a JSON sidecar on disk so
 * PM2 restarts don't reset daily P&L.
 */

import * as fs   from "node:fs";
import * as path from "node:path";
import * as os   from "node:os";
import type { Position, RiskState } from "./types";
import { CONFIG } from "./traderConfig";

// ── Config aliases (from CONFIG for readability) ──────────────────────────────
// All thresholds sourced from CONFIG so they honour environment overrides.
// Local aliases avoid repeating CONFIG.xxx everywhere inside the class.
const RISK_PER_TRADE_PCT   = () => CONFIG.riskPctPerTrade;
const DAILY_DRAWDOWN_LIMIT = () => CONFIG.dailyDrawdownPct;
const MAX_OPEN_POSITIONS   = () => CONFIG.maxOpenPositions;
const MAX_NOTIONAL_PCT     = () => CONFIG.maxNotionalPct;
const MIN_TRADE_USDT       = () => CONFIG.minTradeUsdt;
const MAX_TRADES_DAY       = () => CONFIG.maxTradesPerDay;

// ── State file ────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(
  process.platform === "linux"
    ? path.join(os.tmpdir(), "kucoin-data")
    : path.join(os.tmpdir(), "kucoin-data"),
  "bot6-risk-state.json",
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function readStateFile(): Partial<RiskState> | null {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}

function writeStateFile(state: RiskState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error("[riskManager] Failed to persist state:", e);
  }
}

// ── RiskManager class ─────────────────────────────────────────────────────────
export class RiskManager {
  private state: RiskState;
  private _dayKey: string;

  constructor(initialEquity: number) {
    this._dayKey = todayUtcDate();
    const saved  = readStateFile();

    // If saved state is from today and not a fresh date, restore it
    if (saved && saved.lastUpdated && new Date(saved.lastUpdated).toISOString().slice(0, 10) === this._dayKey) {
      this.state = {
        accountEquity:        initialEquity,       // always use live balance
        dailyStartEquity:     saved.dailyStartEquity    ?? initialEquity,
        dailyPnlUsdt:         saved.dailyPnlUsdt        ?? 0,
        dailyPnlPct:          saved.dailyPnlPct         ?? 0,
        circuitBreakerActive: saved.circuitBreakerActive ?? false,
        killSwitchActive:     saved.killSwitchActive     ?? false,
        totalTradesDay:       saved.totalTradesDay       ?? 0,
        winsDay:              saved.winsDay              ?? 0,
        lossesDay:            saved.lossesDay            ?? 0,
        maxDrawdownPct:       saved.maxDrawdownPct       ?? 0,
        openPositions:        0,
        lastUpdated:          Date.now(),
      };
    } else {
      // New day — reset daily counters
      this.state = {
        accountEquity:       initialEquity,
        dailyStartEquity:    initialEquity,
        dailyPnlUsdt:        0,
        dailyPnlPct:         0,
        circuitBreakerActive: false,
        killSwitchActive:    false,
        totalTradesDay:      0,
        winsDay:             0,
        lossesDay:           0,
        maxDrawdownPct:      0,
        openPositions:       0,
        lastUpdated:         Date.now(),
      };
    }
  }

  // ── Daily reset ─────────────────────────────────────────────────────────────
  /** Call once per loop iteration; handles UTC midnight day-roll. */
  maybeDayRoll(currentEquity: number): void {
    const today = todayUtcDate();
    if (today !== this._dayKey) {
      console.log(`[riskManager] Day roll ${this._dayKey} → ${today}; resetting daily state`);
      this._dayKey = today;
      this.state.dailyStartEquity    = currentEquity;
      this.state.dailyPnlUsdt        = 0;
      this.state.dailyPnlPct         = 0;
      this.state.circuitBreakerActive = false;
      this.state.totalTradesDay      = 0;
      this.state.winsDay             = 0;
      this.state.lossesDay           = 0;
      this.state.maxDrawdownPct      = 0;
    }
    this.state.accountEquity = currentEquity;
    this.state.lastUpdated   = Date.now();
    this.persist();
  }

  // ── Position sizing ─────────────────────────────────────────────────────────
  /**
   * Calculate USDT notional to risk on a trade.
   *
   * Uses fixed-fractional Kelly:
   *   riskUsdt = equity × RISK_PCT
   *   size     = riskUsdt / (entryPrice × stopDistancePct)
   *
   * Returns `null` if the trade should be skipped (circuit breaker, etc.)
   */
  calcPositionSize(
    entryPrice:  number,
    stopPrice:   number,
    equity?:     number,
  ): { sizeUsdt: number; riskUsdt: number } | null {
    if (!this.canOpenTrade()) return null;

    const eq          = equity ?? this.state.accountEquity;
    const riskUsdt    = eq * (RISK_PER_TRADE_PCT() / 100);
    if (entryPrice <= 0) return null;
    const stopDist    = Math.abs(entryPrice - stopPrice);
    const stopDistPct = stopDist / entryPrice;

    if (stopDistPct <= 0 || !isFinite(stopDistPct)) return null;

    // size in USDT = riskUsdt / stopDistPct
    let sizeUsdt = riskUsdt / stopDistPct;

    // Cap at MAX_NOTIONAL_PCT of equity
    const maxSize = eq * (MAX_NOTIONAL_PCT() / 100);
    sizeUsdt = Math.min(sizeUsdt, maxSize);

    if (sizeUsdt < MIN_TRADE_USDT()) return null;

    return { sizeUsdt, riskUsdt };
  }

  // ── Guards ──────────────────────────────────────────────────────────────────
  canOpenTrade(): boolean {
    if (this.state.killSwitchActive)                         return false;
    if (this.state.circuitBreakerActive)                     return false;
    if (this.state.openPositions >= MAX_OPEN_POSITIONS())    return false;
    // Heitkoetter overtrading gate: hard cap on daily trade count
    if (this.state.totalTradesDay >= MAX_TRADES_DAY())       return false;
    return true;
  }

  // ── Position lifecycle callbacks ────────────────────────────────────────────
  onPositionOpened(): void {
    this.state.openPositions++;
    this.state.lastUpdated = Date.now();
    this.persist();
  }

  onPositionClosed(pnlUsdt: number): void {
    if (this.state.openPositions > 0) this.state.openPositions--;
    this.state.dailyPnlUsdt  += pnlUsdt;
    this.state.totalTradesDay++;
    if (pnlUsdt >= 0) this.state.winsDay++;
    else              this.state.lossesDay++;

    const eq = this.state.dailyStartEquity;
    this.state.dailyPnlPct = eq > 0 ? (this.state.dailyPnlUsdt / eq) * 100 : 0;

    // Track worst intra-day drawdown
    if (this.state.dailyPnlPct < -this.state.maxDrawdownPct) {
      this.state.maxDrawdownPct = Math.abs(this.state.dailyPnlPct);
    }

    // Circuit breaker check
    if (this.state.dailyPnlPct <= -DAILY_DRAWDOWN_LIMIT() && !this.state.circuitBreakerActive) {
      console.warn(`[riskManager] CIRCUIT BREAKER: daily P&L = ${this.state.dailyPnlPct.toFixed(2)}% ≤ -${DAILY_DRAWDOWN_LIMIT()}% → halting new trades`);
      this.state.circuitBreakerActive = true;
    }

    this.state.lastUpdated = Date.now();
    this.persist();
  }

  // ── Unrealized drawdown guard ───────────────────────────────────────────────
  /**
   * Called each tick with the sum of all open-position mark-to-market P&L.
   * Fires the circuit breaker when REALIZED + UNREALIZED combined exceeds
   * the daily drawdown limit — prevents waiting for positions to close before
   * halting new entries.
   */
  updateUnrealizedPnl(totalUnrealizedUsdt: number): void {
    const combinedPnl = this.state.dailyPnlUsdt + totalUnrealizedUsdt;
    const eq = this.state.dailyStartEquity;
    const combinedPct = eq > 0 ? (combinedPnl / eq) * 100 : 0;

    if (combinedPct <= -DAILY_DRAWDOWN_LIMIT() && !this.state.circuitBreakerActive) {
      console.warn(
        `[riskManager] CIRCUIT BREAKER (unrealized): combined P&L ${combinedPct.toFixed(2)}%` +
        ` (realized ${this.state.dailyPnlUsdt.toFixed(2)} + unrealized ${totalUnrealizedUsdt.toFixed(2)} USDT) ≤ -${DAILY_DRAWDOWN_LIMIT()}%`
      );
      this.state.circuitBreakerActive = true;
      this.state.lastUpdated = Date.now();
      this.persist();
    }
  }

  // ── Kill switch ─────────────────────────────────────────────────────────────
  activateKillSwitch(): void {
    console.warn("[riskManager] KILL SWITCH ACTIVATED — all new trades blocked");
    this.state.killSwitchActive     = true;
    this.state.circuitBreakerActive = true;
    this.state.lastUpdated          = Date.now();
    this.persist();
  }

  deactivateKillSwitch(): void {
    console.log("[riskManager] Kill switch deactivated");
    this.state.killSwitchActive = false;
    this.persist();
  }

  // ── Simulation reset ────────────────────────────────────────────────────────
  /**
   * Hard-reset all daily counters to a clean slate for a new simulation.
   * Called by DayTrader.startSimulation() so stale live-session state
   * (old totalTradesDay, circuitBreaker, etc.) does not bleed into the sim.
   */
  resetForSimulation(equity: number): void {
    console.log(`[riskManager] Resetting daily state for new simulation. equity=$${equity}`);
    this._dayKey = todayUtcDate();
    this.state.accountEquity        = equity;
    this.state.dailyStartEquity     = equity;
    this.state.dailyPnlUsdt         = 0;
    this.state.dailyPnlPct          = 0;
    this.state.circuitBreakerActive = false;
    this.state.killSwitchActive     = false;
    this.state.totalTradesDay       = 0;
    this.state.winsDay              = 0;
    this.state.lossesDay            = 0;
    this.state.maxDrawdownPct       = 0;
    this.state.openPositions        = 0;
    this.state.lastUpdated          = Date.now();
    this.persist();
  }

  // ── Equity update ───────────────────────────────────────────────────────────
  updateEquity(equity: number): void {
    this.state.accountEquity = equity;
    this.state.lastUpdated   = Date.now();
    this.persist();
  }

  setOpenPositions(count: number): void {
    this.state.openPositions = count;
    this.persist();
  }

  // ── Getters ─────────────────────────────────────────────────────────────────
  getState(): RiskState   { return { ...this.state }; }
  isKillSwitch(): boolean { return this.state.killSwitchActive; }
  isCircuitBreaker(): boolean { return this.state.circuitBreakerActive; }

  // ── Persistence ─────────────────────────────────────────────────────────────
  private persist(): void { writeStateFile(this.state); }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
// Created lazily on first call to `getRiskManager(initialEquity)`.
let _instance: RiskManager | null = null;

export function getRiskManager(initialEquity = 1000): RiskManager {
  if (!_instance) _instance = new RiskManager(initialEquity);
  return _instance;
}

// ── ATR-based exit price helpers ──────────────────────────────────────────────
// All multipliers sourced from CONFIG (env-overridable).
// Single TP replaces old TP1/TP2 split — simplifies exit logic (Principle #7).

/** Stop-loss price: entry ± SL_ATR_MULT × ATR */
export function calcStopLoss(entry: number, atr: number, isBuy: boolean): number {
  return isBuy ? entry - atr * CONFIG.slAtrMult : entry + atr * CONFIG.slAtrMult;
}

/** Take-profit price: entry ± TP_ATR_MULT × ATR (single TP) */
export function calcTP(entry: number, atr: number, isBuy: boolean): number {
  return isBuy ? entry + atr * CONFIG.tpAtrMult : entry - atr * CONFIG.tpAtrMult;
}

/** Break-even trigger: move SL to entry when this price level is reached */
export function calcBEThreshold(entry: number, atr: number, isBuy: boolean): number {
  return isBuy ? entry + atr * CONFIG.beBroughtAt : entry - atr * CONFIG.beBroughtAt;
}

// Backward-compat aliases — used by old code paths that imported calcTP1/calcTP2
export const calcTP1 = calcTP;
export const calcTP2 = calcTP;
