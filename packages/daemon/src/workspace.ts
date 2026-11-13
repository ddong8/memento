import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, sep } from "node:path";
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

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string | Buffer, timeoutMs?: number): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, env, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "utf8", ...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}) },
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

export async function repoOf(dir: string, env?: NodeJS.ProcessEnv): Promise<{ root: string; rel: string }> {
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
  /** Where the branch's upstream is (`main@{upstream}`), so the clone's stand-in remote starts there. */
  upstream?: string;
  /** Whom the agent's commits are by: the user's git identity on the source. */
  userName?: string;
  userEmail?: string;
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

  const config = async (key: string) => (await git(["config", "--get", key], root, env)).stdout.trim();
  const upstream = branch ? (await git(["rev-parse", "--verify", "-q", `${branch}@{upstream}^{commit}`], root, env)).stdout.trim() : "";
  const base = { head, branch, snapshot, tree, root, rel, upstream, userName: await config("user.name"), userEmail: await config("user.email") };
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

export interface CarriedCommit {
  sha: string;
  subject: string;
}

/** Commits the agent made on the executor, sent along with the patch. */
export interface IncomingCommits {
  /** git bundle of `baseHead..head` under refs/memento/result; empty when the agent only pushed. */
  bundle: Buffer;
  head: string;
  /** The source's HEAD the executor started from. */
  baseHead: string;
  /** Branch the agent committed on: the source's branch then ("" on a detached HEAD). */
  branch: string;
  /** The agent pushed: push the branch from the source, which holds the credentials. */
  push: boolean;
}

export interface PushResult {
  /** `skipped`: asked for, but the commits didn't land on the branch (so nothing to push from it). */
  status: "pushed" | "rejected" | "failed" | "skipped";
  remote?: string;
  branch?: string;
  detail?: string;
  /** Put on top of this many commits the remote got meanwhile, then pushed. */
  rebased?: number;
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
  /** The agent's commits, newest first, as they are on the source now. */
  commits?: CarriedCommit[];
  /** `branch`: the source's branch now ends in them; `kept`: they're on `commitBranch` only. */
  committed?: "branch" | "kept";
  commitBranch?: string;
  /** The commits came along but couldn't be taken in. */
  commitsError?: string;
  push?: PushResult;
}

function parseNameStatus(out: string): AppliedFile[] {
  const parts = out.split("\0").filter(Boolean);
  const files: AppliedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]!.charAt(0), path: parts[i + 1]! });
  return files;
}

const SHA = /^[0-9a-f]{40,64}$/;
const tail = (s: string, n = 600) => s.trim().slice(-n);

async function commitList(root: string, range: string, env?: NodeJS.ProcessEnv): Promise<CarriedCommit[]> {
  const out = (await git(["log", "--format=%H%x1f%s", "-n", "200", range], root, env)).stdout;
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split("\x1f");
      return { sha: sha!, subject: subject ?? "" };
    });
}

/** The executor's commits into the source's object store, under a ref of their own until they land. */
async function fetchCommits(root: string, patchDir: string, id: string, c: IncomingCommits, env?: NodeJS.ProcessEnv): Promise<{ ref?: string; error?: string }> {
  if (!SHA.test(c.head) || !SHA.test(c.baseHead)) return { error: "提交信息不完整" };
  if (!c.bundle.length) return c.head === c.baseHead ? {} : { error: "提交包是空的" };
  const file = join(patchDir, `${id}.bundle`);
  await writeFile(file, c.bundle);
  const ref = `refs/memento/incoming/${id}`;
  const r = await git(["fetch", "-q", "--no-tags", file, `+refs/memento/result:${ref}`], root, env);
  await rm(file, { force: true }).catch(() => {});
  if (r.code !== 0) return { error: `取回提交失败：${tail(r.stderr)}` };
  const got = (await git(["rev-parse", "--verify", "-q", ref], root, env)).stdout.trim();
  if (got !== c.head) return { error: "取回的提交和执行机上的对不上" };
  return { ref };
}

/** Index entries of what `from..to` changed set to `to`: the files are already right, `git status` then shows only what's uncommitted. */
async function indexTo(root: string, from: string, to: string, env?: NodeJS.ProcessEnv): Promise<AppliedFile[]> {
  const files = parseNameStatus(await gitOk(["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to], root, env));
  if (files.length) {
    await gitOk(["reset", "-q", to, "--pathspec-from-file=-", "--pathspec-file-nul"], root, env, files.map((f) => f.path).join("\0") + "\0");
  }
  return files;
}

/**
 * Applies an executor's patch to the working tree of `dir`, and the commits the agent made to its
 * branch. `mode: "save"` only keeps them (a task that failed or was stopped): the user decides.
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
    commits?: IncomingCommits;
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
  const listed = options.files ?? (patch.length ? await patchFiles(root, patchPath, env) : []);

  const c = options.commits;
  let incoming: string | undefined;
  let commits: CarriedCommit[] | undefined;
  let commitsError: string | undefined;
  let fetchedRef: string | undefined;
  if (c) {
    const got = await fetchCommits(root, patchDir, id, c, env);
    if (got.error) commitsError = got.error;
    else {
      fetchedRef = got.ref;
      if (got.ref) {
        incoming = c.head;
        commits = await commitList(root, `${c.baseHead}..${c.head}`, env);
      }
    }
  }
  const keep = `memento/${id}`;
  const done = async (r: ApplyResult): Promise<ApplyResult> => {
    if (fetchedRef) await git(["update-ref", "-d", fetchedRef], root, env);
    return {
      ...r,
      ...(commits ? { commits } : {}),
      ...(commitsError ? { commitsError } : {}),
      ...(c?.push && !r.push
        ? {
            push: {
              status: "skipped" as const,
              detail: r.committed === "kept" ? `提交放在了分支 ${r.commitBranch}，没有推送` : commitsError ? "提交没能取回，没有推送" : "改动没有写进来，没有推送",
            },
          }
        : {}),
    };
  };

  if (options.mode === "save") {
    if (!incoming) return done({ applied: false, files: listed, patchPath });
    await gitOk(["branch", "-f", keep, incoming], root, env);
    return done({ applied: false, files: listed, patchPath, committed: "kept", commitBranch: keep });
  }

  const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], root, env)).stdout.trim();
  if (!head) throw new WorkspaceError("源仓库没有提交，无法应用改动");

  let files: AppliedFile[] = [];
  if (patch.length) {
    const put = await withTempIndex(home, async (index) => {
      const e = identityEnv(env, index);
      await gitOk(["read-tree", head], root, e);
      await gitOk(["add", "-A", "--", "."], root, e);
      const now = (await gitOk(["write-tree"], root, e)).trim();
      const r = await git(["apply", "--cached", "--binary", patchPath], root, e);
      if (r.code !== 0) return { error: r.stderr.trim().slice(0, 800) };
      const after = (await gitOk(["write-tree"], root, e)).trim();
      const changed = parseNameStatus(await gitOk(["diff-tree", "-r", "--no-renames", "--name-status", "-z", now, after], root, env));
      const write = changed.filter((f) => f.status !== "D").map((f) => f.path);
      if (write.length) await gitOk(["checkout-index", "-f", "-z", "--stdin"], root, e, write.join("\0") + "\0");
      for (const f of changed) {
        if (f.status !== "D") continue;
        await unlink(join(root, f.path)).catch(() => {});
      }
      return { files: changed };
    });
    if (put.error !== undefined) {
      // The files moved on since the snapshot: keep the result on a branch, overwrite nothing
      const branch = await keepOnBranch(root, patchPath, baseTree, incoming ?? head, id, env, home);
      if (!branch && incoming) await gitOk(["branch", "-f", keep, incoming], root, env);
      const kept = branch ?? (incoming ? keep : undefined);
      return done({
        applied: false,
        conflict: true,
        ...(kept ? { branch: kept } : {}),
        files: listed,
        patchPath,
        error: put.error,
        ...(incoming ? { committed: "kept" as const, commitBranch: kept } : {}),
      });
    }
    files = put.files!;
  }
  if (!c || commitsError) return done({ applied: true, files, patchPath });

  // The commits: onto the branch when the source is still where the executor started from
  const now = (await git(["rev-parse", "--verify", "-q", "HEAD"], root, env)).stdout.trim();
  const onBranch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], root, env)).stdout.trim();
  const target = incoming ?? c.baseHead;
  if (now !== c.baseHead || onBranch !== c.branch) {
    if (!incoming) return done({ applied: true, files, patchPath, push: { status: "skipped", detail: "源设备上的分支在运行期间变了，没有推送" } });
    await gitOk(["branch", "-f", keep, incoming], root, env);
    return done({ applied: true, files, patchPath, committed: "kept", commitBranch: keep });
  }
  if (incoming) {
    const move = c.branch
      ? ["update-ref", "-m", "memento: 另一台设备上的提交", `refs/heads/${c.branch}`, incoming, c.baseHead]
      : ["update-ref", "--no-deref", "-m", "memento: 另一台设备上的提交", "HEAD", incoming, c.baseHead];
    if ((await git(move, root, env)).code !== 0) {
      await gitOk(["branch", "-f", keep, incoming], root, env);
      return done({ applied: true, files, patchPath, committed: "kept", commitBranch: keep });
    }
    // The commits are in; an index git won't let us update (a lock, say) only leaves them showing as staged reverts
    const touched = await indexTo(root, c.baseHead, incoming, env).catch(() => undefined);
    if (!patch.length) files = touched ?? parseNameStatus((await git(["diff-tree", "-r", "--no-renames", "--name-status", "-z", c.baseHead, incoming], root, env)).stdout);
  }
  const r: ApplyResult = { applied: true, files, patchPath, ...(incoming ? { committed: "branch" as const, ...(c.branch ? { commitBranch: c.branch } : {}) } : {}) };
  if (c.push) {
    if (!c.branch) r.push = { status: "skipped", detail: "源设备上是游离的 HEAD，没有分支可推送" };
    else {
      const pushed = await pushBranch(root, c.branch, target, env).catch((e: unknown) => ({
        result: { status: "failed" as const, branch: c.branch, detail: e instanceof Error ? e.message : String(e) },
        rebased: undefined,
      }));
      r.push = pushed.result;
      if (pushed.rebased && commits) {
        // Same commits, put on top of the remote's: their ids changed
        const now = await commitList(root, `${pushed.rebased.onto}..${pushed.rebased.head}`, env);
        if (now.length === commits.length) commits = now;
      }
    }
  }
  return done(r);
}

/** Each network step of a push may take this long: the whole apply has to answer within the relay's timeout. */
const NET_TIMEOUT = 60_000;

/** Pushes `branch` from the source, the way `git push` there would: its upstream (or push remote), its credentials. */
async function pushBranch(
  root: string,
  branch: string,
  head: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ result: PushResult; rebased?: { onto: string; head: string } }> {
  const cfg = async (key: string) => (await git(["config", "--get", key], root, env)).stdout.trim();
  const upRemote = await cfg(`branch.${branch}.remote`);
  const remote = (await cfg(`branch.${branch}.pushRemote`)) || (await cfg("remote.pushDefault")) || upRemote || "origin";
  if ((await git(["remote", "get-url", remote], root, env)).code !== 0) {
    return { result: { status: "failed", remote, branch, detail: `仓库没有远端 ${remote}` } };
  }
  const merge = await cfg(`branch.${branch}.merge`);
  const dst = remote === upRemote && merge.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : branch;
  const e = { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" };
  const base = { remote, branch: dst };
  const push = () => git(["push", "--porcelain", remote, `refs/heads/${branch}:refs/heads/${dst}`], root, e, undefined, NET_TIMEOUT);

  let r = await push();
  if (r.code === 0) return { result: { status: "pushed", ...base } };
  const why = `${r.stdout}\n${r.stderr}`;
  if (!/rejected|non-fast-forward|fetch first/i.test(why)) {
    return { result: { status: "failed", ...base, detail: tail(r.stderr || r.stdout) || "推送超时" } };
  }
  // The remote got commits meanwhile (CI bumping versions, say): put ours on top, as `git pull --rebase` would
  const moved = await rebaseOnRemote(root, branch, head, remote, dst, e);
  if (typeof moved === "string") return { result: { status: "rejected", ...base, detail: moved } };
  r = await push();
  if (r.code === 0) return { result: { status: "pushed", ...base, rebased: moved.behind }, rebased: moved };
  return { result: { status: "rejected", ...base, detail: tail(r.stderr || r.stdout) }, rebased: moved };
}

/**
 * Replays the local commits of `branch` (at `head`, checked out) on top of the remote's, without
 * touching anything the user is working on: only when it applies cleanly and the remote's changes
 * hit no file with uncommitted edits. Returns why not otherwise.
 */
async function rebaseOnRemote(
  root: string,
  branch: string,
  head: string,
  remote: string,
  dst: string,
  env: NodeJS.ProcessEnv,
): Promise<{ onto: string; head: string; behind: number } | string> {
  const manual = `在源设备上 git pull --rebase 后再推送`;
  const f = await git(["fetch", "-q", "--no-tags", remote, `refs/heads/${dst}`], root, env, undefined, NET_TIMEOUT);
  if (f.code !== 0) return `远端有新提交，取回失败：${tail(f.stderr) || "超时"}`;
  const theirs = (await gitOk(["rev-parse", "FETCH_HEAD^{commit}"], root, env)).trim();
  const mb = (await git(["merge-base", head, theirs], root, env)).stdout.trim();
  if (!mb) return `本地分支和远端没有共同的历史，${manual}`;
  if (mb === theirs) return "远端拒绝了推送";
  if ((await gitOk(["rev-list", "--min-parents=2", `${mb}..${head}`], root, env)).trim()) return `本地有合并提交，${manual}`;
  const picks = (await gitOk(["rev-list", "--reverse", `${mb}..${head}`], root, env)).split("\n").filter(Boolean);
  const behind = Number((await gitOk(["rev-list", "--count", `${mb}..${theirs}`], root, env)).trim()) || 0;

  let onto = theirs;
  for (const pick of picks) {
    const m = await git(["merge-tree", "--write-tree", "--merge-base", `${pick}^`, onto, pick], root, env);
    if (m.code === 1) return `远端的新提交和本地提交改到了同一处，${manual}`;
    if (m.code !== 0) return `这台设备的 git 不支持自动变基（需要 2.38 以上），${manual}`;
    const tree = m.stdout.split("\n")[0]!.trim();
    const [name, email, date] = (await gitOk(["show", "-s", "--format=%an%x00%ae%x00%ad", "--date=raw", pick], root, env)).trim().split("\0");
    const message = await gitBytes(["show", "-s", "--format=%B", pick], root, env);
    const made = await git(["commit-tree", tree, "-p", onto, "-F", "-"], root, { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date }, message);
    if (made.code !== 0) return `变基时生成提交失败：${tail(made.stderr)}`;
    onto = made.stdout.trim();
  }

  // What the remote changed comes into the working tree too: only into files nobody is editing here
  const changed = parseNameStatus(await gitOk(["diff-tree", "-r", "--no-renames", "--name-status", "-z", head, onto], root, env));
  const status = (await gitOk(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], root, env)).split("\0");
  const dirty = new Set(status.filter((s) => s.length > 3).map((s) => s.slice(3)));
  const busy = changed.filter((f) => dirty.has(f.path)).map((f) => f.path);
  if (busy.length) return `远端的新提交改到了源设备上正在修改的 ${busy.slice(0, 3).join("、")}，${manual}`;
  if ((await git(["update-ref", "-m", "memento: 推送前变基到远端最新提交", `refs/heads/${branch}`, onto, head], root, env)).code !== 0) {
    return `源设备上的分支刚刚变了，${manual}`;
  }
  await indexTo(root, head, onto, env);
  const write = changed.filter((f) => f.status !== "D").map((f) => f.path);
  if (write.length) await gitOk(["checkout-index", "-f", "-z", "--stdin"], root, env, write.join("\0") + "\0");
  for (const f of changed) if (f.status === "D") await unlink(join(root, f.path)).catch(() => {});
  return { onto: theirs, head: onto, behind };
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
  parent: string,
  id: string,
  env: NodeJS.ProcessEnv | undefined,
  home: string | undefined,
): Promise<string | undefined> {
  if (!SHA.test(baseTree) || (await git(["cat-file", "-e", `${baseTree}^{tree}`], root, env)).code !== 0) return undefined;
  return withTempIndex(home, async (index) => {
    const e = identityEnv(env, index);
    await gitOk(["read-tree", baseTree], root, e);
    if ((await git(["apply", "--cached", "--binary", patchPath], root, e)).code !== 0) return undefined;
    const tree = (await gitOk(["write-tree"], root, e)).trim();
    const commit = (await gitOk(["commit-tree", tree, "-p", parent, "-m", `memento: 另一台设备上的改动（任务 ${id}）`], root, identityEnv(env))).trim();
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
  /** The stand-in remote the agent pushes to (a bare repository next to the clone), and where its branch started. */
  remote?: string;
  pushStart?: string;
}

/**
 * Resets the clone under `base` to the source's snapshot, with the source's HEAD and branch: the
 * agent sees the same `git status` and `git log` as the user would on the source. Files .gitignore
 * leaves out (node_modules, build output) stay from the last run, so installs aren't redone.
 */
export async function prepareMirror(
  base: string,
  info: Pick<ExportResult, "head" | "branch" | "snapshot" | "tree" | "root" | "rel" | "upToDate" | "upstream" | "userName" | "userEmail">,
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
  // The agent commits as the user does on the source
  if (info.userName) await gitOk(["config", "user.name", info.userName], root, env);
  if (info.userEmail) await gitOk(["config", "user.email", info.userEmail], root, env);
  const remote = await standInRemote(root, info, env);
  const workDir = info.rel ? join(root, ...info.rel.split("/")) : root;
  if (info.rel) await mkdir(workDir, { recursive: true });
  return { root, workDir, baseTree: info.tree, snapshot: info.snapshot, head: info.head, branch: info.branch, ...remote };
}

/**
 * The clone's `origin`: a bare repository next to it, its branch where the source's upstream is.
 * The executor holds no credentials, so `git push` goes there; that it moved is what tells the
 * source to push for real afterwards.
 */
async function standInRemote(root: string, info: Pick<ExportResult, "head" | "branch" | "upstream">, env?: NodeJS.ProcessEnv): Promise<{ remote?: string; pushStart?: string }> {
  if (!info.branch) return {};
  const dir = join(dirname(root), "origin.git");
  if (!existsSync(join(dir, "HEAD"))) {
    await mkdir(dir, { recursive: true });
    await gitOk(["init", "-q", "--bare", dir], root, env);
  }
  // Shares the clone's objects: nothing gets copied, pushes only add the new commits
  await mkdir(join(dir, "objects", "info"), { recursive: true });
  await writeFile(join(dir, "objects", "info", "alternates"), `${join(root, ".git", "objects")}\n`);
  const upstream = info.upstream && SHA.test(info.upstream) && (await git(["cat-file", "-e", `${info.upstream}^{commit}`], root, env)).code === 0;
  const start = upstream ? info.upstream! : info.head;
  const ref = `refs/heads/${info.branch}`;
  await gitOk(["--git-dir", dir, "update-ref", ref, start], root, env);
  await gitOk(["--git-dir", dir, "symbolic-ref", "HEAD", ref], root, env);
  await gitOk(["config", "remote.origin.url", dir], root, env);
  await gitOk(["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], root, env);
  await gitOk(["update-ref", `refs/remotes/origin/${info.branch}`, start], root, env);
  await gitOk(["config", `branch.${info.branch}.remote`, "origin"], root, env);
  await gitOk(["config", `branch.${info.branch}.merge`, ref], root, env);
  return { remote: dir, pushStart: start };
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

export interface MirrorCommits {
  /** What to send along; absent when there is nothing (the agent didn't commit or push). */
  commits?: { bundle: Buffer; head: string; baseHead: string; branch: string; push: boolean; count: number };
  /** Why commits it did make don't go back as commits (the files still do, in the patch). */
  note?: string;
}

/** The commits the agent made on top of the source's HEAD, and whether it pushed them. */
export async function mirrorCommits(mirror: Pick<Mirror, "root" | "head" | "branch" | "remote" | "pushStart">, options: { env?: NodeJS.ProcessEnv; home?: string } = {}): Promise<MirrorCommits> {
  const { env, home } = options;
  const root = mirror.root;
  const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], root, env)).stdout.trim();
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], root, env)).stdout.trim();
  let push = false;
  if (mirror.remote && mirror.branch && mirror.pushStart && existsSync(mirror.remote)) {
    const at = (await git(["--git-dir", mirror.remote, "rev-parse", "--verify", "-q", `refs/heads/${mirror.branch}`], root, env)).stdout.trim();
    push = !!at && at !== mirror.pushStart;
  }
  if (!head || head === mirror.head) {
    return push ? { commits: { bundle: Buffer.alloc(0), head: mirror.head, baseHead: mirror.head, branch: mirror.branch, push, count: 0 } } : {};
  }
  if (branch !== mirror.branch) {
    return { note: branch ? `智能体切到了分支 ${branch} 上提交，只带回了文件改动` : "智能体在游离的 HEAD 上提交，只带回了文件改动" };
  }
  if ((await git(["merge-base", "--is-ancestor", mirror.head, head], root, env)).code !== 0) {
    return { note: "智能体改写了已有的提交历史（rebase / reset），只带回了文件改动" };
  }
  const count = Number((await gitOk(["rev-list", "--count", `${mirror.head}..${head}`], root, env)).trim()) || 0;
  await gitOk(["update-ref", "refs/memento/result", head], root, env);
  const dir = join(memento(home), "tmp");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `commits-${randomBytes(6).toString("hex")}.bundle`);
  try {
    await gitOk(["bundle", "create", "-q", file, "refs/memento/result", `^${mirror.head}`], root, env);
    const bundle = await readFile(file);
    return { commits: { bundle, head, baseHead: mirror.head, branch: mirror.branch, push, count } };
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

/** The `commits` field of an apply request, as the executor sends it. */
export function commitsMessage(c: IncomingCommits): Record<string, unknown> {
  return { bundle_b64: c.bundle.toString("base64"), head: c.head, base_head: c.baseHead, branch: c.branch, push: c.push };
}

/** The source's side of an apply request (what `workspace_apply_req` carries), answered with the reply's fields. */
export async function applyWorkspaceRequest(
  dir: string,
  data: Record<string, unknown>,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<{ result: ApplyResult; reply: Record<string, unknown> }> {
  const patch = await unpackPatch(String(data.patch_b64 ?? ""));
  const files = Array.isArray(data.files) ? (data.files as AppliedFile[]).filter((f) => f && typeof f.path === "string") : undefined;
  const raw = data.commits && typeof data.commits === "object" ? (data.commits as Record<string, unknown>) : undefined;
  const commits: IncomingCommits | undefined = raw
    ? {
        bundle: Buffer.from(String(raw.bundle_b64 ?? ""), "base64"),
        head: String(raw.head ?? ""),
        baseHead: String(raw.base_head ?? ""),
        branch: String(raw.branch ?? ""),
        push: raw.push === true,
      }
    : undefined;
  const r = await applyWorkspacePatch(dir, patch, {
    taskId: String(data.task_id ?? ""),
    baseTree: String(data.base_tree ?? ""),
    mode: data.mode === "save" ? "save" : "apply",
    ...(files?.length ? { files } : {}),
    ...(commits ? { commits } : {}),
    ...options,
  });
  return {
    result: r,
    reply: {
      applied: r.applied,
      conflict: r.conflict === true,
      ...(r.branch ? { branch: r.branch } : {}),
      files: r.files.slice(0, 200),
      patch_path: r.patchPath,
      ...(r.error ? { detail: r.error } : {}),
      ...(r.commits ? { commits: r.commits.slice(0, 50) } : {}),
      ...(r.committed ? { committed: r.committed } : {}),
      ...(r.commitBranch ? { commit_branch: r.commitBranch } : {}),
      ...(r.commitsError ? { commits_error: r.commitsError } : {}),
      ...(r.push ? { push: r.push } : {}),
    },
  };
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
  /** The agent's commits that go with the patch (absent from older daemons' entries). */
  commits?: { file: string; head: string; baseHead: string; branch: string; push: boolean };
}

const PENDING = (home?: string) => join(memento(home), "workspaces", "pending");

export async function savePending(
  p: Omit<PendingPatch, "patchFile" | "createdAt" | "commits">,
  patch: Buffer,
  home?: string,
  commits?: IncomingCommits,
): Promise<PendingPatch> {
  const dir = PENDING(home);
  await mkdir(dir, { recursive: true });
  const id = p.taskId.replaceAll("-", "").slice(0, 12) || randomBytes(6).toString("hex");
  const patchFile = join(dir, `${id}.patch`);
  await writeFile(patchFile, patch);
  const entry: PendingPatch = { ...p, patchFile, createdAt: new Date().toISOString() };
  if (commits) {
    const file = join(dir, `${id}.commits.bundle`);
    await writeFile(file, commits.bundle);
    entry.commits = { file, head: commits.head, baseHead: commits.baseHead, branch: commits.branch, push: commits.push };
  }
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
  if (p.commits?.file) await rm(p.commits.file, { force: true });
}
