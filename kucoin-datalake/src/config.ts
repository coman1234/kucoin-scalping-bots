import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// ── SHM paths ─────────────────────────────────────────────────────────────────
function shmBase(): string {
  if (process.platform === "linux") {
    try { fs.accessSync("/dev/shm", fs.constants.W_OK); return "/dev/shm"; }
    catch { /* fall through */ }
  }
  return os.tmpdir();
}

export const SHM_BASE        = shmBase();
export const SHM_DATALAKE    = path.join(SHM_BASE, "datalake");
export const SHM_KUCOIN_DATA = path.join(SHM_BASE, "kucoin-data");  // from data-producer

// ── Disk storage ──────────────────────────────────────────────────────────────
export const DATA_ROOT   = process.env.DATALAKE_ROOT ?? "/var/lib/kucoin-datalake";
export const HISTORY_DIR = path.join(DATA_ROOT, "history");
export const RUNS_DIR    = path.join(DATA_ROOT, "runs");
export const DB_PATH     = path.join(DATA_ROOT, "learning.db");

// ── KuCoin API ────────────────────────────────────────────────────────────────
export const KUCOIN_BASE_URL = process.env.KUCOIN_BASE_URL ?? "https://api.kucoin.com";
export const KUCOIN_API_KEY    = process.env.KUCOIN_API_KEY    ?? "";
export const KUCOIN_API_SECRET = process.env.KUCOIN_API_SECRET ?? "";
export const KUCOIN_PASSPHRASE = process.env.KUCOIN_PASSPHRASE ?? "";

// ── Optimizer config ──────────────────────────────────────────────────────────
export const WORKER_COUNT       = Math.max(2, Math.min(4, (os.cpus().length ?? 4) - 1));
export const OPTIMIZER_INTERVAL = 6 * 60 * 60 * 1000;   // every 6 hours
export const OOS_RATIO          = 0.3;                   // last 30% = out-of-sample
export const MIN_PF_GATE        = 1.05;                  // skip combos with IS pf < 1.05
export const MIN_TRADES         = 10;                    // skip combos with too few trades
export const UCB_C              = Math.sqrt(2);          // UCB1 exploration constant

// ── Download config ───────────────────────────────────────────────────────────
export const DOWNLOAD_DAYS      = 730;                   // 2 years of history
export const DOWNLOAD_TIMEFRAMES: string[] = ["5min", "15min", "1hour"];
export const DOWNLOAD_INTERVAL  = 4 * 60 * 60 * 1000;   // re-fetch every 4h

// ── Param grid ────────────────────────────────────────────────────────────────
export const PARAM_GRID = {
  minSignalScore:        [3, 4, 5, 6, 7, 8],
  stopLossAtrMultiplier: [1.0, 1.5, 2.0, 2.5],
  takeProfitMultiplier:  [1.5, 2.0, 2.5, 3.0],
  adxThreshold:          [20, 25, 30],
  bbSqueezeFilter:       [false, true],
  timeframe:             ["5min", "15min"] as string[],
};

// ── Watch pairs ───────────────────────────────────────────────────────────────
export const WATCH_PAIRS = [
  "BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","DOGE-USDT",
  "XRP-USDT","ADA-USDT","AVAX-USDT","POL-USDT","DOT-USDT",
  "LINK-USDT","UNI-USDT","ATOM-USDT","LTC-USDT","BCH-USDT",
  "NEAR-USDT","FIL-USDT","APT-USDT","ARB-USDT","OP-USDT",
];

// ── HTTP server ───────────────────────────────────────────────────────────────
export const HTTP_PORT = parseInt(process.env.PORT ?? "3010", 10);

// ── Version ───────────────────────────────────────────────────────────────────
export const VERSION = "1.0.0";
