import { NextResponse } from 'next/server';
import { getEngineInstance } from '@/lib/engineSingleton';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const engine = getEngineInstance();
    return NextResponse.json(engine.getStatus());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
