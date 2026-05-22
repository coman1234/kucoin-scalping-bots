/**
 * KuCoin Data Producer — entry point
 *
 * Starts three concurrent async loops and a heartbeat.
 * Handles SIGTERM/SIGINT gracefully (in-flight requests complete, then exits).
 *
 * Usage:
 *   npm run dev       — tsx watch (auto-restart on changes)
 *   npm start         — node dist/index.js  (production)
 */

import { SHM_ROOT } from "./config.js";
import { ensureDirs } from "./writer.js";
import { setShmRoot, startHeartbeat, tickerLoop, orderbookLoop, candleLoop } from "./producer.js";

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log(`[producer] KuCoin Data Producer v1.0.0  pid=${process.pid}`);
console.log(`[producer] SHM root: ${SHM_ROOT}`);

ensureDirs();
setShmRoot(SHM_ROOT);
startHeartbeat();

// ── Launch all loops concurrently ─────────────────────────────────────────────
// Each loop runs independently — an exception inside one does NOT kill the
// others. The outer catch logs and crashes loudly (PM2 will auto-restart).

async function main(): Promise<void> {
  console.log("[producer] Starting ticker / orderbook / candle loops …");

  const results = await Promise.allSettled([
    tickerLoop(),
    orderbookLoop(),
    candleLoop(),
  ]);

  // If we reach here, at least one loop threw and was not caught internally.
  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[producer] Loop crashed:", r.reason);
    }
  }
  process.exit(1);   // PM2 will restart
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let shutdownRequested = false;

function shutdown(signal: string): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log(`\n[producer] Received ${signal} — shutting down gracefully …`);
  // Loops check for shutdown flag via the global; we just allow current
  // in-flight fetches to complete then exit on the next iteration.
  setTimeout(() => {
    console.log("[producer] Clean exit.");
    process.exit(0);
  }, 3_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

process.on("uncaughtException",  err => { console.error("[producer] Uncaught:", err); process.exit(1); });
process.on("unhandledRejection", err => { console.error("[producer] Unhandled:", err); process.exit(1); });

main().catch(err => { console.error("[producer] Fatal:", err); process.exit(1); });
