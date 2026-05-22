/**
 * Main production loops — three independent async loops running concurrently:
 *  1. tickerLoop   — fetches allTickers every TICKER_INTERVAL_MS
 *  2. orderbookLoop — cycles through TOP_20_PAIRS, staggered by PER_PAIR_DELAY_MS
 *  3. candleLoop   — fast (1/3/5 min) and slow (15min/1h) cycles, staggered
 *
 * Each loop is independent; a failure in one does not kill the others.
 * All writes go through atomicWrite() in writer.ts.
 */

import {
  TICKER_INTERVAL_MS, ORDERBOOK_CYCLE_MS, CANDLE_FAST_CYCLE_MS,
  CANDLE_SLOW_CYCLE_MS, PER_PAIR_DELAY_MS,
  TOP_20_PAIRS, FAST_TIMEFRAMES, SLOW_TIMEFRAMES, PRODUCER_VERSION,
} from "./config.js";
import { fetchAllTickers, fetchCandles, fetchOrderBook } from "./kucoin.js";
import {
  writeCandleFile, writeTickerFile, writeOrderBookFile, writeMeta,
} from "./writer.js";
import type { ProducerMeta } from "./types.js";

// ── Shared state ──────────────────────────────────────────────────────────────

const meta: ProducerMeta = {
  pid:                 process.pid,
  version:             PRODUCER_VERSION,
  startedAt:           Date.now(),
  heartbeatAt:         Date.now(),
  lastTickerUpdate:    0,
  lastCandleUpdate:    0,
  lastOrderbookUpdate: 0,
  cycleCount:          0,
  errorCount:          0,
  shmRoot:             "",   // filled in by index.ts after ensureDirs()
};

export function setShmRoot(root: string): void { meta.shmRoot = root; }

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

export function startHeartbeat(): void {
  setInterval(() => {
    meta.heartbeatAt = Date.now();
    meta.cycleCount++;
    try { writeMeta(meta); } catch { /* non-fatal */ }
  }, 1_000);
}

// ── Ticker loop ───────────────────────────────────────────────────────────────

export async function tickerLoop(): Promise<never> {
  while (true) {
    const start = Date.now();
    try {
      const tickers = await fetchAllTickers(TOP_20_PAIRS);
      writeTickerFile({
        fetchedAt:       Date.now(),
        producerVersion: PRODUCER_VERSION,
        tickers,
      });
      meta.lastTickerUpdate = Date.now();
    } catch (err) {
      meta.errorCount++;
      console.error(`[ticker]`, (err as Error).message);
    }
    const elapsed = Date.now() - start;
    await sleep(Math.max(0, TICKER_INTERVAL_MS - elapsed));
  }
}

// ── Order book loop ───────────────────────────────────────────────────────────

export async function orderbookLoop(): Promise<never> {
  while (true) {
    const cycleStart = Date.now();
    for (const symbol of TOP_20_PAIRS) {
      try {
        const book = await fetchOrderBook(symbol);
        writeOrderBookFile({
          symbol,
          fetchedAt:       Date.now(),
          producerVersion: PRODUCER_VERSION,
          ...book,
        });
        meta.lastOrderbookUpdate = Date.now();
      } catch (err) {
        meta.errorCount++;
        console.error(`[orderbook:${symbol}]`, (err as Error).message);
      }
      await sleep(PER_PAIR_DELAY_MS);
    }
    const elapsed = Date.now() - cycleStart;
    await sleep(Math.max(0, ORDERBOOK_CYCLE_MS - elapsed));
  }
}

// ── Candle loop ───────────────────────────────────────────────────────────────

async function runCandleCycle(timeframes: readonly string[]): Promise<void> {
  for (const symbol of TOP_20_PAIRS) {
    for (const tf of timeframes) {
      try {
        const candles = await fetchCandles(symbol, tf);
        writeCandleFile({
          symbol,
          timeframe:       tf,
          fetchedAt:       Date.now(),
          producerVersion: PRODUCER_VERSION,
          candles,
        });
        meta.lastCandleUpdate = Date.now();
      } catch (err) {
        meta.errorCount++;
        console.error(`[candle:${symbol}:${tf}]`, (err as Error).message);
      }
      await sleep(PER_PAIR_DELAY_MS);
    }
  }
}

export async function candleLoop(): Promise<never> {
  let slowAt = 0;  // timestamp of last slow cycle

  while (true) {
    const cycleStart = Date.now();

    // Fast timeframes: every CANDLE_FAST_CYCLE_MS
    await runCandleCycle(FAST_TIMEFRAMES);

    // Slow timeframes: every CANDLE_SLOW_CYCLE_MS
    if (Date.now() - slowAt >= CANDLE_SLOW_CYCLE_MS) {
      await runCandleCycle(SLOW_TIMEFRAMES);
      slowAt = Date.now();
    }

    const elapsed = Date.now() - cycleStart;
    const wait    = Math.max(0, CANDLE_FAST_CYCLE_MS - elapsed);
    if (wait > 0) await sleep(wait);
  }
}
