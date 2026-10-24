#!/usr/bin/env node
// memento's Codex runner. It drives `codex app-server` (JSON-RPC over stdio) instead of `codex exec`, because
// only the app server lets Codex ask the user something mid-task (request_user_input) and take follow-ups,
// and it prints the same JSONL lines `codex exec --json` prints, so the daemon parses both alike.
//
//   node codex_app.mjs [--codex BIN] [-C DIR] [--resume ID [--fork]] [--model M] [--effort E] [--timeout S] [--] PROMPT
//
// stdin, one line each: {"type":"memento_answer","question_id":..,"answer":..} answers a question it printed;
// any other text answers the oldest open question, or else is steered into the running turn.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const args = { codex: process.env.MEMENTO_CODEX_BIN || "codex", cwd: "", resume: "", fork: false, model: "", effort: "", timeout: 0, prompt: "" };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--codex") args.codex = argv[++i] ?? args.codex;
  else if (a === "-C" || a === "--cwd") args.cwd = argv[++i] ?? "";
  else if (a === "--resume") args.resume = argv[++i] ?? "";
  else if (a === "--fork") args.fork = true;
  else if (a === "--model") args.model = argv[++i] ?? "";
  else if (a === "--effort") args.effort = argv[++i] ?? "";
  else if (a === "--timeout") args.timeout = Number(argv[++i] ?? 0) || 0;
  else if (a === "--") {
    args.prompt = argv.slice(i + 1).join(" ");
    break;
  } else args.prompt = args.prompt ? `${args.prompt} ${a}` : a;
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  shutdown(code);
};

// Without the flag Codex refuses request_user_input outside Plan mode ("unavailable in Default mode").
const server = spawn(args.codex, ["app-server", "--enable", "default_mode_request_user_input"], {
  cwd: args.cwd || undefined,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  // npm installs Codex on Windows as codex.cmd, which only a shell can start
  shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(args.codex),
});
server.on("error", (e) => fail(`Codex app-server failed to start: ${e.message}`));
server.on("exit", (code) => {
  if (!finished && !exiting) fail(`Codex app-server exited (${code ?? "signal"}) before the turn finished`);
});
server.stderr.on("data", (c) => process.stderr.write(c));

let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const notify = (method, params) => server.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
const respond = (id, result) => server.stdin.write(`${JSON.stringify({ id, result })}\n`);
const respondError = (id, message) => server.stdin.write(`${JSON.stringify({ id, error: { code: -32601, message } })}\n`);

let threadId = "";
let turnId = "";
let finished = false;
let usage = null;

/** Items as `codex exec --json` names them, which is what the daemon's parser reads. */
function execItem(it) {
  switch (it?.type) {
    case "agentMessage":
      return { id: it.id, type: "agent_message", text: it.text ?? "" };
    case "reasoning":
      return { id: it.id, type: "reasoning", text: [...(it.summary ?? [])].join("\n") || [...(it.content ?? [])].join("\n") };
    case "commandExecution":
      return {
        id: it.id,
        type: "command_execution",
        command: it.command ?? "",
        aggregated_output: it.aggregatedOutput ?? "",
        ...(typeof it.exitCode === "number" ? { exit_code: it.exitCode } : {}),
        status: it.status,
      };
    case "fileChange":
      return { id: it.id, type: "file_change", changes: (it.changes ?? []).map((c) => ({ path: c.path, kind: c.kind })), status: it.status === "completed" ? "completed" : it.status === "inProgress" ? "in_progress" : "failed" };
    case "mcpToolCall": {
      const content = it.result?.content;
      const text = Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : JSON.stringify(c))).join("\n") : it.error?.message;
      return { id: it.id, type: "mcp_tool_call", server: it.server, tool: it.tool, arguments: it.arguments, ...(text ? { result: text } : {}), status: it.status === "failed" ? "failed" : it.status === "completed" ? "completed" : "in_progress" };
    }
    case "webSearch":
      return { id: it.id, type: "web_search", query: it.query ?? "" };
    default:
      return null;
  }
}

// ── Questions: printed as memento events; answers come back on stdin ─────────────────
const questions = []; // { id, ask, key, multi, options, answered }
const asks = new Map(); // ask id -> { rpcId, kind, total, answers }

function ask(rpcId, kind, items) {
  const askId = `codex_${rpcId}_${Date.now()}`;
  asks.set(askId, { rpcId, kind, total: items.length, answers: {} });
  items.forEach((q, i) => {
    const id = `${askId}:${i}`;
    questions.push({ id, ask: askId, key: q.key, multi: Boolean(q.multi), options: q.options ?? [], answered: false });
    out({
      type: "memento_event",
      event: {
        kind: "question",
        id,
        tool: kind,
        ...(q.header ? { header: q.header } : {}),
        question: q.question,
        options: (q.options ?? []).map((o) => (o.description ? { label: o.label, description: o.description } : o.label)),
        is_multi_select: Boolean(q.multi),
        status: "waiting",
      },
    });
  });
}

function answer(questionId, text) {
  const q = questions.find((x) => !x.answered && (!questionId || x.id === questionId));
  if (!q) return false;
  q.answered = true;
  const a = asks.get(q.ask);
  a.answers[q.key] = text;
  out({ type: "memento_event", event: { kind: "question", id: q.id, status: "answered", answer: text } });
  if (Object.keys(a.answers).length < a.total) return true;
  asks.delete(q.ask);
  const first = Object.values(a.answers)[0] ?? "";
  const yes = /^(允许|是|yes|y|accept|allow|ok|确认)/i.test(String(first).trim());
  if (a.kind === "request_user_input") {
    const answers = {};
    for (const [key, val] of Object.entries(a.answers)) {
      const sel = questions.find((x) => x.ask === q.ask && x.key === key);
      answers[key] = { answers: sel?.multi ? String(val).split(/\s*,\s*/).filter(Boolean) : [String(val)] };
    }
    respond(a.rpcId, { answers });
  } else if (a.kind === "elicitation") {
    respond(a.rpcId, { action: yes ? "accept" : "decline", content: yes ? {} : null, _meta: null });
  } else if (a.kind === "command_approval" || a.kind === "file_approval") {
    respond(a.rpcId, { decision: yes ? "accept" : "decline" });
  } else if (a.kind === "legacy_approval") {
    respond(a.rpcId, { decision: yes ? "approved" : { denied: { rejection: String(first) } } });
  }
  return true;
}

const ALLOW = [{ label: "允许" }, { label: "拒绝" }];

function onServerRequest(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case "item/tool/requestUserInput":
      ask(msg.id, "request_user_input", (p.questions ?? []).map((q) => ({
        key: q.id,
        header: q.header,
        question: q.question,
        options: q.options ?? [],
      })));
      return;
    case "mcpServer/elicitation/request":
      ask(msg.id, "elicitation", [{ key: "0", header: p.serverName, question: p.url ? `${p.message}\n${p.url}` : p.message, options: [{ label: "接受" }, { label: "拒绝" }] }]);
      return;
    // approvalPolicy is "never", so these only come if a policy outside memento forces a review
    case "item/commandExecution/requestApproval":
      ask(msg.id, "command_approval", [{ key: "0", header: "执行命令", question: `Codex 请求执行：${p.command ?? ""}${p.reason ? `\n原因：${p.reason}` : ""}`, options: ALLOW }]);
      return;
    case "item/fileChange/requestApproval":
      ask(msg.id, "file_approval", [{ key: "0", header: "修改文件", question: `Codex 请求修改文件${p.reason ? `：${p.reason}` : ""}`, options: ALLOW }]);
      return;
    case "execCommandApproval":
    case "applyPatchApproval":
      ask(msg.id, "legacy_approval", [{ key: "0", header: "审批", question: `Codex 请求批准：${(p.command ?? []).join?.(" ") ?? p.reason ?? ""}`, options: ALLOW }]);
      return;
    default:
      respondError(msg.id, `memento does not handle ${msg.method}`);
  }
}

function onNotification(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case "item/started":
    case "item/completed": {
      if (p.threadId && p.threadId !== threadId) return; // sub-agents
      const item = execItem(p.item);
      if (item) out({ type: msg.method === "item/started" ? "item.started" : "item.completed", item });
      return;
    }
    case "thread/tokenUsage/updated":
      if (p.threadId === threadId) usage = p.tokenUsage?.total ?? usage;
      return;
    case "error":
      if (!p.willRetry && (!p.threadId || p.threadId === threadId)) out({ type: "error", message: p.error?.message ?? "error" });
      return;
    case "turn/completed": {
      if (p.threadId !== threadId || (turnId && p.turn?.id !== turnId)) return;
      finished = true;
      if (p.turn?.status === "failed" || p.turn?.error) {
        out({ type: "turn.failed", error: { message: p.turn?.error?.message ?? "turn failed" } });
        shutdown(1);
      } else {
        out({ type: "turn.completed", usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 } });
        shutdown(p.turn?.status === "interrupted" ? 130 : 0);
      }
      return;
    }
  }
}

createInterface({ input: server.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && msg.method) return onServerRequest(msg);
  if (msg.id != null && pending.has(msg.id)) {
    const w = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else w.resolve(msg.result);
    return;
  }
  if (msg.method) onNotification(msg);
});

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let qid;
  let ans = text;
  if (text.startsWith("{")) {
    try {
      const m = JSON.parse(text);
      if (m?.type === "memento_answer") {
        qid = m.question_id || undefined;
        ans = String(m.answer ?? "");
      }
    } catch {
      // plain text after all
    }
  }
  if (answer(qid, ans)) return;
  if (threadId && turnId) {
    request("turn/steer", { threadId, input: [{ type: "text", text: ans, text_elements: [] }], expectedTurnId: turnId }).catch((e) =>
      process.stderr.write(`Codex steer failed: ${e.message}\n`),
    );
  }
});

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  try {
    server.stdin.end();
  } catch {}
  setTimeout(() => {
    try {
      server.kill();
    } catch {}
    process.exit(code);
  }, 300);
}

async function interruptAndExit(code, note) {
  if (note) process.stderr.write(note);
  if (threadId && turnId && !finished) {
    await Promise.race([request("turn/interrupt", { threadId, turnId }).catch(() => {}), new Promise((r) => setTimeout(r, 600))]);
  }
  shutdown(code);
}
process.on("SIGINT", () => void interruptAndExit(130, "\n⏹️ [收到终止信号 (SIGINT)，已主动停止 Codex 任务]\n"));
process.on("SIGTERM", () => void interruptAndExit(130, "\n⏹️ [收到终止信号 (SIGTERM)，已主动停止 Codex 任务]\n"));

async function main() {
  if (!args.prompt) return fail("Error: no prompt given");
  await request("initialize", { clientInfo: { name: "memento", title: "Memento", version: process.env.MEMENTO_DESKTOP_VERSION || "0.0.0" }, capabilities: null });
  notify("initialized");

  // memento runs Codex unattended, as `codex exec --dangerously-bypass-approvals-and-sandbox` did
  const common = {
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.model ? { model: args.model } : {}),
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
  let started;
  try {
    if (args.resume && args.fork) started = await request("thread/fork", { threadId: args.resume, ...common });
    else if (args.resume) started = await request("thread/resume", { threadId: args.resume, ...common });
    else started = await request("thread/start", common);
  } catch (e) {
    // The daemon starts a fresh session when it sees a resume fail with "thread not found"
    return fail(args.resume ? `Error: failed to resume thread ${args.resume}: thread not found (${e.message})` : `Error: ${e.message}`);
  }
  threadId = started?.thread?.id ?? "";
  if (!threadId) return fail("Error: Codex app-server returned no thread");
  out({ type: "thread.started", thread_id: threadId });

  const turn = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: args.prompt, text_elements: [] }],
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.model ? { model: args.model } : {}),
  });
  turnId = turn?.turn?.id ?? "";
  if (args.timeout > 0) {
    setTimeout(() => void interruptAndExit(124, `\n[Agent timeout: 任务执行已达到安全上限（${args.timeout}s）]\n`), args.timeout * 1000);
  }
}

main().catch((e) => fail(`Codex error: ${e.message}`));
