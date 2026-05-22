/**
 * learningDB.ts — SQLite-backed UCB1 learning history
 * Uses Node.js built-in `node:sqlite` (available since Node 22.5+)
 * to avoid native module compilation issues.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require("node:sqlite");
import * as fs from "fs";
import { DB_PATH, UCB_C } from "./config";
import type { LearningRecord, UCBScore, RegimeLabel } from "./types";

// ─── SQL statements ───────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS learning_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT    NOT NULL,
  regime        TEXT    NOT NULL,
  params_key    TEXT    NOT NULL,
  win_rate      REAL,
  profit_factor REAL,
  expectancy    REAL,
  trades        INTEGER,
  tested_at     INTEGER,
  run_id        INTEGER,
  is_oos        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lr_symbol_regime
  ON learning_records(symbol, regime);

CREATE TABLE IF NOT EXISTS optimization_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER,
  finished_at  INTEGER,
  pairs_done   INTEGER,
  total_combos INTEGER
);
`;

// ─── LearningDB class ─────────────────────────────────────────────────────────

export class LearningDB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor() {
    const dir = DB_PATH.substring(0, Math.max(DB_PATH.lastIndexOf("/"), DB_PATH.lastIndexOf("\\")));
    if (dir) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(DB_PATH);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(DDL);
  }

  // ── Insert a learning record ────────────────────────────────────────────────

  insertRecord(r: LearningRecord): void {
    this.db.prepare(
      `INSERT INTO learning_records
         (symbol, regime, params_key, win_rate, profit_factor, expectancy,
          trades, tested_at, run_id, is_oos)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      r.symbol, r.regime, r.paramsKey, r.winRate, r.profitFactor,
      r.expectancy, r.trades, r.testedAt, r.runId, r.isOOS
    );
  }

  // ── UCB1 scores for all distinct params_key for symbol+regime ─────────────

  getUCBScores(symbol: string, regime: RegimeLabel, _totalRuns: number): UCBScore[] {
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM learning_records WHERE symbol = ? AND regime = ?`
    ).get(symbol, regime) as { cnt: number } | undefined;

    const N = totalRow?.cnt ?? 0;
    if (N === 0) return [];

    const rows = this.db.prepare(
      `SELECT params_key,
              COUNT(*)           AS n,
              AVG(profit_factor) AS avg_pf,
              SUM(profit_factor) AS sum_pf
       FROM learning_records
       WHERE symbol = ? AND regime = ?
       GROUP BY params_key`
    ).all(symbol, regime) as { params_key: string; n: number; avg_pf: number; sum_pf: number }[];

    return rows.map(row => {
      const n_i = row.n;
      const avgScore = row.avg_pf ?? 0;
      const ucbValue = n_i > 0 && N > 0
        ? avgScore + UCB_C * Math.sqrt(Math.log(N) / n_i)
        : avgScore;
      return { paramsKey: row.params_key, regime, totalTrials: n_i, totalScore: row.sum_pf ?? 0, avgScore, ucbValue };
    });
  }

  getBestParams(symbol: string, regime: RegimeLabel): UCBScore | null {
    const scores = this.getUCBScores(symbol, regime, 0);
    if (scores.length === 0) return null;
    return scores.reduce((best, s) => (s.ucbValue > best.ucbValue ? s : best));
  }

  getRecentRecords(symbol: string, limit = 100): LearningRecord[] {
    const rows = this.db.prepare(
      `SELECT id, symbol, regime, params_key, win_rate, profit_factor,
              expectancy, trades, tested_at, run_id, is_oos
       FROM learning_records WHERE symbol = ? ORDER BY id DESC LIMIT ?`
    ).all(symbol, limit) as {
      id: number; symbol: string; regime: string; params_key: string;
      win_rate: number; profit_factor: number; expectancy: number;
      trades: number; tested_at: number; run_id: number; is_oos: number;
    }[];

    return rows.map(r => ({
      id: r.id, symbol: r.symbol, regime: r.regime as RegimeLabel,
      paramsKey: r.params_key, winRate: r.win_rate, profitFactor: r.profit_factor,
      expectancy: r.expectancy, trades: r.trades, testedAt: r.tested_at,
      runId: r.run_id, isOOS: r.is_oos,
    }));
  }

  startRun(): number {
    const info = this.db.prepare(
      `INSERT INTO optimization_runs (started_at, finished_at, pairs_done, total_combos) VALUES (?, NULL, 0, 0)`
    ).run(Date.now());
    return Number(info.lastInsertRowid);
  }

  finishRun(id: number, pairsDone: number, totalCombos: number): void {
    this.db.prepare(
      `UPDATE optimization_runs SET finished_at = ?, pairs_done = ?, total_combos = ? WHERE id = ?`
    ).run(Date.now(), pairsDone, totalCombos, id);
  }

  getRecentRuns(limit = 20): { id: number; startedAt: number; finishedAt: number | null; pairsDone: number; totalCombos: number }[] {
    const rows = this.db.prepare(
      `SELECT id, started_at, finished_at, pairs_done, total_combos
       FROM optimization_runs ORDER BY id DESC LIMIT ?`
    ).all(limit) as { id: number; started_at: number; finished_at: number | null; pairs_done: number; total_combos: number }[];

    return rows.map(r => ({
      id: r.id, startedAt: r.started_at, finishedAt: r.finished_at,
      pairsDone: r.pairs_done, totalCombos: r.total_combos,
    }));
  }

  getStats(): { totalRecords: number; totalRuns: number; dbSizeBytes: number } {
    const recRow = this.db.prepare("SELECT COUNT(*) as cnt FROM learning_records").get() as { cnt: number };
    const runRow = this.db.prepare("SELECT COUNT(*) as cnt FROM optimization_runs").get() as { cnt: number };
    let dbSizeBytes = 0;
    try { dbSizeBytes = fs.statSync(DB_PATH).size; } catch { /* ignore */ }
    return { totalRecords: recRow?.cnt ?? 0, totalRuns: runRow?.cnt ?? 0, dbSizeBytes };
  }

  close(): void {
    this.db.close();
  }
}
