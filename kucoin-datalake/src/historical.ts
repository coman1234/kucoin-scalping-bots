import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import {
  KUCOIN_BASE_URL,
  HISTORY_DIR,
  DOWNLOAD_DAYS,
} from "./config";
import type { KuCoinCandle, HistoricalFile, Timeframe } from "./types";

// ── KuCoin candle row format (raw API response) ───────────────────────────────
// Each row: ["time","open","close","high","low","volume","turnover"]  (all strings, time in seconds)
type RawRow = [string, string, string, string, string, string, string];

function parseRow(row: RawRow): KuCoinCandle {
  return {
    time:     parseInt(row[0], 10),
    open:     parseFloat(row[1]),
    close:    parseFloat(row[2]),
    high:     parseFloat(row[3]),
    low:      parseFloat(row[4]),
    volume:   parseFloat(row[5]),
    turnover: parseFloat(row[6]),
  };
}

function historyPath(symbol: string, timeframe: string): string {
  const safe = symbol.replace("/", "-");
  return path.join(HISTORY_DIR, `${safe}_${timeframe}.json`);
}

function ensureHistoryDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

// ── Load candles from disk ────────────────────────────────────────────────────
export function loadCandles(symbol: string, timeframe: string): KuCoinCandle[] | null {
  const p = historyPath(symbol, timeframe);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const file: HistoricalFile = JSON.parse(raw);
    return file.candles ?? null;
  } catch (err) {
    console.error(`[historical] Failed to load ${p}:`, err);
    return null;
  }
}

function saveCandles(symbol: string, timeframe: string, candles: KuCoinCandle[]): void {
  ensureHistoryDir();
  const file: HistoricalFile = {
    symbol,
    timeframe: timeframe as Timeframe,
    fetchedAt: Math.floor(Date.now() / 1000),
    candles,
  };
  const p = historyPath(symbol, timeframe);
  fs.writeFileSync(p, JSON.stringify(file), "utf8");
}

// ── Fetch a single page of candles from KuCoin ───────────────────────────────
async function fetchPage(
  symbol: string,
  timeframe: string,
  startAt: number,
  endAt: number
): Promise<KuCoinCandle[]> {
  const url = `${KUCOIN_BASE_URL}/api/v1/market/candles`;
  const params = { symbol, type: timeframe, startAt, endAt };

  const resp = await axios.get<{ code: string; data: RawRow[] }>(url, {
    params,
    timeout: 10_000,
  });

  if (resp.data.code !== "200000") {
    throw new Error(`KuCoin API error: code=${resp.data.code}`);
  }

  const rows: RawRow[] = resp.data.data ?? [];
  return rows.map(parseRow);
}

// ── Download all history for one symbol + timeframe ───────────────────────────
export async function downloadSymbol(symbol: string, timeframe: string): Promise<void> {
  console.log(`[historical] Downloading ${symbol} ${timeframe}...`);

  const nowSec      = Math.floor(Date.now() / 1000);
  const startTarget = nowSec - DOWNLOAD_DAYS * 86400;

  // Collect all fetched candles (will merge with existing)
  const fetched: KuCoinCandle[] = [];
  let endAt  = nowSec;
  let pages  = 0;
  const MAX_PAGES = 400; // safety cap: 400 * 1500 candles = 600 000 rows

  while (endAt > startTarget && pages < MAX_PAGES) {
    try {
      const page = await fetchPage(symbol, timeframe, startTarget, endAt);

      if (page.length === 0) break;

      fetched.push(...page);

      // KuCoin returns newest → oldest; oldest candle in this page sets our new ceiling
      const oldest = Math.min(...page.map((c) => c.time));
      endAt = oldest - 1;   // paginate backward

      pages++;
      await new Promise<void>((r) => setTimeout(r, 100)); // rate-limit: 100 ms
    } catch (err) {
      console.error(`[historical] Error fetching ${symbol} ${timeframe} page ${pages}:`, err);
      break; // never crash the service
    }
  }

  if (fetched.length === 0) {
    console.warn(`[historical] No candles fetched for ${symbol} ${timeframe}`);
    return;
  }

  // ── Merge with existing candles (deduplicate by time) ─────────────────────
  const existing = loadCandles(symbol, timeframe) ?? [];
  const byTime = new Map<number, KuCoinCandle>();

  for (const c of existing) byTime.set(c.time, c);
  for (const c of fetched)  byTime.set(c.time, c);   // fetched wins on conflict

  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);

  saveCandles(symbol, timeframe, merged);
  console.log(
    `[historical] ${symbol} ${timeframe}: ${merged.length} candles saved ` +
    `(fetched ${fetched.length} new, ${pages} pages)`
  );
}

// ── Download all symbols × timeframes ────────────────────────────────────────
export async function downloadAll(
  pairs: string[],
  timeframes: string[]
): Promise<void> {
  console.log(
    `[historical] Starting full download: ${pairs.length} pairs × ${timeframes.length} timeframes`
  );

  for (const symbol of pairs) {
    for (const tf of timeframes) {
      try {
        await downloadSymbol(symbol, tf);
      } catch (err) {
        // Never crash the service; just log and move on
        console.error(`[historical] Unhandled error for ${symbol} ${tf}:`, err);
      }
      // Polite pause between symbols
      await new Promise<void>((r) => setTimeout(r, 200));
    }
  }

  console.log("[historical] Full download complete.");
}

// ── Interval downloader loop ──────────────────────────────────────────────────

let _downloadHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background download loop.
 * Runs one full download immediately, then repeats on DOWNLOAD_INTERVAL.
 * Imported by index.ts.
 */
export async function startDownloader(): Promise<void> {
  const {
    WATCH_PAIRS,
    DOWNLOAD_TIMEFRAMES,
    DOWNLOAD_INTERVAL,
  } = await import("./config");

  const runDownload = () =>
    downloadAll(WATCH_PAIRS, DOWNLOAD_TIMEFRAMES).catch((e) =>
      console.error("[historical] Download cycle error:", e)
    );

  // First run — await so the optimizer has data before it starts
  await runDownload();

  _downloadHandle = setInterval(runDownload, DOWNLOAD_INTERVAL);
  console.log(
    `[historical] Download loop scheduled every ${DOWNLOAD_INTERVAL / 1000 / 60} min`
  );
}
