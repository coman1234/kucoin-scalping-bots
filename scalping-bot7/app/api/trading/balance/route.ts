import { NextResponse } from "next/server";
import { getTradeAccounts, credentialsConfigured } from "@/lib/kucoinPrivate";

export async function GET() {
  if (!(await credentialsConfigured())) {
    return NextResponse.json(
      { error: "API credentials not configured" },
      { status: 401 }
    );
  }

  try {
    const accounts = await getTradeAccounts();
    return NextResponse.json({ accounts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch balance" },
      { status: 500 }
    );
  }
}
