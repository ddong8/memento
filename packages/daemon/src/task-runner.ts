import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { AgentEventLog, ClaudeStreamParser, CodexStreamParser, UniversalStreamParser, type AgentEvent, type AgentStreamParser } from "./agent-stream.js";
import { antigravityExecutable, discoverAntigravityEnv } from "./antigravity.js";
import { homeDir } from "./config.js";
import { LineDecoder, windowsConsoleEncoding } from "./console-text.js";
import { executionEnvironment, findExecutable, killProcessTree, prepareCommand, withExeDirOnPath } from "./exec-env.js";
import { HookBridge } from "./hook-bridge.js";
import { getOfflineMindSnapshot } from "./profile-inject.js";
import { codexRunner } from "./codex.js";
import {
  adoptWorkbuddySession,
  cancelWorkbuddySession,
  ensureWorkbuddyCliInstalled,
  ensureWorkbuddyGateway,
  isWorkbuddyDirGateway,
  reapWorkbuddyGateways,
  stopWorkbuddyGateway,
  touchWorkbuddyGateway,
  workbuddyCliDir,
  type WorkbuddyGatewayHandle,
} from "./workbuddy.js";
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
  status: "succeeded" | "failed" | "timeout" | "still_running" | "cancelled";
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

export interface BackoffWithJitterOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  jitterRatio?: number;
}

export function computeBackoffWithJitter(
  attempt: number,
  options: BackoffWithJitterOptions = {},
): number {
  const {
    baseMs = 1500,
    maxMs = 30_000,
    factor = 2,
    jitterRatio = 0.3,
  } = options;
  const rawBackoff = Math.min(baseMs * Math.pow(factor, Math.max(0, attempt)), maxMs);
  const jitterRange = rawBackoff * jitterRatio;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(500, Math.min(maxMs, Math.round(rawBackoff + jitter)));
}

export interface TaskChunkMessage {
  type: "task_chunk";
  task_id: string;
  stream: "stdout" | "stderr";
  text: string;
  seq?: number;
  timestamp?: number;
}

export const chunk = (taskId: string, stream: "stdout" | "stderr", text: string, seq?: number): TaskChunkMessage => ({
  type: "task_chunk",
  task_id: taskId,
  stream,
  text,
  ...(seq !== undefined ? { seq } : {}),
});

const claudeUserMessage = (text: string) => ({ type: "user", message: { role: "user", content: text } });

/**
 * Claude Code's auto-compact window for a task, from the user's setting the server puts in the payload:
 * a token count Claude Code accepts (100k–1M), else undefined and Claude Code keeps its own default
 * (about 967k on 1M-context models). Every step of a run carries the whole context, so a run left to
 * grow to 300k+ costs far more per step than one compacted at 200k.
 */
export function autoCompactWindow(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 100_000 && n <= 1_000_000 ? n : undefined;
}

/** Claude Code in print mode with stream-json in and out: every tool call is an event, the prompt goes in on stdin, and follow-ups can be written while it runs. */
export function claudeArgs(o: { sessionId?: string; sysAppend?: string; model?: string; settingsJson?: string; sessionName?: string } = {}): string[] {
  return [
    "-p",
    ...(o.sessionId ? ["-r", o.sessionId] : []),
    ...(o.sessionName ? ["--name", o.sessionName] : []),
    ...(o.sysAppend ? ["--append-system-prompt", o.sysAppend] : []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    // AskUserQuestion only exists when something can answer it: with this the CLI asks over stdin/stdout
    // (control_request / control_response), and every other tool stays allowed by the flag above.
    "--permission-prompt-tool",
    "stdio",
    ...(o.model ? ["--model", o.model] : []),
    ...(o.settingsJson ? ["--settings", o.settingsJson] : []),
  ];
}

/** The client name memento's Claude Code runs go out under, instead of the sdk-cli every `claude -p` gets. */
export const CLAUDE_CLIENT_NAME = "memento";

/**
 * Environment for a Claude Code run. Claude Code puts CLAUDE_CODE_ENTRYPOINT on its requests (User-Agent and
 * billing header) and in the transcript. As sdk-cli, its sessions are hidden from `claude --resume` in the
 * terminal, and the 5-hour limit is reported to drain 1.6–2.9x faster (anthropics/claude-code#97074). Under
 * its own name it is an ordinary client, which also brings the Artifact tools (about 7k tokens a request, and
 * it publishes pages to claude.ai): those are turned off, leaving requests about 450 tokens larger than as
 * sdk-cli. `entrypoint` is the user's setting from the server: "sdk-cli" keeps Claude Code's own name.
 */
export function claudeClientEnv(entrypoint: unknown): NodeJS.ProcessEnv {
  if (entrypoint === "sdk-cli") return {};
  return { CLAUDE_CODE_ENTRYPOINT: CLAUDE_CLIENT_NAME, CLAUDE_CODE_DISABLE_ARTIFACT: "1" };
}

// Context the server puts in front of the user's prompt when continuing a session or a conversation
const INJECTED_CONTEXT_RES = [
  /^【前序会话核心记忆快照[\s\S]*?【执行规则】[\s\S]*?当前用户指令[：:]\s*/,
  /^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*/,
  /^【前文对话历史】[\s\S]*?【当前用户指令】\s*/,
];

/** The name Claude Code shows for a session Memento runs: the conversation's title, so it reads the same
 * every turn and after a continuation; else what the user asked, not the context put in front of it. */
export function claudeSessionName(title: string, question: string, prompt: string): string | undefined {
  let base = title.trim() || question.trim();
  if (!base) {
    base = prompt;
    for (const re of INJECTED_CONTEXT_RES) {
      const stripped = base.replace(re, "");
      if (stripped !== base) {
        base = stripped;
        break;
      }
    }
  }
  const name = base.replace(/[\r\n\t]+/g, " ").trim().slice(0, 32).trim();
  return name ? `Memento: ${name}` : undefined;
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** `codex exec` (or `exec resume|fork <id>`) with JSON events, no approvals. */
/** assets/codex_app.mjs on the given Codex binary: it drives `codex app-server`, so Codex can ask the user mid-task. */
export function codexArgs(o: {
  runner: string;
  codex: string;
  workDir?: string;
  sessionId?: string;
  fork?: boolean;
  effort?: string;
  model?: string;
  prompt: string;
}): string[] {
  const sid = o.sessionId ? (UUID_RE.exec(o.sessionId)?.[0] ?? o.sessionId) : "";
  return [
    o.runner,
    "--codex",
    o.codex,
    ...(o.workDir ? ["-C", o.workDir] : []),
    ...(sid ? ["--resume", sid, ...(o.fork ? ["--fork"] : [])] : []),
    ...(o.effort ? ["--effort", o.effort] : []),
    ...(o.model ? ["--model", o.model] : []),
    "--",
    o.prompt,
  ];
}

/**
 * Arguments for invoking the Antigravity CLI (`agy` / `agy.exe` or `agy_cli.py`).
 *
 * Official `agy` (Go CLI) parameter protocol:
 *   - `--conversation <id>`: Resume previous conversation by ID (does NOT support `--resume`)
 *   - `--print-timeout <duration>`: Non-interactive turn timeout (e.g. `300s`, does NOT support `--timeout`)
 *   - `--dangerously-skip-permissions`: Headless tool auto-approval without terminal prompting
 *   - `-p <prompt>`: Single prompt non-interactive print mode
 *   - `--model <model>`: Model tier or ID
 *   - `--effort <effort>`: Reasoning effort (low|medium|high|xhigh|max)
 */
export function antigravityArgs(o: {
  sessionId?: string;
  model?: string;
  effort?: string;
  timeoutSeconds?: number;
  prompt: string;
}): string[] {
  const args: string[] = [];
  const sid = o.sessionId ? (UUID_RE.exec(o.sessionId)?.[0] ?? o.sessionId.trim()) : "";
  if (sid) {
    args.push("--conversation", sid);
  }
  if (o.model) {
    args.push("--model", o.model);
  }
  if (o.effort) {
    args.push("--effort", o.effort);
  }
  if (o.timeoutSeconds && o.timeoutSeconds > 0) {
    const s = Math.max(60, o.timeoutSeconds - 15);
    args.push("--print-timeout", `${s}s`);
  }
  args.push("--dangerously-skip-permissions");
  args.push("-p", o.prompt);
  return args;
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
      "Usage of agy",
      "flags provided but not defined: -resume",
      "flags provided but not defined: -conversation",
    ].some((s) => text.includes(s)) ||
    (text.includes("conversation") && text.includes("not found"))
  );
}

const CLAUDE_LOGIN_LOST = /Please run \/login|OAuth session expired|could not be refreshed|OAuth token (?:has expired|revoked)|Not logged in/i;
const CODEX_LOGIN_LOST =
  /refresh token (?:was already used|has expired|is invalid)|refresh_token_(?:reused|expired|invalidated)|token_expired|(?:log out and )?sign in again|try signing in again|run `?codex login|Not logged in/i;

/**
 * What to tell the user when the agent's own login on this device is gone (only signing in again
 * fixes it); undefined when the output says nothing of the kind.
 */
export function agentLoginHint(binary: string, text: string, device = hostname()): string | undefined {
  const b = binary.toLowerCase();
  if (b.includes("claude") && CLAUDE_LOGIN_LOST.test(text)) {
    return `设备「${device}」上的 Claude Code 登录已失效：在这台设备的终端运行 claude auth login（或打开 claude 输入 /login）重新登录后再提问。`;
  }
  if (b.includes("codex") && CODEX_LOGIN_LOST.test(text)) {
    return `设备「${device}」上的 Codex 登录已失效：在这台设备的终端运行 codex login 重新登录后再提问。`;
  }
  return undefined;
}

// Claude Code: "You've hit your session limit · resets 12:10pm (Asia/Shanghai)" (weekly / Opus limits read the
// same); Codex: "You've hit your usage limit. …"; older Claude Code: "Claude AI usage limit reached|<epoch>".
// Read up to a quote too, for when it turns up inside a logged JSON line.
const USAGE_LIMIT = /You(?:'|’)ve hit your [\w ]*limit[^\n"]*|usage limit reached[^\n"]*/i;

/**
 * The agent's own report that the account's quota ran out, from what it gave as errors (stderr, errors in
 * its stream), never its answer, which may well discuss limits; undefined when there is none.
 */
export function usageLimitMessage(errors: string): string | undefined {
  return USAGE_LIMIT.exec(errors)?.[0].trim();
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
  // The stream said which background tasks ended; the answer's wording about them proves nothing
  if (parser?.tracksBackgroundTasks) return false;

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
  /** Set for commands run in Windows PowerShell: lines that aren't UTF-8 are in this console encoding. */
  consoleEncoding?: string | null | undefined;
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
  private readonly taskPids = new Map<string, number>();
  private readonly outputs = new Map<string, { stdout: string; stderr: string }>();
  /** Claude tasks keep stdin open for follow-up instructions until their run ends. */
  private readonly steerInputs = new Map<string, NodeJS.WritableStream & { writable: boolean }>();
  private readonly claudeTasks = new Set<string>();
  /** Claude tasks: answers one of the questions Claude asked; false when none is waiting. */
  private readonly answerers = new Map<string, (questionId: string | undefined, text: string) => boolean>();
  /** Tasks run by memento's own runners (Codex, Antigravity, WorkBuddy), which take answers as memento_answer lines. */
  private readonly runnerTasks = new Set<string>();
  private readonly eventLogs = new Map<string, AgentEventLog>();
  /** Per running task: its agent, the session it runs and, for WorkBuddy, the file of the gateway it is on. */
  private readonly taskSessions = new Map<string, { binary: string; sessionId?: string; gatewayFile?: string }>();
  private readonly cancelledTasks = new Set<string>();
  private readonly taskSeq = new Map<string, number>();
  private readonly taskLogBuffer = new Map<string, TaskChunkMessage[]>();
  private readonly MAX_TASK_LOG_BUFFER = 2000;
  private hookBridge: HookBridge | undefined;

  constructor(
    private readonly send: Send,
    private readonly log: (message: string) => void = () => {},
  ) {}

  sendChunk(taskId: string, stream: "stdout" | "stderr", text: string): TaskChunkMessage {
    const nextSeq = (this.taskSeq.get(taskId) ?? 0) + 1;
    this.taskSeq.set(taskId, nextSeq);
    const msg: TaskChunkMessage = {
      type: "task_chunk",
      task_id: taskId,
      stream,
      text,
      seq: nextSeq,
      timestamp: Date.now(),
    };
    let buf = this.taskLogBuffer.get(taskId);
    if (!buf) {
      buf = [];
      this.taskLogBuffer.set(taskId, buf);
    }
    buf.push(msg);
    if (buf.length > this.MAX_TASK_LOG_BUFFER) {
      buf.shift();
    }
    this.send(msg as unknown as Record<string, unknown>);
    return msg;
  }

  getBufferedChunks(taskId: string, fromSeq = 1): TaskChunkMessage[] {
    const buf = this.taskLogBuffer.get(taskId);
    if (!buf) return [];
    return buf.filter((c) => (c.seq ?? 0) >= fromSeq);
  }

  resendBufferedChunks(taskId: string, fromSeq = 1): number {
    const toResend = this.getBufferedChunks(taskId, fromSeq);
    for (const msg of toResend) {
      this.send(msg as unknown as Record<string, unknown>);
    }
    return toResend.length;
  }

  clearTaskLogBuffer(taskId: string): void {
    this.taskLogBuffer.delete(taskId);
    this.taskSeq.delete(taskId);
  }

  get runningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  /** The gateways other WorkBuddy tasks are on right now. */
  private gatewaysInUse(exceptTaskId?: string): Set<string> {
    const files = new Set<string>();
    for (const [id, s] of this.taskSessions) if (id !== exceptTaskId && s.gatewayFile) files.add(s.gatewayFile);
    return files;
  }

  /**
   * The gateway memento serves for a WorkBuddy task in `workDir` (null: none, the runner looks for the app's).
   * A session to resume that ran in another directory is copied over first, since a gateway only finds its own.
   */
  private async workbuddyGateway(taskId: string, workDir: string | undefined, sessionId: string): Promise<WorkbuddyGatewayHandle | null> {
    const gateway = await ensureWorkbuddyGateway(undefined, { cwd: workDir, inUse: this.gatewaysInUse(taskId) }).catch((err) => {
      this.log(`WorkBuddy gateway failed to start: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!gateway) return null;
    const sess = this.taskSessions.get(taskId);
    if (sess) sess.gatewayFile = gateway.file;
    if (sessionId) {
      // The shared gateway runs in the CLI dir; the session may have started in a directory gateway.
      const dir = gateway.cwd ?? workbuddyCliDir();
      await adoptWorkbuddySession(sessionId, dir)
        .then((copied) => copied && this.log(`Copied WorkBuddy session ${sessionId} to ${dir}`))
        .catch((err) => this.log(`Failed to copy WorkBuddy session: ${err instanceof Error ? err.message : String(err)}`));
    }
    this.sweepIdleGateways();
    return gateway;
  }

  /** Stops WorkBuddy gateways no task has used for a while (the daemon runs this every few minutes too). */
  sweepIdleGateways(): void {
    void reapWorkbuddyGateways(undefined, { inUse: this.gatewaysInUse() })
      .then((stopped) => {
        if (stopped.length) this.log(`Stopped ${stopped.length} idle WorkBuddy gateway(s)`);
      })
      .catch((err) => this.log(`WorkBuddy gateway sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  emitEvent(taskId: string, event: AgentEvent): void {
    const row = this.eventLogs.get(taskId)?.add(event) ?? { ...event, at: new Date().toISOString() };
    this.send({ type: "agent_event", task_id: taskId, event: row });
  }

  cancel(taskId: string): boolean {
    const proc = this.running.get(taskId);
    const pid = this.taskPids.get(taskId) ?? proc?.pid;
    this.log(`Cancelling task ${taskId} (proc running: ${Boolean(proc)}, pid: ${pid})`);
    this.cancelledTasks.add(taskId);
    this.running.delete(taskId);
    this.taskPids.delete(taskId);
    this.steerInputs.delete(taskId);
    this.claudeTasks.delete(taskId);

    // The session runs in memento's gateway, which outlives the runner (and on Windows the runner is
    // killed outright, with no chance to cancel it itself): stop just this task's session there.
    const sessionInfo = this.taskSessions.get(taskId);
    if (sessionInfo?.sessionId && /workbuddy|codebuddy/.test(sessionInfo.binary)) {
      this.log(`Cancelling WorkBuddy session ${sessionInfo.sessionId} for task ${taskId}`);
      void cancelWorkbuddySession(sessionInfo.sessionId, undefined, sessionInfo.gatewayFile).catch((err) =>
        this.log(`Failed to cancel WorkBuddy session: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    // A cancel only reaches the prompt over the connection that sent it, which dies with the runner (killed
    // outright on Windows). A directory gateway with no other task on it is simply stopped; the next task starts
    // a fresh one, which resumes the session.
    const gatewayFile = sessionInfo?.gatewayFile;
    if (process.platform === "win32" && gatewayFile && isWorkbuddyDirGateway(gatewayFile) && !this.gatewaysInUse(taskId).has(gatewayFile)) {
      void stopWorkbuddyGateway(gatewayFile).catch(() => {});
    }

    if (proc || pid) {
      killProcessTree(proc ?? pid);
    }
    // 立即向服务端发送 task_finished (status: cancelled)，防止服务端、灵动岛挂死等待
    this.send(
      taskFinishedMessage({
        taskId,
        status: "cancelled",
        exitCode: 130,
        error: "任务已由用户手动停止",
      }),
    );
    return true;
  }

  /** A follow-up from the user: steers a running Claude/Antigravity/WorkBuddy task or goes to process stdin. */
  /**
   * A reply from the user. When it answers a question the agent asked (by id, or the one waiting), it goes
   * back the way that agent takes answers: Claude Code over its control channel, memento's runners as a
   * memento_answer line. Anything else steers the running task.
   */
  input(taskId: string, text: string, questionId?: string): void {
    if (this.answerers.get(taskId)?.(questionId, text)) return this.echoInput(taskId, text);
    const sink = this.steerInputs.get(taskId) ?? this.running.get(taskId)?.stdin;
    if (!sink?.writable) {
      this.emitEvent(taskId, { kind: "steer", text, status: "late" });
      return;
    }
    const waiting = this.eventLogs
      .get(taskId)
      ?.events.find((e) => e.kind === "question" && (questionId ? e.id === questionId : e.status === "waiting" || !e.status));
    if (waiting?.id && this.runnerTasks.has(taskId)) {
      sink.write(`${JSON.stringify({ type: "memento_answer", question_id: waiting.id, answer: text })}\n`);
      this.emitEvent(taskId, { kind: "question", id: waiting.id, status: "answered", answer: text });
    } else {
      sink.write(this.claudeTasks.has(taskId) ? `${JSON.stringify(claudeUserMessage(text))}\n` : `${text}\n`);
      if (waiting?.id) this.emitEvent(taskId, { kind: "question", id: waiting.id, status: "answered", answer: text });
      this.emitEvent(taskId, { kind: "steer", text, status: "sent" });
    }
    this.echoInput(taskId, text);
  }

  private echoInput(taskId: string, text: string): void {
    const echo = `\n[输入] ${text}\n`;
    const out = this.outputs.get(taskId);
    if (out) out.stdout += echo;
    this.sendChunk(taskId, "stdout", echo);
  }


  dispose(): void {
    const killedPids = new Set<number>();
    for (const proc of this.running.values()) {
      if (proc.pid) killedPids.add(proc.pid);
      killProcessTree(proc);
    }
    for (const pid of this.taskPids.values()) {
      if (!killedPids.has(pid)) {
        killedPids.add(pid);
        killProcessTree(pid);
      }
    }
    this.running.clear();
    this.taskPids.clear();
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
    if (proc.pid) this.taskPids.set(taskId, proc.pid);
    const out = this.outputs.get(taskId)!;
    const { parser } = spec;

    proc.stdin.on("error", () => {});
    this.steerInputs.set(taskId, proc.stdin);
    const flushReplies = () => {
      if (!(parser instanceof ClaudeStreamParser)) return;
      for (const reply of parser.takeReplies()) if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(reply)}\n`);
    };
    if (parser instanceof ClaudeStreamParser) {
      this.answerers.set(taskId, (questionId, text) => {
        const events = parser.answer(questionId, text);
        if (!events) return false;
        for (const e of events) this.emitEvent(taskId, e);
        flushReplies();
        return true;
      });
    }
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

    // PowerShell writes the console code page (GBK on Chinese Windows) into the pipe, not UTF-8
    const lineText = (stream: NodeJS.ReadableStream, onText: (text: string) => void) => {
      const decoder = new LineDecoder(spec.consoleEncoding ?? null);
      stream.on("data", (bytes: Buffer) => {
        const text = decoder.push(bytes);
        if (text) onText(text);
      });
      stream.on("end", () => {
        const text = decoder.flush();
        if (text) onText(text);
      });
    };
    const consoleText = spec.consoleEncoding !== undefined;

    if (!parser) {
      const onStdout = (text: string) => {
        armTimer();
        if (out.stdout.length < 2_500_000) {
          out.stdout += text;
        } else if (!out.stdout.endsWith("[...后续输出过大已转为实时流式传输...]\n")) {
          out.stdout += "\n[...后续输出过大已转为实时流式传输...]\n";
        }
        this.sendChunk(taskId, "stdout", text);
      };
      if (consoleText) {
        lineText(proc.stdout, onStdout);
      } else {
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", onStdout);
      }
    } else {
      createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", (line) => {
        armTimer();
        const events = parser.feed(line);
        if (events === null) {
          if (!line.trim()) {
            // Preserve paragraph separation while preventing excessive empty lines
            if (out.stdout.endsWith("\n\n")) return;
            out.stdout += "\n";
            this.sendChunk(taskId, "stdout", "\n");
            return;
          }
          if (out.stdout.length < 2_500_000) {
            out.stdout += `${line}\n`;
          }
          this.sendChunk(taskId, "stdout", `${line}\n`);
          return;
        }
        for (const e of events) {
          if (e.kind === "text") {
            // What the agent says along the way; the final answer replaces it at the end.
            const text = `${String(e.text)}\n\n`;
            out.stdout += text;
            this.sendChunk(taskId, "stdout", text);
          } else {
            this.emitEvent(taskId, e);
          }
        }
        flushReplies();
        if (parser.sessionId) {
          const sess = this.taskSessions.get(taskId);
          if (sess && !sess.sessionId) sess.sessionId = parser.sessionId;
        }
        if (parser instanceof ClaudeStreamParser && parser.finished && (parser.queuedTurns ?? 0) === 0) {
          const sink = this.steerInputs.get(taskId);
          this.steerInputs.delete(taskId);
          sink?.end();
        }
      });
    }
    const onStderr = (text: string) => {
      armTimer();
      out.stderr += text;
      // workbuddy_cli.mjs reports the session it actually runs (a failed resume opens a new one) as
      // "session id: <id>" on stderr; the reply itself goes to stdout.
      const sid = /^session id:\s*(\S+)/m.exec(text)?.[1];
      const sess = this.taskSessions.get(taskId);
      if (sid && sess) sess.sessionId = sid;
      this.sendChunk(taskId, "stderr", text);
    };
    if (consoleText) {
      lineText(proc.stderr, onStderr);
    } else {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", onStderr);
    }

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
    this.sendChunk(taskId, "stderr", text);
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
    let consoleEncoding: string | null | undefined;
    let worktree: TaskWorktree | undefined;
    /** Added to the agent's environment (the WorkBuddy gateway to use). */
    const env0: NodeJS.ProcessEnv = {};
    /** Set for Codex tasks: memento's runner and the Codex binary it drives. */
    let codex: { runner: string; codex: string } | undefined;

    const binary = (text("binary") || "claude").toLowerCase();
    const prompt = text("prompt");
    const sessionId = text("session_id");
    this.taskSessions.set(taskId, { binary, sessionId: sessionId || undefined });
    const model = text("model");
    const effort = text("effort");
    const rawSysAppend = text("system_prompt_append");
    const offlineMind = !rawSysAppend ? await getOfflineMindSnapshot() : null;
    const sysAppend = rawSysAppend || offlineMind || "";

    // Materialize uploaded base64 images on the local device so local Agent CLI can view them
    if (Array.isArray(payload.images) && payload.images.length > 0) {
      const convId =
        text("conversation_id") ||
        prompt.match(/\/tmp\/memento_images\/([a-zA-Z0-9_-]+)\//)?.[1] ||
        taskId;
      // The prompt names /tmp/memento_images/<conv>/…; on a machine with a /data2 disk the files live
      // there behind a per-conversation link, and stay on /tmp when /data2 isn't writable.
      const tmpDir = join("/tmp/memento_images", convId);
      let imgDir = tmpDir;
      if (existsSync("/data2")) {
        try {
          const bigDir = join("/data2/memento/images", convId);
          mkdirSync(bigDir, { recursive: true });
          mkdirSync("/tmp/memento_images", { recursive: true });
          if (!existsSync(tmpDir)) symlinkSync(bigDir, tmpDir);
          if (realpathSync(tmpDir) === realpathSync(bigDir)) imgDir = bigDir;
        } catch {
          // stay on /tmp
        }
      }
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
        consoleEncoding = await windowsConsoleEncoding();
      } else {
        exe = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
        args = ["-c", command];
      }
    } else {
      isAntigravity = binary.includes("agy") || binary.includes("antigravity");
      const isWorkbuddy = binary.includes("workbuddy") || binary.includes("codebuddy");
      if (isWorkbuddy) await ensureWorkbuddyCliInstalled();
      const candidates = binary === "workbuddy" ? ["workbuddy_cli.mjs", "workbuddy.cmd", "workbuddy", "codebuddy"] : [binary];
      const resolved = isAntigravity ? await antigravityExecutable() : await findExecutable(candidates);
      if (!resolved) {
        let tip = "";
        if (isAntigravity) {
          tip =
            process.platform === "win32"
              ? "\n💡 运行 Antigravity 任务需要 Python 3（安装时勾选 Add python.exe to PATH），并保持 Antigravity 应用运行；装好后重启 Memento。"
              : "\n💡 运行 Antigravity 任务需要 python3，并保持 Antigravity 应用运行；装好后重启 Memento。";
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
        // Background memory consolidation (auto-dream) never runs as sdk-cli but would under memento's own name;
        // it stays with the user's own Claude Code sessions, as before, rather than spending quota on memento's runs.
        settings.autoDreamEnabled = false;
        Object.assign(env0, claudeClientEnv(payload.claude_entrypoint));
        const compactWindow = autoCompactWindow(payload.auto_compact_window);
        if (compactWindow) settings.autoCompactWindow = compactWindow;
        // Report each tool call to the server, which pushes risky ones to the phone.
        this.hookBridge ??= new HookBridge((tid, use) => this.send({ type: "agent_tool_use", task_id: tid, ...use }));
        const hooks = await this.hookBridge.claudeHooks(taskId);
        if (hooks) settings.hooks = hooks;
        claudeSettings = Object.keys(settings).length ? JSON.stringify(settings) : undefined;
        const sessionName = claudeSessionName(text("title"), text("user_question"), prompt);
        args = claudeArgs({ sessionId, sysAppend, model, settingsJson: claudeSettings, sessionName });
        parser = new ClaudeStreamParser();
        stdinPrompt = prompt;
        this.claudeTasks.add(taskId);
      } else if (binary.includes("codex")) {
        codex = { runner: await codexRunner(), codex: exe };
        exe = process.execPath;
        args = codexArgs({ ...codex, workDir, sessionId, fork: payload.fork === true, effort, model, prompt });
        parser = new CodexStreamParser();
        this.runnerTasks.add(taskId);
      } else if (isWorkbuddy) {
        const isNativeCodebuddy = exe.toLowerCase().includes("codebuddy");
        if (!isNativeCodebuddy) {
          // WorkBuddy ≥ 5.8 has no gateway of its own any more: the runner uses the one memento serves for this
          // directory (after the worktree, which moves it).
          const gateway = await this.workbuddyGateway(taskId, workDir, sessionId);
          if (gateway) env0.MEMENTO_WORKBUDDY_GATEWAY_FILE = gateway.file;
          args = [
            ...(sessionId ? ["--resume", sessionId] : []),
            ...(model ? ["--model", model] : []),
            ...(effort ? ["--effort", effort] : []),
            ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
            "-p",
            prompt,
          ];
          parser = new UniversalStreamParser();
          this.runnerTasks.add(taskId);
        } else {
          // Native WorkBuddy / CodeBuddy CLI supports Claude-compatible stream-json; headless tool use needs -y.
          // A session missing on this device falls through to the "session not found" retry below.
          args = [
            "--output-format",
            "stream-json",
            "-y",
            ...(sessionId ? ["--resume", sessionId] : []),
            ...(model ? ["--model", model] : []),
            ...(effort ? ["--effort", effort] : []),
            ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
            "-p",
            prompt,
          ];
          parser = new ClaudeStreamParser();
        }
      } else if (isAntigravity) {
        args = antigravityArgs({
          sessionId,
          model,
          effort,
          timeoutSeconds: task.timeoutSeconds,
          prompt,
        });
        parser = new UniversalStreamParser();
        this.runnerTasks.add(taskId);
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
      // The Codex runner runs on this process's own runtime (Electron as Node in the desktop app)
      const env = { ...withExeDirOnPath(await executionEnvironment(), codex?.codex ?? exe), ...env0 };
      if (codex) env.ELECTRON_RUN_AS_NODE = "1";
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

      let exitCode = await run({ args, parser, stdinPrompt, consoleEncoding });
      if (this.cancelledTasks.has(taskId)) {
        this.log(`Task ${taskId} was cancelled by user; skipping retries`);
        return;
      }
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

      // Retry 0.5: Antigravity model capacity unavailable (503 / RESOURCE_EXHAUSTED): fallback tier
      if (
        exitCode !== 0 &&
        isAntigravity &&
        /No capacity available|UNAVAILABLE.*503|RESOURCE_EXHAUSTED|code 503/i.test(errScan())
      ) {
        const currentModel = (model || "").toLowerCase();
        const fallbackModel = currentModel.includes("pro") ? "flash_lite" : "pro";
        this.notice(
          taskId,
          `\n⚡ [模型容灾降级] 检测到当前模型容量不足 (503 No capacity)，已自动切换至 ${fallbackModel.toUpperCase()} 档位全新会话无缝重试...\n\n`,
        );
        parser = new UniversalStreamParser();
        const fallbackArgs = antigravityArgs({
          model: fallbackModel,
          effort,
          timeoutSeconds: task.timeoutSeconds,
          prompt,
        });
        exitCode = await run({ args: fallbackArgs, parser });
      }

      // Retry 1: the ChatGPT app holds the Codex session's writer lock, so fork it instead.
      if (exitCode !== 0 && binary.includes("codex") && sessionId && payload.fork !== true && errScan().includes("already has an active writer")) {
        this.notice(taskId, "\n⚡ [自动重试] 该会话当前正被 ChatGPT 客户端占用锁定，已自动无缝切换为 Fork 分支模式重新执行（完整继承上下文记忆）...\n\n");
        parser = new CodexStreamParser();
        exitCode = await run({ args: codexArgs({ ...codex!, workDir, sessionId, fork: true, effort, model, prompt }), parser });
      }

      // Retry 2: the session to resume isn't on this device (common when dispatching across devices): start fresh.
      const sessionNotFoundDetected = isSessionNotFound(errScan());
      if ((exitCode !== 0 || (!out.stdout.trim() && !parser?.finalText?.trim())) && action !== "shell" && sessionId && sessionNotFoundDetected) {
        this.notice(taskId, "\n⚡ [自动自愈] 本地未找到历史会话（跨设备远程调度或会话过期常见），已自动重置为全新会话重新执行...\n\n");
        if (binary.includes("claude")) {
          parser = new ClaudeStreamParser();
          const sessionName = claudeSessionName(text("title"), text("user_question"), prompt);
          exitCode = await run({ args: claudeArgs({ sysAppend, model, settingsJson: claudeSettings, sessionName }), parser, stdinPrompt: prompt });
        } else if (binary.includes("codex")) {
          parser = new CodexStreamParser();
          exitCode = await run({ args: codexArgs({ ...codex!, workDir, effort, model, prompt }), parser });
        } else if (binary.includes("workbuddy") || binary.includes("codebuddy")) {
          const isNativeCodebuddy = exe.toLowerCase().includes("codebuddy");
          if (!isNativeCodebuddy) {
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
                "-y",
                ...(model ? ["--model", model] : []),
                ...(effort ? ["--effort", effort] : []),
                ...(sysAppend ? ["--append-system-prompt", sysAppend] : []),
                "-p",
                prompt,
              ],
              parser,
            });
          }
        } else if (isAntigravity) {
          parser = new UniversalStreamParser();
          exitCode = await run({
            args: antigravityArgs({
              model,
              effort,
              timeoutSeconds: task.timeoutSeconds,
              prompt,
            }),
            parser,
          });
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
      // Only the agent's errors are scanned, not its answer, which may well discuss logins.
      const loginHint = exitCode !== 0 ? agentLoginHint(binary, errScan()) : undefined;
      if (loginHint) this.notice(taskId, `\n🔑 [登录失效] ${loginHint}\n`);

      let fullOut = out.stdout.trim();
      const fullErr = out.stderr.trim();
      // A structured run's answer includes all intermediate thoughts and final conclusions from the parser
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
          const done = await worktree.finish(await executionEnvironment());
          this.emitEvent(taskId, done);
          // Its directory is gone, and with it the reason for its gateway.
          const gatewayFile = this.taskSessions.get(taskId)?.gatewayFile;
          if (done.status === "removed" && gatewayFile && isWorkbuddyDirGateway(gatewayFile) && !this.gatewaysInUse(taskId).has(gatewayFile)) {
            void stopWorkbuddyGateway(gatewayFile).catch(() => {});
          }
        } catch (e) {
          this.log(`Worktree wrap-up failed for ${taskId}: ${e instanceof Error ? e.message : e}`);
        }
      }

      const sessionFailedFinal = !fullOut && (isSessionNotFound(fullErr) || isSessionNotFound(streamErrors));
      // Out of quota: the run stopped there, whatever background work it had open or however it exited
      const usageLimit = action === "agent" ? usageLimitMessage(`${streamErrors}\n${fullErr}`) : undefined;
      const effectiveExitCode = (sessionFailedFinal || usageLimit) && exitCode === 0 ? 1 : exitCode;

      if (this.cancelledTasks.has(taskId)) {
        this.log(`Task ${taskId} was cancelled by user; skipping final task_finished overwrite`);
        return;
      }

      this.send(
        taskFinishedMessage({
          taskId,
          status: usageLimit
            ? "failed"
            : timedOut && !isStillRunning
              ? "timeout"
              : isStillRunning
                ? "still_running"
                : effectiveExitCode === 0
                  ? "succeeded"
                  : "failed",
          exitCode: effectiveExitCode,
          stdout: fullOut,
          stderr: safeErr,
          error: usageLimit
            ? usageLimit
            : timedOut
              ? `Task timed out after ${task.timeoutSeconds}s`
              : effectiveExitCode !== 0
                ? loginHint || fullErr || streamErrors || (sessionFailedFinal ? "会话未找到或已过期" : `Exit code ${effectiveExitCode}`)
                : null,
          errorType: usageLimit ? "usage_limit" : promptTooLong ? "prompt_too_long" : loginHint ? "agent_login_required" : null,
          sessionId: parser?.sessionId ?? sid ?? (sessionFailedFinal ? null : (sessionId || null)),
          events: this.eventLogs.get(taskId)?.events,
        }),
      );
    } catch (e) {
      if (!this.cancelledTasks.has(taskId)) {
        this.send(taskFinishedMessage({ taskId, status: "failed", exitCode: 1, error: `Execution failed to start: ${e instanceof Error ? e.message : e}` }));
      }
    } finally {
      this.outputs.delete(taskId);
      this.eventLogs.delete(taskId);
      this.claudeTasks.delete(taskId);
      this.answerers.delete(taskId);
      this.runnerTasks.delete(taskId);
      this.steerInputs.get(taskId)?.end();
      this.steerInputs.delete(taskId);
      this.running.delete(taskId);
      this.taskPids.delete(taskId);
      const gatewayFile = this.taskSessions.get(taskId)?.gatewayFile;
      this.taskSessions.delete(taskId);
      // Its idle time starts now.
      if (gatewayFile) void touchWorkbuddyGateway(gatewayFile).catch(() => {});
      setTimeout(() => {
        this.cancelledTasks.delete(taskId);
        this.taskLogBuffer.delete(taskId);
        this.taskSeq.delete(taskId);
      }, 30_000);
    }
  }
}
