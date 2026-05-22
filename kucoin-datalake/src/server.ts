import express, { Request, Response } from "express";
import { HTTP_PORT, VERSION } from "./config";
import { LearningDB } from "./learningDB";
import {
  readOptimizerStatus,
  readBestParams,
  readAllBestParams,
  readRegime,
  readAllRegimes,
} from "./shmWriter";
import { getStatus, runNow } from "./optimizer";
import type { DatalakeHealth, RegimeLabel } from "./types";

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const startTime = Date.now();

// ─── Shared DB instance (read-only queries only) ──────────────────────────────

let db: LearningDB;

function getDB(): LearningDB {
  if (!db) db = new LearningDB();
  return db;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** GET /health */
app.get("/health", (_req: Request, res: Response) => {
  const dbStats = getDB().getStats();
  const params = readAllBestParams();

  const health: DatalakeHealth = {
    status:       "ok",
    historySymbols: params.length,
    oldestDataAt: 0,
    newestDataAt: Date.now(),
    dbSizeBytes:  dbStats.dbSizeBytes,
    shmWritable:  true,
    lastOptimizerRun: readOptimizerStatus()?.startedAt ?? 0,
    uptime:       Date.now() - startTime,
  };

  // Check if SHM is writable
  try {
    const fs = require("fs") as typeof import("fs");
    const { SHM_DATALAKE } = require("./config") as { SHM_DATALAKE: string };
    fs.accessSync(SHM_DATALAKE, fs.constants.W_OK);
  } catch {
    health.shmWritable = false;
    health.status = "degraded";
  }

  res.json(health);
});

/** GET /status */
app.get("/status", (_req: Request, res: Response) => {
  const status = readOptimizerStatus() ?? getStatus();
  res.json(status);
});

/** GET /params/:symbol */
app.get("/params/:symbol", (req: Request, res: Response) => {
  const p = readBestParams(req.params.symbol);
  if (!p) return res.status(404).json({ error: "No params for symbol" });
  return res.json(p);
});

/** GET /params */
app.get("/params", (_req: Request, res: Response) => {
  res.json(readAllBestParams());
});

/** GET /regime/:symbol */
app.get("/regime/:symbol", (req: Request, res: Response) => {
  const r = readRegime(req.params.symbol);
  if (!r) return res.status(404).json({ error: "No regime data for symbol" });
  return res.json(r);
});

/** GET /regime */
app.get("/regime", (_req: Request, res: Response) => {
  res.json(readAllRegimes());
});

/** GET /learning/:symbol — last 100 records */
app.get("/learning/:symbol", (req: Request, res: Response) => {
  const records = getDB().getRecentRecords(req.params.symbol, 100);
  res.json(records);
});

/** GET /learning/ucb/:symbol/:regime — UCB1 scores */
app.get("/learning/ucb/:symbol/:regime", (req: Request, res: Response) => {
  const { symbol, regime } = req.params;
  const scores = getDB().getUCBScores(symbol, regime as RegimeLabel, 0);
  res.json(scores);
});

/** POST /optimizer/start — trigger a run (non-blocking) */
app.post("/optimizer/start", (_req: Request, res: Response) => {
  runNow().catch((e) => console.error("[server] /optimizer/start error:", e));
  res.json({ ok: true, message: "Optimization run triggered" });
});

/** GET /runs — last 20 optimization runs */
app.get("/runs", (_req: Request, res: Response) => {
  const runs = getDB().getRecentRuns(20);
  res.json(runs);
});

// ─── 404 handler ──────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

export function startServer(): void {
  app.listen(HTTP_PORT, () => {
    console.log(`[server] kucoin-datalake v${VERSION} listening on port ${HTTP_PORT}`);
  });
}
