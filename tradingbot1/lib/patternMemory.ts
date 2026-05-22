// ─── Pattern Memory Engine ───────────────────────────────────────────────────
//
// Each trade entry is "fingerprinted" as a normalised vector of indicator values.
// On a new signal, similarityScore() searches historical fingerprints and returns
// a weighted confidence adjustment based on EV of similar past setups.
//
// Similarity: cosine similarity on the normalised feature vector.
// EV weighting: patterns with high historical EV boost confidence; losers reduce it.

import { Indicators, Direction, TradeStatus } from './types';

export interface PatternFingerprint {
  id: string;
  timestamp: number;
  symbol: string;
  direction: Direction;
  signalScore: number;
  features: NormalisedFeatures;
  outcome?: PatternOutcome;
}

export interface PatternOutcome {
  status: TradeStatus;
  pnl: number;
  holdBars: number; // how many candles until exit
  rMultiple: number; // pnl / initial risk
}

// Normalised feature vector — all values mapped to [0, 1] or [-1, 1]
export interface NormalisedFeatures {
  ema9vs21: number;      // (ema9 - ema21) / ema21 — trend separation
  bbPosition: number;    // (price - bbLower) / (bbUpper - bbLower)
  rsiNorm: number;       // rsi / 100
  macdSign: number;      // sign of macd line: -1 / 0 / +1
  histMomentum: number;  // macdHistogram sign relative to prev
  volumeRatio: number;   // volume / volumeMA, capped at 3
  atrNorm: number;       // atr / price — volatility normalised to price
  fibProximity: number;  // closest fib distance / price
  wickStrength: number;  // 0–1 from wick analysis
  wickBullish: number;   // 1=bullish, -1=bearish, 0=neutral
}

// In-memory store (swap for Redis/DB in production)
const store: Map<string, PatternFingerprint> = new Map();
let storeVersion = 0;

// ── Build a normalised feature vector from live indicators ──────────────────
export function buildFingerprint(
  id: string,
  symbol: string,
  direction: Direction,
  signalScore: number,
  indicators: Indicators,
  currentPrice: number,
  wickStrength: number,
  wickBullish: number,
  timestamp = Date.now()
): PatternFingerprint {
  const fib = indicators.fibLevels;
  const fibLevels = [
    fib.level236, fib.level382, fib.level500,
    fib.level618, fib.level786,
  ];
  const fibProximity = Math.min(
    ...fibLevels.map((l) => Math.abs(currentPrice - l) / currentPrice)
  );

  const bbRange = indicators.bbUpper - indicators.bbLower;
  const bbPosition = bbRange > 0
    ? (currentPrice - indicators.bbLower) / bbRange
    : 0.5;

  const features: NormalisedFeatures = {
    ema9vs21: indicators.ema21 !== 0
      ? (indicators.ema9 - indicators.ema21) / indicators.ema21
      : 0,
    bbPosition: Math.max(0, Math.min(1, bbPosition)),
    rsiNorm: indicators.rsi / 100,
    macdSign: Math.sign(indicators.macdLine),
    histMomentum: Math.sign(indicators.macdHistogram),
    volumeRatio: Math.min(3, indicators.volumeMA > 0
      ? indicators.volumeMA / indicators.volumeMA  // replaced at call site
      : 1),
    atrNorm: currentPrice > 0 ? indicators.atr / currentPrice : 0,
    fibProximity: Math.min(1, fibProximity * 100), // scale to ~0-1
    wickStrength,
    wickBullish,
  };

  return { id, timestamp, symbol, direction, signalScore, features };
}

// ── Volume ratio needs current volume, provide an overloaded builder ─────────
export function buildFingerprintFull(
  id: string,
  symbol: string,
  direction: Direction,
  signalScore: number,
  indicators: Indicators,
  currentPrice: number,
  currentVolume: number,
  wickStrength: number,
  wickBullish: number,
  timestamp = Date.now()
): PatternFingerprint {
  const fp = buildFingerprint(
    id, symbol, direction, signalScore,
    indicators, currentPrice, wickStrength, wickBullish, timestamp
  );
  fp.features.volumeRatio = Math.min(
    3,
    indicators.volumeMA > 0 ? currentVolume / indicators.volumeMA : 1
  );
  return fp;
}

// ── Persist a fingerprint ────────────────────────────────────────────────────
export function storePattern(fingerprint: PatternFingerprint): void {
  store.set(fingerprint.id, fingerprint);
  storeVersion++;
}

// ── Record the outcome once the trade closes ─────────────────────────────────
export function recordOutcome(id: string, outcome: PatternOutcome): void {
  const fp = store.get(id);
  if (fp) {
    store.set(id, { ...fp, outcome });
    storeVersion++;
  }
}

// ── Cosine similarity between two feature vectors ────────────────────────────
function cosineSimilarity(a: NormalisedFeatures, b: NormalisedFeatures): number {
  const keys = Object.keys(a) as (keyof NormalisedFeatures)[];
  let dot = 0, normA = 0, normB = 0;
  for (const k of keys) {
    dot += a[k] * b[k];
    normA += a[k] ** 2;
    normB += b[k] ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Weighted EV of k most similar historical patterns ───────────────────────
//
// Returns a confidence multiplier in [-1, +1]:
//   +1.0 = historically similar setups all won at high R-multiple
//   -1.0 = historically similar setups all lost
//    0.0 = no history or neutral EV
//
export function similarityScore(
  candidate: PatternFingerprint,
  topK = 10,
  minSimilarity = 0.85
): { multiplier: number; matchCount: number; avgSimilarity: number } {
  const resolved = Array.from(store.values()).filter(
    (fp) => fp.id !== candidate.id && fp.outcome !== undefined
  );

  if (resolved.length === 0) {
    return { multiplier: 0, matchCount: 0, avgSimilarity: 0 };
  }

  // Score and rank all stored patterns by cosine similarity
  const scored = resolved
    .map((fp) => ({
      fp,
      sim: cosineSimilarity(candidate.features, fp.features),
    }))
    .filter((s) => s.sim >= minSimilarity)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topK);

  if (scored.length === 0) {
    return { multiplier: 0, matchCount: 0, avgSimilarity: 0 };
  }

  // Weighted average of R-multiples (similarity is the weight)
  let weightedRSum = 0;
  let totalWeight = 0;
  let simSum = 0;

  for (const { fp, sim } of scored) {
    const r = fp.outcome!.rMultiple; // known to be set due to filter above
    // Direction mismatch inverts the R signal
    const directionMatch = fp.direction === candidate.direction ? 1 : -1;
    weightedRSum += sim * r * directionMatch;
    totalWeight += sim;
    simSum += sim;
  }

  const avgR = totalWeight > 0 ? weightedRSum / totalWeight : 0;
  const avgSimilarity = simSum / scored.length;

  // Normalise to [-1, +1]: assume R-multiples typically range -2 to +4
  const multiplier = Math.max(-1, Math.min(1, avgR / 4));

  return { multiplier, matchCount: scored.length, avgSimilarity };
}

// ── Retrieve stored patterns (diagnostics / UI) ───────────────────────────────
export function getAllPatterns(): PatternFingerprint[] {
  return Array.from(store.values());
}

export function getPatternStats(): {
  total: number;
  resolved: number;
  winRate: number;
  avgRMultiple: number;
} {
  const all = Array.from(store.values());
  const resolved = all.filter((fp) => fp.outcome);
  const wins = resolved.filter((fp) => (fp.outcome?.rMultiple ?? 0) > 0);
  const avgR =
    resolved.length > 0
      ? resolved.reduce((s, fp) => s + (fp.outcome?.rMultiple ?? 0), 0) /
        resolved.length
      : 0;

  return {
    total: all.length,
    resolved: resolved.length,
    winRate: resolved.length > 0 ? wins.length / resolved.length : 0,
    avgRMultiple: avgR,
  };
}

export function clearStore(): void {
  store.clear();
  storeVersion = 0;
}

export { storeVersion };
