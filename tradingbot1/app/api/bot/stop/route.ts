import { NextResponse } from 'next/server';
import { getEngineInstance } from '@/lib/engineSingleton';

export async function POST() {
  try {
    const engine = getEngineInstance();
    engine.stop();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
