import * as fs from "fs";
import { DATA_ROOT, HISTORY_DIR, RUNS_DIR } from "./config";
import { ensureDirs } from "./shmWriter";
import { startServer } from "./server";
import { startDownloader } from "./historical";
import { startOptimizer } from "./optimizer";

async function main(): Promise<void> {
  // ── Create required directories ────────────────────────────────────────────
  for (const d of [DATA_ROOT, HISTORY_DIR, RUNS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // ── Create SHM directories ─────────────────────────────────────────────────
  ensureDirs();

  // ── Start HTTP API server ──────────────────────────────────────────────────
  startServer();

  // ── Start historical data downloader (awaits first download cycle) ─────────
  await startDownloader();

  // ── Start optimizer loop ───────────────────────────────────────────────────
  startOptimizer();

  console.log("[kucoin-datalake] All services started.");
}

main().catch((e) => {
  console.error("[kucoin-datalake] Fatal startup error:", e);
  process.exit(1);
});
