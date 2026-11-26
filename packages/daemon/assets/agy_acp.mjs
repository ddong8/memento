#!/usr/bin/env node
// Memento's Antigravity ACP runner: drives Google's `agy acp --stdio` (JSON-RPC) with live streaming, mid-turn steering, ask_question, subagents and background task tracking.
// Generated from packages/daemon/src/agy-acp-runner by packages/daemon/scripts/build-runners.mjs: do not edit.

// packages/daemon/src/agy-acp-runner/main.ts
import { spawn } from "node:child_process";
import { closeSync, existsSync as existsSync2, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// packages/daemon/src/acp-runner/protocol.ts
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var str = (v) => typeof v === "string" ? v : "";
var clip = (s, n) => s.length > n ? `${s.slice(0, n)}…` : s;
var READ_ONLY_KINDS = /* @__PURE__ */ new Set(["read", "search", "think", "fetch"]);
var EDIT_KINDS = /* @__PURE__ */ new Set(["edit", "delete", "move"]);
function autoPermissionOption(options, toolKind, mode) {
  const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
  if (!allow) return null;
  const kind = toolKind.toLowerCase();
  if (mode === "full") return allow.optionId;
  if (mode === "supervised") return null;
  if (READ_ONLY_KINDS.has(kind)) return allow.optionId;
  if (mode === "auto_edits" && EDIT_KINDS.has(kind)) return allow.optionId;
  return null;
}
function chosenPermissionOption(options, answer) {
  const a = answer.trim();
  const allowAll = a.startsWith("本次都允许");
  if (a === "允许" || allowAll) {
    const o = allowAll ? options.find((x) => x.kind === "allow_always") ?? options.find((x) => x.kind === "allow_once") : options.find((x) => x.kind === "allow_once") ?? options.find((x) => x.kind === "allow_always");
    return o ? { optionId: o.optionId, allowAll } : null;
  }
  const no = options.find((x) => x.kind === "reject_once") ?? options.find((x) => x.kind === "reject_always");
  return no ? { optionId: no.optionId, allowAll: false } : null;
}
function toolDetail(tc) {
  const title = str(tc.title);
  const loc = Array.isArray(tc.locations) && isObj(tc.locations[0]) ? str(tc.locations[0].path) : "";
  const raw = isObj(tc.rawInput) ? tc.rawInput : {};
  const cmd = str(raw.command) || (Array.isArray(raw.command) ? raw.command.join(" ") : "");
  return clip(title || cmd || loc || str(tc.kind) || "tool", 300);
}

// packages/daemon/src/agy-acp-runner/helpers.ts
import { existsSync } from "node:fs";

// packages/daemon/src/sqlite.ts
import { execFileSync } from "node:child_process";
var loaded;
function nodeSqlite() {
  if (loaded !== void 0) return loaded;
  const emit2 = process.emitWarning;
  process.emitWarning = ((warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/\bSQLite\b/.test(text ?? "")) return;
    emit2.call(process, warning, ...rest);
  });
  try {
    loaded = process.getBuiltinModule?.("node:sqlite") ?? null;
  } catch {
    loaded = null;
  } finally {
    process.emitWarning = emit2;
  }
  return loaded;
}
var sqliteCli = () => process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
var FIELD = "";
var ROW = "";
function inline(sql, params) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++] ?? null;
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${v.replace(/'/g, "''")}'`;
  });
}
function cli(path, sql, timeout) {
  return execFileSync(sqliteCli(), ["-batch", "-list", "-noheader", "-separator", FIELD, "-newline", ROW, path, sql], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"]
  });
}
function sqliteRows(path, sql, params = [], timeout = 3e3) {
  const sqlite = nodeSqlite();
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(path, { readOnly: true, timeout });
      try {
        return db.prepare(sql).all(...params).map((row) => Object.values(row));
      } finally {
        db.close();
      }
    } catch {
      return void 0;
    }
  }
  try {
    const out = cli(path, inline(sql, params), timeout);
    return out.split(ROW).filter((r) => r !== "" && r !== "\n").map((r) => r.split(FIELD));
  } catch {
    return void 0;
  }
}

// packages/daemon/src/agy-acp-runner/helpers.ts
var isObj2 = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
var str2 = (v) => typeof v === "string" ? v : v == null ? "" : String(v);
var clip2 = (s, max) => {
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
  } else if (isObj2(rawOutput)) {
    const out = rawOutput.output ?? rawOutput.text ?? rawOutput.content ?? rawOutput.stdout;
    if (typeof out === "string" && out.trim()) parts.push(out.trim());
    const err2 = rawOutput.error;
    if (typeof err2 === "string" && err2.trim()) parts.push(err2.trim());
    else if (isObj2(err2) && typeof err2.message === "string" && err2.message.trim()) parts.push(err2.message.trim());
  }
  if (!parts.length && Array.isArray(content)) {
    for (const item of content) {
      if (isObj2(item)) {
        if (typeof item.text === "string" && item.text.trim()) parts.push(item.text.trim());
        else if (isObj2(item.content) && typeof item.content.text === "string" && item.content.text.trim()) {
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
    if (!isObj2(q)) continue;
    const text = str2(q.question).trim();
    if (!text) continue;
    const opts = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (typeof o === "string" && o.trim()) {
          opts.push({ label: o.trim() });
        } else if (isObj2(o)) {
          const label = str2(o.label || o.text || o.value).trim();
          const description = str2(o.description).trim() || void 0;
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
      if (isObj2(parsed)) obj = parsed;
    } catch {
      return {};
    }
  } else if (isObj2(raw)) {
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
function readAgyConversationState(dbPath, conversationId) {
  if (!conversationId || !existsSync(dbPath)) return null;
  const rows = sqliteRows(
    dbPath,
    "SELECT status, not_fully_idle, step_count, killed FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
    [conversationId],
    1500
  );
  const row = rows?.[0];
  if (!row) return null;
  const status = str2(row[0]).trim();
  const nfiRaw = row[1];
  const notFullyIdle = nfiRaw === 1 || nfiRaw === true || String(nfiRaw).toLowerCase() === "true" || String(nfiRaw) === "1";
  const stepCount = Number(row[2] ?? 0) || 0;
  const killedRaw = row[3];
  const killed = killedRaw === 1 || killedRaw === true || String(killedRaw).toLowerCase() === "true" || String(killedRaw) === "1";
  return { status, notFullyIdle, stepCount, killed };
}
function isCascadeRunning(state) {
  if (!state) return false;
  return /RUNNING|WAITING/i.test(state.status);
}
function isCascadeIdle(state) {
  if (!state) return false;
  return /IDLE|DONE|ERROR|CANCEL/i.test(state.status) && !state.notFullyIdle;
}
function isAsyncToolName(name) {
  return name === "run_command" || name === "schedule" || name === "run_workflow" || name === "bash";
}
function hasBackgroundEndMarker(content) {
  return AGY_BG_ENDED.some((kw) => content.includes(kw));
}
function isFailedToolOutput(content) {
  return /(?:^|\n)\s*(?:The )?command exited with code [1-9]\d*\.?|\bStatus:\s*(?:ERROR|FAILED)\b|failed with result/i.test(content);
}
function isTransientAgyError(message) {
  return /\b(?:attempt\s+\d+|503|429|502|504|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|overloaded|rate limit|No capacity|temporarily unavailable)\b/i.test(
    message
  );
}

// packages/daemon/src/agy-acp-runner/main.ts
var argv = process.argv.slice(2);
var args = {
  agy: process.env.MEMENTO_AGY_BIN || "agy",
  appDataDir: process.env.MEMENTO_AGY_APP_DATA_DIR || "antigravity-cli",
  cwd: "",
  conversation: "",
  model: "",
  effort: "",
  timeout: 0,
  systemAppend: process.env.MEMENTO_AGY_SYSTEM_APPEND || "",
  permission: "full",
  prompt: ""
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--agy") args.agy = argv[++i] ?? args.agy;
  else if (a === "--app-data-dir" || a === "--app_data_dir") args.appDataDir = argv[++i] ?? args.appDataDir;
  else if (a === "-C" || a === "--cwd") args.cwd = argv[++i] ?? "";
  else if (a === "--conversation" || a === "--resume") args.conversation = argv[++i] ?? "";
  else if (a === "--model") args.model = argv[++i] ?? "";
  else if (a === "--effort") args.effort = argv[++i] ?? "";
  else if (a === "--timeout") args.timeout = Number(argv[++i] ?? 0) || 0;
  else if (a === "--system-append") args.systemAppend = argv[++i] ?? "";
  else if (a === "--permission") args.permission = argv[++i] ?? "full";
  else if (a === "--") {
    args.prompt = argv.slice(i + 1).join(" ");
    break;
  } else {
    args.prompt = args.prompt ? `${args.prompt} ${a}` : a;
  }
}
var lastStdoutEmitAt = Date.now();
var emit = (event) => {
  lastStdoutEmitAt = Date.now();
  process.stdout.write(`${JSON.stringify({ type: "memento_event", event })}
`);
};
var err = (msg) => process.stderr.write(msg);
var home = process.env.HOME || process.env.USERPROFILE || homedir();
var safeAppDataDir = /^[\w.-]+$/.test(args.appDataDir) ? args.appDataDir : "antigravity-cli";
var cliDataDir = join(home, ".gemini", safeAppDataDir);
var cliBrainRoot = join(cliDataDir, "brain");
var cliSummariesDb = join(cliDataDir, "conversation_summaries.db");
var NO_WAKEUP_IDLE_MS = Number(process.env.MEMENTO_AGY_NO_WAKEUP_MS) || 5e3;
var CANCEL_NO_WAKEUP_IDLE_MS = Number(process.env.MEMENTO_AGY_CANCEL_NO_WAKEUP_MS) || 2e3;
var POST_RUNNING_TEXT_IDLE_MS = Number(process.env.MEMENTO_AGY_POST_RUNNING_TEXT_IDLE_MS) || 1500;
var POST_RUNNING_IDLE_MS = Number(process.env.MEMENTO_AGY_POST_RUNNING_IDLE_MS) || 2500;
var CONFIRMED_DB_SETTLE_MS = 150;
var CONFIRMED_NODB_SETTLE_MS = 500;
var POLL_INTERVAL_MS = 200;
var DB_READ_CACHE_MS = 150;
var FALLBACK_WAKEUP_QUIET_MS = Number(process.env.MEMENTO_AGY_WAKEUP_FALLBACK_MS) || 12e4;
var KEEPALIVE_INTERVAL_MS = Number(process.env.MEMENTO_AGY_KEEPALIVE_MS) || 3e4;
var TIMER_WAKE_GRACE_MS = 12e4;
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
    if (existsSync2(this.path)) {
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
    if (!existsSync2(this.path)) return [];
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
        if (isObj2(parsed)) rows.push(parsed);
      } catch {
      }
    }
    return rows;
  }
};
var viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(args.agy);
var acpFlags = [
  "acp",
  "--stdio",
  "--dangerously-skip-permissions",
  ...safeAppDataDir !== "antigravity-cli" ? ["--app-data-dir", safeAppDataDir] : []
];
var server = viaShell ? spawn(`"${args.agy}" ${acpFlags.join(" ")}`, { cwd: args.cwd || void 0, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: true }) : spawn(args.agy, acpFlags, { cwd: args.cwd || void 0, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
var exiting = false;
var finished = false;
var sessionId = "";
var activeModel = "";
var replayingHistory = false;
var startedAt = Date.now();
var pollTimer;
var timeoutTimer;
var lastTimeoutArmedAt = 0;
function cleanupTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
}
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  cleanupTimers();
  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  if (server.exitCode !== null || server.signalCode !== null) {
    done();
    return;
  }
  server.once("exit", done);
  try {
    server.stdin.end();
  } catch {
  }
  const killTimer = setTimeout(() => {
    try {
      server.kill();
    } catch {
    }
    done();
  }, 150);
  killTimer.unref();
}
function fail(message, code = 1) {
  emit({ kind: "error", message: clip2(message, 2e3) });
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
  return new Promise((resolve, reject) => pendingRpc.set(id, { resolve: (v) => resolve(isObj2(v) ? v : {}), reject }));
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
var pendingSubagentMeta = [];
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
var wakeupStartedAt = 0;
var wakeupActivityAt = 0;
var wakeupStreamActivityAt = 0;
var wakeupConfirmedAt = 0;
var wakeupSeenRunning = false;
var wakeupDoneConfirmed = false;
var wakeupEmittedText = false;
var wakeupTriggerWasCancel = false;
var wakeupIdleSince = 0;
var wakeupStepIndex = -1;
var wakeupError = "";
var maxParentStepIndex = -1;
var pendingWakeupAfterStep = -1;
var pendingWakeupWasCancel = false;
var lastDbState = null;
var lastDbReadAt = 0;
var parentTailer;
var seenParentStepKeys = /* @__PURE__ */ new Set();
function readDbState(force = false) {
  if (!sessionId) return null;
  const now = Date.now();
  if (!force && now - lastDbReadAt < DB_READ_CACHE_MS) return lastDbState;
  lastDbReadAt = now;
  lastDbState = readAgyConversationState(cliSummariesDb, sessionId);
  return lastDbState;
}
function hasPendingTimer() {
  const now = Date.now();
  for (const bg of activeBgTasks.values()) {
    if (!bg.isDaemon && bg.timerDue !== void 0 && now < bg.timerDue + TIMER_WAKE_GRACE_MS) {
      return true;
    }
  }
  return false;
}
function armActivityTimeout(force = false) {
  if (args.timeout <= 0 || finished || exiting) return;
  const now = Date.now();
  if (!force && timeoutTimer && now - lastTimeoutArmedAt < 5e3) return;
  lastTimeoutArmedAt = now;
  if (timeoutTimer) clearTimeout(timeoutTimer);
  timeoutTimer = setTimeout(() => {
    if (finished || exiting) return;
    if (openQuestions.length > 0 || hasPendingTimer()) {
      armActivityTimeout(true);
      return;
    }
    if (hasOpenNonDaemonAsync()) {
      err(`
⏳ [任务在后台持续执行中（${backgroundSummaryNames()}），达到单次静默等待上限（${args.timeout}s），保持后台运行]
`);
      finishCleanly(true);
      return;
    }
    void cancelAndExit(124, `
[Agent timeout: 任务执行已达到静默安全上限（${args.timeout}s）]
`);
  }, args.timeout * 1e3);
  timeoutTimer.unref();
}
function isCancelOutput(text) {
  return /\bTimer cancelled\b|\bwas cancel(?:l)?ed\b|\bStatus:\s*CANCEL(?:L)?ED\b/i.test(text);
}
function markActivity(isStreamEvent = false) {
  const now = Date.now();
  armActivityTimeout(false);
  if (awaitingWakeup) {
    wakeupActivityAt = now;
    if (isStreamEvent) wakeupStreamActivityAt = now;
    wakeupIdleSince = 0;
  }
}
function enterWakeup(triggerStepIdx, wasCancel = false) {
  const now = Date.now();
  awaitingWakeup = true;
  wakeupStartedAt = now;
  wakeupActivityAt = now;
  wakeupStreamActivityAt = now;
  wakeupConfirmedAt = 0;
  wakeupSeenRunning = false;
  wakeupDoneConfirmed = false;
  wakeupEmittedText = false;
  wakeupTriggerWasCancel = wasCancel;
  wakeupIdleSince = 0;
  wakeupError = "";
  const floor = triggerStepIdx !== void 0 && triggerStepIdx >= 0 ? triggerStepIdx : maxParentStepIndex;
  if (floor > wakeupStepIndex) wakeupStepIndex = floor;
  armActivityTimeout(false);
}
function leaveWakeupForAsync() {
  awaitingWakeup = false;
  wakeupConfirmedAt = 0;
  wakeupSeenRunning = false;
  wakeupDoneConfirmed = false;
  wakeupEmittedText = false;
  wakeupTriggerWasCancel = false;
  wakeupIdleSince = 0;
  wakeupError = "";
}
function maybeEmitKeepalive() {
  if (finished || exiting) return;
  if (Date.now() - lastStdoutEmitAt < KEEPALIVE_INTERVAL_MS) return;
  const hasWork = hasOpenNonDaemonAsync() || openQuestions.length > 0 || awaitingWakeup && (wakeupSeenRunning || isCascadeRunning(lastDbState) || Boolean(lastDbState?.notFullyIdle));
  if (!hasWork) return;
  emit({ kind: "keepalive" });
}
function removeBgTaskByTarget(target) {
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
    if (!isAsyncToolName(tool.name)) continue;
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
  if (changed) {
    leaveWakeupForAsync();
    emitBackgroundSnapshot();
  }
}
function registerSubagent(subCid, meta) {
  const existing = activeSubagents.get(subCid);
  if (existing) {
    const fallbackPrefix = `子智能体 ${subCid.slice(0, 8)}`;
    const betterName = meta.name || meta.role;
    if (betterName && existing.name === fallbackPrefix) {
      existing.name = clip2(betterName, 80);
      if (meta.role) existing.role = clip2(meta.role, 60);
      if (meta.detail) existing.detail = clip2(meta.detail, 200);
      emit({
        kind: "subagent",
        id: existing.id,
        name: existing.name,
        ...existing.role ? { role: existing.role } : {},
        agent_type: "subagent",
        ...existing.detail ? { detail: existing.detail } : {},
        status: "running"
      });
      emitBackgroundSnapshot();
    }
    return;
  }
  const logPath = meta.logPath || join(cliBrainRoot, subCid, ".system_generated", "logs", "transcript.jsonl");
  const name = clip2(meta.name || meta.role || `子智能体 ${subCid.slice(0, 8)}`, 80);
  const sub = {
    id: subCid,
    name,
    role: meta.role ? clip2(meta.role, 60) : void 0,
    detail: meta.detail ? clip2(meta.detail, 200) : void 0,
    tailer: new JsonlTailer(logPath, false),
    stepTools: /* @__PURE__ */ new Map(),
    pendingTools: [],
    stepSeq: 0
  };
  activeSubagents.set(subCid, sub);
  leaveWakeupForAsync();
  markActivity();
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
      const stype = str2(step.type).toUpperCase();
      const sstatus = str2(step.status).toUpperCase();
      const scontent = str2(step.content);
      const stepIdx = typeof step.step_index === "number" ? step.step_index : -1;
      if (str2(step.source).toUpperCase() === "MODEL" && stype === "PLANNER_RESPONSE") {
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        for (const rawCall of calls) {
          if (!isObj2(rawCall)) continue;
          const name = str2(rawCall.name) || "tool";
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
  if (activity) markActivity();
  return activity;
}
function attachBackgroundTask(bg, content, createdAt, explicitTool) {
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
  if (!matchedTool?.isDaemon) leaveWakeupForAsync();
  markActivity();
  emitBackgroundSnapshot();
}
function pollParentTranscript() {
  if (!parentTailer) return;
  const steps = parentTailer.poll();
  for (const step of steps) {
    const idx = typeof step.step_index === "number" ? step.step_index : -1;
    const statusRaw = str2(step.status).toUpperCase();
    const key = `${idx}:${statusRaw}`;
    if (idx >= 0 && seenParentStepKeys.has(key)) continue;
    const createdAt = typeof step.created_at === "string" ? Date.parse(step.created_at) : NaN;
    if (Number.isFinite(createdAt) && createdAt < startedAt - 2e3) {
      if (idx >= 0) seenParentStepKeys.add(key);
      continue;
    }
    if (idx >= 0) {
      seenParentStepKeys.add(key);
      if (idx > maxParentStepIndex) maxParentStepIndex = idx;
    }
    const type = str2(step.type).toUpperCase();
    const source = str2(step.source).toUpperCase();
    const content = str2(step.content);
    const isFinalPlanner = type === "PLANNER_RESPONSE" && source === "MODEL" && statusRaw === "DONE" && (!Array.isArray(step.tool_calls) || step.tool_calls.filter(isObj2).length === 0);
    if (!isFinalPlanner) markActivity();
    if (type === "GENERIC" && statusRaw === "RUNNING" && content.startsWith("Created At:")) {
      const bg = parseBackgroundStart(content);
      if (bg) attachBackgroundTask(bg, content, createdAt);
    } else if (type === "GENERIC" && (statusRaw === "DONE" || statusRaw === "RUNNING")) {
      const launched = parseSubagentLaunch(content);
      if (launched) {
        const queuedMeta = !activeSubagents.has(launched.conversationId) ? pendingSubagentMeta.shift() : void 0;
        registerSubagent(launched.conversationId, { ...queuedMeta, logPath: launched.logPath });
      }
    } else if (type === "SYSTEM_MESSAGE" && content) {
      let asyncFinished = false;
      let endedCount = 0;
      let cancelledCount = 0;
      const msgIsCancel = isCancelOutput(content);
      for (const [fullId, bg] of [...activeBgTasks]) {
        const sender = content.includes(`sender=${fullId}`) || content.includes(`sender=${bg.shortId}`);
        const mentioned = new RegExp(`(?:^|[^\\w-])${bg.shortId}(?!\\d)`).test(content);
        if (sender || mentioned && hasBackgroundEndMarker(content)) {
          activeBgTasks.delete(fullId);
          if (!bg.isDaemon) {
            asyncFinished = true;
            endedCount++;
            if (msgIsCancel) cancelledCount++;
          }
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
                output: cleanToolOutput(content)
              });
            }
          }
          emitBackgroundSnapshot();
        }
      }
      for (const [subCid] of [...activeSubagents]) {
        if (content.includes(`sender=${subCid}`) || content.includes(subCid)) {
          const failed = /failed|error|terminated|cancelled/i.test(content) && !/completed/i.test(content);
          closeSubagent(subCid, failed ? "failed" : "done", content);
          asyncFinished = true;
          endedCount++;
          if (msgIsCancel) cancelledCount++;
        }
      }
      if (asyncFinished) {
        const allCancelled = endedCount > 0 && cancelledCount === endedCount;
        if (idx >= 0) {
          pendingWakeupAfterStep = Math.max(pendingWakeupAfterStep, idx);
          pendingWakeupWasCancel = allCancelled;
        }
        if (inFlightPrompts === 0 && !hasOpenNonDaemonAsync()) {
          enterWakeup(idx, allCancelled);
        }
      } else if (awaitingWakeup && idx >= 0 && /\bsender=/.test(content)) {
        if (idx > wakeupStepIndex) wakeupStepIndex = idx;
        if (msgIsCancel) wakeupTriggerWasCancel = true;
        wakeupDoneConfirmed = false;
        wakeupConfirmedAt = 0;
        wakeupIdleSince = 0;
      }
    } else if (type === "ERROR_MESSAGE") {
      const errMsg = str2(step.error) || str2(step.message) || content;
      if (errMsg && !isTransientAgyError(errMsg) && awaitingWakeup) {
        wakeupError = errMsg;
      }
    } else if (type === "PLANNER_RESPONSE" && source === "MODEL" && statusRaw === "DONE") {
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls.filter(isObj2) : [];
      for (const rawCall of calls) {
        const cname = str2(rawCall.name);
        const cargs = unwrapTranscriptArgs(rawCall.args);
        if (cname === "invoke_subagent") {
          pendingSubagentMeta.push({
            name: str2(cargs.Role) || str2(cargs.TypeName) || void 0,
            role: str2(cargs.TypeName) || void 0,
            detail: str2(cargs.Prompt) || void 0
          });
        } else if (cname === "manage_task" && ["kill", "stop", "cancel"].includes(str2(cargs.Action).toLowerCase())) {
          removeBgTaskByTarget(str2(cargs.TaskId));
        } else if (cname === "manage_subagents") {
          const act = str2(cargs.Action).toLowerCase();
          if (act === "kill_all") {
            for (const sid of [...activeSubagents.keys()]) closeSubagent(sid, "done");
          } else if (act === "kill" && Array.isArray(cargs.ConversationIds)) {
            for (const rawSid of cargs.ConversationIds) closeSubagent(str2(rawSid), "done");
          }
        }
      }
      const hasToolCalls = calls.length > 0;
      if (hasToolCalls) {
        if (awaitingWakeup) {
          wakeupSeenRunning = true;
          wakeupDoneConfirmed = false;
          wakeupConfirmedAt = 0;
          wakeupIdleSince = 0;
        }
      } else {
        if (pendingWakeupAfterStep >= 0 && (idx < 0 || idx > pendingWakeupAfterStep)) {
          pendingWakeupAfterStep = -1;
          pendingWakeupWasCancel = false;
        }
        if (awaitingWakeup && !hasOpenNonDaemonAsync() && openQuestions.length === 0 && inFlightPrompts === 0 && (idx < 0 || idx > wakeupStepIndex)) {
          wakeupSeenRunning = true;
          wakeupDoneConfirmed = true;
          if (!wakeupConfirmedAt) wakeupConfirmedAt = Date.now();
        }
      }
    }
  }
}
function pollBackgroundLogs() {
  if (!sessionId || activeBgTasks.size === 0) return;
  const tasksDir = join(cliBrainRoot, sessionId, ".system_generated", "tasks");
  if (!existsSync2(tasksDir)) return;
  for (const bg of activeBgTasks.values()) {
    const p = join(tasksDir, `${bg.shortId}.log`);
    try {
      const sz = statSync(p).size;
      const prev = taskLogSizes.get(bg.shortId);
      if (prev !== void 0 && sz > prev) {
        markActivity();
      }
      taskLogSizes.set(bg.shortId, sz);
    } catch {
    }
  }
}
function evaluateWakeupCompletion() {
  if (finished || exiting) return;
  if (inFlightPrompts > 0 || openQuestions.length > 0) return;
  if (hasOpenNonDaemonAsync()) return;
  if (!awaitingWakeup) return;
  const now = Date.now();
  const db = readDbState(wakeupDoneConfirmed);
  if (isCascadeRunning(db)) {
    wakeupSeenRunning = true;
    wakeupIdleSince = 0;
    markActivity();
    return;
  }
  if (db?.notFullyIdle) {
    wakeupIdleSince = 0;
    markActivity();
    return;
  }
  if (wakeupError && now - wakeupActivityAt >= 3e3) {
    fail(`Antigravity wakeup error: ${wakeupError}`, 1);
    return;
  }
  if (wakeupDoneConfirmed && (!db || isCascadeIdle(db))) {
    if (db && isCascadeIdle(db)) {
      const streamQuiet = now - wakeupStreamActivityAt >= CONFIRMED_DB_SETTLE_MS;
      const confirmQuiet = wakeupEmittedText || now - wakeupConfirmedAt >= CONFIRMED_DB_SETTLE_MS;
      if (streamQuiet && confirmQuiet) {
        finishCleanly(false);
      }
    } else if (now - Math.max(wakeupActivityAt, wakeupConfirmedAt) >= CONFIRMED_NODB_SETTLE_MS) {
      finishCleanly(false);
    }
    return;
  }
  if (db && isCascadeIdle(db)) {
    if (wakeupSeenRunning) {
      if (!wakeupIdleSince) wakeupIdleSince = now;
      const idleThreshold = wakeupEmittedText ? POST_RUNNING_TEXT_IDLE_MS : POST_RUNNING_IDLE_MS;
      const actThreshold = wakeupEmittedText ? POST_RUNNING_TEXT_IDLE_MS : 2e3;
      if (now - wakeupIdleSince >= idleThreshold && now - wakeupActivityAt >= actThreshold) {
        finishCleanly(false);
      }
    } else {
      const noWakeupMs = wakeupTriggerWasCancel ? CANCEL_NO_WAKEUP_IDLE_MS : NO_WAKEUP_IDLE_MS;
      if (now - wakeupStartedAt >= noWakeupMs && now - wakeupActivityAt >= noWakeupMs) {
        finishCleanly(false);
      }
    }
    return;
  }
  if (!db && now - wakeupActivityAt >= FALLBACK_WAKEUP_QUIET_MS) {
    finishCleanly(false);
  }
}
function onServerRequest(msg) {
  const method = str2(msg.method);
  const p = isObj2(msg.params) ? msg.params : {};
  if (method === "session/request_permission") {
    const opts = Array.isArray(p.options) ? p.options.filter(isObj2) : [];
    const options = opts.map((o) => ({ optionId: str2(o.optionId), name: str2(o.name), kind: str2(o.kind) }));
    const tc = isObj2(p.toolCall) ? p.toolCall : {};
    const kind = str2(tc.kind) || "other";
    const auto = permAllowedKinds.has(kind) ? autoPermissionOption(options, kind, "full") : autoPermissionOption(options, kind, args.permission);
    if (auto || !options.length) {
      const allow = opts.find((o) => str2(o.kind).startsWith("allow")) ?? opts[0];
      respond(msg.id, { outcome: { outcome: "selected", optionId: auto ?? (str2(allow?.optionId) || "allow") } });
      return;
    }
    const qid = `agy-perm-${String(msg.id)}`;
    pendingPerms.set(qid, { rpcId: msg.id, options, kind });
    emit({
      kind: "question",
      id: qid,
      tool: kind,
      header: "需要你批准",
      question: `Antigravity 想要：${toolDetail(tc)}`,
      options: [{ label: "允许" }, { label: `本次都允许 ${kind}`, description: "这次运行里同类操作不再询问" }, { label: "拒绝" }],
      is_multi_select: false,
      approval: true,
      status: "waiting"
    });
    return;
  }
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unsupported method: ${method}` } })}
`);
}
function handleToolUpdate(upd) {
  const toolCallId = str2(upd.toolCallId) || `acp_tool_${Date.now()}`;
  const name = str2(upd.name) || "tool";
  const toolArgs = isObj2(upd.args) ? upd.args : isObj2(upd.rawInput) ? upd.rawInput : {};
  const title = str2(upd.title);
  const status = str2(upd.status).toLowerCase();
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
  markActivity(true);
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
      wakeupSeenRunning = true;
      wakeupDoneConfirmed = false;
      wakeupIdleSince = 0;
    }
    return;
  }
  const rawText = extractAcpToolOutput(upd.rawOutput, upd.content);
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
          startedAt: Date.now()
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
    ...cleanedOutput ? { output: cleanedOutput } : {}
  });
  if (name === "manage_task" && ["kill", "stop", "cancel"].includes(str2(toolArgs.Action).toLowerCase())) {
    removeBgTaskByTarget(str2(toolArgs.TaskId));
  } else if (name === "manage_subagents") {
    const act = str2(toolArgs.Action).toLowerCase();
    if (act === "kill_all") {
      for (const sid of [...activeSubagents.keys()]) closeSubagent(sid, "done");
    } else if (act === "kill" && Array.isArray(toolArgs.ConversationIds)) {
      for (const rawSid of toolArgs.ConversationIds) closeSubagent(str2(rawSid), "done");
    }
  }
  if (name === "invoke_subagent" && status === "completed") {
    const launched = parseSubagentLaunch(rawText);
    if (launched) {
      registerSubagent(launched.conversationId, {
        name: str2(toolArgs.Role) || str2(toolArgs.TypeName),
        role: str2(toolArgs.TypeName) || void 0,
        detail: str2(toolArgs.Prompt) || void 0,
        logPath: launched.logPath
      });
    } else {
      pollParentTranscript();
    }
  }
  if (wasBackgrounded || removedNonDaemonBg) {
    emitBackgroundSnapshot();
    if (inFlightPrompts === 0 && !wasDaemon && !hasOpenNonDaemonAsync()) {
      const wasCancel = status === "cancelled" || status === "canceled" || isCancelOutput(rawText);
      enterWakeup(void 0, wasCancel);
    }
  } else if (awaitingWakeup) {
    wakeupSeenRunning = true;
    wakeupDoneConfirmed = false;
    wakeupConfirmedAt = 0;
    wakeupIdleSince = 0;
  }
}
function onNotification(msg) {
  if (replayingHistory) return;
  if (str2(msg.method) !== "session/update") return;
  const params = isObj2(msg.params) ? msg.params : {};
  const upd = isObj2(params.update) ? params.update : {};
  const kind = str2(upd.sessionUpdate);
  switch (kind) {
    case "agent_thought_chunk": {
      const content = isObj2(upd.content) ? upd.content : {};
      const text = str2(content.text);
      if (text) {
        markActivity(true);
        emit({ kind: "thinking", text });
        if (awaitingWakeup) {
          wakeupSeenRunning = true;
          wakeupDoneConfirmed = false;
          wakeupConfirmedAt = 0;
          wakeupIdleSince = 0;
        }
      }
      break;
    }
    case "agent_message_chunk": {
      const content = isObj2(upd.content) ? upd.content : {};
      const text = str2(content.text);
      if (!text) break;
      if (suppressAskFallbackText && openQuestions.length > 0) break;
      markActivity(true);
      promoteOpenToolsToBackground();
      let chunk = text;
      if (hasEmittedText && !textEndsWithNewline && awaitingWakeup && !wakeupEmittedText && !chunk.startsWith("\n")) {
        chunk = `

${chunk}`;
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
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!isObj2(msg)) return;
  if (msg.id != null && typeof msg.method === "string") {
    onServerRequest(msg);
    return;
  }
  if (msg.id != null && typeof msg.id === "number" && pendingRpc.has(msg.id)) {
    const waiter = pendingRpc.get(msg.id);
    pendingRpc.delete(msg.id);
    if (isObj2(msg.error)) {
      const em = str2(msg.error.message) || JSON.stringify(msg.error);
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
  leaveWakeupForAsync();
  markActivity();
  inFlightPrompts++;
  void request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }]
  }).then((res) => {
    inFlightPrompts = Math.max(0, inFlightPrompts - 1);
    turns++;
    markActivity();
    const usage = isObj2(res.usage) ? res.usage : void 0;
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
    if (pendingWakeupAfterStep >= 0) {
      enterWakeup(pendingWakeupAfterStep, pendingWakeupWasCancel);
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
var pendingPerms = /* @__PURE__ */ new Map();
var permAllowedKinds = /* @__PURE__ */ new Set();
function answerPermission(qid, text) {
  const key = qid && pendingPerms.has(qid) ? qid : !qid && pendingPerms.size ? [...pendingPerms.keys()][0] : "";
  const w = key ? pendingPerms.get(key) : void 0;
  if (!w) return false;
  pendingPerms.delete(key);
  const choice = chosenPermissionOption(w.options, text);
  if (choice?.allowAll) permAllowedKinds.add(w.kind);
  respond(w.rpcId, { outcome: choice ? { outcome: "selected", optionId: choice.optionId } : { outcome: "cancelled" } });
  emit({ kind: "question", id: key, status: "answered", answer: clip2(text, 200) });
  return true;
}
function handleUserInput(qid, text) {
  if (answerPermission(qid, text)) return;
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
      emit({ kind: "question", id: entry.id, status: "answered", answer: clip2(text, 200) });
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
      if (isObj2(m) && m.type === "memento_answer") {
        qid = str2(m.question_id) || void 0;
        text = str2(m.answer);
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
  sessionId = str2(sessionRes.sessionId) || args.conversation;
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
  const modelsObj = isObj2(sessionRes.models) ? sessionRes.models : {};
  const availableModels = (Array.isArray(modelsObj.availableModels) ? modelsObj.availableModels : []).filter(isObj2).map((m) => ({ modelId: str2(m.modelId), name: str2(m.name) || void 0 })).filter((m) => Boolean(m.modelId));
  const configOptions = Array.isArray(sessionRes.configOptions) ? sessionRes.configOptions.filter(isObj2) : [];
  const cfgModel = str2(configOptions.find((c) => c.id === "model")?.currentValue);
  const cfgLevel = str2(configOptions.find((c) => c.id === "thought_level")?.currentValue);
  activeModel = str2(modelsObj.currentModelId) || (cfgModel && cfgLevel ? `${cfgModel}-${cfgLevel}` : cfgModel);
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
    evaluateWakeupCompletion();
    maybeEmitKeepalive();
  }, POLL_INTERVAL_MS);
  pollTimer.unref();
  armActivityTimeout(true);
  sendPrompt(args.prompt, false);
  for (const early of earlyInputs.splice(0)) {
    handleUserInput(early.qid, early.text);
  }
}
main().catch((e) => fail(`Antigravity ACP error: ${e instanceof Error ? e.message : String(e)}`, 1));
