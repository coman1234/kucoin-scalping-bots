/**
 * historicalDownloader.ts — bulk download + daily incremental sync.
 *
 * Full download:   2 years of candles for all 20 pairs × all STORE_TIMEFRAMES
 * Incremental:     Only candles newer than last stored timestamp  (~15-60 s daily)
 */

import { getCandlesPaged } from "./kucoinPublic";
import {
  storeCandlesForPair,
  getLastCandleTime,
  STORE_TIMEFRAMES,
} from "./historicalDataStore";
import { TOP_20_PAIRS }      from "./autoOptimizer";
import { writeToFileLog }    from "./serverLogger";

// ── Config ────────────────────────────────────────────────────────────────────
const HISTORY_DAYS   = 730;
const PAIR_DELAY_MS  = 1_200;
const MAX_RETRIES    = 3;
const RETRY_BASE_MS  = 6_000;

const TF_STEP_SEC: Record<string, number> = {
  "1min": 60, "3min": 180, "5min": 300, "15min": 900,
  "30min": 1800, "1hour": 3600, "4hour": 14400, "1day": 86400,
};

// ── Progress types ────────────────────────────────────────────────────────────
export type DownloadMode = "full" | "incremental";

export interface DownloadProgress {
  pair:       string;
  pairIndex:  number;
  totalPairs: number;
  status:     "downloading" | "ok" | "error" | "skipped";
  message:    string;
  newCandles: number;
}

export interface DownloadState {
  running:    boolean;
  mode:       DownloadMode | null;
  progress:   DownloadProgress | null;
  startedAt:  number | null;
  finishedAt: number | null;
  lastError:  string | null;
  pairsOk:    number;
  pairsErr:   number;
}

// ── Singleton state ───────────────────────────────────────────────────────────
let _running:    boolean            = false;
let _mode:       DownloadMode | null = null;
let _progress:   DownloadProgress | null = null;
let _startedAt:  number | null      = null;
let _finishedAt: number | null      = null;
let _lastError:  string | null      = null;
let _pairsOk     = 0;
let _pairsErr    = 0;

export function getDownloadState(): DownloadState {
  return {
    running:   _running,
    mode:      _mode,
    progress:  _progress,
    startedAt: _startedAt, finishedAt: _finishedAt,
    lastError: _lastError,
    pairsOk:   _pairsOk,
    pairsErr:  _pairsErr,
  };
}

// ── Public entry points ───────────────────────────────────────────────────────

export function startFullDownload(): void {
  if (_running) return;
  _begin("full");
  _downloadAll("full").catch(e => { _lastError = String(e); })
    .finally(() => { _running = false; _finishedAt = Date.now(); });
}

export function startIncrementalSync(): void {
  if (_running) return;
  _begin("incremental");
  _downloadAll("incremental").catch(e => { _lastError = String(e); })
    .finally(() => { _running = false; _finishedAt = Date.now(); });
}

// ── Core download loop ────────────────────────────────────────────────────────
function _begin(mode: DownloadMode): void {
  _running    = true;
  _mode       = mode;
  _progress   = null;
  _startedAt  = Date.now();
  _finishedAt = null;
  _lastError  = null;
  _pairsOk    = 0;
  _pairsErr   = 0;
  const totalSteps = TOP_20_PAIRS.length * STORE_TIMEFRAMES.length;
  const msg = `Starting ${mode} download: ${TOP_20_PAIRS.length} pairs × ${STORE_TIMEFRAMES.length} timeframes = ${totalSteps} steps`;
  console.log(`[historicalDownloader] ${msg}`);
  writeToFileLog({ timestamp: Date.now(), type: "HIST_DOWNLOAD", severity: "info", title: msg }).catch(() => {});
}

async function _downloadAll(mode: DownloadMode): Promise<void> {
  const nowSec       = Math.floor(Date.now() / 1000);
  const fullStartSec = nowSec - HISTORY_DAYS * 86_400;
  const totalSteps   = TOP_20_PAIRS.length * STORE_TIMEFRAMES.length;

  let stepIndex = 0;

  for (let i = 0; i < TOP_20_PAIRS.length; i++) {
    const symbol = TOP_20_PAIRS[i];

    for (const tf of STORE_TIMEFRAMES) {
      const tfStepSec = TF_STEP_SEC[tf] ?? 300;

      _progress = {
        pair: symbol, pairIndex: stepIndex, totalPairs: totalSteps,
        status: "downloading", message: `Fetching ${symbol} ${tf}...`, newCandles: 0,
      };

      let startAt: number;
      if (mode === "incremental") {
        const lastSec = getLastCandleTime(symbol, tf);
        if (lastSec !== null && lastSec > fullStartSec) {
          startAt = lastSec + tfStepSec;
        } else {
          startAt = fullStartSec;
        }
      } else {
        startAt = fullStartSec;
      }

      const endAt = nowSec;

      if (startAt >= endAt - tfStepSec * 2) {
        const skipMsg = `${symbol} ${tf} already up to date (${stepIndex + 1}/${totalSteps})`;
        _progress = { ...(_progress!), status: "skipped", message: skipMsg };
        console.log(`[historicalDownloader] ${skipMsg}`);
        writeToFileLog({ timestamp: Date.now(), type: "HIST_DOWNLOAD", severity: "info", title: `SKIP ${skipMsg}`, symbol }).catch(() => {});
        stepIndex++;
        if (stepIndex < totalSteps) await _sleep(200);
        continue;
      }

      try {
        const candles = await _fetchWithRetry(symbol, tf, startAt, endAt);
        if (candles.length > 0) {
          storeCandlesForPair(symbol, tf, candles);
        }
        _pairsOk++;
        const okMsg = `${symbol} ${tf}: +${candles.length} candles stored (${stepIndex + 1}/${totalSteps})`;
        _progress = { ...(_progress!), status: "ok", message: okMsg, newCandles: candles.length };
        console.log(`[historicalDownloader] ${okMsg}`);
        writeToFileLog({
          timestamp: Date.now(), type: "HIST_DOWNLOAD", severity: "info",
          title: okMsg, symbol,
          detail: `tf=${tf} startAt=${new Date(startAt * 1000).toISOString().slice(0, 10)} endAt=${new Date(endAt * 1000).toISOString().slice(0, 10)}`,
        }).catch(() => {});
      } catch (e) {
        _pairsErr++;
        const errMsg = `${symbol} ${tf}: ${String(e).slice(0, 100)}`;
        _progress = { ...(_progress!), status: "error", message: errMsg };
        console.error(`[historicalDownloader] ${symbol} ${tf} failed:`, e);
        writeToFileLog({
          timestamp: Date.now(), type: "HIST_DOWNLOAD", severity: "error",
          title: `FAILED ${errMsg}`, symbol,
        }).catch(() => {});
      }

      stepIndex++;
      if (stepIndex < totalSteps) await _sleep(PAIR_DELAY_MS);
    }
  }

  _progress = null;
  const elapsed = ((Date.now() - (_startedAt ?? Date.now())) / 1000).toFixed(0);
  const doneMsg = `${mode} download complete — ok=${_pairsOk} err=${_pairsErr} elapsed=${elapsed}s`;
  console.log(`[historicalDownloader] ${doneMsg}`);
  writeToFileLog({ timestamp: Date.now(), type: "HIST_DOWNLOAD", severity: _pairsErr > 0 ? "warning" : "success", title: doneMsg }).catch(() => {});
}

async function _fetchWithRetry(
  symbol: string,
  tf:     string,
  startAt: number,
  endAt:   number,
): Promise<import("./kucoinPublic").KuCoinCandle[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) await _sleep(RETRY_BASE_MS * attempt);
      return await getCandlesPaged(symbol, tf, startAt, endAt);
    } catch (e) {
      lastErr = e;
      console.warn(
        `[historicalDownloader] ${symbol} ${tf} attempt ${attempt + 1}/${MAX_RETRIES} failed: ${String(e).slice(0, 80)}`
      );
    }
  }
  throw lastErr;
}

function _sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
