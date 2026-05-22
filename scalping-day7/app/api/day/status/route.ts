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

interface RegimeFile {
  regime?: string;
  confidence?: number;
  updatedAt?: number;
}

interface ParamsFile {
  profitFactor?: number;
  winRate?: number;
  totalTrades?: number;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

interface PairResult {
  symbol: string;
  regime: string;
  bestPF: number;
  confidence: number;
  params: Record<string, unknown> | null;
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
  const pairs: PairResult[] = PAIRS.map((sym) => {
    const regimeData = readJson<RegimeFile>(
      shmPath(`datalake/regime/${sym}.json`)
    );
    const paramsData = readJson<ParamsFile>(
      shmPath(`datalake/params/${sym}.json`)
    );

    const regime = regimeData?.regime ?? "unknown";
    const confidence = regimeData?.confidence ?? 0;

    // params may be nested under a .params key or at the top level
    const rawParams: Record<string, unknown> | null =
      paramsData?.params ??
      (paramsData && typeof paramsData === "object"
        ? (paramsData as Record<string, unknown>)
        : null);

    // strip metadata keys so UI only shows trading params
    const params: Record<string, unknown> | null = rawParams
      ? Object.fromEntries(
          Object.entries(rawParams).filter(
            ([k]) =>
              !["profitFactor", "winRate", "totalTrades", "symbol"].includes(k)
          )
        )
      : null;

    return {
      symbol: sym,
      regime,
      bestPF: paramsData?.profitFactor ?? 0,
      confidence,
      params,
    };
  });

  return NextResponse.json(
    { pairs, timestamp: Date.now() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
