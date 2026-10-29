import path from "node:path";
import type { NextConfig } from "next";

// The repo is an npm workspace: dependencies (and @memento/core) live in the
// root node_modules, so tracing and bundling start from the repo root.
const repoRoot = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  compress: true,
  poweredByHeader: false,
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
  // The image build passes the commit (apps/web/Dockerfile); elsewhere Next picks a random id
  generateBuildId: async () => process.env.GIT_SHA || null,
  // The same id for the page itself and /build-id: open windows reload when they differ (src/lib/build-update.ts)
  env: { MEMENTO_BUILD_ID: process.env.GIT_SHA || "" },
  experimental: {
    optimizePackageImports: ["react-icons", "three", "highlight.js", "lowlight"],
  },
  async redirects() {
    return [
      {
        source: "/artifacts/deployment-guide.md",
        has: [
          {
            type: "header",
            key: "accept",
            value: "(.*text/html.*)",
          },
        ],
        destination: "/artifacts/deployment-guide.html",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
