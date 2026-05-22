// ─── Trading Orchestrator ────────────────────────────────────────────────────
import { Candle, TradePosition, BacktestParams } from './types';
import { scoreSignal, ScoreResult } from './signalEngine';
import { computeIndicators } from './indicators';
import {
  calculateTradeParams, evaluatePosition, buildPosition,
  updateDailyRisk, canOpenTrade, HARD_CAP_USD,
  DAILY_DRAWDOWN_LIMIT, DailyRiskState,
} from './riskReward';
import {
  buildFingerprintFull, storePattern, recordOutcome,
} from './patternMemory';
import {
  fetchCandles, fetchAccountBalance, placeOrder,
  placeStopOrder, cancelStopOrder, KuCoinInterval,
} from './kuCoinClient';
import { getFeed } from './kuCoinWebSocket';
import { adaptiveOptimise, DEFAULT_OPTIMISER_CONFIG, runBacktest } from './backtester';

export interface EngineConfig {
  symbol: string;
  interval: KuCoinInterval;
  signalThreshold: number;
  atrMultiplierSL: number;
  atrMultiplierTP: number;
  paperMode: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
  symbol: process.env.TRADING_SYMBOL ?? 'BTC-USDT',
  interval: (process.env.TRADING_INTERVAL as KuCoinInterval) ?? '15min',
  signalThreshold: parseInt(process.env.SIGNAL_THRESHOLD ?? '4'),
  atrMultiplierSL: 1.5,
  atrMultiplierTP: 3.0,
  paperMode: true,
};

export interface PerformanceStats {
  winRate: number;
  ev: number;
  totalPnL: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  sharpeRatio: number;
}

export class TradingEngine {
  private candles: Candle[] = [];
  private openPosition: TradePosition | null = null;
  private openSlOrderId: string | null = null;
  private openTpOrderId: string | null = null;
  private completedTrades: TradePosition[] = [];
  private tradeIdCounter = 0;
  private dailyState: DailyRiskState;
  private params: BacktestParams;
  public config: EngineConfig;
  private isRunning = false;
  private lastDayTs = 0;
  private prevIndicators = computeIndicators([]);
  private latestSignal: ScoreResult | null = null;
  private startError: string | null = null;

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.params = {
      signalThreshold: this.config.signalThreshold,
      atrMultiplierSL: this.config.atrMultiplierSL,
      atrMultiplierTP: this.config.atrMultiplierTP,
      maxTradeUSD: HARD_CAP_USD,
      dailyDrawdownLimit: DAILY_DRAWDOWN_LIMIT,
    };
    this.dailyState = {
      startingCapital: 10_000,
      currentCapital: 10_000,
      dailyLoss: 0,
      isBreached: false,
    };
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.startError = null;
    this.isRunning = true;

    console.log(`[Engine] Starting ${this.config.symbol} @ ${this.config.interval}` +
      (this.config.paperMode ? ' [PAPER]' : ' [LIVE]'));

    try {
      const bal = await fetchAccountBalance('USDT');
      this.dailyState = {
        startingCapital: bal.available,
        currentCapital: bal.available,
        dailyLoss: 0,
        isBreached: false,
      };
      console.log(`[Engine] Balance: $${bal.available.toFixed(2)} USDT`);
    } catch (err) {
      console.warn('[Engine] Balance fetch failed — using paper capital:', err);
    }

    try {
      this.candles = await fetchCandles(this.config.symbol, this.config.interval, 200);
      this.prevIndicators = computeIndicators(this.candles);
      console.log(`[Engine] Seeded ${this.candles.length} candles`);
    } catch (err) {
      this.startError = `Candle fetch failed: ${err}`;
      this.isRunning = false;
      return;
    }

    const feed = getFeed();
    await feed.start();
    feed.onCandle(this.config.symbol, this.config.interval, this.onCandle.bind(this));
    console.log('[Engine] Live feed active');
  }

  stop(): void {
    this.isRunning = false;
    getFeed().stop();
    console.log('[Engine] Stopped');
  }

  updateConfig(patch: Partial<EngineConfig>): void {
    const wasRunning = this.isRunning;
    if (wasRunning) this.stop();
    this.config = { ...this.config, ...patch };
    this.params = { ...this.params, signalThreshold: this.config.signalThreshold };
    if (wasRunning) this.start();
  }

  // ── Candle handler ─────────────────────────────────────────────────────────

  private async onCandle(candle: Candle, _symbol: string, isClosed: boolean): Promise<void> {
    const last = this.candles[this.candles.length - 1];
    if (last && last.timestamp === candle.timestamp) {
      this.candles[this.candles.length - 1] = candle;
    } else {
      this.candles.push(candle);
      if (this.candles.length > 500) this.candles.shift();
    }

    if (!isClosed) return;

    const dayTs = Math.floor(candle.timestamp / 86400000);
    if (dayTs !== this.lastDayTs) {
      this.dailyState = {
        startingCapital: this.dailyState.currentCapital,
        currentCapital: this.dailyState.currentCapital,
        dailyLoss: 0,
        isBreached: false,
      };
      this.lastDayTs = dayTs;
    }

    if (this.openPosition) await this.managePosition(candle);
    if (!this.openPosition && canOpenTrade(this.dailyState)) {
      await this.evaluateEntry(candle);
    }

    this.prevIndicators = computeIndicators(this.candles) ?? this.prevIndicators;
  }

  // ── Position management ────────────────────────────────────────────────────

  private async managePosition(candle: Candle): Promise<void> {
    const pos = this.openPosition!;
    const result = evaluatePosition(pos, candle.close, candle.high, candle.low);

    if (result.action === 'PARTIAL_EXIT') {
      pos.remainingSize -= result.sizeExited;
      pos.breakEvenActive = true;
      pos.stopLoss = result.newStopLoss!;
      pos.pnl += result.pnl;
      this.dailyState = updateDailyRisk(this.dailyState, result.pnl);
      console.log(`[Engine] TP1 @ ${result.exitPrice} — BE stop active`);
      if (!this.config.paperMode) await this.executePartialExit(pos, result.sizeExited, result.exitPrice);

    } else if (result.action === 'FULL_EXIT') {
      pos.pnl += result.pnl;
      pos.exitPrice = result.exitPrice;
      pos.exitTime = candle.timestamp;
      pos.status = result.pnl >= 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS';
      this.dailyState = updateDailyRisk(this.dailyState, result.pnl);

      const rMult = pos.pnl / Math.max(0.01,
        Math.abs(pos.entryPrice - pos.stopLoss) * (pos.size / pos.entryPrice));

      recordOutcome(pos.id, { status: pos.status, pnl: pos.pnl, holdBars: 0, rMultiple: rMult });

      console.log(`[Engine] ${pos.id} ${pos.status} ${result.exitReason} @ ${result.exitPrice} | PnL $${pos.pnl.toFixed(2)} | ${rMult.toFixed(2)}R`);

      this.completedTrades.push({ ...pos });
      this.openPosition = null;
      this.openSlOrderId = null;
      this.openTpOrderId = null;

      if (!this.config.paperMode) await this.cancelBracketOrders();

      this.params = adaptiveOptimise(
        this.candles, this.completedTrades.length,
        this.params, DEFAULT_OPTIMISER_CONFIG
      );
    }
  }

  // ── Entry evaluation ───────────────────────────────────────────────────────

  private async evaluateEntry(candle: Candle): Promise<void> {
    const result = scoreSignal(this.candles, this.prevIndicators ?? undefined);
    this.latestSignal = result;
    if (!result || result.score < this.params.signalThreshold) return;
    if (result.direction === 'NEUTRAL') return;

    const tradeParams = calculateTradeParams(
      candle.close, result.direction, result.indicators.atr,
      this.dailyState.currentCapital,
      this.params.atrMultiplierSL, this.params.atrMultiplierTP
    );
    if (!tradeParams || tradeParams.positionSizeUSD > this.params.maxTradeUSD) return;

    const id = `t-${String(++this.tradeIdCounter).padStart(3, '0')}`;
    this.openPosition = buildPosition(id, this.config.symbol, result.direction, tradeParams, candle.timestamp, result.score);

    storePattern(buildFingerprintFull(
      id, this.config.symbol, result.direction, result.score,
      result.indicators, candle.close, candle.volume,
      result.wick.strength,
      result.wick.direction === 'BULLISH' ? 1 : result.wick.direction === 'BEARISH' ? -1 : 0,
      candle.timestamp
    ));

    console.log(`[Engine] ENTRY ${result.direction} @ ${candle.close} score=${result.score}/6${this.config.paperMode ? ' [PAPER]' : ''}`);
    if (!this.config.paperMode) await this.executeBracketEntry(this.openPosition, tradeParams);
  }

  // ── Order execution ────────────────────────────────────────────────────────

  private async executeBracketEntry(
    pos: TradePosition,
    params: NonNullable<ReturnType<typeof calculateTradeParams>>
  ): Promise<void> {
    const side = pos.direction === 'LONG' ? 'buy' : 'sell';
    const closeSide = side === 'buy' ? 'sell' : 'buy';
    const qty = (params.positionSizeUSD / pos.entryPrice).toFixed(6);
    try {
      await placeOrder({ symbol: pos.symbol, side, type: 'market', size: qty });
      const sl = await placeStopOrder({ symbol: pos.symbol, side: closeSide, size: qty, stopPrice: params.stopLoss.toFixed(4) });
      this.openSlOrderId = sl.orderId;
      const tp = await placeOrder({ symbol: pos.symbol, side: closeSide, type: 'limit', size: (parseFloat(qty) * 0.5).toFixed(6), price: params.tp1.toFixed(4) });
      this.openTpOrderId = tp.orderId;
    } catch (err) {
      console.error('[Engine] Order failed:', err);
      this.openPosition = null;
    }
  }

  private async executePartialExit(pos: TradePosition, size: number, price: number): Promise<void> {
    try {
      await placeOrder({ symbol: pos.symbol, side: pos.direction === 'LONG' ? 'sell' : 'buy', type: 'market', size: (size / price).toFixed(6) });
    } catch (err) { console.error('[Engine] Partial exit failed:', err); }
  }

  private async cancelBracketOrders(): Promise<void> {
    if (this.openSlOrderId) { try { await cancelStopOrder(this.openSlOrderId); } catch { /* filled */ } this.openSlOrderId = null; }
    if (this.openTpOrderId) { try { /* cancel limit TP */ } catch { /* filled */ } this.openTpOrderId = null; }
  }

  // ── Public API for dashboard ───────────────────────────────────────────────

  getStatus() {
    const lastPrice = this.candles.length > 0 ? this.candles[this.candles.length - 1].close : 0;
    return {
      isRunning: this.isRunning,
      startError: this.startError,
      symbol: this.config.symbol,
      interval: this.config.interval,
      paperMode: this.config.paperMode,
      openPosition: this.openPosition,
      completedTradesCount: this.completedTrades.length,
      capital: this.dailyState.currentCapital,
      dailyDrawdown: this.dailyState.startingCapital > 0
        ? this.dailyState.dailyLoss / this.dailyState.startingCapital : 0,
      drawdownBreached: this.dailyState.isBreached,
      currentParams: this.params,
      lastCandle: this.candles[this.candles.length - 1] ?? null,
      lastPrice,
      latestSignal: this.latestSignal,
      performance: this.computePerformance(),
    };
  }

  getCandles(limit = 200): Candle[] {
    return this.candles.slice(-limit);
  }

  getRecentTrades(limit = 50): TradePosition[] {
    return this.completedTrades.slice(-limit).reverse();
  }

  runQuickBacktest(): ReturnType<typeof runBacktest> {
    return runBacktest(this.candles, this.params, this.config.symbol);
  }

  private computePerformance(): PerformanceStats | null {
    const trades = this.completedTrades;
    if (trades.length === 0) return null;
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const winRate = wins.length / trades.length;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const ev = winRate * avgWin - (1 - winRate) * avgLoss;
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);

    let peak = this.dailyState.startingCapital;
    let cap = this.dailyState.startingCapital;
    let maxDrawdown = 0;
    for (const t of trades) {
      cap += t.pnl;
      if (cap > peak) peak = cap;
      const dd = (peak - cap) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const returns = trades.map((t) => t.pnl / this.dailyState.startingCapital);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.length > 1
      ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1) : 1;
    const sharpeRatio = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;

    return { winRate, ev, totalPnL, avgWin, avgLoss, maxDrawdown, sharpeRatio };
  }
}
