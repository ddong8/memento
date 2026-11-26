import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";

const CHECKPOINT_PREFIX = "refs/memento/checkpoints/";
const SAFE_REF_RE = /^(?:HEAD|refs\/memento\/checkpoints\/[A-Za-z0-9._/-]+|[0-9a-fA-F]{7,40})$/;
const SAFE_CHECKPOINT_REF_RE = /^refs\/memento\/checkpoints\/[A-Za-z0-9._/-]+$/;
const MAX_CHECKPOINTS_PER_REPO = 80;
const MAX_DIFF_BYTES_PER_FILE = 180 * 1024;
const MAX_TOTAL_DIFF_BYTES = 1_200 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 128 * 1024;

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCmd(bin: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<CmdResult> {
  return new Promise((done) => {
    execFile(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 24 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<CmdResult> {
  return runCmd("git", ["-c", "core.quotePath=false", ...args], cwd, env, timeoutMs);
}

export interface CheckpointFileStat {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface CheckpointEventPayload {
  kind: "checkpoint";
  id: string;
  status: "created";
  repo_root: string;
  branch: string;
  before_ref: string;
  after_ref: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  files: CheckpointFileStat[];
}

export interface GitDiffLine {
  type: "context" | "add" | "del";
  old_line: number | null;
  new_line: number | null;
  content: string;
}

export interface GitDiffHunk {
  header: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: GitDiffLine[];
}

export interface GitDiffFile {
  path: string;
  old_path?: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated?: boolean;
  hunks: GitDiffHunk[];
}

export interface GitCheckpointSummary {
  id: string;
  before_ref: string;
  after_ref: string;
  created_at?: string;
}

export interface GitDiffResponse {
  ok: boolean;
  error?: string;
  repo_root?: string;
  branch?: string;
  head_sha?: string;
  is_dirty?: boolean;
  base_ref?: string;
  target_ref?: string;
  total_files?: number;
  total_additions?: number;
  total_deletions?: number;
  truncated?: boolean;
  files?: GitDiffFile[];
  checkpoints?: GitCheckpointSummary[];
}

export interface GitRestoreResponse {
  ok: boolean;
  error?: string;
  repo_root?: string;
  branch?: string;
  restored_ref?: string;
  backup_ref?: string;
  files_restored?: number;
  files_removed?: number;
}

export interface GitDeliverResponse {
  ok: boolean;
  error?: string;
  repo_root?: string;
  branch?: string;
  commit_sha?: string;
  pushed?: boolean;
  push_output?: string;
  pr_url?: string;
  pr_error?: string;
  summary?: string;
}

async function resolveGitRepo(dir: string, env?: NodeJS.ProcessEnv): Promise<{ repoRoot: string; gitDir: string; branch: string; headSha: string } | null> {
  if (!dir || !existsSync(dir)) return null;
  const top = await git(["rev-parse", "--show-toplevel", "--git-dir"], dir, env, 10_000);
  if (top.code !== 0) return null;
  const lines = top.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const repoRoot = normalize(lines[0]!);
  const rawGitDir = lines[1]!;
  const gitDir = resolve(dir, rawGitDir);
  const br = await git(["symbolic-ref", "--short", "HEAD"], repoRoot, env, 5_000);
  const head = await git(["rev-parse", "--verify", "HEAD"], repoRoot, env, 5_000);
  return {
    repoRoot,
    gitDir,
    branch: br.code === 0 ? br.stdout.trim() : "HEAD",
    headSha: head.code === 0 ? head.stdout.trim() : "",
  };
}

/**
 * Captures the entire working tree (tracked edits + staged edits + non-ignored untracked files)
 * into a detached commit pointed to by a hidden Git ref (`refs/memento/checkpoints/...`),
 * using a temporary `GIT_INDEX_FILE` so the user's real index, HEAD, and branch are never touched.
 */
async function captureSnapshotRef(
  repoRoot: string,
  gitDir: string,
  refName: string,
  label: string,
  headSha: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ commitSha: string; treeSha: string } | null> {
  if (!SAFE_CHECKPOINT_REF_RE.test(refName)) return null;
  const tmpIndex = join(tmpdir(), `memento-git-idx-${process.pid}-${randomUUID().slice(0, 8)}`);
  try {
    const realIndex = join(gitDir, "index");
    if (existsSync(realIndex)) {
      await copyFile(realIndex, tmpIndex).catch(() => {});
    }
    const idxEnv: NodeJS.ProcessEnv = {
      ...(env ?? process.env),
      GIT_INDEX_FILE: tmpIndex,
      GIT_AUTHOR_NAME: "Memento Checkpoint",
      GIT_AUTHOR_EMAIL: "checkpoint@memento.local",
      GIT_COMMITTER_NAME: "Memento Checkpoint",
      GIT_COMMITTER_EMAIL: "checkpoint@memento.local",
    };
    const add = await git(["add", "-A", "--", "."], repoRoot, idxEnv, 20_000);
    if (add.code !== 0) return null;
    const wt = await git(["write-tree"], repoRoot, idxEnv, 15_000);
    if (wt.code !== 0) return null;
    const treeSha = wt.stdout.trim();
    if (!treeSha) return null;
    const commitArgs = ["commit-tree", treeSha, ...(headSha ? ["-p", headSha] : []), "-m", label];
    const ct = await git(commitArgs, repoRoot, idxEnv, 10_000);
    if (ct.code !== 0) return null;
    const commitSha = ct.stdout.trim();
    if (!commitSha) return null;
    const upd = await git(["update-ref", refName, commitSha], repoRoot, env, 10_000);
    if (upd.code !== 0) return null;
    return { commitSha, treeSha };
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

async function pruneOldCheckpoints(repoRoot: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const list = await git(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", CHECKPOINT_PREFIX],
    repoRoot,
    env,
    10_000,
  );
  if (list.code !== 0) return;
  const refs = list.stdout.trim().split(/\r?\n/).filter(Boolean);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const rest = r.slice(CHECKPOINT_PREFIX.length);
    const id = rest.split("/")[0];
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length <= MAX_CHECKPOINTS_PER_REPO) return;
  const toDrop = new Set(ids.slice(MAX_CHECKPOINTS_PER_REPO));
  for (const r of refs) {
    const id = r.slice(CHECKPOINT_PREFIX.length).split("/")[0];
    if (id && toDrop.has(id)) {
      await git(["update-ref", "-d", r], repoRoot, env, 5_000).catch(() => {});
    }
  }
}

async function listCheckpoints(repoRoot: string, env?: NodeJS.ProcessEnv): Promise<GitCheckpointSummary[]> {
  const list = await git(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname)\t%(committerdate:iso-strict)", CHECKPOINT_PREFIX],
    repoRoot,
    env,
    10_000,
  );
  if (list.code !== 0) return [];
  const byId = new Map<string, { before_ref?: string; after_ref?: string; created_at?: string }>();
  for (const line of list.stdout.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, dateStr] = line.split("\t");
    if (!ref?.startsWith(CHECKPOINT_PREFIX)) continue;
    const parts = ref.slice(CHECKPOINT_PREFIX.length).split("/");
    const id = parts[0];
    const kind = parts[1];
    if (!id || (kind !== "before" && kind !== "after")) continue;
    const entry = byId.get(id) ?? {};
    if (kind === "before") entry.before_ref = ref;
    if (kind === "after") {
      entry.after_ref = ref;
      if (dateStr) entry.created_at = dateStr;
    } else if (!entry.created_at && dateStr) {
      entry.created_at = dateStr;
    }
    byId.set(id, entry);
  }
  const out: GitCheckpointSummary[] = [];
  for (const [id, entry] of byId) {
    if (entry.before_ref && entry.after_ref) {
      out.push({ id, before_ref: entry.before_ref, after_ref: entry.after_ref, created_at: entry.created_at });
    }
  }
  return out.slice(0, 30);
}

/**
 * Turn-scoped hidden Git checkpoint: captures working tree before an agent runs, and emits a
 * compact diff summary + hidden before/after refs when the agent actually changed files.
 */
export class TurnCheckpoint {
  private constructor(
    readonly id: string,
    readonly repoRoot: string,
    readonly gitDir: string,
    readonly branch: string,
    readonly headSha: string,
    readonly beforeRef: string,
    readonly beforeTree: string,
  ) {}

  static async start(dir: string, taskId: string, env?: NodeJS.ProcessEnv): Promise<TurnCheckpoint | null> {
    const repo = await resolveGitRepo(dir, env);
    if (!repo) return null;
    const cleanId = taskId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || randomUUID().slice(0, 12);
    const id = `${Date.now().toString(36)}-${cleanId}`;
    const beforeRef = `${CHECKPOINT_PREFIX}${id}/before`;
    const snap = await captureSnapshotRef(repo.repoRoot, repo.gitDir, beforeRef, `memento checkpoint before ${id}`, repo.headSha, env);
    if (!snap) return null;
    return new TurnCheckpoint(id, repo.repoRoot, repo.gitDir, repo.branch, repo.headSha, beforeRef, snap.treeSha);
  }

  async finish(env?: NodeJS.ProcessEnv): Promise<CheckpointEventPayload | null> {
    const afterRef = `${CHECKPOINT_PREFIX}${this.id}/after`;
    const repoNow = await resolveGitRepo(this.repoRoot, env);
    const snap = await captureSnapshotRef(
      this.repoRoot,
      this.gitDir,
      afterRef,
      `memento checkpoint after ${this.id}`,
      repoNow?.headSha || this.headSha,
      env,
    );
    if (!snap) {
      await git(["update-ref", "-d", this.beforeRef], this.repoRoot, env, 5_000).catch(() => {});
      return null;
    }
    if (snap.treeSha === this.beforeTree) {
      await git(["update-ref", "-d", this.beforeRef], this.repoRoot, env, 5_000).catch(() => {});
      await git(["update-ref", "-d", afterRef], this.repoRoot, env, 5_000).catch(() => {});
      return null;
    }

    const [numstat, namestatus] = await Promise.all([
      git(["diff", "--numstat", "-M", this.beforeRef, afterRef], this.repoRoot, env, 15_000),
      git(["diff", "--name-status", "-M", this.beforeRef, afterRef], this.repoRoot, env, 15_000),
    ]);

    const statusByPath = new Map<string, string>();
    for (const line of namestatus.stdout.trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const rawStatus = parts[0]?.trim() || "M";
      const filePath = (parts[2] ?? parts[1] ?? "").trim();
      if (filePath) statusByPath.set(filePath, rawStatus.charAt(0));
    }

    const files: CheckpointFileStat[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.stdout.trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const add = parts[0] === "-" ? 0 : Number.parseInt(parts[0]!, 10) || 0;
      const del = parts[1] === "-" ? 0 : Number.parseInt(parts[1]!, 10) || 0;
      const rawPath = parts.slice(2).join("\t").trim();
      // Handle rename notation `{a => b}` or `old => new` cleanly by preferring namestatus path
      const path = rawPath.includes(" => ") ? rawPath.replace(/\{[^}]*=>\s*([^}]*)\}/g, "$1").split(" => ").pop()!.trim() : rawPath;
      insertions += add;
      deletions += del;
      files.push({
        path,
        status: statusByPath.get(path) ?? "M",
        additions: add,
        deletions: del,
      });
    }

    void pruneOldCheckpoints(this.repoRoot, env).catch(() => {});

    return {
      kind: "checkpoint",
      id: this.id,
      status: "created",
      repo_root: this.repoRoot,
      branch: repoNow?.branch || this.branch,
      before_ref: this.beforeRef,
      after_ref: afterRef,
      files_changed: files.length,
      insertions,
      deletions,
      files: files.slice(0, 60),
    };
  }
}

/** Parses standard `git diff --unified=3` output into structured per-file hunks & numbered lines. */
export function parseUnifiedDiff(raw: string): GitDiffFile[] {
  const files: GitDiffFile[] = [];
  if (!raw.trim()) return files;
  const lines = raw.split(/\r?\n/);
  let current: GitDiffFile | null = null;
  let currentHunk: GitDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let fileBytes = 0;

  const flushHunk = () => {
    if (current && currentHunk) {
      current.hunks.push(currentHunk);
      currentHunk = null;
    }
  };
  const flushFile = () => {
    flushHunk();
    if (current) {
      files.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const oldP = m?.[1]?.replace(/^"|"$/g, "") ?? "";
      const newP = m?.[2]?.replace(/^"|"$/g, "") ?? "";
      current = {
        path: newP || oldP,
        ...(oldP && newP && oldP !== newP ? { old_path: oldP } : {}),
        status: "M",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      fileBytes = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode ")) {
      current.status = "A";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.status = "D";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "R";
      current.old_path = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.status = "R";
      current.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || line.startsWith("similarity index ") || line.startsWith("old mode ") || line.startsWith("new mode ")) {
      continue;
    }
    if (line.startsWith("@@ ")) {
      flushHunk();
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (hm) {
        oldLine = Number.parseInt(hm[1]!, 10);
        const oldCount = hm[2] !== undefined ? Number.parseInt(hm[2], 10) : 1;
        newLine = Number.parseInt(hm[3]!, 10);
        const newCount = hm[4] !== undefined ? Number.parseInt(hm[4], 10) : 1;
        currentHunk = {
          header: line,
          old_start: oldLine,
          old_lines: oldCount,
          new_start: newLine,
          new_lines: newCount,
          lines: [],
        };
      }
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;

    fileBytes += line.length + 1;
    if (fileBytes > MAX_DIFF_BYTES_PER_FILE) {
      current.truncated = true;
      continue;
    }

    if (line.startsWith("+")) {
      current.additions++;
      currentHunk.lines.push({ type: "add", old_line: null, new_line: newLine++, content: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.deletions++;
      currentHunk.lines.push({ type: "del", old_line: oldLine++, new_line: null, content: line.slice(1) });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", old_line: oldLine++, new_line: newLine++, content: line.slice(1) });
    }
  }
  flushFile();
  return files;
}

/** Synthesizes a structured diff entry for an untracked file in the working tree. */
async function buildUntrackedFileDiff(repoRoot: string, relPath: string): Promise<GitDiffFile> {
  const fullPath = join(repoRoot, relPath);
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) {
      return { path: relPath, status: "?", additions: 0, deletions: 0, binary: false, hunks: [] };
    }
    if (info.size > MAX_UNTRACKED_FILE_BYTES) {
      return { path: relPath, status: "A", additions: 0, deletions: 0, binary: false, truncated: true, hunks: [] };
    }
    const buf = await readFile(fullPath);
    // Heuristic binary check: NUL byte in first 4KB
    const sample = buf.subarray(0, Math.min(buf.length, 4096));
    if (sample.includes(0)) {
      return { path: relPath, status: "A", additions: 0, deletions: 0, binary: true, hunks: [] };
    }
    const text = buf.toString("utf8");
    const rawLines = text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
    const diffLines: GitDiffLine[] = rawLines.map((content, idx) => ({
      type: "add",
      old_line: null,
      new_line: idx + 1,
      content,
    }));
    return {
      path: relPath,
      status: "A",
      additions: diffLines.length,
      deletions: 0,
      binary: false,
      hunks: diffLines.length
        ? [{ header: `@@ -0,0 +1,${diffLines.length} @@ (new file)`, old_start: 0, old_lines: 0, new_start: 1, new_lines: diffLines.length, lines: diffLines }]
        : [],
    };
  } catch {
    return { path: relPath, status: "A", additions: 0, deletions: 0, binary: false, hunks: [] };
  }
}

/** Returns parsed per-file unified diffs for a checkpoint pair or the live working tree. */
export async function getGitDiff(params: {
  cwd: string;
  baseRef?: string;
  targetRef?: string;
  filePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GitDiffResponse> {
  const repo = await resolveGitRepo(params.cwd, params.env);
  if (!repo) return { ok: false, error: "当前目录不是 Git 仓库" };

  const baseRef = params.baseRef?.trim() || "";
  const targetRef = params.targetRef?.trim() || "";
  if (baseRef && !SAFE_REF_RE.test(baseRef)) return { ok: false, error: `非法 base_ref: ${baseRef}` };
  if (targetRef && !SAFE_REF_RE.test(targetRef)) return { ok: false, error: `非法 target_ref: ${targetRef}` };

  const pathArgs = params.filePath?.trim() ? ["--", params.filePath.trim()] : [];
  let rawDiff = "";
  let extraFiles: GitDiffFile[] = [];

  if (baseRef && targetRef) {
    const res = await git(["diff", "--no-color", "--unified=3", "-M", baseRef, targetRef, ...pathArgs], repo.repoRoot, params.env, 25_000);
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "获取检查点 Diff 失败" };
    rawDiff = res.stdout;
  } else {
    // Live working tree vs HEAD (includes both staged and unstaged tracked changes)
    const args = repo.headSha
      ? ["diff", "--no-color", "--unified=3", "-M", "HEAD", ...pathArgs]
      : ["diff", "--no-color", "--unified=3", "-M", ...pathArgs];
    const res = await git(args, repo.repoRoot, params.env, 25_000);
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "获取工作区 Diff 失败" };
    rawDiff = res.stdout;

    // Also include untracked non-ignored files so brand-new files created by agents show up in Diff Review
    const untracked = await git(["ls-files", "--others", "--exclude-standard", ...pathArgs], repo.repoRoot, params.env, 10_000);
    if (untracked.code === 0 && untracked.stdout.trim()) {
      const paths = untracked.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 40);
      extraFiles = await Promise.all(paths.map((p) => buildUntrackedFileDiff(repo.repoRoot, p)));
    }
  }

  let truncated = false;
  if (rawDiff.length > MAX_TOTAL_DIFF_BYTES) {
    rawDiff = rawDiff.slice(0, MAX_TOTAL_DIFF_BYTES);
    truncated = true;
  }

  const parsed = [...parseUnifiedDiff(rawDiff), ...extraFiles];
  const totalAdditions = parsed.reduce((acc, f) => acc + f.additions, 0);
  const totalDeletions = parsed.reduce((acc, f) => acc + f.deletions, 0);
  const statusOut = await git(["status", "--porcelain"], repo.repoRoot, params.env, 10_000);
  const checkpoints = await listCheckpoints(repo.repoRoot, params.env);

  return {
    ok: true,
    repo_root: repo.repoRoot,
    branch: repo.branch,
    head_sha: repo.headSha,
    is_dirty: Boolean(statusOut.stdout.trim()),
    base_ref: baseRef || (repo.headSha ? "HEAD" : ""),
    target_ref: targetRef || "WORKING_TREE",
    total_files: parsed.length,
    total_additions: totalAdditions,
    total_deletions: totalDeletions,
    truncated,
    files: parsed,
    checkpoints,
  };
}

/**
 * Restores the working tree to match a hidden checkpoint ref (`refs/memento/checkpoints/...`)
 * WITHOUT moving HEAD or switching branches. Always snapshots the current working tree to a
 * `pre-revert-*` backup ref first so the revert itself is reversible.
 */
export async function restoreGitCheckpoint(params: {
  cwd: string;
  targetRef: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GitRestoreResponse> {
  const targetRef = params.targetRef?.trim() || "";
  if (!SAFE_CHECKPOINT_REF_RE.test(targetRef)) {
    return { ok: false, error: "仅允许回滚到 Memento 隐藏检查点引用（refs/memento/checkpoints/...）" };
  }
  const repo = await resolveGitRepo(params.cwd, params.env);
  if (!repo) return { ok: false, error: "当前目录不是 Git 仓库" };

  const verify = await git(["rev-parse", "--verify", targetRef], repo.repoRoot, params.env, 5_000);
  if (verify.code !== 0) return { ok: false, error: `检查点不存在或已被清理：${targetRef}` };

  // 1. Snapshot current working tree into a safety backup ref before modifying files
  const backupId = `revert-${Date.now().toString(36)}`;
  const backupRef = `${CHECKPOINT_PREFIX}${backupId}/before`;
  const backup = await captureSnapshotRef(repo.repoRoot, repo.gitDir, backupRef, `memento pre-revert backup ${backupId}`, repo.headSha, params.env);
  if (!backup) return { ok: false, error: "回滚前创建安全备份快照失败，已中止回滚" };

  // 2. Find files present now (backupRef) that did NOT exist in targetRef, and remove them
  const diffRemoved = await git(["diff", "--name-only", "--diff-filter=D", backupRef, targetRef], repo.repoRoot, params.env, 15_000);
  const toRemove = diffRemoved.code === 0 ? diffRemoved.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const rootPrefix = repo.repoRoot.endsWith(sep) ? repo.repoRoot : `${repo.repoRoot}${sep}`;
  let removedCount = 0;
  for (const rel of toRemove) {
    const abs = resolve(repo.repoRoot, rel);
    if (!abs.startsWith(rootPrefix)) continue;
    await rm(abs, { force: true }).catch(() => {});
    removedCount++;
  }

  // 3. Find files that differ or were deleted since targetRef and restore them directly into the working tree
  const diffRestore = await git(["diff", "--name-only", "--diff-filter=ACMRT", backupRef, targetRef], repo.repoRoot, params.env, 15_000);
  const toRestore = diffRestore.code === 0 ? diffRestore.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const CHUNK = 80;
  if (toRestore.length > 0) {
    // Use `git checkout <targetRef> -- <paths>` in chunks to avoid command-line length limits
    for (let i = 0; i < toRestore.length; i += CHUNK) {
      const slice = toRestore.slice(i, i + CHUNK);
      const co = await git(["checkout", targetRef, "--", ...slice], repo.repoRoot, params.env, 20_000);
      if (co.code !== 0) {
        return { ok: false, error: `恢复文件失败：${co.stderr.trim()}` };
      }
    }
  }
  // Keep HEAD and staging area aligned with HEAD for touched paths (matches working-tree revert semantics)
  const touchedPaths = [...new Set([...toRemove, ...toRestore])];
  if (touchedPaths.length > 0 && repo.headSha) {
    for (let i = 0; i < touchedPaths.length; i += CHUNK) {
      await git(["reset", "-q", "HEAD", "--", ...touchedPaths.slice(i, i + CHUNK)], repo.repoRoot, params.env, 10_000).catch(() => {});
    }
  }

  // Record after-revert snapshot so the revert itself shows up in checkpoint history
  const afterRevertRef = `${CHECKPOINT_PREFIX}${backupId}/after`;
  await captureSnapshotRef(repo.repoRoot, repo.gitDir, afterRevertRef, `memento post-revert ${backupId}`, repo.headSha, params.env).catch(() => {});

  return {
    ok: true,
    repo_root: repo.repoRoot,
    branch: repo.branch,
    restored_ref: targetRef,
    backup_ref: backupRef,
    files_restored: toRestore.length,
    files_removed: removedCount,
  };
}

/**
 * One-click Git delivery: stage selected (or all) files, commit, optionally push, and optionally open a PR via `gh`.
 */
export async function deliverGitChanges(params: {
  cwd: string;
  message: string;
  files?: string[];
  push?: boolean;
  createPr?: boolean;
  prTitle?: string;
  prBody?: string;
  prBase?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GitDeliverResponse> {
  const repo = await resolveGitRepo(params.cwd, params.env);
  if (!repo) return { ok: false, error: "当前目录不是 Git 仓库" };

  const message = params.message?.trim() || "";
  if (!message) return { ok: false, error: "提交信息不能为空" };

  const selectedFiles = Array.isArray(params.files) ? params.files.map((f) => String(f).trim()).filter(Boolean) : [];
  const addArgs = selectedFiles.length > 0 ? ["add", "--", ...selectedFiles] : ["add", "-A"];
  const add = await git(addArgs, repo.repoRoot, params.env, 20_000);
  if (add.code !== 0) return { ok: false, error: `暂存改动失败：${add.stderr.trim()}` };

  const staged = await git(["diff", "--cached", "--name-only"], repo.repoRoot, params.env, 10_000);
  let commitSha = repo.headSha;
  let summary = "";

  if (staged.stdout.trim()) {
    const commit = await git(["commit", "-m", message], repo.repoRoot, params.env, 30_000);
    if (commit.code !== 0) {
      return { ok: false, error: `提交失败：${(commit.stderr || commit.stdout).trim()}` };
    }
    const headNow = await git(["rev-parse", "HEAD"], repo.repoRoot, params.env, 5_000);
    commitSha = headNow.stdout.trim() || commitSha;
    summary = `已提交 ${commitSha.slice(0, 8)}`;
  } else if (!params.push && !params.createPr) {
    return { ok: false, error: "没有可提交的改动" };
  } else {
    summary = "工作区无新改动，直接执行后续步骤";
  }

  let pushed = false;
  let pushOutput = "";
  if (params.push || params.createPr) {
    const pushRes = await git(["push", "-u", "origin", repo.branch], repo.repoRoot, params.env, 60_000);
    if (pushRes.code !== 0) {
      return {
        ok: false,
        repo_root: repo.repoRoot,
        branch: repo.branch,
        commit_sha: commitSha,
        pushed: false,
        error: `推送远端失败：${(pushRes.stderr || pushRes.stdout).trim()}`,
      };
    }
    pushed = true;
    pushOutput = (pushRes.stderr || pushRes.stdout).trim().slice(0, 400);
    summary = summary ? `${summary} · 已推送到 origin/${repo.branch}` : `已推送到 origin/${repo.branch}`;
  }

  let prUrl: string | undefined;
  let prError: string | undefined;
  if (params.createPr) {
    const prTitle = params.prTitle?.trim() || message.split("\n")[0]!;
    const prBody = params.prBody?.trim() || `由 Memento 一键创建（提交 ${commitSha.slice(0, 8)}）。`;
    const prArgs = ["pr", "create", "--title", prTitle, "--body", prBody, ...(params.prBase?.trim() ? ["--base", params.prBase.trim()] : [])];
    const prRes = await runCmd("gh", prArgs, repo.repoRoot, params.env, 45_000);
    const combined = `${prRes.stdout}\n${prRes.stderr}`;
    const urlMatch = /https:\/\/[^\s]+/i.exec(combined);
    if (prRes.code === 0 && urlMatch) {
      prUrl = urlMatch[0];
      summary = `${summary} · 已创建 PR`;
    } else if (/already exists/i.test(combined) && urlMatch) {
      prUrl = urlMatch[0];
      summary = `${summary} · 复用已有 PR`;
    } else {
      prError = combined.trim().slice(0, 400) || "创建 PR 失败（请确认目标设备已安装并登录 gh CLI）";
    }
  }

  return {
    ok: !prError,
    repo_root: repo.repoRoot,
    branch: repo.branch,
    commit_sha: commitSha,
    pushed,
    push_output: pushOutput || undefined,
    pr_url: prUrl,
    pr_error: prError,
    summary,
    ...(prError ? { error: prError } : {}),
  };
}
