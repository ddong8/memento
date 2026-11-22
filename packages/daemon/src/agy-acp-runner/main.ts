// Memento's Antigravity ACP runner: drives Google's `agy acp --stdio` (JSON-RPC 2.0)
// instead of `agy -p --output-format stream-json`, giving:
//   - true token-by-token streaming (agent_message_chunk / agent_thought_chunk) with zero head-of-line blocking
//   - real-time mid-turn steering (concurrent session/prompt, even while background commands run)
//   - native ask_question interactive dialog bridging
//   - independent "background" tool status + background task wakeup continuation (R-TRACK-BACKGROUND)
//   - live nested subagent tool timeline via child transcript tailing
//   - clean session/cancel on SIGINT/SIGTERM
//
// Usage:
//   node agy_acp.mjs --agy BIN [-C DIR] [--conversation ID] [--model M] [--effort E] [--timeout S] [--] PROMPT
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  acpToolDetail,
  cleanToolOutput,
  clip,
  extractAcpToolOutput,
  formatAskQuestionAnswers,
  hasBackgroundEndMarker,
  isAsyncToolName,
  isCascadeIdle,
  isCascadeRunning,
  isFailedToolOutput,
  isObj,
  isTransientAgyError,
  normalizeAcpEffort,
  parseAskQuestionArgs,
  parseBackgroundStart,
  parseSubagentLaunch,
  readAgyConversationState,
  resolveAcpModel,
  str,
  timerSeconds,
  unwrapTranscriptArgs,
  type AcpModelOption,
  type AcpQuestionItem,
  type AgyConversationState,
  type Json,
} from "./helpers.js";

const argv = process.argv.slice(2);
const args = {
  agy: process.env.MEMENTO_AGY_BIN || "agy",
  cwd: "",
  conversation: "",
  model: "",
  effort: "",
  timeout: 0,
  systemAppend: process.env.MEMENTO_AGY_SYSTEM_APPEND || "",
  prompt: "",
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--agy") args.agy = argv[++i] ?? args.agy;
  else if (a === "-C" || a === "--cwd") args.cwd = argv[++i] ?? "";
  else if (a === "--conversation" || a === "--resume") args.conversation = argv[++i] ?? "";
  else if (a === "--model") args.model = argv[++i] ?? "";
  else if (a === "--effort") args.effort = argv[++i] ?? "";
  else if (a === "--timeout") args.timeout = Number(argv[++i] ?? 0) || 0;
  else if (a === "--system-append") args.systemAppend = argv[++i] ?? "";
  else if (a === "--") {
    args.prompt = argv.slice(i + 1).join(" ");
    break;
  } else {
    args.prompt = args.prompt ? `${args.prompt} ${a}` : a;
  }
}

let lastStdoutEmitAt = Date.now();
const emit = (event: Json) => {
  lastStdoutEmitAt = Date.now();
  process.stdout.write(`${JSON.stringify({ type: "memento_event", event })}\n`);
};
const err = (msg: string) => process.stderr.write(msg);

const home = process.env.HOME || process.env.USERPROFILE || homedir();
const cliDataDir = join(home, ".gemini", "antigravity-cli");
const cliBrainRoot = join(cliDataDir, "brain");
const cliSummariesDb = join(cliDataDir, "conversation_summaries.db");

// Authoritative wakeup/keepalive timings (env-overridable for deterministic tests)
const NO_WAKEUP_IDLE_MS = Number(process.env.MEMENTO_AGY_NO_WAKEUP_MS) || 15_000;
const POST_RUNNING_IDLE_MS = Number(process.env.MEMENTO_AGY_POST_RUNNING_IDLE_MS) || 5_000;
const FALLBACK_WAKEUP_QUIET_MS = Number(process.env.MEMENTO_AGY_WAKEUP_FALLBACK_MS) || 120_000;
const KEEPALIVE_INTERVAL_MS = Number(process.env.MEMENTO_AGY_KEEPALIVE_MS) || 30_000;
const TIMER_WAKE_GRACE_MS = 120_000;

class JsonlTailer {
  private offset = 0;
  private remainder = "";
  private initialized = false;

  constructor(
    readonly path: string,
    private readonly startAtEnd: boolean,
  ) {}

  snapshotEof(): void {
    if (this.initialized) return;
    if (existsSync(this.path)) {
      try {
        this.offset = this.startAtEnd ? statSync(this.path).size : 0;
        this.initialized = true;
      } catch {
        // wait until readable
      }
    } else if (!this.startAtEnd) {
      this.offset = 0;
      this.initialized = true;
    }
  }

  poll(maxBytes = 512 * 1024): Json[] {
    if (!existsSync(this.path)) return [];
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (!this.initialized) {
      this.offset = this.startAtEnd ? size : 0;
      this.initialized = true;
      if (this.startAtEnd) return [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.remainder = "";
    }
    if (size <= this.offset) return [];
    const toRead = Math.min(size - this.offset, maxBytes);
    let fd: number | undefined;
    let chunk = "";
    try {
      fd = openSync(this.path, "r");
      const buf = Buffer.alloc(toRead);
      const n = readSync(fd, buf, 0, toRead, this.offset);
      if (n <= 0) return [];
      this.offset += n;
      chunk = buf.toString("utf8", 0, n);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
    const lines = (this.remainder + chunk).split("\n");
    this.remainder = lines.pop() ?? "";
    const rows: Json[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as unknown;
        if (isObj(parsed)) rows.push(parsed);
      } catch {
        // ignore partial/malformed
      }
    }
    return rows;
  }
}

const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(args.agy);
const acpFlags = ["acp", "--stdio", "--dangerously-skip-permissions"];
const server = viaShell
  ? spawn(`"${args.agy}" ${acpFlags.join(" ")}`, { cwd: args.cwd || undefined, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: true })
  : spawn(args.agy, acpFlags, { cwd: args.cwd || undefined, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

let exiting = false;
let finished = false;
let sessionId = "";
let activeModel = "";
let replayingHistory = false;
const startedAt = Date.now();
let pollTimer: NodeJS.Timeout | undefined;
let timeoutTimer: NodeJS.Timeout | undefined;
let lastTimeoutArmedAt = 0;

function cleanupTimers(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
}

function shutdown(code: number): void {
  if (exiting) return;
  exiting = true;
  cleanupTimers();
  try {
    server.stdin.end();
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      server.kill();
    } catch {
      // ignore
    }
    process.exit(code);
  }, 250);
}

function fail(message: string, code = 1): void {
  emit({ kind: "error", message: clip(message, 2000) });
  err(`${message}\n`);
  shutdown(code);
}

server.on("error", (e) => fail(`Antigravity ACP failed to start: ${e.message}`));
server.on("exit", (code) => {
  if (!finished && !exiting) fail(`Antigravity ACP exited (${code ?? "signal"}) before the turn finished`);
});
server.stderr.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf8");
  // Drop routine stderr chatter that isn't an actionable error
  const kept = text
    .split(/\r?\n/)
    .filter((l) => !/root agent idle;\s*waiting/i.test(l))
    .join("\n");
  if (kept.trim()) err(kept.endsWith("\n") ? kept : `${kept}\n`);
});

// ── JSON-RPC 2.0 client over stdio ───────────────────────────────────────────────
let nextRpcId = 1;
const pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function request(method: string, params?: Json): Promise<Json> {
  const id = nextRpcId++;
  const payload = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
  server.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => pendingRpc.set(id, { resolve: (v) => resolve(isObj(v) ? v : {}), reject }));
}

function notify(method: string, params?: Json): void {
  const payload = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
  server.stdin.write(`${JSON.stringify(payload)}\n`);
}

function respond(id: unknown, result: Json): void {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

// ── State tracking for tools, background tasks, subagents, questions & usage ─────
interface OpenTool {
  id: string;
  name: string;
  detail: string;
  isDaemon: boolean;
  backgrounded: boolean;
  taskId?: string;
  startedAt: number;
}

interface SubagentTrack {
  id: string;
  name: string;
  role?: string;
  detail?: string;
  tailer: JsonlTailer;
  stepTools: Map<number, string>;
  pendingTools: string[];
  stepSeq: number;
}

interface PendingAskBatch {
  toolCallId: string;
  items: AcpQuestionItem[];
  questionIds: string[];
  answers: Array<string | undefined>;
}

const inProgressTools = new Map<string, OpenTool>();
const emittedTools = new Set<string>();
const completedTools = new Set<string>();
const activeBgTasks = new Map<string, { shortId: string; description: string; toolCallId?: string; isDaemon?: boolean; timerDue?: number }>();
const activeSubagents = new Map<string, SubagentTrack>();
const pendingSubagentMeta: Array<{ name?: string; role?: string; detail?: string }> = [];
const taskLogSizes = new Map<string, number>();

const openQuestions: Array<{ id: string; batch: PendingAskBatch; index: number }> = [];
const askToolCallIds = new Set<string>();
let suppressAskFallbackText = false;

let inFlightPrompts = 0;
let turns = 0;
let totalInputTokens = 0;
let totalCachedReadTokens = 0;
let totalOutputTokens = 0;
let hasEmittedText = false;
let textEndsWithNewline = true;

// Wakeup state machine (active after inFlightPrompts === 0 and background tasks/subagents finish)
let awaitingWakeup = false;
let wakeupStartedAt = 0;
let wakeupActivityAt = 0;
let wakeupSeenRunning = false;
let wakeupDoneConfirmed = false;
let wakeupEmittedText = false;
let wakeupIdleSince = 0;
let wakeupStepIndex = -1;
let wakeupError = "";
let maxParentStepIndex = -1;
// Guards against the race where a background task's SYSTEM_MESSAGE lands right before session/prompt resolves end_turn
let pendingWakeupAfterStep = -1;

let lastDbState: AgyConversationState | null = null;
let lastDbReadAt = 0;

let parentTailer: JsonlTailer | undefined;
const seenParentStepKeys = new Set<string>();

function readDbState(force = false): AgyConversationState | null {
  if (!sessionId) return null;
  const now = Date.now();
  if (!force && now - lastDbReadAt < 350) return lastDbState;
  lastDbReadAt = now;
  lastDbState = readAgyConversationState(cliSummariesDb, sessionId);
  return lastDbState;
}

function hasPendingTimer(): boolean {
  const now = Date.now();
  for (const bg of activeBgTasks.values()) {
    if (!bg.isDaemon && bg.timerDue !== undefined && now < bg.timerDue + TIMER_WAKE_GRACE_MS) {
      return true;
    }
  }
  return false;
}

function armActivityTimeout(force = false): void {
  if (args.timeout <= 0 || finished || exiting) return;
  const now = Date.now();
  if (!force && timeoutTimer && now - lastTimeoutArmedAt < 5_000) return;
  lastTimeoutArmedAt = now;
  if (timeoutTimer) clearTimeout(timeoutTimer);
  timeoutTimer = setTimeout(() => {
    if (finished || exiting) return;
    // Never time out while the user is reviewing an ask_question dialog or a schedule timer hasn't fired yet
    if (openQuestions.length > 0 || hasPendingTimer()) {
      armActivityTimeout(true);
      return;
    }
    if (hasOpenNonDaemonAsync()) {
      err(`\n⏳ [任务在后台持续执行中（${backgroundSummaryNames()}），达到单次静默等待上限（${args.timeout}s），保持后台运行]\n`);
      finishCleanly(true);
      return;
    }
    void cancelAndExit(124, `\n[Agent timeout: 任务执行已达到静默安全上限（${args.timeout}s）]\n`);
  }, args.timeout * 1000);
  timeoutTimer.unref();
}

function markActivity(): void {
  const now = Date.now();
  armActivityTimeout(false);
  if (awaitingWakeup) {
    wakeupActivityAt = now;
    wakeupIdleSince = 0;
  }
}

function enterWakeup(triggerStepIdx?: number): void {
  const now = Date.now();
  awaitingWakeup = true;
  wakeupStartedAt = now;
  wakeupActivityAt = now;
  wakeupSeenRunning = false;
  wakeupDoneConfirmed = false;
  wakeupEmittedText = false;
  wakeupIdleSince = 0;
  wakeupError = "";
  const floor = triggerStepIdx !== undefined && triggerStepIdx >= 0 ? triggerStepIdx : maxParentStepIndex;
  if (floor > wakeupStepIndex) wakeupStepIndex = floor;
  armActivityTimeout(false);
}

function leaveWakeupForAsync(): void {
  awaitingWakeup = false;
  wakeupSeenRunning = false;
  wakeupDoneConfirmed = false;
  wakeupEmittedText = false;
  wakeupIdleSince = 0;
  wakeupError = "";
}

function maybeEmitKeepalive(): void {
  if (finished || exiting) return;
  if (Date.now() - lastStdoutEmitAt < KEEPALIVE_INTERVAL_MS) return;
  const hasWork =
    hasOpenNonDaemonAsync() ||
    openQuestions.length > 0 ||
    (awaitingWakeup && (wakeupSeenRunning || isCascadeRunning(lastDbState) || Boolean(lastDbState?.notFullyIdle)));
  if (!hasWork) return;
  emit({ kind: "keepalive" });
}

function removeBgTaskByTarget(target: string): boolean {
  if (!target) return false;
  const targetShort = target.split("/").pop() || target;
  let removed = false;
  for (const [fullId, bg] of [...activeBgTasks]) {
    if (fullId.includes(target) || target.includes(fullId) || bg.shortId === targetShort) {
      activeBgTasks.delete(fullId);
      if (bg.toolCallId) {
        const open = inProgressTools.get(bg.toolCallId);
        if (open) {
          inProgressTools.delete(bg.toolCallId);
          completedTools.add(bg.toolCallId);
          emit({ kind: "tool", id: open.id, name: open.name, detail: open.detail, status: "done", output: "后台任务已终止。" });
        }
      }
      removed = true;
    }
  }
  if (removed) emitBackgroundSnapshot();
  return removed;
}

function emitBackgroundSnapshot(): void {
  const tasks: Array<{ id: string; description?: string }> = [];
  for (const [, bg] of activeBgTasks) {
    if (bg.isDaemon) continue;
    tasks.push({ id: bg.shortId, description: bg.description || `后台任务 ${bg.shortId}` });
  }
  for (const tool of inProgressTools.values()) {
    if (tool.isDaemon || !tool.backgrounded || tool.taskId) continue;
    tasks.push({ id: tool.id, description: tool.detail || tool.name });
  }
  for (const sub of activeSubagents.values()) {
    tasks.push({ id: sub.id, description: `子智能体 · ${sub.name}` });
  }
  emit({ kind: "background", tasks });
}

function hasOpenNonDaemonAsync(): boolean {
  for (const bg of activeBgTasks.values()) {
    if (!bg.isDaemon) return true;
  }
  for (const tool of inProgressTools.values()) {
    if (!tool.isDaemon) return true;
  }
  if (activeSubagents.size > 0) return true;
  return false;
}

function hasAnyDaemonRunning(): boolean {
  for (const bg of activeBgTasks.values()) if (bg.isDaemon) return true;
  for (const tool of inProgressTools.values()) if (tool.isDaemon) return true;
  return false;
}

function emitUsage(): void {
  const duration_ms = Math.max(0, Date.now() - startedAt);
  const usage: Json = { kind: "usage", duration_ms };
  if (totalInputTokens > 0) usage.input_tokens = totalInputTokens;
  if (totalCachedReadTokens > 0) usage.cache_read_tokens = totalCachedReadTokens;
  if (totalOutputTokens > 0) usage.output_tokens = totalOutputTokens;
  if (turns > 0) usage.turns = turns;
  emit(usage);
}

function backgroundSummaryNames(): string {
  const names: string[] = [];
  for (const bg of activeBgTasks.values()) names.push(bg.shortId);
  for (const sub of activeSubagents.values()) names.push(sub.name || sub.id.slice(0, 8));
  for (const tool of inProgressTools.values()) if (!tool.taskId) names.push(tool.detail || tool.name);
  return names.join(", ") || "background";
}

function finishCleanly(stillRunning = false): void {
  if (finished || exiting) return;
  finished = true;
  emitUsage();
  if (stillRunning || hasAnyDaemonRunning()) {
    err(`\n[STATUS_STILL_RUNNING: tasks=${backgroundSummaryNames()}]\n`);
  }
  shutdown(0);
}

function promoteOpenToolsToBackground(): void {
  let changed = false;
  for (const tool of inProgressTools.values()) {
    if (tool.backgrounded) continue;
    if (!isAsyncToolName(tool.name)) continue;
    tool.backgrounded = true;
    changed = true;
    emit({
      kind: "tool",
      id: tool.id,
      name: tool.name,
      detail: tool.detail,
      status: "background",
      output: tool.isDaemon
        ? "已作为后台常驻进程启动（IsDaemon）。"
        : "已转入后台持续运行，完成后将自动通知智能体继续。",
    });
  }
  if (changed) {
    leaveWakeupForAsync();
    emitBackgroundSnapshot();
  }
}

function registerSubagent(subCid: string, meta: { name?: string; role?: string; detail?: string; logPath?: string }): void {
  const existing = activeSubagents.get(subCid);
  if (existing) {
    // Enrich fallback ID-only name when handleToolUpdate arrives after pollParentTranscript
    const fallbackPrefix = `子智能体 ${subCid.slice(0, 8)}`;
    const betterName = meta.name || meta.role;
    if (betterName && existing.name === fallbackPrefix) {
      existing.name = clip(betterName, 80);
      if (meta.role) existing.role = clip(meta.role, 60);
      if (meta.detail) existing.detail = clip(meta.detail, 200);
      emit({
        kind: "subagent",
        id: existing.id,
        name: existing.name,
        ...(existing.role ? { role: existing.role } : {}),
        agent_type: "subagent",
        ...(existing.detail ? { detail: existing.detail } : {}),
        status: "running",
      });
      emitBackgroundSnapshot();
    }
    return;
  }
  const logPath =
    meta.logPath || join(cliBrainRoot, subCid, ".system_generated", "logs", "transcript.jsonl");
  const name = clip(meta.name || meta.role || `子智能体 ${subCid.slice(0, 8)}`, 80);
  const sub: SubagentTrack = {
    id: subCid,
    name,
    role: meta.role ? clip(meta.role, 60) : undefined,
    detail: meta.detail ? clip(meta.detail, 200) : undefined,
    tailer: new JsonlTailer(logPath, false),
    stepTools: new Map(),
    pendingTools: [],
    stepSeq: 0,
  };
  activeSubagents.set(subCid, sub);
  leaveWakeupForAsync();
  markActivity();
  emit({
    kind: "subagent",
    id: sub.id,
    name: sub.name,
    ...(sub.role ? { role: sub.role } : {}),
    agent_type: "subagent",
    ...(sub.detail ? { detail: sub.detail } : {}),
    status: "running",
  });
  emitBackgroundSnapshot();
}

function closeSubagent(subCid: string, status: "done" | "failed", output?: string): void {
  const sub = activeSubagents.get(subCid);
  if (!sub) return;
  for (const tid of sub.pendingTools) {
    emit({ kind: "tool", id: tid, status: status === "failed" ? "failed" : "done", subagent_id: sub.id, subagent_name: sub.name });
  }
  sub.pendingTools.length = 0;
  activeSubagents.delete(subCid);
  emit({
    kind: "subagent",
    id: sub.id,
    status,
    ...(output ? { output: cleanToolOutput(output) } : {}),
  });
  emitBackgroundSnapshot();
}

function pollSubagents(): boolean {
  let activity = false;
  for (const sub of activeSubagents.values()) {
    const steps = sub.tailer.poll();
    for (const step of steps) {
      activity = true;
      const stype = str(step.type).toUpperCase();
      const sstatus = str(step.status).toUpperCase();
      const scontent = str(step.content);
      const stepIdx = typeof step.step_index === "number" ? step.step_index : -1;

      if (str(step.source).toUpperCase() === "MODEL" && stype === "PLANNER_RESPONSE") {
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        for (const rawCall of calls) {
          if (!isObj(rawCall)) continue;
          const name = str(rawCall.name) || "tool";
          const tcArgs = unwrapTranscriptArgs(rawCall.args);
          const tid = `agy_sub_${sub.id.slice(0, 8)}_${++sub.stepSeq}`;
          sub.pendingTools.push(tid);
          emit({
            kind: "tool",
            id: tid,
            name,
            detail: acpToolDetail(name, tcArgs),
            status: "running",
            subagent_id: sub.id,
            subagent_name: sub.name,
          });
        }
      } else if (stype === "GENERIC" && (sstatus === "DONE" || sstatus === "ERROR" || sstatus === "FAILED")) {
        let tid = stepIdx >= 0 ? sub.stepTools.get(stepIdx) : undefined;
        if (!tid && sub.pendingTools.length > 0) {
          tid = sub.pendingTools.shift();
          if (tid && stepIdx >= 0) sub.stepTools.set(stepIdx, tid);
        }
        if (tid) {
          emit({
            kind: "tool",
            id: tid,
            status: sstatus === "ERROR" || sstatus === "FAILED" ? "failed" : "done",
            ...(scontent.trim() ? { output: cleanToolOutput(scontent) } : {}),
            subagent_id: sub.id,
            subagent_name: sub.name,
          });
        }
      }
    }
  }
  if (activity) markActivity();
  return activity;
}

function attachBackgroundTask(bg: { fullId: string; shortId: string; description?: string }, content: string, createdAt: number, explicitTool?: OpenTool): void {
  if (activeBgTasks.has(bg.fullId)) return;
  let matchedTool = explicitTool;
  if (!matchedTool) {
    for (const t of inProgressTools.values()) {
      if (!t.taskId && isAsyncToolName(t.name)) {
        matchedTool = t;
        break;
      }
    }
  }
  if (!matchedTool) {
    for (const t of inProgressTools.values()) {
      if (!t.taskId) {
        matchedTool = t;
        break;
      }
    }
  }
  const secs = timerSeconds(content);
  const due = secs !== undefined ? (Number.isFinite(createdAt) ? createdAt : Date.now()) + secs * 1000 : undefined;
  activeBgTasks.set(bg.fullId, {
    shortId: bg.shortId,
    description: bg.description || matchedTool?.detail || bg.shortId,
    toolCallId: matchedTool?.id,
    isDaemon: matchedTool?.isDaemon,
    timerDue: due,
  });
  if (matchedTool) {
    matchedTool.backgrounded = true;
    matchedTool.taskId = bg.fullId;
    emit({
      kind: "tool",
      id: matchedTool.id,
      name: matchedTool.name,
      detail: matchedTool.detail,
      status: "background",
      output: matchedTool.isDaemon
        ? `已作为后台常驻进程启动（${bg.shortId}）。\n${cleanToolOutput(content)}`
        : `已转入后台持续运行（${bg.shortId}），完成后将自动通知智能体继续。\n${cleanToolOutput(content)}`,
    });
  }
  if (!matchedTool?.isDaemon) leaveWakeupForAsync();
  markActivity();
  emitBackgroundSnapshot();
}

function pollParentTranscript(): void {
  if (!parentTailer) return;
  const steps = parentTailer.poll();
  for (const step of steps) {
    const idx = typeof step.step_index === "number" ? step.step_index : -1;
    const statusRaw = str(step.status).toUpperCase();
    const key = `${idx}:${statusRaw}`;
    if (idx >= 0 && seenParentStepKeys.has(key)) continue;
    const createdAt = typeof step.created_at === "string" ? Date.parse(step.created_at) : NaN;
    if (Number.isFinite(createdAt) && createdAt < startedAt - 2000) {
      if (idx >= 0) seenParentStepKeys.add(key);
      continue;
    }
    if (idx >= 0) {
      seenParentStepKeys.add(key);
      if (idx > maxParentStepIndex) maxParentStepIndex = idx;
    }

    const type = str(step.type).toUpperCase();
    const source = str(step.source).toUpperCase();
    const content = str(step.content);
    markActivity();

    if (type === "GENERIC" && statusRaw === "RUNNING" && content.startsWith("Created At:")) {
      const bg = parseBackgroundStart(content);
      if (bg) attachBackgroundTask(bg, content, createdAt);
    } else if (type === "GENERIC" && (statusRaw === "DONE" || statusRaw === "RUNNING")) {
      const launched = parseSubagentLaunch(content);
      if (launched) {
        const queuedMeta = !activeSubagents.has(launched.conversationId) ? pendingSubagentMeta.shift() : undefined;
        registerSubagent(launched.conversationId, { ...queuedMeta, logPath: launched.logPath });
      }
    } else if (type === "SYSTEM_MESSAGE" && content) {
      let asyncFinished = false;
      // Check background task completion
      for (const [fullId, bg] of [...activeBgTasks]) {
        const sender = content.includes(`sender=${fullId}`) || content.includes(`sender=${bg.shortId}`);
        const mentioned = new RegExp(`(?:^|[^\\w-])${bg.shortId}(?!\\d)`).test(content);
        if (sender || (mentioned && hasBackgroundEndMarker(content))) {
          activeBgTasks.delete(fullId);
          if (!bg.isDaemon) asyncFinished = true;
          if (bg.toolCallId) {
            const open = inProgressTools.get(bg.toolCallId);
            if (open) {
              inProgressTools.delete(bg.toolCallId);
              completedTools.add(bg.toolCallId);
              const failed = isFailedToolOutput(content);
              emit({
                kind: "tool",
                id: open.id,
                name: open.name,
                detail: open.detail,
                status: failed ? "failed" : "done",
                output: cleanToolOutput(content),
              });
            }
          }
          emitBackgroundSnapshot();
        }
      }
      // Check subagent completion
      for (const [subCid] of [...activeSubagents]) {
        if (content.includes(`sender=${subCid}`) || content.includes(subCid)) {
          const failed = /failed|error|terminated|cancelled/i.test(content) && !/completed/i.test(content);
          closeSubagent(subCid, failed ? "failed" : "done", content);
          asyncFinished = true;
        }
      }
      if (asyncFinished) {
        if (idx >= 0) pendingWakeupAfterStep = Math.max(pendingWakeupAfterStep, idx);
        if (inFlightPrompts === 0 && !hasOpenNonDaemonAsync()) {
          enterWakeup(idx);
        }
      } else if (awaitingWakeup && idx >= 0 && /\bsender=/.test(content)) {
        // SYSTEM_MESSAGE landed slightly after tool_call_update already cleared activeBgTasks:
        // advance wakeupStepIndex so only a PLANNER_RESPONSE strictly after this SYSTEM_MESSAGE confirms completion.
        if (idx > wakeupStepIndex) wakeupStepIndex = idx;
        wakeupDoneConfirmed = false;
        wakeupIdleSince = 0;
      }
    } else if (type === "ERROR_MESSAGE") {
      const errMsg = str(step.error) || str(step.message) || content;
      if (errMsg && !isTransientAgyError(errMsg) && awaitingWakeup) {
        wakeupError = errMsg;
      }
    } else if (type === "PLANNER_RESPONSE" && source === "MODEL" && statusRaw === "DONE") {
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls.filter(isObj) : [];
      for (const rawCall of calls) {
        const cname = str(rawCall.name);
        const cargs = unwrapTranscriptArgs(rawCall.args);
        if (cname === "invoke_subagent") {
          pendingSubagentMeta.push({
            name: str(cargs.Role) || str(cargs.TypeName) || undefined,
            role: str(cargs.TypeName) || undefined,
            detail: str(cargs.Prompt) || undefined,
          });
        } else if (cname === "manage_task" && ["kill", "stop", "cancel"].includes(str(cargs.Action).toLowerCase())) {
          removeBgTaskByTarget(str(cargs.TaskId));
        } else if (cname === "manage_subagents") {
          const act = str(cargs.Action).toLowerCase();
          if (act === "kill_all") {
            for (const sid of [...activeSubagents.keys()]) closeSubagent(sid, "done");
          } else if (act === "kill" && Array.isArray(cargs.ConversationIds)) {
            for (const rawSid of cargs.ConversationIds) closeSubagent(str(rawSid), "done");
          }
        }
      }
      const hasToolCalls = calls.length > 0;
      if (hasToolCalls) {
        if (awaitingWakeup) {
          wakeupSeenRunning = true;
          wakeupDoneConfirmed = false;
          wakeupIdleSince = 0;
        }
      } else {
        if (pendingWakeupAfterStep >= 0 && (idx < 0 || idx > pendingWakeupAfterStep)) {
          pendingWakeupAfterStep = -1;
        }
        if (
          awaitingWakeup &&
          !hasOpenNonDaemonAsync() &&
          openQuestions.length === 0 &&
          inFlightPrompts === 0 &&
          (idx < 0 || idx > wakeupStepIndex)
        ) {
          wakeupSeenRunning = true;
          wakeupDoneConfirmed = true;
          wakeupActivityAt = Date.now();
        }
      }
    }
  }
}

function pollBackgroundLogs(): void {
  if (!sessionId || activeBgTasks.size === 0) return;
  const tasksDir = join(cliBrainRoot, sessionId, ".system_generated", "tasks");
  if (!existsSync(tasksDir)) return;
  for (const bg of activeBgTasks.values()) {
    const p = join(tasksDir, `${bg.shortId}.log`);
    try {
      const sz = statSync(p).size;
      const prev = taskLogSizes.get(bg.shortId);
      if (prev !== undefined && sz > prev) {
        markActivity();
      }
      taskLogSizes.set(bg.shortId, sz);
    } catch {
      // log not yet created
    }
  }
}

/**
 * Authoritative completion check for autonomous post-background wakeups.
 * Never uses short fixed quiet timers (which killed real slow-thinking models mid-wakeup);
 * instead combines agy's own SQLite Cascade state (status + not_fully_idle) with transcript
 * PLANNER_RESPONSE confirmation.
 */
function evaluateWakeupCompletion(): void {
  if (finished || exiting) return;
  if (inFlightPrompts > 0 || openQuestions.length > 0) return;
  if (hasOpenNonDaemonAsync()) return;
  if (!awaitingWakeup) return;

  const now = Date.now();
  const db = readDbState();

  // 1. Authoritative RUNNING signal from agy's Cascade engine: NEVER exit while thinking, retrying, or running tools!
  if (isCascadeRunning(db)) {
    wakeupSeenRunning = true;
    wakeupIdleSince = 0;
    markActivity();
    return;
  }

  // 2. Authoritative not_fully_idle signal: agy still tracks an internal async task / swarm worker / pending wakeup
  if (db?.notFullyIdle) {
    wakeupIdleSince = 0;
    markActivity();
    return;
  }

  // 3. Fatal non-transient error during wakeup once engine is no longer running
  if (wakeupError && now - wakeupActivityAt >= 3000) {
    fail(`Antigravity wakeup error: ${wakeupError}`, 1);
    return;
  }

  // 4. Confirmed post-wakeup final PLANNER_RESPONSE (no tool_calls) and engine is idle (or DB unavailable in mock tests)
  if (wakeupDoneConfirmed && (!db || isCascadeIdle(db))) {
    if (now - wakeupActivityAt >= 800) {
      finishCleanly(false);
    }
    return;
  }

  // 5. DB-backed fallback when no PLANNER_RESPONSE arrived (e.g. cancelled task or silent no-op wakeup)
  if (db && isCascadeIdle(db)) {
    if (wakeupSeenRunning) {
      if (!wakeupIdleSince) wakeupIdleSince = now;
      if (now - wakeupIdleSince >= POST_RUNNING_IDLE_MS && now - wakeupActivityAt >= 3000) {
        finishCleanly(false);
      }
    } else if (now - wakeupStartedAt >= NO_WAKEUP_IDLE_MS && now - wakeupActivityAt >= NO_WAKEUP_IDLE_MS) {
      finishCleanly(false);
    }
    return;
  }

  // 6. Fallback when conversation_summaries.db is absent/unreadable (e.g. test harness without SQLite)
  if (!db && now - wakeupActivityAt >= FALLBACK_WAKEUP_QUIET_MS) {
    finishCleanly(false);
  }
}

// ── ACP notification & server request handlers ──────────────────────────────────
function onServerRequest(msg: Json): void {
  const method = str(msg.method);
  const p = isObj(msg.params) ? msg.params : {};
  if (method === "session/request_permission") {
    const opts = Array.isArray(p.options) ? p.options.filter(isObj) : [];
    const allow = opts.find((o) => str(o.kind).startsWith("allow")) ?? opts[0];
    const optionId = str(allow?.optionId) || "allow";
    respond(msg.id, { outcome: { outcome: "selected", optionId } });
    return;
  }
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unsupported method: ${method}` } })}\n`);
}

function handleToolUpdate(upd: Json): void {
  const toolCallId = str(upd.toolCallId) || `acp_tool_${Date.now()}`;
  const name = str(upd.name) || "tool";
  const toolArgs = isObj(upd.args) ? upd.args : isObj(upd.rawInput) ? upd.rawInput : {};
  const title = str(upd.title);
  const status = str(upd.status).toLowerCase();
  const detail = acpToolDetail(name, toolArgs, title);

  // Interactive ask_question bridge
  if (name === "ask_question") {
    const items = parseAskQuestionArgs(toolArgs);
    if ((status === "pending" || status === "in_progress") && items.length > 0 && !askToolCallIds.has(toolCallId)) {
      askToolCallIds.add(toolCallId);
      suppressAskFallbackText = true;
      const batch: PendingAskBatch = {
        toolCallId,
        items,
        questionIds: items.map((_, i) => `agy_q_${toolCallId}:${i}`),
        answers: items.map(() => undefined),
      };
      items.forEach((q, i) => {
        const qid = batch.questionIds[i]!;
        openQuestions.push({ id: qid, batch, index: i });
        emit({
          kind: "question",
          id: qid,
          tool: "ask_question",
          question: q.question,
          options: q.options,
          is_multi_select: q.isMultiSelect,
          status: "waiting",
        });
      });
    } else if (status === "completed") {
      suppressAskFallbackText = false;
    }
    return;
  }

  const isTerminal = status === "completed" || status === "failed" || status === "cancelled" || status === "canceled";
  markActivity();
  if (!isTerminal) {
    const existing = inProgressTools.get(toolCallId);
    if (existing?.backgrounded) return; // Don't revert a backgrounded tool back to "running"
    const isDaemon = toolArgs.IsDaemon === true || toolArgs.isDaemon === true;
    if (!existing) {
      inProgressTools.set(toolCallId, {
        id: toolCallId,
        name,
        detail,
        isDaemon,
        backgrounded: false,
        startedAt: Date.now(),
      });
    }
    if (!emittedTools.has(toolCallId)) {
      emittedTools.add(toolCallId);
      emit({ kind: "tool", id: toolCallId, name, detail, status: "running" });
    }
    if (awaitingWakeup) {
      wakeupSeenRunning = true;
      wakeupDoneConfirmed = false;
      wakeupIdleSince = 0;
    }
    return;
  }

  // Tool reached terminal state (completed / failed / cancelled)
  const rawText = extractAcpToolOutput(upd.rawOutput, upd.content);

  // Guard: if a tool reports "completed" immediately upon returning a background task ID (without an end marker),
  // keep it tracked as a live background task instead of dropping it prematurely.
  if (status === "completed" && rawText && !hasBackgroundEndMarker(rawText)) {
    const bgStart = parseBackgroundStart(rawText);
    if (bgStart) {
      let open = inProgressTools.get(toolCallId);
      if (!open) {
        const isDaemon = toolArgs.IsDaemon === true || toolArgs.isDaemon === true;
        open = {
          id: toolCallId,
          name,
          detail,
          isDaemon,
          backgrounded: false,
          startedAt: Date.now(),
        };
        inProgressTools.set(toolCallId, open);
      }
      attachBackgroundTask(bgStart, rawText, Date.now(), open);
      return;
    }
  }

  const prev = inProgressTools.get(toolCallId);
  const wasBackgrounded = Boolean(prev?.backgrounded);
  const wasDaemon = Boolean(prev?.isDaemon);
  let removedNonDaemonBg = false;
  inProgressTools.delete(toolCallId);
  completedTools.add(toolCallId);

  for (const [fullId, bg] of [...activeBgTasks]) {
    if (bg.toolCallId === toolCallId) {
      if (!bg.isDaemon) removedNonDaemonBg = true;
      activeBgTasks.delete(fullId);
    }
  }

  const cleanedOutput = rawText ? cleanToolOutput(rawText) : "";
  const finalStatus = status === "completed" && !isFailedToolOutput(rawText) ? "done" : "failed";

  emit({
    kind: "tool",
    id: toolCallId,
    name: prev?.name || name,
    detail: prev?.detail || detail,
    status: finalStatus,
    ...(cleanedOutput ? { output: cleanedOutput } : {}),
  });

  // Clean up explicitly killed background tasks / subagents
  if (name === "manage_task" && ["kill", "stop", "cancel"].includes(str(toolArgs.Action).toLowerCase())) {
    removeBgTaskByTarget(str(toolArgs.TaskId));
  } else if (name === "manage_subagents") {
    const act = str(toolArgs.Action).toLowerCase();
    if (act === "kill_all") {
      for (const sid of [...activeSubagents.keys()]) closeSubagent(sid, "done");
    } else if (act === "kill" && Array.isArray(toolArgs.ConversationIds)) {
      for (const rawSid of toolArgs.ConversationIds) closeSubagent(str(rawSid), "done");
    }
  }

  // Subagent launch detection from invoke_subagent rawOutput
  if (name === "invoke_subagent" && status === "completed") {
    const launched = parseSubagentLaunch(rawText);
    if (launched) {
      registerSubagent(launched.conversationId, {
        name: str(toolArgs.Role) || str(toolArgs.TypeName),
        role: str(toolArgs.TypeName) || undefined,
        detail: str(toolArgs.Prompt) || undefined,
        logPath: launched.logPath,
      });
    } else {
      // Fallback: check parent transcript immediately for subagent conversationId
      pollParentTranscript();
    }
  }

  if (wasBackgrounded || removedNonDaemonBg) {
    emitBackgroundSnapshot();
    if (inFlightPrompts === 0 && !wasDaemon && !hasOpenNonDaemonAsync()) {
      enterWakeup();
    }
  } else if (awaitingWakeup) {
    // Synchronous tool finished inside a wakeup turn: agent is still actively processing tool output
    wakeupSeenRunning = true;
    wakeupDoneConfirmed = false;
    wakeupIdleSince = 0;
  }
}

function onNotification(msg: Json): void {
  if (replayingHistory) return;
  if (str(msg.method) !== "session/update") return;
  const params = isObj(msg.params) ? msg.params : {};
  const upd = isObj(params.update) ? params.update : {};
  const kind = str(upd.sessionUpdate);

  switch (kind) {
    case "agent_thought_chunk": {
      const content = isObj(upd.content) ? upd.content : {};
      const text = str(content.text);
      if (text) {
        markActivity();
        emit({ kind: "thinking", text });
        if (awaitingWakeup) {
          wakeupSeenRunning = true;
          wakeupDoneConfirmed = false;
          wakeupIdleSince = 0;
        }
      }
      break;
    }
    case "agent_message_chunk": {
      const content = isObj(upd.content) ? upd.content : {};
      const text = str(content.text);
      if (!text) break;
      if (suppressAskFallbackText && openQuestions.length > 0) break;
      markActivity();
      // If a run_command/schedule/run_workflow is still open while the agent starts replying, it went async!
      promoteOpenToolsToBackground();
      let chunk = text;
      if (hasEmittedText && !textEndsWithNewline && awaitingWakeup && !wakeupEmittedText && !chunk.startsWith("\n")) {
        chunk = `\n\n${chunk}`;
      }
      hasEmittedText = true;
      textEndsWithNewline = chunk.endsWith("\n");
      emit({ kind: "text_delta", text: chunk });
      if (awaitingWakeup) {
        wakeupSeenRunning = true;
        wakeupEmittedText = true;
        wakeupIdleSince = 0;
      }
      break;
    }
    case "tool_call":
    case "tool_call_update":
      handleToolUpdate(upd);
      break;
    case "usage_update": {
      // Note: agy emits usage_update right BEFORE tool calls too, never treat it as an end-of-turn signal!
      markActivity();
      break;
    }
    default:
      break;
  }
}

createInterface({ input: server.stdout, crlfDelay: Infinity }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!isObj(msg)) return;
  if (msg.id != null && typeof msg.method === "string") {
    onServerRequest(msg);
    return;
  }
  if (msg.id != null && typeof msg.id === "number" && pendingRpc.has(msg.id)) {
    const waiter = pendingRpc.get(msg.id)!;
    pendingRpc.delete(msg.id);
    if (isObj(msg.error)) {
      const em = str(msg.error.message) || JSON.stringify(msg.error);
      waiter.reject(new Error(em));
    } else {
      waiter.resolve(msg.result);
    }
    return;
  }
  if (typeof msg.method === "string") {
    onNotification(msg);
  }
});

// ── Sending prompts & handling stdin steering / interactive answers ──────────────
function sendPrompt(text: string, isSteer = false): void {
  if (finished || exiting || !sessionId) {
    if (isSteer) emit({ kind: "steer", text, status: "late" });
    return;
  }
  if (hasEmittedText && !textEndsWithNewline) {
    emit({ kind: "text_delta", text: "\n\n" });
    textEndsWithNewline = true;
  }
  suppressAskFallbackText = false;
  leaveWakeupForAsync();
  markActivity();
  inFlightPrompts++;

  void request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  })
    .then((res) => {
      inFlightPrompts = Math.max(0, inFlightPrompts - 1);
      turns++;
      markActivity();
      const usage = isObj(res.usage) ? res.usage : undefined;
      if (usage) {
        if (typeof usage.inputTokens === "number") totalInputTokens += usage.inputTokens;
        if (typeof usage.cachedReadTokens === "number") totalCachedReadTokens += usage.cachedReadTokens;
        if (typeof usage.outputTokens === "number") totalOutputTokens += usage.outputTokens;
      }
      // Pull any transcript entries written just before end_turn (e.g. background task / subagent launch)
      pollParentTranscript();
      pollSubagents();
      promoteOpenToolsToBackground();

      if (inFlightPrompts > 0) return;
      if (openQuestions.length > 0) return;
      if (hasOpenNonDaemonAsync()) {
        emitBackgroundSnapshot();
        return;
      }
      // Guard: if a background task's SYSTEM_MESSAGE arrived right before end_turn and no post-SYSTEM_MESSAGE
      // PLANNER_RESPONSE has landed yet, wait for the wakeup turn instead of exiting early!
      if (pendingWakeupAfterStep >= 0) {
        enterWakeup(pendingWakeupAfterStep);
        return;
      }
      finishCleanly(false);
    })
    .catch((e: unknown) => {
      inFlightPrompts = Math.max(0, inFlightPrompts - 1);
      const message = e instanceof Error ? e.message : String(e);
      if (isSteer && !finished && !exiting) {
        err(`Antigravity ACP steer failed: ${message}\n`);
        emit({ kind: "steer", text, status: "late" });
        return;
      }
      fail(message, 1);
    });
}

const earlyInputs: Array<{ qid?: string; text: string }> = [];

function handleUserInput(qid: string | undefined, text: string): void {
  if (finished || exiting) {
    emit({ kind: "steer", text, status: "late" });
    return;
  }
  if (!sessionId) {
    earlyInputs.push({ qid, text });
    return;
  }
  const qIdx = openQuestions.findIndex((q) => (qid ? q.id === qid : true));
  if (qIdx >= 0) {
    const [entry] = openQuestions.splice(qIdx, 1);
    if (entry) {
      entry.batch.answers[entry.index] = text;
      emit({ kind: "question", id: entry.id, status: "answered", answer: clip(text, 200) });
      if (entry.batch.answers.every((a) => a !== undefined)) {
        const reply = formatAskQuestionAnswers(
          entry.batch.items,
          entry.batch.answers.map((a) => a ?? ""),
        );
        sendPrompt(reply, false);
      }
      return;
    }
  }
  // Mid-run steering (works both during active generation and while waiting on background tasks!)
  sendPrompt(text, true);
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let qid: string | undefined;
  let text = raw;
  if (raw.startsWith("{")) {
    try {
      const m = JSON.parse(raw) as unknown;
      if (isObj(m) && m.type === "memento_answer") {
        qid = str(m.question_id) || undefined;
        text = str(m.answer);
      }
    } catch {
      // plain text steering
    }
  }
  handleUserInput(qid, text);
});

async function cancelAndExit(code: number, note: string): Promise<void> {
  if (note) err(note);
  if (sessionId && !finished) {
    try {
      notify("session/cancel", { sessionId });
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  shutdown(code);
}

process.on("SIGINT", () => void cancelAndExit(130, "\n⏹️ [收到终止信号 (SIGINT)，已主动停止 Antigravity 任务]\n"));
process.on("SIGTERM", () => void cancelAndExit(130, "\n⏹️ [收到终止信号 (SIGTERM)，已主动停止 Antigravity 任务]\n"));

async function main(): Promise<void> {
  if (!args.prompt) {
    fail("Error: no prompt given");
    return;
  }

  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "memento", version: process.env.MEMENTO_DESKTOP_VERSION || "0.0.0" },
  });

  const meta = args.systemAppend
    ? { _meta: { antigravity: { systemPrompt: { append: args.systemAppend } } } }
    : {};
  const baseParams: Json = {
    cwd: args.cwd || process.cwd(),
    mcpServers: [],
    ...meta,
  };

  let sessionRes: Json;
  if (args.conversation) {
    // Snapshot transcript EOF before resuming so older turns are never replayed by parentTailer
    const prePath = join(cliBrainRoot, args.conversation, ".system_generated", "logs", "transcript.jsonl");
    parentTailer = new JsonlTailer(prePath, true);
    parentTailer.snapshotEof();
    try {
      sessionRes = await request("session/resume", { sessionId: args.conversation, ...baseParams });
    } catch (resumeErr) {
      const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
      if (/session\/load/i.test(msg)) {
        try {
          replayingHistory = true;
          sessionRes = await request("session/load", { sessionId: args.conversation, ...baseParams });
        } catch (loadErr) {
          replayingHistory = false;
          const lm = loadErr instanceof Error ? loadErr.message : String(loadErr);
          fail(`Error: failed to resume conversation ${args.conversation}: session not found (${lm})`, 1);
          return;
        } finally {
          replayingHistory = false;
        }
      } else {
        fail(`Error: failed to resume conversation ${args.conversation}: session not found (${msg})`, 1);
        return;
      }
    }
  } else {
    sessionRes = await request("session/new", baseParams);
  }

  sessionId = str(sessionRes.sessionId) || args.conversation;
  if (!sessionId) {
    fail("Error: Antigravity ACP returned no sessionId", 1);
    return;
  }
  err(`session id: ${sessionId}\n`);

  if (!parentTailer) {
    const transcriptPath = join(cliBrainRoot, sessionId, ".system_generated", "logs", "transcript.jsonl");
    parentTailer = new JsonlTailer(transcriptPath, false);
  }

  // Extract available models and current default model
  const modelsObj = isObj(sessionRes.models) ? sessionRes.models : {};
  const availableModels: AcpModelOption[] = (Array.isArray(modelsObj.availableModels) ? modelsObj.availableModels : [])
    .filter(isObj)
    .map((m) => ({ modelId: str(m.modelId), name: str(m.name) || undefined }))
    .filter((m) => Boolean(m.modelId));

  const configOptions = Array.isArray(sessionRes.configOptions) ? sessionRes.configOptions.filter(isObj) : [];
  const cfgModel = str(configOptions.find((c) => c.id === "model")?.currentValue);
  const cfgLevel = str(configOptions.find((c) => c.id === "thought_level")?.currentValue);
  activeModel = str(modelsObj.currentModelId) || (cfgModel && cfgLevel ? `${cfgModel}-${cfgLevel}` : cfgModel);

  const resolved = resolveAcpModel(args.model, args.effort, availableModels);
  if (resolved.invalidError) {
    fail(resolved.invalidError, 1);
    return;
  }
  if (resolved.modelId) {
    try {
      await request("session/set_model", { sessionId, modelId: resolved.modelId });
      activeModel = resolved.modelId;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (/unknown model|not recognized|invalid model/i.test(m)) {
        fail(`invalid model selection (--model "${args.model}"): ${m}`, 1);
        return;
      }
      fail(`Error setting model ${resolved.modelId}: ${m}`, 1);
      return;
    }
  }
  if (resolved.applyEffortSeparately) {
    const eff = normalizeAcpEffort(args.effort);
    if (eff) {
      await request("session/set_config_option", { sessionId, configId: "thought_level", value: eff }).catch(() => {});
    }
  }

  emit({ kind: "session", session_id: sessionId, ...(activeModel ? { model: activeModel } : {}) });

  // Background transcript/subagent/wakeup watcher (400ms poll for background task IDs, log growth, subagents, DB state & keepalive)
  pollTimer = setInterval(() => {
    if (finished || exiting) return;
    pollParentTranscript();
    pollSubagents();
    pollBackgroundLogs();
    evaluateWakeupCompletion();
    maybeEmitKeepalive();
  }, 400);
  pollTimer.unref();

  armActivityTimeout(true);

  sendPrompt(args.prompt, false);
  for (const early of earlyInputs.splice(0)) {
    handleUserInput(early.qid, early.text);
  }
}

main().catch((e: unknown) => fail(`Antigravity ACP error: ${e instanceof Error ? e.message : String(e)}`, 1));
