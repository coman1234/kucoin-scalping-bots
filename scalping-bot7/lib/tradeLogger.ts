import type { TradeLogEntry } from "@/app/api/trading/log/route";

export type { TradeLogEntry };

export async function logTrade(entry: TradeLogEntry): Promise<void> {
  try {
    await fetch("/api/trading/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch { /* non-critical — don't crash the bot */ }
}

export async function loadTradeLog(): Promise<TradeLogEntry[]> {
  try {
    const res  = await fetch("/api/trading/log");
    const data = await res.json();
    return data.trades ?? [];
  } catch {
    return [];
  }
}
