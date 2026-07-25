import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static resolves its executable relative to its package directory.
  // Bundling it into a server chunk rewrites __dirname to .next/server and
  // leaves the native binary behind in node_modules.
  serverExternalPackages: ["ffmpeg-static"],
};

export default nextConfig;
