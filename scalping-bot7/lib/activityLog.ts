/**
 * Client-side activity logging helper.
 * Fire-and-forget POST to the server-side JSON log.
 * Imports the types from the API route to keep a single source of truth.
 */

export type ActivityType =
  | "BOT_START" | "BOT_STOP" | "EMERGENCY_STOP"
  | "TRADE_OPEN" | "TRADE_CLOSE" | "TRADE_TP1"
  | "SIGNAL"
  | "BACKTEST" | "BATCH_SCAN" | "OPTIMIZER"
  | "SETTINGS" | "CONNECTION"
  | "WARNING" | "ERROR" | "SYSTEM";

export type ActivitySeverity = "info" | "success" | "warning" | "error";

export interface ActivityEntry {
  id:        string;
  timestamp: number;
  type:      ActivityType;
  severity:  ActivitySeverity;
  title:     string;
  detail?:   string;
  symbol?:   string;
  value?:    number;
}

export type NewActivityEntry = Omit<ActivityEntry, "id" | "timestamp">;

/**
 * Append an activity entry to the server-side log.
 * Non-blocking — errors are silently swallowed so the caller never stalls.
 */
export function logActivity(entry: NewActivityEntry): void {
  fetch("/api/trading/activity-log", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(entry),
  }).catch(() => {/* intentionally silent */});
}

/** Fetch recent log entries (newest first). */
export async function fetchActivityLog(limit = 200): Promise<ActivityEntry[]> {
  try {
    const res  = await fetch(`/api/trading/activity-log?limit=${limit}`);
    const data = await res.json() as { entries: ActivityEntry[] };
    return data.entries ?? [];
  } catch {
    return [];
  }
}

/** Clear the entire log. */
export async function clearActivityLog(): Promise<void> {
  await fetch("/api/trading/activity-log", { method: "DELETE" }).catch(() => {});
}
