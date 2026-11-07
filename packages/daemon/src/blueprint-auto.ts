import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir, mementoDir } from "./config.js";
import { findExecutable } from "./exec-env.js";

/** Cache ttl in milliseconds for git roots verified to have blueprint configured */
const VERIFIED_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  ready: boolean;
  timestamp: number;
  headSha: string | null;
}

const verifiedCache = new Map<string, CacheEntry>();

/** Locate the root git directory from any descendant working path */
export function findGitRoot(startPath: string): string | null {
  if (!startPath || typeof startPath !== "string") return null;
  let current = resolve(startPath);
  const maxDepth = 25;
  for (let i = 0; i < maxDepth; i++) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Discover local Git repositories across standard workspace directories on any OS */
export async function discoverLocalGitRepositories(): Promise<{ name: string; path: string }[]> {
  const home = homeDir();
  const searchBases = [
    join(home, "dev"),
    join(home, "Desktop", "dev"),
    join(home, "WorkBuddy"),
    join(home, "projects"),
    join(home, "workspace"),
    join(home, "code"),
    join(home, "repos"),
  ];
  const found: { name: string; path: string }[] = [];
  const seen = new Set<string>();

  const checkDir = async (dirPath: string, depth: number) => {
    if (depth > 2 || seen.has(dirPath)) return;
    const name = basename(dirPath);
    if (name.startsWith(".") || name === "node_modules" || name === "venv" || name.toLowerCase().includes("worktree")) {
      return;
    }
    if (existsSync(join(dirPath, ".git"))) {
      seen.add(dirPath);
      found.push({ name, path: dirPath });
      return;
    }
    if (depth === 2) return;
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await checkDir(join(dirPath, entry.name), depth + 1);
        }
      }
    } catch {
      // ignore permission or missing dir errors
    }
  };

  for (const base of searchBases) {
    if (!existsSync(base)) continue;
    try {
      const entries = await readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await checkDir(join(base, entry.name), 1);
        }
      }
    } catch {
      // ignore
    }
  }
  return found;
}

/** Fast zero-subprocess resolution of current Git HEAD short SHA (7 chars) */
export async function readGitHeadShort(gitRoot: string): Promise<string | null> {
  try {
    const headFile = join(gitRoot, ".git", "HEAD");
    if (!existsSync(headFile)) return null;
    const raw = (await readFile(headFile, "utf8")).trim();
    if (!raw) return null;
    if (!raw.startsWith("ref:")) {
      return raw.slice(0, 7);
    }
    const refRel = raw.replace(/^ref:\s*/, "").trim();
    const refPath = join(gitRoot, ".git", refRel);
    if (existsSync(refPath)) {
      const sha = (await readFile(refPath, "utf8")).trim();
      return sha ? sha.slice(0, 7) : null;
    }
    const packedPath = join(gitRoot, ".git", "packed-refs");
    if (existsSync(packedPath)) {
      const packed = await readFile(packedPath, "utf8");
      for (const line of packed.split("\n")) {
        const s = line.trim();
        if (!s || s.startsWith("#") || s.startsWith("^")) continue;
        const [sha, rname] = s.split(/\s+/);
        if (rname === refRel && sha) return sha.slice(0, 7);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Check if PROJECT_BLUEPRINT.md and the git hooks (post-commit, post-merge, post-checkout) are properly in place and up-to-date with HEAD */
export async function isBlueprintReady(gitRoot: string): Promise<boolean> {
  try {
    const bpPath = join(gitRoot, "PROJECT_BLUEPRINT.md");
    if (!existsSync(bpPath)) return false;
    const bpStat = await stat(bpPath);
    if (bpStat.size < 50) return false;

    // Check git hooks
    for (const hname of ["post-commit", "post-merge", "post-checkout"]) {
      const hookPath = join(gitRoot, ".git", "hooks", hname);
      if (!existsSync(hookPath)) return false;
      const hookContent = await readFile(hookPath, "utf8");
      if (!hookContent.includes("project_blueprint.py") && !hookContent.includes("Memento Blueprint Hook")) {
        return false;
      }
    }

    // Verify blueprint is not stale relative to current Git HEAD (catches --no-verify or GUI commits)
    const currentHead = await readGitHeadShort(gitRoot);
    if (currentHead) {
      const recordedHeadPath = join(gitRoot, ".git", ".memento_blueprint_head");
      if (existsSync(recordedHeadPath)) {
        const recorded = (await readFile(recordedHeadPath, "utf8")).trim();
        if (recorded && !recorded.startsWith(currentHead) && !currentHead.startsWith(recorded)) {
          return false;
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function parseBlueprintScriptMeta(content: string): { version: number; hash: string } {
  const hash = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
  const m = content.match(/^BLUEPRINT_SCRIPT_VERSION\s*=\s*(\d+)/m);
  const version = m?.[1] ? Number.parseInt(m[1], 10) : 1;
  return { version, hash };
}

function hasRepoCheckoutScript(): boolean {
  try {
    const currentModulePath = fileURLToPath(import.meta.url);
    const repoCandidate = resolve(currentModulePath, "../../../../scripts/project_blueprint.py");
    return existsSync(repoCandidate);
  } catch {
    return false;
  }
}

function locateBundledBlueprintGenerator(): string | null {
  if (process.env.MEMENTO_BLUEPRINT_RUNNER && existsSync(process.env.MEMENTO_BLUEPRINT_RUNNER)) {
    return process.env.MEMENTO_BLUEPRINT_RUNNER;
  }
  try {
    const currentModulePath = fileURLToPath(import.meta.url);
    const repoCandidate = resolve(currentModulePath, "../../../../scripts/project_blueprint.py");
    if (existsSync(repoCandidate)) {
      return repoCandidate;
    }
  } catch {
    // ignore
  }
  try {
    const assetCandidate = fileURLToPath(new URL("../assets/project_blueprint.py", import.meta.url));
    if (existsSync(assetCandidate)) {
      return assetCandidate;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Locate generator script:
 * 1. Target project's own scripts/project_blueprint.py
 * 2. Bundled / Memento repository's scripts/project_blueprint.py
 * 3. Global ~/.memento/scripts/project_blueprint.py (synced from bundled asset or server OTA)
 */
export async function locateBlueprintGenerator(gitRoot?: string): Promise<string | null> {
  if (gitRoot) {
    const localScript = join(gitRoot, "scripts", "project_blueprint.py");
    if (existsSync(localScript)) return localScript;
  }

  const globalScript = join(mementoDir(homeDir()), "scripts", "project_blueprint.py");
  const bundled = locateBundledBlueprintGenerator();
  if (existsSync(globalScript) && bundled) {
    try {
      const [gContent, bContent] = await Promise.all([
        readFile(globalScript, "utf8"),
        readFile(bundled, "utf8"),
      ]);
      const gMeta = parseBlueprintScriptMeta(gContent);
      const bMeta = parseBlueprintScriptMeta(bContent);
      // Prefer globalScript if it was upgraded via OTA to a newer version than bundled asset
      if (gMeta.version > bMeta.version || (!hasRepoCheckoutScript() && gMeta.version === bMeta.version)) {
        return globalScript;
      }
    } catch {
      // fall through
    }
  }

  if (bundled) return bundled;
  if (existsSync(globalScript)) return globalScript;

  return null;
}

/** Sync generator script to ~/.memento/scripts/project_blueprint.py for global accessibility */
export async function syncGlobalBlueprintScript(): Promise<string | null> {
  try {
    const globalDir = join(mementoDir(homeDir()), "scripts");
    await mkdir(globalDir, { recursive: true });
    const target = join(globalDir, "project_blueprint.py");

    const bundled = locateBundledBlueprintGenerator();
    if (bundled && bundled !== target) {
      const bundledContent = await readFile(bundled, "utf8");
      const bundledMeta = parseBlueprintScriptMeta(bundledContent);
      const existingContent = await readFile(target, "utf8").catch(() => "");
      const existingMeta = existingContent ? parseBlueprintScriptMeta(existingContent) : { version: 0, hash: "" };

      const shouldWrite =
        !existingContent ||
        bundledMeta.version > existingMeta.version ||
        (bundledMeta.version === existingMeta.version &&
          bundledMeta.hash !== existingMeta.hash &&
          hasRepoCheckoutScript());

      if (shouldWrite) {
        const tmp = `${target}.tmp`;
        await writeFile(tmp, bundledContent, "utf8");
        if (process.platform !== "win32") await chmod(tmp, 0o755);
        await rename(tmp, target);
        verifiedCache.clear();
      }
    }
    return existsSync(target) ? target : bundled;
  } catch {
    return null;
  }
}

/** Check if the server's blueprint generator script is newer than our local copy */
export async function needsRemoteBlueprintSync(
  remoteMeta?: { version?: number; hash?: string } | null,
): Promise<boolean> {
  if (!remoteMeta?.hash) return false;
  try {
    await syncGlobalBlueprintScript();
    const target = join(mementoDir(homeDir()), "scripts", "project_blueprint.py");
    if (!existsSync(target)) return true;
    const localContent = await readFile(target, "utf8");
    const localMeta = parseBlueprintScriptMeta(localContent);
    const remoteVer = remoteMeta.version ?? 1;
    if (remoteVer > localMeta.version) return true;
    if (remoteVer === localMeta.version && remoteMeta.hash !== localMeta.hash && !hasRepoCheckoutScript()) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Atomically install the OTA blueprint generator script downloaded from the server */
export async function applyRemoteBlueprintScript(
  remote?: { version?: number; hash?: string; content?: string } | null,
): Promise<boolean> {
  if (!remote?.content || !remote.content.includes("def build_blueprint_content")) {
    return false;
  }
  try {
    const globalDir = join(mementoDir(homeDir()), "scripts");
    await mkdir(globalDir, { recursive: true });
    const target = join(globalDir, "project_blueprint.py");
    const tmp = `${target}.tmp`;
    await writeFile(tmp, remote.content, "utf8");
    if (process.platform !== "win32") await chmod(tmp, 0o755);
    await rename(tmp, target);
    verifiedCache.clear();
    return true;
  } catch {
    return false;
  }
}

/** Sync USER_BLUEPRINT.md to ~/.memento/USER_BLUEPRINT.md for instant local agent access */
export async function syncLocalUserBlueprint(markdown?: string | null): Promise<boolean> {
  if (!markdown || markdown.length < 50) return false;
  try {
    const dir = mementoDir(homeDir());
    await mkdir(dir, { recursive: true });
    const target = join(dir, "USER_BLUEPRINT.md");
    const existing = await readFile(target, "utf8").catch(() => "");
    if (existing === markdown) return false;
    const tmp = `${target}.tmp`;
    await writeFile(tmp, markdown, "utf8");
    await rename(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure PROJECT_BLUEPRINT.md and post-commit hook are deployed for a given project directory.
 * Guaranteed to be non-blocking, safe, idempotent, and fault-tolerant.
 */
export async function ensureProjectBlueprint(
  targetPath: string,
  options: { force?: boolean; log?: (msg: string) => void } = {},
): Promise<boolean> {
  const log = options.log || (() => {});
  if (!targetPath) return false;

  const gitRoot = findGitRoot(targetPath);
  if (!gitRoot) {
    return false;
  }

  const now = Date.now();
  const currentHead = await readGitHeadShort(gitRoot);
  const cached = verifiedCache.get(gitRoot);
  if (
    !options.force &&
    cached &&
    cached.ready &&
    cached.headSha === currentHead &&
    now - cached.timestamp < VERIFIED_TTL_MS
  ) {
    return true;
  }

  const alreadyReady = await isBlueprintReady(gitRoot);
  if (!options.force && alreadyReady) {
    verifiedCache.set(gitRoot, { ready: true, timestamp: now, headSha: currentHead });
    return true;
  }

  // Ensure global script is mirrored
  await syncGlobalBlueprintScript();
  const generator = await locateBlueprintGenerator(gitRoot);
  if (!generator) {
    log(`[blueprint-auto] Could not locate generator script for ${gitRoot}`);
    return false;
  }

  // Locate python executable (python3 or python)
  const pythonExe = (await findExecutable(["python3", "python"])) || "python3";

  return new Promise<boolean>((resolveDone) => {
    try {
      const proc = spawn(pythonExe, [generator, "--root", gitRoot, "--install-hook", "--quiet"], {
        cwd: gitRoot,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });

      let errOut = "";
      proc.stderr?.on("data", (chunk) => {
        errOut += String(chunk);
      });

      proc.once("error", (err) => {
        log(`[blueprint-auto] Spawn error for ${gitRoot}: ${err.message}`);
        resolveDone(false);
      });

      proc.once("exit", (code) => {
        if (code === 0) {
          log(`[blueprint-auto] Successfully configured living blueprint & hook for ${gitRoot}`);
          verifiedCache.set(gitRoot, { ready: true, timestamp: Date.now(), headSha: currentHead });
          resolveDone(true);
        } else {
          log(`[blueprint-auto] Failed configuring blueprint for ${gitRoot} (code ${code}): ${errOut}`);
          resolveDone(false);
        }
      });

      // Guard timeout: do not let hanging python process run forever
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolveDone(false);
      }, 15000);
      timer.unref?.();
    } catch (e) {
      log(`[blueprint-auto] Execution exception: ${String(e)}`);
      resolveDone(false);
    }
  });
}
