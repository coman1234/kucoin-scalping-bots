import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const BOT_CONFIG_PIPELINE = path.join(process.cwd(), "data", "botConfig-pipeline.json");

export async function GET() {
  try {
    const raw = await fs.readFile(BOT_CONFIG_PIPELINE, "utf-8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json(null);
  }
}
