import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function shmBase(subdir: string): string {
  if (process.platform === "linux") {
    try { fs.accessSync("/dev/shm", fs.constants.R_OK); return path.join("/dev/shm", subdir); }
    catch { /* fall through */ }
  }
  return path.join(os.tmpdir(), subdir);
}

export const SHM_KUCOIN = shmBase("kucoin-data");
export const SHM_LAKE   = shmBase("datalake");

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; }
  catch { return null; }
}

// Types
export interface CandleEntry { time: number; open: number; high: number; low: number; close: number; volume: number; turnover: number; }
export interface CandleFile { symbol: string; timeframe: string; fetchedAt: number; candles: CandleEntry[]; }
export interface TickerEntry { symbol: string; price: number; bestBid: number; bestAsk: number; changeRate: number; vol: number; volValue: number; }
export interface TickerFile { fetchedAt: number; tickers: Record<string, TickerEntry>; }
export interface BestParams { symbol: string; params: Record<string, unknown>; metrics: { winRate: number; profitFactor: number; expectancy: number; trades: number; regime: string }; confidence: number; updatedAt: number; optimizationRun: number; regime: string; }
export interface RegimeSnapshot { symbol: string; regime: string; adx: number; atrPct: number; bbBandwidth: number; updatedAt: number; }
export interface OptimizerStatus { running: boolean; runId: number; pairsDone: number; pairsTotal: number; currentPair: string; nextRunAt: number; lastRunDurationMs: number; totalOptimizations: number; }
export interface ProducerMeta { pid: number; heartbeatAt: number; cycleCount: number; errorCount: number; }

export function readCandles(symbol: string, timeframe: string): CandleFile | null {
  return readJson<CandleFile>(path.join(SHM_KUCOIN, "candles", `${symbol}_${timeframe}.json`));
}
export function readTicker(symbol: string): TickerEntry | null {
  const f = readJson<TickerFile>(path.join(SHM_KUCOIN, "ticker", "all.json"));
  return f?.tickers[symbol] ?? null;
}
export function readAllTickers(): TickerFile | null {
  return readJson<TickerFile>(path.join(SHM_KUCOIN, "ticker", "all.json"));
}
export function readBestParams(symbol: string): BestParams | null {
  return readJson<BestParams>(path.join(SHM_LAKE, "params", `${symbol}.json`));
}
export function readAllBestParams(): BestParams[] {
  try {
    return fs.readdirSync(path.join(SHM_LAKE, "params"))
      .filter(f => f.endsWith(".json"))
      .map(f => readJson<BestParams>(path.join(SHM_LAKE, "params", f)))
      .filter((x): x is BestParams => x !== null);
  } catch { return []; }
}
export function readRegime(symbol: string): RegimeSnapshot | null {
  return readJson<RegimeSnapshot>(path.join(SHM_LAKE, "regime", `${symbol}.json`));
}
export function readOptimizerStatus(): OptimizerStatus | null {
  return readJson<OptimizerStatus>(path.join(SHM_LAKE, "optimizer-status.json"));
}
export function readProducerMeta(): ProducerMeta | null {
  return readJson<ProducerMeta>(path.join(SHM_KUCOIN, "meta.json"));
}
export function isProducerAlive(): boolean {
  const m = readProducerMeta();
  return !!m && Date.now() - m.heartbeatAt < 15_000;
}
