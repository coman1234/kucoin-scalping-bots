import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "api-config.json");

interface ApiConfig {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  sandboxMode: boolean;
}

async function readConfig(): Promise<ApiConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { apiKey: "", apiSecret: "", apiPassphrase: "", sandboxMode: false };
  }
}

export async function GET() {
  const cfg = await readConfig();
  // Return full credentials — this app runs on localhost only (no network exposure).
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
    const body = await req.json() as Partial<ApiConfig>;

    // Merge-guard: never overwrite an existing field with an empty string.
    // This protects against the Settings modal blanking out credentials that
    // were previously saved directly to the file.
    const existing = await readConfig();
    const merged: ApiConfig = {
      apiKey:        body.apiKey        || existing.apiKey,
      apiSecret:     body.apiSecret     || existing.apiSecret,
      apiPassphrase: body.apiPassphrase || existing.apiPassphrase,
      sandboxMode:   body.sandboxMode   ?? existing.sandboxMode,
    };

    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
