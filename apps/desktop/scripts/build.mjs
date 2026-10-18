// Bundles the main process, preload and daemon into dist/, so the packaged app
// needs no node_modules. The daemon's Antigravity runner ships next to it.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, platform: "node", target: "node22", sourcemap: true, logLevel: "info" };

await build({
  ...common,
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(dist, "main.cjs"),
  format: "cjs",
  external: ["electron"],
  define: {
    "import.meta.url": "undefined",
  },
});

await build({
  ...common,
  entryPoints: [join(root, "src/preload.ts")],
  outfile: join(dist, "preload.cjs"),
  format: "cjs",
  external: ["electron"],
});

// ws's native speedups are optional; it falls back to JS without them.
await build({
  ...common,
  entryPoints: [join(root, "src/daemon-entry.ts")],
  outfile: join(dist, "daemon.mjs"),
  format: "esm",
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// The MCP server AI tools start (see src/mcp-entry.ts).
await build({
  ...common,
  entryPoints: [join(root, "src/mcp-entry.ts")],
  outfile: join(dist, "mcp.mjs"),
  format: "esm",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

cpSync(join(root, "../../packages/daemon/assets"), join(root, "assets"), { recursive: true });
cpSync(join(root, "static"), join(dist, "static"), { recursive: true });
