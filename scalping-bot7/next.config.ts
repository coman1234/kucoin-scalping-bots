import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {},
  allowedDevOrigins: ["192.168.1.20", "192.168.1.*"],
  // Pin the workspace root so Next.js doesn't get confused by other
  // package-lock.json files higher up in the filesystem hierarchy.
  outputFileTracingRoot: path.join(__dirname),
  eslint:     { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // Build-time constants — baked into the client bundle at compile time
  env: {
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
    NEXT_PUBLIC_APP_NAME:   "Bot A · v7.0",
  },
};

export default nextConfig;
