// Memento's generic ACP runner: drives any agent that speaks the Agent Client Protocol over stdio (OpenCode,
// Gemini CLI, Cursor, Kiro, Copilot CLI, ...) for a task sent to this device, and prints memento_event lines
// (session, text_delta, thinking, tool, question, error) that the daemon's UniversalStreamParser reads.
//   - resumes the agent's own session with session/load when it supports it, else starts a new one
//   - permission requests are answered by the task's permission mode; what the mode leaves open becomes an
//     approval card, answered with a memento_answer line on stdin
//   - other stdin lines are follow-ups, sent as the next prompt once the current turn ends
//   - SIGINT/SIGTERM cancel the turn (session/cancel) before exiting
//
// Usage: node acp_runner.mjs --cmd BIN [--arg A]... [-C DIR] [--session ID] [--permission MODE] [--label NAME] [--] PROMPT
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  autoPermissionOption,
  chosenPermissionOption,
  clip,
  isObj,
  str,
  toolDetail,
  updateToEvents,
  type Json,
  type PermissionMode,
  type PermissionOption,
  type UpdateState,
} from "./protocol.js";

const argv = process.argv.slice(2);
const opts = { cmd: "", args: [] as string[], cwd: process.cwd(), session: "", permission: "full" as PermissionMode, label: "Agent", prompt: "" };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--cmd") opts.cmd = argv[++i] ?? "";
  else if (a === "--arg") opts.args.push(argv[++i] ?? "");
  else if (a === "-C") opts.cwd = argv[++i] ?? opts.cwd;
  else if (a === "--session") opts.session = argv[++i] ?? "";
  else if (a === "--permission") opts.permission = (argv[++i] ?? "full") as PermissionMode;
  else if (a === "--label") opts.label = argv[++i] ?? opts.label;
  else if (a === "--") {
    opts.prompt = argv.slice(i + 1).join(" ");
    break;
  } else opts.prompt = opts.prompt ? `${opts.prompt} ${a}` : a;
}

const emit = (event: Json) => process.stdout.write(`${JSON.stringify({ type: "memento_event", event })}\n`);
const fail = (message: string, code = 1): never => {
  emit({ kind: "error", message: clip(message, 2000) });
  process.exit(code);
};
if (!opts.cmd) fail("没有指定要启动的 ACP 智能体");

const agent = spawn(opts.cmd, opts.args, {
  cwd: opts.cwd,
  stdio: ["pipe", "pipe", "pipe"],
  // npm installs these as .cmd shims on Windows, which only start through a shell
  shell: process.platform === "win32",
  windowsHide: true,
});
let stderrTail = "";
agent.stderr.on("data", (b: Buffer) => {
  stderrTail = (stderrTail + b.toString()).slice(-4000);
});
agent.on("error", (e) => fail(`${opts.label} 启动失败：${e.message}（是否已安装并登录？）`, 127));

let nextId = 1;
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
const send = (payload: Json) => agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
function request(method: string, params: Json): Promise<Json> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const notify = (method: string, params: Json) => send({ method, params });

let sessionId = "";
let replaying = false;
const state: UpdateState = { tools: new Map() };
/** Permission requests waiting for the user, by the question id shown on the card */
const waiting = new Map<string, { rpcId: unknown; options: PermissionOption[]; kind: string }>();
/** Tool kinds the user allowed for the rest of this run */
const allowedKinds = new Set<string>();

function onAgentRequest(msg: Json): void {
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
      status: "waiting",
    });
    return;
  }
  // memento doesn't offer the agent its file system or terminals (it uses its own): say so instead of hanging
  send({ id: msg.id, error: { code: -32601, message: `Unsupported method: ${method}` } });
}

createInterface({ input: agent.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // agents may log to stdout
  }
  if (!isObj(msg)) return;
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
    const p = pending.get(Number(msg.id));
    if (!p) return;
    pending.delete(Number(msg.id));
    if (msg.error) p.reject(new Error(isObj(msg.error) ? str(msg.error.message) || "ACP 错误" : "ACP 错误"));
    else p.resolve(isObj(msg.result) ? msg.result : {});
    return;
  }
  if (msg.method && msg.id !== undefined) return onAgentRequest(msg);
  if (msg.method === "session/update" && isObj(msg.params) && isObj(msg.params.update)) {
    if (replaying) return; // session/load replays the history memento already shows
    for (const e of updateToEvents(msg.params.update, state)) emit(e);
  }
});

const followUps: string[] = [];
let turnRunning = false;
let finished = false;

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let qid = "";
  let text = raw;
  if (raw.startsWith("{")) {
    try {
      const m = JSON.parse(raw) as unknown;
      if (isObj(m) && m.type === "memento_answer") {
        qid = str(m.question_id);
        text = str(m.answer);
      }
    } catch {
      // a plain follow-up
    }
  }
  const w = qid ? waiting.get(qid) : waiting.size ? [...waiting.entries()][0]![1] : undefined;
  const key = qid || (waiting.size ? [...waiting.keys()][0]! : "");
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

async function runTurn(text: string): Promise<string> {
  turnRunning = true;
  try {
    const res = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    return str(res.stopReason) || "end_turn";
  } finally {
    turnRunning = false;
  }
}

async function cancelAndExit(code: number): Promise<void> {
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
    clientInfo: { name: "memento", title: "Memento", version: "1" },
  });
  const caps = isObj(init.agentCapabilities) ? init.agentCapabilities : {};
  if (opts.session && caps.loadSession === true) {
    replaying = true;
    try {
      await request("session/load", { sessionId: opts.session, cwd: opts.cwd, mcpServers: [] });
      sessionId = opts.session;
    } catch {
      // gone (or another machine's): a new session below
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
})().catch((e: Error) => {
  const hint = /auth|login|unauthor/i.test(`${e.message} ${stderrTail}`) ? `（${opts.label} 可能还没登录）` : "";
  fail(`${opts.label} 出错：${e.message}${hint}${stderrTail.trim() ? `\n${clip(stderrTail.trim(), 800)}` : ""}`);
});
