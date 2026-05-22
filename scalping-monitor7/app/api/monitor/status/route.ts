import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

interface ProducerMeta {
  startedAt?: number;
  lastTickAt?: number;
  pairsConnected?: number;
  tickCount?: number;
}

// ── Pairs ─────────────────────────────────────────────────────────────────────

const PAIRS = [
  "BTC-USDT", "ETH-USDT", "SOL-USDT", "BNB-USDT", "DOGE-USDT",
  "XRP-USDT", "ADA-USDT", "AVAX-USDT", "POL-USDT", "DOT-USDT",
  "LINK-USDT", "UNI-USDT", "ATOM-USDT", "LTC-USDT", "BCH-USDT",
  "NEAR-USDT", "FIL-USDT", "APT-USDT", "ARB-USDT", "OP-USDT",
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
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
