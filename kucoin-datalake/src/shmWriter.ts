import * as fs from "fs";
import * as path from "path";
import { SHM_DATALAKE } from "./config";
import type { OptimizerStatus, BestParams, RegimeSnapshot } from "./types";

// ─── Directory paths ──────────────────────────────────────────────────────────

const PARAMS_DIR   = path.join(SHM_DATALAKE, "params");
const REGIME_DIR   = path.join(SHM_DATALAKE, "regime");
const STATUS_FILE  = path.join(SHM_DATALAKE, "optimizer-status.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Atomic write: write to a .tmp file then rename over the target.
 * Prevents consumers from reading a partially-written file.
 */
function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, filePath);
}

function safeReadJSON<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Create SHM directory tree. Call once at startup. */
export function ensureDirs(): void {
  for (const dir of [SHM_DATALAKE, PARAMS_DIR, REGIME_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Optimizer status ──────────────────────────────────────────────────────────

export function writeOptimizerStatus(status: OptimizerStatus): void {
  atomicWrite(STATUS_FILE, status);
}

export function readOptimizerStatus(): OptimizerStatus | null {
  return safeReadJSON<OptimizerStatus>(STATUS_FILE);
}

// ── Best params ───────────────────────────────────────────────────────────────

export function writeBestParams(p: BestParams): void {
  const safe = p.symbol.replace("/", "-");
  atomicWrite(path.join(PARAMS_DIR, `${safe}.json`), p);
}

export function readBestParams(symbol: string): BestParams | null {
  const safe = symbol.replace("/", "-");
  return safeReadJSON<BestParams>(path.join(PARAMS_DIR, `${safe}.json`));
}

export function readAllBestParams(): BestParams[] {
  try {
    if (!fs.existsSync(PARAMS_DIR)) return [];
    return fs
      .readdirSync(PARAMS_DIR)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map((f) => safeReadJSON<BestParams>(path.join(PARAMS_DIR, f)))
      .filter((x): x is BestParams => x !== null);
  } catch {
    return [];
  }
}

// ── Regime snapshots ──────────────────────────────────────────────────────────

export function writeRegimeSnapshot(r: RegimeSnapshot): void {
  const safe = r.symbol.replace("/", "-");
  atomicWrite(path.join(REGIME_DIR, `${safe}.json`), r);
}

export function readRegime(symbol: string): RegimeSnapshot | null {
  const safe = symbol.replace("/", "-");
  return safeReadJSON<RegimeSnapshot>(path.join(REGIME_DIR, `${safe}.json`));
}

export function readAllRegimes(): RegimeSnapshot[] {
  try {
    if (!fs.existsSync(REGIME_DIR)) return [];
    return fs
      .readdirSync(REGIME_DIR)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map((f) => safeReadJSON<RegimeSnapshot>(path.join(REGIME_DIR, f)))
      .filter((x): x is RegimeSnapshot => x !== null);
  } catch {
    return [];
  }
}
