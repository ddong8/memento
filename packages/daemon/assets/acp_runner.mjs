#!/usr/bin/env node
// Memento's generic ACP runner: drives any Agent Client Protocol agent over stdio (OpenCode, Gemini CLI, Cursor, Kiro, Copilot CLI) for tasks sent to this device.
// Generated from packages/daemon/src/acp-runner by packages/daemon/scripts/build-runners.mjs: do not edit.

// packages/daemon/src/acp-runner/main.ts
import { spawn } from "node:child_process";
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
function toolOutput(tc) {
  if (!Array.isArray(tc.content)) return "";
  const parts = [];
  for (const c of tc.content) {
    if (!isObj(c)) continue;
    if (c.type === "content" && isObj(c.content) && typeof c.content.text === "string") parts.push(c.content.text);
    else if (c.type === "diff") parts.push(`改动 ${str(c.path)}`);
  }
  return clip(parts.join("\n").trim(), 4e3);
}
function updateToEvents(update, state2) {
  const kind = str(update.sessionUpdate);
  switch (kind) {
    case "agent_message_chunk": {
      const text = isObj(update.content) ? str(update.content.text) : "";
      return text ? [{ kind: "text_delta", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = isObj(update.content) ? str(update.content.text) : "";
      return text ? [{ kind: "thinking", text }] : [];
    }
    case "tool_call": {
      const id = str(update.toolCallId);
      if (!id) return [];
      const name = str(update.kind) || "tool";
      state2.tools.set(id, name);
      const status = str(update.status);
      const done = status === "completed" || status === "failed";
      return [{
        kind: "tool",
        id,
        name,
        detail: toolDetail(update),
        status: status === "failed" ? "failed" : done ? "done" : "running",
        ...done && toolOutput(update) ? { output: toolOutput(update) } : {}
      }];
    }
    case "tool_call_update": {
      const id = str(update.toolCallId);
      if (!id) return [];
      const status = str(update.status);
      if (status !== "completed" && status !== "failed") {
        return update.title ? [{ kind: "tool", id, detail: toolDetail(update), status: "running" }] : [];
      }
      const out = toolOutput(update);
      return [{ kind: "tool", id, status: status === "failed" ? "failed" : "done", ...out ? { output: out } : {} }];
    }
    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries.filter(isObj) : [];
      if (!entries.length) return [];
      const lines = entries.map((e) => `${str(e.status) === "completed" ? "☑" : "☐"} ${str(e.content)}`);
      return [{ kind: "thinking", text: `计划：
${lines.join("\n")}
` }];
    }
    default:
      return [];
  }
}

// packages/daemon/src/acp-runner/main.ts
var argv = process.argv.slice(2);
var opts = { cmd: "", args: [], cwd: process.cwd(), session: "", permission: "full", label: "Agent", prompt: "" };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--cmd") opts.cmd = argv[++i] ?? "";
  else if (a === "--arg") opts.args.push(argv[++i] ?? "");
  else if (a === "-C") opts.cwd = argv[++i] ?? opts.cwd;
  else if (a === "--session") opts.session = argv[++i] ?? "";
  else if (a === "--permission") opts.permission = argv[++i] ?? "full";
  else if (a === "--label") opts.label = argv[++i] ?? opts.label;
  else if (a === "--") {
    opts.prompt = argv.slice(i + 1).join(" ");
    break;
  } else opts.prompt = opts.prompt ? `${opts.prompt} ${a}` : a;
}
var emit = (event) => process.stdout.write(`${JSON.stringify({ type: "memento_event", event })}
`);
var fail = (message, code = 1) => {
  emit({ kind: "error", message: clip(message, 2e3) });
  process.exit(code);
};
if (!opts.cmd) fail("没有指定要启动的 ACP 智能体");
var agent = spawn(opts.cmd, opts.args, {
  cwd: opts.cwd,
  stdio: ["pipe", "pipe", "pipe"],
  // npm installs these as .cmd shims on Windows, which only start through a shell
  shell: process.platform === "win32",
  windowsHide: true
});
var stderrTail = "";
agent.stderr.on("data", (b) => {
  stderrTail = (stderrTail + b.toString()).slice(-4e3);
});
agent.on("error", (e) => fail(`${opts.label} 启动失败：${e.message}（是否已安装并登录？）`, 127));
var nextId = 1;
var pending = /* @__PURE__ */ new Map();
var send = (payload) => agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}
`);
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
var notify = (method, params) => send({ method, params });
var sessionId = "";
var replaying = false;
var state = { tools: /* @__PURE__ */ new Map() };
var waiting = /* @__PURE__ */ new Map();
var allowedKinds = /* @__PURE__ */ new Set();
function onAgentRequest(msg) {
  const method = str(msg.method);
  const params = isObj(msg.params) ? msg.params : {};
  if (method === "session/request_permission") {
    const options = (Array.isArray(params.options) ? params.options : []).filter(isObj).map((o) => ({ optionId: str(o.optionId), name: str(o.name), kind: str(o.kind) }));
    const tc = isObj(params.toolCall) ? params.toolCall : {};
    const kind = str(tc.kind) || state.tools.get(str(tc.toolCallId)) || "other";
    const auto = allowedKinds.has(kind) ? autoPermissionOption(options, kind, "full") : autoPermissionOption(options, kind, opts.permission);
    if (auto) {
      send({ id: msg.id, result: { outcome: { outcome: "selected", optionId: auto } } });
      return;
    }
    const qid = `acp-perm-${String(msg.id)}`;
    waiting.set(qid, { rpcId: msg.id, options, kind });
    emit({
      kind: "question",
      id: qid,
      tool: kind,
      header: "需要你批准",
      question: `${opts.label} 想要：${toolDetail(tc)}`,
      options: [{ label: "允许" }, { label: `本次都允许 ${kind}`, description: "这次运行里同类操作不再询问" }, { label: "拒绝" }],
      is_multi_select: false,
      approval: true,
      status: "waiting"
    });
    return;
  }
  send({ id: msg.id, error: { code: -32601, message: `Unsupported method: ${method}` } });
}
createInterface({ input: agent.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObj(msg)) return;
  if (msg.id !== void 0 && (msg.result !== void 0 || msg.error !== void 0) && !msg.method) {
    const p = pending.get(Number(msg.id));
    if (!p) return;
    pending.delete(Number(msg.id));
    if (msg.error) p.reject(new Error(isObj(msg.error) ? str(msg.error.message) || "ACP 错误" : "ACP 错误"));
    else p.resolve(isObj(msg.result) ? msg.result : {});
    return;
  }
  if (msg.method && msg.id !== void 0) return onAgentRequest(msg);
  if (msg.method === "session/update" && isObj(msg.params) && isObj(msg.params.update)) {
    if (replaying) return;
    for (const e of updateToEvents(msg.params.update, state)) emit(e);
  }
});
var followUps = [];
var turnRunning = false;
var finished = false;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let qid = "";
  let text = raw;
  if (raw.startsWith("{")) {
    try {
      const m = JSON.parse(raw);
      if (isObj(m) && m.type === "memento_answer") {
        qid = str(m.question_id);
        text = str(m.answer);
      }
    } catch {
    }
  }
  const w = qid ? waiting.get(qid) : waiting.size ? [...waiting.entries()][0][1] : void 0;
  const key = qid || (waiting.size ? [...waiting.keys()][0] : "");
  if (w) {
    waiting.delete(key);
    const choice = chosenPermissionOption(w.options, text);
    if (choice?.allowAll) allowedKinds.add(w.kind);
    send({ id: w.rpcId, result: { outcome: choice ? { outcome: "selected", optionId: choice.optionId } : { outcome: "cancelled" } } });
    emit({ kind: "question", id: key, status: "answered", answer: clip(text, 200) });
    return;
  }
  followUps.push(text);
  emit({ kind: "steer", text, status: turnRunning ? "queued" : "delivered" });
});
async function runTurn(text) {
  turnRunning = true;
  try {
    const res = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    return str(res.stopReason) || "end_turn";
  } finally {
    turnRunning = false;
  }
}
async function cancelAndExit(code) {
  if (sessionId && !finished) {
    for (const [, w] of waiting) send({ id: w.rpcId, result: { outcome: { outcome: "cancelled" } } });
    notify("session/cancel", { sessionId });
    await new Promise((r) => setTimeout(r, 400));
  }
  agent.kill();
  process.exit(code);
}
process.on("SIGINT", () => void cancelAndExit(130));
process.on("SIGTERM", () => void cancelAndExit(143));
agent.on("exit", (code) => {
  if (finished) return;
  fail(`${opts.label} 意外退出（${code ?? "signal"}）${stderrTail.trim() ? `：${clip(stderrTail.trim(), 800)}` : ""}`, code || 1);
});
(async () => {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "memento", title: "Memento", version: "1" }
  });
  const caps = isObj(init.agentCapabilities) ? init.agentCapabilities : {};
  if (opts.session && caps.loadSession === true) {
    replaying = true;
    try {
      await request("session/load", { sessionId: opts.session, cwd: opts.cwd, mcpServers: [] });
      sessionId = opts.session;
    } catch {
    } finally {
      replaying = false;
    }
  }
  if (!sessionId) {
    const created = await request("session/new", { cwd: opts.cwd, mcpServers: [] });
    sessionId = str(created.sessionId);
    if (!sessionId) fail(`${opts.label} 没有返回会话编号`);
  }
  emit({ kind: "session", session_id: sessionId });
  let stop = await runTurn(opts.prompt);
  while (followUps.length && stop !== "cancelled") stop = await runTurn(followUps.splice(0).join("\n\n"));
  finished = true;
  if (stop === "refusal") emit({ kind: "error", message: `${opts.label} 拒绝了这个请求` });
  else if (stop === "max_tokens" || stop === "max_turn_requests") emit({ kind: "error", message: `${opts.label} 达到单轮上限（${stop}），回复可能不完整` });
  agent.kill();
  process.exit(stop === "end_turn" || stop === "max_tokens" || stop === "max_turn_requests" ? 0 : 1);
})().catch((e) => {
  const hint = /auth|login|unauthor/i.test(`${e.message} ${stderrTail}`) ? `（${opts.label} 可能还没登录）` : "";
  fail(`${opts.label} 出错：${e.message}${hint}${stderrTail.trim() ? `
${clip(stderrTail.trim(), 800)}` : ""}`);
});
