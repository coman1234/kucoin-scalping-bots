import { NextRequest, NextResponse } from 'next/server';
import { getEngineInstance } from '@/lib/engineSingleton';
import type { EngineConfig } from '@/lib/tradingEngine';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const engine = getEngineInstance();

    const patch: Partial<EngineConfig> = {};
    if (body.symbol) patch.symbol = body.symbol;
    if (body.interval) patch.interval = body.interval;
    if (body.paperMode !== undefined) patch.paperMode = body.paperMode;
    if (body.signalThreshold) patch.signalThreshold = Number(body.signalThreshold);

    if (Object.keys(patch).length > 0) engine.updateConfig(patch);

    await engine.start();
    return NextResponse.json({ ok: true, status: engine.getStatus() });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
