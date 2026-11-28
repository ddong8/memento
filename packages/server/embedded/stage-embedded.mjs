#!/usr/bin/env node
/**
 * Stages a slim, deduplicated, pgvector-preinstalled PostgreSQL 16 runtime for the current platform:
 *   packages/server/embedded/staged/<platform>/native/
 *
 * Used by:
 *   1) Desktop single-installer build (apps/desktop/scripts/build.mjs & desktop-release.yml)
 *   2) Headless zero-Docker standalone launcher (packages/server/scripts/standalone.mjs)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMBEDDED_PG_VERSION = process.env.EMBEDDED_PG || "16.16.0-beta.19";
const PLAT = `${process.platform}-${process.arch}`;
const PG_PLAT = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const IS_WIN = process.platform === "win32";
const PG_CTL_BIN = IS_WIN ? "pg_ctl.exe" : "pg_ctl";

const CACHE_DIR = join(HERE, ".cache", PLAT);
const PGVECTOR_OUT = join(HERE, "out", PLAT);
const STAGED_DIR = join(HERE, "staged", PLAT);
const STAGED_NATIVE = join(STAGED_DIR, "native");

const KEEP_BINS = new Set([
  "postgres",
  "initdb",
  "pg_ctl",
  "pg_isready",
  "psql",
  "pg_dump",
  "pg_restore",
  "createdb",
  "dropdb",
  "pg_basebackup",
]);

const DROP_TOP_DIRS = new Set(["doc", "include", "man", "pgAdmin 4", "StackBuilder", "symbols", "installer", "scripts"]);

function dirBytes(dir) {
  let total = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) total += dirBytes(p);
    else total += st.size;
  }
  return total;
}

function ensureEmbeddedPgCache() {
  const pkgName = `@embedded-postgres/${PG_PLAT}`;
  const cachedNative = join(CACHE_DIR, "node_modules", ...pkgName.split("/"), "native");
  if (existsSync(join(cachedNative, "bin", PG_CTL_BIN))) {
    console.log(`[stage-embedded] using cached ${pkgName}@${EMBEDDED_PG_VERSION}`);
    return cachedNative;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(join(CACHE_DIR, "package.json"))) {
    writeFileSync(join(CACHE_DIR, "package.json"), JSON.stringify({ name: "memento-embedded-pg-cache", private: true }) + "\n");
  }
  console.log(`[stage-embedded] installing ${pkgName}@${EMBEDDED_PG_VERSION} ...`);
  const npmBin = IS_WIN ? "npm.cmd" : "npm";
  // Do NOT pass --ignore-scripts: @embedded-postgres/linux-* runs postinstall hydrate-symlinks.js
  execFileSync(npmBin, ["install", "--no-audit", "--no-fund", `${pkgName}@${EMBEDDED_PG_VERSION}`], {
    cwd: CACHE_DIR,
    stdio: "inherit",
    shell: IS_WIN,
  });
  if (!existsSync(join(cachedNative, "bin", PG_CTL_BIN))) {
    throw new Error(`Expected ${join(cachedNative, "bin", PG_CTL_BIN)} after installing ${pkgName}`);
  }
  return cachedNative;
}

function ensurePgvector() {
  if (existsSync(join(PGVECTOR_OUT, "lib")) && existsSync(join(PGVECTOR_OUT, "extension"))) {
    const libs = readdirSync(join(PGVECTOR_OUT, "lib"));
    const exts = readdirSync(join(PGVECTOR_OUT, "extension"));
    if (libs.length > 0 && exts.includes("vector.control")) {
      console.log(`[stage-embedded] using existing pgvector in ${PGVECTOR_OUT}`);
      return PGVECTOR_OUT;
    }
  }
  console.log(`[stage-embedded] building pgvector for ${PLAT} ...`);
  if (IS_WIN) {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "build-pgvector.ps1")], {
      cwd: HERE,
      stdio: "inherit",
    });
  } else {
    execFileSync("bash", [join(HERE, "build-pgvector.sh")], {
      cwd: HERE,
      stdio: "inherit",
    });
  }
  if (!existsSync(join(PGVECTOR_OUT, "lib")) || !existsSync(join(PGVECTOR_OUT, "extension", "vector.control"))) {
    throw new Error(`pgvector build did not produce expected outputs in ${PGVECTOR_OUT}`);
  }
  return PGVECTOR_OUT;
}

/** Deduplicate identical regular shared library copies inside a directory into relative symlinks (POSIX only). */
function deduplicateSharedLibs(libDir) {
  if (IS_WIN || !existsSync(libDir)) return 0;
  const byHash = new Map();
  let saved = 0;
  const entries = readdirSync(libDir).sort();
  for (const name of entries) {
    const full = join(libDir, name);
    const st = lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) continue;
    if (!/\.(dylib|so)(\.\d+)*$/.test(name)) continue;
    if (st.size < 65_536) continue;
    const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
    const group = byHash.get(hash) ?? [];
    group.push({ name, full, size: st.size });
    byHash.set(hash, group);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    // Keep the most specific versioned filename (longest name) as the real file; symlink shorter aliases to it
    group.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
    const canonical = group[0];
    for (let i = 1; i < group.length; i++) {
      const dup = group[i];
      unlinkSync(dup.full);
      symlinkSync(canonical.name, dup.full);
      saved += dup.size;
    }
  }
  return saved;
}

function main() {
  const cachedNative = ensureEmbeddedPgCache();
  const pgvectorDir = ensurePgvector();

  rmSync(STAGED_DIR, { recursive: true, force: true });
  mkdirSync(STAGED_NATIVE, { recursive: true });

  // Copy native tree excluding docs/headers/unused bloat
  for (const ent of readdirSync(cachedNative, { withFileTypes: true })) {
    if (DROP_TOP_DIRS.has(ent.name)) continue;
    const src = join(cachedNative, ent.name);
    const dst = join(STAGED_NATIVE, ent.name);
    if (ent.name === "bin" && ent.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      for (const binEnt of readdirSync(src, { withFileTypes: true })) {
        const base = binEnt.name.replace(/\.exe$/i, "").toLowerCase();
        const isDll = IS_WIN && /\.dll$/i.test(binEnt.name);
        if (!isDll && !KEEP_BINS.has(base)) continue;
        cpSync(join(src, binEnt.name), join(dst, binEnt.name), { recursive: true, dereference: false, verbatimSymlinks: true });
        if (!IS_WIN && !lstatSync(join(dst, binEnt.name)).isSymbolicLink()) {
          chmodSync(join(dst, binEnt.name), 0o755);
        }
      }
      continue;
    }
    cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: true });
  }

  // Remove static archives & debug symbols if any
  const pruneExtras = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "pgxs" || ent.name === "pkgconfig") {
          rmSync(full, { recursive: true, force: true });
          continue;
        }
        pruneExtras(full);
      } else if (/\.(a|pdb|lib)$/i.test(ent.name)) {
        rmSync(full, { force: true });
      }
    }
  };
  pruneExtras(STAGED_NATIVE);

  // Hydrate relative symlinks declared in pg-symlinks.json (Linux @embedded-postgres packages rely on this
  // for libicuuc.so.60 / libicudata.so.60 / libpq.so.5 etc., even when cache is reused or scripts were skipped)
  if (!IS_WIN) {
    const manifestPath = join(STAGED_NATIVE, "pg-symlinks.json");
    if (existsSync(manifestPath)) {
      const entries = JSON.parse(readFileSync(manifestPath, "utf8"));
      let hydrated = 0;
      for (const { source, target } of entries) {
        const srcRel = String(source).replace(/^native[\\/]/, "");
        const dstRel = String(target).replace(/^native[\\/]/, "");
        const srcAbs = resolve(STAGED_NATIVE, srcRel);
        const dstAbs = resolve(STAGED_NATIVE, dstRel);
        if (!existsSync(srcAbs)) continue;
        let dstExists = false;
        try {
          lstatSync(dstAbs);
          dstExists = true;
        } catch {
          dstExists = false;
        }
        if (dstExists) continue;
        mkdirSync(dirname(dstAbs), { recursive: true });
        symlinkSync(relative(dirname(dstAbs), srcAbs), dstAbs);
        hydrated++;
      }
      if (hydrated > 0) {
        console.log(`[stage-embedded] hydrated ${hydrated} relative symlinks from pg-symlinks.json`);
      }
    }
  }

  // Deduplicate duplicate dylib/so copies (saves ~60-110 MB on macOS)
  const saved = deduplicateSharedLibs(join(STAGED_NATIVE, "lib"));
  const savedPg = deduplicateSharedLibs(join(STAGED_NATIVE, "lib", "postgresql"));

  // Pre-install pgvector into the staged native tree so read-only installed app bundles work out of the box
  const pkglib = existsSync(join(STAGED_NATIVE, "lib", "postgresql")) ? join(STAGED_NATIVE, "lib", "postgresql") : join(STAGED_NATIVE, "lib");
  const extDir = existsSync(join(STAGED_NATIVE, "share", "postgresql", "extension"))
    ? join(STAGED_NATIVE, "share", "postgresql", "extension")
    : join(STAGED_NATIVE, "share", "extension");
  mkdirSync(pkglib, { recursive: true });
  mkdirSync(extDir, { recursive: true });
  for (const f of readdirSync(join(pgvectorDir, "lib"))) {
    cpSync(join(pgvectorDir, "lib", f), join(pkglib, f));
  }
  for (const f of readdirSync(join(pgvectorDir, "extension"))) {
    cpSync(join(pgvectorDir, "extension", f), join(extDir, f));
  }

  // Verify no symlink escaped to an absolute build-machine path or dangles
  if (!IS_WIN) {
    const checkSymlinks = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
          const target = readlinkSync(full);
          if (isAbsolute(target)) {
            throw new Error(`stage-embedded: 发现绝对路径软链 ${full} -> ${target}`);
          }
          const resolved = resolve(dirname(full), target);
          if (!existsSync(resolved)) {
            throw new Error(`stage-embedded: 发现悬空软链 ${full} -> ${target}`);
          }
        } else if (st.isDirectory()) {
          checkSymlinks(full);
        }
      }
    };
    checkSymlinks(STAGED_NATIVE);
    const ver = execFileSync(join(STAGED_NATIVE, "bin", "initdb"), ["--version"], { encoding: "utf8" }).trim();
    console.log(`[stage-embedded] verified staged binary: ${ver}`);
  }

  const totalMb = (dirBytes(STAGED_NATIVE) / 1024 / 1024).toFixed(1);
  const savedMb = ((saved + savedPg) / 1024 / 1024).toFixed(1);
  const relOut = relative(process.cwd(), STAGED_NATIVE);
  if (process.env.CI === "true" || process.argv.includes("--clean-cache")) {
    rmSync(CACHE_DIR, { recursive: true, force: true });
  }
  console.log(`[stage-embedded] ready: ${relOut} (${totalMb} MB uncompressed, deduplicated ${savedMb} MB, pgvector installed)`);
}

main();
