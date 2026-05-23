/**
 * GET /api/config/test — test KuCoin connection
 */
import { NextResponse } from "next/server";
import { getUsdtBalance } from "@/lib/kucoinExec";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const balance = await getUsdtBalance();
    return NextResponse.json({ ok: true, usdtBalance: balance });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) });
  }
}
