#!/usr/bin/env node
/**
 * Packages the zero-Docker headless standalone Memento archive for the current platform:
 *   dist-standalone/memento-standalone-<platform>.tar.gz (macOS / Linux)
 *   dist-standalone/memento-standalone-<platform>.zip    (Windows)
 *
 * Expects apps/desktop/dist-embedded/ to be built first (`MEMENTO_BUNDLE_EMBEDDED=1 npm run build -w @memento/desktop`).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const EMBEDDED = join(REPO, "apps", "desktop", "dist-embedded");
const OUT_ROOT = join(REPO, "dist-standalone");
const PLAT = `${process.platform}-${process.arch}`;
const STAGE = join(OUT_ROOT, `memento-standalone-${PLAT}`);

if (!existsSync(join(EMBEDDED, "server", "main.mjs")) || !existsSync(join(EMBEDDED, "embedded-pg", "native"))) {
  throw new Error("请先构建完整内嵌产物（node packages/server/embedded/stage-embedded.mjs && npm run build -w web && MEMENTO_BUNDLE_EMBEDDED=1 npm run build -w @memento/desktop）");
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(EMBEDDED, STAGE, { recursive: true, dereference: false, verbatimSymlinks: true });
cpSync(join(HERE, "standalone.mjs"), join(STAGE, "standalone.mjs"));

if (process.platform !== "win32") {
  const checkSymlinks = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(full);
        if (isAbsolute(target)) {
          throw new Error(`pack-standalone: 禁止绝对路径软链进入压缩包：${full} -> ${target}`);
        }
        if (!existsSync(resolve(dirname(full), target))) {
          throw new Error(`pack-standalone: 发现悬空软链：${full} -> ${target}`);
        }
      } else if (st.isDirectory()) {
        checkSymlinks(full);
      }
    }
  };
  checkSymlinks(STAGE);
}

if (process.platform === "win32") {
  writeFileSync(join(STAGE, "start.cmd"), "@echo off\r\nnode \"%~dp0standalone.mjs\" %*\r\n");
  const zipPath = join(OUT_ROOT, `memento-standalone-${PLAT}.zip`);
  rmSync(zipPath, { force: true });
  execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${STAGE}' -DestinationPath '${zipPath}'`], { stdio: "inherit" });
  console.log(`[pack-standalone] ${zipPath} (${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
} else {
  const startSh = join(STAGE, "start.sh");
  writeFileSync(startSh, "#!/usr/bin/env bash\nset -euo pipefail\ncd \"$(dirname \"$0\")\"\nexec node ./standalone.mjs \"$@\"\n");
  chmodSync(startSh, 0o755);
  const tarPath = join(OUT_ROOT, `memento-standalone-${PLAT}.tar.gz`);
  rmSync(tarPath, { force: true });
  execFileSync("tar", ["-czf", tarPath, "-C", OUT_ROOT, `memento-standalone-${PLAT}`], { stdio: "inherit" });
  console.log(`[pack-standalone] ${tarPath} (${(statSync(tarPath).size / 1024 / 1024).toFixed(1)} MB)`);
}
