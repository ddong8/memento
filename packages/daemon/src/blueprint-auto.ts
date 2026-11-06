import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir, mementoDir } from "./config.js";
import { findExecutable } from "./exec-env.js";

/** Cache ttl in milliseconds for git roots verified to have blueprint configured */
const VERIFIED_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  ready: boolean;
  timestamp: number;
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

/** Check if PROJECT_BLUEPRINT.md and the post-commit git hook are properly in place */
export async function isBlueprintReady(gitRoot: string): Promise<boolean> {
  try {
    const bpPath = join(gitRoot, "PROJECT_BLUEPRINT.md");
    if (!existsSync(bpPath)) return false;
    const bpStat = await stat(bpPath);
    if (bpStat.size < 50) return false;

    // Check post-commit hook
    const hookPath = join(gitRoot, ".git", "hooks", "post-commit");
    if (!existsSync(hookPath)) return false;
    const hookContent = await readFile(hookPath, "utf8");
    if (!hookContent.includes("project_blueprint.py") && !hookContent.includes("Memento Blueprint Hook")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Locate generator script:
 * 1. Target project's own scripts/project_blueprint.py
 * 2. Memento repository's scripts/project_blueprint.py
 * 3. Global ~/.memento/scripts/project_blueprint.py
 */
export async function locateBlueprintGenerator(gitRoot?: string): Promise<string | null> {
  if (gitRoot) {
    const localScript = join(gitRoot, "scripts", "project_blueprint.py");
    if (existsSync(localScript)) return localScript;
  }

  // Check if running within Memento codebase
  try {
    const currentModulePath = fileURLToPath(import.meta.url);
    const repoCandidate = resolve(currentModulePath, "../../../../scripts/project_blueprint.py");
    if (existsSync(repoCandidate)) {
      return repoCandidate;
    }
  } catch {
    // ignore
  }

  const globalScript = join(mementoDir(homeDir()), "scripts", "project_blueprint.py");
  if (existsSync(globalScript)) return globalScript;

  return null;
}

/** Sync generator script to ~/.memento/scripts/project_blueprint.py for global accessibility */
export async function syncGlobalBlueprintScript(): Promise<string | null> {
  try {
    const generator = await locateBlueprintGenerator();
    if (!generator) return null;

    const globalDir = join(mementoDir(homeDir()), "scripts");
    await mkdir(globalDir, { recursive: true });
    const target = join(globalDir, "project_blueprint.py");

    if (generator !== target) {
      await copyFile(generator, target);
    }
    return target;
  } catch {
    return null;
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
  const cached = verifiedCache.get(gitRoot);
  if (!options.force && cached && cached.ready && now - cached.timestamp < VERIFIED_TTL_MS) {
    return true;
  }

  const alreadyReady = await isBlueprintReady(gitRoot);
  if (!options.force && alreadyReady) {
    verifiedCache.set(gitRoot, { ready: true, timestamp: now });
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
          verifiedCache.set(gitRoot, { ready: true, timestamp: Date.now() });
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
