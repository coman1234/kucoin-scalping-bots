// ─── Global singleton — persists across Next.js hot-reloads ─────────────────
import { TradingEngine, EngineConfig } from './tradingEngine';

declare global {
  // eslint-disable-next-line no-var
  var _evEngine: TradingEngine | undefined;
}

export function getEngineInstance(config?: Partial<EngineConfig>): TradingEngine {
  if (!global._evEngine) {
    global._evEngine = new TradingEngine(config);
  }
  return global._evEngine;
}

export function resetEngine(): void {
  global._evEngine?.stop();
  global._evEngine = undefined;
}
