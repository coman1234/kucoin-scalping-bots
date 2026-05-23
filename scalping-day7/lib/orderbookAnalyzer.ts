/**
 * orderbookAnalyzer.ts — order book imbalance metrics for scalping-day6
 *
 * Converts raw L2 order book snapshot into a single normalised imbalance
 * score in [-1, +1], where +1 = pure bid pressure, -1 = pure ask pressure.
 */

import type { OrderBookFile, OrderBookLevel } from "./cacheReader";

export interface ImbalanceResult {
  imbalance:    number;   // [-1, +1]
  bidVolume:    number;   // total bid volume (top N levels)
  askVolume:    number;   // total ask volume (top N levels)
  spread:       number;   // ask[0] - bid[0] (absolute)
  spreadPct:    number;   // spread / mid × 100
  midPrice:     number;
  bullish:      boolean;  // imbalance > BULL_THRESHOLD
  bearish:      boolean;  // imbalance < BEAR_THRESHOLD
}

const LEVELS         = 10;      // top-N levels to sum
const BULL_THRESHOLD =  0.15;   // +15% bid dominance = bullish pressure
const BEAR_THRESHOLD = -0.15;   // −15% ask dominance = bearish pressure

/**
 * Sum volume across the top-N levels of one side.
 * Levels are already sorted: bids descending (best bid first),
 * asks ascending (best ask first).
 */
function sumVolume(levels: OrderBookLevel[], n = LEVELS): number {
  let total = 0;
  const limit = Math.min(n, levels.length);
  for (let i = 0; i < limit; i++) total += levels[i].size;
  return total;
}

/**
 * Compute order book imbalance from a cached order book snapshot.
 * Returns `null` if the book is missing or has fewer than 2 levels per side.
 */
export function analyzeOrderBook(book: OrderBookFile | null, levels = LEVELS): ImbalanceResult | null {
  if (!book || book.bids.length < 2 || book.asks.length < 2) return null;

  const bidVol = sumVolume(book.bids, levels);
  const askVol = sumVolume(book.asks, levels);
  const total  = bidVol + askVol;

  const imbalance = total > 0 ? (bidVol - askVol) / total : 0;

  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  const mid     = (bestBid + bestAsk) / 2;
  const spread  = bestAsk - bestBid;

  return {
    imbalance,
    bidVolume:  bidVol,
    askVolume:  askVol,
    spread,
    spreadPct:  mid > 0 ? (spread / mid) * 100 : 0,
    midPrice:   mid,
    bullish:    imbalance > BULL_THRESHOLD,
    bearish:    imbalance < BEAR_THRESHOLD,
  };
}

/**
 * Quick helper — returns just the [-1, +1] imbalance or 0 on missing data.
 */
export function obImbalance(book: OrderBookFile | null, levels = LEVELS): number {
  return analyzeOrderBook(book, levels)?.imbalance ?? 0;
}

/**
 * Compute VWAP of the top-N bid levels (weighted average bid price).
 * Useful as a short-term support proxy.
 */
export function bidVwap(book: OrderBookFile | null, n = LEVELS): number | null {
  if (!book || book.bids.length < 1) return null;
  let vol = 0, notional = 0;
  const limit = Math.min(n, book.bids.length);
  for (let i = 0; i < limit; i++) {
    vol      += book.bids[i].size;
    notional += book.bids[i].price * book.bids[i].size;
  }
  return vol > 0 ? notional / vol : null;
}

/**
 * Compute VWAP of the top-N ask levels (weighted average ask price).
 * Useful as a short-term resistance proxy.
 */
export function askVwap(book: OrderBookFile | null, n = LEVELS): number | null {
  if (!book || book.asks.length < 1) return null;
  let vol = 0, notional = 0;
  const limit = Math.min(n, book.asks.length);
  for (let i = 0; i < limit; i++) {
    vol      += book.asks[i].size;
    notional += book.asks[i].price * book.asks[i].size;
  }
  return vol > 0 ? notional / vol : null;
}
