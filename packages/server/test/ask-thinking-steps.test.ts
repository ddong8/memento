// Regression tests ensuring thinking blocks and structured tool steps survive live SSE streaming,
// persistence (ask_conversations.turns), session-timeline sync, and legacy turn normalization.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";

import type { Deps } from "../src/context";

import { askConversations, machines } from "../src/db/pulled/schema";
import {
  buildToolCallFromDeviceTask,
  extractThinkingFromEvents,
  getOrCreateConversation,
  sanitizeTurnsForResponse,
} from "../src/services/ask-store";
import { directAgentStream } from "../src/services/ask-stream";
import { mergeSession, messagesToTurns } from "../src/services/session-timeline";
import { wsManager } from "../src/services/ws-manager";
import { addUser, setupApp, TEST_DB } from "./helpers";

describe("Ask thinking & steps preservation", () => {
  it("extracts thinking from structured task events cleanly", () => {
    const events = [
      { kind: "session", session_id: "sess-1" },
      { kind: "thinking", text: "First step of reasoning.\n\n" },
      { kind: "tool", id: "t1", name: "Bash", detail: "git status", status: "done" },
      { kind: "thinking", text: "Second step of reasoning.\n\n" },
    ];
    expect(extractThinkingFromEvents(events)).toBe("First step of reasoning.\n\nSecond step of reasoning.");
  });

  it("normalizes legacy steps-only turns into ExecutionCard toolCalls on read", () => {
    const turns = sanitizeTurnsForResponse([
      { role: "user", content: "帮我检查" },
      {
        role: "assistant",
        content: "已检查完成",
        steps: [
          { type: "tool_call", name: "Bash", detail: "ls -la", output: "total 8" },
          { type: "tool_call", name: "Read", detail: "package.json", output: "{}" },
        ],
      },
    ]);
    expect(turns).toHaveLength(2);
    const asst = turns[1]!;
    expect(Array.isArray(asst.toolCalls)).toBe(true);
    expect(asst.toolCalls).toHaveLength(1);
    const tc = asst.toolCalls![0] as { name: string; result?: { events?: Array<{ kind: string; name: string; detail?: string }> } };
    expect(tc.name).toBe("run_on_device");
    expect(tc.result?.events).toHaveLength(2);
    expect(tc.result?.events?.[0]).toMatchObject({ kind: "tool", name: "Bash", detail: "ls -la" });
  });

  it("builds full toolCalls + thinking from a device_tasks row with events", () => {
    const fakeTask = {
      id: "4e9368e5-6a93-4f84-9f04-84af281e43f6",
      deviceId: "dev-hash-1",
      machineId: null,
      userId: null,
      action: "agent",
      payload: { binary: "antigravity", prompt: "全部做完", cwd: "/Users/test/memento", images: ["data:image/png;base64,abc"] },
      status: "succeeded",
      exitCode: 0,
      stdout: "已全部完成",
      stderr: "",
      error: null,
      timeoutSeconds: 7200,
      createdAt: "2026-11-27T11:00:00Z",
      dispatchedAt: "2026-11-27T11:00:01Z",
      finishedAt: "2026-11-27T11:05:00Z",
      alerts: [],
      events: [
        { kind: "thinking", text: "分析构建步骤...\n\n" },
        { kind: "tool", id: "c1", name: "run_command", detail: "npm test", status: "done" },
      ],
      sessionId: "4b28af2c-45a6-4fa8-9090-211978f7a47c",
    } as Parameters<typeof buildToolCallFromDeviceTask>[0];

    const { toolCall, thinking } = buildToolCallFromDeviceTask(fakeTask, "Mac mini");
    expect(thinking).toBe("分析构建步骤...");
    expect(toolCall.name).toBe("run_on_device");
    expect(toolCall.device_name).toBe("Mac mini");
    expect((toolCall.args as Record<string, unknown>).images).toBeUndefined();
    const res = toolCall.result as { events?: unknown[]; status?: string };
    expect(res.status).toBe("succeeded");
    expect(res.events).toHaveLength(2);
  });

  it("upgrades legacy steps-only turns during session-timeline merge and preserves metadata.thinking", () => {
    const incoming = messagesToTurns(
      [
        { lineNumber: 10, role: "user", messageType: "USER_INPUT", content: "检查发布", metadata: {}, timestamp: "2026-11-27T10:00:00Z" },
        {
          lineNumber: 11,
          role: "tool",
          messageType: "tool_call",
          content: "[run_command]",
          metadata: { tool_name: "run_command", tool_input: { CommandLine: "gh run list" } },
          timestamp: "2026-11-27T10:00:02Z",
        },
        {
          lineNumber: 12,
          role: "tool",
          messageType: "tool_output",
          content: "Command exited with code 0.\n\nCommand output:\nok",
          metadata: {},
          timestamp: "2026-11-27T10:00:05Z",
        },
        {
          lineNumber: 13,
          role: "assistant",
          messageType: "PLANNER_RESPONSE",
          content: "发布已通过",
          metadata: { thinking: "先检查 CI 流水线状态" },
          timestamp: "2026-11-27T10:00:08Z",
        },
      ],
      "antigravity",
    );
    expect(incoming).toHaveLength(2);
    expect(incoming[1]!.thinking).toBe("先检查 CI 流水线状态");
    expect(incoming[1]!.toolCalls).toHaveLength(1);
    const tc0 = incoming[1]!.toolCalls![0] as { binary?: string; result?: { events?: Array<{ name: string; detail?: string; output?: string }> } };
    expect(tc0.binary).toBe("agy");
    expect(tc0.result?.events?.[0]).toMatchObject({ name: "run_command", detail: "gh run list", output: "ok" });

    // Existing turn produced by earlier TS version with legacy `steps` and missing `thinking`
    const existing = [
      { role: "user", content: "检查发布", created_at: "2026-11-27T10:00:00Z", line_number: 10 },
      {
        role: "assistant",
        content: "发布已通过",
        created_at: "2026-11-27T10:00:08Z",
        line_number: 11,
        steps: [{ type: "tool_call", name: "run_command", detail: "gh run list" }],
      },
    ];
    const { turns: merged, changed } = mergeSession(existing, incoming);
    expect(changed).toBe(true);
    expect(merged[1]!.thinking).toBe("先检查 CI 流水线状态");
    expect(merged[1]!.toolCalls?.length).toBe(1);
    expect(merged[1]!.steps).toBeUndefined();
  });
});

describe.skipIf(!TEST_DB)("Direct agent live SSE + DB persistence", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeAll(async () => {
    ctx = await setupApp({ MEMENTO_REMOTE_EXEC: "1" });
  });

  afterAll(async () => {
    await ctx?.sql.end();
  });

  it("emits tool_call, thinking, task_event, task_chunk, tool_result and persists thinking + toolCalls.events", async () => {
    const owner = await addUser(ctx.db, { email: "stream-check@example.com", role: "owner" });
    const devHash = "dev-stream-test-hash";
    await ctx.db.insert(machines).values({
      id: randomUUID(),
      userId: owner.id,
      name: "Test-Mac",
      collectorTokenHash: devHash,
      isArchived: false,
      lastHeartbeat: new Date().toISOString(),
    });

    const conv = await getOrCreateConversation(ctx.db, owner, { title: "SSE 协议测试", deviceId: devHash });
    let dispatchedTaskId = "";

    const fakeWs = {
      readyState: WebSocket.OPEN,
      send(raw: string, cb?: (err?: Error) => void) {
        cb?.();
        const msg = JSON.parse(raw) as { type?: string; task?: { id?: string } };
        if (msg.type === "task_dispatch" && msg.task?.id) {
          dispatchedTaskId = msg.task.id;
          queueMicrotask(() => {
            wsManager.pushEvent(dispatchedTaskId, { kind: "session", session_id: "4b28af2c-45a6-4fa8-9090-211978f7a47c" });
            wsManager.pushEvent(dispatchedTaskId, { kind: "thinking", text: "先分析日志。\n\n" });
            wsManager.pushEvent(dispatchedTaskId, { kind: "tool", id: "step-1", name: "run_command", detail: "git status", status: "running" });
            wsManager.pushEvent(dispatchedTaskId, { kind: "tool", id: "step-1", name: "run_command", detail: "git status", status: "done", output: "clean" });
            wsManager.pushChunk(dispatchedTaskId, "stdout", "全部检查");
            wsManager.pushChunk(dispatchedTaskId, "stdout", "完毕");
            wsManager.pushFinished(dispatchedTaskId, {
              status: "succeeded",
              exit_code: 0,
              stdout: "全部检查完毕",
              stderr: "",
              session_id: "4b28af2c-45a6-4fa8-9090-211978f7a47c",
              events: [
                { kind: "session", session_id: "4b28af2c-45a6-4fa8-9090-211978f7a47c" },
                { kind: "thinking", text: "先分析日志。\n\n" },
                { kind: "tool", id: "step-1", name: "run_command", detail: "git status", status: "done", output: "clean" },
              ],
            });
          });
        }
      },
    };
    await wsManager.register(devHash, fakeWs, "Test-Mac");

    const deps: Deps = { db: ctx.db, settings: ctx.settings, redis: () => null };
    const frames: Record<string, unknown>[] = [];
    try {
      for await (const frame of directAgentStream(deps, owner, {
        convId: conv.id,
        convTitle: conv.title,
        question: "帮我检查状态",
        device: devHash,
        executionMode: "antigravity",
        action: "agent",
      })) {
        if (frame.startsWith("data: ")) frames.push(JSON.parse(frame.slice(6)) as Record<string, unknown>);
      }
    } finally {
      await wsManager.unregister(devHash, fakeWs);
    }

    const types = frames.map((f) => f.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("task_progress");
    expect(types).toContain("thinking");
    expect(types).toContain("task_event");
    expect(types).toContain("task_chunk");
    expect(types).toContain("tool_result");
    expect(types).toContain("delta");
    expect(types).toContain("done");

    const toolCallEvt = frames.find((f) => f.type === "tool_call")!;
    const callId = toolCallEvt.tool_call_id;
    expect(typeof callId).toBe("string");
    const taskEventEvts = frames.filter((f) => f.type === "task_event");
    expect(taskEventEvts.every((e) => e.tool_call_id === callId)).toBe(true);
    const toolResultEvt = frames.find((f) => f.type === "tool_result")!;
    expect(toolResultEvt.tool_call_id).toBe(callId);
    expect(((toolResultEvt.result as { events?: unknown[] }).events ?? []).length).toBe(3);

    // Check DB persistence matches ExecutionCard / ThinkingBlock frontend contract
    const [row] = await ctx.db.select().from(askConversations).where(eq(askConversations.id, conv.id)).limit(1);
    const savedTurns = (row?.turns as Array<Record<string, unknown>>) ?? [];
    expect(savedTurns).toHaveLength(2);
    const asst = savedTurns[1]!;
    expect(asst.thinking).toBe("先分析日志。");
    expect(asst.content).toBe("全部检查完毕");
    expect(Array.isArray(asst.toolCalls)).toBe(true);
    const savedTc = (asst.toolCalls as Array<Record<string, unknown>>)[0]!;
    expect(savedTc.id).toBe(callId);
    expect(savedTc.name).toBe("run_on_device");
    expect(((savedTc.result as { events?: unknown[] }).events ?? []).length).toBe(3);
  });
});
