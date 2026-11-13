import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import type { AgentEvent } from "./agent-stream.js";
import { homeDir } from "./config.js";
import { executionEnvironment, killProcessTree } from "./exec-env.js";
import { mirrorPatch, packPatch, PATCH_LIMIT, repoOf, unpackPatch, WorkspaceError, type Mirror } from "./workspace.js";
import type { Relay, WorkspaceRun } from "./workspace-sync.js";

/**
 * Code on one device, agent on another, and the agent's commands where the code is: a test suite
 * that needs the source's toolchain, database, .env or installed dependencies runs there, on the
 * agent's changes, while the agent keeps working on the executor.
 *
 * Executor: a loopback endpoint per task (like the hook bridge) that the agent reaches with the
 * `memento-source` command. Each call sends what the agent changed so far (a patch against the
 * snapshot it started from) and the command through the server (op `exec`).
 *
 * Source: the command runs in a checkout of its own (a git worktree under ~/.memento/workspace-check)
 * reset to that snapshot with the patch applied, never in the user's working tree. Dependencies and
 * local config git ignores (node_modules, .venv, .env…) are linked in from the user's checkout, so
 * nothing is installed again. Commands of one repository run one at a time.
 */

/** How long one command may run on the source. */
export const SOURCE_EXEC_TIMEOUT_MS = 30 * 60_000;
/** Output sent back per stream: the end of it, where test results are. */
const OUTPUT_LIMIT = 200 * 1024;

// ── on the executor ──────────────────────────────────────────────────────

interface Registered {
  taskId: string;
  run: WorkspaceRun;
}

export class SourceExecBridge {
  private readonly secret = randomBytes(24).toString("hex");
  private server: Server | undefined;
  private port: number | undefined;
  private readonly tasks = new Map<string, Registered>();

  constructor(
    private readonly relay: () => Relay | undefined,
    private readonly emit: (taskId: string, event: AgentEvent) => void = () => {},
    private readonly home = homeDir(),
  ) {}

  /** The URL the agent's `memento-source` posts to for this task, and the command's path; null when it can't listen. */
  async register(taskId: string, run: WorkspaceRun): Promise<{ url: string; command: string } | null> {
    try {
      const port = await this.ensureStarted();
      const token = randomBytes(12).toString("hex");
      this.tasks.set(token, { taskId, run });
      const command = await ensureSourceCli(this.home);
      return { url: `http://127.0.0.1:${port}/exec/${this.secret}/${token}`, command };
    } catch {
      return null;
    }
  }

  unregister(taskId: string): void {
    for (const [token, t] of this.tasks) if (t.taskId === taskId) this.tasks.delete(token);
  }

  private async ensureStarted(): Promise<number> {
    if (this.port !== undefined) return this.port;
    const server = createServer((req, res) => {
      const parts = (req.url ?? "").split("/").filter(Boolean);
      const task = parts.length === 3 && parts[0] === "exec" && parts[1] === this.secret ? this.tasks.get(parts[2]!) : undefined;
      if (req.method !== "POST" || !task) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        // Headers at once and a space now and then: the command may run for many minutes
        res.writeHead(200, { "Content-Type": "application/json" });
        const keepAlive = setInterval(() => res.write(" "), 20_000);
        void this.handle(task, body)
          .then((r) => res.end(JSON.stringify(r)))
          .catch((e: unknown) => res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })))
          .finally(() => clearInterval(keepAlive));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  private async handle(task: Registered, body: string): Promise<Record<string, unknown>> {
    let req: { command?: unknown; cwd?: unknown; timeout_seconds?: unknown };
    try {
      req = JSON.parse(body) as typeof req;
    } catch {
      return { error: "bad request" };
    }
    const command = String(req.command ?? "").trim();
    if (!command) return { error: "没有要执行的命令" };
    const relay = this.relay();
    if (!relay) return { error: "和服务器的连接还没建立" };
    const { run, taskId } = task;
    const rel = relCwd(run.mirror, String(req.cwd ?? ""));
    const timeoutMs = Math.min(SOURCE_EXEC_TIMEOUT_MS, Math.max(10_000, (Number(req.timeout_seconds) || 0) * 1000 || SOURCE_EXEC_TIMEOUT_MS));
    const started = Date.now();
    const env = await executionEnvironment();
    const p = await mirrorPatch(run.mirror, { env, home: this.home });
    const patchB64 = p.patch.length ? await packPatch(p.patch) : "";
    if (patchB64.length > PATCH_LIMIT) return { error: "改动太大，没法发到代码所在的设备上执行" };
    this.emit(taskId, { kind: "source_exec", status: "running", command: command.slice(0, 500), source: run.spec.sourceName } as AgentEvent);
    let r: Record<string, unknown>;
    try {
      r = await relay(
        "exec",
        {
          source_device_id: run.spec.sourceDeviceId,
          path: run.spec.sourcePath,
          snapshot: run.mirror.snapshot,
          patch_b64: patchB64,
          rel,
          command,
          timeout_ms: timeoutMs,
        },
        timeoutMs + 120_000,
      );
    } catch (e) {
      r = { error: e instanceof Error ? e.message : String(e) };
    }
    const exitCode = typeof r.exit_code === "number" ? r.exit_code : undefined;
    this.emit(taskId, {
      kind: "source_exec",
      status: r.error ? "failed" : "done",
      command: command.slice(0, 500),
      source: run.spec.sourceName,
      ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
      ...(r.error ? { error: String(r.error).slice(0, 500) } : {}),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    } as AgentEvent);
    return r;
  }

  dispose(): void {
    this.server?.close();
    this.tasks.clear();
  }
}

/** The agent's working directory as a path in the repository ("" for its root), or the task's own directory when it is outside. */
export function relCwd(mirror: Pick<Mirror, "root" | "workDir">, cwd: string): string {
  const from = cwd && isAbsolute(cwd) ? cwd : mirror.workDir;
  const rel = relative(mirror.root, from);
  if (!rel) return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return relative(mirror.root, mirror.workDir).split(sep).join("/");
  return rel.split(sep).join("/");
}

const CLI_SCRIPT = `// memento-source: run a command on the device the code is on (written by Memento, rewritten on update)
import { request } from "node:http";
const url = process.env.MEMENTO_SOURCE_URL;
const args = process.argv.slice(2);
if (!url) {
  console.error("memento-source: 只能在 Memento 跨设备任务里由智能体使用");
  process.exit(2);
}
if (!args.length || args[0] === "-h" || args[0] === "--help") {
  console.error('用法: memento-source "<命令>"   在代码所在的设备上、带着当前改动执行命令');
  process.exit(2);
}
const body = JSON.stringify({ command: args.join(" "), cwd: process.cwd() });
const req = request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
  let text = "";
  res.setEncoding("utf8");
  res.on("data", (c) => (text += c));
  res.on("end", () => {
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      console.error("memento-source: 没有拿到结果" + (res.statusCode !== 200 ? "（" + res.statusCode + "）" : ""));
      process.exit(1);
    }
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.error) process.stderr.write("memento-source: " + r.error + "\\n");
    process.exit(typeof r.exit_code === "number" ? r.exit_code : 1);
  });
});
req.on("error", (e) => {
  console.error("memento-source: " + e.message);
  process.exit(1);
});
req.end(body);
`;

/** Writes the `memento-source` command (a script run on this process's runtime) and returns how to call it. */
export async function ensureSourceCli(home = homeDir(), runtime = process.execPath): Promise<string> {
  const dir = join(home, ".memento", "bin");
  await mkdir(dir, { recursive: true });
  const script = join(dir, "memento-source.mjs");
  await writeFile(script, CLI_SCRIPT);
  if (process.platform === "win32") {
    const cmd = join(dir, "memento-source.cmd");
    await writeFile(cmd, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${runtime}" "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    return cmd;
  }
  const sh = join(dir, "memento-source");
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  await writeFile(sh, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(runtime)} ${q(script)} "$@"\n`);
  await chmod(sh, 0o755);
  return sh;
}

/** What the agent is told about it, in its system prompt. */
export function sourceExecHint(command: string, sourceName: string): string {
  return (
    `[在代码所在的设备上执行] 代码在「${sourceName}」上，你在另一台设备上它的副本里工作。测试、构建、需要那台设备环境` +
    `（本地数据库、.env、已装的依赖、那台设备才有的工具链）的命令，用 \`${command} "<命令>"\` 在「${sourceName}」上执行：` +
    `会带上你到目前为止的全部改动，在那台设备上单独的检出目录里执行（不碰用户的工作目录），输出和退出码原样返回。` +
    `工作目录对应你当前所在的目录。一次最多 30 分钟，超过 10 分钟的命令请放到后台执行。`
  );
}

// ── on the device the code is on ─────────────────────────────────────────

/** Ignored paths linked into the checkout from the user's: dependencies and local config, never build output. */
const LINKED = /^(node_modules|\.venv|venv|\.env(\..+)?|\.envrc|\.direnv)$/;

const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  }).catch(() => {});
  return next;
}

function run(
  exe: string,
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; input?: Buffer; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env: options.env, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    // Only the end is kept: a long test run's results are at its end
    const keep = (list: Buffer[], b: Buffer, len: number) => {
      list.push(b);
      len += b.length;
      while (len > OUTPUT_LIMIT * 2 && list.length > 1) len -= list.shift()!.length;
      return len;
    };
    child.stdout.on("data", (b: Buffer) => (outLen = keep(out, b, outLen)));
    child.stderr.on("data", (b: Buffer) => (errLen = keep(err, b, errLen)));
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killProcessTree(child);
        }, options.timeoutMs)
      : undefined;
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    const tail = (list: Buffer[]) => {
      const s = Buffer.concat(list).toString("utf8");
      return s.length > OUTPUT_LIMIT ? `…（前面的输出已省略）\n${s.slice(-OUTPUT_LIMIT)}` : s;
    };
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: tail(out), stderr: `${tail(err)}${e.message}\n`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: tail(out), stderr: tail(err), timedOut });
    });
  });
}

async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: Buffer) {
  return run("git", args, cwd, { env, input, timeoutMs: 120_000 });
}

/** The checkout commands for root run in: created once, reset to `snapshot` each time. */
export function checkDir(root: string, home = homeDir()): string {
  const id = createHash("sha1").update(root).digest("hex").slice(0, 12);
  return join(home, ".memento", "workspace-check", id, basename(root) || "repo");
}

async function linkIgnored(root: string, wt: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const r = await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], root, env);
  if (r.code !== 0) return;
  for (const entry of r.stdout.split("\0")) {
    const path = entry.replace(/\/+$/, "");
    if (!path || !LINKED.test(basename(path))) continue;
    const at = join(wt, path);
    if (!existsSync(dirname(at))) continue;
    if (await lstat(at).catch(() => null)) continue;
    const target = join(root, path);
    const isDir = entry.endsWith("/");
    await symlink(target, at, isDir && process.platform === "win32" ? "junction" : isDir ? "dir" : "file").catch(() => {});
  }
}

export interface SourceExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out?: boolean;
  seconds: number;
}

/** The source's side of `workspace_exec_req`: the command on the snapshot plus the agent's patch, in the check-out of its own. */
export async function execOnSource(
  dir: string,
  data: Record<string, unknown>,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SourceExecResult> {
  const env = options.env ?? (await executionEnvironment());
  const { root } = await repoOf(dir, env);
  const snapshot = String(data.snapshot ?? "");
  if (!/^[0-9a-f]{40,64}$/.test(snapshot)) throw new WorkspaceError("缺少同步时的快照");
  const rel = String(data.rel ?? "").replaceAll("\\", "/");
  if (rel.split("/").includes("..") || isAbsolute(rel)) throw new WorkspaceError(`工作目录不对：${rel}`);
  const command = String(data.command ?? "").trim();
  if (!command) throw new WorkspaceError("没有要执行的命令");
  const timeoutMs = Math.min(SOURCE_EXEC_TIMEOUT_MS, Number(data.timeout_ms) || SOURCE_EXEC_TIMEOUT_MS);
  const patch = data.patch_b64 ? await unpackPatch(String(data.patch_b64)) : Buffer.alloc(0);

  return serialized(root, async () => {
    if ((await git(["cat-file", "-e", `${snapshot}^{commit}`], root, env)).code !== 0) {
      throw new WorkspaceError("这台设备上找不到同步时的快照（可能已被清理），重新开始任务");
    }
    const wt = checkDir(root, options.home);
    if (!existsSync(join(wt, ".git"))) {
      await rm(wt, { recursive: true, force: true });
      await mkdir(dirname(wt), { recursive: true });
      await git(["worktree", "prune"], root, env);
      const add = await git(["worktree", "add", "-q", "--detach", wt, snapshot], root, env);
      if (add.code !== 0) throw new WorkspaceError(`准备检出目录失败：${add.stderr.trim().slice(0, 400)}`);
    } else {
      const co = await git(["checkout", "-q", "-f", "--detach", snapshot], wt, env);
      if (co.code !== 0) throw new WorkspaceError(`重置检出目录失败：${co.stderr.trim().slice(0, 400)}`);
      // Ignored files (the linked dependencies, build output) stay
      await git(["clean", "-fdq"], wt, env);
    }
    await linkIgnored(root, wt, env);
    if (patch.length) {
      const ap = await git(["apply", "--binary", "--whitespace=nowarn", "-"], wt, env, patch);
      if (ap.code !== 0) throw new WorkspaceError(`改动在这台设备上打不上：${ap.stderr.trim().slice(0, 400)}`);
    }
    const cwd = join(wt, rel);
    if (!existsSync(cwd)) throw new WorkspaceError(`这台设备上没有目录 ${rel}`);
    const started = Date.now();
    const shell = process.platform === "win32"
      ? { exe: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] }
      : { exe: existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh", args: ["-c", command] };
    const r = await run(shell.exe, shell.args, cwd, { env, timeoutMs });
    return {
      exit_code: r.timedOut ? 124 : r.code,
      stdout: r.stdout,
      stderr: r.timedOut ? `${r.stderr}\n（超过 ${Math.round(timeoutMs / 60_000)} 分钟，已停止）\n` : r.stderr,
      ...(r.timedOut ? { timed_out: true } : {}),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  });
}
