#!/usr/bin/env node
// Memento's Antigravity ACP runner: drives Google's `agy acp --stdio` (JSON-RPC) with live streaming, mid-turn steering, ask_question, subagents and background task tracking.
// Generated from packages/daemon/src/agy-acp-runner by packages/daemon/scripts/build-runners.mjs: do not edit.

// packages/daemon/src/agy-acp-runner/main.ts
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// packages/daemon/src/agy-acp-runner/helpers.ts
var isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
var str = (v) => typeof v === "string" ? v : v == null ? "" : String(v);
var clip = (s, max) => {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
};
function clipOutput(text, head = 1200, tail = 600) {
  const t = text.trim();
  if (t.length <= head + tail + 40) return t;
  const lines = t.slice(head, t.length - tail).split("\n").length - 1;
  return `${t.slice(0, head)}
… 省略 ${t.length - head - tail} 字${lines > 0 ? `（${lines} 行）` : ""} …
${t.slice(-tail)}`;
}
function cleanToolOutput(content) {
  return clipOutput(
    content.replace(/^(?:Created At|Completed At):[^\n]*\n/gm, "").replace(/\s*If relevant, proactively run terminal commands to execute this code for the USER\. Don't ask for permission\./g, "")
  );
}
var DETAIL_KEYS = [
  "CommandLine",
  "Command",
  "command",
  "cmd",
  "Path",
  "AbsolutePath",
  "TargetFile",
  "file_path",
  "path",
  "filePath",
  "File",
  "Query",
  "query",
  "Pattern",
  "pattern",
  "Url",
  "url",
  "Description",
  "description",
  "Prompt",
  "prompt",
  "Role",
  "toolSummary"
];
function acpToolDetail(name, args2, fallbackTitle = "") {
  const first = (...keys) => {
    for (const k of keys) {
      const v = args2[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return "";
  };
  const join2 = (x, y, sep = "  ") => [x, y].filter(Boolean).join(sep);
  let d = "";
  switch (name) {
    case "run_command":
      d = first("CommandLine", "Command", "command");
      break;
    case "read_file":
    case "view_file":
    case "view_file_outline":
    case "view_code_item": {
      d = first("Path", "AbsolutePath", "File", "TargetFile", "file_path");
      const from = first("StartLine");
      const to = first("EndLine");
      if (d && from) d += to ? `:${from}-${to}` : `:${from}`;
      break;
    }
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "write_file":
    case "write_to_file":
      d = first("Path", "TargetFile", "AbsolutePath", "File", "file_path");
      break;
    case "list_dir":
      d = first("DirectoryPath", "Path", "path");
      break;
    case "grep_search":
    case "codebase_search":
      d = join2(first("Query", "Pattern", "query", "pattern"), first("SearchPath", "SearchDirectory", "Path"));
      break;
    case "find_by_name":
      d = join2(first("Pattern", "pattern"), first("SearchDirectory", "SearchPath"));
      break;
    case "search_web":
      d = first("query", "Query");
      break;
    case "read_url_content":
    case "view_content_chunk":
      d = first("Url", "url", "DocumentId");
      break;
    case "manage_task":
      d = join2(first("Action"), first("TaskId"), " ");
      break;
    case "schedule": {
      const secs = first("DurationSeconds");
      d = join2(secs ? `${secs}s 后` : "", first("Prompt"), "：");
      break;
    }
    case "invoke_subagent":
      d = join2(first("Role", "TypeName"), first("Prompt"), "：");
      break;
    case "swarm":
      d = join2([first("action"), first("name")].filter(Boolean).join(" "), first("brief", "title"), "：");
      break;
    case "run_workflow":
      d = first("Description", "ScriptPath");
      break;
  }
  if (!d) d = first(...DETAIL_KEYS);
  if (!d && fallbackTitle && fallbackTitle !== `Run ${name}`) d = fallbackTitle;
  return Array.from(d.split("\n")[0].replace(/^["']+|["']+$/g, "")).slice(0, 200).join("");
}
function extractAcpToolOutput(rawOutput, content) {
  const parts = [];
  if (typeof rawOutput === "string" && rawOutput.trim()) {
    parts.push(rawOutput.trim());
  } else if (isObj(rawOutput)) {
    const out = rawOutput.output ?? rawOutput.text ?? rawOutput.content ?? rawOutput.stdout;
    if (typeof out === "string" && out.trim()) parts.push(out.trim());
    const err2 = rawOutput.error;
    if (typeof err2 === "string" && err2.trim()) parts.push(err2.trim());
    else if (isObj(err2) && typeof err2.message === "string" && err2.message.trim()) parts.push(err2.message.trim());
  }
  if (!parts.length && Array.isArray(content)) {
    for (const item of content) {
      if (isObj(item)) {
        if (typeof item.text === "string" && item.text.trim()) parts.push(item.text.trim());
        else if (isObj(item.content) && typeof item.content.text === "string" && item.content.text.trim()) {
          parts.push(item.content.text.trim());
        }
      }
    }
  }
  return parts.join("\n").trim();
}
function normalizeAcpEffort(effort) {
  const e = effort.trim().toLowerCase();
  if (e === "max" || e === "extra") return "xhigh";
  if (e === "low" || e === "medium" || e === "high" || e === "xhigh") return e;
  return "";
}
function resolveAcpModel(requestedModel, requestedEffort, available) {
  const m = requestedModel.trim();
  const eff = normalizeAcpEffort(requestedEffort);
  if (!m) {
    return { modelId: void 0, applyEffortSeparately: Boolean(eff) };
  }
  if (!available.length) {
    return { modelId: m, applyEffortSeparately: Boolean(eff) };
  }
  const byLower = new Map(available.map((x) => [x.modelId.toLowerCase(), x.modelId]));
  const exact = byLower.get(m.toLowerCase());
  if (exact) {
    const embedsEffort = /-(?:low|medium|high|xhigh)$/i.test(exact);
    if (eff && embedsEffort) {
      const swapped = exact.replace(/-(?:low|medium|high|xhigh)$/i, `-${eff}`);
      const swappedHit = byLower.get(swapped.toLowerCase());
      if (swappedHit) return { modelId: swappedHit, applyEffortSeparately: false };
    }
    return { modelId: exact, applyEffortSeparately: Boolean(eff) && !embedsEffort };
  }
  if (eff) {
    const withEff = byLower.get(`${m}-${eff}`.toLowerCase());
    if (withEff) return { modelId: withEff, applyEffortSeparately: false };
  }
  for (const fallbackEff of ["high", "medium", "low", "xhigh"]) {
    const cand = byLower.get(`${m}-${fallbackEff}`.toLowerCase());
    if (cand) return { modelId: cand, applyEffortSeparately: false };
  }
  return {
    invalidError: `invalid model selection (--model "${m}" --effort "${requestedEffort}"): model ${m} is not recognized as a known model`,
    applyEffortSeparately: false
  };
}
function parseAskQuestionArgs(args2) {
  const rawList = Array.isArray(args2.questions) ? args2.questions : [];
  const items = [];
  for (const q of rawList) {
    if (!isObj(q)) continue;
    const text = str(q.question).trim();
    if (!text) continue;
    const opts = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (typeof o === "string" && o.trim()) {
          opts.push({ label: o.trim() });
        } else if (isObj(o)) {
          const label = str(o.label || o.text || o.value).trim();
          const description = str(o.description).trim() || void 0;
          if (label) opts.push(description ? { label, description } : { label });
        }
      }
    }
    items.push({
      question: text,
      options: opts,
      isMultiSelect: q.is_multi_select === true || q.isMultiSelect === true
    });
  }
  return items;
}
function formatAskQuestionAnswers(questions, answers) {
  if (questions.length <= 1) return (answers[0] ?? "").trim();
  return questions.map((q, i) => `${i + 1}. ${q.question}
${(answers[i] ?? "").trim()}`).join("\n\n");
}
var AGY_BG_STARTED = /(?:Tool is running as a background task with task id|Command running in background with ID|Task running in background with ID):\s*((?:[0-9a-fA-F-]+\/)?task-\d+)/i;
var AGY_BG_ENDED = [
  "finished with result",
  "The command exited with code",
  "Command exited with code",
  "Timer fired",
  "Timer cancelled",
  "Status: DONE",
  "was canceled",
  "was cancelled",
  "Status: CANCELLED",
  "Status: CANCELED",
  "Status: ERROR",
  "Status: FAILED",
  "failed with result"
];
function parseBackgroundStart(content) {
  const m = AGY_BG_STARTED.exec(content);
  if (!m?.[1]) return null;
  const fullId = m[1].trim();
  const shortId = fullId.split("/").pop();
  const description = /Task Description:\s*(.+)/i.exec(content)?.[1]?.trim() || void 0;
  return { fullId, shortId, description };
}
function parseSubagentLaunch(content) {
  const cidMatch = /["']?conversationId["']?\s*[:=]\s*["']?([0-9a-fA-F-]{8,64})/i.exec(content) ?? /Subagent\s+([0-9a-fA-F-]{8,64})\s+is running/i.exec(content) ?? /Conversation ID:\s*([0-9a-fA-F-]{8,64})/i.exec(content);
  if (!cidMatch?.[1]) return null;
  let logPath;
  const uriMatch = /["']?logAbsoluteUri["']?\s*[:=]\s*["']?file:\/\/([^"'\s]+)/i.exec(content);
  if (uriMatch?.[1]) {
    let cleaned = decodeURIComponent(uriMatch[1]);
    if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(cleaned)) cleaned = cleaned.slice(1);
    else if (process.platform !== "win32" && !cleaned.startsWith("/")) cleaned = `/${cleaned}`;
    logPath = cleaned;
  }
  return { conversationId: cidMatch[1].trim(), logPath };
}
function timerSeconds(content) {
  const m = /Task Description:\s*Timer\s*\((\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i.exec(content) ?? /Waiting\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i.exec(content);
  if (!m?.[1] || !m[2]) return void 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return void 0;
  const u = m[2].toLowerCase();
  if (u.startsWith("h")) return n * 3600;
  if (u.startsWith("m")) return n * 60;
  return n;
}
function unwrapTranscriptArgs(raw) {
  let obj = {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (isObj(parsed)) obj = parsed;
    } catch {
      return {};
    }
  } else if (isObj(raw)) {
    obj = { ...raw };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      try {
        const inner = JSON.parse(v);
        if (typeof inner === "string") obj[k] = inner;
      } catch {
      }
    }
  }
  return obj;
}

// packages/daemon/src/agy-acp-runner/main.ts
var argv = process.argv.slice(2);
var args = {
  agy: process.env.MEMENTO_AGY_BIN || "agy",
  cwd: "",
  conversation: "",
  model: "",
  effort: "",
  timeout: 0,
  systemAppend: process.env.MEMENTO_AGY_SYSTEM_APPEND || "",
  prompt: ""
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
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
var emit = (event) => process.stdout.write(`${JSON.stringify({ type: "memento_event", event })}
`);
var err = (msg) => process.stderr.write(msg);
var home = process.env.HOME || process.env.USERPROFILE || homedir();
var cliBrainRoot = join(home, ".gemini", "antigravity-cli", "brain");
var JsonlTailer = class {
  constructor(path, startAtEnd) {
    this.path = path;
    this.startAtEnd = startAtEnd;
  }
  path;
  startAtEnd;
  offset = 0;
  remainder = "";
  initialized = false;
  snapshotEof() {
    if (this.initialized) return;
    if (existsSync(this.path)) {
      try {
        this.offset = this.startAtEnd ? statSync(this.path).size : 0;
        this.initialized = true;
      } catch {
      }
    } else if (!this.startAtEnd) {
      this.offset = 0;
      this.initialized = true;
    }
  }
  poll(maxBytes = 512 * 1024) {
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
    let fd;
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
      if (fd !== void 0) {
        try {
          closeSync(fd);
        } catch {
        }
      }
    }
    const lines = (this.remainder + chunk).split("\n");
    this.remainder = lines.pop() ?? "";
    const rows = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t);
        if (isObj(parsed)) rows.push(parsed);
      } catch {
      }
    }
    return rows;
  }
};
var viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(args.agy);
var acpFlags = ["acp", "--stdio", "--dangerously-skip-permissions"];
var server = viaShell ? spawn(`"${args.agy}" ${acpFlags.join(" ")}`, { cwd: args.cwd || void 0, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: true }) : spawn(args.agy, acpFlags, { cwd: args.cwd || void 0, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
var exiting = false;
var finished = false;
var sessionId = "";
var activeModel = "";
var replayingHistory = false;
var startedAt = Date.now();
var pollTimer;
var finishCheckTimer;
var timeoutTimer;
function cleanupTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (finishCheckTimer) clearTimeout(finishCheckTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
}
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  cleanupTimers();
  try {
    server.stdin.end();
  } catch {
  }
  setTimeout(() => {
    try {
      server.kill();
    } catch {
    }
    process.exit(code);
  }, 250);
}
function fail(message, code = 1) {
  emit({ kind: "error", message: clip(message, 2e3) });
  err(`${message}
`);
  shutdown(code);
}
server.on("error", (e) => fail(`Antigravity ACP failed to start: ${e.message}`));
server.on("exit", (code) => {
  if (!finished && !exiting) fail(`Antigravity ACP exited (${code ?? "signal"}) before the turn finished`);
});
server.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  const kept = text.split(/\r?\n/).filter((l) => !/root agent idle;\s*waiting/i.test(l)).join("\n");
  if (kept.trim()) err(kept.endsWith("\n") ? kept : `${kept}
`);
});
var nextRpcId = 1;
var pendingRpc = /* @__PURE__ */ new Map();
function request(method, params) {
  const id = nextRpcId++;
  const payload = params === void 0 ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
  server.stdin.write(`${JSON.stringify(payload)}
`);
  return new Promise((resolve, reject) => pendingRpc.set(id, { resolve: (v) => resolve(isObj(v) ? v : {}), reject }));
}
function notify(method, params) {
  const payload = params === void 0 ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
  server.stdin.write(`${JSON.stringify(payload)}
`);
}
function respond(id, result) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}
`);
}
var inProgressTools = /* @__PURE__ */ new Map();
var emittedTools = /* @__PURE__ */ new Set();
var completedTools = /* @__PURE__ */ new Set();
var activeBgTasks = /* @__PURE__ */ new Map();
var activeSubagents = /* @__PURE__ */ new Map();
var taskLogSizes = /* @__PURE__ */ new Map();
var openQuestions = [];
var askToolCallIds = /* @__PURE__ */ new Set();
var suppressAskFallbackText = false;
var inFlightPrompts = 0;
var turns = 0;
var totalInputTokens = 0;
var totalCachedReadTokens = 0;
var totalOutputTokens = 0;
var hasEmittedText = false;
var textEndsWithNewline = true;
var awaitingWakeup = false;
var wakeupActivityAt = 0;
var wakeupDoneConfirmed = false;
var wakeupSawTextOrTool = false;
var parentTailer;
var seenParentStepKeys = /* @__PURE__ */ new Set();
function emitBackgroundSnapshot() {
  const tasks = [];
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
function hasOpenNonDaemonAsync() {
  for (const bg of activeBgTasks.values()) {
    if (!bg.isDaemon) return true;
  }
  for (const tool of inProgressTools.values()) {
    if (!tool.isDaemon) return true;
  }
  if (activeSubagents.size > 0) return true;
  return false;
}
function hasAnyDaemonRunning() {
  for (const bg of activeBgTasks.values()) if (bg.isDaemon) return true;
  for (const tool of inProgressTools.values()) if (tool.isDaemon) return true;
  return false;
}
function emitUsage() {
  const duration_ms = Math.max(0, Date.now() - startedAt);
  const usage = { kind: "usage", duration_ms };
  if (totalInputTokens > 0) usage.input_tokens = totalInputTokens;
  if (totalCachedReadTokens > 0) usage.cache_read_tokens = totalCachedReadTokens;
  if (totalOutputTokens > 0) usage.output_tokens = totalOutputTokens;
  if (turns > 0) usage.turns = turns;
  emit(usage);
}
function backgroundSummaryNames() {
  const names = [];
  for (const bg of activeBgTasks.values()) names.push(bg.shortId);
  for (const sub of activeSubagents.values()) names.push(sub.name || sub.id.slice(0, 8));
  for (const tool of inProgressTools.values()) if (!tool.taskId) names.push(tool.detail || tool.name);
  return names.join(", ") || "background";
}
function finishCleanly(stillRunning = false) {
  if (finished || exiting) return;
  finished = true;
  emitUsage();
  if (stillRunning || hasAnyDaemonRunning()) {
    err(`
[STATUS_STILL_RUNNING: tasks=${backgroundSummaryNames()}]
`);
  }
  shutdown(0);
}
function promoteOpenToolsToBackground() {
  let changed = false;
  for (const tool of inProgressTools.values()) {
    if (tool.backgrounded) continue;
    if (tool.name !== "run_command" && tool.name !== "schedule" && tool.name !== "bash") continue;
    tool.backgrounded = true;
    changed = true;
    emit({
      kind: "tool",
      id: tool.id,
      name: tool.name,
      detail: tool.detail,
      status: "background",
      output: tool.isDaemon ? "已作为后台常驻进程启动（IsDaemon）。" : "已转入后台持续运行，完成后将自动通知智能体继续。"
    });
  }
  if (changed) emitBackgroundSnapshot();
}
function registerSubagent(subCid, meta) {
  if (activeSubagents.has(subCid)) return;
  const logPath = meta.logPath || join(cliBrainRoot, subCid, ".system_generated", "logs", "transcript.jsonl");
  const name = clip(meta.name || meta.role || `子智能体 ${subCid.slice(0, 8)}`, 80);
  const sub = {
    id: subCid,
    name,
    role: meta.role ? clip(meta.role, 60) : void 0,
    detail: meta.detail ? clip(meta.detail, 200) : void 0,
    tailer: new JsonlTailer(logPath, false),
    stepTools: /* @__PURE__ */ new Map(),
    pendingTools: [],
    stepSeq: 0
  };
  activeSubagents.set(subCid, sub);
  emit({
    kind: "subagent",
    id: sub.id,
    name: sub.name,
    ...sub.role ? { role: sub.role } : {},
    agent_type: "subagent",
    ...sub.detail ? { detail: sub.detail } : {},
    status: "running"
  });
  emitBackgroundSnapshot();
}
function closeSubagent(subCid, status, output) {
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
    ...output ? { output: cleanToolOutput(output) } : {}
  });
  emitBackgroundSnapshot();
}
function pollSubagents() {
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
            subagent_name: sub.name
          });
        }
      } else if (stype === "GENERIC" && (sstatus === "DONE" || sstatus === "ERROR" || sstatus === "FAILED")) {
        let tid = stepIdx >= 0 ? sub.stepTools.get(stepIdx) : void 0;
        if (!tid && sub.pendingTools.length > 0) {
          tid = sub.pendingTools.shift();
          if (tid && stepIdx >= 0) sub.stepTools.set(stepIdx, tid);
        }
        if (tid) {
          emit({
            kind: "tool",
            id: tid,
            status: sstatus === "ERROR" || sstatus === "FAILED" ? "failed" : "done",
            ...scontent.trim() ? { output: cleanToolOutput(scontent) } : {},
            subagent_id: sub.id,
            subagent_name: sub.name
          });
        }
      }
    }
  }
  return activity;
}
function pollParentTranscript() {
  if (!parentTailer) return;
  const steps = parentTailer.poll();
  for (const step of steps) {
    const idx = typeof step.step_index === "number" ? step.step_index : -1;
    const statusRaw = str(step.status).toUpperCase();
    const key = `${idx}:${statusRaw}`;
    if (idx >= 0 && seenParentStepKeys.has(key)) continue;
    const createdAt = typeof step.created_at === "string" ? Date.parse(step.created_at) : NaN;
    if (Number.isFinite(createdAt) && createdAt < startedAt - 2e3) {
      if (idx >= 0) seenParentStepKeys.add(key);
      continue;
    }
    if (idx >= 0) seenParentStepKeys.add(key);
    const type = str(step.type).toUpperCase();
    const source = str(step.source).toUpperCase();
    const content = str(step.content);
    if (type === "GENERIC" && statusRaw === "RUNNING" && content.startsWith("Created At:")) {
      const bg = parseBackgroundStart(content);
      if (bg && !activeBgTasks.has(bg.fullId)) {
        let matchedTool;
        for (const t of inProgressTools.values()) {
          if (!t.taskId && (t.name === "run_command" || t.name === "schedule" || t.name === "bash")) {
            matchedTool = t;
            break;
          }
        }
        const secs = timerSeconds(content);
        const due = secs !== void 0 ? (Number.isFinite(createdAt) ? createdAt : Date.now()) + secs * 1e3 : void 0;
        activeBgTasks.set(bg.fullId, {
          shortId: bg.shortId,
          description: bg.description || matchedTool?.detail || bg.shortId,
          toolCallId: matchedTool?.id,
          isDaemon: matchedTool?.isDaemon,
          timerDue: due
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
            output: matchedTool.isDaemon ? `已作为后台常驻进程启动（${bg.shortId}）。
${cleanToolOutput(content)}` : `已转入后台持续运行（${bg.shortId}），完成后将自动通知智能体继续。
${cleanToolOutput(content)}`
          });
        }
        emitBackgroundSnapshot();
      }
    } else if (type === "GENERIC" && (statusRaw === "DONE" || statusRaw === "RUNNING")) {
      const launched = parseSubagentLaunch(content);
      if (launched && !activeSubagents.has(launched.conversationId)) {
        registerSubagent(launched.conversationId, { logPath: launched.logPath });
      }
    } else if (type === "SYSTEM_MESSAGE" && content) {
      for (const [fullId, bg] of [...activeBgTasks]) {
        const sender = content.includes(`sender=${fullId}`) || content.includes(`sender=${bg.shortId}`);
        const mentioned = new RegExp(`(?:^|[^\\w-])${bg.shortId}(?!\\d)`).test(content);
        if (sender || mentioned && AGY_BG_ENDED.some((kw) => content.includes(kw))) {
          activeBgTasks.delete(fullId);
          if (bg.toolCallId) {
            const open = inProgressTools.get(bg.toolCallId);
            if (open) {
              inProgressTools.delete(bg.toolCallId);
              completedTools.add(bg.toolCallId);
              const failed = /Status:\s*(?:ERROR|FAILED)|failed with result|exited with code [1-9]/i.test(content);
              emit({
                kind: "tool",
                id: open.id,
                name: open.name,
                detail: open.detail,
                status: failed ? "failed" : "done",
                output: cleanToolOutput(content)
              });
            }
          }
          emitBackgroundSnapshot();
          if (inFlightPrompts === 0) {
            awaitingWakeup = true;
            wakeupActivityAt = Date.now();
            wakeupDoneConfirmed = false;
            wakeupSawTextOrTool = false;
          }
        }
      }
      for (const [subCid] of [...activeSubagents]) {
        if (content.includes(`sender=${subCid}`) || content.includes(subCid)) {
          const failed = /failed|error|terminated|cancelled/i.test(content) && !/completed/i.test(content);
          closeSubagent(subCid, failed ? "failed" : "done", content);
          if (inFlightPrompts === 0) {
            awaitingWakeup = true;
            wakeupActivityAt = Date.now();
            wakeupDoneConfirmed = false;
            wakeupSawTextOrTool = false;
          }
        }
      }
    } else if (type === "PLANNER_RESPONSE" && source === "MODEL" && statusRaw === "DONE") {
      const hasToolCalls = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
      if (awaitingWakeup && !hasToolCalls && !hasOpenNonDaemonAsync() && openQuestions.length === 0 && inFlightPrompts === 0) {
        wakeupDoneConfirmed = true;
        wakeupActivityAt = Date.now();
        scheduleFinishCheck(800);
      }
    }
  }
}
function pollBackgroundLogs() {
  if (!sessionId || activeBgTasks.size === 0) return;
  const tasksDir = join(cliBrainRoot, sessionId, ".system_generated", "tasks");
  if (!existsSync(tasksDir)) return;
  for (const bg of activeBgTasks.values()) {
    const p = join(tasksDir, `${bg.shortId}.log`);
    try {
      const sz = statSync(p).size;
      const prev = taskLogSizes.get(bg.shortId);
      if (prev !== void 0 && sz > prev) {
        wakeupActivityAt = Date.now();
      }
      taskLogSizes.set(bg.shortId, sz);
    } catch {
    }
  }
}
function scheduleFinishCheck(delayMs) {
  if (finishCheckTimer) clearTimeout(finishCheckTimer);
  finishCheckTimer = setTimeout(() => {
    if (finished || exiting) return;
    pollParentTranscript();
    pollSubagents();
    if (inFlightPrompts > 0 || openQuestions.length > 0 || hasOpenNonDaemonAsync()) return;
    if (!awaitingWakeup) {
      finishCleanly(false);
      return;
    }
    const quietMs = Date.now() - wakeupActivityAt;
    if (wakeupDoneConfirmed && quietMs >= 600) {
      finishCleanly(false);
      return;
    }
    if (wakeupSawTextOrTool && quietMs >= 2500) {
      finishCleanly(false);
      return;
    }
    if (quietMs >= 6e3) {
      finishCleanly(false);
      return;
    }
    scheduleFinishCheck(500);
  }, delayMs);
}
function onServerRequest(msg) {
  const method = str(msg.method);
  const p = isObj(msg.params) ? msg.params : {};
  if (method === "session/request_permission") {
    const opts = Array.isArray(p.options) ? p.options.filter(isObj) : [];
    const allow = opts.find((o) => str(o.kind).startsWith("allow")) ?? opts[0];
    const optionId = str(allow?.optionId) || "allow";
    respond(msg.id, { outcome: { outcome: "selected", optionId } });
    return;
  }
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unsupported method: ${method}` } })}
`);
}
function handleToolUpdate(upd) {
  const toolCallId = str(upd.toolCallId) || `acp_tool_${Date.now()}`;
  const name = str(upd.name) || "tool";
  const toolArgs = isObj(upd.args) ? upd.args : isObj(upd.rawInput) ? upd.rawInput : {};
  const title = str(upd.title);
  const status = str(upd.status).toLowerCase();
  const detail = acpToolDetail(name, toolArgs, title);
  if (name === "ask_question") {
    const items = parseAskQuestionArgs(toolArgs);
    if ((status === "pending" || status === "in_progress") && items.length > 0 && !askToolCallIds.has(toolCallId)) {
      askToolCallIds.add(toolCallId);
      suppressAskFallbackText = true;
      const batch = {
        toolCallId,
        items,
        questionIds: items.map((_, i) => `agy_q_${toolCallId}:${i}`),
        answers: items.map(() => void 0)
      };
      items.forEach((q, i) => {
        const qid = batch.questionIds[i];
        openQuestions.push({ id: qid, batch, index: i });
        emit({
          kind: "question",
          id: qid,
          tool: "ask_question",
          question: q.question,
          options: q.options,
          is_multi_select: q.isMultiSelect,
          status: "waiting"
        });
      });
    } else if (status === "completed") {
      suppressAskFallbackText = false;
    }
    return;
  }
  const isTerminal = status === "completed" || status === "failed" || status === "cancelled" || status === "canceled";
  if (!isTerminal) {
    const existing = inProgressTools.get(toolCallId);
    if (existing?.backgrounded) return;
    const isDaemon = toolArgs.IsDaemon === true || toolArgs.isDaemon === true;
    if (!existing) {
      inProgressTools.set(toolCallId, {
        id: toolCallId,
        name,
        detail,
        isDaemon,
        backgrounded: false,
        startedAt: Date.now()
      });
    }
    if (!emittedTools.has(toolCallId)) {
      emittedTools.add(toolCallId);
      emit({ kind: "tool", id: toolCallId, name, detail, status: "running" });
    }
    if (awaitingWakeup) {
      wakeupActivityAt = Date.now();
      wakeupSawTextOrTool = true;
      wakeupDoneConfirmed = false;
    }
    return;
  }
  const prev = inProgressTools.get(toolCallId);
  const wasBackgrounded = Boolean(prev?.backgrounded);
  inProgressTools.delete(toolCallId);
  completedTools.add(toolCallId);
  for (const [fullId, bg] of [...activeBgTasks]) {
    if (bg.toolCallId === toolCallId) {
      activeBgTasks.delete(fullId);
    }
  }
  const rawText = extractAcpToolOutput(upd.rawOutput, upd.content);
  const cleanedOutput = rawText ? cleanToolOutput(rawText) : "";
  const finalStatus = status === "completed" ? "done" : "failed";
  emit({
    kind: "tool",
    id: toolCallId,
    name: prev?.name || name,
    detail: prev?.detail || detail,
    status: finalStatus,
    ...cleanedOutput ? { output: cleanedOutput } : {}
  });
  if (name === "invoke_subagent" && status === "completed") {
    const launched = parseSubagentLaunch(rawText);
    if (launched) {
      registerSubagent(launched.conversationId, {
        name: str(toolArgs.Role) || str(toolArgs.TypeName),
        role: str(toolArgs.TypeName) || void 0,
        detail: str(toolArgs.Prompt) || void 0,
        logPath: launched.logPath
      });
    } else {
      pollParentTranscript();
    }
  }
  if (wasBackgrounded) {
    emitBackgroundSnapshot();
    if (inFlightPrompts === 0) {
      awaitingWakeup = true;
      wakeupActivityAt = Date.now();
      wakeupDoneConfirmed = false;
      wakeupSawTextOrTool = false;
      scheduleFinishCheck(1200);
    }
  } else if (awaitingWakeup) {
    wakeupActivityAt = Date.now();
    wakeupSawTextOrTool = true;
  }
}
function onNotification(msg) {
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
        emit({ kind: "thinking", text });
        if (awaitingWakeup) {
          wakeupActivityAt = Date.now();
          wakeupSawTextOrTool = true;
        }
      }
      break;
    }
    case "agent_message_chunk": {
      const content = isObj(upd.content) ? upd.content : {};
      const text = str(content.text);
      if (!text) break;
      if (suppressAskFallbackText && openQuestions.length > 0) break;
      promoteOpenToolsToBackground();
      let chunk = text;
      if (hasEmittedText && !textEndsWithNewline && awaitingWakeup && !wakeupSawTextOrTool && !chunk.startsWith("\n")) {
        chunk = `

${chunk}`;
      }
      hasEmittedText = true;
      textEndsWithNewline = chunk.endsWith("\n");
      emit({ kind: "text_delta", text: chunk });
      if (awaitingWakeup) {
        wakeupActivityAt = Date.now();
        wakeupSawTextOrTool = true;
      }
      break;
    }
    case "tool_call":
    case "tool_call_update":
      handleToolUpdate(upd);
      break;
    case "usage_update": {
      if (awaitingWakeup && wakeupSawTextOrTool && !hasOpenNonDaemonAsync() && openQuestions.length === 0 && inFlightPrompts === 0) {
        wakeupActivityAt = Date.now();
        scheduleFinishCheck(1e3);
      }
      break;
    }
    default:
      break;
  }
}
createInterface({ input: server.stdout, crlfDelay: Infinity }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
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
    const waiter = pendingRpc.get(msg.id);
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
function sendPrompt(text, isSteer = false) {
  if (finished || exiting || !sessionId) {
    if (isSteer) emit({ kind: "steer", text, status: "late" });
    return;
  }
  if (hasEmittedText && !textEndsWithNewline) {
    emit({ kind: "text_delta", text: "\n\n" });
    textEndsWithNewline = true;
  }
  suppressAskFallbackText = false;
  awaitingWakeup = false;
  wakeupDoneConfirmed = false;
  wakeupSawTextOrTool = false;
  if (finishCheckTimer) clearTimeout(finishCheckTimer);
  inFlightPrompts++;
  void request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }]
  }).then((res) => {
    inFlightPrompts = Math.max(0, inFlightPrompts - 1);
    turns++;
    const usage = isObj(res.usage) ? res.usage : void 0;
    if (usage) {
      if (typeof usage.inputTokens === "number") totalInputTokens += usage.inputTokens;
      if (typeof usage.cachedReadTokens === "number") totalCachedReadTokens += usage.cachedReadTokens;
      if (typeof usage.outputTokens === "number") totalOutputTokens += usage.outputTokens;
    }
    pollParentTranscript();
    pollSubagents();
    promoteOpenToolsToBackground();
    if (inFlightPrompts > 0) return;
    if (openQuestions.length > 0) return;
    if (hasOpenNonDaemonAsync()) {
      emitBackgroundSnapshot();
      return;
    }
    finishCleanly(false);
  }).catch((e) => {
    inFlightPrompts = Math.max(0, inFlightPrompts - 1);
    const message = e instanceof Error ? e.message : String(e);
    if (isSteer && !finished && !exiting) {
      err(`Antigravity ACP steer failed: ${message}
`);
      emit({ kind: "steer", text, status: "late" });
      return;
    }
    fail(message, 1);
  });
}
var earlyInputs = [];
function handleUserInput(qid, text) {
  if (finished || exiting) {
    emit({ kind: "steer", text, status: "late" });
    return;
  }
  if (!sessionId) {
    earlyInputs.push({ qid, text });
    return;
  }
  const qIdx = openQuestions.findIndex((q) => qid ? q.id === qid : true);
  if (qIdx >= 0) {
    const [entry] = openQuestions.splice(qIdx, 1);
    if (entry) {
      entry.batch.answers[entry.index] = text;
      emit({ kind: "question", id: entry.id, status: "answered", answer: clip(text, 200) });
      if (entry.batch.answers.every((a) => a !== void 0)) {
        const reply = formatAskQuestionAnswers(
          entry.batch.items,
          entry.batch.answers.map((a) => a ?? "")
        );
        sendPrompt(reply, false);
      }
      return;
    }
  }
  sendPrompt(text, true);
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let qid;
  let text = raw;
  if (raw.startsWith("{")) {
    try {
      const m = JSON.parse(raw);
      if (isObj(m) && m.type === "memento_answer") {
        qid = str(m.question_id) || void 0;
        text = str(m.answer);
      }
    } catch {
    }
  }
  handleUserInput(qid, text);
});
async function cancelAndExit(code, note) {
  if (note) err(note);
  if (sessionId && !finished) {
    try {
      notify("session/cancel", { sessionId });
    } catch {
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  shutdown(code);
}
process.on("SIGINT", () => void cancelAndExit(130, "\n⏹️ [收到终止信号 (SIGINT)，已主动停止 Antigravity 任务]\n"));
process.on("SIGTERM", () => void cancelAndExit(130, "\n⏹️ [收到终止信号 (SIGTERM)，已主动停止 Antigravity 任务]\n"));
async function main() {
  if (!args.prompt) {
    fail("Error: no prompt given");
    return;
  }
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "memento", version: process.env.MEMENTO_DESKTOP_VERSION || "0.0.0" }
  });
  const meta = args.systemAppend ? { _meta: { antigravity: { systemPrompt: { append: args.systemAppend } } } } : {};
  const baseParams = {
    cwd: args.cwd || process.cwd(),
    mcpServers: [],
    ...meta
  };
  let sessionRes;
  if (args.conversation) {
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
  err(`session id: ${sessionId}
`);
  if (!parentTailer) {
    const transcriptPath = join(cliBrainRoot, sessionId, ".system_generated", "logs", "transcript.jsonl");
    parentTailer = new JsonlTailer(transcriptPath, false);
  }
  const modelsObj = isObj(sessionRes.models) ? sessionRes.models : {};
  const availableModels = (Array.isArray(modelsObj.availableModels) ? modelsObj.availableModels : []).filter(isObj).map((m) => ({ modelId: str(m.modelId), name: str(m.name) || void 0 })).filter((m) => Boolean(m.modelId));
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
      await request("session/set_config_option", { sessionId, configId: "thought_level", value: eff }).catch(() => {
      });
    }
  }
  emit({ kind: "session", session_id: sessionId, ...activeModel ? { model: activeModel } : {} });
  pollTimer = setInterval(() => {
    if (finished || exiting) return;
    pollParentTranscript();
    pollSubagents();
    pollBackgroundLogs();
  }, 300);
  pollTimer.unref();
  if (args.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      if (finished || exiting) return;
      if (openQuestions.length > 0) return;
      if (hasOpenNonDaemonAsync()) {
        err(`
⏳ [任务在后台持续执行中（${backgroundSummaryNames()}），达到单次等待上限（${args.timeout}s），保持后台运行]
`);
        finishCleanly(true);
        return;
      }
      void cancelAndExit(124, `
[Agent timeout: 任务执行已达到安全上限（${args.timeout}s）]
`);
    }, args.timeout * 1e3);
    timeoutTimer.unref();
  }
  sendPrompt(args.prompt, false);
  for (const early of earlyInputs.splice(0)) {
    handleUserInput(early.qid, early.text);
  }
}
main().catch((e) => fail(`Antigravity ACP error: ${e instanceof Error ? e.message : String(e)}`, 1));
