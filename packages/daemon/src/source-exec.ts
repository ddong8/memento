import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  /** Commands of each task still running on the source: stopped there when the task ends. */
  private readonly inflight = new Map<string, number>();
  private readonly runs = new Map<string, { taskId: string; sourceDeviceId: string }>();

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
    // A stopped task's command would otherwise run on there for up to 30 minutes, and every command of
    // that repository (any task's) waits behind it
    if (this.inflight.get(taskId)) this.cancelOnSource(taskId);
    this.runs.delete(taskId);
  }

  /** Stop on the source one command (execId) or, without it, everything of the task. */
  private cancelOnSource(taskId: string, execId?: string): void {
    const relay = this.relay();
    const run = this.runs.get(taskId);
    if (!relay || !run) return;
    void relay("exec_cancel", { source_device_id: run.sourceDeviceId, task_id: taskId, ...(execId ? { exec_id: execId } : {}) }, 30_000).catch(() => {});
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
        const execId = randomBytes(8).toString("hex");
        // The agent gave up on the command (its tool call was stopped, the CLI killed): stop it there too
        res.on("close", () => {
          if (!res.writableEnded && this.inflight.get(task.taskId)) this.cancelOnSource(task.taskId, execId);
        });
        void this.handle(task, body, execId)
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

  private async handle(task: Registered, body: string, execId = ""): Promise<Record<string, unknown>> {
    let req: { action?: unknown; command?: unknown; cwd?: unknown; timeout_seconds?: unknown; message?: unknown; paths?: unknown; push?: unknown; file?: unknown; dest?: unknown };
    try {
      req = JSON.parse(body) as typeof req;
    } catch {
      return { error: "bad request" };
    }
    if (req.action === "commit" || req.action === "push") return this.commit(task, req);
    if (req.action === "get") return this.get(task, req);
    if (req.action === "put") return this.put(task, req);
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
    this.runs.set(taskId, { taskId, sourceDeviceId: run.spec.sourceDeviceId });
    this.inflight.set(taskId, (this.inflight.get(taskId) ?? 0) + 1);
    let r: Record<string, unknown>;
    try {
      r = await relay(
        "exec",
        {
          task_id: taskId,
          exec_id: execId,
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
    } finally {
      const left = (this.inflight.get(taskId) ?? 1) - 1;
      if (left > 0) this.inflight.set(taskId, left);
      else this.inflight.delete(taskId);
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

  /** `memento-source commit`: a real commit on the source of what the agent changed; `push` only asks for the push at the end. */
  private async commit(task: Registered, req: { action?: unknown; cwd?: unknown; message?: unknown; paths?: unknown; push?: unknown }): Promise<Record<string, unknown>> {
    const { run, taskId } = task;
    const local = (run.local ??= { head: run.mirror.head, count: 0, push: false });
    if (req.push === true || req.action === "push") local.push = true;
    if (req.action === "push") {
      return { exit_code: 0, stdout: `任务结束、改动写回「${run.spec.sourceName}」后，由它推送${local.count ? `（含这次任务的 ${local.count} 个提交）` : ""}。\n` };
    }
    const message = String(req.message ?? "").trim();
    if (!message) return { error: '提交说明是空的：memento-source commit -m "说明"' };
    const relay = this.relay();
    if (!relay) return { error: "和服务器的连接还没建立" };
    const cwd = String(req.cwd ?? "") || run.mirror.workDir;
    const paths = (Array.isArray(req.paths) ? req.paths.map(String) : []).map((p) => {
      const r = relative(run.mirror.root, resolve(cwd, p));
      return r.split(sep).join("/");
    });
    if (paths.some((p) => p.startsWith("..") || isAbsolute(p))) return { error: "要提交的路径必须在仓库里" };
    const started = Date.now();
    const env = await executionEnvironment();
    const p = await mirrorPatch(run.mirror, { env, home: this.home });
    const patchB64 = p.patch.length ? await packPatch(p.patch) : "";
    if (patchB64.length > PATCH_LIMIT) return { error: "改动太大，没法发到代码所在的设备上提交" };
    const label = `git commit -m "${message.split("\n")[0]!.slice(0, 120)}"${local.push ? "（结束后推送）" : ""}`;
    this.emit(taskId, { kind: "source_exec", status: "running", command: label, source: run.spec.sourceName } as AgentEvent);
    let r: Record<string, unknown>;
    try {
      r = await relay(
        "commit",
        {
          source_device_id: run.spec.sourceDeviceId,
          path: run.spec.sourcePath,
          task_id: taskId,
          snapshot: run.mirror.snapshot,
          base_tree: run.mirror.baseTree,
          base_head: run.mirror.head,
          parent: local.head,
          patch_b64: patchB64,
          message,
          paths,
        },
        20 * 60_000,
      );
    } catch (e) {
      r = { error: e instanceof Error ? e.message : String(e) };
    }
    const sha = typeof r.sha === "string" && /^[0-9a-f]{40,64}$/.test(r.sha) ? r.sha : "";
    let note = "";
    if (sha) {
      local.head = sha;
      local.count++;
      // The source's formatters touched what went in: the same files here, or the next commit would undo them
      if (typeof r.hook_patch_b64 === "string" && r.hook_patch_b64) {
        const fix = await unpackPatch(r.hook_patch_b64);
        const ap = await runGit(["apply", "--binary", "--whitespace=nowarn", "-"], run.mirror.root, env, fix);
        note = ap === 0 ? "（提交钩子改动的文件已同步到这里）" : "（提交钩子改了文件，但没能同步到这里，下次提交前请重新确认这些文件）";
      }
      r.stdout = `${String(r.stdout ?? "")}已在「${run.spec.sourceName}」上提交 ${sha.slice(0, 8)} ${String(r.subject ?? "")}${note}\n`;
    }
    const exitCode = typeof r.exit_code === "number" ? r.exit_code : r.error ? 1 : 0;
    this.emit(taskId, {
      kind: "source_exec",
      status: r.error ? "failed" : "done",
      command: label,
      source: run.spec.sourceName,
      exit_code: exitCode,
      ...(sha ? { commit: sha } : {}),
      ...(r.error ? { error: String(r.error).slice(0, 500) } : {}),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    } as AgentEvent);
    return r;
  }

  /** `memento-source get`: a file from the source (a screenshot, a log), saved here for the agent to read. */
  private async get(task: Registered, req: { cwd?: unknown; file?: unknown; dest?: unknown }): Promise<Record<string, unknown>> {
    const { run, taskId } = task;
    const file = String(req.file ?? "").trim();
    if (!file) return { error: "用法：memento-source get <文件> [保存到]" };
    const relay = this.relay();
    if (!relay) return { error: "和服务器的连接还没建立" };
    const cwd = String(req.cwd ?? "") || run.mirror.workDir;
    let r: Record<string, unknown>;
    try {
      r = await relay("get", { source_device_id: run.spec.sourceDeviceId, path: run.spec.sourcePath, file, rel: relCwd(run.mirror, cwd), task_id: taskId }, 180_000);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    const dest = req.dest
      ? resolve(cwd, String(req.dest))
      : join(this.home, ".memento", "tmp", "from-source", taskId.replaceAll("-", "").slice(0, 8), basename(file.replaceAll("\\", "/")));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(String(r.data_b64 ?? ""), "base64"));
    this.emit(taskId, { kind: "source_exec", status: "done", command: `取回 ${file}`, source: run.spec.sourceName, exit_code: 0 } as AgentEvent);
    return { exit_code: 0, stdout: `${dest}\n` };
  }

  /** `memento-source put`: a file from here written anywhere on the source outside the project (the old one backed up there). */
  private async put(task: Registered, req: { cwd?: unknown; file?: unknown; dest?: unknown }): Promise<Record<string, unknown>> {
    const { run, taskId } = task;
    const file = String(req.file ?? "").trim();
    const dest = String(req.dest ?? "").trim();
    if (!file || !dest) return { error: "用法：memento-source put <这里的文件> <那台设备上的绝对路径>" };
    const relay = this.relay();
    if (!relay) return { error: "和服务器的连接还没建立" };
    const local = resolve(String(req.cwd ?? "") || run.mirror.workDir, file);
    const st = await stat(local).catch(() => null);
    if (!st?.isFile()) return { error: `这里没有文件 ${local}` };
    if (st.size > GET_LIMIT) return { error: `${local} 超过 ${GET_LIMIT / 1048576}MB，传不过去` };
    let r: Record<string, unknown>;
    try {
      r = await relay("put", { source_device_id: run.spec.sourceDeviceId, path: run.spec.sourcePath, dest, data_b64: (await readFile(local)).toString("base64") }, 180_000);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    this.emit(taskId, { kind: "source_exec", status: "done", command: `写入 ${dest}`, source: run.spec.sourceName, exit_code: 0 } as AgentEvent);
    const backup = r.backup ? `（原文件备份在 ${String(r.backup)}）` : "（新文件）";
    return { exit_code: 0, stdout: `已写入「${run.spec.sourceName}」上的 ${String(r.path ?? dest)}${backup}\n` };
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
const USAGE = [
  '用法:',
  '  memento-source "<命令>"                       在代码所在的设备上、带着当前改动执行命令',
  '  memento-source commit -m "说明" [--push] [-- 路径...]   在那台设备上提交（它的提交钩子照常运行）',
  '  memento-source push                            任务结束、改动写回后由那台设备推送',
  '  memento-source get <文件> [保存到]              把那台设备上的文件（截图、日志、产物，或任意绝对路径）取回这里',
  '  memento-source put <这里的文件> <那边的绝对路径>  把文件写到那台设备上项目以外的任意位置（原文件先备份）',
].join("\\n");
if (!url) {
  console.error("memento-source: 只能在 Memento 跨设备任务里由智能体使用");
  process.exit(2);
}
if (!args.length || args[0] === "-h" || args[0] === "--help") {
  console.error(USAGE);
  process.exit(2);
}
let body;
if (args[0] === "commit") {
  const rest = args.slice(1);
  const message = [];
  const paths = [];
  let push = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") { paths.push(...rest.slice(i + 1)); break; }
    if (a === "-m" || a === "--message") { if (rest[i + 1] !== undefined) message.push(rest[++i]); }
    else if (a.startsWith("--message=")) message.push(a.slice(10));
    else if (a === "--push") push = true;
    else if (a === "-a" || a === "--all") {}
    else message.push(a);
  }
  if (!message.length) { console.error(USAGE); process.exit(2); }
  body = { action: "commit", message: message.join("\\n\\n"), paths, push, cwd: process.cwd() };
} else if (args[0] === "push" && args.length === 1) {
  body = { action: "push", cwd: process.cwd() };
} else if (args[0] === "put" && args.length === 3) {
  body = { action: "put", file: args[1], dest: args[2], cwd: process.cwd() };
} else if (args[0] === "get" && args.length >= 2 && args.length <= 3) {
  body = { action: "get", file: args[1], dest: args[2], cwd: process.cwd() };
} else {
  body = { command: args.join(" "), cwd: process.cwd() };
}
const data = JSON.stringify(body);
const req = request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
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
req.end(data);
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
  const c = `\`${command}\``;
  return [
    `[只在这里改代码] 代码在「${sourceName}」上，你在另一台设备（执行机）上它的副本里工作。这台执行机只用来读和改代码，其余操作全部在「${sourceName}」上做：`,
    `1) 测试、构建、lint、类型检查、安装依赖、运行程序、打开浏览器或截图、安卓模拟器、iOS 构建和上传 TestFlight 等，一律用 ${c} "<命令>"：带着你到目前为止的全部改动，在「${sourceName}」上单独的检出目录里执行（不碰用户的工作目录，依赖、.env、钥匙串和已登录的工具都用那台设备上现成的），输出和退出码原样返回；工作目录对应你当前所在的目录。一次最多 30 分钟，更久的命令放到后台执行。`,
    `2) 提交用 ${c} commit -m "说明" [-- 路径...]：在「${sourceName}」上真正执行 git commit，它的提交钩子照常运行；钩子失败会把输出返回给你，修好再提交；钩子自动改动的文件会同步回这里。要推送加 --push（或执行 ${c} push），任务结束、改动写回「${sourceName}」后由它推送。不要在这里 git commit / push，这里已拦截，绕过去的提交也不会带回。`,
    `3) 要看「${sourceName}」上生成的文件（截图、日志、构建产物），用 ${c} get <文件> [保存到] 取回这里再读；相对路径按当前目录在那边的检出目录里找，也可以给那台设备上的绝对路径。`,
    `4) 要改「${sourceName}」上项目以外的文件（别的仓库、配置文件等）：先 ${c} get <那边的绝对路径> 取回，在这里改好，再 ${c} put <这里的文件> <那边的绝对路径> 写回（原文件自动备份；.ssh、.env、系统配置这类敏感位置会被拒绝）。本项目里的代码照常直接在这里改，任务结束自动写回。`,
    `5) 不要在这台执行机上安装依赖、跑测试或构建。`,
  ].join("\n");
}

// ── on the device the code is on ─────────────────────────────────────────

/** Ignored paths linked into the checkout from the user's: dependencies and local config, never build output. */
const LINKED = /^(node_modules|\.venv|venv|\.env(\..+)?|\.envrc|\.direnv)$/;

const queues = new Map<string, Promise<unknown>>();

/** Commands running here by executor task and by command id, and those stopped lately (queued ones are skipped). */
const running = new Map<string, Set<ChildProcess>>();
const stopped = new Map<string, number>();
const STOPPED_KEEP_MS = 30 * 60_000;

/**
 * The executor's task ended or gave up on its command: kill what runs here for it and skip what still
 * waits. Commands of one repository run one at a time, so a command left running (a find over the home
 * folder, a hung brew) held up every later command of that repository, any task's, until its 30 minutes ran out.
 */
export function cancelSourceExec(taskId: string, execId = ""): number {
  // One command the agent gave up on, or (no command id) all of an ended task
  const key = execId ? `exec:${execId}` : taskId ? `task:${taskId}` : "";
  if (!key) return 0;
  const now = Date.now();
  for (const [id, at] of stopped) if (now - at > STOPPED_KEEP_MS) stopped.delete(id);
  stopped.set(key, now);
  const children = running.get(key);
  if (!children) return 0;
  for (const child of children) killProcessTree(child);
  return children.size;
}

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
  options: { env?: NodeJS.ProcessEnv; input?: Buffer; timeoutMs?: number; onSpawn?: (child: ChildProcess) => () => void } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // Its own process group, so stopping it reaches everything it started (killProcessTree signals the group)
    const child = spawn(exe, args, { cwd, env: options.env, windowsHide: true, detached: process.platform !== "win32" });
    const forget = options.onSpawn?.(child);
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
    let done = false;
    let drain: NodeJS.Timeout | undefined;
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      forget?.();
      resolve({ code: 127, stdout: tail(out), stderr: `${tail(err)}${e.message}\n`, timedOut });
    });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      forget?.();
      resolve({ code: code ?? 1, stdout: tail(out), stderr: tail(err), timedOut });
    };
    child.on("close", (code) => finish(code));
    // 'close' waits for the output pipes, which a leftover grandchild can keep open forever: and with
    // commands of one repository run one at a time, every later command waited behind it
    child.on("exit", (code) => {
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, 5_000);
      drain.unref?.();
    });
  });
}

async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: Buffer) {
  return run("git", args, cwd, { env, input, timeoutMs: 120_000 });
}

/** The checkout commands for root run in: created once, reset to `snapshot` each time. Slot n > 0 is a spare one. */
export function checkDir(root: string, home = homeDir(), slot = 0): string {
  const id = createHash("sha1").update(root).digest("hex").slice(0, 12);
  const dir = join(home, ".memento", "workspace-check", id, basename(root) || "repo");
  return slot ? `${dir}~${slot}` : dir;
}

/**
 * Checkouts of one repository commands may run in at the same time. With one, a slow command (a scan
 * of the home folder that took 10 minutes, a long test run) held every later command of that
 * repository, any task's, for up to its 30 minutes; now the next one takes a free checkout.
 */
export const MAX_CHECKOUTS = 4;
const busySlots = new Map<string, Set<number>>();
const slotWaiters = new Map<string, Array<() => void>>();
/** The checkout a task used last: its next command goes there again, and `get` looks there first. */
const lastSlot = new Map<string, number>();

async function acquireCheckout(root: string, taskId: string): Promise<{ index: number; release: () => void }> {
  for (;;) {
    const busy = busySlots.get(root) ?? new Set<number>();
    busySlots.set(root, busy);
    const pref = taskId ? lastSlot.get(`${root}|${taskId}`) : undefined;
    const order = [...(pref !== undefined ? [pref] : []), ...Array.from({ length: MAX_CHECKOUTS }, (_, i) => i)];
    const index = order.find((i) => !busy.has(i));
    if (index !== undefined) {
      busy.add(index);
      if (taskId) lastSlot.set(`${root}|${taskId}`, index);
      let released = false;
      return {
        index,
        release: () => {
          if (released) return;
          released = true;
          busy.delete(index);
          const waiting = slotWaiters.get(root) ?? [];
          slotWaiters.delete(root);
          for (const wake of waiting) wake();
        },
      };
    }
    await new Promise<void>((wake) => slotWaiters.set(root, [...(slotWaiters.get(root) ?? []), wake]));
  }
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

/** Where a checkout lists the files the agent's patch added to it (next to it, not in it). */
function addedList(wt: string): string {
  return join(dirname(wt), `${basename(wt)}.added`);
}

async function readAdded(wt: string): Promise<string[]> {
  const text = await readFile(addedList(wt), "utf8").catch(() => "");
  return text.split("\0").filter((p) => p && !p.split("/").includes("..") && !isAbsolute(p));
}

async function noteAdded(wt: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const all = [...new Set([...(await readAdded(wt)), ...paths])];
  await writeFile(addedList(wt), all.join("\0"));
}

/** Files a patch creates (`git apply --summary`: " create mode 100644 path"). */
async function patchCreates(wt: string, patch: Buffer, env: NodeJS.ProcessEnv): Promise<string[]> {
  const r = await git(["apply", "--summary", "-"], wt, env, patch);
  return r.stdout
    .split("\n")
    .map((l) => /^\s*create mode \d+ (.+)$/.exec(l)?.[1]?.trim())
    .filter((p): p is string => !!p)
    .map((p) => (p.startsWith('"') ? (JSON.parse(p) as string) : p));
}

/** The checkout for root, reset to `commit` (ignored files such as linked dependencies and build output stay). */
async function checkoutAt(root: string, commit: string, env: NodeJS.ProcessEnv, home?: string, slot = 0): Promise<string> {
  // One checkout set up at a time: `git worktree add/prune` on the repository don't run side by side
  return serialized(`${root}#setup`, () => checkoutOne(root, commit, env, home, slot));
}

async function checkoutOne(root: string, commit: string, env: NodeJS.ProcessEnv, home: string | undefined, slot: number): Promise<string> {
  const wt = checkDir(root, home, slot);
  const create = async () => {
    await rm(wt, { recursive: true, force: true });
    await rm(addedList(wt), { force: true });
    await mkdir(dirname(wt), { recursive: true });
    await git(["worktree", "prune"], root, env);
    const add = await git(["worktree", "add", "-q", "-f", "--detach", wt, commit], root, env);
    if (add.code !== 0) throw new WorkspaceError(`准备检出目录失败：${add.stderr.trim().slice(0, 400)}`);
  };
  if (!existsSync(join(wt, ".git"))) await create();
  else {
    // Files the last patch or commit added go; what the commands made there (screenshots, logs, build output) stays for `get`
    for (const p of await readAdded(wt)) await unlink(join(wt, p)).catch(() => {});
    await rm(addedList(wt), { force: true });
    const co = await git(["checkout", "-q", "-f", "--detach", commit], wt, env);
    // The checkout belongs to a repository that is gone (deleted and cloned again at the same path): start it over
    if (co.code !== 0) await create();
  }
  await linkIgnored(root, wt, env);
  return wt;
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
  const taskId = String(data.task_id ?? "");
  const execId = String(data.exec_id ?? "");
  const keys = [taskId && `task:${taskId}`, execId && `exec:${execId}`].filter(Boolean) as string[];
  const isStopped = () => keys.some((k) => stopped.has(k));
  const queued = Date.now();

  const slot = await acquireCheckout(root, taskId);
  try {
    if (isStopped()) {
      return { exit_code: 130, stdout: "", stderr: "任务已停止，这条命令没有执行\n", seconds: 0 };
    }
    const waited = Math.round((Date.now() - queued) / 1000);
    if ((await git(["cat-file", "-e", `${snapshot}^{commit}`], root, env)).code !== 0) {
      throw new WorkspaceError("这台设备上找不到同步时的快照（可能已被清理），重新开始任务");
    }
    const wt = await checkoutAt(root, snapshot, env, options.home, slot.index);
    if (patch.length) {
      await noteAdded(wt, await patchCreates(wt, patch, env));
      const ap = await git(["apply", "--binary", "--whitespace=nowarn", "-"], wt, env, patch);
      if (ap.code !== 0) throw new WorkspaceError(`改动在这台设备上打不上：${ap.stderr.trim().slice(0, 400)}`);
    }
    const cwd = join(wt, rel);
    if (!existsSync(cwd)) throw new WorkspaceError(`这台设备上没有目录 ${rel}`);
    const started = Date.now();
    const shell = process.platform === "win32"
      ? { exe: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] }
      : { exe: existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh", args: ["-c", command] };
    const onSpawn = keys.length
      ? (child: ChildProcess) => {
          for (const k of keys) running.set(k, (running.get(k) ?? new Set<ChildProcess>()).add(child));
          return () => {
            for (const k of keys) {
              const set = running.get(k);
              set?.delete(child);
              if (set && !set.size) running.delete(k);
            }
          };
        }
      : undefined;
    const r = await run(shell.exe, shell.args, cwd, { env, timeoutMs, onSpawn });
    const cancelled = !r.timedOut && isStopped();
    // Waiting behind another command of this repository is told, so a slow answer isn't taken for a hang
    const note = waited >= 10 ? `（这台设备上 ${MAX_CHECKOUTS} 个检出目录都有命令在跑，等了 ${waited} 秒才轮到）\n` : "";
    return {
      exit_code: r.timedOut ? 124 : r.code,
      stdout: r.stdout,
      stderr: `${r.timedOut ? `${r.stderr}\n（超过 ${Math.round(timeoutMs / 60_000)} 分钟，已停止）\n` : cancelled ? `${r.stderr}\n（任务已停止，命令被结束）\n` : r.stderr}${note}`,
      ...(r.timedOut ? { timed_out: true } : {}),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  } finally {
    slot.release();
  }
}

// ── commits made where the code is ───────────────────────────────────────

const SHA = /^[0-9a-f]{40,64}$/;

/** Where the commits a task made on the source are kept until its changes come back (`memento/<id>` like the kept branches). */
export function localCommitsRef(taskId: string): string {
  return `refs/memento/local/${taskId.replaceAll("-", "").slice(0, 8)}`;
}

export interface SourceCommitResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  /** The commit made (absent when the commit, a hook, failed). */
  sha?: string;
  subject?: string;
  files?: string[];
  /** What the source's hooks changed in the committed files (formatters): for the executor to take in too. */
  hook_patch_b64?: string;
  seconds: number;
}

/** A git command fed `input`, for its exit code. */
function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, input: Buffer): Promise<number> {
  return new Promise((done) => {
    const child = execFile("git", args, { cwd, env, windowsHide: true }, (err) => done(err ? 1 : 0));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** A git command's output as raw bytes (a binary patch), or undefined when it fails. */
function gitRaw(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Buffer | undefined> {
  return new Promise((done) => {
    execFile("git", args, { cwd, env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => done(err ? undefined : stdout));
  });
}

/** Paths that changed between two trees (`from` may be a commit). */
async function changedPaths(root: string, from: string, to: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const r = await git(["diff-tree", "-r", "--no-renames", "--name-only", "-z", from, to], root, env);
  if (r.code !== 0) throw new WorkspaceError(`比较改动失败：${r.stderr.trim().slice(0, 300)}`);
  return r.stdout.split("\0").filter(Boolean);
}

/**
 * The source's side of `workspace_commit_req`: a real `git commit` of what the agent changed, on the
 * source, so its hooks (lint-staged, commit-msg checks, signing) run with its toolchain and the commit
 * is the user's own. It is made in the task's checkout on top of the task's previous commit (the
 * source's HEAD at first) and kept under `localCommitsRef` until the changes come back, when the
 * user's branch moves onto it. Only the files the agent changed go in: edits the user hadn't
 * committed when the task started stay out unless the agent touched those files.
 */
export async function commitOnSource(
  dir: string,
  data: Record<string, unknown>,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SourceCommitResult> {
  const env = options.env ?? (await executionEnvironment());
  const { root } = await repoOf(dir, env);
  const snapshot = String(data.snapshot ?? "");
  const baseTree = String(data.base_tree ?? "");
  const baseHead = String(data.base_head ?? "");
  const parent = String(data.parent ?? "") || baseHead;
  const taskId = String(data.task_id ?? "");
  const message = String(data.message ?? "").trim();
  if (![snapshot, baseTree, baseHead, parent].every((s) => SHA.test(s))) throw new WorkspaceError("缺少同步时的快照");
  if (!taskId) throw new WorkspaceError("缺少任务号");
  if (!message) throw new WorkspaceError("提交说明是空的：memento-source commit -m \"说明\"");
  const only = (Array.isArray(data.paths) ? data.paths.map(String) : [])
    .map((p) => p.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "").replace(/^\.$/, ""));
  if (only.some((p) => p.split("/").includes("..") || isAbsolute(p))) throw new WorkspaceError("要提交的路径必须在仓库里");
  const patch = data.patch_b64 ? await unpackPatch(String(data.patch_b64)) : Buffer.alloc(0);

  return serialized(`${root}#commit`, async () => {
   const slot = await acquireCheckout(root, taskId);
   try {
    for (const sha of [snapshot, parent, baseHead]) {
      if ((await git(["cat-file", "-e", `${sha}^{commit}`], root, env)).code !== 0) {
        throw new WorkspaceError("这台设备上找不到同步时的快照或之前的提交（可能已被清理），重新开始任务");
      }
    }
    // The tree the agent has now: the snapshot plus its patch
    const tmp = join(options.home ?? homeDir(), ".memento", "tmp");
    await mkdir(tmp, { recursive: true });
    const index = join(tmp, `commit-index-${randomBytes(6).toString("hex")}`);
    let now: string;
    try {
      const e = { ...env, GIT_INDEX_FILE: index };
      const rt = await git(["read-tree", baseTree], root, e);
      if (rt.code !== 0) throw new WorkspaceError(`读取快照失败：${rt.stderr.trim().slice(0, 300)}`);
      if (patch.length) {
        const ap = await git(["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], root, e, patch);
        if (ap.code !== 0) throw new WorkspaceError(`改动在这台设备上打不上：${ap.stderr.trim().slice(0, 400)}`);
      }
      const wt = await git(["write-tree"], root, e);
      if (wt.code !== 0) throw new WorkspaceError(`整理改动失败：${wt.stderr.trim().slice(0, 300)}`);
      now = wt.stdout.trim();
    } finally {
      await rm(index, { force: true }).catch(() => {});
    }
    // What the agent changed, and what this task's earlier commits touched (a change it took back since)
    const touched = new Set([...(await changedPaths(root, baseTree, now, env)), ...(await changedPaths(root, baseHead, parent, env))]);
    const inScope = (p: string) => !only.length || only.some((o) => o === "" || p === o || p.startsWith(`${o}/`));
    const paths = [...touched].filter(inScope);
    const started = Date.now();
    const nothing = (why: string): SourceCommitResult => ({ exit_code: 1, stdout: "", stderr: `${why}\n`, seconds: 0 });
    if (!paths.length) return nothing("没有要提交的改动");

    const wt = await checkoutAt(root, parent, env, options.home, slot.index);
    const present = new Set(
      (await git(["ls-tree", "-r", "-z", "--name-only", now, "--", ...paths], root, env)).stdout.split("\0").filter(Boolean),
    );
    const write = paths.filter((p) => present.has(p));
    const gone = paths.filter((p) => !present.has(p));
    if (write.length) {
      await noteAdded(wt, write);
      const co = await git(["checkout", now, "--pathspec-from-file=-", "--pathspec-file-nul"], wt, env, Buffer.from(write.join("\0") + "\0"));
      if (co.code !== 0) throw new WorkspaceError(`写入改动失败：${co.stderr.trim().slice(0, 300)}`);
    }
    if (gone.length) {
      await git(["rm", "-q", "--cached", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], wt, env, Buffer.from(gone.join("\0") + "\0"));
      for (const p of gone) await unlink(join(wt, p)).catch(() => {});
    }
    const staged = (await git(["write-tree"], wt, env)).stdout.trim();
    const parentTree = (await git(["rev-parse", `${parent}^{tree}`], wt, env)).stdout.trim();
    if (staged === parentTree) return nothing("没有要提交的改动（和上一次提交一样）");

    // The user's own commit: their identity, hooks and signing, as `git commit` there does
    const c = await run("git", ["commit", "-q", "-F", "-"], wt, { env, input: Buffer.from(`${message}\n`), timeoutMs: 15 * 60_000 });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const sha = (await git(["rev-parse", "--verify", "-q", "HEAD"], wt, env)).stdout.trim();
    if (c.code !== 0 || !SHA.test(sha) || sha === parent) {
      return { exit_code: c.code || 1, stdout: c.stdout, stderr: c.stderr || "提交没有成功\n", seconds };
    }
    await git(["update-ref", "-m", "memento: 本机上的提交", localCommitsRef(taskId), sha], root, env);
    const committedTree = (await git(["rev-parse", `${sha}^{tree}`], wt, env)).stdout.trim();
    let hookPatch = "";
    if (committedTree !== staged) {
      const d = await gitRaw(["diff", "--binary", "--full-index", "--no-renames", "--no-color", "--no-ext-diff", staged, committedTree], wt, env);
      if (d?.length) hookPatch = await packPatch(d);
    }
    const subject = (await git(["log", "-1", "--format=%s", sha], wt, env)).stdout.trim();
    return {
      exit_code: 0,
      stdout: c.stdout,
      stderr: c.stderr,
      sha,
      subject,
      files: (await changedPaths(root, parent, sha, env)).slice(0, 500),
      ...(hookPatch ? { hook_patch_b64: hookPatch } : {}),
      seconds,
    };
   } finally {
    slot.release();
   }
  });
}

/** Largest file `memento-source get` brings over (it travels base64 in one message). */
export const GET_LIMIT = 8 * 1024 * 1024;

/** A file the task's commands made, relative to its checkout: the one it used last, else the newest copy in any. */
async function inCheckout(root: string, taskId: string, rel: string, file: string, home?: string): Promise<string> {
  const pref = taskId ? lastSlot.get(`${root}|${taskId}`) : undefined;
  const at = (slot: number) => resolve(checkDir(root, home, slot), rel, file);
  if (pref !== undefined && existsSync(at(pref))) return at(pref);
  let best: { path: string; mtime: number } | undefined;
  for (let i = 0; i < MAX_CHECKOUTS; i++) {
    const st = await stat(at(i)).catch(() => null);
    if (st?.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: at(i), mtime: st.mtimeMs };
  }
  return best?.path ?? at(pref ?? 0);
}

/**
 * The source's side of `workspace_get_req`: a file the agent's commands made there (a screenshot, a
 * log, a build artifact), relative to the task's checkout, or anywhere on the device by absolute path.
 */
export async function readOnSource(
  dir: string,
  data: Record<string, unknown>,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ data_b64: string; size: number; path: string }> {
  const env = options.env ?? (await executionEnvironment());
  const { root } = await repoOf(dir, env);
  const file = String(data.file ?? "").trim();
  if (!file) throw new WorkspaceError("没有给要取回的文件");
  const rel = String(data.rel ?? "").replaceAll("\\", "/");
  if (rel.split("/").includes("..") || isAbsolute(rel)) throw new WorkspaceError(`工作目录不对：${rel}`);
  const at = isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) ? file : await inCheckout(root, String(data.task_id ?? ""), rel, file, options.home);
  const st = await stat(at).catch(() => null);
  if (!st) throw new WorkspaceError(`这台设备上没有 ${at}`);
  if (!st.isFile()) throw new WorkspaceError(`${at} 不是文件`);
  if (st.size > GET_LIMIT) throw new WorkspaceError(`${at} 有 ${Math.round(st.size / 1048576)}MB，超过 ${GET_LIMIT / 1048576}MB，取不回来；先压缩或截取需要的部分`);
  return { data_b64: (await readFile(at)).toString("base64"), size: st.size, path: at };
}

// ── what the executor itself doesn't do ──────────────────────────────────

// At a command's start (or after ; && || | ( ), past sudo / env VAR=x / a path
const AT = String.raw`(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+)?(?:env\s+)?(?:\w+=\S*\s+)*(?:\S*/)?`;
const BLOCKED: Array<[RegExp, string]> = [
  [new RegExp(`${AT}git\\s+(?:-[Cc]\\s+\\S+\\s+|--?[\\w-]+(?:=\\S+)?\\s+)*(?:commit|push|merge|rebase|cherry-pick|revert|am|tag)\\b`), "提交和推送"],
  [new RegExp(`${AT}(?:npm|pnpm|yarn|bun)\\s+(?:install|i|ci|add|test|t|run|run-script|exec|build|start|dev)\\b`), "安装依赖、测试和构建"],
  [new RegExp(`${AT}(?:npx|pnpx|bunx|yarn\\s+dlx)\\s`), "运行项目工具"],
  [new RegExp(`${AT}(?:cargo|go)\\s+(?:build|test|run|install|check)\\b`), "构建和测试"],
  [new RegExp(`${AT}(?:uv\\s+(?:run|sync|pip|add)|pip3?\\s+install|poetry\\s+(?:install|run)|python3?\\s+-m\\s+(?:pytest|pip|unittest))\\b`), "安装依赖和测试"],
  [
    new RegExp(
      `${AT}(?:pytest|tox|nox|jest|vitest|mocha|playwright|cypress|tsc|eslint|ruff|mypy|pyright|gradle|gradlew|mvn|xcodebuild|xcrun|pod|fastlane|expo|eas|adb|emulator|flutter|docker|docker-compose|kubectl|helm|make|cmake|ninja)(?=\\s|$|;|&|\\|)`,
    ),
    "测试、构建和运行",
  ],
  [
    new RegExp(`${AT}(?:python3?(?:\\.\\d+)?|node|deno|bun|ruby|php|perl|java|bash|sh|zsh)\\s+(?:-(?![cem]\\b)\\S+\\s+)*[^\\s;&|-][^\\s;&|]*\\.(?:py|js|mjs|cjs|ts|rb|php|pl|jar|sh)(?=\\s|$|;|&|\\|)`),
    "运行程序和脚本",
  ],
  [new RegExp(`(?:^|[;&|(]|&&|\\|\\|)\\s*\\./[^\\s;&|]+`), "运行程序和脚本"],
];

/** What a shell command the agent runs on the executor would do there that belongs on the source, or undefined. */
export function executorOnlyEdits(command: string): string | undefined {
  if (/memento-source/.test(command)) return undefined;
  for (const [re, what] of BLOCKED) if (re.test(command)) return what;
  return undefined;
}

/** Why the executor turned a command down, for the agent: where to run it instead. */
export function executorDenyReason(what: string, command: string, sourceName: string): string {
  return (
    `这台设备只改代码，${what}在代码所在的「${sourceName}」上做。改用 \`${command} "<原命令>"\` 在「${sourceName}」上带着你的改动执行；` +
    `提交用 \`${command} commit -m "说明"\`（要推送加 --push）。`
  );
}

// ── files outside the project, written on the source ─────────────────────

/** `p` with links resolved as far as it exists (the rest, not there yet, kept as given). */
async function realDir(p: string): Promise<string> {
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    const real = await realpath(head).catch(() => undefined);
    if (real) return join(real, ...rest.reverse());
    const up = dirname(head);
    if (up === head) return resolve(p);
    rest.push(basename(head));
    head = up;
  }
}

/** Where files `put` overwrote are kept on the source, newest run first by date. */
export function editBackupDir(home = homeDir()): string {
  return join(home, ".memento", "source-edits");
}

/**
 * The source's side of `workspace_put_req`: a file the agent wrote, put anywhere on this device
 * outside the task's project (that goes back with the task's patch instead). What was there is copied
 * to ~/.memento/source-edits first. The server already turned down sensitive places (.ssh, .env, /etc…).
 */
export async function writeOnSource(
  dir: string,
  data: Record<string, unknown>,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ path: string; size: number; backup?: string }> {
  const env = options.env ?? (await executionEnvironment());
  const dest = String(data.dest ?? "").trim();
  if (!(isAbsolute(dest) || /^[A-Za-z]:[\\/]/.test(dest))) throw new WorkspaceError(`要写到的位置必须是绝对路径：${dest}`);
  const at = resolve(dest);
  const { root } = await repoOf(dir, env).catch(() => ({ root: dir }));
  // Compared as real paths: a link on the way (macOS /var → /private/var) mustn't hide that it's in the project
  const inside = relative(await realDir(root), await realDir(at));
  if (!inside || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new WorkspaceError("这是任务项目里的文件：直接在执行机的副本里改，任务结束会自动写回");
  }
  const content = Buffer.from(String(data.data_b64 ?? ""), "base64");
  if (content.length > GET_LIMIT) throw new WorkspaceError(`文件超过 ${GET_LIMIT / 1048576}MB`);
  const old = await stat(at).catch(() => null);
  if (old && !old.isFile()) throw new WorkspaceError(`${at} 不是文件`);
  let backup: string | undefined;
  if (old) {
    const day = new Date().toISOString().replace(/[:.]/g, "-");
    backup = join(editBackupDir(options.home), day, at.replace(/^[A-Za-z]:/, (d) => d[0]!).replace(/[\\/]+/g, "__"));
    await mkdir(dirname(backup), { recursive: true });
    await writeFile(backup, await readFile(at));
  }
  await mkdir(dirname(at), { recursive: true });
  await writeFile(at, content);
  return { path: at, size: content.length, ...(backup ? { backup } : {}) };
}

