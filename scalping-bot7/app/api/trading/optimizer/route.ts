import { NextRequest, NextResponse } from "next/server";

const DATALAKE_URL = process.env.DATALAKE_URL ?? "http://localhost:3010";

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") ?? "status";
  try {
    const r = await fetch(`${DATALAKE_URL}/${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json();
    return NextResponse.json(data);
  } catch {
    // Fallback: read from SHM directly
    const { readOptimizerStatus } = await import("@/lib/shmReader");
    return NextResponse.json(
      readOptimizerStatus() ?? { running: false, error: "datalake unreachable" }
    );
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  try {
    const r = await fetch(`${DATALAKE_URL}/optimizer/start`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(5000),
    });
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json({ error: "datalake unreachable" }, { status: 503 });
  }
}
