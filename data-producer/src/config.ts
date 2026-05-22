import * as os from "node:os";
import * as path from "node:path";

// ── Shared-memory root ────────────────────────────────────────────────────────
// On Linux production use /dev/shm (RAM disk, ~1µs read latency).
// On macOS/Windows dev machines fall back to /tmp so the daemon still works.
export const SHM_ROOT: string = (() => {
  if (process.platform === "linux") {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.accessSync("/dev/shm", fs.constants.W_OK);
      return "/dev/shm/kucoin-data";
    } catch { /* fall through */ }
  }
  return path.join(os.tmpdir(), "kucoin-data");
})();

// ── KuCoin API ────────────────────────────────────────────────────────────────
export const KUCOIN_BASE_URL     = process.env.KUCOIN_BASE_URL ?? "https://api.kucoin.com";
export const REQUEST_TIMEOUT_MS  = 10_000;

// ── Fetch schedule ────────────────────────────────────────────────────────────
export const TICKER_INTERVAL_MS     =  2_000;   // allTickers — 1 request covers all pairs
export const ORDERBOOK_CYCLE_MS     =  4_000;   // full orderbook cycle across all 20 pairs
export const CANDLE_FAST_CYCLE_MS   = 65_000;   // 1/3/5 min candles refresh
export const CANDLE_SLOW_CYCLE_MS   = 300_000;  // 15min / 1h candles refresh
export const HEARTBEAT_INTERVAL_MS  =  1_000;

// Stagger between per-pair requests — 150 ms × 20 pairs = 3 s full cycle
export const PER_PAIR_DELAY_MS = 150;

// ── Staleness thresholds (read by consumers) ──────────────────────────────────
export const STALE_TICKER_MS    =  8_000;
export const STALE_ORDERBOOK_MS = 15_000;
export const STALE_CANDLE_MS    = 90_000;
export const PRODUCER_DEAD_MS   = 10_000;   // heartbeat gap = producer down

// ── Top-20 universe ───────────────────────────────────────────────────────────
export const TOP_20_PAIRS: string[] = [
  "BTC-USDT", "ETH-USDT",  "SOL-USDT",  "XRP-USDT",  "BNB-USDT",
  "DOGE-USDT","ADA-USDT",  "AVAX-USDT", "LINK-USDT",  "DOT-USDT",
  "POL-USDT", "UNI-USDT",  "LTC-USDT",  "ATOM-USDT",  "ARB-USDT",
  "NEAR-USDT","APT-USDT",  "OP-USDT",   "TRX-USDT",   "INJ-USDT",
];

export const FAST_TIMEFRAMES = ["1min", "3min", "5min"]  as const;
export const SLOW_TIMEFRAMES = ["15min", "1hour"]        as const;
export const CANDLES_TO_STORE = 500;
export const PRODUCER_VERSION = "1.0.0";
