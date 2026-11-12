import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { homeDir } from "./config.js";

/**
 * Code on one device, agent on another. The device holding the code (the source) packs its
 * repository into a git bundle: the history plus a snapshot commit of the working tree as it is,
 * uncommitted and untracked files included (whatever .gitignore leaves out stays behind). The
 * device running the agent (the executor) keeps a full clone of it under
 * ~/.memento/workspaces, resets it to that snapshot and runs the agent there. What the agent
 * changed goes back as a binary patch against the snapshot, which the source applies to its working
 * tree without touching its index: the files show up as uncommitted changes, as if the agent had
 * run there. A patch that no longer applies (the files changed meanwhile) is kept on a branch
 * instead of overwriting anything.
 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string | Buffer): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, env, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
      },
    );
    // git can quit before reading all of a big patch; its exit code says why, the EPIPE must not crash us
    child.stdin?.on("error", () => {});
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Raw bytes of a command's output: patches carry file contents in whatever encoding they have. */
function gitBytes(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) reject(new WorkspaceError(`git ${args[0]} 失败：${String(stderr || err.message).trim().slice(0, 600)}`));
      else resolve(stdout);
    });
  });
}

async function gitOk(args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string | Buffer): Promise<string> {
  const r = await git(args, cwd, env, input);
  if (r.code !== 0) throw new WorkspaceError(`git ${args[0]} 失败：${(r.stderr || r.stdout).trim().slice(0, 600)}`);
  return r.stdout;
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    /** Lets the executor react: a bundle that needs commits its clone lost is fetched again in full. */
    readonly code: string = "failed",
  ) {
    super(message);
  }
}

/** Commits memento makes itself (snapshots, kept results): no user.name needed on the device. */
function identityEnv(env?: NodeJS.ProcessEnv, indexFile?: string): NodeJS.ProcessEnv {
  return {
    ...(env ?? process.env),
    GIT_AUTHOR_NAME: "memento",
    GIT_AUTHOR_EMAIL: "memento@localhost",
    GIT_COMMITTER_NAME: "memento",
    GIT_COMMITTER_EMAIL: "memento@localhost",
    // Never stop for a credential or editor prompt on a device nobody is watching
    GIT_TERMINAL_PROMPT: "0",
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  };
}

const memento = (home?: string) => join(home ?? homeDir(), ".memento");

/** A temporary index of its own, so the user's staged changes are never touched. */
async function withTempIndex<T>(home: string | undefined, fn: (indexFile: string) => Promise<T>): Promise<T> {
  const dir = join(memento(home), "tmp");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `index-${randomBytes(6).toString("hex")}`);
  try {
    return await fn(file);
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

/** The tree of the working directory as it is: tracked files with their edits, plus untracked ones .gitignore lets in. */
async function workingTree(root: string, env: NodeJS.ProcessEnv | undefined, home: string | undefined, start: string): Promise<string> {
  return withTempIndex(home, async (index) => {
    const e = identityEnv(env, index);
    await gitOk(["read-tree", start], root, e);
    await gitOk(["add", "-A", "--", "."], root, e);
    return (await gitOk(["write-tree"], root, e)).trim();
  });
}

/** Largest untracked file and total a snapshot takes along; bigger ones belong in .gitignore. */
export const UNTRACKED_FILE_LIMIT = 50 * 1024 * 1024;
export const UNTRACKED_TOTAL_LIMIT = 300 * 1024 * 1024;

async function checkUntracked(root: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const out = await gitOk(["ls-files", "--others", "--exclude-standard", "-z"], root, env);
  let total = 0;
  const big: string[] = [];
  for (const rel of out.split("\0")) {
    if (!rel) continue;
    try {
      const st = await lstat(join(root, rel));
      if (!st.isFile()) continue;
      total += st.size;
      if (st.size > UNTRACKED_FILE_LIMIT) big.push(`${rel}（${Math.round(st.size / 1048576)}MB）`);
    } catch {}
  }
  if (big.length) {
    throw new WorkspaceError(`有未被 .gitignore 忽略的大文件，加进 .gitignore 后再试：${big.slice(0, 5).join("、")}`, "too_big");
  }
  if (total > UNTRACKED_TOTAL_LIMIT) {
    throw new WorkspaceError(`未跟踪的文件共 ${Math.round(total / 1048576)}MB，超过 ${UNTRACKED_TOTAL_LIMIT / 1048576}MB，把构建产物等加进 .gitignore 后再试`, "too_big");
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function repoOf(dir: string, env?: NodeJS.ProcessEnv): Promise<{ root: string; rel: string }> {
  if (!dir || !existsSync(dir)) throw new WorkspaceError(`目录不存在：${dir}`, "not_found");
  const top = await git(["rev-parse", "--show-toplevel"], dir, env);
  if (top.code !== 0) throw new WorkspaceError(`${dir} 不是 git 仓库。在另一台设备上改代码需要项目是 git 仓库（git init 并提交一次即可）`, "not_git");
  const root = normalize(top.stdout.trim());
  // From git itself: the toplevel it reports has symlinks resolved (/var → /private/var on macOS), dir may not
  const prefix = (await git(["rev-parse", "--show-prefix"], dir, env)).stdout.trim().replace(/\/+$/, "");
  return { root, rel: toPosix(prefix) };
}

// ── on the device that holds the code ────────────────────────────────────

export interface ExportResult {
  /** Where the bundle was written; empty when the executor already holds the snapshot. */
  bundle: string;
  size: number;
  head: string;
  /** Branch checked out at the source; empty on a detached HEAD. */
  branch: string;
  snapshot: string;
  tree: string;
  root: string;
  /** The directory the task was sent to, relative to the repository root ("" for the root itself). */
  rel: string;
  upToDate: boolean;
}

const OUTBOX = (home?: string) => join(memento(home), "workspace-out");

/** Old bundles go after an hour: the executor fetches one within seconds of asking for it. */
async function sweepOutbox(home?: string): Promise<void> {
  const dir = OUTBOX(home);
  try {
    const now = Date.now();
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const st = await stat(p).catch(() => null);
      if (st && now - st.mtimeMs > 3_600_000) await rm(p, { force: true }).catch(() => {});
    }
  } catch {}
}

export async function exportWorkspace(
  dir: string,
  have: readonly string[],
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<ExportResult> {
  const { env, home } = options;
  const { root, rel } = await repoOf(dir, env);
  const headR = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], root, env);
  if (headR.code !== 0) throw new WorkspaceError("仓库还没有任何提交，先提交一次再试", "no_commit");
  const head = headR.stdout.trim();
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], root, env)).stdout.trim();

  await checkUntracked(root, env);
  const tree = await workingTree(root, env, home, head);
  // Dated as HEAD: the same working tree gives the same snapshot, which the executor then already has
  const at = `${(await gitOk(["show", "-s", "--format=%ct", head], root, env)).trim()} +0000`;
  const snapshot = (
    await gitOk(["commit-tree", tree, "-p", head, "-m", "memento: 工作区快照"], root, { ...identityEnv(env), GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at })
  ).trim();
  await gitOk(["update-ref", "refs/memento/snapshot", snapshot], root, env);

  const base = { head, branch, snapshot, tree, root, rel };
  if (have.includes(snapshot)) return { ...base, bundle: "", size: 0, upToDate: true };

  // Only what the executor lacks: commits it already holds are left out
  const known: string[] = [];
  for (const sha of new Set(have)) {
    if (/^[0-9a-f]{40,64}$/.test(sha) && (await git(["cat-file", "-e", `${sha}^{commit}`], root, env)).code === 0) known.push(sha);
  }
  const out = OUTBOX(home);
  await mkdir(out, { recursive: true });
  await sweepOutbox(home);
  const bundle = join(out, `${randomBytes(8).toString("hex")}.bundle`);
  const made = await git(["bundle", "create", "-q", bundle, "refs/memento/snapshot", ...known.map((s) => `^${s}`)], root, env);
  if (made.code !== 0) throw new WorkspaceError(`打包仓库失败：${made.stderr.trim().slice(0, 600)}`);
  const size = (await stat(bundle)).size;
  return { ...base, bundle, size, upToDate: false };
}

export interface AppliedFile {
  status: string;
  path: string;
}

export interface ApplyResult {
  applied: boolean;
  /** The patch didn't apply to the files as they are now: kept on this branch instead. */
  conflict?: boolean;
  branch?: string;
  files: AppliedFile[];
  /** Where the patch is kept in the repository (.git/memento/patches): `git apply -R` takes it back out. */
  patchPath: string;
  error?: string;
}

function parseNameStatus(out: string): AppliedFile[] {
  const parts = out.split("\0").filter(Boolean);
  const files: AppliedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]!.charAt(0), path: parts[i + 1]! });
  return files;
}

/**
 * Applies an executor's patch to the working tree of `dir`. `mode: "save"` only keeps it (a task
 * that failed or was stopped): the user decides whether to apply it.
 */
export async function applyWorkspacePatch(
  dir: string,
  patch: Buffer,
  options: {
    taskId: string;
    baseTree: string;
    mode?: "apply" | "save";
    /** What the executor says the patch touches, reported when it is only kept. */
    files?: AppliedFile[];
    env?: NodeJS.ProcessEnv;
    home?: string;
  },
): Promise<ApplyResult> {
  const { env, home, taskId, baseTree } = options;
  const { root } = await repoOf(dir, env);
  const gitDir = normalize((await gitOk(["rev-parse", "--absolute-git-dir"], root, env)).trim());
  const id = taskId.replaceAll("-", "").slice(0, 8) || randomBytes(4).toString("hex");
  const patchDir = join(gitDir, "memento", "patches");
  await mkdir(patchDir, { recursive: true });
  const patchPath = join(patchDir, `${id}.patch`);
  await writeFile(patchPath, patch);

  const listed = options.files ?? (await patchFiles(root, patchPath, env));
  if (options.mode === "save") return { applied: false, files: listed, patchPath };

  const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], root, env)).stdout.trim();
  if (!head) throw new WorkspaceError("源仓库没有提交，无法应用改动");

  return withTempIndex(home, async (index) => {
    const e = identityEnv(env, index);
    await gitOk(["read-tree", head], root, e);
    await gitOk(["add", "-A", "--", "."], root, e);
    const now = (await gitOk(["write-tree"], root, e)).trim();
    const put = await git(["apply", "--cached", "--binary", patchPath], root, e);
    if (put.code !== 0) {
      // The files moved on since the snapshot: keep the result on a branch, overwrite nothing
      const branch = await keepOnBranch(root, patchPath, baseTree, head, id, env, home);
      return { applied: false, conflict: true, branch, files: listed, patchPath, error: put.stderr.trim().slice(0, 800) };
    }
    const after = (await gitOk(["write-tree"], root, e)).trim();
    const files = parseNameStatus(await gitOk(["diff-tree", "-r", "--no-renames", "--name-status", "-z", now, after], root, env));
    const write = files.filter((f) => f.status !== "D").map((f) => f.path);
    if (write.length) await gitOk(["checkout-index", "-f", "-z", "--stdin"], root, e, write.join("\0") + "\0");
    for (const f of files) {
      if (f.status !== "D") continue;
      await unlink(join(root, f.path)).catch(() => {});
    }
    return { applied: true, files, patchPath };
  });
}

async function patchFiles(root: string, patchPath: string, env?: NodeJS.ProcessEnv): Promise<AppliedFile[]> {
  const out = (await git(["apply", "--numstat", "-z", "--binary", patchPath], root, env)).stdout;
  const files: AppliedFile[] = [];
  for (const entry of out.split("\0")) {
    const m = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/.exec(entry);
    if (m) files.push({ status: "M", path: m[1]! });
  }
  return files;
}

async function keepOnBranch(
  root: string,
  patchPath: string,
  baseTree: string,
  head: string,
  id: string,
  env: NodeJS.ProcessEnv | undefined,
  home: string | undefined,
): Promise<string | undefined> {
  if (!/^[0-9a-f]{40,64}$/.test(baseTree) || (await git(["cat-file", "-e", `${baseTree}^{tree}`], root, env)).code !== 0) return undefined;
  return withTempIndex(home, async (index) => {
    const e = identityEnv(env, index);
    await gitOk(["read-tree", baseTree], root, e);
    if ((await git(["apply", "--cached", "--binary", patchPath], root, e)).code !== 0) return undefined;
    const tree = (await gitOk(["write-tree"], root, e)).trim();
    const commit = (await gitOk(["commit-tree", tree, "-p", head, "-m", `memento: 另一台设备上的改动（任务 ${id}）`], root, identityEnv(env))).trim();
    const branch = `memento/${id}`;
    await gitOk(["branch", "-f", branch, commit], root, env);
    return branch;
  });
}

// ── on the device that runs the agent ────────────────────────────────────

/** Where a source directory's clone lives on this device: one per (source device, directory). */
export function mirrorBase(sourceDeviceId: string, sourcePath: string, home?: string): string {
  const key = createHash("sha256").update(`${sourceDeviceId}\n${sourcePath}`).digest("hex").slice(0, 12);
  return join(memento(home), "workspaces", key);
}

function repoName(root: string): string {
  // Windows paths arrive as they are on the source: take the last segment either way
  const name = basename(root.replaceAll("\\", "/").replace(/\/+$/, "")) || "repo";
  return name.replace(/[^\w.\-一-鿿]/g, "_") || "repo";
}

async function findMirror(base: string): Promise<string | undefined> {
  try {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(base, entry.name, ".git"))) return join(base, entry.name);
    }
  } catch {}
  return undefined;
}

/** Commits the executor's clone holds, so the source leaves them out of the bundle. */
export async function mirrorHave(base: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const dir = await findMirror(base);
  if (!dir) return [];
  const out = await git(["for-each-ref", "--format=%(objectname)", "refs/memento/snapshot", "refs/memento/base"], dir, env);
  return out.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export interface Mirror {
  root: string;
  workDir: string;
  baseTree: string;
  snapshot: string;
  head: string;
  branch: string;
}

/**
 * Resets the clone under `base` to the source's snapshot, with the source's HEAD and branch: the
 * agent sees the same `git status` and `git log` as the user would on the source. Files .gitignore
 * leaves out (node_modules, build output) stay from the last run, so installs aren't redone.
 */
export async function prepareMirror(
  base: string,
  info: Pick<ExportResult, "head" | "branch" | "snapshot" | "tree" | "root" | "rel" | "upToDate">,
  bundleFile: string | undefined,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<Mirror> {
  const { env } = options;
  const root = (await findMirror(base)) ?? join(base, repoName(info.root));
  if (!existsSync(join(root, ".git"))) {
    await mkdir(root, { recursive: true });
    await gitOk(["init", "-q"], root, env);
    // The source's own line endings are in the blobs; checking out unchanged keeps the patch clean
    await gitOk(["config", "core.autocrlf", "false"], root, env);
  }
  if (!info.upToDate) {
    if (!bundleFile) throw new WorkspaceError("没有拿到源设备的代码包");
    const fetched = await git(["fetch", "-q", "--no-tags", bundleFile, "+refs/memento/snapshot:refs/memento/snapshot"], root, env);
    if (fetched.code !== 0) {
      const missing = /prerequisite|lacks|not found|missing/i.test(fetched.stderr);
      throw new WorkspaceError(`取回源设备代码失败：${fetched.stderr.trim().slice(0, 600)}`, missing ? "missing_base" : "failed");
    }
  }
  const snap = (await git(["rev-parse", "--verify", "-q", "refs/memento/snapshot"], root, env)).stdout.trim();
  if (snap !== info.snapshot) throw new WorkspaceError("执行机上的代码副本和源设备对不上，重新拉取", "missing_base");

  await gitOk(["clean", "-fdq"], root, env);
  await gitOk(["checkout", "-q", "-f", "--detach", info.snapshot], root, env);
  if (info.branch) {
    await gitOk(["update-ref", `refs/heads/${info.branch}`, info.head], root, env);
    await gitOk(["symbolic-ref", "HEAD", `refs/heads/${info.branch}`], root, env);
  } else {
    await gitOk(["update-ref", "--no-deref", "HEAD", info.head], root, env);
  }
  // Index back to HEAD, files stay as in the snapshot: the source's uncommitted edits show as such here too
  await gitOk(["reset", "-q"], root, env);
  await gitOk(["update-ref", "refs/memento/base", info.head], root, env);
  const workDir = info.rel ? join(root, ...info.rel.split("/")) : root;
  if (info.rel) await mkdir(workDir, { recursive: true });
  return { root, workDir, baseTree: info.tree, snapshot: info.snapshot, head: info.head, branch: info.branch };
}

/** Largest patch sent back in one go (gzip-compressed). */
export const PATCH_LIMIT = 10 * 1024 * 1024;

export interface MirrorPatch {
  /** Empty: the agent changed nothing. */
  patch: Buffer;
  files: AppliedFile[];
  tree: string;
}

/** What the agent changed in the clone, as a binary patch against the snapshot it started from. */
export async function mirrorPatch(mirror: Pick<Mirror, "root" | "baseTree">, options: { env?: NodeJS.ProcessEnv; home?: string } = {}): Promise<MirrorPatch> {
  const { env, home } = options;
  const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], mirror.root, env)).stdout.trim() || mirror.baseTree;
  const tree = await workingTree(mirror.root, env, home, head);
  if (tree === mirror.baseTree) return { patch: Buffer.alloc(0), files: [], tree };
  const patch = await gitBytes(["diff", "--binary", "--full-index", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", mirror.baseTree, tree], mirror.root, env);
  const files = parseNameStatus(await gitOk(["diff-tree", "-r", "--no-renames", "--name-status", "-z", mirror.baseTree, tree], mirror.root, env));
  return { patch, files, tree };
}

export async function packPatch(patch: Buffer): Promise<string> {
  return (await gzipAsync(patch)).toString("base64");
}

export async function unpackPatch(b64: string): Promise<Buffer> {
  return gunzipAsync(Buffer.from(b64, "base64"));
}

// ── patches the source couldn't take yet (it was offline) ────────────────

export interface PendingPatch {
  taskId: string;
  sourceDeviceId: string;
  sourcePath: string;
  baseTree: string;
  mode: "apply" | "save";
  patchFile: string;
  createdAt: string;
}

const PENDING = (home?: string) => join(memento(home), "workspaces", "pending");

export async function savePending(p: Omit<PendingPatch, "patchFile" | "createdAt">, patch: Buffer, home?: string): Promise<PendingPatch> {
  const dir = PENDING(home);
  await mkdir(dir, { recursive: true });
  const id = p.taskId.replaceAll("-", "").slice(0, 12) || randomBytes(6).toString("hex");
  const patchFile = join(dir, `${id}.patch`);
  await writeFile(patchFile, patch);
  const entry: PendingPatch = { ...p, patchFile, createdAt: new Date().toISOString() };
  await writeFile(join(dir, `${id}.json`), JSON.stringify(entry, null, 2));
  return entry;
}

export async function listPending(home?: string): Promise<PendingPatch[]> {
  const dir = PENDING(home);
  const out: PendingPatch[] = [];
  try {
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const p = JSON.parse(await readFile(join(dir, name), "utf8")) as PendingPatch;
        if (p.taskId && existsSync(p.patchFile)) out.push(p);
      } catch {}
    }
  } catch {}
  return out;
}

export async function dropPending(p: PendingPatch, home?: string): Promise<void> {
  const id = basename(p.patchFile, ".patch");
  await rm(join(PENDING(home), `${id}.json`), { force: true });
  await rm(p.patchFile, { force: true });
}
