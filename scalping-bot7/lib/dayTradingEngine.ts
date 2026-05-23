/**
 * dayTradingEngine.ts — Multi-pair automated day trading singleton
 *
 * Strategy: trend-following momentum scalping across TOP_20_PAIRS simultaneously.
 */

import { promises as fs }    from "fs";
import path                   from "path";
import { getCandles, getSymbols } from "./kucoinPublic";
import { generateSignal }         from "./signalEngine";
import { calculateRiskReward } from "./riskReward";
import {
  placeOrder, getTradeAccounts, cancelStopOrder,
} from "./kucoinPrivate";
import { writeToFileLog, FileLogEntry } from "./serverLogger";
import { TOP_20_PAIRS }       from "./autoOptimizer";

function logDT(title: string, detail?: string, symbol?: string): void {
  const entry: FileLogEntry = {
    timestamp: Date.now(),
    type:      "DayTrading",
    severity:  "info",
    title,
    detail,
    symbol,
  };
  writeToFileLog(entry).catch(() => {});
}

const DATA_DIR   = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "day-trading-state.json");
const LOG_PATH   = path.join(DATA_DIR, "day-trading-log.json");

const MAX_POSITIONS          = 3;
const MAX_SAME_DIRECTION     = 2;
const RISK_PCT_PER_TRADE     = 1.0;
const MAX_TRADE_USDT         = 150;
const MAX_TRADE_USDT_ASIA    = 75;
const MIN_TRADE_USDT         = 10;
const MAX_DAILY_LOSS_PCT     = 3.0;
const MAX_CONSECUTIVE_LOSSES = 3;
const COOLDOWN_MS            = 10 * 60_000;
const SCAN_INTERVAL_MS       = 30_000;
const MANAGE_INTERVAL_MS     = 15_000;
const KUCOIN_FEE             = 0.001;
const SLIPPAGE               = 0.0003;
const TIMEFRAME              = "5min";
const MIN_CANDLES            = 60;
const BALANCE_CACHE_MS       = 20_000;
const MAX_LOG_ENTRIES        = 500;
const SCORE_BOOST            = 1;
const MIN_SCORE_FLOOR        = 7;

const ASIA_HOUR_START = 23;
const ASIA_HOUR_END   = 8;
const ASIA_SCORE_BOOST = 1;

function getSessionInfo(): { isAsia: boolean; sessionLabel: string; maxTradeUSDT: number } {
  const hourUTC = new Date().getUTCHours();
  const isAsia  = hourUTC >= ASIA_HOUR_START || hourUTC < ASIA_HOUR_END;
  return {
    isAsia,
    sessionLabel: isAsia ? "Asia" : "EU/US",
    maxTradeUSDT: isAsia ? MAX_TRADE_USDT_ASIA : MAX_TRADE_USDT,
  };
}

interface SymbolMeta { baseIncrement: string; baseMinSize: string; }
const symbolMeta  = new Map<string, SymbolMeta>();
let   metaLoaded  = false;

async function ensureSymbolMeta(): Promise<void> {
  if (metaLoaded) return;
  try {
    const syms = await getSymbols();
    for (const s of syms) {
      symbolMeta.set(s.symbol, { baseIncrement: s.baseIncrement, baseMinSize: s.baseMinSize });
    }
    metaLoaded = true;
  } catch { /* use toFixed(4) fallback if unavailable */ }
}

function floorToIncrement(value: number, sym: string): string {
  const meta = symbolMeta.get(sym);
  const incStr = meta?.baseIncrement ?? "0.0001";
  const inc    = parseFloat(incStr);
  if (!inc || inc <= 0) return value.toFixed(4);
  const floored  = Math.floor(value / inc) * inc;
  const decimals = incStr.includes(".")
    ? incStr.split(".")[1].replace(/0+$/, "").length
    : 0;
  return floored.toFixed(Math.max(decimals, 0));
}

export interface DayTradePosition {
  id:                 string;
  symbol:             string;
  direction:          "BUY" | "SELL";
  entryPrice:         number;
  entryTime:          number;
  sizeUSDT:           number;
  size:               number;
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
  maxFavorable:       number;
  signalScore:        number;
  orderId:            string;
  stopOrderId?:       string;
  regime:             string;
  portfolioImport?:   boolean;
}

export interface ClosedDayTrade {
  id:            string;
  symbol:        string;
  direction:     "BUY" | "SELL";
  entryPrice:    number;
  exitPrice:     number;
  entryTime:     number;
  exitTime:      number;
  durationMin:   number;
  sizeUSDT:      number;
  pnlUSDT:       number;
  pnlPct:        number;
  exitReason:    "TP1" | "TP2" | "SL" | "TRAIL" | "MANUAL";
  signalScore:   number;
  regime:        string;
  tp1Hit:        boolean;
}

export interface DayTradingState {
  status:      "stopped" | "running" | "paused" | "halted";
  startedAt:   number | null;
  haltReason:  string | null;
  lastScanAt:  number | null;
  cooldownUntil:  number | null;
  cooldownRegime?: string | null;

  openPositions: DayTradePosition[];

  dailyStats: {
    trades:           number;
    wins:             number;
    losses:           number;
    pnlUSDT:          number;
    pnlPct:           number;
    dayStartBalance:  number;
    grossWins:        number;
    grossLosses:      number;
    consecutiveLosses: number;
    bestTrade:        number;
    worstTrade:       number;
  };

  params: {
    minSignalScore:         number;
    stopLossAtrMultiplier:  number;
    takeProfitMultiplier:   number;
    rsiOversoldThreshold:   number;
    rsiOverboughtThreshold: number;
    volumeMultiplier:       number;
    tp1Ratio:               number;
    winRate:                number;
    profitFactor:           number;
  } | null;

  lastError: string | null;
}

let state: DayTradingState = {
  status:        "stopped",
  startedAt:     null,
  haltReason:    null,
  lastScanAt:    null,
  cooldownUntil: null,
  openPositions: [],
  dailyStats: {
    trades: 0, wins: 0, losses: 0, pnlUSDT: 0, pnlPct: 0,
    dayStartBalance: 0, grossWins: 0, grossLosses: 0,
    consecutiveLosses: 0, bestTrade: 0, worstTrade: 0,
  },
  params:    null,
  lastError: null,
};

let scanTimer:   ReturnType<typeof setTimeout> | null = null;
let manageTimer: ReturnType<typeof setTimeout> | null = null;
let closedToday: ClosedDayTrade[] = [];

let cachedBalance:   number = 0;
let balanceCachedAt: number = 0;

async function getAvailableUSDT(): Promise<number> {
  if (Date.now() - balanceCachedAt < BALANCE_CACHE_MS && cachedBalance > 0) {
    return cachedBalance;
  }
  try {
    const accounts = await getTradeAccounts();
    const usdt     = accounts.find(a => a.currency === "USDT");
    cachedBalance   = usdt ? parseFloat(usdt.available) : 0;
    balanceCachedAt = Date.now();
    return cachedBalance;
  } catch {
    return cachedBalance;
  }
}

function invalidateBalance() { cachedBalance = 0; }

async function getPortfolioValueUSDT(): Promise<number> {
  try {
    const accounts = await getTradeAccounts();
    let total = 0;
    const pricePromises: Promise<void>[] = [];

    for (const a of accounts) {
      const qty = parseFloat(a.available) + parseFloat(a.holds);
      if (qty <= 0) continue;
      if (a.currency === "USDT") {
        total += qty;
      } else {
        const sym = `${a.currency}-USDT`;
        if (!TOP_20_PAIRS.includes(sym)) continue;
        pricePromises.push(
          getLivePrice(sym).then(p => { if (p > 0) total += qty * p; })
        );
      }
    }
    await Promise.all(pricePromises);
    return total > 0 ? total : cachedBalance;
  } catch {
    return cachedBalance;
  }
}

async function importPortfolioHoldings(): Promise<void> {
  if (!state.params) return;
  try {
    await ensureSymbolMeta();
    const accounts       = await getTradeAccounts();
    const alreadyTracked = new Set(state.openPositions.map(p => p.symbol));
    let   imported       = 0;

    for (const account of accounts) {
      if (account.currency === "USDT") continue;

      const symbol = `${account.currency}-USDT`;
      if (!TOP_20_PAIRS.includes(symbol)) continue;
      if (alreadyTracked.has(symbol))     continue;

      const qty = parseFloat(account.available);
      if (qty <= 0) continue;

      const price = await getLivePrice(symbol);
      if (price <= 0) continue;

      const valueUSDT = qty * price;
      if (valueUSDT < MIN_TRADE_USDT) continue;

      let atr    = price * 0.005;
      let regime = "RANGING";
      try {
        const candles = await getCandles(symbol, TIMEFRAME);
        if (candles && candles.length >= MIN_CANDLES) {
          const sig    = generateSignal(candles, 1);
          const sigAtr = sig.indicators.atr[sig.indicators.atr.length - 1];
          if (sigAtr && !isNaN(sigAtr) && sigAtr > 0) atr = sigAtr;
          regime = sig.regime;
        }
      } catch { /* use fallback */ }

      const rr = calculateRiskReward(
        price, "BUY", atr, null,
        valueUSDT,
        0.5,
        state.params.stopLossAtrMultiplier,
        state.params.takeProfitMultiplier,
        state.params.tp1Ratio,
      );

      if (rr.stopLossPrice <= 0 || rr.stopLossPrice >= price) continue;

      const pos: DayTradePosition = {
        id:                 `portfolio_${symbol}`,
        symbol,
        direction:          "BUY",
        entryPrice:         price,
        entryTime:          Date.now(),
        sizeUSDT:           valueUSDT,
        size:               qty,
        stopLossPrice:      rr.stopLossPrice,
        tp1Price:           rr.takeProfitPrice1,
        tp2Price:           rr.takeProfitPrice2,
        tp1Hit:             false,
        slMovedToBreakeven: false,
        atrAtEntry:         atr,
        currentPrice:       price,
        unrealizedPnlPct:   0,
        unrealizedPnlUSDT:  0,
        maxFavorable:       0,
        signalScore:        0,
        orderId:            "portfolio",
        regime,
        portfolioImport:    true,
      };

      state.openPositions.push(pos);
      alreadyTracked.add(symbol);
      imported++;

      const slPct = ((price - rr.stopLossPrice) / price * 100).toFixed(2);
      logDT(
        `📦 IMPORT ${symbol} — $${valueUSDT.toFixed(0)} @ $${price.toFixed(4)}`,
        `SL=$${rr.stopLossPrice.toFixed(4)} (−${slPct}%) TP1=$${rr.takeProfitPrice1.toFixed(4)}`,
        symbol,
      );
    }

    if (imported > 0) {
      saveState();
      logDT(`Portfolio: ${imported} holding(s) imported for stop-loss management`);
    } else {
      logDT(`Portfolio: no new holdings to import`);
    }
  } catch (err) {
    logDT(`importPortfolioHoldings error`, String(err));
  }
}

function saveState(): void {
  fs.writeFile(STATE_PATH, JSON.stringify(state), "utf-8").catch(() => {});
}

async function loadState(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw   = await fs.readFile(STATE_PATH, "utf-8");
    const saved = JSON.parse(raw) as DayTradingState;
    state = {
      ...saved,
      status:        "stopped",
      haltReason:    null,
      lastError:     null,
    };
  } catch { /* fresh start */ }
}

function appendLog(entry: ClosedDayTrade): void {
  closedToday.push(entry);
  if (closedToday.length > MAX_LOG_ENTRIES) closedToday.shift();
  fs.writeFile(LOG_PATH, JSON.stringify(closedToday.slice(-MAX_LOG_ENTRIES)), "utf-8").catch(() => {});
}

async function loadLog(): Promise<void> {
  try {
    const raw  = await fs.readFile(LOG_PATH, "utf-8");
    const all  = JSON.parse(raw) as ClosedDayTrade[];
    const day  = new Date().toDateString();
    closedToday = all.filter(t => new Date(t.exitTime).toDateString() === day);
  } catch { closedToday = []; }
}

async function loadPipelineParams(): Promise<DayTradingState["params"] | null> {
  try {
    const pipeState = JSON.parse(
      await fs.readFile(path.join(DATA_DIR, "pipeline-state.json"), "utf-8")
    );
    if (pipeState.phase === "ready" && pipeState.bestParams) {
      return {
        minSignalScore:         pipeState.bestParams.minSignalScore ?? 7,
        stopLossAtrMultiplier:  pipeState.bestParams.stopLossAtrMultiplier ?? 2.0,
        takeProfitMultiplier:   pipeState.bestParams.takeProfitMultiplier ?? 2.5,
        rsiOversoldThreshold:   pipeState.bestParams.rsiOversoldThreshold ?? 45,
        rsiOverboughtThreshold: pipeState.bestParams.rsiOverboughtThreshold ?? 55,
        volumeMultiplier:       pipeState.bestParams.volumeMultiplier ?? 1.2,
        tp1Ratio:               pipeState.bestParams.tp1Ratio ?? 0.33,
        winRate:                pipeState.bestParams.winRate ?? 0,
        profitFactor:           pipeState.bestParams.profitFactor ?? 0,
      };
    }
  } catch { /* no pipeline yet */ }
  return null;
}

function isDailyLimitHit(): boolean {
  const { dayStartBalance, pnlUSDT } = state.dailyStats;
  if (dayStartBalance <= 0) return false;
  const lossPct = (-pnlUSDT / dayStartBalance) * 100;
  return lossPct >= MAX_DAILY_LOSS_PCT;
}

function isInCooldown(): boolean {
  if (state.cooldownUntil === null) return false;
  if (Date.now() >= state.cooldownUntil) return false;
  return true;
}

function maybeEndCooldownOnRegimeChange(observedRegime: string): void {
  if (state.cooldownUntil === null || Date.now() >= state.cooldownUntil) return;
  if (state.cooldownRegime && state.cooldownRegime !== observedRegime) {
    logDT(
      `Cooldown ended early — regime changed: ${state.cooldownRegime} → ${observedRegime}`,
      `Was waiting until ${new Date(state.cooldownUntil).toLocaleTimeString()}`,
    );
    state.cooldownUntil  = null;
    state.cooldownRegime = null;
    saveState();
  }
}

function isNewDay(): boolean {
  if (!state.startedAt) return false;
  const startDay = new Date(state.startedAt).toDateString();
  const today    = new Date().toDateString();
  return startDay !== today;
}

function calcTradeSize(
  availableUSDT:  number,
  entryPrice:     number,
  stopLossPrice:  number,
  maxTradeOverride?: number,
): number {
  const cap        = maxTradeOverride ?? MAX_TRADE_USDT;
  const stopPct    = Math.abs(entryPrice - stopLossPrice) / entryPrice;
  if (stopPct <= 0) return MIN_TRADE_USDT;
  const riskUSDT   = availableUSDT * (RISK_PCT_PER_TRADE / 100);
  const sizeUSDT   = riskUSDT / stopPct;
  return Math.min(Math.max(sizeUSDT, MIN_TRADE_USDT), cap);
}

function newId(): string {
  return `dt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function openPosition(
  symbol:   string,
  signal:   ReturnType<typeof generateSignal>,
  params:   NonNullable<DayTradingState["params"]>,
  availableUSDT: number,
  maxTradeUSDT?: number,
): Promise<void> {
  const dir      = signal.direction as "BUY" | "SELL";
  const price    = signal.entryPrice;
  const atr      = signal.indicators.atr[signal.indicators.atr.length - 1] ?? price * 0.005;

  const rr = calculateRiskReward(
    price, dir, atr, signal.indicators.fibonacci,
    100,
    0.5,
    params.stopLossAtrMultiplier,
    params.takeProfitMultiplier,
    params.tp1Ratio,
  );

  const sizeUSDT = calcTradeSize(availableUSDT, price, rr.stopLossPrice, maxTradeUSDT);
  const baseSize = sizeUSDT / price;
  const sizeStr  = floorToIncrement(baseSize, symbol);

  if (dir === "SELL") {
    try {
      const accounts = await getTradeAccounts();
      const baseCurrency = symbol.replace("-USDT", "");
      const holding      = accounts.find(a => a.currency === baseCurrency);
      const heldQty      = holding ? parseFloat(holding.available) : 0;
      if (heldQty < parseFloat(sizeStr)) {
        logDT(
          `SKIP SELL ${symbol} — no ${baseCurrency} to sell`,
          `need=${sizeStr} have=${heldQty.toFixed(6)} — short selling not supported`,
          symbol,
        );
        return;
      }
    } catch {
      logDT(`SKIP SELL ${symbol} — could not verify ${symbol.replace("-USDT", "")} balance`, undefined, symbol);
      return;
    }
  }

  const clientOid = newId();
  let orderId = "";

  try {
    const orderSide = dir === "BUY" ? "buy" : "sell";
    const result    = await placeOrder({
      clientOid,
      side:   orderSide,
      symbol,
      type:   "market",
      funds:  dir === "BUY" ? sizeUSDT.toFixed(2) : undefined,
      size:   dir === "SELL" ? sizeStr : undefined,
    });
    orderId = result.orderId;
    invalidateBalance();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logDT(`ORDER FAILED ${symbol} ${dir}`, msg, symbol);
    state.lastError = `${symbol} order failed: ${msg}`;
    saveState();
    return;
  }

  const feeSlip   = KUCOIN_FEE + SLIPPAGE;
  const adjEntry  = dir === "BUY" ? price * (1 + feeSlip) : price * (1 - feeSlip);

  const pos: DayTradePosition = {
    id:                 clientOid,
    symbol,
    direction:          dir,
    entryPrice:         adjEntry,
    entryTime:          Date.now(),
    sizeUSDT,
    size:               parseFloat(sizeStr),
    stopLossPrice:      rr.stopLossPrice,
    tp1Price:           rr.takeProfitPrice1,
    tp2Price:           rr.takeProfitPrice2,
    tp1Hit:             false,
    slMovedToBreakeven: false,
    atrAtEntry:         atr,
    currentPrice:       price,
    unrealizedPnlPct:   0,
    unrealizedPnlUSDT:  0,
    maxFavorable:       0,
    signalScore:        signal.score,
    orderId,
    regime:             signal.regime,
  };

  state.openPositions.push(pos);
  saveState();

  const sess = getSessionInfo();
  logDT(
    `OPENED ${dir} ${symbol} @${adjEntry.toFixed(4)} [${sess.sessionLabel}]`,
    `SL=${rr.stopLossPrice.toFixed(4)} TP1=${rr.takeProfitPrice1.toFixed(4)} TP2=${rr.takeProfitPrice2.toFixed(4)} size=$${sizeUSDT.toFixed(2)} score=${signal.score}`,
    symbol
  );
}

async function closePosition(
  pos:    DayTradePosition,
  reason: ClosedDayTrade["exitReason"],
  exitPrice?: number,
): Promise<void> {
  const price = exitPrice ?? pos.currentPrice;
  const side  = pos.direction === "BUY" ? "sell" : "buy";

  if (pos.stopOrderId) {
    cancelStopOrder(pos.stopOrderId).catch(() => {});
  }

  try {
    await placeOrder({
      clientOid: newId(),
      side,
      symbol:    pos.symbol,
      type:      "market",
      size:      floorToIncrement(pos.size, pos.symbol),
    });
    invalidateBalance();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logDT(`CLOSE FAILED ${pos.symbol}`, msg, pos.symbol);
    state.lastError = `Close failed ${pos.symbol}: ${msg}`;
  }

  const feeSlip  = KUCOIN_FEE + SLIPPAGE;
  const adjExit  = pos.direction === "BUY" ? price * (1 - feeSlip) : price * (1 + feeSlip);

  const pnlPct  = pos.direction === "BUY"
    ? ((adjExit - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - adjExit) / pos.entryPrice) * 100;
  const pnlUSDT = (pnlPct / 100) * pos.sizeUSDT;

  const durationMin = Math.round((Date.now() - pos.entryTime) / 60_000);

  const closed: ClosedDayTrade = {
    id:          pos.id,
    symbol:      pos.symbol,
    direction:   pos.direction,
    entryPrice:  pos.entryPrice,
    exitPrice:   adjExit,
    entryTime:   pos.entryTime,
    exitTime:    Date.now(),
    durationMin,
    sizeUSDT:    pos.sizeUSDT,
    pnlUSDT,
    pnlPct,
    exitReason:  reason,
    signalScore: pos.signalScore,
    regime:      pos.regime,
    tp1Hit:      pos.tp1Hit,
  };

  appendLog(closed);

  const ds = state.dailyStats;
  ds.trades++;
  ds.pnlUSDT += pnlUSDT;
  if (ds.dayStartBalance > 0) ds.pnlPct = (ds.pnlUSDT / ds.dayStartBalance) * 100;

  if (pnlUSDT >= 0) {
    ds.wins++;
    ds.grossWins        += pnlUSDT;
    ds.consecutiveLosses = 0;
    ds.bestTrade         = Math.max(ds.bestTrade, pnlPct);
  } else {
    ds.losses++;
    ds.grossLosses      += Math.abs(pnlUSDT);
    ds.consecutiveLosses++;
    ds.worstTrade        = Math.min(ds.worstTrade, pnlPct);

    if (ds.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      state.cooldownUntil  = Date.now() + COOLDOWN_MS;
      state.cooldownRegime = state.openPositions.length > 0
        ? state.openPositions[state.openPositions.length - 1].regime
        : null;
      const cooldownMins = Math.round(COOLDOWN_MS / 60_000);
      logDT(
        `${MAX_CONSECUTIVE_LOSSES} consecutive losses — ${cooldownMins}min cooldown`,
        `regime=${state.cooldownRegime ?? "unknown"} — will end early if regime shifts`,
      );
    }
  }

  state.openPositions = state.openPositions.filter(p => p.id !== pos.id);
  saveState();

  logDT(
    `CLOSED ${reason} ${pos.direction} ${pos.symbol} @${adjExit.toFixed(4)}`,
    `P&L=${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUSDT >= 0 ? "+" : ""}${pnlUSDT.toFixed(2)}) dur=${durationMin}min | day: ${ds.trades}T ${ds.wins}W ${ds.losses}L $${ds.pnlUSDT.toFixed(2)}`,
    pos.symbol
  );

  if (isDailyLimitHit()) {
    state.status     = "halted";
    state.haltReason = `Daily loss limit reached: ${ds.pnlPct.toFixed(2)}% / ${MAX_DAILY_LOSS_PCT}%`;
    logDT(
      `HALTED — ${state.haltReason}`,
      `Scanning stopped. ${state.openPositions.length} remaining position(s) still managed to SL/TP.`,
    );
    stopScanning();
  }
}

async function getLivePrice(symbol: string): Promise<number> {
  try {
    const res  = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3001"}/api/trading/price?symbol=${symbol}`,
      { next: { revalidate: 0 } }
    );
    const data = await res.json() as { orderBook?: { price?: string } };
    return parseFloat(data.orderBook?.price ?? "0");
  } catch {
    return 0;
  }
}

async function manageTick(): Promise<void> {
  if (state.openPositions.length === 0) return;

  const snapshot = [...state.openPositions];
  const prices   = await Promise.all(snapshot.map(p => getLivePrice(p.symbol)));

  for (let idx = 0; idx < snapshot.length; idx++) {
    const originalPos = snapshot[idx];
    const price       = prices[idx];
    if (price <= 0) continue;

    const pos = state.openPositions.find(p => p.id === originalPos.id);
    if (!pos) continue;

    pos.currentPrice = price;

    const pnlPct  = pos.direction === "BUY"
      ? ((price - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - price) / pos.entryPrice) * 100;

    pos.unrealizedPnlPct  = pnlPct;
    pos.unrealizedPnlUSDT = (pnlPct / 100) * pos.sizeUSDT;
    pos.maxFavorable       = Math.max(pos.maxFavorable, pnlPct);

    const isBuy = pos.direction === "BUY";

    if ((isBuy && price <= pos.stopLossPrice) || (!isBuy && price >= pos.stopLossPrice)) {
      await closePosition(pos, pos.slMovedToBreakeven ? "TRAIL" : "SL", price);
      continue;
    }

    if (!pos.tp1Hit) {
      if ((isBuy && price >= pos.tp1Price) || (!isBuy && price <= pos.tp1Price)) {
        try {
          await placeOrder({
            clientOid: newId(),
            side:      isBuy ? "sell" : "buy",
            symbol:    pos.symbol,
            type:      "market",
            size:      floorToIncrement(pos.size * 0.5, pos.symbol),
          });
          invalidateBalance();

          pos.tp1Hit             = true;
          pos.slMovedToBreakeven = true;
          pos.size              *= 0.5;
          pos.sizeUSDT          *= 0.5;
          pos.stopLossPrice      = pos.entryPrice;

          logDT(`TP1 HIT ${pos.symbol} @${price.toFixed(4)} — SL→breakeven`, undefined, pos.symbol);
          saveState();
        } catch (err) {
          logDT(`TP1 partial close failed ${pos.symbol}`, String(err), pos.symbol);
        }
      }
    }

    if (pos.tp1Hit && ((isBuy && price >= pos.tp2Price) || (!isBuy && price <= pos.tp2Price))) {
      await closePosition(pos, "TP2", price);
      continue;
    }

    if (pos.tp1Hit && pos.atrAtEntry > 0) {
      const trailDist = pos.atrAtEntry * 1.0;
      if (isBuy) {
        const newTrail = price - trailDist;
        if (newTrail > pos.stopLossPrice) {
          pos.stopLossPrice    = newTrail;
          pos.trailingStopPrice = newTrail;
        }
      } else {
        const newTrail = price + trailDist;
        if (newTrail < pos.stopLossPrice) {
          pos.stopLossPrice    = newTrail;
          pos.trailingStopPrice = newTrail;
        }
      }
    }
  }

  saveState();
}

async function scanTick(): Promise<void> {
  state.lastScanAt = Date.now();

  if (state.status !== "running") return;
  if (isDailyLimitHit()) { await haltDaily(); return; }
  if (isInCooldown()) {
    if (state.cooldownRegime) {
      try {
        const btcCandles = await getCandles("BTC-USDT", TIMEFRAME);
        if (btcCandles && btcCandles.length >= MIN_CANDLES) {
          const btcSig = generateSignal(btcCandles, 1);
          maybeEndCooldownOnRegimeChange(btcSig.regime);
        }
      } catch { /* ignore */ }
    }
    if (isInCooldown()) return;
  }

  const botPositions = state.openPositions.filter(p => !p.portfolioImport);
  if (botPositions.length >= MAX_POSITIONS) return;
  if (isNewDay()) { await resetDailyStats(); }

  if (!state.params) {
    const loaded = await loadPipelineParams();
    if (!loaded) { state.lastError = "No pipeline params — run optimizer first"; saveState(); return; }
    state.params = loaded;
  }
  const activeParams = state.params;

  const minScore = Math.max(activeParams.minSignalScore + SCORE_BOOST, MIN_SCORE_FLOOR);

  const session           = getSessionInfo();
  const effectiveScore    = session.isAsia ? minScore + ASIA_SCORE_BOOST : minScore;
  const effectiveMaxTrade = session.maxTradeUSDT;

  const available = await getAvailableUSDT();
  if (available < MIN_TRADE_USDT * 2) {
    logDT(`Insufficient balance: $${available.toFixed(2)}`);
    return;
  }

  const openSymbols = new Set(state.openPositions.map(p => p.symbol));
  const slots       = MAX_POSITIONS - botPositions.length;

  type ScanResult = { symbol: string; signal: ReturnType<typeof generateSignal> } | null;
  const results: ScanResult[] = [];

  for (let i = 0; i < TOP_20_PAIRS.length; i += 5) {
    const batch = TOP_20_PAIRS.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(async (symbol): Promise<ScanResult> => {
      if (openSymbols.has(symbol)) return null;
      try {
        const candles = await getCandles(symbol, TIMEFRAME);
        if (!candles || candles.length < MIN_CANDLES) return null;
        const signal = generateSignal(candles, effectiveScore, {
          rsiOversoldThreshold:   activeParams.rsiOversoldThreshold,
          rsiOverboughtThreshold: activeParams.rsiOverboughtThreshold,
          volumeMultiplier:       activeParams.volumeMultiplier,
        });
        if (signal.direction === "NEUTRAL" || signal.score < effectiveScore) return null;
        const { regime } = signal;
        if (regime === "VOLATILE")                                          return null;
        if (signal.direction === "BUY"  && regime === "TRENDING_DOWN")     return null;
        if (signal.direction === "SELL" && regime === "TRENDING_UP")       return null;
        return { symbol, signal };
      } catch { return null; }
    }));
    results.push(...batchResults);
    if (i + 5 < TOP_20_PAIRS.length) await new Promise(r => setTimeout(r, 300));
  }

  const candidates = results
    .filter((r): r is { symbol: string; signal: ReturnType<typeof generateSignal> } => r !== null)
    .sort((a, b) => b.signal.score - a.signal.score)
    .slice(0, slots);

  for (const { symbol, signal } of candidates) {
    const bots = state.openPositions.filter(p => !p.portfolioImport);
    if (bots.length >= MAX_POSITIONS) break;

    const dir       = signal.direction as "BUY" | "SELL";
    const sameDir   = bots.filter(p => p.direction === dir).length;
    if (sameDir >= MAX_SAME_DIRECTION) {
      logDT(`SKIP ${symbol} ${dir} — direction cap (${sameDir}/${MAX_SAME_DIRECTION} same direction)`, undefined, symbol);
      continue;
    }

    await openPosition(symbol, signal, activeParams, available, effectiveMaxTrade);
  }
}

async function resetDailyStats(): Promise<void> {
  const balance = await getPortfolioValueUSDT();
  state.dailyStats = {
    trades: 0, wins: 0, losses: 0, pnlUSDT: 0, pnlPct: 0,
    dayStartBalance: balance, grossWins: 0, grossLosses: 0,
    consecutiveLosses: 0, bestTrade: 0, worstTrade: 0,
  };
  state.startedAt    = Date.now();
  state.cooldownUntil = null;
  closedToday = [];
  saveState();
  logDT(`New day started — portfolio $${balance.toFixed(2)}`);
}

async function haltDaily(): Promise<void> {
  state.status     = "halted";
  state.haltReason = `Daily loss limit ${MAX_DAILY_LOSS_PCT}% reached`;
  stopScanning();
  if (state.openPositions.length > 0 && !manageTimer) {
    scheduleManage();
  }
  saveState();
  logDT(
    `HALTED — daily limit hit`,
    `No new trades. ${state.openPositions.length} open position(s) still managed until SL/TP hit.`,
  );
}

function stopTimers(): void {
  if (scanTimer)   { clearTimeout(scanTimer);   scanTimer   = null; }
  if (manageTimer) { clearTimeout(manageTimer); manageTimer = null; }
}

function stopScanning(): void {
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
}

function scheduleScan(): void {
  scanTimer = setTimeout(async () => {
    try { await scanTick(); } catch (e) {
      logDT(`scanTick error`, String(e));
    }
    if (state.status === "running") scheduleScan();
  }, SCAN_INTERVAL_MS);
}

function scheduleManage(): void {
  manageTimer = setTimeout(async () => {
    try { await manageTick(); } catch (e) {
      logDT(`manageTick error`, String(e));
    }
    if (state.status === "running" || state.openPositions.length > 0) scheduleManage();
    else manageTimer = null;
  }, MANAGE_INTERVAL_MS);
}

let initialized = false;

export async function initDayTrading(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await loadState();
  await loadLog();
  ensureSymbolMeta().catch(() => {});
}

export async function startDayTrading(): Promise<{ ok: boolean; error?: string }> {
  await initDayTrading();

  if (state.status === "running") return { ok: true };

  const params = await loadPipelineParams();
  if (!params) {
    return { ok: false, error: "Pipeline-parametreja ei löydy. Aja optimizer ensin." };
  }

  const balance = await getAvailableUSDT();
  if (balance < MIN_TRADE_USDT * MAX_POSITIONS) {
    return { ok: false, error: `Liian pieni saldo: $${balance.toFixed(2)} (min $${MIN_TRADE_USDT * MAX_POSITIONS})` };
  }

  state.params  = params;
  state.status  = "running";
  state.haltReason = null;
  state.lastError  = null;

  if (!state.startedAt || isNewDay()) {
    await resetDailyStats();
  }

  importPortfolioHoldings().catch(e => logDT("importPortfolioHoldings error", String(e)));

  saveState();
  logDT(`STARTED — balance $${balance.toFixed(2)}`, `params: minScore=${params.minSignalScore}+${SCORE_BOOST} SL=${params.stopLossAtrMultiplier}× TP=${params.takeProfitMultiplier}×`);

  scheduleScan();
  scheduleManage();
  scanTick().catch(() => {});

  return { ok: true };
}

export async function stopDayTrading(closeAll = false): Promise<void> {
  state.status = "stopped";
  stopTimers();
  saveState();

  if (closeAll && state.openPositions.length > 0) {
    logDT(`Closing ${state.openPositions.length} open positions on stop`);
    for (const pos of [...state.openPositions]) {
      await closePosition(pos, "MANUAL");
    }
  }

  logDT(`STOPPED`, `day stats: ${state.dailyStats.trades}T ${state.dailyStats.wins}W ${state.dailyStats.losses}L $${state.dailyStats.pnlUSDT.toFixed(2)}`);
}

export function getDayTradingState(): DayTradingState {
  return state;
}

export function getDayTradingLog(): ClosedDayTrade[] {
  return closedToday.slice();
}

export function getDayTradingConfig() {
  const sess = getSessionInfo();
  return {
    MAX_POSITIONS,
    RISK_PCT_PER_TRADE,
    MAX_TRADE_USDT,
    MAX_DAILY_LOSS_PCT,
    MAX_CONSECUTIVE_LOSSES,
    SCAN_INTERVAL_MS,
    MANAGE_INTERVAL_MS,
    SCORE_BOOST,
    ASIA_SCORE_BOOST,
    session:       sess.sessionLabel,
    isAsiaSession: sess.isAsia,
    maxTradeUSDT:  sess.maxTradeUSDT,
  };
}

export function stopEngine(): void {
  stopTimers();
}
