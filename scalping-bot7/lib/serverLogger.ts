/**
 * serverLogger.ts — server-side only file logger.
 *
 * Writes one human-readable line per event to:
 *   <project-root>/log/scalping-bot-YYYY-MM-DD.log   (daily rotation)
 *   e.g. /usr/local/bin/scalping-bot7/log/scalping-bot-2026-05-04.log
 *
 * Usage from any API route / server action:
 *   import { writeToFileLog } from "@/lib/serverLogger";
 *   await writeToFileLog(entry);
 *
 * Watch live in a terminal:
 *   tail -f /usr/local/bin/scalping-bot7/log/scalping-bot-$(date +%Y-%m-%d).log
 */

import { promises as fs } from "fs";
import path from "path";

// Logs go to <project-root>/log/ — i.e. /usr/local/bin/scalping-bot7/log/
export const LOG_DIR = path.join(process.cwd(), "log");

// ── Helpers ───────────────────────────────────────────────────────────────────
function p2(n: number) { return String(n).padStart(2, "0"); }

function fmtTimestamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

function dailyFileName(ms: number): string {
  const d = new Date(ms);
  return `scalping-bot-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.log`;
}

// ── Public API ────────────────────────────────────────────────────────────────
export interface FileLogEntry {
  timestamp: number;
  type:      string;
  severity:  string;
  title:     string;
  detail?:   string;
  symbol?:   string;
  value?:    number;
}

/**
 * Append one entry to ~/log/scalping-bot-YYYY-MM-DD.log.
 * Never throws — file errors are silently swallowed so the caller never stalls.
 */
export async function writeToFileLog(entry: FileLogEntry): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });

    const ts  = fmtTimestamp(entry.timestamp);
    const sev = entry.severity.toUpperCase().padEnd(7);   // "INFO   ", "SUCCESS"
    const typ = entry.type.padEnd(15);                    // "TRADE_OPEN     "
    const sym = entry.symbol ? `[${entry.symbol}] ` : "";
    const val = entry.value != null
      ? ` | ${entry.type.startsWith("TRADE") ? "pnl" : "value"}: ${entry.value}`
      : "";

    // Main line
    let line = `[${ts}] [${sev}] [${typ}] ${sym}${entry.title}${val}\n`;

    // Optional detail on indented second line
    if (entry.detail) {
      line += `                                               → ${entry.detail}\n`;
    }

    const filePath = path.join(LOG_DIR, dailyFileName(entry.timestamp));
    await fs.appendFile(filePath, line, "utf-8");
  } catch {
    // File logging must never crash the main API flow
  }
}

/**
 * Write a plain separator line — useful for "=== Session start ===" markers.
 */
export async function writeLogSeparator(label: string): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const ts   = fmtTimestamp(Date.now());
    const line = `\n[${ts}] ${"─".repeat(60)}\n[${ts}] ${label}\n[${ts}] ${"─".repeat(60)}\n\n`;
    const filePath = path.join(LOG_DIR, dailyFileName(Date.now()));
    await fs.appendFile(filePath, line, "utf-8");
  } catch { /* ignore */ }
}
