import type { KuCoinCandle } from "./kucoinPublic";
import { generateSignal, generateSignalFast } from "./signalEngine";
import { calculateRiskReward, HARD_CAP_USDT, DAILY_DRAWDOWN_LIMIT } from "./riskReward";
import { precomputeIndicators, type AlignedIndicators } from "./indicators";

// ── Multi-timeframe confirmation ──────────────────────────────────────────────
export interface MTFData {
  indicators: AlignedIndicators;
  timeLookup: Map<number, number>;
  periodSec: number;
}

export interface BacktestConfig {
  symbol: string;
  timeframe: string;
  tradeAmountUSDT: number;
  minSignalScore: number;
  takeProfitMultiplier: number;
  stopLossAtrMultiplier: number;
  partialExitEnabled: boolean;
  enforceHardCap?: boolean;
  enforceDailyDrawdown?: boolean;
  rsiOversoldThreshold?:   number;
  rsiOverboughtThreshold?: number;
  volumeMultiplier?:       number;
  tp1Ratio?:               number;
}

export interface TradeResult {
  id: string;
  symbol: string;
  direction: "BUY" | "SELL";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopLossPrice: number;
  takeProfitPrice1: number;
  takeProfitPrice2: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  slHit: boolean;
  pnlUSDT: number;
  pnlPct: number;
  durationMinutes: number;
  signalScore: number;
  riskRewardRatio: number;
  exitReason: "TP1" | "TP2" | "SL" | "SIGNAL_REVERSAL" | "END_OF_DATA";
  conditionsMet: string[];
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
}

export interface BacktestResults {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancy: number;
  profitFactor: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  maxConsecutiveLosses: number;
  sharpeRatio: number;
  bestTrade: TradeResult | null;
  worstTrade: TradeResult | null;
  allTrades: TradeResult[];
  equityCurve: { time: number; balance: number }[];
  avgTradeDurationMinutes: number;
  warnings: string[];
}

const KUCOIN_FEE     = 0.001;
const SLIPPAGE       = 0.0003;
const SLIPPAGE_TP    = 0.0005;
const WARMUP_CANDLES = 50;

function timeframeToMinutes(tf: string): number {
  const map: Record<string, number> = {
    "1min": 1, "3min": 3, "5min": 5, "15min": 15,
    "30min": 30, "1hour": 60, "4hour": 240, "1day": 1440,
  };
  return map[tf] ?? 1;
}

export function runBacktest(
  candles: KuCoinCandle[],
  config: BacktestConfig,
  precomputed?: AlignedIndicators,
  mtf1h?: MTFData,
): BacktestResults {
  const enforceHardCap      = config.enforceHardCap      ?? true;
  const enforceDailyDrawdown = config.enforceDailyDrawdown ?? true;
  const precomp = precomputed ?? precomputeIndicators(candles);

  const warnings:    string[] = [];
  const allTrades:   TradeResult[] = [];
  const equityCurve: { time: number; balance: number }[] = [];

  let balance             = config.tradeAmountUSDT * 10;
  const startBalance      = balance;
  let peakBalance         = balance;
  let maxDrawdown         = 0;
  let consecutiveLosses   = 0;
  let maxConsecutiveLosses = 0;

  let dailyStartBalance = balance;
  let currentDay        = -1;
  let dailyHaltActive   = false;

  interface OpenPosition {
    direction: "BUY" | "SELL";
    entryPrice: number;
    entryTime: number;
    entryIndex: number;
    stopLossPrice: number;
    tp1Price: number;
    tp2Price: number;
    rr: number;
    signalScore: number;
    conditionsMet: string[];
    tp1Hit: boolean;
    slMovedToBreakeven: boolean;
    trailingStopPrice?: number;
    atrAtEntry: number;
    size: number;
    maxFav: number;
    maxAdv: number;
  }

  let openPosition: OpenPosition | null = null;
  const tfMinutes = timeframeToMinutes(config.timeframe);

  for (let i = WARMUP_CANDLES; i < candles.length; i++) {
    const candle = candles[i];

    if (enforceDailyDrawdown) {
      const day = Math.floor(candle.time / 86_400);
      if (day !== currentDay) {
        currentDay        = day;
        dailyStartBalance = balance;
        dailyHaltActive   = false;
      }
    }

    if (openPosition) {
      const { direction, entryPrice, tp1Price, tp2Price, tp1Hit } = openPosition;
      const high  = candle.high;
      const low   = candle.low;
      const isBuy = direction === "BUY";

      const curFav = isBuy ? (high - entryPrice) / entryPrice * 100 : (entryPrice - low)  / entryPrice * 100;
      const curAdv = isBuy ? (entryPrice - low)  / entryPrice * 100 : (high - entryPrice) / entryPrice * 100;
      if (curFav > openPosition.maxFav) openPosition.maxFav = curFav;
      if (curAdv > openPosition.maxAdv) openPosition.maxAdv = curAdv;

      let sl = openPosition.stopLossPrice;
      if (openPosition.slMovedToBreakeven) {
        if ( isBuy && openPosition.entryPrice > sl) sl = openPosition.entryPrice;
        if (!isBuy && openPosition.entryPrice < sl) sl = openPosition.entryPrice;
      }

      let closedReason: TradeResult["exitReason"] | null = null;
      let exitPrice = candle.close;

      const tp1HitNow = !openPosition.tp1Hit && (isBuy ? high >= tp1Price : low <= tp1Price);
      const tp2Hit    = isBuy ? high >= tp2Price : low <= tp2Price;

      if (tp2Hit && (tp1Hit || tp1HitNow)) {
        closedReason = "TP2";
        exitPrice    = tp2Price;
      } else if (tp1HitNow) {
        openPosition.tp1Hit          = true;
        if (config.partialExitEnabled) {
          openPosition.stopLossPrice  = entryPrice;
          openPosition.slMovedToBreakeven = true;
        }
      }

      const slHit = isBuy ? low <= sl : high >= sl;
      if (slHit && closedReason === null) {
        closedReason = "SL";
        exitPrice    = sl;
      }

      if (closedReason) {
        const durationMinutes = (i - openPosition.entryIndex) * tfMinutes;
        const tradeCost       = openPosition.size * KUCOIN_FEE * 2;

        let pnlPct  = 0;
        let pnlUSDT = 0;

        if (closedReason === "TP2" && config.partialExitEnabled) {
          const tp1Fill = isBuy ? tp1Price * (1 - SLIPPAGE_TP) : tp1Price * (1 + SLIPPAGE_TP);
          const tp2Fill = isBuy ? tp2Price * (1 - SLIPPAGE_TP) : tp2Price * (1 + SLIPPAGE_TP);
          const tp1Pct = isBuy
            ? (tp1Fill - entryPrice) / entryPrice * 100
            : (entryPrice - tp1Fill) / entryPrice * 100;
          const tp2Pct = isBuy
            ? (tp2Fill - entryPrice) / entryPrice * 100
            : (entryPrice - tp2Fill) / entryPrice * 100;
          pnlPct = tp1Pct * 0.5 + tp2Pct * 0.5;
        } else if (closedReason === "SL" && openPosition.tp1Hit && config.partialExitEnabled) {
          const tp1Fill  = isBuy ? tp1Price * (1 - SLIPPAGE_TP) : tp1Price * (1 + SLIPPAGE_TP);
          const tp1Pct   = isBuy
            ? (tp1Fill - entryPrice) / entryPrice * 100
            : (entryPrice - tp1Fill) / entryPrice * 100;
          const slSlipped = isBuy
            ? exitPrice * (1 - SLIPPAGE)
            : exitPrice * (1 + SLIPPAGE);
          const slPct = isBuy
            ? (slSlipped - entryPrice) / entryPrice * 100
            : (entryPrice - slSlipped) / entryPrice * 100;
          pnlPct = tp1Pct * 0.5 + slPct * 0.5;
        } else {
          const slippedExit = closedReason === "SL"
            ? (isBuy ? exitPrice * (1 - SLIPPAGE)    : exitPrice * (1 + SLIPPAGE))
            : (isBuy ? exitPrice * (1 - SLIPPAGE_TP) : exitPrice * (1 + SLIPPAGE_TP));
          pnlPct = isBuy
            ? (slippedExit - entryPrice) / entryPrice * 100
            : (entryPrice - slippedExit) / entryPrice * 100;
        }

        pnlUSDT = openPosition.size * (pnlPct / 100) - tradeCost;
        balance += pnlUSDT;
        peakBalance = Math.max(peakBalance, balance);
        const drawdown = ((peakBalance - balance) / peakBalance) * 100;
        maxDrawdown    = Math.max(maxDrawdown, drawdown);

        if (pnlUSDT > 0) {
          consecutiveLosses = 0;
        } else {
          consecutiveLosses++;
          maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
        }

        allTrades.push({
          id: `bt-${i}`,
          symbol: config.symbol,
          direction,
          entryTime:       openPosition.entryTime,
          exitTime:        candle.time,
          entryPrice:      openPosition.entryPrice,
          exitPrice,
          stopLossPrice:   sl,
          takeProfitPrice1: tp1Price,
          takeProfitPrice2: tp2Price,
          tp1Hit:  openPosition.tp1Hit,
          tp2Hit:  closedReason === "TP2",
          slHit:   closedReason === "SL",
          pnlUSDT,
          pnlPct,
          durationMinutes,
          signalScore:       openPosition.signalScore,
          riskRewardRatio:   openPosition.rr,
          exitReason:        closedReason,
          conditionsMet:     openPosition.conditionsMet,
          maxFavorableExcursion: openPosition.maxFav,
          maxAdverseExcursion:   openPosition.maxAdv,
        });

        equityCurve.push({ time: candle.time, balance });
        openPosition = null;

        const ddRatio = dailyStartBalance > 0
          ? (dailyStartBalance - balance) / dailyStartBalance
          : 0;
        if (enforceDailyDrawdown && ddRatio >= DAILY_DRAWDOWN_LIMIT) {
          dailyHaltActive = true;
          warnings.push(
            `⚠️ Daily drawdown limit (${(DAILY_DRAWDOWN_LIMIT * 100).toFixed(0)}%) hit — skipping rest of day (candle ${i})`,
          );
        }
      }
    }

    if (openPosition || dailyHaltActive) continue;

    const opts = {
      rsiOversoldThreshold:   config.rsiOversoldThreshold   ?? 45,
      rsiOverboughtThreshold: config.rsiOverboughtThreshold ?? 55,
      volumeMultiplier:       config.volumeMultiplier        ?? 1.2,
    };
    const fastSig = generateSignalFast(i, candles, precomp, config.minSignalScore, opts);

    if (fastSig.direction === "NEUTRAL" || fastSig.score < config.minSignalScore) continue;

    const reg = precomp.regime[i];
    if (reg === 3) continue;
    if (reg === 2) continue;
    if (fastSig.direction === "BUY"  && reg === 1) continue;
    if (fastSig.direction === "SELL" && reg === 0) continue;

    if (mtf1h) {
      const currentBarStart = Math.floor(candle.time / mtf1h.periodSec) * mtf1h.periodSec;
      const prevBarTs = currentBarStart - mtf1h.periodSec;
      const idx1h = mtf1h.timeLookup.get(prevBarTs);
      if (idx1h !== undefined && !isNaN(mtf1h.indicators.adx[idx1h])) {
        const reg1h = mtf1h.indicators.regime[idx1h];
        if (reg1h === 2 || reg1h === 3) continue;
        if (fastSig.direction === "BUY"  && reg1h === 1) continue;
        if (fastSig.direction === "SELL" && reg1h === 0) continue;
      }
    }

    const lastAtr = isNaN(precomp.atr[i]) ? candle.close * 0.005 : precomp.atr[i];

    if (i + 1 >= candles.length) continue;

    const nextOpen     = candles[i + 1].open;
    const slippedEntry = fastSig.direction === "BUY"
      ? nextOpen * (1 + SLIPPAGE)
      : nextOpen * (1 - SLIPPAGE);

    let effectiveSize = config.tradeAmountUSDT;
    if (enforceHardCap) {
      const rrCap = calculateRiskReward(
        slippedEntry, fastSig.direction, lastAtr, precomp.fibonacci,
        config.tradeAmountUSDT, 0.5,
        config.stopLossAtrMultiplier, config.takeProfitMultiplier,
        config.tp1Ratio ?? 0.33,
      );
      const impliedRisk = config.tradeAmountUSDT * (rrCap.stopLossPct / 100);
      if (impliedRisk > HARD_CAP_USDT) {
        effectiveSize = config.tradeAmountUSDT * (HARD_CAP_USDT / impliedRisk);
      }
    }

    const rrEntry = calculateRiskReward(
      slippedEntry, fastSig.direction, lastAtr, precomp.fibonacci,
      effectiveSize, 0.5,
      config.stopLossAtrMultiplier, config.takeProfitMultiplier,
      config.tp1Ratio ?? 0.33,
    );

    openPosition = {
      direction:          fastSig.direction,
      entryPrice:         slippedEntry,
      entryTime:          candles[i + 1].time,
      entryIndex:         i + 1,
      stopLossPrice:      rrEntry.stopLossPrice,
      tp1Price:           rrEntry.takeProfitPrice1,
      tp2Price:           rrEntry.takeProfitPrice2,
      rr:                 rrEntry.riskRewardRatio,
      signalScore:        fastSig.score,
      conditionsMet:      [],
      tp1Hit:             false,
      slMovedToBreakeven: false,
      trailingStopPrice:  undefined,
      atrAtEntry:         lastAtr,
      size:               effectiveSize,
      maxFav:             0,
      maxAdv:             0,
    };
  }

  if (openPosition) {
    const lastCandle  = candles[candles.length - 1];
    const tradeCost   = openPosition.size * KUCOIN_FEE * 2;
    const isBuy       = openPosition.direction === "BUY";
    const exitPrice   = lastCandle.close;
    const pnlPct = isBuy
      ? (exitPrice - openPosition.entryPrice) / openPosition.entryPrice * 100
      : (openPosition.entryPrice - exitPrice) / openPosition.entryPrice * 100;
    const pnlUSDT = openPosition.size * (pnlPct / 100) - tradeCost;
    balance += pnlUSDT;

    allTrades.push({
      id: "bt-end",
      symbol:            config.symbol,
      direction:         openPosition.direction,
      entryTime:         openPosition.entryTime,
      exitTime:          lastCandle.time,
      entryPrice:        openPosition.entryPrice,
      exitPrice,
      stopLossPrice:     openPosition.stopLossPrice,
      takeProfitPrice1:  openPosition.tp1Price,
      takeProfitPrice2:  openPosition.tp2Price,
      tp1Hit:  openPosition.tp1Hit,
      tp2Hit:  false,
      slHit:   false,
      pnlUSDT,
      pnlPct,
      durationMinutes:   (candles.length - 1 - openPosition.entryIndex) * tfMinutes,
      signalScore:       openPosition.signalScore,
      riskRewardRatio:   openPosition.rr,
      exitReason:        "END_OF_DATA",
      conditionsMet:     openPosition.conditionsMet,
      maxFavorableExcursion: openPosition.maxFav,
      maxAdverseExcursion:   openPosition.maxAdv,
    });
  }

  return buildStats(allTrades, balance, startBalance, maxDrawdown,
    maxConsecutiveLosses, equityCurve, warnings);
}

function buildStats(
  allTrades: TradeResult[],
  balance: number,
  startBalance: number,
  maxDrawdown: number,
  maxConsecutiveLosses: number,
  equityCurve: { time: number; balance: number }[],
  warnings: string[],
): BacktestResults {
  const wins   = allTrades.filter((t) => t.pnlUSDT > 0);
  const losses = allTrades.filter((t) => t.pnlUSDT <= 0);

  const winRate    = allTrades.length > 0 ? wins.length / allTrades.length : 0;
  const avgWinPct  = wins.length   > 0 ? wins.reduce((a, t)   => a + t.pnlPct, 0) / wins.length   : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((a, t) => a + Math.abs(t.pnlPct), 0) / losses.length : 0;

  const grossWins   = wins.reduce((a, t)   => a + t.pnlUSDT, 0);
  const grossLosses = Math.abs(losses.reduce((a, t) => a + t.pnlUSDT, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;

  const totalReturnPct = ((balance - startBalance) / startBalance) * 100;
  const expectancy     = allTrades.length > 0
    ? allTrades.reduce((a, t) => a + t.pnlUSDT, 0) / allTrades.length
    : 0;

  const returns  = allTrades.map((t) => t.pnlPct);
  const avgRet   = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((a, b) => a + (b - avgRet) ** 2, 0) / (returns.length - 1)
    : 0;
  const sharpeRatio = variance > 0 ? avgRet / Math.sqrt(variance) : 0;

  const avgDuration = allTrades.length > 0
    ? allTrades.reduce((a, t) => a + t.durationMinutes, 0) / allTrades.length
    : 0;

  const sortedByPnl = [...allTrades].sort((a, b) => b.pnlPct - a.pnlPct);

  if (allTrades.length < 30) {
    warnings.push("⚠️ Fewer than 30 trades — insufficient data to validate strategy");
  }
  if (profitFactor < 1.2 && allTrades.length >= 30) {
    warnings.push("⚠️ Profit factor below 1.2 — strategy may not be profitable long-term");
  }
  if (maxDrawdown > 15) {
    warnings.push(`⚠️ Max drawdown ${maxDrawdown.toFixed(1)}% exceeds 15% safety threshold`);
  }

  return {
    totalTrades: allTrades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     winRate * 100,
    avgWinPct,
    avgLossPct,
    expectancy,
    profitFactor,
    totalReturnPct,
    maxDrawdownPct: maxDrawdown,
    maxConsecutiveLosses,
    sharpeRatio,
    bestTrade:  sortedByPnl[0]                    ?? null,
    worstTrade: sortedByPnl[sortedByPnl.length - 1] ?? null,
    allTrades,
    equityCurve,
    avgTradeDurationMinutes: avgDuration,
    warnings,
  };
}

export interface Optimize1500Result {
  bestParams: Pick<
    BacktestConfig,
    | "minSignalScore"
    | "stopLossAtrMultiplier"
    | "takeProfitMultiplier"
    | "rsiOversoldThreshold"
    | "rsiOverboughtThreshold"
    | "volumeMultiplier"
  >;
  result: BacktestResults;
  meetsTarget: boolean;
  targetMet: "WIN_RATE" | "POSITIVE_EV" | "BOTH" | "NONE";
}

export function optimize1500(
  candles: KuCoinCandle[],
  baseConfig: Pick<BacktestConfig, "symbol" | "timeframe" | "tradeAmountUSDT">,
): Optimize1500Result {
  const window = candles.slice(-1500);
  const windowPrecomp = precomputeIndicators(window);

  const minScores      = [5, 4, 6, 3];
  const slMultipliers  = [1.0, 1.5, 2.0];
  const tpMultipliers  = [2.5, 3.0, 3.5, 4.0];
  const rsiOversolds   = [35, 40, 45];
  const volMultipliers = [1.2, 1.0, 1.5];

  let best: Optimize1500Result | null = null;
  let bestScore = -Infinity;

  for (const minSignalScore of minScores) {
    for (const slMult of slMultipliers) {
      for (const tpMult of tpMultipliers) {
        if (tpMult < slMult * 2) continue;

        for (const rsiOversold of rsiOversolds) {
          for (const volMult of volMultipliers) {
            const result = runBacktest(window, {
              ...baseConfig,
              minSignalScore,
              stopLossAtrMultiplier:  slMult,
              takeProfitMultiplier:   tpMult,
              partialExitEnabled:     true,
              enforceHardCap:         true,
              enforceDailyDrawdown:   true,
              rsiOversoldThreshold:   rsiOversold,
              rsiOverboughtThreshold: 100 - rsiOversold,
              volumeMultiplier:       volMult,
            }, windowPrecomp);

            if (result.totalTrades < 5) continue;

            const meetsWR = result.winRate  >= 50;
            const meetsEV = result.expectancy > 0;

            const objectiveScore =
              result.winRate        * 2.0 +
              result.profitFactor   * 8.0 +
              result.sharpeRatio    * 4.0 -
              result.maxDrawdownPct ** 2 * 0.05;

            if (objectiveScore > bestScore) {
              bestScore = objectiveScore;
              best = {
                bestParams: {
                  minSignalScore,
                  stopLossAtrMultiplier:  slMult,
                  takeProfitMultiplier:   tpMult,
                  rsiOversoldThreshold:   rsiOversold,
                  rsiOverboughtThreshold: 100 - rsiOversold,
                  volumeMultiplier:       volMult,
                },
                result,
                meetsTarget: meetsWR || meetsEV,
                targetMet:
                  meetsWR && meetsEV ? "BOTH"
                  : meetsWR          ? "WIN_RATE"
                  : meetsEV          ? "POSITIVE_EV"
                  : "NONE",
              };
            }
          }
        }
      }
    }
  }

  if (!best) {
    const fallback = runBacktest(window, {
      ...baseConfig,
      minSignalScore:        4,
      stopLossAtrMultiplier: 1.5,
      takeProfitMultiplier:  2.5,
      partialExitEnabled:    true,
      enforceHardCap:        true,
      enforceDailyDrawdown:  true,
    });
    return {
      bestParams: {
        minSignalScore:        4,
        stopLossAtrMultiplier: 1.5,
        takeProfitMultiplier:  2.5,
        rsiOversoldThreshold:  40,
        rsiOverboughtThreshold: 60,
        volumeMultiplier:      1.2,
      },
      result: fallback,
      meetsTarget: false,
      targetMet: "NONE",
    };
  }

  return best;
}
