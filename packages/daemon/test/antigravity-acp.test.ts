// End-to-end tests for Memento's Antigravity ACP runner (`agy_acp.mjs` driving `agy acp --stdio`):
// token-by-token streaming, background task wakeup without head-of-line blocking, mid-turn steering,
// interactive ask_question dialog bridging, nested subagent transcript streaming, model fallback & cancel.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { formatAskQuestionAnswers, parseAskQuestionArgs, parseSubagentLaunch, resolveAcpModel } from "../src/agy-acp-runner/helpers.js";

const dir = mkdtempSync(join(tmpdir(), "agy-acp-test-"));
const fakeAgy = join(dir, "agy");
const fakeHome = join(dir, "home");
const CID = "a1b2c3d4-1111-4222-8333-444455556666";
const SUB_CID = "b2c3d4e5-2222-4333-8444-555566667777";

vi.mock("../src/antigravity.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/antigravity.js")>();
  return {
    ...real,
    antigravityExecutable: async () => join(dir, "agy_cli.mjs"),
    discoverAntigravityEnv: async () => null,
    officialAgyCli: async () => fakeAgy,
    ensureOfficialAgyCli: async () => fakeAgy,
  };
});

const { WsTaskClient } = await import("../src/ws-client.js");

beforeAll(() => {
  mkdirSync(fakeHome, { recursive: true });
  const js = join(dir, "fake_agy_acp.mjs");
  writeFileSync(
    js,
    `
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const logFile = ${JSON.stringify(join(dir, "acp_calls.jsonl"))};
const brainRoot = ${JSON.stringify(join(fakeHome, ".gemini", "antigravity-cli", "brain"))};
const CID = ${JSON.stringify(CID)};
const SUB_CID = ${JSON.stringify(SUB_CID)};

if (args[0] === "acp" && args.includes("--help")) {
  console.log("Usage: agy acp [flags]\\n\\nStart the Agent Client Protocol (ACP) stdio server");
  process.exit(0);
}
if (args[0] === "models") {
  console.log("Fetching available models...\\ngemini-4-neon-high\\tGemini 4 Neon (High)\\ngemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)");
  process.exit(0);
}
if (args[0] !== "acp") {
  process.exit(2);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const update = (upd) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: CID, update: upd } });
const record = (ev) => appendFileSync(logFile, JSON.stringify(ev) + "\\n");

const availableModels = [
  { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
  { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
];

let pendingAskId = null;
let bgTimer = null;
let activeModel = "gemini-4-neon-high";

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  record({ method: msg.method, params: msg.params });

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Fake ACP", version: "1.5.14" } } });
    return;
  }
  if (msg.method === "session/new" || msg.method === "session/resume") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: CID,
        models: { availableModels, currentModelId: activeModel },
        configOptions: [
          { id: "model", currentValue: "gemini-4-neon" },
          { id: "thought_level", currentValue: "high" },
        ],
      },
    });
    return;
  }
  if (msg.method === "session/set_model") {
    const mid = msg.params?.modelId;
    if (!availableModels.some((m) => m.modelId === mid)) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown model ID: " + mid } });
      return;
    }
    activeModel = mid;
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/cancel") {
    record({ cancelled: true });
    if (bgTimer) clearTimeout(bgTimer);
    return;
  }
  if (msg.method === "session/prompt") {
    const text = msg.params?.prompt?.[0]?.text || "";

    // Scenario 1: Basic token streaming + thinking + tool
    if (text === "流式测试") {
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先检查文件。" } });
      update({ sessionUpdate: "tool_call", toolCallId: "call_read_1", name: "read_file", args: { Path: "/srv/app/index.ts" }, status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call_read_1", name: "read_file", args: { Path: "/srv/app/index.ts" }, status: "completed", rawOutput: { output: "console.log(1);" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好，" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "流式世界！" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 1200, cachedReadTokens: 800, outputTokens: 25 } } });
      return;
    }

    // Scenario 2: Background command + wakeup completion + mid-turn steering!
    if (text === "后台命令加追问") {
      const logsDir = join(brainRoot, CID, ".system_generated", "logs");
      mkdirSync(logsDir, { recursive: true });
      const now = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
      appendFileSync(
        join(logsDir, "transcript.jsonl"),
        JSON.stringify({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: now, content: "Created At: " + now + "\\nTool is running as a background task with task id: " + CID + "/task-2\\nTask Description: render video" }) + "\\n",
      );
      update({ sessionUpdate: "tool_call", toolCallId: "call_bg_2", name: "run_command", args: { CommandLine: "python render.py", WaitMsBeforeAsync: 500 }, status: "in_progress" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "渲染已在后台启动。" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 500, cachedReadTokens: 200, outputTokens: 12 } } });
      // Complete background command after 900ms and autonomously stream follow-up summary
      bgTimer = setTimeout(() => {
        const doneAt = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "tool_call_update", toolCallId: "call_bg_2", name: "run_command", args: { CommandLine: "python render.py" }, status: "completed", rawOutput: { output: "RENDER_OK" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: doneAt, content: "<SYSTEM_MESSAGE>\\n[Message] sender=" + CID + "/task-2 content=Task id \\"" + CID + "/task-2\\" finished with result:\\nCommand exited with code 0.\\n</SYSTEM_MESSAGE>" }) + "\\n",
        );
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "后台渲染全部完成。" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: doneAt, content: "后台渲染全部完成。" }) + "\\n",
        );
        update({ sessionUpdate: "usage_update", used: 1800, size: 1048576 });
      }, 900);
      return;
    }

    if (text === "顺便检查清晰度") {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "收到追问，已顺带核查清晰度为 4K。" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 300, cachedReadTokens: 100, outputTokens: 18 } } });
      return;
    }

    // Scenario 3: Interactive ask_question
    if (text === "发起交互提问") {
      pendingAskId = "call_ask_1";
      update({
        sessionUpdate: "tool_call",
        toolCallId: pendingAskId,
        name: "ask_question",
        args: { questions: [{ question: "选择部署环境", options: ["(Recommended) 预发环境", "生产环境"], is_multi_select: false }] },
        status: "in_progress",
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: pendingAskId,
        name: "ask_question",
        args: { questions: [{ question: "选择部署环境", options: ["(Recommended) 预发环境", "生产环境"], is_multi_select: false }] },
        status: "pending",
      });
      // CLI prints plain-text fallback which our runner must suppress!
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\\n选择部署环境\\n- [1] (Recommended) 预发环境\\n- [2] 生产环境\\n" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 400, outputTokens: 10 } } });
      return;
    }

    if (pendingAskId && text.includes("生产环境")) {
      update({ sessionUpdate: "tool_call_update", toolCallId: pendingAskId, name: "ask_question", status: "completed" });
      pendingAskId = null;
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已确认部署到生产环境。" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 450, outputTokens: 12 } } });
      return;
    }

    // Scenario 4: Subagent launch + child transcript nested tools
    if (text === "派子智能体") {
      const subLogsDir = join(brainRoot, SUB_CID, ".system_generated", "logs");
      const parentLogsDir = join(brainRoot, CID, ".system_generated", "logs");
      mkdirSync(subLogsDir, { recursive: true });
      mkdirSync(parentLogsDir, { recursive: true });
      const subLogPath = join(subLogsDir, "transcript.jsonl");
      const now = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
      update({ sessionUpdate: "tool_call", toolCallId: "call_sub_1", name: "invoke_subagent", args: { TypeName: "research", Role: "代码审计员", Prompt: "检查 API 安全" }, status: "in_progress" });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_sub_1",
        name: "invoke_subagent",
        args: { TypeName: "research", Role: "代码审计员", Prompt: "检查 API 安全" },
        status: "completed",
        rawOutput: { output: 'Created the following subagent:\\n{"conversationId":"' + SUB_CID + '","logAbsoluteUri":"file://' + subLogPath + '"}' },
      });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已派发子智能体。" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 300, outputTokens: 8 } } });

      setTimeout(() => {
        appendFileSync(
          subLogPath,
          JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: now, tool_calls: [{ name: "grep_search", args: { Query: '"auth_token"', SearchPath: '"server/"' } }] }) + "\\n" +
          JSON.stringify({ step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: now, content: "3 matches found" }) + "\\n",
        );
      }, 150);

      setTimeout(() => {
        const doneAt = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        appendFileSync(
          join(parentLogsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 10, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: doneAt, content: "<SYSTEM_MESSAGE>\\n[Message] sender=" + SUB_CID + " content=Subagent completed: 无高危漏洞\\n</SYSTEM_MESSAGE>" }) + "\\n",
        );
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "子智能体审计完毕：无高危漏洞。" } });
        appendFileSync(
          join(parentLogsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 11, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: doneAt, content: "子智能体审计完毕：无高危漏洞。" }) + "\\n",
        );
        update({ sessionUpdate: "usage_update", used: 900, size: 1048576 });
      }, 700);
      return;
    }

    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } } });
  }
});
`,
  );
  writeFileSync(fakeAgy, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`);
  chmodSync(fakeAgy, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

async function runAcpTask(
  taskId: string,
  payload: Record<string, unknown>,
  onMessage?: (msg: Record<string, unknown>, sendToClient: (m: Record<string, unknown>) => void) => void,
) {
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const received: Record<string, unknown>[] = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let resolveDone!: (m: Record<string, unknown>) => void;
  const finished = new Promise<Record<string, unknown>>((r) => (resolveDone = r));
  wss.on("connection", (ws) => {
    const sendToClient = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
    sendToClient({ type: "connected", device_name: "test" });
    sendToClient({ type: "task_dispatch", task: { id: taskId, action: "agent", timeout_seconds: 120, payload: { binary: "agy", cwd: dir, ...payload } } });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(msg);
      onMessage?.(msg, sendToClient);
      if (msg.type === "task_finished") resolveDone(msg);
    });
  });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  const client = new WsTaskClient({ serverUrl: `http://127.0.0.1:${port}`, token: "t", deviceId: "dev", deviceName: "test", platform: "test", extraWatchDirs: [] });
  try {
    void client.start();
    const done = await finished;
    const events = received.filter((m) => m.type === "agent_event").map((m) => m.event as Record<string, unknown>);
    const chunks = received.filter((m) => m.type === "task_chunk" && m.stream === "stdout").map((m) => String(m.text ?? ""));
    return { done, events, chunks, received };
  } finally {
    client.dispose();
    await new Promise((r) => wss.close(r));
    process.env.HOME = prevHome;
  }
}

it("helper unit checks: model resolution, ask_question parsing, subagent launch parsing", () => {
  const models = [
    { modelId: "claude-opus-5-5-high" },
    { modelId: "claude-opus-5-5-low" },
    { modelId: "gemini-3.8-flash-medium" },
  ];
  expect(resolveAcpModel("claude-opus-5-5", "low", models)).toEqual({ modelId: "claude-opus-5-5-low", applyEffortSeparately: false });
  expect(resolveAcpModel("claude-opus-5-5-high", "low", models)).toEqual({ modelId: "claude-opus-5-5-low", applyEffortSeparately: false });
  expect(resolveAcpModel("pro", "", models).invalidError).toContain("invalid model selection");

  const qs = parseAskQuestionArgs({
    questions: [{ question: "Q1", options: ["A", "B"], is_multi_select: false }],
  });
  expect(qs).toHaveLength(1);
  expect(formatAskQuestionAnswers(qs, ["B"])).toBe("B");

  expect(
    parseSubagentLaunch('{"conversationId":"11111111-2222-3333-4444-555555555555","logAbsoluteUri":"file:///tmp/sub.jsonl"}'),
  ).toEqual({ conversationId: "11111111-2222-3333-4444-555555555555", logPath: "/tmp/sub.jsonl" });
});

it.skipIf(process.platform === "win32")(
  "streams token-by-token text_delta, thinking, tool calls, usage, and session_id over agy acp",
  async () => {
    const { done, events, chunks } = await runAcpTask("acp-0001", { prompt: "流式测试", model: "claude-opus-5-5-high" });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    expect(chunks).toEqual(["你好，", "流式世界！"]);
    expect(String(done.stdout)).toBe("你好，流式世界！");
    expect(events).toContainEqual(expect.objectContaining({ kind: "thinking", text: "先检查文件。" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_read_1", name: "read_file", detail: "/srv/app/index.ts", status: "done", output: "console.log(1);" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "usage", input_tokens: 1200, cache_read_tokens: 800, output_tokens: 25, turns: 1 }));
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "marks backgrounded command with status=background, accepts mid-turn steering while waiting, and finishes after wakeup completion",
  async () => {
    let steered = false;
    const { done, events, chunks } = await runAcpTask("acp-0002", { prompt: "后台命令加追问" }, (msg, sendToClient) => {
      if (
        !steered &&
        msg.type === "agent_event" &&
        (msg.event as Record<string, unknown>)?.kind === "tool" &&
        (msg.event as Record<string, unknown>)?.status === "background"
      ) {
        steered = true;
        sendToClient({ type: "task_input", task_id: "acp-0002", input: "顺便检查清晰度" });
      }
    });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    expect(steered).toBe(true);
    // Background tool transitioned through "background" -> "done", with background snapshot emitted
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_bg_2", status: "background" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "background", tasks: [expect.objectContaining({ id: "task-2" })] }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_bg_2", status: "done", output: "RENDER_OK" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "steer", text: "顺便检查清晰度", status: "sent" }));
    const combined = chunks.join("");
    expect(combined).toContain("渲染已在后台启动。");
    expect(combined).toContain("收到追问，已顺带核查清晰度为 4K。");
    expect(combined).toContain("后台渲染全部完成。");
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "bridges ask_question to interactive question card, suppresses plain-text list fallback, and resumes on user answer",
  async () => {
    let answered = false;
    const { done, events, chunks } = await runAcpTask("acp-0003", { prompt: "发起交互提问" }, (msg, sendToClient) => {
      const ev = msg.event as Record<string, unknown> | undefined;
      if (!answered && msg.type === "agent_event" && ev?.kind === "question" && ev.status === "waiting") {
        answered = true;
        sendToClient({ type: "task_input", task_id: "acp-0003", input: "生产环境", question_id: ev.id });
      }
    });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    expect(answered).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ kind: "question", tool: "ask_question", question: "选择部署环境", status: "waiting" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "question", status: "answered", answer: "生产环境" }));
    const combined = chunks.join("");
    expect(combined).not.toContain("- [1]");
    expect(combined).toContain("已确认部署到生产环境。");
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "tracks invoke_subagent, streams nested child tool calls, and waits until subagent finishes and main agent summarizes",
  async () => {
    const { done, events, chunks } = await runAcpTask("acp-0004", { prompt: "派子智能体" });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    expect(events).toContainEqual(expect.objectContaining({ kind: "subagent", id: SUB_CID, name: "代码审计员", status: "running" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", name: "grep_search", detail: "auth_token  server/", subagent_id: SUB_CID, status: "done" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "subagent", id: SUB_CID, status: "done" }));
    expect(chunks.join("")).toContain("子智能体审计完毕：无高危漏洞。");
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "drops unknown tier model names (like 'pro') and retries cleanly with the default model over ACP",
  async () => {
    const { done } = await runAcpTask("acp-0005", { prompt: "流式测试", model: "pro" });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    expect(String(done.stderr)).toContain("agy 不认识模型 pro");
    const calls = readFileSync(join(dir, "acp_calls.jsonl"), "utf8");
    expect(calls).toContain("session/prompt");
  },
  30_000,
);
