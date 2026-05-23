import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.1.20", "192.168.1.*"],
  outputFileTracingRoot: path.join(__dirname),
  eslint:     { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  env: {
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
    NEXT_PUBLIC_APP_NAME:   "Monitor · v7",
  },
};

export default nextConfig;
