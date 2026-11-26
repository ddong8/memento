// End-to-end tests for Memento's Antigravity ACP runner (`agy_acp.mjs` driving `agy acp --stdio`):
// token-by-token streaming, background task wakeup without head-of-line blocking, mid-turn steering,
// interactive ask_question dialog bridging, nested subagent transcript streaming, model fallback & cancel.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
  formatAskQuestionAnswers,
  isAsyncToolName,
  isCascadeIdle,
  isCascadeRunning,
  isFailedToolOutput,
  isTransientAgyError,
  parseAskQuestionArgs,
  parseSubagentLaunch,
  readAgyConversationState,
  resolveAcpModel,
} from "../src/agy-acp-runner/helpers.js";
import {
  antigravityDesktopStorePresent,
  bindAntigravitySessionProject,
  patchTrajectoryMetadataProjectId,
  resolveAntigravityDesktopProjectId,
  selectAntigravityAppDataDir,
  agyCliOpenBackgroundTasks,
} from "../src/antigravity.js";
import { sqliteRows, sqliteRun } from "../src/sqlite.js";

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
const appDataIdx = args.indexOf("--app-data-dir");
const appDataDir = appDataIdx >= 0 && args[appDataIdx + 1] ? args[appDataIdx + 1] : "antigravity-cli";
const activeHome = process.env.HOME || ${JSON.stringify(fakeHome)};
const cliDataDir = join(activeHome, ".gemini", appDataDir);
const brainRoot = join(cliDataDir, "brain");
const dbPath = join(cliDataDir, "conversation_summaries.db");
const CID = ${JSON.stringify(CID)};
const SUB_CID = ${JSON.stringify(SUB_CID)};

function setDbState(cid, status, notFullyIdle, stepCount = 1) {
  try {
    const sqlite = process.getBuiltinModule?.("node:sqlite");
    if (!sqlite) return;
    mkdirSync(cliDataDir, { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id text PRIMARY KEY, status text NOT NULL DEFAULT '', not_fully_idle numeric NOT NULL DEFAULT 0, step_count integer NOT NULL DEFAULT 0, killed numeric NOT NULL DEFAULT 0)");
      db.prepare("INSERT OR REPLACE INTO conversation_summaries (conversation_id, status, not_fully_idle, step_count, killed) VALUES (?, ?, ?, ?, 0)").run(cid, status, notFullyIdle ? 1 : 0, stepCount);
    } finally {
      db.close();
    }
  } catch {
    // ignore in runtimes without node:sqlite
  }
}

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
    record({ initAppDataDir: appDataDir, argv: args });
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Fake ACP", version: "1.5.14" } } });
    return;
  }
  if (msg.method === "session/new" || msg.method === "session/resume") {
    const activeSid = msg.method === "session/resume" && msg.params?.sessionId ? msg.params.sessionId : CID;
    if (msg.method === "session/new" && appDataDir === "antigravity") {
      try {
        const sqlite = process.getBuiltinModule?.("node:sqlite");
        if (sqlite) {
          mkdirSync(join(cliDataDir, "conversations"), { recursive: true });
          const sdb = new sqlite.DatabaseSync(dbPath);
          try {
            sdb.exec("CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id text PRIMARY KEY, title text DEFAULT '', project_id text DEFAULT '', status text NOT NULL DEFAULT '', not_fully_idle numeric NOT NULL DEFAULT 0, step_count integer NOT NULL DEFAULT 0, killed numeric NOT NULL DEFAULT 0, workspace_uris text DEFAULT '[]', last_modified_time text DEFAULT '')");
            sdb.prepare("INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, project_id, status, not_fully_idle, step_count, killed, workspace_uris, last_modified_time) VALUES (?, '', 'default-cli-project', 'CASCADE_RUN_STATUS_IDLE', 0, 1, 0, '[]', '2026-11-26 05:00:00+00:00')").run(activeSid);
          } finally {
            sdb.close();
          }
          const cdb = new sqlite.DatabaseSync(join(cliDataDir, "conversations", activeSid + ".db"));
          try {
            cdb.exec("CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id integer PRIMARY KEY, data blob)");
            const blob = Buffer.concat([Buffer.from("header"), Buffer.from([0x92, 0x01, 0x13]), Buffer.from("default-cli-project", "utf8"), Buffer.from([0xc8, 0x01, 0x01])]);
            cdb.prepare("INSERT OR REPLACE INTO trajectory_metadata_blob (id, data) VALUES (1, ?)").run(blob);
          } finally {
            cdb.close();
          }
        }
      } catch {
        // ignore
      }
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: activeSid,
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

    // Scenario 5: Slow thinking (>7s) & multi-step pauses (>3s) after background task fails with exit code 1 (repro 79bd668f!)
    if (text === "慢思考多步唤醒") {
      const logsDir = join(brainRoot, CID, ".system_generated", "logs");
      mkdirSync(logsDir, { recursive: true });
      const t0 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
      setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 20);
      update({ sessionUpdate: "tool_call", toolCallId: "call_deploy_1174", name: "run_command", args: { CommandLine: "kubectl rollout status deploy/filmkit", WaitMsBeforeAsync: 500 }, status: "in_progress" });
      appendFileSync(
        join(logsDir, "transcript.jsonl"),
        JSON.stringify({ step_index: 20, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: t0, content: "Created At: " + t0 + "\\nTool is running as a background task with task id: " + CID + "/task-1174\\nTask Description: kubectl rollout status deploy/filmkit" }) + "\\n",
      );
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正在导入镜像并等待新 Pod 就绪。" } });
      appendFileSync(
        join(logsDir, "transcript.jsonl"),
        JSON.stringify({ step_index: 21, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t0, content: "正在导入镜像并等待新 Pod 就绪。" }) + "\\n",
      );
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 800, outputTokens: 20 } } });
      setDbState(CID, "CASCADE_RUN_STATUS_IDLE", true, 21);

      // Background deploy exits with code 1 at +500ms, engine flips to RUNNING immediately
      setTimeout(() => {
        const t1 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "tool_call_update", toolCallId: "call_deploy_1174", name: "run_command", args: { CommandLine: "kubectl rollout status deploy/filmkit" }, status: "completed", rawOutput: { output: "Command exited with code 1.\\n\\nerror: deployment exceeded its progress deadline" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 22, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: t1, content: "<SYSTEM_MESSAGE>\\n[Message] sender=" + CID + "/task-1174 content=Task id \\"" + CID + "/task-1174\\" finished with result:\\nCommand exited with code 1.\\n</SYSTEM_MESSAGE>" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 22);
      }, 500);

      // 6.8s silent TTFT (old 6.0s timer killed EVERY real wakeup here!)
      setTimeout(() => {
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "部署超时了，先查 Pod 原因。" } });
      }, 7300);

      // +3.0s gap after thought chunk (old 2.5s timer killed multi-step wakeups here!) -> usage_update + follow-up tool
      setTimeout(() => {
        const t2 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "usage_update", used: 2200, size: 1048576 });
        update({ sessionUpdate: "tool_call", toolCallId: "call_pods_23", name: "run_command", args: { CommandLine: "kubectl get pods -n memento" }, status: "in_progress" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "call_pods_23", name: "run_command", args: { CommandLine: "kubectl get pods -n memento" }, status: "completed", rawOutput: { output: "Command exited with code 0.\\nfilmkit-new 1/1 Running" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 23, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t2, tool_calls: [{ name: "run_command", args: { CommandLine: '"kubectl get pods -n memento"' } }] }) + "\\n" +
          JSON.stringify({ step_index: 24, source: "MODEL", type: "GENERIC", status: "DONE", created_at: t2, content: "Command exited with code 0.\\nfilmkit-new 1/1 Running" }) + "\\n",
        );
      }, 10300);

      // +3.0s pause thinking about tool output -> final answer + IDLE|0
      setTimeout(() => {
        const t3 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已定位部署超时原因并核验新 Pod 1/1 Running。" } });
        update({ sessionUpdate: "usage_update", used: 2400, size: 1048576 });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 25, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t3, content: "已定位部署超时原因并核验新 Pod 1/1 Running。" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_IDLE", false, 26);
      }, 13300);
      return;
    }

    // Scenario 6: Chained two-wave background tasks launched during wakeup
    if (text === "两波接力后台任务") {
      const logsDir = join(brainRoot, CID, ".system_generated", "logs");
      mkdirSync(logsDir, { recursive: true });
      const t0 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
      setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 30);
      update({ sessionUpdate: "tool_call", toolCallId: "call_wave1", name: "run_command", args: { CommandLine: "gh run watch 1" }, status: "in_progress" });
      appendFileSync(
        join(logsDir, "transcript.jsonl"),
        JSON.stringify({ step_index: 30, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: t0, content: "Created At: " + t0 + "\\nTool is running as a background task with task id: " + CID + "/task-30\\nTask Description: gh run watch 1" }) + "\\n",
      );
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一波构建已启动。" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 300, outputTokens: 10 } } });
      setDbState(CID, "CASCADE_RUN_STATUS_IDLE", true, 31);

      // Wave 1 finishes at +500ms -> woken agent immediately launches Wave 2 (run_workflow) in background!
      setTimeout(() => {
        const t1 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "tool_call_update", toolCallId: "call_wave1", name: "run_command", args: { CommandLine: "gh run watch 1" }, status: "completed", rawOutput: { output: "Command exited with code 0.\\nIMAGE_BUILT" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 32, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: t1, content: "<SYSTEM_MESSAGE>\\n[Message] sender=" + CID + "/task-30 content=Task id \\"" + CID + "/task-30\\" finished with result:\\nCommand exited with code 0.\\n</SYSTEM_MESSAGE>" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 32);
      }, 500);

      setTimeout(() => {
        const t2 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "tool_call", toolCallId: "call_wave2", name: "run_workflow", args: { Description: "滚动部署验收" }, status: "in_progress" });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 33, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t2, tool_calls: [{ name: "run_workflow", args: { Description: '"滚动部署验收"' } }] }) + "\\n" +
          JSON.stringify({ step_index: 34, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: t2, content: "Created At: " + t2 + "\\nTool is running as a background task with task id: " + CID + "/task-34\\nTask Description: 滚动部署验收" }) + "\\n",
        );
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一波完成，已启动第二波部署。" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 35, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t2, content: "第一波完成，已启动第二波部署。" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_IDLE", true, 35);
      }, 1200);

      // Wave 2 finishes at +2400ms -> woken agent emits final summary
      setTimeout(() => {
        const t3 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "tool_call_update", toolCallId: "call_wave2", name: "run_workflow", args: { Description: "滚动部署验收" }, status: "completed", rawOutput: { output: "Command exited with code 0.\\nDEPLOY_VERIFIED" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 36, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: t3, content: "<SYSTEM_MESSAGE>\\n[Message] sender=" + CID + "/task-34 content=Task id \\"" + CID + "/task-34\\" finished with result:\\nCommand exited with code 0.\\n</SYSTEM_MESSAGE>" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 36);
      }, 2400);

      setTimeout(() => {
        const t4 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "两波后台任务全部完成。" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 37, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t4, content: "两波后台任务全部完成。" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_IDLE", false, 38);
      }, 3000);
      return;
    }

    // Scenario 7: Async tool returning status=completed immediately with background task id + silent keepalive
    if (text === "定时复查保活") {
      const logsDir = join(brainRoot, CID, ".system_generated", "logs");
      mkdirSync(logsDir, { recursive: true });
      const t0 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
      setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 40);
      update({ sessionUpdate: "tool_call", toolCallId: "call_sched_40", name: "schedule", args: { DurationSeconds: 2, Prompt: "复查结果" }, status: "in_progress" });
      // Edge case: tool_call_update reports "completed" immediately upon returning a background task ID!
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_sched_40",
        name: "schedule",
        args: { DurationSeconds: 2, Prompt: "复查结果" },
        status: "completed",
        rawOutput: { output: "Created At: " + t0 + "\\nTool is running as a background task with task id: " + CID + "/task-40\\nTask Description: Timer (2s)" },
      });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已设 2 秒定时复查。" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 200, outputTokens: 8 } } });
      setDbState(CID, "CASCADE_RUN_STATUS_IDLE", true, 41);

      setTimeout(() => {
        const t1 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 42, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: t1, content: "<SYSTEM_MESSAGE>\\n[Message] sender=" + CID + "/task-40 content=Task id \\"" + CID + "/task-40\\" finished with result:\\nTimer fired\\n</SYSTEM_MESSAGE>" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 42);
      }, 1100);

      setTimeout(() => {
        const t2 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "定时复查已完成。" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 43, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t2, content: "定时复查已完成。" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_IDLE", false, 44);
      }, 1500);
      return;
    }

    // Scenario 8: Transcript registers subagent before invoke_subagent tool_call_update arrives with Role
    if (text === "子智能体名称补全") {
      const subCid2 = "c3d4e5f6-3333-4444-8555-666677778888";
      const parentLogsDir = join(brainRoot, CID, ".system_generated", "logs");
      mkdirSync(parentLogsDir, { recursive: true });
      const t0 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
      setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 50);
      // Parent transcript gets conversationId BEFORE handleToolUpdate completes
      appendFileSync(
        join(parentLogsDir, "transcript.jsonl"),
        JSON.stringify({ step_index: 50, source: "MODEL", type: "GENERIC", status: "DONE", created_at: t0, content: 'Created the following subagent:\\n{"conversationId":"' + subCid2 + '"}' }) + "\\n",
      );
      setTimeout(() => {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_sub_enrich",
          name: "invoke_subagent",
          args: { TypeName: "research", Role: "架构复核员", Prompt: "复核设计" },
          status: "completed",
          rawOutput: { output: 'Created the following subagent:\\n{"conversationId":"' + subCid2 + '"}' },
        });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已派发架构复核员。" } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 200, outputTokens: 8 } } });
        setDbState(CID, "CASCADE_RUN_STATUS_IDLE", true, 51);
      }, 450);

      setTimeout(() => {
        const t1 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        appendFileSync(
          join(parentLogsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 52, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: t1, content: "<SYSTEM_MESSAGE>\\n[Message] sender=" + subCid2 + " content=Subagent completed: 复核通过\\n</SYSTEM_MESSAGE>" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 52);
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "架构复核通过。" } });
        appendFileSync(
          join(parentLogsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 53, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t1, content: "架构复核通过。" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_IDLE", false, 54);
      }, 1000);
      return;
    }

    // Scenario 9: Cancelled background task with IDLE DB finishes swiftly (~2s instead of 15s stall)
    if (text === "取消后台快速收尾") {
      const logsDir = join(brainRoot, CID, ".system_generated", "logs");
      mkdirSync(logsDir, { recursive: true });
      const t0 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
      setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 60);
      update({ sessionUpdate: "tool_call", toolCallId: "call_cancel_60", name: "schedule", args: { DurationSeconds: 60, Prompt: "定期巡检" }, status: "in_progress" });
      appendFileSync(
        join(logsDir, "transcript.jsonl"),
        JSON.stringify({ step_index: 60, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: t0, content: "Created At: " + t0 + "\\nTool is running as a background task with task id: " + CID + "/task-60\\nTask Description: Timer (60s)" }) + "\\n",
      );
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "定时器已创建。" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 6 } } });
      setDbState(CID, "CASCADE_RUN_STATUS_IDLE", true, 61);

      setTimeout(() => {
        const t1 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 62, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: t1, content: "<SYSTEM_MESSAGE>\\n[Message] sender=" + CID + "/task-60 content=Task id \\"" + CID + "/task-60\\" finished with result:\\nTimer cancelled\\n</SYSTEM_MESSAGE>" }) + "\\n",
        );
        // Cascade goes straight to IDLE/0 with no wakeup reply
        setDbState(CID, "CASCADE_RUN_STATUS_IDLE", false, 62);
      }, 300);
      return;
    }

    // Scenario 10: Wakeup final PLANNER_RESPONSE + IDLE/0 exits swiftly without the old 1.2s+ artificial stall
    if (text === "唤醒完成即时收尾") {
      const logsDir = join(brainRoot, CID, ".system_generated", "logs");
      mkdirSync(logsDir, { recursive: true });
      const t0 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
      setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 70);
      update({ sessionUpdate: "tool_call", toolCallId: "call_fast_70", name: "run_command", args: { CommandLine: "echo fast" }, status: "in_progress" });
      appendFileSync(
        join(logsDir, "transcript.jsonl"),
        JSON.stringify({ step_index: 70, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: t0, content: "Created At: " + t0 + "\\nTool is running as a background task with task id: " + CID + "/task-70\\nTask Description: echo fast" }) + "\\n",
      );
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "后台命令已发。" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 6 } } });
      setDbState(CID, "CASCADE_RUN_STATUS_IDLE", true, 71);

      setTimeout(() => {
        const t1 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "tool_call_update", toolCallId: "call_fast_70", name: "run_command", args: { CommandLine: "echo fast" }, status: "completed", rawOutput: { output: "Command exited with code 0.\\nfast" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 72, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: t1, content: "<SYSTEM_MESSAGE>\\n[Message] sender=" + CID + "/task-70 content=Task id \\"" + CID + "/task-70\\" finished with result:\\nCommand exited with code 0.\\n</SYSTEM_MESSAGE>" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_RUNNING", true, 72);
      }, 300);

      setTimeout(() => {
        const t2 = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "即时收尾完毕。" } });
        appendFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ step_index: 73, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t2, content: "即时收尾完毕。" }) + "\\n",
        );
        setDbState(CID, "CASCADE_RUN_STATUS_IDLE", false, 74);
      }, 600);
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
  customHome?: string,
) {
  const prevHome = process.env.HOME;
  const prevAcpRunner = process.env.MEMENTO_AGY_ACP_RUNNER;
  process.env.HOME = customHome ?? fakeHome;
  delete process.env.MEMENTO_AGY_ACP_RUNNER;
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
    if (prevAcpRunner === undefined) delete process.env.MEMENTO_AGY_ACP_RUNNER;
    else process.env.MEMENTO_AGY_ACP_RUNNER = prevAcpRunner;
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

  expect(isAsyncToolName("run_command")).toBe(true);
  expect(isAsyncToolName("schedule")).toBe(true);
  expect(isAsyncToolName("run_workflow")).toBe(true);
  expect(isAsyncToolName("read_file")).toBe(false);
  expect(isFailedToolOutput("Command exited with code 1.\nerror: exceeded deadline")).toBe(true);
  expect(isFailedToolOutput("Command exited with code 0.\nOK")).toBe(false);
  expect(isTransientAgyError("503 No capacity available (attempt 2)")).toBe(true);
  expect(isTransientAgyError("invalid argument")).toBe(false);

  const testDb = join(dir, "helper_summaries.db");
  expect(
    sqliteRun(
      testDb,
      "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, status text, not_fully_idle numeric, step_count integer, killed numeric)",
    ),
  ).toBe(true);
  expect(
    sqliteRun(
      testDb,
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)",
      ["cid-run", "CASCADE_RUN_STATUS_RUNNING", 1, 12, 0],
    ),
  ).toBe(true);
  expect(
    sqliteRun(
      testDb,
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)",
      ["cid-idle", "CASCADE_RUN_STATUS_IDLE", 0, 14, 0],
    ),
  ).toBe(true);
  const runState = readAgyConversationState(testDb, "cid-run");
  expect(runState).toEqual({ status: "CASCADE_RUN_STATUS_RUNNING", notFullyIdle: true, stepCount: 12, killed: false });
  expect(isCascadeRunning(runState)).toBe(true);
  expect(isCascadeIdle(runState)).toBe(false);
  const idleState = readAgyConversationState(testDb, "cid-idle");
  expect(idleState).toEqual({ status: "CASCADE_RUN_STATUS_IDLE", notFullyIdle: false, stepCount: 14, killed: false });
  expect(isCascadeRunning(idleState)).toBe(false);
  expect(isCascadeIdle(idleState)).toBe(true);
  expect(readAgyConversationState(testDb, "missing")).toBeNull();
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

it.skipIf(process.platform === "win32")(
  "tracks slow-thinking (>6s) and multi-step (>2.5s gaps) autonomous wakeups to completion without exiting early",
  async () => {
    const { done, events, chunks } = await runAcpTask("acp-0006", { prompt: "慢思考多步唤醒" });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    // Non-zero exit code background command must be marked failed (not done)
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_deploy_1174", status: "failed" }));
    // Follow-up diagnostic tool ran AFTER >6.8s TTFT + >3s pause without being killed
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_pods_23", status: "done" }));
    const combined = chunks.join("");
    expect(combined).toContain("正在导入镜像并等待新 Pod 就绪。");
    expect(combined).toContain("已定位部署超时原因并核验新 Pod 1/1 Running。");
    expect(String(done.stdout)).toContain("已定位部署超时原因并核验新 Pod 1/1 Running。");
  },
  35_000,
);

it.skipIf(process.platform === "win32")(
  "tracks chained multi-wave background tasks launched during an autonomous wakeup turn",
  async () => {
    const { done, events, chunks } = await runAcpTask("acp-0007", { prompt: "两波接力后台任务" });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_wave1", status: "background" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_wave1", status: "done" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_wave2", status: "background" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_wave2", status: "done" }));
    const combined = chunks.join("");
    expect(combined).toContain("第一波构建已启动。");
    expect(combined).toContain("第一波完成，已启动第二波部署。");
    expect(combined).toContain("两波后台任务全部完成。");
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "keeps async-launch completed schedule timers alive until Timer fired and swallows keepalive events silently",
  async () => {
    const prevKeepalive = process.env.MEMENTO_AGY_KEEPALIVE_MS;
    process.env.MEMENTO_AGY_KEEPALIVE_MS = "400";
    try {
      const { done, events, chunks } = await runAcpTask("acp-0008", { prompt: "定时复查保活" });
      expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
      expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_sched_40", status: "background" }));
      expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "call_sched_40", status: "done" }));
      expect(events.some((e) => e.kind === "keepalive")).toBe(false);
      const combined = chunks.join("");
      expect(combined).toContain("已设 2 秒定时复查。");
      expect(combined).toContain("定时复查已完成。");
    } finally {
      if (prevKeepalive === undefined) delete process.env.MEMENTO_AGY_KEEPALIVE_MS;
      else process.env.MEMENTO_AGY_KEEPALIVE_MS = prevKeepalive;
    }
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "enriches subagent name from invoke_subagent Role even when transcript registers conversationId first",
  async () => {
    const { done, events, chunks } = await runAcpTask("acp-0009", { prompt: "子智能体名称补全" });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "subagent", id: "c3d4e5f6-3333-4444-8555-666677778888", name: "架构复核员", status: "running" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "subagent", id: "c3d4e5f6-3333-4444-8555-666677778888", status: "done" }),
    );
    expect(chunks.join("")).toContain("架构复核通过。");
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "exits swiftly on cancelled background tasks (~2s) and confirmed idle wakeups (<1s) without stale stalls",
  async () => {
    const tCancelStart = Date.now();
    const cancelRes = await runAcpTask("acp-0010", { prompt: "取消后台快速收尾" });
    const cancelElapsed = Date.now() - tCancelStart;
    expect(cancelRes.done, `${cancelRes.done.error}\n${cancelRes.done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    // Previously stalled for NO_WAKEUP_IDLE_MS=15_000ms; now settles in ~2.3s
    expect(cancelElapsed).toBeLessThan(6_000);

    let finalChunkAt = 0;
    const fastRes = await runAcpTask("acp-0011", { prompt: "唤醒完成即时收尾" }, (msg) => {
      if (msg.type === "task_chunk" && String(msg.text ?? "").includes("即时收尾完毕。")) {
        finalChunkAt = Date.now();
      }
    });
    const tailLatency = Date.now() - finalChunkAt;
    expect(fastRes.done, `${fastRes.done.error}\n${fastRes.done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    expect(finalChunkAt).toBeGreaterThan(0);
    expect(fastRes.chunks.join("")).toContain("即时收尾完毕。");
    // Previously waited 800ms + 2*400ms poll + 250ms shutdown (~1.2s-1.9s); now finishes well under 1s
    expect(tailLatency).toBeLessThan(950);
  },
  30_000,
);

it("selectAntigravityAppDataDir, Desktop project resolution, and protobuf project_id patching", () => {
  const syncHome = join(dir, "sync-unit-home");
  // Only bin/ exists (created by Memento wrapper): NOT a Desktop app store
  mkdirSync(join(syncHome, ".gemini", "antigravity", "bin"), { recursive: true });
  expect(antigravityDesktopStorePresent(syncHome)).toBe(false);
  expect(selectAntigravityAppDataDir(undefined, syncHome)).toBe("antigravity-cli");

  // Once Desktop store exists (conversation_summaries.db or conversations/), new sessions target "antigravity"
  const desktopSid = "4ff9e5c4-d996-4f5e-b804-ea6c72eea91d";
  const cliSid = "8bea4d8c-5bb2-4a49-ad65-c3a4d13ebabf";
  mkdirSync(join(syncHome, ".gemini", "antigravity", "conversations"), { recursive: true });
  writeFileSync(join(syncHome, ".gemini", "antigravity", "conversations", `${desktopSid}.db`), "sqlite");
  mkdirSync(join(syncHome, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
  writeFileSync(join(syncHome, ".gemini", "antigravity-cli", "conversations", `${cliSid}.db`), "sqlite");

  expect(antigravityDesktopStorePresent(syncHome)).toBe(true);
  expect(selectAntigravityAppDataDir(desktopSid, syncHome)).toBe("antigravity");
  expect(selectAntigravityAppDataDir(cliSid, syncHome)).toBe("antigravity-cli");
  expect(selectAntigravityAppDataDir(undefined, syncHome)).toBe("antigravity");
  expect(selectAntigravityAppDataDir("99999999-0000-4000-8000-000000000000", syncHome)).toBe("antigravity");

  // Project resolution from ~/.gemini/config/projects/*.json
  const projDir = join(dir, "demo-workspace");
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(syncHome, ".gemini", "config", "projects"), { recursive: true });
  const projId = "b5cec0a5-c6ba-4b3f-b667-6125d4f651ef";
  writeFileSync(
    join(syncHome, ".gemini", "config", "projects", `${projId}.json`),
    JSON.stringify({
      id: projId,
      name: "demo-workspace",
      projectResources: { resources: [{ gitFolder: { folderUri: `file://${projDir}` } }] },
    }),
  );
  expect(resolveAntigravityDesktopProjectId(projDir, syncHome)).toBe(projId);
  expect(resolveAntigravityDesktopProjectId(syncHome, syncHome)).toBeUndefined();

  // Protobuf project_id patching replaces default-cli-project accurately
  const rawBlob = Buffer.concat([
    Buffer.from("prefix"),
    Buffer.from([0x92, 0x01, 0x13]),
    Buffer.from("default-cli-project", "utf8"),
    Buffer.from([0xc8, 0x01, 0x01]),
  ]);
  const patched = patchTrajectoryMetadataProjectId(rawBlob, projId);
  expect(patched).not.toBeNull();
  expect(patched!.includes(Buffer.from(projId, "utf8"))).toBe(true);
  expect(patched!.includes(Buffer.from("default-cli-project", "utf8"))).toBe(false);
  expect(patchTrajectoryMetadataProjectId(patched!, "other-project-id")).toBeNull();

  // agyCliOpenBackgroundTasks reads Desktop store transcripts when appDataDir="antigravity"
  const deskLogs = join(syncHome, ".gemini", "antigravity", "brain", desktopSid, ".system_generated", "logs");
  mkdirSync(deskLogs, { recursive: true });
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  writeFileSync(
    join(deskLogs, "transcript.jsonl"),
    JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "GENERIC",
      status: "RUNNING",
      created_at: now,
      content: `Created At: ${now}\nTool is running as a background task with task id: ${desktopSid}/task-1`,
    }) + "\n",
  );
  expect(agyCliOpenBackgroundTasks(desktopSid, Date.now() - 5000, syncHome, "antigravity")).toEqual([`${desktopSid}/task-1`]);
});

it.skipIf(process.platform === "win32")(
  "resumes Antigravity Desktop sessions in-place via --app-data-dir antigravity (no forking), preserves CLI sessions, and binds new Desktop sessions to the matching project",
  async () => {
    // Reuse fakeHome (captured by executionEnvironment() cache) as the Desktop+CLI home for this final test
    const syncHome = fakeHome;
    const workRepo = join(dir, "memento-ws");
    const desktopSid = "acb4c02e-913a-4f95-bac8-4f7d586f4584";
    const cliSid = "8bea4d8c-5bb2-4a49-ad65-c3a4d13ebabf";
    const projId = "b5cec0a5-c6ba-4b3f-b667-6125d4f651ef";
    mkdirSync(workRepo, { recursive: true });
    mkdirSync(join(syncHome, ".gemini", "antigravity", "conversations"), { recursive: true });
    mkdirSync(join(syncHome, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
    mkdirSync(join(syncHome, ".gemini", "config", "projects"), { recursive: true });
    writeFileSync(join(syncHome, ".gemini", "antigravity", "conversations", `${desktopSid}.db`), "sqlite");
    writeFileSync(join(syncHome, ".gemini", "antigravity-cli", "conversations", `${cliSid}.db`), "sqlite");
    writeFileSync(
      join(syncHome, ".gemini", "config", "projects", `${projId}.json`),
      JSON.stringify({
        id: projId,
        name: "memento-ws",
        projectResources: { resources: [{ gitFolder: { folderUri: `file://${workRepo}` } }] },
      }),
    );

    const logPath = join(dir, "acp_calls.jsonl");
    const beforeLines = readFileSync(logPath, "utf8").trim().split("\n").length;

    // 1) Resuming a Desktop session must use --app-data-dir antigravity and resume the EXACT desktopSid with NO fork notice
    const deskRes = await runAcpTask("acp-sync-desktop", { prompt: "流式测试", cwd: workRepo, session_id: desktopSid });
    expect(deskRes.done, `${deskRes.done.error}\n${deskRes.done.stderr}`).toMatchObject({ status: "succeeded", session_id: desktopSid });
    expect(String(deskRes.done.stderr ?? "")).not.toContain("会话接续");

    const afterDesk = readFileSync(logPath, "utf8").trim().split("\n").slice(beforeLines).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(afterDesk).toContainEqual(expect.objectContaining({ initAppDataDir: "antigravity" }));
    expect(afterDesk).toContainEqual(expect.objectContaining({ method: "session/resume", params: expect.objectContaining({ sessionId: desktopSid }) }));

    // 2) Resuming an existing CLI session must stay on antigravity-cli
    const beforeCli = readFileSync(logPath, "utf8").trim().split("\n").length;
    const cliRes = await runAcpTask("acp-sync-cli", { prompt: "流式测试", cwd: workRepo, session_id: cliSid });
    expect(cliRes.done, `${cliRes.done.error}\n${cliRes.done.stderr}`).toMatchObject({ status: "succeeded", session_id: cliSid });
    const afterCli = readFileSync(logPath, "utf8").trim().split("\n").slice(beforeCli).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(afterCli).toContainEqual(expect.objectContaining({ initAppDataDir: "antigravity-cli" }));
    expect(afterCli).toContainEqual(expect.objectContaining({ method: "session/resume", params: expect.objectContaining({ sessionId: cliSid }) }));

    // 3) Starting a brand-new session on a Desktop machine targets --app-data-dir antigravity and binds project_id
    const beforeNew = readFileSync(logPath, "utf8").trim().split("\n").length;
    const newRes = await runAcpTask("acp-sync-new", { prompt: "流式测试", cwd: workRepo });
    expect(newRes.done, `${newRes.done.error}\n${newRes.done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    const afterNew = readFileSync(logPath, "utf8").trim().split("\n").slice(beforeNew).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(afterNew).toContainEqual(expect.objectContaining({ initAppDataDir: "antigravity" }));
    expect(afterNew).toContainEqual(expect.objectContaining({ method: "session/new" }));

    const boundRows = sqliteRows(
      join(syncHome, ".gemini", "antigravity", "conversation_summaries.db"),
      "SELECT project_id FROM conversation_summaries WHERE conversation_id = ?",
      [CID],
    );
    expect(boundRows?.[0]?.[0]).toBe(projId);
    // Calling bindAntigravitySessionProject again must NOT clobber the already-bound real project
    expect(bindAntigravitySessionProject(CID, "other-project", "antigravity", syncHome)).toBe(false);
  },
  30_000,
);
