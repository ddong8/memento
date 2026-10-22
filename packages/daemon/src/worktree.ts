import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, normalize, relative } from "node:path";

import { homeDir } from "./config.js";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// git reports the real path (/private/var/... on macOS); compare like with like.
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return normalize(path);
  }
}

/**
 * A git worktree and branch of its own for one agent task, so tasks running in
 * parallel on the same repository can't overwrite each other's changes.
 *
 * Lives outside the repository (~/.memento/worktrees/<repo>-<task>), on branch
 * memento/<task>. A task that changed nothing leaves no trace; one that did
 * keeps its branch for the user to review and merge.
 */
export class TaskWorktree {
  private constructor(
    readonly repoRoot: string,
    readonly path: string,
    readonly branch: string,
    readonly baseSha: string,
    /** Where the agent runs: the same subdirectory of the repository it was sent to. */
    readonly workDir: string,
  ) {}

  /** Sets one up for `dir`, or explains why the task runs in place instead. */
  static async create(
    dir: string,
    taskId: string,
    options: { env?: NodeJS.ProcessEnv; home?: string } = {},
  ): Promise<{ tree: TaskWorktree | null; reason?: string }> {
    const { env } = options;
    const top = await git(["rev-parse", "--show-toplevel"], dir, env);
    if (top.code !== 0) return { tree: null, reason: "不是 git 仓库，直接在原目录运行" };
    const root = normalize(top.stdout.trim());
    const head = await git(["rev-parse", "HEAD"], root, env);
    if (head.code !== 0) return { tree: null, reason: "仓库还没有任何提交，直接在原目录运行" };
    const base = head.stdout.trim();

    const id = taskId.replaceAll("-", "").slice(0, 8);
    const path = join(options.home ?? homeDir(), ".memento", "worktrees", `${basename(root)}-${id}`);
    const branch = `memento/${id}`;
    await mkdir(dirname(path), { recursive: true });

    const add = await git(["worktree", "add", "-b", branch, path, base], root, env);
    if (add.code !== 0) return { tree: null, reason: `创建 worktree 失败，直接在原目录运行：${add.stderr.trim()}` };
    const rel = relative(real(root), real(dir));
    const workDir = rel === "" || rel.startsWith("..") ? path : join(path, rel);
    return { tree: new TaskWorktree(root, path, branch, base, workDir) };
  }

  /** What the task left behind. Removes the worktree and branch when that's nothing. */
  async finish(env?: NodeJS.ProcessEnv): Promise<Record<string, unknown> & { kind: string }> {
    const status = await git(["status", "--porcelain"], this.path, env);
    const changed = new Set<string>();
    for (const line of status.stdout.split("\n")) if (line.trim().length > 3) changed.add(line.slice(3).trim());
    const diff = await git(["diff", "--name-only", this.baseSha, "HEAD"], this.path, env);
    for (const line of diff.stdout.split("\n")) if (line.trim()) changed.add(line.trim());
    const count = await git(["rev-list", "--count", `${this.baseSha}..HEAD`], this.path, env);
    const commits = Number.parseInt(count.stdout.trim(), 10) || 0;

    if (!changed.size && !commits) {
      await git(["worktree", "remove", "--force", this.path], this.repoRoot, env);
      await git(["branch", "-D", this.branch], this.repoRoot, env);
      return { kind: "worktree", status: "removed", branch: this.branch };
    }
    const files = [...changed].sort();
    return {
      kind: "worktree",
      status: "kept",
      branch: this.branch,
      path: this.path,
      repo: this.repoRoot,
      commits,
      files: files.slice(0, 30),
      file_count: files.length,
    };
  }

  /**
   * Scans ~/.memento/worktrees and ~/.memento/cache for orphaned worktrees and stale temporary files
   * older than maxAgeMs (default 24h), safely reclaiming disk space.
   */
  static async cleanupStale(options: { home?: string; maxAgeMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
    const baseDir = options.home ?? homeDir();
    const worktreeDir = join(baseDir, ".memento", "worktrees");
    const cacheDir = join(baseDir, ".memento", "cache");
    const maxAge = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    let cleaned = 0;

    // 1. Clean stale worktrees
    try {
      const entries = await readdir(worktreeDir, { withFileTypes: true });
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const targetDir = join(worktreeDir, entry.name);
        try {
          const stats = await stat(targetDir);
          if (now - stats.mtimeMs > maxAge) {
            const status = await git(["status", "--porcelain"], targetDir, options.env);
            if (status.code === 0 && !status.stdout.trim()) {
              await rm(targetDir, { recursive: true, force: true });
              cleaned++;
            }
          }
        } catch {}
      }
    } catch {}

    // 2. Clean stale temporary cache/media artifacts
    try {
      const cacheEntries = await readdir(cacheDir, { withFileTypes: true });
      const now = Date.now();
      for (const entry of cacheEntries) {
        const targetPath = join(cacheDir, entry.name);
        try {
          const stats = await stat(targetPath);
          if (now - stats.mtimeMs > maxAge) {
            await rm(targetPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch {}
      }
    } catch {}

    // 3. Clean stale temporary agent image folders (/data2/memento/images & /tmp/memento_images)
    const imgDirs = ["/data2/memento/images", "/tmp/memento_images"];
    for (const idir of imgDirs) {
      try {
        const entries = await readdir(idir, { withFileTypes: true });
        const now = Date.now();
        for (const entry of entries) {
          const targetPath = join(idir, entry.name);
          try {
            const stats = await stat(targetPath);
            if (now - stats.mtimeMs > maxAge) {
              await rm(targetPath, { recursive: true, force: true });
              cleaned++;
            }
          } catch {}
        }
      } catch {}
    }

    return cleaned;
  }
}

