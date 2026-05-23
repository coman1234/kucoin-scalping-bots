import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  eslint:     { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  env: {
    NEXT_PUBLIC_BUILD_TIME:  new Date().toISOString(),
    NEXT_PUBLIC_APP_NAME:    "Day Trader · v7",
    KUCOIN_HISTORY_DIR:      "/usr/local/bin/scalping-bot6/data/history",
  },
};

export default nextConfig;
