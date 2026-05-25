/**
 * dayTrader.ts — autonomous signal → order state machine for scalping-day6
 *
 * ── Heitkoetter compliance summary ────────────────────────────────────────────
 * Principle #2  Fill verification: entry fill is polled before SL/TP orders.
 *               SL and TP are anchored to actual fill price, not signal price.
 * Principle #7  Triple-layered exit: SL (stop-market on KuCoin), TP (limit on
 *               KuCoin), and time-stop (in-process after maxHoldMinutes).
 * Mistake #2/3  Both SL and TP are placed on the exchange at entry time — they
 *               execute even if this process crashes between ticks.
 * Overtrading   maxTradesPerDay enforced by RiskManager.canOpenTrade().
 *
 * ── Core loop ─────────────────────────────────────────────────────────────────
 *  1. Refresh equity (every 60s)
 *  2. Guard: producer must be alive
 *  3. Scan all pairs → collect breakout signals (EMA gate + min score)
 *  4. Enter new positions: size → fill → SL stop-order → TP limit-order
 *  5. Manage open positions: time-stop, SL price-check, TP price-check, break-even
 *  6. Persist state
 */

import { nanoid }             from "nanoid";
import type { BreakoutSignal, Position, RiskState, DashboardState, ProducerHealth, SimulationStats, ActivityEvent, WalletEntry, WalletState } from "./types";
import { readCandleFile, readOrderBook, readTicker, isProducerAlive, producerLagMs, readMeta, getBot7Signal, readBot7Signals } from "./cacheReader";
import { detectBreakout }     from "./breakoutDetector";
import { getRiskManager, calcStopLoss, calcTP, calcBEThreshold } from "./riskManager";
import {
  safeMarketBuy, safeMarketSell,
  safePlaceStopOrder, safePlaceTpLimitOrder,
  pollFillPrice, DRY_RUN,
  setSimulationMode, setLiveMode, getCurrentMode, isEffectiveDryRun,
  getAllBalances,
} from "./kucoinExec";
import { CONFIG } from "./traderConfig";

// ── Watched pairs + timeframes ────────────────────────────────────────────────
const DEFAULT_PAIRS = [
  "BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","DOGE-USDT",
  "XRP-USDT","ADA-USDT","AVAX-USDT","MATIC-USDT","DOT-USDT",
  "LINK-USDT","UNI-USDT","ATOM-USDT","LTC-USDT","BCH-USDT",
  "NEAR-USDT","FIL-USDT","APT-USDT","ARB-USDT","OP-USDT",
];
const WATCH_PAIRS: string[] = process.env.BOT7_PAIRS
  ? process.env.BOT7_PAIRS.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_PAIRS;

const LOOP_MS      = 10_000;  // 10-second main loop
const MAX_RECENT   = 50;
const MAX_ACTIVITY = 100;

// ── DayTrader ─────────────────────────────────────────────────────────────────
export class DayTrader {
  private openPositions:   Map<string, Position> = new Map();
  private recentTrades:    Position[]            = [];
  private activityLog:     ActivityEvent[]       = [];
  private activeSignals:   BreakoutSignal[]      = [];
  private candidateSignals: BreakoutSignal[]     = []; // pass G1+G2+G3 but fail minScore
  private running          = false;
  private loopTimer:       NodeJS.Timeout | null = null;
  private lastEquityUpdate = 0;

  private sim: SimulationStats = {
    active:      false,
    trades:      0,
    wins:        0,
    losses:      0,
    pnlUsdt:     0,
    pnlPct:      0,
    startEquity: 0,
    startedAt:   0,
  };

  private walletState: WalletState = {
    entries:     [],
    totalUsdt:   0,
    usdtFree:    0,
    usdtLocked:  0,
    lastUpdated: 0,
  };

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[dayTrader] Starting. DRY_RUN=${DRY_RUN}. Mode=${getCurrentMode()}. Pairs: ${WATCH_PAIRS.length}. MaxTrades/day: ${CONFIG.maxTradesPerDay}`);
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    console.log("[dayTrader] Stopped.");
  }

  /** Start paper-trading simulation (no real orders). */
  startSimulation(startEquity = 1000): void {
    setSimulationMode(true);
    this.sim = {
      active:      true,
      trades:      0,
      wins:        0,
      losses:      0,
      pnlUsdt:     0,
      pnlPct:      0,
      startEquity,
      startedAt:   Date.now(),
    };
    console.log(`[dayTrader] Simulation started. startEquity=$${startEquity}`);
    if (!this.running) this.start();
  }

  /** Stop paper-trading simulation. */
  stopSimulation(): void {
    setSimulationMode(false);
    this.sim.active = false;
    console.log(`[dayTrader] Simulation stopped. Trades=${this.sim.trades} PnL=$${this.sim.pnlUsdt.toFixed(2)}`);
  }

  /** Switch to LIVE trading using real KuCoin USDT. */
  startLiveTrading(): void {
    setLiveMode(true);
    this.sim.active = false;
    console.log("[dayTrader] LIVE trading activated — real orders will be sent to KuCoin");
    if (!this.running) this.start();
  }

  /** Revert to DRY_RUN / idle state. */
  stopLiveTrading(): void {
    setLiveMode(false);
    console.log("[dayTrader] LIVE trading deactivated — reverting to DRY_RUN");
  }

  // ── Main loop ───────────────────────────────────────────────────────────────
  private async loop(): Promise<void> {
    if (!this.running) return;
    try { await this.tick(); }
    catch (e) { console.error("[dayTrader] tick error:", e); }
    this.loopTimer = setTimeout(() => void this.loop(), LOOP_MS);
  }

  private async tick(): Promise<void> {
    const rm  = getRiskManager();
    const now = Date.now();

    // ── 1. Equity refresh (every 60s to avoid hammering the API) ───────────────
    if (now - this.lastEquityUpdate > 60_000) {
      try {
        const { getUsdtBalance } = await import("./kucoinExec");
        const equity = await getUsdtBalance();
        rm.updateEquity(equity);
        rm.maybeDayRoll(equity);
        this.lastEquityUpdate = now;
      } catch (e) {
        console.warn("[dayTrader] equity fetch failed:", e);
      }
      // Live wallet: refresh from KuCoin every 60s alongside equity
      if (!isEffectiveDryRun()) {
        await this.updateLiveWallet();
      }
    }

    // Sim / DRY wallet: recompute every tick (cheap, no API call)
    if (isEffectiveDryRun()) {
      this.updateSimWallet();
    }

    // ── 2. Guard: producer must be alive ────────────────────────────────────────
    if (!isProducerAlive()) {
      console.warn("[dayTrader] Producer not alive — skipping scan");
      return;
    }

    // ── 3. Scan all pairs for breakout signals ──────────────────────────────────
    const signals:    BreakoutSignal[] = [];
    const candidates: BreakoutSignal[] = [];
    for (const symbol of WATCH_PAIRS) {
      const cf   = readCandleFile(symbol, CONFIG.signalTimeframe);
      const book = readOrderBook(symbol);
      if (!cf || cf.candles.length < 60) continue;
      // Normal scan (applies minScore filter)
      const sig = detectBreakout(symbol, CONFIG.signalTimeframe, cf.candles, book);
      if (sig) { signals.push(sig); continue; }
      // Pre-filter scan: passes G1+G2+G3 but fails minScore — shown as "waiting"
      const raw = detectBreakout(symbol, CONFIG.signalTimeframe, cf.candles, book, true);
      if (raw) candidates.push(raw);
    }
    signals.sort((a, b) => b.score - a.score);
    this.activeSignals    = signals;
    this.candidateSignals = candidates;

    // ── 4. Enter new positions (one per symbol, skip duplicates) ─────────────────
    const openSymbols = new Set([...this.openPositions.values()].map(p => p.symbol));
    for (const sig of signals) {
      if (!rm.canOpenTrade()) break;
      if (openSymbols.has(sig.symbol)) continue;
      await this.enter(sig);
      openSymbols.add(sig.symbol);
    }

    // ── 5. Manage open positions ─────────────────────────────────────────────────
    for (const pos of [...this.openPositions.values()]) {
      await this.manage(pos);
    }

    // ── 6. Sync position count + unrealized P&L to risk manager ─────────────────
    rm.setOpenPositions(this.openPositions.size);
    const totalUnrealized = [...this.openPositions.values()]
      .reduce((sum, p) => sum + (p.unrealizedPnlUsdt ?? 0), 0);
    rm.updateUnrealizedPnl(totalUnrealized);
  }

  // ── Enter a position ──────────────────────────────────────────────────────────
  private async enter(sig: BreakoutSignal): Promise<void> {
    const rm    = getRiskManager();
    const isBuy = sig.direction === "BUY";

    // ── Confluence filter (SHM cross-bot validation) ────────────────────────────
    // If confluenceMinScore > 0, require bot7 to agree on direction AND score.
    // bot7 writes /dev/shm/kucoin-data/signals/bot7.json every 30 s.
    // Score 0–13: 0 = disabled, 5 = moderate confirmation, 7 = strong confirmation.
    if (CONFIG.confluenceMinScore > 0) {
      const bot7 = getBot7Signal(sig.symbol);
      if (!bot7) {
        console.log(`[dayTrader] Confluence SKIP ${sig.symbol}: bot7 signal not available (stale or missing)`);
        return;
      }
      if (bot7.direction !== sig.direction) {
        console.log(`[dayTrader] Confluence SKIP ${sig.symbol}: direction conflict — day7=${sig.direction} bot7=${bot7.direction} (score ${bot7.score}/${bot7.maxScore})`);
        return;
      }
      if (bot7.score < CONFIG.confluenceMinScore) {
        console.log(`[dayTrader] Confluence SKIP ${sig.symbol}: bot7 score too low — ${bot7.score}/${bot7.maxScore} < required ${CONFIG.confluenceMinScore}`);
        return;
      }
      console.log(`[dayTrader] Confluence OK ${sig.symbol}: bot7=${bot7.direction} ${bot7.score}/${bot7.maxScore} "${bot7.label}"`);
    }

    // Pre-size with signal price (close approximation; recalculated after fill)
    const estSL  = calcStopLoss(sig.entryPrice, sig.atr, isBuy);
    const sizing = rm.calcPositionSize(sig.entryPrice, estSL);
    if (!sizing) return;

    const { sizeUsdt, riskUsdt } = sizing;

    console.log(
      `[dayTrader] ENTER ${sig.direction} ${sig.symbol} ~@${sig.entryPrice}` +
      ` score=${sig.score}/${sig.maxScore} $${sizeUsdt.toFixed(2)}`
    );

    // ── Place entry market order ─────────────────────────────────────────────────
    let orderId: string;
    try {
      orderId = isBuy
        ? await safeMarketBuy(sig.symbol, sizeUsdt, `bot7-${sig.score}`)
        : await safeMarketSell(sig.symbol, (sizeUsdt / sig.entryPrice).toFixed(6), `bot7-${sig.score}`);
    } catch (e) {
      console.error(`[dayTrader] Entry order failed for ${sig.symbol}:`, e);
      return;
    }

    // ── Principle #2: confirm fill before placing exits ──────────────────────────
    // Poll KuCoin until the market order is matched and we have an actual fill price.
    // Fallback to signal price in dry-run or if polling times out.
    const fillPrice = isEffectiveDryRun()
      ? sig.entryPrice
      : (await pollFillPrice(orderId)) ?? sig.entryPrice;

    // Recalculate SL and TP anchored to actual fill price (not pre-trade signal)
    const sl = calcStopLoss(fillPrice, sig.atr, isBuy);
    const tp = calcTP(fillPrice, sig.atr, isBuy);
    // Size in base currency (for stop and TP orders)
    const sizeBase = (sizeUsdt / fillPrice).toFixed(6);

    console.log(
      `[dayTrader] FILLED ${sig.symbol} @${fillPrice.toFixed(6)}` +
      ` SL=${sl.toFixed(6)} TP=${tp.toFixed(6)} qty=${sizeBase}`
    );

    // ── Place SL stop-market order (layer 1) ─────────────────────────────────────
    try {
      await safePlaceStopOrder({
        symbol:    sig.symbol,
        side:      isBuy ? "sell" : "buy",
        size:      sizeBase,
        stopPrice: sl.toFixed(8),
        remark:    `sl-${orderId.slice(-6)}`,
      });
    } catch (e) {
      console.warn(`[dayTrader] SL stop-order failed for ${sig.symbol}:`, e);
      // Position is still tracked — manage() will close on SL price breach
    }

    // ── Place TP limit order (layer 2) ───────────────────────────────────────────
    // Resting limit order on KuCoin — executes even if this process is down.
    try {
      await safePlaceTpLimitOrder(
        sig.symbol,
        isBuy ? "sell" : "buy",
        sizeBase,
        tp.toFixed(8),
        `tp-${orderId.slice(-6)}`,
      );
    } catch (e) {
      console.warn(`[dayTrader] TP limit-order failed for ${sig.symbol}:`, e);
      // manage() will close on TP price breach as fallback
    }

    // Layer 3 (time-stop) is handled in manage() by watching entryTime.

    const pos: Position = {
      id:            nanoid(8),
      symbol:        sig.symbol,
      direction:     sig.direction,
      entryPrice:    fillPrice,
      entryTime:     Date.now(),
      entryOrderId:  orderId,
      size:          sizeUsdt,
      atrAtEntry:    sig.atr,
      stopLossPrice: sl,
      tp1Price:      tp,   // single TP
      tp2Price:      tp,   // kept for type compat — same value
      tp1Hit:        false, // becomes true when break-even is activated
      state:         "OPEN",
      signalScore:   sig.score,
      riskUsdt,
    };

    this.openPositions.set(pos.id, pos);
    rm.onPositionOpened();

    // ── Log entry event ─────────────────────────────────────────────────────────
    this.activityLog.unshift({
      time:       pos.entryTime,
      type:       "ENTERED",
      symbol:     pos.symbol,
      direction:  pos.direction,
      price:      fillPrice,
      sizeUsdt:   sizeUsdt,
      positionId: pos.id,
    });
    if (this.activityLog.length > MAX_ACTIVITY) this.activityLog.pop();
  }

  // ── Manage open position ───────────────────────────────────────────────────────
  private async manage(pos: Position): Promise<void> {
    const ticker = readTicker(pos.symbol);
    if (!ticker) return;

    const price = ticker.price;
    const isBuy = pos.direction === "BUY";
    const ep    = pos.entryPrice;

    // ── Mark-to-market unrealized P&L (fee-adjusted) ─────────────────────────────
    if (ep > 0) {
      const rawPnl = isBuy
        ? (price - ep) / ep * pos.size
        : (ep - price) / ep * pos.size;
      const feeRate = (CONFIG.feeRatePct ?? 0.1) / 100;
      pos.unrealizedPnlUsdt = isFinite(rawPnl) ? rawPnl - pos.size * feeRate * 2 : 0;
      pos.unrealizedPct     = pos.size > 0 ? (pos.unrealizedPnlUsdt / pos.size) * 100 : 0;
    }

    // ── Layer 3: Time-stop (Heitkoetter Secret #2) ───────────────────────────────
    // If the trade has not reached break-even within maxHoldMinutes, cut it.
    // A stalled trade drains capital opportunity — exit cleanly.
    const holdMin = (Date.now() - pos.entryTime) / 60_000;
    if (holdMin > CONFIG.maxHoldMinutes && !pos.tp1Hit) {
      console.log(`[dayTrader] TIME-STOP ${pos.symbol} after ${holdMin.toFixed(0)}m @${price}`);
      await this.close(pos, price, "TIME_STOP");
      return;
    }

    // ── Layer 1: SL price-check (in-process backup for exchange SL) ──────────────
    const hitSL = isBuy ? price <= pos.stopLossPrice : price >= pos.stopLossPrice;
    if (hitSL) {
      await this.close(pos, price, "SL");
      return;
    }

    // ── Layer 2: TP price-check (in-process backup for exchange TP) ──────────────
    const hitTP = isBuy ? price >= pos.tp1Price : price <= pos.tp1Price;
    if (hitTP) {
      await this.close(pos, price, "TP2");
      return;
    }

    // ── Break-even trail ─────────────────────────────────────────────────────────
    // When price reaches 1×ATR in profit, move SL to entry price.
    // This locks in break-even without closing the position (Mistake #2/3 fix).
    if (!pos.tp1Hit) {
      const beLevel = calcBEThreshold(pos.entryPrice, pos.atrAtEntry, isBuy);
      const beTriggered = isBuy ? price >= beLevel : price <= beLevel;
      if (beTriggered) {
        pos.tp1Hit        = true;           // flag: break-even is active
        pos.stopLossPrice = pos.entryPrice; // move SL to break-even
        pos.state         = "PARTIAL";
        console.log(
          `[dayTrader] Break-even activated ${pos.symbol}` +
          ` @${price.toFixed(6)} — SL moved to ${pos.entryPrice.toFixed(6)}`
        );
      }
    }
  }

  // ── Close a position ──────────────────────────────────────────────────────────
  private async close(
    pos:    Position,
    price:  number,
    reason: "TP1" | "TP2" | "SL" | "TIME_STOP" | "KILL_SWITCH" | "MANUAL",
  ): Promise<void> {
    const isBuy    = pos.direction === "BUY";
    const ep       = pos.entryPrice > 0 ? pos.entryPrice : price;
    const sizeB    = (pos.size / ep).toFixed(6);
    const rawPnl   = isBuy
      ? (price - ep) / ep * pos.size
      : (ep - price) / ep * pos.size;
    const grossPnl = isFinite(rawPnl) ? rawPnl : 0;

    // ── Deduct exchange fees (entry order + exit order) ───────────────────────
    // KuCoin taker fee: default 0.1% per order → 0.2% round-trip on notional.
    const feeRate = (CONFIG.feeRatePct ?? 0.1) / 100;
    const fees    = pos.size * feeRate * 2;
    const pnl     = grossPnl - fees;
    const pnlPct  = (pos.size > 0 && isFinite(pnl)) ? (pnl / pos.size) * 100 : 0;

    console.log(
      `[dayTrader] CLOSE ${reason} ${pos.symbol} @${price}` +
      ` gross=${grossPnl.toFixed(2)} fees=-${fees.toFixed(2)} net=${pnl.toFixed(2)} USDT (${pnlPct.toFixed(2)}%)`
    );

    try {
      if (isBuy) await safeMarketSell(pos.symbol, sizeB,      `close-${reason}`);
      else        await safeMarketBuy (pos.symbol, pos.size,   `close-${reason}`);
    } catch (e) {
      console.error(`[dayTrader] Close order failed for ${pos.symbol}:`, e);
    }

    const closed: Position = {
      ...pos,
      state:      "CLOSED",
      exitPrice:  price,
      exitTime:   Date.now(),
      pnlUsdt:    pnl,
      pnlPct,
      exitReason: reason,
    };

    this.openPositions.delete(pos.id);
    this.recentTrades.unshift(closed);
    if (this.recentTrades.length > MAX_RECENT) this.recentTrades.pop();

    // ── Log exit event ─────────────────────────────────────────────────────────
    this.activityLog.unshift({
      time:       Date.now(),
      type:       "CLOSED",
      symbol:     pos.symbol,
      direction:  pos.direction,
      price,
      sizeUsdt:   pos.size,
      exitReason: reason,
      grossPnl,
      feesUsdt:   fees,
      netPnl:     pnl,
      positionId: pos.id,
    });
    if (this.activityLog.length > MAX_ACTIVITY) this.activityLog.pop();

    // Update simulation stats when in sim mode
    if (this.sim.active || isEffectiveDryRun()) {
      this.sim.trades++;
      if (pnl > 0) this.sim.wins++; else this.sim.losses++;
      this.sim.pnlUsdt += pnl;
      if (this.sim.startEquity > 0) {
        this.sim.pnlPct = (this.sim.pnlUsdt / this.sim.startEquity) * 100;
      }
    }

    getRiskManager().onPositionClosed(pnl);
  }

  // ── Wallet tracking ────────────────────────────────────────────────────────────

  /** Derives a virtual wallet from sim/DRY state — no API calls. */
  private updateSimWallet(): void {
    const openPos    = [...this.openPositions.values()];
    const lockedUsdt = openPos.reduce((s, p) => s + p.size, 0);
    const base       = this.sim.startEquity > 0 ? this.sim.startEquity : (getRiskManager().getState().accountEquity || 1000);
    const totalUsdt  = base + this.sim.pnlUsdt;
    const freeUsdt   = Math.max(0, totalUsdt - lockedUsdt);

    const entries: WalletEntry[] = [
      { currency: "USDT", balance: totalUsdt, valueUsdt: totalUsdt, inOpenPos: lockedUsdt > 0 },
    ];

    // Add virtual crypto holdings from open BUY positions
    for (const pos of openPos) {
      if (pos.direction !== "BUY") continue;
      const ticker     = readTicker(pos.symbol);
      const priceUsdt  = ticker?.price ?? pos.entryPrice;
      const baseQty    = pos.entryPrice > 0 ? pos.size / pos.entryPrice : 0;
      entries.push({
        currency:  pos.symbol.replace("-USDT", ""),
        balance:   baseQty,
        valueUsdt: baseQty * priceUsdt,
        priceUsdt,
        inOpenPos: true,
      });
    }

    this.walletState = {
      entries,
      totalUsdt,
      usdtFree:    freeUsdt,
      usdtLocked:  lockedUsdt,
      lastUpdated: Date.now(),
    };
  }

  /** Fetches real KuCoin balances and maps them to WalletEntry[]. */
  private async updateLiveWallet(): Promise<void> {
    try {
      const balances  = await getAllBalances();
      const openPos   = [...this.openPositions.values()];
      const openCrypto = new Set(openPos.map(p => p.symbol.replace("-USDT", "")));

      const entries: WalletEntry[] = [];
      let totalUsdt  = 0;
      let usdtFree   = 0;
      let usdtLocked = 0;

      for (const b of balances) {
        const bal = parseFloat(b.balance);
        if (!isFinite(bal) || bal <= 0) continue;

        if (b.currency === "USDT") {
          const avail  = parseFloat(b.available);
          const locked = bal - avail;
          entries.push({ currency: "USDT", balance: bal, valueUsdt: bal, inOpenPos: locked > 0 });
          totalUsdt  += bal;
          usdtFree   += avail;
          usdtLocked += locked;
        } else {
          const ticker    = readTicker(`${b.currency}-USDT`);
          const priceUsdt = ticker?.price;
          const valueUsdt = priceUsdt != null ? bal * priceUsdt : 0;
          if (valueUsdt < 0.01) continue; // skip dust
          entries.push({
            currency:  b.currency,
            balance:   bal,
            valueUsdt,
            priceUsdt,
            inOpenPos: openCrypto.has(b.currency),
          });
          totalUsdt += valueUsdt;
        }
      }

      this.walletState = {
        entries:     entries.sort((a, b) => b.valueUsdt - a.valueUsdt),
        totalUsdt,
        usdtFree,
        usdtLocked,
        lastUpdated: Date.now(),
      };
    } catch (e) {
      console.warn("[dayTrader] live wallet update failed:", e);
    }
  }

  // ── Kill switch ────────────────────────────────────────────────────────────────
  async activateKillSwitch(): Promise<void> {
    getRiskManager().activateKillSwitch();
    for (const pos of [...this.openPositions.values()]) {
      const ticker = readTicker(pos.symbol);
      const price  = ticker?.price ?? pos.entryPrice;
      await this.close(pos, price, "KILL_SWITCH");
    }
  }

  deactivateKillSwitch(): void { getRiskManager().deactivateKillSwitch(); }

  // ── Dashboard snapshot ─────────────────────────────────────────────────────────
  getDashboard(): DashboardState {
    const meta = readMeta();
    const producerHealth: ProducerHealth = {
      alive:      isProducerAlive(),
      lagMs:      producerLagMs(),
      cycleCount: meta?.cycleCount ?? 0,
      errorCount: meta?.errorCount ?? 0,
      shmRoot:    meta?.shmRoot    ?? "",
    };

    return {
      producerHealth,
      riskState:     getRiskManager().getState(),
      openPositions: [...this.openPositions.values()],
      recentTrades:  this.recentTrades,
      activityLog:   this.activityLog,
      activeSignals:  this.activeSignals,
      blockedSignals: this.candidateSignals.length,
      timestamp:      Date.now(),
      tradingActive: this.running,
      mode:          getCurrentMode(),
      simulation:    { ...this.sim },
      wallet:           { ...this.walletState },
      bot7SignalsAgeMs: (() => {
        const f = readBot7Signals();
        return f ? Date.now() - f.writtenAt : -1;
      })(),
    };
  }

  // ── Accessors ──────────────────────────────────────────────────────────────────
  getOpenPositions():  Position[]       { return [...this.openPositions.values()]; }
  getRecentTrades():   Position[]       { return this.recentTrades; }
  getActiveSignals():  BreakoutSignal[] { return this.activeSignals; }
  getRiskState():      RiskState        { return getRiskManager().getState(); }
}

// ── Singleton ──────────────────────────────────────────────────────────────────
// Use globalThis so Next.js App Router's per-route module isolation doesn't
// create separate DayTrader instances for api/trading vs api/dashboard.
const _gd = globalThis as unknown as { __day7Trader?: DayTrader };
export function getDayTrader(): DayTrader {
  if (!_gd.__day7Trader) _gd.__day7Trader = new DayTrader();
  return _gd.__day7Trader;
}
