/**
 * GET  /api/config  — returns stored API keys
 * POST /api/config  — saves API keys to data/api-config.json
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { reloadCredentials } from "@/lib/kucoinExec";

export const dynamic = "force-dynamic";

const CONFIG_PATH = path.join(process.cwd(), "data", "api-config.json");

interface ApiConfig {
  apiKey:        string;
  apiSecret:     string;
  apiPassphrase: string;
  sandboxMode:   boolean;
}

async function readConfig(): Promise<ApiConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as ApiConfig;
  } catch {
    return { apiKey: "", apiSecret: "", apiPassphrase: "", sandboxMode: false };
  }
}

export async function GET() {
  const cfg = await readConfig();
  return NextResponse.json({
    configured:    !!(cfg.apiKey && cfg.apiSecret && cfg.apiPassphrase),
    sandboxMode:   cfg.sandboxMode,
    apiKey:        cfg.apiKey,
    apiSecret:     cfg.apiSecret,
    apiPassphrase: cfg.apiPassphrase,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body     = await req.json() as Partial<ApiConfig>;
    const existing = await readConfig();

    const merged: ApiConfig = {
      apiKey:        body.apiKey?.trim()        || existing.apiKey,
      apiSecret:     body.apiSecret?.trim()     || existing.apiSecret,
      apiPassphrase: body.apiPassphrase?.trim() || existing.apiPassphrase,
      sandboxMode:   body.sandboxMode ?? existing.sandboxMode,
    };

    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");

    await reloadCredentials();

    return NextResponse.json({
      ok:         true,
      configured: !!(merged.apiKey && merged.apiSecret && merged.apiPassphrase),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
