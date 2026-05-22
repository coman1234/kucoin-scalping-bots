import { parentPort } from "worker_threads";
import { runBacktest } from "./backtester";
import type { WorkerRequest, WorkerResponse } from "./types";

if (!parentPort) {
  throw new Error("optimizer.worker must be run as a worker_thread");
}

parentPort.on("message", (request: WorkerRequest) => {
  const { taskId, symbol, candles, params, oosRatio } = request;

  try {
    const { isMetrics, oosMetrics } = runBacktest(candles, params, oosRatio, symbol);

    const response: WorkerResponse = {
      taskId,
      symbol,
      params,
      isMetrics,
      oosMetrics,
    };

    parentPort!.postMessage(response);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`[worker] Error for ${symbol} task=${taskId}: ${errorMsg}`);

    // Post a minimal error response so the pool doesn't hang
    const errorResponse: WorkerResponse = {
      taskId,
      symbol,
      params,
      // Provide zero-value metrics so callers can check trades === 0
      isMetrics: {
        symbol,
        params,
        trades: 0, wins: 0,
        winRate: 0, profitFactor: 0,
        expectancy: 0, maxDrawdownPct: 0,
        totalR: 0, sharpe: 0,
        regime: "unknown",
        testedAt: Date.now(),
        candleCount: 0,
        isOOS: false,
      },
      oosMetrics: {
        symbol,
        params,
        trades: 0, wins: 0,
        winRate: 0, profitFactor: 0,
        expectancy: 0, maxDrawdownPct: 0,
        totalR: 0, sharpe: 0,
        regime: "unknown",
        testedAt: Date.now(),
        candleCount: 0,
        isOOS: true,
      },
      error: errorMsg,
    };

    parentPort!.postMessage(errorResponse);
  }
});
