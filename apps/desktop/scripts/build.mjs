// Bundles the main process, preload and daemon into dist/, so the packaged app
// needs no node_modules. The daemon's Antigravity runner ships next to it.
import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  external: ["electron", "bufferutil", "utf-8-validate"],
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
  external: ["bufferutil", "utf-8-validate", "node-datachannel", "node-pty"],
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

// Copied fresh, so a runner the daemon no longer ships (agy_cli.py) doesn't stay in the package
rmSync(join(root, "assets"), { recursive: true, force: true });
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
// node-pty (the web app's terminal): just this platform's prebuilt binaries. npm unpacks the macOS
// spawn-helper without its execute bit and every spawn then fails, so it's set here (the installed app may be
// read-only). Optional: without it the daemon doesn't offer terminals.
const pty = packageDir("node-pty");
if (pty) {
  const target = join(dist, "node_modules", "node-pty");
  const plat = `${process.platform}-${process.arch}`;
  cpSync(pty, target, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = src.slice(pty.length).replace(/\\/g, "/");
      if (rel.startsWith("/prebuilds/")) return rel === "/prebuilds" || rel.startsWith(`/prebuilds/${plat}`);
      return !/^\/(src|deps|scripts|third_party|typings)(\/|$)/.test(rel);
    },
  });
  const helper = join(target, "prebuilds", plat, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
cpSync(join(root, "static"), join(dist, "static"), { recursive: true });
// 单机模式 (src/local-server.ts): the same compose files as the enterprise deployment
rmSync(join(dist, "local-server"), { recursive: true, force: true });
mkdirSync(join(dist, "local-server"), { recursive: true });
// (the template without its leading dot: packaging may leave dotfiles out)
for (const [from, to] of [["docker-compose.yml"], ["Caddyfile"], [".env.example", "env.example"], ["personal.env"]]) {
  cpSync(join(root, "../../deploy/enterprise", from), join(dist, "local-server", to ?? from));
}

// 内置单机三合一包 (dist-embedded -> electron-builder extraResources/embedded):
// 1) @memento/server + @node-rs/jieba
// 2) apps/web Next.js standalone (server.js + static + public)
// 3) 内嵌 PostgreSQL 16 (+ 预装 pgvector，已去重动态库)
const embeddedOut = join(root, "dist-embedded");
rmSync(embeddedOut, { recursive: true, force: true });
mkdirSync(embeddedOut, { recursive: true });

const serverSrc = join(root, "../../packages/server/dist");
const serverOut = join(embeddedOut, "server");
if (existsSync(join(serverSrc, "main.mjs"))) {
  mkdirSync(serverOut, { recursive: true });
  for (const f of ["main.mjs", "migrate.mjs", "schema.sql"]) {
    if (existsSync(join(serverSrc, f))) cpSync(join(serverSrc, f), join(serverOut, f));
  }
  const jiebaRoot = join(root, "../../node_modules/@node-rs");
  if (existsSync(jiebaRoot)) {
    cpSync(jiebaRoot, join(serverOut, "node_modules/@node-rs"), { recursive: true, dereference: true });
  }
}

const webStandaloneSrc = join(root, "../../apps/web/.next/standalone");
const webStaticSrc = join(root, "../../apps/web/.next/static");
const webPublicSrc = join(root, "../../apps/web/public");
const webOut = join(embeddedOut, "web");
if (existsSync(join(webStandaloneSrc, "apps/web/server.js"))) {
  cpSync(webStandaloneSrc, webOut, {
    recursive: true,
    dereference: true,
    filter: (src) => !src.replace(/\\/g, "/").includes("/.next/cache"),
  });
  if (existsSync(webStaticSrc)) {
    cpSync(webStaticSrc, join(webOut, "apps/web/.next/static"), { recursive: true, dereference: true });
  }
  if (existsSync(webPublicSrc)) {
    cpSync(webPublicSrc, join(webOut, "apps/web/public"), { recursive: true, dereference: true });
  }
}

const plat = `${process.platform}-${process.arch}`;
const pgPlat = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const stagedPgSrc = join(root, "../../packages/server/embedded/staged", plat, "native");
const fallbackPgSrc = join(root, "../../node_modules", `@embedded-postgres/${pgPlat}`, "native");
const embPgSrc = existsSync(stagedPgSrc) ? stagedPgSrc : fallbackPgSrc;
if (existsSync(embPgSrc)) {
  // Preserve deduplicated shared-library relative symlinks verbatim on POSIX
  // (without verbatimSymlinks: true, Node cpSync rewrites relative links to absolute build-runner paths!)
  const embPgDst = join(embeddedOut, "embedded-pg/native");
  cpSync(embPgSrc, embPgDst, { recursive: true, dereference: false, verbatimSymlinks: true });
  if (process.platform !== "win32") {
    const checkSymlinks = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
          const target = readlinkSync(full);
          if (isAbsolute(target)) {
            throw new Error(`build.mjs: 禁止绝对路径软链进入安装包：${full} -> ${target}`);
          }
          if (!existsSync(resolve(dirname(full), target))) {
            throw new Error(`build.mjs: 发现悬空软链：${full} -> ${target}`);
          }
        } else if (st.isDirectory()) {
          checkSymlinks(full);
        }
      }
    };
    checkSymlinks(embPgDst);
  }
}
const pgvSrc = join(root, "../../packages/server/embedded/out", plat);
const alreadyPreinstalled =
  existsSync(join(embeddedOut, "embedded-pg/native/share/postgresql/extension/vector.control")) ||
  existsSync(join(embeddedOut, "embedded-pg/native/share/extension/vector.control"));
if (!alreadyPreinstalled && existsSync(join(pgvSrc, "lib"))) {
  cpSync(pgvSrc, join(embeddedOut, "pgvector"), { recursive: true, dereference: true });
}

if (process.env.MEMENTO_BUNDLE_EMBEDDED === "1") {
  const pgCtl = process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl";
  const missing = [];
  if (!existsSync(join(embeddedOut, "server/main.mjs"))) missing.push("dist-embedded/server/main.mjs");
  if (!existsSync(join(embeddedOut, "web/apps/web/server.js"))) missing.push("dist-embedded/web/apps/web/server.js");
  if (!existsSync(join(embeddedOut, "embedded-pg/native/bin", pgCtl))) missing.push(`dist-embedded/embedded-pg/native/bin/${pgCtl}`);
  if (process.platform === "win32" && !existsSync(join(embeddedOut, "embedded-pg/native/bin/cmd-noautorun.exe"))) {
    missing.push("dist-embedded/embedded-pg/native/bin/cmd-noautorun.exe");
  }
  const hasVecExt =
    existsSync(join(embeddedOut, "embedded-pg/native/share/postgresql/extension/vector.control")) ||
    existsSync(join(embeddedOut, "embedded-pg/native/share/extension/vector.control"));
  if (!hasVecExt) missing.push("pgvector extension (vector.control)");
  if (missing.length) {
    throw new Error(`MEMENTO_BUNDLE_EMBEDDED=1 要求完整单机产物，缺失：${missing.join(", ")}`);
  }
}
