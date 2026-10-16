import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { AgentEventLog, ClaudeStreamParser, CodexStreamParser, UniversalStreamParser, type AgentEvent, type AgentStreamParser } from "./agent-stream.js";
import { discoverAntigravityEnv, ensureAgyCliInstalled } from "./antigravity.js";
import { homeDir } from "./config.js";
import { executionEnvironment, findExecutable, killProcessTree, prepareCommand, withExeDirOnPath } from "./exec-env.js";
import { HookBridge } from "./hook-bridge.js";
import { ensureWorkbuddyCliInstalled } from "./workbuddy.js";
import { TaskWorktree } from "./worktree.js";

/** A task the server dispatched to this device. */
export interface TaskDispatch {
  id: string;
  /** "shell" | "agent" */
  action: string;
  payload: Record<string, unknown>;
  timeoutSeconds: number;
}

export function parseTaskDispatch(json: Record<string, unknown>): TaskDispatch {
  const action = String(json.action ?? "shell");
  const timeout = typeof json.timeout_seconds === "number" ? json.timeout_seconds : action === "agent" ? 7200 : 300;
  const payload = json.payload && typeof json.payload === "object" ? (json.payload as Record<string, unknown>) : {};
  return { id: String(json.id ?? ""), action, payload, timeoutSeconds: timeout };
}

export interface TaskFinished {
  taskId: string;
  status: "succeeded" | "failed" | "timeout" | "still_running";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string | null;
  errorType?: string | null;
  sessionId?: string | null;
  events?: readonly AgentEvent[];
}

export function taskFinishedMessage(f: TaskFinished): Record<string, unknown> {
  return {
    type: "task_finished",
    task_id: f.taskId,
    status: f.status,
    ...(f.exitCode !== undefined ? { exit_code: f.exitCode } : {}),
    ...(f.stdout !== undefined ? { stdout: f.stdout } : {}),
    ...(f.stderr !== undefined ? { stderr: f.stderr } : {}),
    ...(f.error != null ? { error: f.error } : {}),
    ...(f.errorType != null ? { error_type: f.errorType } : {}),
    ...(f.sessionId != null ? { session_id: f.sessionId } : {}),
    ...(f.events?.length ? { events: f.events } : {}),
  };
}

/**
 * Smart head-tail truncation for command outputs:
 * Keeps initial context (first ~40K chars) and final diagnostic/error traces (last ~100K chars),
 * folding the middle spam to prevent ballooning WebSocket frames and losing error stacks.
 */
export function smartTruncateOutput(text: string, maxChars = 150_000, headChars = 40_000, tailChars = 100_000): string {
  if (!text || text.length <= maxChars) return text;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omitted = text.length - headChars - tailChars;
  const omittedLines = text.slice(headChars, -tailChars).split("\n").length;
  return `${head}\n\n... [已自动折叠中间约 ${omittedLines} 行 / ${omitted.toLocaleString()} 字符日志] ...\n\n${tail}`;
}

const chunk = (taskId: string, stream: "stdout" | "stderr", text: string) => ({ type: "task_chunk", task_id: taskId, stream, text });

const claudeUserMessage = (text: string) => ({ type: "user", message: { role: "user", content: text } });

/** Claude Code in print mode with stream-json in and out: every tool call is an event, the prompt goes in on stdin, and follow-ups can be written while it runs. */
export function claudeArgs(o: { sessionId?: string; sysAppend?: string; model?: string; settingsJson?: string } = {}): string[] {
  return [
    "-p",
    ...(o.sessionId ? ["-r", o.sessionId] : []),
    ...(o.sysAppend ? ["--append-system-prompt", o.sysAppend] : []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    ...(o.model ? ["--model", o.model] : []),
    ...(o.settingsJson ? ["--settings", o.settingsJson] : []),
  ];
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** `codex exec` (or `exec resume|fork <id>`) with JSON events, no approvals. */
export function codexArgs(o: { workDir?: string; sessionId?: string; fork?: boolean; effort?: string; model?: string; prompt: string }): string[] {
  const sid = o.sessionId ? (UUID_RE.exec(o.sessionId)?.[0] ?? o.sessionId) : "";
  return [
    ...(o.workDir ? ["-C", o.workDir] : []),
    "exec",
    ...(sid ? [o.fork ? "fork" : "resume"] : []),
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    ...(o.effort ? ["-c", `model_reasoning_effort="${o.effort}"`] : []),
    ...(o.model ? ["-m", o.model] : []),
    ...(sid ? [sid] : []),
    o.prompt,
  ];
}

/** Errors that mean the session to resume isn't on this device (or the CLI didn't take the resume flags). */
export function isSessionNotFound(text: string): boolean {
  return (
    [
      "no rollout found",
      "thread not found",
      "session not found",
      "conversation not found",
      "Error resuming conversation",
      "failed to resume",
      "cannot resume",
      "unable to resume",
      "No conversation found",
      "could not find session",
      "no recorded session",
      "unexpected argument",
      "invalid value",
      "Usage: codex exec",
      "Usage: agy",
    ].some((s) => text.includes(s)) ||
    (text.includes("conversation") && text.includes("not found"))
  );
}

/**
 * Checks whether an agent or process exited while its background subtasks or
 * daemons are still actively running.
 */
export function detectStillRunning(
  stdout: string,
  stderr: string,
  parser: AgentStreamParser | undefined,
  exitCode: number,
): boolean {
  if (parser?.isStillRunning) return true;
  if (stdout.includes("STATUS_STILL_RUNNING") || stderr.includes("STATUS_STILL_RUNNING")) return true;

  if (exitCode !== 0) return false;

  const combined = `${stdout}\n${stderr}`;

  // 结构化后台任务 ID 精确配对（如 Antigravity task-xxx）：
  // 若所有已启动的结构化后台任务均已收到完成/取消回执，则不受后续总结正文中的自然语言词汇干扰
  const launchedIds = new Set<string>();
  for (const m of combined.matchAll(/(?:Tool is running as a background task with task id|Command running in background with ID|Task running in background with ID):\s*(?:[0-9a-fA-F-]+\/)?(task-\d+)/gi)) {
    if (m[1]) launchedIds.add(m[1]);
  }
  for (const m of combined.matchAll(/⏳\s*\[(?:后台任务启动:|等待后台任务)\s*(?:[0-9a-fA-F-]+\/)?(task-\d+)/gi)) {
    if (m[1]) launchedIds.add(m[1]);
  }

  if (launchedIds.size > 0) {
    const completedIds = new Set<string>();
    for (const m of combined.matchAll(/[✅⏹️]\s*\[后台任务\s+(?:[0-9a-fA-F-]+\/)?(task-\d+)\s+(?:执行完毕|已结束|已取消|已终止|已由 Agent 主动终止)/gi)) {
      if (m[1]) completedIds.add(m[1]);
    }
    const allFinished = Array.from(launchedIds).every((id) => completedIds.has(id));
    return !allFinished;
  }

  const bgPatterns = [
    /Tool is running as a background task/i,
    /The command was sent to the background as a task/i,
    /running as a background task with task id/i,
    /Command running in background with ID:/i,
    /Task running in background with ID:/i,
    /⏳\s*\[(?:等待后台任务|后台任务启动|后台任务运行中|后台任务 \S+ (?:执行中|持续执行中|持续运行中))/i,
    /(?:已转入|仍在|正在|已置于|提交至)后台(?:运行|执行|持续执行)/i,
    /(?:后台任务|后台进程)(?:已启动|正在执行|仍在运行|未完成)/i,
    /(?:is |still )running in the background/i,
    /background task (?:started|is running|in progress)/i,
    /Agent \S+ running in background/i,
    /Subagent \S+ is running in the background/i,
  ];

  let hasBg = false;
  let lastBgIdx = -1;
  for (const re of bgPatterns) {
    const matches = Array.from(combined.matchAll(new RegExp(re, "gi")));
    for (const m of matches) {
      hasBg = true;
      if (m.index !== undefined && m.index > lastBgIdx) {
        lastBgIdx = m.index;
      }
    }
  }

  if (!hasBg) return false;

  const completionPatterns = [
    /后台任务已(?:执行完毕|完成|结束|取消|终止)/i,
    /background task (?:completed|finished|exited|canceled|cancelled|terminated)/i,
    /[✅⏹️]\s*\[后台任务 \S+ (?:执行完毕|已结束|已取消|已终止|已由 Agent 主动终止)/i,
  ];

  let lastCompIdx = -1;
  for (const re of completionPatterns) {
    const matches = Array.from(combined.matchAll(new RegExp(re, "gi")));
    for (const m of matches) {
      if (m.index !== undefined && m.index > lastCompIdx) {
        lastCompIdx = m.index;
      }
    }
  }

  if (lastCompIdx > lastBgIdx) return false;

  return true;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** On macOS, whether /Volumes/<name> is mounted: touching an unmounted network volume pops a permission prompt. */
export function isVolumeMountedOnMac(path: string): boolean {
  if (process.platform !== "darwin" || !path.startsWith("/Volumes/")) return true;
  const name = path.split("/")[2];
  if (!name) return false;
  try {
    return readdirSync("/Volumes").includes(name);
  } catch {
    return false;
  }
}

/**
 * Where a task runs: the directory it names when that exists here, else a
 * same-named project under the usual folders (tasks sent from another OS carry
 * that machine's path), else the home directory — never "/".
 */
export function resolveWorkingDir(rawCwd: string | undefined, log: (m: string) => void = () => {}, home = homeDir()): string | undefined {
  let candidate = rawCwd?.trim();
  if (candidate) {
    if (candidate.startsWith("~")) candidate = candidate.replace("~", home);
    if (process.platform === "darwin" && candidate.startsWith("/Volumes/") && !isVolumeMountedOnMac(candidate)) {
      log(`Skipping unmounted macOS volume path: ${candidate}`);
    } else if (isDir(candidate)) {
      return candidate;
    }
  }
  const name = rawCwd?.replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop();
  if (name) {
    const probes = ["", "dev", "Projects", "Documents", "Workspace", "Desktop", "code", "src"].map((d) =>
      d ? `${home}/${d}/${name}` : `${home}/${name}`,
    );
    if (process.platform === "win32") probes.push(`D:/dev/${name}`, `D:/Projects/${name}`, `E:/dev/${name}`, `C:/dev/${name}`);
    for (const p of probes) {
      if (isDir(p)) {
        log(`Auto-aligned CWD to local directory: ${p}`);
        return p;
      }
    }
  }
  if (isDir(home)) {
    log(`CWD fallback to user home directory: ${home}`);
    return home;
  }
  return undefined;
}

interface RunSpec {
  exe: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  parser?: AgentStreamParser | undefined;
  stdinPrompt?: string | undefined;
}

const TIMED_OUT = -999;

type Send = (message: Record<string, unknown>) => void;

/**
 * Runs dispatched tasks: shell commands and agent CLIs (Claude Code, Codex,
 * Antigravity). Streams output and structured steps back through `send`,
 * accepts follow-ups for running Claude tasks, and reports the result.
 */
export class TaskRunner {
  private readonly running = new Map<string, ChildProcess>();
  private readonly outputs = new Map<string, { stdout: string; stderr: string }>();
  /** Claude tasks keep stdin open for follow-up instructions until their run ends. */
  private readonly steerInputs = new Map<string, NodeJS.WritableStream & { writable: boolean }>();
  private readonly claudeTasks = new Set<string>();
  private readonly eventLogs = new Map<string, AgentEventLog>();
  private hookBridge: HookBridge | undefined;

  constructor(
    private readonly send: Send,
    private readonly log: (message: string) => void = () => {},
  ) {}

  get runningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  emitEvent(taskId: string, event: AgentEvent): void {
    const row = this.eventLogs.get(taskId)?.add(event) ?? { ...event, at: new Date().toISOString() };
    this.send({ type: "agent_event", task_id: taskId, event: row });
  }

  cancel(taskId: string): boolean {
    const proc = this.running.get(taskId);
    if (!proc) return false;
    this.log(`Cancelling task ${taskId}`);
    this.running.delete(taskId);
    killProcessTree(proc);
    return true;
  }

  /** A follow-up from the user: steers a running Claude/Antigravity/WorkBuddy task or goes to process stdin. */
  input(taskId: string, text: string): void {
    const steer = this.steerInputs.get(taskId);
    if (steer) {
      if (steer.writable) {
        if (this.claudeTasks.has(taskId)) {
          steer.write(`${JSON.stringify(claudeUserMessage(text))}\n`);
        } else {
          steer.write(`${text}\n`);
        }
        // Mark any waiting question in this task's event log as answered
        const eventLog = this.eventLogs.get(taskId);
        if (eventLog) {
          const waitingQ = eventLog.events.find(
            (e) => e.kind === "question" && (e.status === "waiting" || !e.status),
          );
          if (waitingQ && waitingQ.id) {
            this.emitEvent(taskId, {
              kind: "question",
              id: waitingQ.id,
              status: "answered",
              answer: text,
            });
          }
        }
        this.emitEvent(taskId, { kind: "steer", text, status: "sent" });
        const echo = `\n[输入] ${text}\n`;
        const out = this.outputs.get(taskId);
        if (out) out.stdout += echo;
        this.send(chunk(taskId, "stdout", echo));
      } else {
        this.emitEvent(taskId, { kind: "steer", text, status: "late" });
      }
      return;
    }
    const proc = this.running.get(taskId);
    if (proc?.stdin?.writable) {
      proc.stdin.write(`${text}\n`);
      const eventLog = this.eventLogs.get(taskId);
      if (eventLog) {
        const waitingQ = eventLog.events.find(
          (e) => e.kind === "question" && (e.status === "waiting" || !e.status),
        );
        if (waitingQ && waitingQ.id) {
          this.emitEvent(taskId, {
            kind: "question",
            id: waitingQ.id,
            status: "answered",
            answer: text,
          });
        }
      }
      this.emitEvent(taskId, { kind: "steer", text, status: "sent" });
      const echo = `\n[输入] ${text}\n`;
      const out = this.outputs.get(taskId);
      if (out) out.stdout += echo;
      this.send(chunk(taskId, "stdout", echo));
      return;
    }
    this.emitEvent(taskId, { kind: "steer", text, status: "late" });
  }

  dispose(): void {
    for (const proc of this.running.values()) killProcessTree(proc);
    this.running.clear();
    this.outputs.clear();
    void this.hookBridge?.stop();
    this.hookBridge = undefined;
  }

  /** Starts one process for the task and resolves with its exit code (TIMED_OUT on timeout). */
  private async runOnce(taskId: string, spec: RunSpec, timeoutSeconds: number): Promise<number> {
    const prep = await prepareCommand(spec.exe, spec.args);
    const proc = spawn(prep.executable, prep.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      // Its own process group, so cancelling reaches everything it started.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.running.set(taskId, proc);
    const out = this.outputs.get(taskId)!;
    const { parser } = spec;

    proc.stdin.on("error", () => {});
    this.steerInputs.set(taskId, proc.stdin);
    if (spec.stdinPrompt !== undefined && parser instanceof ClaudeStreamParser) {
      proc.stdin.write(`${JSON.stringify(claudeUserMessage(spec.stdinPrompt))}\n`);
    }

    const stdoutDone = new Promise<void>((resolve) => proc.stdout.once("end", () => resolve()));

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;

    const cmdLine = `${spec.exe} ${spec.args?.join(" ")} ${spec.stdinPrompt ?? ""}`;
    const isHeavyCommand = /\b(?:cargo\s+build|flutter\s+build|npm\s+run\s+build|docker\s+build|mvn\s+package|gradle\s+build|git\s+clone)\b/i.test(
      cmdLine,
    );
    // Dynamically grant at least 300s (5 minutes) for heavy build/compilation jobs if a small timeout (<300s) was passed
    const effectiveTimeout = isHeavyCommand && timeoutSeconds > 0 && timeoutSeconds < 300 ? 300 : timeoutSeconds;

    const hasWaitingQuestion = () => {
      const el = this.eventLogs.get(taskId);
      return el?.events.some((e) => e.kind === "question" && (e.status === "waiting" || !e.status)) ?? false;
    };

    const armStallWatchdog = () => {
      if (stallTimer) clearTimeout(stallTimer);
      // If process runs for 5 minutes with zero output, send a progress heartbeat alert
      stallTimer = setTimeout(() => {
        this.send({
          type: "task_progress",
          task_id: taskId,
          status: "进程正在静默运行中（超过 5 分钟无新输出，可能处于深度计算或等待输入）",
        });
      }, 300_000);
    };

    // Activity-based watchdog: refreshed whenever process produces stdout/stderr, disabled if timeoutSeconds <= 0
    const armTimer = () => {
      armStallWatchdog();
      if (effectiveTimeout > 0) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (hasWaitingQuestion()) {
            // User is reviewing an interactive question dialog; defer timeout
            armTimer();
            return;
          }
          timedOut = true;
          killProcessTree(proc);
        }, effectiveTimeout * 1000);
      }
    };
    armTimer();

    if (!parser) {
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (text: string) => {
        armTimer();
        if (out.stdout.length < 2_500_000) {
          out.stdout += text;
        } else if (!out.stdout.endsWith("[...后续输出过大已转为实时流式传输...]\n")) {
          out.stdout += "\n[...后续输出过大已转为实时流式传输...]\n";
        }
        this.send(chunk(taskId, "stdout", text));
      });
    } else {
      createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", (line) => {
        armTimer();
        const events = parser.feed(line);
        if (events === null) {
          if (!line.trim()) return;
          if (out.stdout.length < 2_500_000) {
            out.stdout += `${line}\n`;
          }
          this.send(chunk(taskId, "stdout", `${line}\n`));
          return;
        }
        for (const e of events) {
          if (e.kind === "text") {
            // What the agent says along the way; the final answer replaces it at the end.
            const text = `${String(e.text)}\n\n`;
            out.stdout += text;
            this.send(chunk(taskId, "stdout", text));
          } else {
            this.emitEvent(taskId, e);
          }
        }
        if (parser instanceof ClaudeStreamParser && parser.finished && (parser.queuedTurns ?? 0) === 0) {
          const sink = this.steerInputs.get(taskId);
          this.steerInputs.delete(taskId);
          sink?.end();
        }
      });
    }
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (text: string) => {
      armTimer();
      out.stderr += text;
      this.send(chunk(taskId, "stderr", text));
    });

    return new Promise<number>((resolve, reject) => {
      proc.once("error", (e) => {
        if (timer) clearTimeout(timer);
        if (stallTimer) clearTimeout(stallTimer);
        reject(e);
      });
      proc.once("exit", (code, signal) => {
        if (timer) clearTimeout(timer);
        if (stallTimer) clearTimeout(stallTimer);
        // Let the last output drain, but don't wait on a pipe some leftover child still holds.
        void Promise.race([stdoutDone, new Promise((r) => setTimeout(r, 3000))]).then(() =>
          resolve(timedOut ? TIMED_OUT : (code ?? (signal ? -1 : 1))),
        );
      });
    });
  }

  private notice(taskId: string, text: string): void {
    const out = this.outputs.get(taskId);
    if (out) out.stderr += text;
    this.send(chunk(taskId, "stderr", text));
  }

  async execute(task: TaskDispatch): Promise<void> {
    const taskId = task.id;
    const { action, payload } = task;
    const text = (key: string) => (payload[key] == null ? "" : String(payload[key]));
    let workDir = resolveWorkingDir(text("cwd"), this.log);

    let exe = "";
    let args: string[] = [];
    let isAntigravity = false;
    // Structured agents (Claude, Codex) report every step through the parser.
    let parser: AgentStreamParser | undefined;
    let stdinPrompt: string | undefined;
    let claudeSettings: string | undefined;
    let worktree: TaskWorktree | undefined;

    const binary = (text("binary") || "claude").toLowerCase();
    const prompt = text("prompt");
    const sessionId = text("session_id");
    const model = text("model");
    const effort = text("effort");
    const sysAppend = text("system_prompt_append");

    // Materialize uploaded base64 images on the local device so local Agent CLI can view them
    if (Array.isArray(payload.images) && payload.images.length > 0) {
      const convId =
        text("conversation_id") ||
        prompt.match(/\/tmp\/memento_images\/([a-zA-Z0-9_-]+)\//)?.[1] ||
        taskId;
      const imgDir = join("/tmp/memento_images", convId);
      try {
        mkdirSync(imgDir, { recursive: true });
        for (let idx = 0; idx < payload.images.length; idx++) {
          const img = String(payload.images[idx] ?? "");
          if (img.startsWith("data:image/")) {
            const commaIdx = img.indexOf(",");
            if (commaIdx > 0) {
              const header = img.slice(0, commaIdx);
              const b64data = img.slice(commaIdx + 1);
              const mime = header.split(";")[0]?.split(":")[1] ?? "image/png";
              let ext = mime.split("/")[1] ?? "png";
              if (ext === "jpeg") ext = "jpg";
              const imgPath = join(imgDir, `image_${idx + 1}.${ext}`);
              writeFileSync(imgPath, Buffer.from(b64data, "base64"));
            }
          }
        }
      } catch (err) {
        this.log(`Failed to materialize local image attachments: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (action === "shell") {
      const command = text("command");
      if (process.platform === "win32") {
        exe = "powershell.exe";
        args = ["-NoProfile", "-NonInteractive", "-Command", command];
      } else {
        exe = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
        args = ["-c", command];
      }
    } else {
      isAntigravity = binary.includes("agy") || binary.includes("antigravity");
      const isWorkbuddy = binary.includes("workbuddy") || binary.includes("codebuddy");
      if (isAntigravity) await ensureAgyCliInstalled();
      if (isWorkbuddy) await ensureWorkbuddyCliInstalled();
      const candidates = [binary];
      if (binary === "agy") candidates.push("agy_cli.py", "agentapi");
      else if (binary === "antigravity") candidates.push("agy", "agy_cli.py", "agentapi");
      else if (binary === "workbuddy") candidates.push("workbuddy_cli.mjs", "codebuddy");
      const resolved = await findExecutable(candidates);
      if (!resolved) {
        let tip = "";
        if (isAntigravity) {
          tip =
            process.platform === "win32"
              ? "\n💡 Antigravity CLI 未安装，请在 PowerShell 中执行以下命令进行安装：\nirm https://antigravity.google/cli/install.ps1 | iex"
              : "\n💡 Antigravity CLI 未安装，请在终端中执行以下命令进行安装：\ncurl -fsSL https://antigravity.google/cli/install.sh | bash";
        } else if (isWorkbuddy) {
          tip = "\n💡 未检测到 CodeBuddy/WorkBuddy 命令行工具。请运行 npm install -g @tencent-ai/codebuddy-code 进行安装，并确保腾讯 WorkBuddy 客户端保持启动。";
        } else if (binary.includes("claude")) {
          tip = "\n💡 请运行 npm install -g @anthropic-ai/claude-code 安装 Claude Code CLI";
        } else if (binary.includes("codex")) {
          tip = "\n💡 请运行 npm install -g @openai/codex 或参考 Codex 官方文档安装 Codex CLI";
        }
        this.send(
          taskFinishedMessage({ taskId, status: "failed", exitCode: 1, error: `Agent CLI executable not found on device: ${binary}${tip}` }),
        );
        return;
      }
      exe = resolved;
      this.eventLogs.set(taskId, new AgentEventLog());

      // Its own worktree and branch, so parallel tasks on one repository don't collide.
      if (payload.worktree === true && workDir) {
        const made = await TaskWorktree.create(workDir, taskId, { env: await executionEnvironment() });
        if (made.tree) {
          worktree = made.tree;
          workDir = made.tree.workDir;
          this.emitEvent(taskId, { kind: "worktree", status: "created", branch: made.tree.branch, path: made.tree.path });
        } else {
          this.emitEvent(taskId, { kind: "worktree", status: "skipped", reason: made.reason });
        }
      }

      if (binary.includes("claude")) {
        const settings: Record<string, unknown> = {};
        if (effort) settings.effortLevel = effort;
        // Report each tool call to the server, which pushes risky ones to the phone.
        this.hookBridge ??= new HookBridge((tid, use) => this.send({ type: "agent_tool_use", task_id: tid, ...use }));
        const hooks = await this.hookBridge.claudeHooks(taskId);
        if (hooks) settings.hooks = hooks;
        claudeSettings = Object.keys(settings).length ? JSON.stringify(settings) : undefined;
        args = claudeArgs({ sessionId, sysAppend, model, settingsJson: claudeSettings });
        parser = new ClaudeStreamParser();
        stdinPrompt = prompt;
        this.claudeTasks.add(taskId);
      } else if (binary.includes("codex")) {
        args = codexArgs({ workDir, sessionId, fork: payload.fork === true, effort, model, prompt });
        parser = new CodexStreamParser();
      } else if (isWorkbuddy) {
        const isMjsRunner = exe.endsWith("workbuddy_cli.mjs");
        if (isMjsRunner) {
          args = [
            ...(sessionId ? ["--resume", sessionId] : []),
            ...(model ? ["--model", model] : []),
            ...(effort ? ["--effort", effort] : []),
            ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
            "-p",
            prompt,
          ];
          parser = new UniversalStreamParser();
        } else {
          // Native WorkBuddy / CodeBuddy CLI supports Claude-compatible stream-json
          args = [
            "--output-format",
            "stream-json",
            ...(sessionId ? ["--resume", sessionId, "--resume-create-missing"] : []),
            ...(model ? ["--model", model] : []),
            ...(effort ? ["--effort", effort] : []),
            ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
            "-p",
            prompt,
          ];
          parser = new ClaudeStreamParser();
        }
      } else {
        args = [
          ...(sessionId ? ["--resume", sessionId] : []),
          ...(model ? ["--model", model] : []),
          ...(task.timeoutSeconds > 0 ? ["--timeout", String(Math.max(60, task.timeoutSeconds - 15))] : ["--timeout", "0"]),
          "-p",
          prompt,
        ];
        parser = new UniversalStreamParser();
      }
    }

    this.send({ type: "task_progress", task_id: taskId, status: "running" });
    const out = { stdout: "", stderr: "" };
    this.outputs.set(taskId, out);

    try {
      const env = withExeDirOnPath(await executionEnvironment(), exe);
      if (isAntigravity) {
        const ag = await discoverAntigravityEnv();
        if (!ag) {
          this.send(
            taskFinishedMessage({
              taskId,
              status: "failed",
              exitCode: 1,
              error:
                "💡 未检测到正在运行的 Antigravity 应用服务。\n\nAntigravity 需在本地保持运行以便通过 language_server 进行通信。\n请先启动 Antigravity 客户端应用后再试。",
            }),
          );
          return;
        }
        Object.assign(env, ag);
      }
      const run = (spec: Omit<RunSpec, "exe" | "cwd" | "env">) =>
        this.runOnce(taskId, { exe, cwd: workDir, env, ...spec }, task.timeoutSeconds);

      let exitCode = await run({ args, parser, stdinPrompt });
      // Errors can come on stderr or inside the JSON stream; retries look at both.
      const errScan = () => `${out.stderr}\n${parser?.errors ?? ""}`;

      // Retry 0: Antigravity's language server moved.
      if (exitCode !== 0 && isAntigravity && (out.stderr + out.stdout).includes("ANTIGRAVITY_LS_ADDRESS is not set")) {
        this.notice(taskId, "\n⚡ [环境自愈] 正在重新检测并绑定本地 Antigravity 运行端口...\n\n");
        const ag = await discoverAntigravityEnv(true);
        if (ag) {
          Object.assign(env, ag);
          exitCode = await run({ args });
        }
      }

      // Retry 1: the ChatGPT app holds the Codex session's writer lock, so fork it instead.
      if (exitCode !== 0 && binary.includes("codex") && sessionId && payload.fork !== true && errScan().includes("already has an active writer")) {
        this.notice(taskId, "\n⚡ [自动重试] 该会话当前正被 ChatGPT 客户端占用锁定，已自动无缝切换为 Fork 分支模式重新执行（完整继承上下文记忆）...\n\n");
        parser = new CodexStreamParser();
        exitCode = await run({ args: codexArgs({ workDir, sessionId, fork: true, effort, model, prompt }), parser });
      }

      // Retry 2: the session to resume isn't on this device (common when dispatching across devices): start fresh.
      const sessionNotFoundDetected = isSessionNotFound(errScan());
      if ((exitCode !== 0 || (!out.stdout.trim() && !parser?.finalText?.trim())) && action !== "shell" && sessionId && sessionNotFoundDetected) {
        this.notice(taskId, "\n⚡ [自动自愈] 本地未找到历史会话（跨设备远程调度或会话过期常见），已自动重置为全新会话重新执行...\n\n");
        if (binary.includes("claude")) {
          parser = new ClaudeStreamParser();
          exitCode = await run({ args: claudeArgs({ sysAppend, model, settingsJson: claudeSettings }), parser, stdinPrompt: prompt });
        } else if (binary.includes("codex")) {
          parser = new CodexStreamParser();
          exitCode = await run({ args: codexArgs({ workDir, effort, model, prompt }), parser });
        } else if (binary.includes("workbuddy") || binary.includes("codebuddy")) {
          const isMjsRunner = exe.endsWith("workbuddy_cli.mjs");
          if (isMjsRunner) {
            parser = new UniversalStreamParser();
            exitCode = await run({
              args: [
                ...(model ? ["--model", model] : []),
                ...(effort ? ["--effort", effort] : []),
                ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
                "-p",
                prompt,
              ],
              parser,
            });
          } else {
            parser = new ClaudeStreamParser();
            exitCode = await run({
              args: [
                "--output-format",
                "stream-json",
                ...(model ? ["--model", model] : []),
                ...(effort ? ["--effort", effort] : []),
                ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
                "-p",
                prompt,
              ],
              parser,
            });
          }
        } else {
          parser = new UniversalStreamParser();
          exitCode = await run({ args: [...(model ? ["--model", model] : []), "-p", prompt], parser });
        }
      }

      if (exitCode !== 0 && process.platform === "darwin" && /Operation not permitted|Permission denied/.test(out.stderr)) {
        this.notice(
          taskId,
          "\n💡 [权限提示] 检测到 macOS 磁盘访问受限。请在「系统设置 -> 隐私与安全性 -> 完全磁盘访问权限」中添加并开启 Memento。\n",
        );
      }

      let fullOut = out.stdout.trim();
      const fullErr = out.stderr.trim();
      // A structured run's answer is its final message, not everything said along the way.
      const answer = parser?.finalText?.trim();
      if (answer) {
        fullOut = answer;
      } else {
        fullOut = smartTruncateOutput(fullOut);
      }
      const safeErr = smartTruncateOutput(fullErr, 80_000, 20_000, 60_000);
      const streamErrors = parser?.errors.trim() ?? "";
      const timedOut = exitCode === TIMED_OUT;
      const hasStillRunningTag = out.stdout.includes("STATUS_STILL_RUNNING") || fullErr.includes("STATUS_STILL_RUNNING");
      const isStillRunning = (!timedOut || hasStillRunningTag) && detectStillRunning(out.stdout, fullErr, parser, exitCode);
      const promptTooLong = errScan().includes("Prompt is too long") || fullOut.includes("Prompt is too long");

      const sid =
        /session id:\s*([0-9a-fA-F-]+)/i.exec(fullOut)?.[1] ??
        /session id:\s*([0-9a-fA-F-]+)/i.exec(fullErr)?.[1] ??
        /thread[_-]id:\s*([0-9a-fA-F-]+)/i.exec(fullOut)?.[1];

      if (worktree) {
        try {
          this.emitEvent(taskId, await worktree.finish(await executionEnvironment()));
        } catch (e) {
          this.log(`Worktree wrap-up failed for ${taskId}: ${e instanceof Error ? e.message : e}`);
        }
      }

      const sessionFailedFinal = !fullOut && (isSessionNotFound(fullErr) || isSessionNotFound(streamErrors));
      const effectiveExitCode = sessionFailedFinal && exitCode === 0 ? 1 : exitCode;

      this.send(
        taskFinishedMessage({
          taskId,
          status: timedOut && !isStillRunning ? "timeout" : isStillRunning ? "still_running" : effectiveExitCode === 0 ? "succeeded" : "failed",
          exitCode: effectiveExitCode,
          stdout: fullOut,
          stderr: safeErr,
          error: timedOut
            ? `Task timed out after ${task.timeoutSeconds}s`
            : effectiveExitCode !== 0
              ? fullErr || streamErrors || (sessionFailedFinal ? "会话未找到或已过期" : `Exit code ${effectiveExitCode}`)
              : null,
          errorType: promptTooLong ? "prompt_too_long" : null,
          sessionId: parser?.sessionId ?? sid ?? (sessionFailedFinal ? null : (sessionId || null)),
          events: this.eventLogs.get(taskId)?.events,
        }),
      );
    } catch (e) {
      this.send(taskFinishedMessage({ taskId, status: "failed", exitCode: 1, error: `Execution failed to start: ${e instanceof Error ? e.message : e}` }));
    } finally {
      this.outputs.delete(taskId);
      this.eventLogs.delete(taskId);
      this.claudeTasks.delete(taskId);
      this.steerInputs.get(taskId)?.end();
      this.steerInputs.delete(taskId);
      this.running.delete(taskId);
    }
  }
}
