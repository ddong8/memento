// Bundles the main process, preload and daemon into dist/, so the packaged app
// needs no node_modules. The daemon's Antigravity runner ships next to it.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
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
// node-datachannel (direct WebRTC transfer) is a native module, shipped as a package next to the bundle.
await build({
  ...common,
  entryPoints: [join(root, "src/daemon-entry.ts")],
  outfile: join(dist, "daemon.mjs"),
  format: "esm",
  external: ["bufferutil", "utf-8-validate", "node-datachannel"],
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

// node-datachannel with its one dependency and the prebuilt binary for the platform being built
// (release CI builds each OS on its own runner, where npm installed that platform's package).
// The daemon loads it lazily and falls back to the server relay if it's missing.
const requireFromDaemon = createRequire(join(root, "../../packages/daemon/package.json"));
function packageDir(name) {
  let dir;
  try {
    dir = dirname(requireFromDaemon.resolve(name));
  } catch {
    return null;
  }
  for (; dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return dir;
  }
  return null;
}
const ndc = packageDir("node-datachannel");
if (ndc) {
  const natives = Object.keys(JSON.parse(readFileSync(join(ndc, "package.json"), "utf8")).optionalDependencies ?? {});
  for (const name of ["node-datachannel", "detect-libc", ...natives]) {
    const dir = name === "node-datachannel" ? ndc : packageDir(name);
    if (dir) cpSync(dir, join(dist, "node_modules", name), { recursive: true, dereference: true });
  }
}
cpSync(join(root, "static"), join(dist, "static"), { recursive: true });
