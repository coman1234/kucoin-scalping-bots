import { NextResponse } from "next/server";
import * as fs   from "node:fs";
import * as path from "node:path";
import * as os   from "node:os";

// ── SHM helpers ───────────────────────────────────────────────────────────────

function shmPath(sub: string): string {
  const base = process.platform === "linux" ? "/dev/shm" : os.tmpdir();
  return path.join(base, sub);
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OptimizerStatus {
  running?: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  phase?: string;
  progress?: number;
  message?: string;
}

// Matches actual meta.json written by data-producer / cacheReader.ts
interface ProducerMeta {
  pid?: number;
  version?: string;
  startedAt?: number;
  heartbeatAt?: number;
  lastTickerUpdate?: number;
  lastCandleUpdate?: number;
  lastOrderbookUpdate?: number;
  cycleCount?: number;
  errorCount?: number;
  shmRoot?: string;
}

// ── Pairs — must match WATCH_PAIRS in app/page.tsx ───────────────────────────

const PAIRS = [
  "BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","BNB-USDT",
  "DOGE-USDT","ADA-USDT","AVAX-USDT","LINK-USDT","DOT-USDT",
  "POL-USDT","UNI-USDT","LTC-USDT","ATOM-USDT","ARB-USDT",
  "NEAR-USDT","APT-USDT","OP-USDT","TRX-USDT","INJ-USDT",
];

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET() {
  const optimizerStatus = readJson<OptimizerStatus>(
    shmPath("datalake/optimizer-status.json")
  );

  const producerMeta = readJson<ProducerMeta>(
    shmPath("kucoin-data/meta.json")
  );

  const regimes: Record<string, unknown> = {};
  for (const sym of PAIRS) {
    regimes[sym] = readJson(shmPath(`datalake/regime/${sym}.json`));
  }

  return NextResponse.json(
    {
      optimizerStatus,
      producerMeta,
      regimes,
      timestamp: Date.now(),
    },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
