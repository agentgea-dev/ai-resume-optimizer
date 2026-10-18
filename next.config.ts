import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // resvg ships a native binary that must be loaded by Node, not bundled.
  serverExternalPackages: ["@resvg/resvg-js"],
};

export default nextConfig;
