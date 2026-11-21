import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { homeDir } from "./config.js";
import { agyQuotaMessage } from "./agy-models.js";
import type { AgentEvent, AgentStreamParser } from "./agent-stream.js";
import type { ToolUse } from "./hook-bridge.js";

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
/**
 * The runner's tiers to go on with when the Antigravity app's `model` ran out of quota, lightest first:
 * the app's default (none asked for) is its heavy model, the one that runs out.
 */
export function appQuotaFallbacks(model: string): string[] {
  const m = model.toLowerCase();
  if (m.includes("lite")) return ["flash", "pro"];
  if (m.includes("flash")) return ["flash_lite", "pro"];
  return ["flash", "flash_lite"];
}

/**
 * Drops Node's own runtime warnings ("(node:55188) [DEP0190] DeprecationWarning: …" and the "(Use `node
 * --trace-deprecation ...`" line after it) from an agent's stderr: they say nothing about the task, and
 * when the run failed they stood in for the real error.
 */
export function stripRuntimeWarnings(stderr: string): string {
  return stderr
    .replace(/^\(node:\d+\) (?:\[[A-Z0-9]+\] )?\w*Warning: .*(?:\r?\n|$)/gm, "")
    .replace(/^\(Use `[^`]*--trace-(?:deprecation|warnings)[^`]*` to show where the warning was created\)(?:\r?\n|$)/gm, "");
}

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

export const claudeUserMessage = (text: string) => ({ type: "user", message: { role: "user", content: text } });

/** How long after its answer a Claude run still waiting on background tasks keeps taking follow-ups. */
export const STEER_AFTER_ANSWER_MS = 30 * 60_000;

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
 * Arguments for invoking the Antigravity CLI (`agy` / `agy.exe` or memento's `agy_cli.mjs`).
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
  /** Google's own CLI rather than memento's runner: it reports its steps as stream-json. */
  official?: boolean;
}): string[] {
  const args: string[] = [];
  // Antigravity's conversations are UUIDs: anything else would resume nothing (agentapi takes it anyway,
  // makes a folder of that name and the run waits out the reply that never comes)
  const sid = o.sessionId ? (UUID_RE.exec(o.sessionId)?.[0] ?? "") : "";
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
  if (o.official) args.push("--output-format", "stream-json");
  args.push("-p", o.prompt);
  return args;
}

/** Starts the error of a run whose session couldn't be fetched from the device it is on (the page offers compacted retry on it). */
export const SESSION_UNAVAILABLE = "没能取到原会话";

/** Errors that mean the session to resume isn't on this device (or the CLI didn't take the resume flags). */
export function isSessionNotFound(text: string): boolean {
  return (
    [
      "no rollout found",
      "thread not found",
      "session not found",
      "conversation not found",
      "trajectory not found",
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

// Claude Code: "You've hit your session limit · resets 12:10pm (Asia/Shanghai)" (weekly limit reads the same);
// Codex: "You've hit your usage limit. …"; older Claude Code: "Claude AI usage limit reached|<epoch>". Read up
// to a quote too, for when it turns up inside a logged JSON line. A limit of one model (Claude's Opus limit, a
// team's budget, Codex's "usage limit for X", Antigravity's quota) goes on with another model first
// (model-limits.ts), so the run ends on it only when the last run did.
const USAGE_LIMIT = /You(?:'|’)ve hit your [\w' ]*limit[^\n"]*|You(?:'|’)ve hit your team(?:'|’)s shared budget[^\n"]*|usage limit reached[^\n"]*/i;

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

export interface RunSpec {
  exe: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  parser?: AgentStreamParser | undefined;
  stdinPrompt?: string | undefined;
  /** Set for commands run in Windows PowerShell: lines that aren't UTF-8 are in this console encoding. */
  consoleEncoding?: string | null | undefined;
}

export const TIMED_OUT = -999;

export type Send = (message: Record<string, unknown>) => void;

/**
 * Runs dispatched tasks: shell commands and agent CLIs (Claude Code, Codex,
 * Antigravity). Streams output and structured steps back through `send`,
 * accepts follow-ups for running Claude tasks, and reports the result.
 */
