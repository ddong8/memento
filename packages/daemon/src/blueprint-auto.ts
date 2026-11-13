import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLUEPRINT_FILE,
  GENERATED_FOOTER_RE,
  GENERATED_MARK,
  HEAD_MARKER,
  HOOK_MARKER_START,
  LEGACY_GENERATED_MARK,
  LEGACY_SCRIPT_NAME,
  MANAGED_GIT_HOOKS,
  RUNTIME_NAME,
  SCRIPT_NAME,
  SCRIPT_SIGNATURE,
  scriptVersionOf,
} from "./blueprint/meta.js";
import { homeDir, mementoDir } from "./config.js";

/** Cache ttl in milliseconds for git roots verified to have blueprint configured */
const VERIFIED_TTL_MS = 10 * 60 * 1000;
/** A repo the generator failed on is retried after this long (or once HEAD moves), not on every sync. */
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
/** One generator run; big monorepos take a few seconds, a hung run must not pile up. */
const GENERATOR_TIMEOUT_MS = 60_000;

interface CacheEntry {
  ready: boolean;
  timestamp: number;
  headSha: string | null;
}

const verifiedCache = new Map<string, CacheEntry>();
const failedAt = new Map<string, { at: number; headSha: string | null }>();
const inflight = new Map<string, Promise<boolean>>();

/** How the last attempt on a repo went: `no_hooks` is a blueprint kept current from here, without git hooks. */
export interface BlueprintRepoState {
  state: "ok" | "no_hooks" | "failed";
  /** For failed: `no_runtime`, `timeout`, `no_generator`, or `exit <code>: <last stderr line>` */
  reason?: string;
}

/** What the devices page shows for this machine's last blueprint pass. */
export interface BlueprintStatusReport {
  enabled: boolean;
  /** What the generator runs on: this process's runtime (Electron as Node in the desktop app) */
  runtime: string;
  generator_version: number | null;
  ok: number;
  no_hooks: number;
  failed: { name: string; reason: string }[];
}

const repoStates = new Map<string, BlueprintRepoState>();

/** Off when the user turned automatic blueprints off in Memento (profile injection `blueprint.auto`). */
let autoEnabled = true;

export function setBlueprintAutoEnabled(on: boolean): void {
  if (on === autoEnabled) return;
  autoEnabled = on;
  verifiedCache.clear();
  failedAt.clear();
  repoStates.clear();
}

/** The pass over `gitRoots` summed up; repos never attempted (not git, switched off) are left out. */
export async function blueprintStatusReport(gitRoots: Iterable<string>): Promise<BlueprintStatusReport> {
  let ok = 0;
  let noHooks = 0;
  const failed: { name: string; reason: string }[] = [];
  for (const root of new Set(gitRoots)) {
    const st = repoStates.get(root);
    if (!st) continue;
    if (st.state === "ok") ok++;
    else if (st.state === "no_hooks") noHooks++;
    else failed.push({ name: basename(root), reason: st.reason ?? "error" });
  }
  const generator = await locateBlueprintGenerator();
  return {
    enabled: autoEnabled,
    runtime: process.execPath,
    generator_version: generator ? await generatorVersion(generator) : null,
    ok,
    no_hooks: noHooks,
    failed,
  };
}

const versionCache = new Map<string, { mtimeMs: number; size: number; readAt: number; version: number }>();
/**
 * A file rewritten within the filesystem's timestamp resolution (a kernel tick, a few ms on Linux) keeps
 * its mtime: a cached version is trusted only when the file was already this old when it was read.
 */
const RACY_MS = 2_000;

/** BLUEPRINT_SCRIPT_VERSION of a generator script, cached until the file changes (see RACY_MS). */
async function generatorVersion(script: string): Promise<number> {
  try {
    const { mtimeMs, size } = await stat(script);
    const hit = versionCache.get(script);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size && hit.readAt - mtimeMs > RACY_MS) return hit.version;
    const readAt = Date.now();
    const { version } = parseBlueprintScriptMeta(await readFile(script, "utf8"));
    versionCache.set(script, { mtimeMs, size, readAt, version });
    return version;
  } catch {
    return 0;
  }
}

/** The generator version a generated blueprint was written by, from its footer (0 before versions were written). */
export function blueprintGeneratorVersion(text: string): number {
  const m = text.match(GENERATED_FOOTER_RE);
  return m?.[1] ? Number.parseInt(m[1], 10) : 0;
}

export function isBlueprintAutoEnabled(): boolean {
  return autoEnabled;
}

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

/**
 * The git dir (HEAD, per-worktree files, our marker) and the common dir (refs, packed-refs) of a
 * checkout. In a linked worktree or submodule `.git` is a file pointing elsewhere.
 */
export async function resolveGitDirs(gitRoot: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const dotGit = join(gitRoot, ".git");
  try {
    const st = await stat(dotGit);
    if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    if (!st.isFile()) return null;
    const m = (await readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+)$/m);
    if (!m?.[1]) return null;
    const gitDir = resolve(gitRoot, m[1].trim());
    const common = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
    return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
  } catch {
    return null;
  }
}

/** Fast zero-subprocess resolution of current Git HEAD short SHA (7 chars) */
export async function readGitHeadShort(gitRoot: string): Promise<string | null> {
  try {
    const dirs = await resolveGitDirs(gitRoot);
    if (!dirs) return null;
    const raw = (await readFile(join(dirs.gitDir, "HEAD"), "utf8").catch(() => "")).trim();
    if (!raw) return null;
    if (!raw.startsWith("ref:")) {
      return raw.slice(0, 7);
    }
    const refRel = raw.replace(/^ref:\s*/, "").trim();
    for (const base of new Set([dirs.gitDir, dirs.commonDir])) {
      const sha = (await readFile(join(base, refRel), "utf8").catch(() => "")).trim();
      if (sha) return sha.slice(0, 7);
    }
    const packed = await readFile(join(dirs.commonDir, "packed-refs"), "utf8").catch(() => "");
    for (const line of packed.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || s.startsWith("^")) continue;
      const [sha, rname] = s.split(/\s+/);
      if (rname === refRel && sha) return sha.slice(0, 7);
    }
    return null;
  } catch {
    return null;
  }
}

/** Footer of a generated blueprint (the Python generator's too); a file without it is hand-written and left alone. */
export function isGeneratedBlueprint(text: string): boolean {
  return text.startsWith("# Project Blueprint:") && (text.includes(GENERATED_MARK) || text.includes(LEGACY_GENERATED_MARK));
}

/**
 * Git hooks still running the Python generator, which is gone from this machine: they do nothing
 * now, and the repo is set up again once (the generator replaces our block in each hook).
 */
async function hasLegacyHooks(gitRoot: string): Promise<boolean> {
  const dirs = await resolveGitDirs(gitRoot);
  if (!dirs) return false;
  for (const name of MANAGED_GIT_HOOKS) {
    const text = await readFile(join(dirs.commonDir, "hooks", name), "utf8").catch(() => "");
    if (text.includes(HOOK_MARKER_START) && text.includes(LEGACY_SCRIPT_NAME)) return true;
  }
  return false;
}

/**
 * Whether the repo's PROJECT_BLUEPRINT.md is current: a hand-written one always is (never ours to
 * touch); a generated one when the HEAD recorded at generation is still HEAD and the generator that
 * wrote it is not older than `minGeneratorVersion`. Hooks are not required:
 * repos with core.hooksPath or non-shell hooks get none, and are kept current from here instead.
 */
export async function isBlueprintReady(gitRoot: string, minGeneratorVersion = 0): Promise<boolean> {
  try {
    const text = await readFile(join(gitRoot, BLUEPRINT_FILE), "utf8").catch(() => "");
    if (!text) return false;
    if (!isGeneratedBlueprint(text)) return true;
    // Written by an older generator: rebuilt once with the new one (new sections, the About line)
    if (blueprintGeneratorVersion(text) < minGeneratorVersion) return false;
    const head = await readGitHeadShort(gitRoot);
    if (!head) return true; // no commit yet: nothing to be stale against
    const dirs = await resolveGitDirs(gitRoot);
    if (!dirs) return false;
    const recorded = (await readFile(join(dirs.gitDir, HEAD_MARKER), "utf8").catch(() => "")).trim();
    return !!recorded && (recorded.startsWith(head) || head.startsWith(recorded));
  } catch {
    return false;
  }
}

export function parseBlueprintScriptMeta(content: string): { version: number; hash: string } {
  const hash = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
  return { version: scriptVersionOf(content) || 1, hash };
}

function hasRepoCheckoutScript(): boolean {
  try {
    const currentModulePath = fileURLToPath(import.meta.url);
    const repoCandidate = resolve(currentModulePath, `../../../../scripts/${SCRIPT_NAME}`);
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
    const repoCandidate = resolve(currentModulePath, `../../../../scripts/${SCRIPT_NAME}`);
    if (existsSync(repoCandidate)) {
      return repoCandidate;
    }
  } catch {
    // ignore
  }
  try {
    const assetCandidate = fileURLToPath(new URL(`../assets/${SCRIPT_NAME}`, import.meta.url));
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
 * 1. Target project's own scripts/project_blueprint.mjs
 * 2. Bundled / Memento repository's scripts/project_blueprint.mjs
 * 3. Global ~/.memento/scripts/project_blueprint.mjs (synced from bundled asset or server OTA)
 */
export async function locateBlueprintGenerator(gitRoot?: string): Promise<string | null> {
  const shared = await locateSharedGenerator();
  if (gitRoot) {
    // A repo's own copy wins, unless it is older than ours (copied once and never updated)
    const localScript = join(gitRoot, "scripts", SCRIPT_NAME);
    if (existsSync(localScript) && (!shared || (await generatorVersion(localScript)) >= (await generatorVersion(shared)))) {
      return localScript;
    }
  }
  return shared;
}

async function locateSharedGenerator(): Promise<string | null> {
  const globalScript = join(mementoDir(homeDir()), "scripts", SCRIPT_NAME);
  const bundled = locateBundledBlueprintGenerator();
  if (existsSync(globalScript) && bundled) {
    const [gVersion, bVersion] = await Promise.all([generatorVersion(globalScript), generatorVersion(bundled)]);
    // Prefer globalScript if it was upgraded via OTA to a newer version than bundled asset
    if (gVersion > bVersion || (!hasRepoCheckoutScript() && gVersion === bVersion)) {
      return globalScript;
    }
  }

  if (bundled) return bundled;
  if (existsSync(globalScript)) return globalScript;

  return null;
}

/**
 * What the git hooks run the generator on (~/.memento/scripts/runtime): this process's runtime,
 * Electron as Node in the desktop app, or `node` once that is gone (the app uninstalled).
 */
export function hookRuntimeScript(execPath = process.execPath, platform = process.platform): string {
  // Git for Windows runs hooks in its sh, which takes C:/ paths
  const exe = (platform === "win32" ? execPath.replaceAll("\\", "/") : execPath).replaceAll("'", "'\\''");
  return [
    "#!/bin/sh",
    "# The runtime of Memento's project blueprint git hooks (rewritten by Memento)",
    `if [ -x '${exe}' ]; then`,
    `    ELECTRON_RUN_AS_NODE=1 exec '${exe}' "$@"`,
    "fi",
    'exec node "$@"',
    "",
  ].join("\n");
}

async function writeIfChanged(target: string, content: string, executable: boolean): Promise<boolean> {
  if ((await readFile(target, "utf8").catch(() => null)) === content) return false;
  const tmp = `${target}.tmp`;
  await writeFile(tmp, content, "utf8");
  if (executable && process.platform !== "win32") await chmod(tmp, 0o755);
  await rename(tmp, target);
  return true;
}

/**
 * Sync generator script to ~/.memento/scripts/project_blueprint.mjs for global accessibility, with the
 * runtime file the hooks run it on. The Python generator it replaces is removed.
 */
export async function syncGlobalBlueprintScript(): Promise<string | null> {
  try {
    const globalDir = join(mementoDir(homeDir()), "scripts");
    await mkdir(globalDir, { recursive: true });
    const target = join(globalDir, SCRIPT_NAME);
    await writeIfChanged(join(globalDir, RUNTIME_NAME), hookRuntimeScript(), true);
    await rm(join(globalDir, LEGACY_SCRIPT_NAME), { force: true });

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

      if (shouldWrite && (await writeIfChanged(target, bundledContent, true))) verifiedCache.clear();
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
    const target = join(mementoDir(homeDir()), "scripts", SCRIPT_NAME);
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
  if (!remote?.content || !remote.content.includes(SCRIPT_SIGNATURE) || !scriptVersionOf(remote.content)) {
    return false;
  }
  try {
    const globalDir = join(mementoDir(homeDir()), "scripts");
    await mkdir(globalDir, { recursive: true });
    await writeIfChanged(join(globalDir, SCRIPT_NAME), remote.content, true);
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

export interface GeneratorResult {
  code: number | null;
  stderr: string;
  /** Why it could not run at all: the runtime missing (the app moved mid-update), or killed after GENERATOR_TIMEOUT_MS */
  failure?: "no_runtime" | "timeout";
}

/** The generator runs on this process's runtime: Electron as Node in the desktop app, node otherwise. */
async function runGenerator(generator: string, args: string[], cwd: string): Promise<GeneratorResult> {
  return new Promise<GeneratorResult>((resolveDone) => {
    let settled = false;
    let stderr = "";
    const done = (code: number | null, extra = "", failure?: GeneratorResult["failure"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = (stderr + extra).trim().slice(-600);
      resolveDone({ code, stderr: text, ...(failure ? { failure } : {}) });
    };
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      done(null, `timed out after ${GENERATOR_TIMEOUT_MS / 1000}s`, "timeout");
    }, GENERATOR_TIMEOUT_MS);
    timer.unref?.();
    const proc = spawn(process.execPath, [generator, ...args], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += String(chunk);
    });
    proc.once("error", (err) => done(null, err.message, (err as NodeJS.ErrnoException).code === "ENOENT" ? "no_runtime" : undefined));
    proc.once("exit", (code) => done(code));
  });
}

/** The reason shown on the devices page: a known cause, or the exit code and the error's last line. */
export function generatorFailureReason(res: GeneratorResult): string {
  if (res.failure) return res.failure;
  const last = res.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return `exit ${res.code ?? "?"}${last ? `: ${last.slice(0, 160)}` : ""}`;
}

/**
 * Ensure PROJECT_BLUEPRINT.md and its git hooks for a project directory. Non-blocking for callers
 * that don't await it, idempotent, one generator run per repo at a time, and a no-op while the
 * user has automatic blueprints off.
 */
export async function ensureProjectBlueprint(
  targetPath: string,
  options: { force?: boolean; log?: (msg: string) => void } = {},
): Promise<boolean> {
  if (!autoEnabled || !targetPath) return false;
  const gitRoot = findGitRoot(targetPath);
  if (!gitRoot) return false;
  const pending = inflight.get(gitRoot);
  if (pending) return pending;
  const run = ensureAt(gitRoot, options).finally(() => inflight.delete(gitRoot));
  inflight.set(gitRoot, run);
  return run;
}

async function ensureAt(gitRoot: string, options: { force?: boolean; log?: (msg: string) => void }): Promise<boolean> {
  const log = options.log || (() => {});
  const force = !!options.force;
  const now = Date.now();
  const currentHead = await readGitHeadShort(gitRoot);
  const cached = verifiedCache.get(gitRoot);
  if (!force && cached?.ready && cached.headSha === currentHead && now - cached.timestamp < VERIFIED_TTL_MS) {
    return true;
  }
  const fail = (reason: string) => {
    failedAt.set(gitRoot, { at: Date.now(), headSha: currentHead });
    repoStates.set(gitRoot, { state: "failed", reason });
    return false;
  };
  let generator = await locateBlueprintGenerator(gitRoot);
  const minVersion = generator ? await generatorVersion(generator) : 0;
  if (!force && (await isBlueprintReady(gitRoot, minVersion)) && !(await hasLegacyHooks(gitRoot))) {
    verifiedCache.set(gitRoot, { ready: true, timestamp: now, headSha: currentHead });
    if (repoStates.get(gitRoot)?.state !== "no_hooks") repoStates.set(gitRoot, { state: "ok" });
    return true;
  }
  const failed = failedAt.get(gitRoot);
  if (!force && failed && failed.headSha === currentHead && now - failed.at < RETRY_AFTER_FAILURE_MS) {
    return false;
  }

  await syncGlobalBlueprintScript();
  generator = await locateBlueprintGenerator(gitRoot);
  if (!generator) {
    log(`[blueprint-auto] Could not locate generator script for ${gitRoot}`);
    return fail("no_generator");
  }
  try {
    const res = await runGenerator(generator, ["--root", gitRoot, "--install-hook", "--quiet"], gitRoot);
    if (!res.failure && (await isBlueprintReady(gitRoot, minVersion))) {
      verifiedCache.set(gitRoot, { ready: true, timestamp: Date.now(), headSha: await readGitHeadShort(gitRoot) });
      failedAt.delete(gitRoot);
      // Exit 1 with the blueprint written: hooks left out (core.hooksPath, or the repo's own non-shell hooks)
      repoStates.set(gitRoot, { state: res.code === 0 ? "ok" : "no_hooks" });
      log(
        res.code === 0
          ? `[blueprint-auto] Living blueprint & hooks ready for ${gitRoot}`
          : `[blueprint-auto] Living blueprint ready for ${gitRoot} (git hooks left out, kept current on sync)`,
      );
      return true;
    }
    const reason = generatorFailureReason(res);
    log(
      res.failure === "no_runtime"
        ? `[blueprint-auto] Could not start ${process.execPath} for the blueprint generator (${gitRoot})`
        : `[blueprint-auto] Failed configuring blueprint for ${gitRoot} (code ${res.code}): ${res.stderr}`,
    );
    return fail(reason);
  } catch (e) {
    log(`[blueprint-auto] Execution exception: ${String(e)}`);
    return fail(`error: ${String(e).slice(0, 160)}`);
  }
}

/**
 * Take back everything the generator did on this machine (hooks, markers, untracked generated
 * blueprints, anchors, its state dir): when the user turns automatic blueprints off.
 */
export async function removeAllProjectBlueprints(log: (msg: string) => void = () => {}): Promise<boolean> {
  verifiedCache.clear();
  failedAt.clear();
  repoStates.clear();
  const generator = await locateBlueprintGenerator();
  if (!generator) return false;
  const res = await runGenerator(generator, ["--uninstall-all", "--quiet"], homeDir());
  if (res.code === 0) {
    log("[blueprint-auto] Removed living blueprints & hooks from local repos");
    return true;
  }
  log(`[blueprint-auto] Could not fully remove living blueprints (code ${res.code}): ${res.stderr}`);
  return false;
}
