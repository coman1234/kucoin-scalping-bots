/**
 * serverBot.ts — SERVER-ONLY trading bot singleton.
 *
 * Runs the live trading loop entirely on the Node.js process.
 * The browser only polls /api/trading/bot for status and sends
 * start/stop commands. Closing the browser does NOT stop the bot.
 */

import { promises as fs }  from "fs";
import path                 from "path";
import { getCandles }       from "./kucoinPublic";
import { generateSignal }   from "./signalEngine";
import { calculateRiskReward } from "./riskReward";
import {
  placeOrder, placeStopOrder,
  getTradeAccounts, cancelAllOrders, cancelStopOrder,
} from "./kucoinPrivate";
import { writeToFileLog }   from "./serverLogger";

const DATA_DIR    = path.join(process.cwd(), "data");
const STATE_PATH  = path.join(DATA_DIR, "bot-state.json");
const PARAMS_PATH = path.join(DATA_DIR, "botConfig-pipeline.json");
const TRADES_PATH = path.join(DATA_DIR, "trades.json");

const ENTRY_TICK_MS    = 60_000;
const POSITION_TICK_MS = 15_000;
const BALANCE_CACHE_MS = 30_000;
const KUCOIN_FEE       = 0.001;
const SLIPPAGE         = 0.0003;
const DEFAULT_SYMBOL   = "BTC-USDT";
const DEFAULT_TF       = "5min";
const MIN_CANDLES      = 60;
const MAX_TRADES_SAVED = 2_000;

// Maximum USDT capital allocated to bot7 (0 = use full available balance).
// Set BOT7_MAX_CAPITAL in .env to ring-fence a portion of the wallet for bot7.
// Example: BOT7_MAX_CAPITAL=500 keeps bot7 within a 500 USDT budget while
// the remaining balance is available for day7 or other use.
const BOT7_MAX_CAPITAL = (() => {
  const v = parseFloat(process.env.BOT7_MAX_CAPITAL ?? "0");
  return isFinite(v) && v > 0 ? v : 0;
})();

export interface BotOpenPosition {
  id:                 string;
  direction:          "BUY" | "SELL";
  entryPrice:         number;
  entryTime:          number;
  size:               number;
  sizeUSDT:           number;
  stopLossPrice:      number;
  tp1Price:           number;
  tp2Price:           number;
  tp1Hit:             boolean;
  slMovedToBreakeven: boolean;
  trailingStopPrice?: number;
  atrAtEntry:         number;
  currentPrice:       number;
  unrealizedPnlPct:   number;
  unrealizedPnlUSDT:  number;
  orderId:            string;
  stopOrderId?:       string;
  signalScore:        number;
}

export interface BotState {
  status:     "stopped" | "running" | "error";
  symbol:     string;
  timeframe:  string;
  startedAt:  number | null;
  lastTickAt: number | null;
  nextTickAt: number | null;
  openPosition: BotOpenPosition | null;
  lastSignal: {
    direction: "BUY" | "SELL" | "NEUTRAL";
    score:     number;
    label:     string;
    timestamp: number;
  } | null;
  params: {
    minSignalScore:         number;
    stopLossAtrMultiplier:  number;
    takeProfitMultiplier:   number;
    rsiOversoldThreshold:   number;
    rsiOverboughtThreshold: number;
    volumeMultiplier:       number;
    tradeAmountUSDT:        number;
    winRate:                number;
    profitFactor:           number;
  } | null;
  sessionStats: {
    trades:  number;
    wins:    number;
    losses:  number;
    pnlUSDT: number;
  };
  lastError: string | null;
}

let botState: BotState = {
  status:       "stopped",
  symbol:       DEFAULT_SYMBOL,
  timeframe:    DEFAULT_TF,
  startedAt:    null,
  lastTickAt:   null,
  nextTickAt:   null,
  openPosition: null,
  lastSignal:   null,
  params:       null,
  sessionStats: { trades: 0, wins: 0, losses: 0, pnlUSDT: 0 },
  lastError:    null,
};

let tickTimer: ReturnType<typeof setTimeout> | null = null;

let cachedBalance:     number | null = null;
let balanceCachedAt:   number        = 0;

async function getUsdtBalance(): Promise<number> {
  if (cachedBalance !== null && Date.now() - balanceCachedAt < BALANCE_CACHE_MS) {
    return cachedBalance;
  }
  try {
    const accounts  = await getTradeAccounts();
    const usdt      = accounts.find(a => a.currency === "USDT");
    cachedBalance   = usdt ? parseFloat(usdt.available) : 0;
    balanceCachedAt = Date.now();
    return cachedBalance;
  } catch {
    return cachedBalance ?? 0;
  }
}

function invalidateBalanceCache() {
  cachedBalance = null;
}

let tradesBuffer: unknown[] = [];
let tradesDirty  = false;

async function loadTradesBuffer(): Promise<void> {
  try {
    const raw    = await fs.readFile(TRADES_PATH, "utf-8");
    tradesBuffer = JSON.parse(raw) as unknown[];
  } catch {
    tradesBuffer = [];
  }
}

function flushTrades(): void {
  if (!tradesDirty) return;
  tradesDirty = false;
  const snapshot = tradesBuffer.slice(-MAX_TRADES_SAVED);
  fs.writeFile(TRADES_PATH, JSON.stringify(snapshot), "utf-8").catch(() => {});
}

function appendTrade(trade: Record<string, unknown>): void {
  tradesBuffer.push({ ...trade, timestamp: trade.exitTime, source: "server-bot", simulated: false });
  if (tradesBuffer.length > MAX_TRADES_SAVED + 100) {
    tradesBuffer = tradesBuffer.slice(-MAX_TRADES_SAVED);
  }
  tradesDirty = true;
  flushTrades();
}

function saveState(): void {
  fs.writeFile(STATE_PATH, JSON.stringify(botState), "utf-8").catch(() => {});
}

async function loadState(): Promise<void> {
  try {
    const raw   = await fs.readFile(STATE_PATH, "utf-8");
    const saved = JSON.parse(raw) as BotState;
    botState = {
      ...saved,
      status:     "stopped",
      lastError:  null,
      lastTickAt: null,
      nextTickAt: null,
    };
  } catch { /* no saved state — use defaults */ }
}

async function loadParams(): Promise<BotState["params"] | null> {
  try {
    const raw = await fs.readFile(PARAMS_PATH, "utf-8");
    return JSON.parse(raw) as BotState["params"];
  } catch {
    return null;
  }
}

function log(entry: Parameters<typeof writeToFileLog>[0]): void {
  writeToFileLog(entry).catch(() => {});
}

export function getBotState(): BotState {
  return botState;
}

export async function startBot(symbol?: string, timeframe?: string): Promise<void> {
  if (botState.status === "running") return;

  const params = await loadParams();
  if (!params) {
    botState.lastError = "No validated params — run the pipeline first";
    botState.status    = "error";
    saveState();
    return;
  }

  botState.status       = "running";
  botState.symbol       = symbol ?? DEFAULT_SYMBOL;
  botState.timeframe    = timeframe ?? DEFAULT_TF;
  botState.params       = params;
  botState.startedAt    = Date.now();
  botState.lastError    = null;
  botState.sessionStats = { trades: 0, wins: 0, losses: 0, pnlUSDT: 0 };
  invalidateBalanceCache();
  saveState();

  log({
    timestamp: Date.now(), type: "BOT_START", severity: "info",
    title: `Server bot started — ${botState.symbol} ${botState.timeframe}`,
    detail: `Score≥${params.minSignalScore} · SL×${params.stopLossAtrMultiplier} · TP×${params.takeProfitMultiplier} · WR${params.winRate?.toFixed(1)}% · PF${params.profitFactor?.toFixed(2)}`,
  });

  scheduleTick(0);
}

export async function stopBot(reason = "Manual stop"): Promise<void> {
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  botState.status     = "stopped";
  botState.nextTickAt = null;
  saveState();
  await writeToFileLog({
    timestamp: Date.now(), type: "BOT_STOP", severity: "info",
    title: `Server bot stopped — ${reason}`,
    detail: `Session: ${botState.sessionStats.trades} trades · PnL $${botState.sessionStats.pnlUSDT.toFixed(2)}`,
  });
}

export async function emergencyStop(): Promise<void> {
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }

  try {
    await cancelAllOrders(botState.symbol);
  } catch (e) {
    log({ timestamp: Date.now(), type: "ERROR", severity: "error",
      title: "Emergency stop — failed to cancel KuCoin orders", detail: String(e) });
  }

  botState.status       = "stopped";
  botState.openPosition = null;
  botState.nextTickAt   = null;
  invalidateBalanceCache();
  saveState();

  await writeToFileLog({
    timestamp: Date.now(), type: "EMERGENCY_STOP", severity: "error",
    title: `EMERGENCY STOP — ${botState.symbol}`,
    detail: `All orders cancelled. Session PnL: $${botState.sessionStats.pnlUSDT.toFixed(2)}`,
  });
}

export async function initBot(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await Promise.all([loadState(), loadTradesBuffer()]);
}

function nextTickDelay(): number {
  return botState.openPosition ? POSITION_TICK_MS : ENTRY_TICK_MS;
}

function scheduleTick(delayMs: number): void {
  if (tickTimer) clearTimeout(tickTimer);
  botState.nextTickAt = Date.now() + delayMs;
  tickTimer = setTimeout(async () => {
    if (botState.status !== "running") return;
    try {
      await tick();
    } catch (err) {
      botState.lastError = String(err);
      await writeToFileLog({
        timestamp: Date.now(), type: "ERROR", severity: "error",
        title: "Bot tick error", detail: String(err),
      });
    }
    if (botState.status === "running") scheduleTick(nextTickDelay());
  }, delayMs);
}

async function tick(): Promise<void> {
  botState.lastTickAt = Date.now();
  const { symbol, timeframe, params } = botState;
  if (!params) return;

  const candles = await getCandles(symbol, timeframe);
  if (!candles || candles.length < MIN_CANDLES) {
    log({ timestamp: Date.now(), type: "WARNING", severity: "warning",
      title: `Insufficient candle data (${candles?.length ?? 0})`, symbol });
    return;
  }

  const signal = generateSignal(candles, params.minSignalScore, {
    rsiOversoldThreshold:   params.rsiOversoldThreshold,
    rsiOverboughtThreshold: params.rsiOverboughtThreshold,
    volumeMultiplier:       params.volumeMultiplier,
  });

  botState.lastSignal = {
    direction: signal.direction,
    score:     signal.score,
    label:     signal.label,
    timestamp: Date.now(),
  };

  const price   = candles[candles.length - 1].close;
  const lastAtr = signal.indicators.atr[signal.indicators.atr.length - 1] ?? price * 0.005;

  if (botState.openPosition) {
    await managePosition(signal, price, lastAtr, params, symbol);
    saveState();
    return;
  }

  if (signal.direction !== "NEUTRAL" && signal.score >= params.minSignalScore) {
    await enterPosition(signal, price, lastAtr, params, symbol, timeframe);
  }

  saveState();
}

async function managePosition(
  signal:  ReturnType<typeof generateSignal>,
  price:   number,
  atr:     number,
  params:  NonNullable<BotState["params"]>,
  symbol:  string,
): Promise<void> {
  const pos   = botState.openPosition!;
  const isBuy = pos.direction === "BUY";

  pos.currentPrice      = price;
  const rawPnlPct       = isBuy
    ? (price - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - price) / pos.entryPrice * 100;
  pos.unrealizedPnlPct  = rawPnlPct;
  pos.unrealizedPnlUSDT = pos.sizeUSDT * (rawPnlPct / 100);

  if (pos.tp1Hit) {
    const trailDist = atr * params.stopLossAtrMultiplier;
    if (isBuy) {
      const candidate = price - trailDist;
      if (!pos.trailingStopPrice || candidate > pos.trailingStopPrice)
        pos.trailingStopPrice = candidate;
    } else {
      const candidate = price + trailDist;
      if (!pos.trailingStopPrice || candidate < pos.trailingStopPrice)
        pos.trailingStopPrice = candidate;
    }
  }

  let effectiveSL = pos.stopLossPrice;
  if (pos.slMovedToBreakeven) {
    if ( isBuy && pos.entryPrice > effectiveSL) effectiveSL = pos.entryPrice;
    if (!isBuy && pos.entryPrice < effectiveSL) effectiveSL = pos.entryPrice;
  }
  if (pos.trailingStopPrice) {
    if ( isBuy && pos.trailingStopPrice > effectiveSL) effectiveSL = pos.trailingStopPrice;
    if (!isBuy && pos.trailingStopPrice < effectiveSL) effectiveSL = pos.trailingStopPrice;
  }

  const tp2Triggered = isBuy ? price >= pos.tp2Price : price <= pos.tp2Price;
  if (tp2Triggered && pos.tp1Hit) {
    await closePosition("TP2", pos.tp2Price, symbol);
    return;
  }

  const tp1Triggered = !pos.tp1Hit && (isBuy ? price >= pos.tp1Price : price <= pos.tp1Price);
  if (tp1Triggered) {
    pos.tp1Hit             = true;
    pos.slMovedToBreakeven = true;
    pos.stopLossPrice      = pos.entryPrice;

    log({ timestamp: Date.now(), type: "TRADE_TP1", severity: "success",
      title: `TP1 hit — ${symbol} ${pos.direction} @ $${pos.tp1Price.toFixed(4)}`, symbol });

    try {
      await placeOrder({
        clientOid: `tp1-${Date.now()}`,
        side:      isBuy ? "sell" : "buy",
        symbol,
        type:      "market",
        size:      (pos.size / 2).toFixed(6),
      });
      invalidateBalanceCache();
    } catch (e) {
      log({ timestamp: Date.now(), type: "WARNING", severity: "warning",
        title: "TP1 partial exit failed", detail: String(e), symbol });
    }
    return;
  }

  const slTriggered = isBuy ? price <= effectiveSL : price >= effectiveSL;
  if (slTriggered) {
    await closePosition("SL", effectiveSL, symbol);
    return;
  }

  const isReversal =
    (pos.direction === "BUY"  && signal.direction === "SELL" && signal.score >= 5) ||
    (pos.direction === "SELL" && signal.direction === "BUY"  && signal.score >= 5);
  if (isReversal) {
    await closePosition("SIGNAL_REVERSAL", price, symbol);
  }
}

async function closePosition(
  reason:    string,
  exitPrice: number,
  symbol:    string,
): Promise<void> {
  const pos = botState.openPosition;
  if (!pos) return;

  const isBuy    = pos.direction === "BUY";
  const pnlPct   = isBuy
    ? (exitPrice - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - exitPrice) / pos.entryPrice * 100;
  const tradeCost = pos.sizeUSDT * KUCOIN_FEE * 2 + pos.sizeUSDT * SLIPPAGE * 2;
  const pnlUSDT   = pos.sizeUSDT * (pnlPct / 100) - tradeCost;

  if (pos.stopOrderId) {
    cancelStopOrder(pos.stopOrderId).catch(() => {});
  }

  try {
    const remainingSize = pos.tp1Hit
      ? (pos.size / 2).toFixed(6)
      : pos.size.toFixed(6);

    await placeOrder({
      clientOid: `close-${Date.now()}`,
      side:      isBuy ? "sell" : "buy",
      symbol,
      type:      "market",
      size:      remainingSize,
    });
    invalidateBalanceCache();
  } catch (e) {
    await writeToFileLog({
      timestamp: Date.now(), type: "ERROR", severity: "error",
      title: `Close order failed (${reason})`, detail: String(e), symbol,
    });
  }

  const durationMinutes = (Date.now() - pos.entryTime) / 60_000;
  appendTrade({
    id: pos.id, symbol, direction: pos.direction,
    entryPrice: pos.entryPrice, exitPrice,
    entryTime: pos.entryTime, exitTime: Date.now(),
    pnlUSDT, pnlPct, exitReason: reason,
    signalScore: pos.signalScore, durationMinutes,
  });

  botState.sessionStats.trades++;
  if (pnlUSDT > 0) botState.sessionStats.wins++;
  else              botState.sessionStats.losses++;
  botState.sessionStats.pnlUSDT += pnlUSDT;

  await writeToFileLog({
    timestamp: Date.now(), type: "TRADE_CLOSE", severity: pnlUSDT >= 0 ? "success" : "warning",
    title: `${symbol} ${pos.direction} ${reason} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
    detail: `Entry $${pos.entryPrice.toFixed(4)} → Exit $${exitPrice.toFixed(4)} · P&L $${pnlUSDT.toFixed(2)} · ${durationMinutes.toFixed(0)} min`,
    symbol, value: pnlUSDT,
  });

  botState.openPosition = null;
}

async function enterPosition(
  signal:    ReturnType<typeof generateSignal>,
  price:     number,
  atr:       number,
  params:    NonNullable<BotState["params"]>,
  symbol:    string,
  timeframe: string,
): Promise<void> {
  const isBuy     = signal.direction === "BUY";
  const rawTrade  = params.tradeAmountUSDT ?? 100;
  // Cap trade amount to the bot7 capital budget (BOT7_MAX_CAPITAL).
  const tradeUSDT = BOT7_MAX_CAPITAL > 0 ? Math.min(rawTrade, BOT7_MAX_CAPITAL) : rawTrade;

  const rr = calculateRiskReward(
    price, signal.direction as "BUY" | "SELL",
    atr, signal.indicators.fibonacci ?? null,
    tradeUSDT, 0.5,
    params.stopLossAtrMultiplier,
    params.takeProfitMultiplier,
  );

  const available = await getUsdtBalance();
  // When a capital cap is set, treat only that budget as available to bot7.
  const effectiveBalance = BOT7_MAX_CAPITAL > 0 ? Math.min(available, BOT7_MAX_CAPITAL) : available;
  if (effectiveBalance < tradeUSDT * 0.9) {
    log({ timestamp: Date.now(), type: "WARNING", severity: "warning",
      title: `Insufficient balance ($${effectiveBalance.toFixed(2)} < $${tradeUSDT}${BOT7_MAX_CAPITAL > 0 ? ` · cap $${BOT7_MAX_CAPITAL}` : ""})`, symbol });
    return;
  }

  let orderId = `sim-${Date.now()}`;
  try {
    const result = await placeOrder({
      clientOid: `entry-${Date.now()}`,
      side:      isBuy ? "buy" : "sell",
      symbol,
      type:      "market",
      funds:     (tradeUSDT * (1 + SLIPPAGE)).toFixed(2),
    });
    orderId = result.orderId;
    invalidateBalanceCache();
  } catch (e) {
    await writeToFileLog({
      timestamp: Date.now(), type: "ERROR", severity: "error",
      title: "Entry order failed — skipping trade", detail: String(e), symbol,
    });
    return;
  }

  let stopOrderId: string | undefined;
  try {
    const size = (tradeUSDT / price).toFixed(6);
    const stop = await placeStopOrder({
      clientOid:     `sl-${Date.now()}`,
      side:          isBuy ? "sell" : "buy",
      symbol,
      type:          "market",
      size,
      stopPrice:     rr.stopLossPrice.toFixed(4),
      stop:          "loss",
      stopPriceType: "TP",
    });
    stopOrderId = stop.orderId;
  } catch { /* SL order failure is non-fatal */ }

  const size          = tradeUSDT / price;
  const slippedEntry  = isBuy ? price * (1 + SLIPPAGE) : price * (1 - SLIPPAGE);

  botState.openPosition = {
    id:                 `trade-${Date.now()}`,
    direction:          signal.direction as "BUY" | "SELL",
    entryPrice:         slippedEntry,
    entryTime:          Date.now(),
    size,
    sizeUSDT:           tradeUSDT,
    stopLossPrice:      rr.stopLossPrice,
    tp1Price:           rr.takeProfitPrice1,
    tp2Price:           rr.takeProfitPrice2,
    tp1Hit:             false,
    slMovedToBreakeven: false,
    atrAtEntry:         atr,
    currentPrice:       price,
    unrealizedPnlPct:   0,
    unrealizedPnlUSDT:  0,
    orderId,
    stopOrderId,
    signalScore:        signal.score,
  };

  log({
    timestamp: Date.now(), type: "TRADE_OPEN", severity: "info",
    title: `${symbol} ${signal.direction} @ $${slippedEntry.toFixed(4)} · Score ${signal.score}/${signal.maxScore ?? 13}`,
    detail: `SL $${rr.stopLossPrice.toFixed(4)} · TP1 $${rr.takeProfitPrice1.toFixed(4)} · TP2 $${rr.takeProfitPrice2.toFixed(4)} · $${tradeUSDT} · ${timeframe}`,
    symbol, value: tradeUSDT,
  });
}
