import path from "node:path";
import type { NextConfig } from "next";

// The repo is an npm workspace: dependencies (and @memento/core) live in the
// root node_modules, so tracing and bundling start from the repo root.
const repoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  compress: true,
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["react-icons", "date-fns"],
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
