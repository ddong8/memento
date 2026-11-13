import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { homeDir } from "./config.js";
import { prepareCommand } from "./exec-env.js";

/**
 * Keeping a resumed Claude Code session on its prompt cache, as Claude Code itself does.
 *
 * The cache is keyed on the request's exact beginning (system prompt, tools, history), not on the client:
 * a session the terminal or VS Code ran a minute ago goes on in memento at cache prices, provided the
 * request starts the same. What breaks that in practice (measured 11-13 with the API's cache diagnostics):
 * - another build of Claude Code: its system prompt and tools differ (2.1.283 after 2.1.311 read nothing
 *   back; close builds mostly do). So a session goes on with the build that ran it last, when it's here.
 * - an hour without a request: the cache is gone and the next step writes the whole context again at
 *   twice the input price. Claude Code's terminal and IDE compact an idle conversation of 200k+ tokens
 *   shortly before that (idle compaction, from 2.1.299); `claude -p` doesn't. So after a run memento does
 *   the same for the sessions it ran: at 54 minutes idle a /compact, which reads the still-cached history
 *   (one run: 53k read from the cache, nothing written) and leaves a summary for the next step.
 */

const run = promisify(execFile);

export interface ClaudeBuild {
  path: string;
  version: string;
  /** Where it came from, for the log: on PATH, ~/.local/bin, an editor's extension. */
  source: string;
}

const VERSION = /(\d+\.\d+\.\d+)/;
const versionCache = new Map<string, { mtime: number; version: string }>();

async function buildVersion(path: string): Promise<string | undefined> {
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return undefined;
  const hit = versionCache.get(path);
  if (hit && hit.mtime === st.mtimeMs) return hit.version;
  try {
    const prep = await prepareCommand(path, ["--version"]);
    const { stdout } = await run(prep.executable, prep.args, { timeout: 20_000, windowsHide: true });
    const version = VERSION.exec(stdout)?.[1];
    if (version) versionCache.set(path, { mtime: st.mtimeMs, version });
    return version;
  } catch {
    return undefined;
  }
}

/** The Claude Code builds on this device: every claude on PATH, ~/.local/bin, and the ones editor extensions bundle. */
export async function claudeBuilds(env: NodeJS.ProcessEnv, home = homeDir()): Promise<ClaudeBuild[]> {
  const isWin = process.platform === "win32";
  const exe = isWin ? "claude.exe" : "claude";
  const found: ClaudeBuild[] = [];
  const seen = new Set<string>();
  const add = async (path: string, source: string, version?: string) => {
    const key = isWin ? path.toLowerCase() : path;
    if (seen.has(key)) return;
    seen.add(key);
    const v = version ?? (await buildVersion(path));
    if (v && existsSync(path)) found.push({ path, version: v, source });
  };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  for (const dir of (env[pathKey] ?? "").split(delimiter).filter(Boolean)) {
    for (const name of isWin ? ["claude.exe", "claude.cmd"] : ["claude"]) {
      if (existsSync(join(dir, name))) await add(join(dir, name), "PATH");
    }
  }
  await add(join(home, ".local", "bin", exe), "~/.local/bin");
  // VS Code and its forks bundle their own build: anthropic.claude-code-<version>-<platform>/resources/native-binary
  for (const editor of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const dir = join(home, editor, "extensions");
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const m = /^anthropic\.claude-code-(\d+\.\d+\.\d+)/.exec(name);
      if (!m) continue;
      const bin = join(dir, name, "resources", "native-binary", exe);
      if (existsSync(bin)) await add(bin, `${editor.slice(1)} 扩展`, m[1]);
    }
  }
  return found;
}

/** The Claude Code build that last wrote to this transcript (its entries carry "version"). */
export async function sessionVersion(file: string): Promise<string | undefined> {
  const fh = await open(file, "r").catch(() => null);
  if (!fh) return undefined;
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? "";
      // Entries a client wrote (with its entrypoint): not ones copied over, like a compaction summary's
      if (!line.includes('"entrypoint"')) continue;
      const v = /"version"\s*:\s*"(\d+\.\d+\.\d+)"/.exec(line)?.[1];
      if (v) return v;
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

/**
 * The build to resume a session with: the one that ran it last when it's on this device and isn't the
 * default already, else the default. null when the default is right (or nothing better is here).
 */
export async function matchingBuild(
  defaultExe: string,
  sessionFile: string | undefined,
  env: NodeJS.ProcessEnv,
  home = homeDir(),
): Promise<(ClaudeBuild & { wanted: string; had?: string }) | null> {
  if (!sessionFile) return null;
  const wanted = await sessionVersion(sessionFile);
  if (!wanted) return null;
  const had = await buildVersion(defaultExe);
  if (had === wanted) return null;
  const match = (await claudeBuilds(env, home)).find((b) => b.version === wanted);
  return match ? { ...match, wanted, ...(had ? { had } : {}) } : null;
}

// ── idle compaction ────────────────────────────────────────────────────────

/** Claude Code's own: a conversation idle about this long is compacted before its hour of cache runs out. */
export const IDLE_COMPACT_AFTER_MS = 54 * 60_000;
export const IDLE_COMPACT_MIN_TOKENS = 200_000;

/** Whether the user's Claude Code settings leave idle compaction on, and from what size (as Claude Code reads them). */
export async function idleCompactPolicy(env: NodeJS.ProcessEnv, home = homeDir()): Promise<{ on: boolean; minTokens: number }> {
  let on = !/^(1|true)$/i.test(String(env.DISABLE_COMPACT ?? ""));
  try {
    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
    if (settings.idleCompaction === false) on = false;
  } catch {
    // no settings: Claude Code's defaults
  }
  const min = Number(env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS);
  return { on, minTokens: Number.isFinite(min) && min > 0 ? min : IDLE_COMPACT_MIN_TOKENS };
}

export interface IdleCompactJob {
  sessionId: string;
  cwd: string;
  exe: string;
  model?: string;
  env: NodeJS.ProcessEnv;
  contextTokens: number;
}

/**
 * Compacts the sessions memento ran once they sit idle, the way Claude Code's terminal does: one timer per
 * session, reset by every run; skipped when anything wrote to the session meanwhile (another client goes on
 * with it, and compacts it itself) or a run of it starts.
 */
export class IdleCompactor {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly compacting = new Map<string, ChildProcess>();

  constructor(
    private readonly log: (msg: string) => void,
    private readonly opts: {
      afterMs?: number;
      home?: string;
      findSession?: (sessionId: string) => Promise<string | undefined>;
    } = {},
  ) {}

  /** After a run of the session ended: compact it when it's still idle a while from now. */
  async schedule(job: IdleCompactJob): Promise<void> {
    this.cancel(job.sessionId);
    const policy = await idleCompactPolicy(job.env, this.opts.home);
    if (!policy.on || job.contextTokens < policy.minTokens) return;
    const file = await this.opts.findSession?.(job.sessionId);
    if (!file) return;
    const mtime = (await stat(file).catch(() => null))?.mtimeMs;
    if (mtime === undefined) return;
    const t = setTimeout(() => {
      this.timers.delete(job.sessionId);
      void this.fire(job, file, mtime);
    }, this.opts.afterMs ?? IDLE_COMPACT_AFTER_MS);
    t.unref?.();
    this.timers.set(job.sessionId, t);
  }

  /** A run of the session starts (or it's gone): no compaction of it now, and one under way stops. */
  cancel(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) clearTimeout(t);
    this.timers.delete(sessionId);
    const proc = this.compacting.get(sessionId);
    if (proc) {
      this.compacting.delete(sessionId);
      proc.kill();
      this.log(`Idle compaction of ${sessionId} stopped: a run of it started`);
    }
  }

  dispose(): void {
    for (const id of [...this.timers.keys(), ...this.compacting.keys()]) this.cancel(id);
  }

  private async fire(job: IdleCompactJob, file: string, mtime: number): Promise<void> {
    const now = (await stat(file).catch(() => null))?.mtimeMs;
    if (now !== mtime) return; // someone went on with it (another client, or memento again)
    if (!existsSync(job.cwd)) return; // run in a worktree that is gone: it can't be resumed from there
    const args = [
      "-p",
      "-r",
      job.sessionId,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      // The model it ran with: another one shares no cache with it
      ...(job.model ? ["--model", job.model] : []),
    ];
    const prep = await prepareCommand(job.exe, args);
    const proc = spawn(prep.executable, prep.args, { cwd: job.cwd, env: job.env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    this.compacting.set(job.sessionId, proc);
    let tail = "";
    let result: { pre?: number; post?: number; ok?: boolean } = {};
    proc.stdout?.on("data", (b: Buffer) => {
      tail += b.toString("utf8");
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const d = JSON.parse(line) as Record<string, unknown>;
          if (d.type === "system" && d.subtype === "compact_boundary") {
            const meta = (d.compact_metadata ?? {}) as Record<string, unknown>;
            result = { ...result, pre: Number(meta.pre_tokens) || undefined, post: Number(meta.post_tokens) || undefined };
          } else if (d.type === "result") {
            result.ok = d.is_error !== true;
            proc.stdin?.end();
          }
        } catch {
          // not a JSON line
        }
      }
    });
    proc.stdin?.on("error", () => {});
    proc.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "/compact" } })}\n`);
    const killer = setTimeout(() => proc.kill(), 10 * 60_000);
    killer.unref?.();
    await new Promise<void>((resolve) => proc.on("close", () => resolve()));
    clearTimeout(killer);
    if (this.compacting.get(job.sessionId) !== proc) return; // stopped for a run
    this.compacting.delete(job.sessionId);
    this.log(
      result.pre
        ? `Idle compaction of ${job.sessionId}: ${result.pre} → ${result.post ?? "?"} tokens, before its cache ran out`
        : `Idle compaction of ${job.sessionId} didn't compact (${result.ok === false ? "error" : "no boundary"})`,
    );
  }
}
