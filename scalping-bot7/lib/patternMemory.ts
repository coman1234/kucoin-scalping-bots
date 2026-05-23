import type { IndicatorResult } from "./indicators";

/** Minimum weighted Euclidean similarity to count a stored pattern as "similar" */
const SIMILARITY_THRESHOLD = 0.65;

export interface PatternFingerprint {
  id: string;
  symbol: string;
  timeframe: string;
  timestamp: number;
  indicators: {
    rsi: number;
    rsiZone: "oversold" | "neutral" | "overbought";
    macdHistogram: number;
    macdCross: "bullish" | "bearish" | "none";
    bbPosition: "below" | "inside" | "above";
    bbWidth: number;
    ema9vsEma21: "above" | "below" | "crossing";
    volumeRatio: number;
    fibLevel: number | null;
    trendDirection: "up" | "down" | "sideways";
    candlePattern: "hammer" | "doji" | "engulfing" | "none";
  };
  signalScore: number;
  signalDirection: "BUY" | "SELL";
  conditionsMet: string[];
  outcome: "WIN" | "LOSS" | "BREAKEVEN" | "PENDING";
  pnlPct: number;
  exitReason: "TP1" | "TP2" | "SL" | "SIGNAL_REVERSAL" | "END_OF_DATA" | null;
  tradeDurationMinutes: number;
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
}

export interface PatternAnalysis {
  matchCount: number;
  winRate: number;
  avgPnlPct: number;
  avgDurationMinutes: number;
  bestOutcome: number;
  worstOutcome: number;
  commonExitReason: string;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_DATA";
  recommendation: "PROCEED" | "CAUTION" | "SKIP";
  recommendationReason: string;
  patternBonus: number;
}

const MAX_PATTERNS = 500;

interface FeatureVector {
  rsi:          number;
  macdHistNorm: number;
  bbPosition:   number;
  ema9Spread:   number;
  volumeRatio:  number;
  trendDir:     number;
  fibProximity: number;
}

const FEATURE_WEIGHTS: Record<keyof FeatureVector, number> = {
  rsi:          2.0,
  macdHistNorm: 1.5,
  bbPosition:   1.5,
  ema9Spread:   2.0,
  volumeRatio:  1.0,
  trendDir:     2.0,
  fibProximity: 1.0,
};
const TOTAL_WEIGHT = Object.values(FEATURE_WEIGHTS).reduce((a, b) => a + b, 0);

function toFeatureVector(ind: PatternFingerprint["indicators"]): FeatureVector {
  return {
    rsi: ind.rsi / 100,
    macdHistNorm: Math.tanh(ind.macdHistogram * 500) * 0.5 + 0.5,
    bbPosition:
      ind.bbPosition === "below"  ? 0.0
      : ind.bbPosition === "above" ? 1.0
      : 0.5,
    ema9Spread:
      ind.ema9vsEma21 === "above"    ? 1.0
      : ind.ema9vsEma21 === "below"  ? 0.0
      : 0.5,
    volumeRatio: Math.min(ind.volumeRatio / 3, 1),
    trendDir:
      ind.trendDirection === "up"   ? 1.0
      : ind.trendDirection === "down" ? 0.0
      : 0.5,
    fibProximity:
      ind.fibLevel !== null
        ? Math.max(0, 1 - Math.abs(1 - ind.fibLevel) * 20)
        : 0.0,
  };
}

function weightedEuclideanDistance(a: FeatureVector, b: FeatureVector): number {
  let sumSq = 0;
  for (const key of Object.keys(FEATURE_WEIGHTS) as (keyof FeatureVector)[]) {
    sumSq += FEATURE_WEIGHTS[key] * (a[key] - b[key]) ** 2;
  }
  return Math.sqrt(sumSq / TOTAL_WEIGHT);
}

function similarityScore(
  current: PatternFingerprint["indicators"],
  stored:  PatternFingerprint["indicators"],
): number {
  const dist = weightedEuclideanDistance(toFeatureVector(current), toFeatureVector(stored));
  return Math.max(0, 1 - dist / 0.35);
}

function storageKey(symbol: string, timeframe: string): string {
  return `patternMemory_${symbol}_${timeframe}`;
}

export function loadPatterns(
  symbol: string,
  timeframe: string,
): PatternFingerprint[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey(symbol, timeframe));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function savePattern(pattern: PatternFingerprint): void {
  if (typeof window === "undefined") return;
  const key = storageKey(pattern.symbol, pattern.timeframe);
  let patterns = loadPatterns(pattern.symbol, pattern.timeframe);

  const idx = patterns.findIndex((p) => p.id === pattern.id);
  if (idx >= 0) {
    patterns[idx] = pattern;
  } else {
    patterns.push(pattern);
    if (patterns.length > MAX_PATTERNS) {
      patterns = patterns.slice(patterns.length - MAX_PATTERNS);
    }
  }

  try {
    localStorage.setItem(key, JSON.stringify(patterns));
  } catch {
    // Ignore quota errors silently
  }
}

export function updatePatternOutcome(
  id: string,
  symbol: string,
  timeframe: string,
  outcome: PatternFingerprint["outcome"],
  pnlPct: number,
  exitReason: PatternFingerprint["exitReason"],
  durationMinutes: number,
  maxFav: number,
  maxAdv: number,
): void {
  const patterns = loadPatterns(symbol, timeframe);
  const pattern  = patterns.find((p) => p.id === id);
  if (!pattern) return;
  pattern.outcome              = outcome;
  pattern.pnlPct               = pnlPct;
  pattern.exitReason           = exitReason;
  pattern.tradeDurationMinutes = durationMinutes;
  pattern.maxFavorableExcursion = maxFav;
  pattern.maxAdverseExcursion  = maxAdv;
  savePattern(pattern);
}

export function buildFingerprint(
  ind: IndicatorResult,
  currentCandle: { open: number; high: number; low: number; close: number; volume: number },
  signalScore: number,
  signalDirection: "BUY" | "SELL",
  conditionsMet: string[],
  symbol: string,
  timeframe: string,
): PatternFingerprint {
  const rsi     = ind.rsi[ind.rsi.length - 1] ?? 50;
  const rsiZone: PatternFingerprint["indicators"]["rsiZone"] =
    rsi < 35 ? "oversold" : rsi > 65 ? "overbought" : "neutral";

  const macdHist     = ind.macd.histogram[ind.macd.histogram.length - 1] ?? 0;
  const prevMacdHist = ind.macd.histogram[ind.macd.histogram.length - 2] ?? 0;
  let macdCross: PatternFingerprint["indicators"]["macdCross"] = "none";
  if (prevMacdHist <= 0 && macdHist > 0)  macdCross = "bullish";
  else if (prevMacdHist >= 0 && macdHist < 0) macdCross = "bearish";

  const bbUpper  = ind.bb.upper[ind.bb.upper.length - 1]   ?? currentCandle.close;
  const bbLower  = ind.bb.lower[ind.bb.lower.length - 1]   ?? currentCandle.close;
  const bbMiddle = ind.bb.middle[ind.bb.middle.length - 1] ?? currentCandle.close;
  const bbWidth  = bbUpper > 0 ? ((bbUpper - bbLower) / bbMiddle) * 100 : 0;
  let bbPosition: PatternFingerprint["indicators"]["bbPosition"] = "inside";
  if (currentCandle.close < bbLower) bbPosition = "below";
  else if (currentCandle.close > bbUpper) bbPosition = "above";

  const ema9     = ind.ema9[ind.ema9.length - 1]   ?? currentCandle.close;
  const ema21    = ind.ema21[ind.ema21.length - 1]  ?? currentCandle.close;
  const prevEma9  = ind.ema9[ind.ema9.length - 2]  ?? ema9;
  const prevEma21 = ind.ema21[ind.ema21.length - 2] ?? ema21;
  let ema9vsEma21: PatternFingerprint["indicators"]["ema9vsEma21"] = "above";
  if (ema9 > ema21)  ema9vsEma21 = "above";
  else if (ema9 < ema21) ema9vsEma21 = "below";
  if (
    (prevEma9 <= prevEma21 && ema9 > ema21) ||
    (prevEma9 >= prevEma21 && ema9 < ema21)
  ) ema9vsEma21 = "crossing";

  const volMA      = ind.volumeMA[ind.volumeMA.length - 1] ?? 1;
  const volumeRatio = volMA > 0 ? currentCandle.volume / volMA : 1;

  const ema21Recent = ind.ema21.slice(-5);
  let trendDirection: PatternFingerprint["indicators"]["trendDirection"] = "sideways";
  if (ema21Recent.length >= 2) {
    const slope    = ema21Recent[ema21Recent.length - 1] - ema21Recent[0];
    const relSlope = Math.abs(slope) / (ema21Recent[0] || 1);
    if (relSlope > 0.002) trendDirection = slope > 0 ? "up" : "down";
  }

  let candlePattern: PatternFingerprint["indicators"]["candlePattern"] = "none";
  const body       = Math.abs(currentCandle.close - currentCandle.open);
  const totalRange = currentCandle.high - currentCandle.low;
  const upperWick  = currentCandle.high - Math.max(currentCandle.close, currentCandle.open);
  const lowerWick  = Math.min(currentCandle.close, currentCandle.open) - currentCandle.low;
  if (totalRange > 0) {
    if (body / totalRange < 0.1) candlePattern = "doji";
    else if (lowerWick > body * 2 && upperWick < body * 0.5) candlePattern = "hammer";
  }

  let fibLevel: number | null = null;
  if (ind.fibonacci) {
    const levels = Object.values(ind.fibonacci.levels);
    let closestDist = Infinity;
    for (const lvl of levels) {
      const dist = Math.abs(lvl - currentCandle.close) / currentCandle.close;
      if (dist < closestDist && dist < 0.005) {
        closestDist = dist;
        fibLevel = parseFloat((currentCandle.close / lvl).toFixed(4));
      }
    }
  }

  return {
    id: `pm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol,
    timeframe,
    timestamp: Date.now(),
    indicators: {
      rsi, rsiZone,
      macdHistogram: macdHist,
      macdCross,
      bbPosition, bbWidth,
      ema9vsEma21,
      volumeRatio,
      fibLevel,
      trendDirection,
      candlePattern,
    },
    signalScore,
    signalDirection,
    conditionsMet,
    outcome: "PENDING",
    pnlPct: 0,
    exitReason: null,
    tradeDurationMinutes: 0,
    maxFavorableExcursion: 0,
    maxAdverseExcursion: 0,
  };
}

export function findSimilarPatterns(
  current: PatternFingerprint["indicators"],
  symbol: string,
  timeframe: string,
  direction: "BUY" | "SELL",
): PatternAnalysis {
  const all = loadPatterns(symbol, timeframe).filter(
    (p) => p.outcome !== "PENDING" && p.signalDirection === direction,
  );

  const similar = all.filter(
    (p) => similarityScore(current, p.indicators) >= SIMILARITY_THRESHOLD,
  );

  if (similar.length < 2) {
    return {
      matchCount: similar.length,
      winRate: 0,
      avgPnlPct: 0,
      avgDurationMinutes: 0,
      bestOutcome: 0,
      worstOutcome: 0,
      commonExitReason: "N/A",
      confidence: "INSUFFICIENT_DATA",
      recommendation: "PROCEED",
      recommendationReason: "Not enough historical pattern data yet — proceeding normally",
      patternBonus: 0,
    };
  }

  const wins         = similar.filter((p) => p.outcome === "WIN");
  const winRate      = (wins.length / similar.length) * 100;
  const avgPnlPct    = similar.reduce((a, p) => a + p.pnlPct, 0) / similar.length;
  const avgDuration  = similar.reduce((a, p) => a + p.tradeDurationMinutes, 0) / similar.length;
  const pnlValues    = similar.map((p) => p.pnlPct);
  const bestOutcome  = Math.max(...pnlValues);
  const worstOutcome = Math.min(...pnlValues);

  const exitCounts: Record<string, number> = {};
  for (const p of similar) {
    if (p.exitReason) exitCounts[p.exitReason] = (exitCounts[p.exitReason] ?? 0) + 1;
  }
  const commonExitReason =
    Object.entries(exitCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "N/A";

  const confidence: PatternAnalysis["confidence"] =
    similar.length >= 10 ? "HIGH"
    : similar.length >= 5 ? "MEDIUM"
    : "LOW";

  let recommendation: PatternAnalysis["recommendation"] = "PROCEED";
  let recommendationReason = "";
  let patternBonus = 0;

  if (winRate < 35) {
    recommendation = "SKIP";
    recommendationReason = `Pattern historically fails — only ${winRate.toFixed(0)}% win rate across ${similar.length} similar trades`;
    patternBonus = -999;
  } else if (winRate < 45 || avgPnlPct < -0.5) {
    recommendation = "CAUTION";
    recommendationReason = `Pattern underperforms — ${winRate.toFixed(0)}% WR, avg P&L ${avgPnlPct.toFixed(2)}%`;
    patternBonus = -0.5;
  } else if (winRate >= 60 && avgPnlPct > 0) {
    recommendation = "PROCEED";
    recommendationReason = `Strong pattern — ${winRate.toFixed(0)}% WR across ${similar.length} similar trades`;
    patternBonus = confidence === "HIGH" ? 0.5 : 0.25;
  } else {
    recommendation = "PROCEED";
    recommendationReason = `Acceptable pattern — ${winRate.toFixed(0)}% WR, avg P&L ${avgPnlPct.toFixed(2)}%`;
    patternBonus = 0;
  }

  return {
    matchCount: similar.length,
    winRate,
    avgPnlPct,
    avgDurationMinutes: avgDuration,
    bestOutcome,
    worstOutcome,
    commonExitReason,
    confidence,
    recommendation,
    recommendationReason,
    patternBonus,
  };
}

export function exportPatterns(symbol: string, timeframe: string): string {
  return JSON.stringify(loadPatterns(symbol, timeframe), null, 2);
}

export function importPatterns(
  data: string,
  targetSymbol: string,
  targetTimeframe: string,
  withWarning = false,
): { imported: number; warning: string } {
  try {
    const patterns: PatternFingerprint[] = JSON.parse(data);
    const existing = loadPatterns(targetSymbol, targetTimeframe);
    const merged = [
      ...existing,
      ...patterns.map((p) => ({
        ...p,
        symbol:    targetSymbol,
        timeframe: targetTimeframe,
        id: `imported-${p.id}`,
      })),
    ].slice(-MAX_PATTERNS);
    localStorage.setItem(storageKey(targetSymbol, targetTimeframe), JSON.stringify(merged));
    return {
      imported: patterns.length,
      warning: withWarning
        ? "⚠️ Patterns imported from different timeframe — accuracy may be reduced"
        : "",
    };
  } catch {
    return { imported: 0, warning: "Import failed — invalid JSON" };
  }
}

export function getPatternCount(symbol: string, timeframe: string): number {
  return loadPatterns(symbol, timeframe).filter((p) => p.outcome !== "PENDING").length;
}
