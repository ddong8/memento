import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AgentEventLog,
  ClaudeStreamParser,
  claudeToolDetail,
  codexCommand,
  CodexStreamParser,
  UniversalStreamParser,
  type AgentEvent,
  type AgentStreamParser,
} from "../src/agent-stream.js";

function run(parser: AgentStreamParser, fixture: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8").split("\n")) {
    events.push(...(parser.feed(line) ?? []));
  }
  return events;
}

function tools(events: AgentEvent[]) {
  const log = new AgentEventLog();
  for (const e of events) if (e.kind !== "text") log.add(e);
  return log.events.filter((e) => e.kind === "tool");
}

describe("Claude stream-json", () => {
  it("tool calls, final answer, session and usage", () => {
    const parser = new ClaudeStreamParser();
    const events = run(parser, "claude_stream.jsonl");
    const t = tools(events);
    expect(t.map((x) => x.name)).toEqual(["Bash", "Write"]);
    expect(t[0]).toMatchObject({ detail: "ls", status: "done", output: "README.md" });
    expect(t[1]!.detail).toBe("/tmp/probe/hello.txt");
    expect(parser.finalText).toBe("DONE");
    expect(parser.sessionId).toBe("6f3d1184-787b-4878-a8f5-2f5ade4fb738");
    expect(parser.finished).toBe(true);
    expect(parser.queuedTurns).toBe(0);
    const usage = events.find((e) => e.kind === "usage")!;
    expect(usage.cost_usd as number).toBeGreaterThan(0);
    expect(usage.turns).toBe(3);
  });

  it("a failed tool result is marked failed", () => {
    const parser = new ClaudeStreamParser();
    parser.feed('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"false"}}]}}');
    const events = parser.feed(
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Exit code 1","is_error":true}]}}',
    )!;
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("failed");
  });

  it("an error result is reported for retry decisions", () => {
    const parser = new ClaudeStreamParser();
    parser.feed('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"No conversation found with session ID: x"}');
    expect(parser.errors).toContain("No conversation found");
  });

  it("non-JSON lines pass through", () => {
    expect(new ClaudeStreamParser().feed("plain text")).toBeNull();
  });

  it("preserves intermediate texts when result event has summary or task completion", () => {
    const parser = new ClaudeStreamParser();
    parser.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"步骤1：正在分析代码架构..."}]}}');
    parser.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"步骤2：发现关键瓶颈并完成修复。"}]}}');
    parser.feed('{"type":"result","subtype":"success","is_error":false,"result":"任务完成"}');
    expect(parser.finalText).toBe("步骤1：正在分析代码架构...\n\n步骤2：发现关键瓶颈并完成修复。\n\n任务完成");
  });

  it("does not duplicate result when already included in texts", () => {
    const parser = new ClaudeStreamParser();
    parser.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"所有用例已通过，全部完成。"}]}}');
    parser.feed('{"type":"result","subtype":"success","is_error":false,"result":"所有用例已通过，全部完成。"}');
    expect(parser.finalText).toBe("所有用例已通过，全部完成。");
  });
});

describe("Codex exec --json", () => {
  it("commands, final answer and thread id", () => {
    const parser = new CodexStreamParser();
    const events = run(parser, "codex_stream.jsonl");
    const t = tools(events);
    expect(t.map((x) => x.detail)).toEqual(["ls", "printf hi > hello2.txt"]);
    expect(t.every((x) => x.status === "done")).toBe(true);
    expect(parser.finalText).toBe("我将执行 ls，然后创建 hello2.txt。\n\nDONE");
    expect(parser.sessionId).toBe("01a0e88c-159e-74f2-9b90-68d0adee98a0");
    expect(events.at(-1)!.kind).toBe("usage");
  });

  it("a non-zero exit marks the command failed", () => {
    const [e] = new CodexStreamParser().feed(
      '{"type":"item.completed","item":{"id":"i","type":"command_execution","command":"bash -lc \\"exit 3\\"","aggregated_output":"","exit_code":3,"status":"failed"}}',
    )!;
    expect(e).toMatchObject({ status: "failed", detail: "exit 3" });
  });

  it("file changes list their paths", () => {
    const [e] = new CodexStreamParser().feed(
      '{"type":"item.completed","item":{"id":"f","type":"file_change","changes":[{"path":"a.py","kind":"update"},{"path":"b.py","kind":"add"}],"status":"completed"}}',
    )!;
    expect(e).toMatchObject({ name: "Edit", detail: "a.py, b.py" });
  });

  it("turn failures are errors", () => {
    const parser = new CodexStreamParser();
    parser.feed('{"type":"turn.failed","error":{"message":"thread not found"}}');
    expect(parser.errors).toContain("thread not found");
  });
});

it("tool details read like what the agent did", () => {
  expect(claudeToolDetail("Grep", { pattern: "TODO", path: "lib" })).toBe("TODO  lib");
  expect(claudeToolDetail("WebSearch", { query: "flutter webview" })).toBe("flutter webview");
  expect(claudeToolDetail("TodoWrite", { todos: [1, 2, 3] })).toBe("3 项待办");
  expect(claudeToolDetail("Bash", { command: "git status\ngit diff" })).toBe("git status");
  expect(codexCommand("/bin/zsh -lc 'git status'")).toBe("git status");
});

it("event log keeps one row per tool and caps its size", () => {
  const log = new AgentEventLog(2);
  log.add({ kind: "tool", id: "a", name: "Bash", status: "running" });
  log.add({ kind: "tool", id: "a", status: "done" });
  log.add({ kind: "usage", turns: 1 });
  log.add({ kind: "error", message: "dropped" });
  expect(log.events).toHaveLength(2);
  expect(log.events[0]).toMatchObject({ name: "Bash", status: "done" });
});

describe("Background task detection", () => {
  it("Claude detects background bash command", () => {
    const parser = new ClaudeStreamParser();
    parser.feed('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm run build","run_in_background":true}}]}}');
    expect(parser.isStillRunning).toBe(true);

    parser.feed('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Command running in background with ID: bg-998"}]}}');
    expect(parser.activeBackgroundTasks.has("bg-998")).toBe(true);

    parser.feed('{"type":"result","result":"已在后台启动构建任务"}');
    expect(parser.isStillRunning).toBe(true);
  });

  it("Codex detects background nohup execution", () => {
    const parser = new CodexStreamParser();
    parser.feed('{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"nohup python train.py &","aggregated_output":"[1] 12345","exit_code":0,"status":"completed"}}');
    expect(parser.isStillRunning).toBe(true);
  });
});

describe("Interactive questions", () => {
  it("Claude AskUserQuestion: asks over the control channel and gets the answers back in updatedInput", () => {
    const parser = new ClaudeStreamParser();
    const input = {
      questions: [
        { question: "选哪个包管理器？", header: "包管理", options: [{ label: "npm", description: "默认" }, { label: "pnpm" }], multiSelect: false },
        { question: "要哪些检查？", header: "检查", options: [{ label: "lint" }, { label: "test" }], multiSelect: true },
      ],
    };
    const asked = parser.feed(JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input } }))!;
    expect(asked).toEqual([
      expect.objectContaining({ kind: "question", id: "r1:0", header: "包管理", question: "选哪个包管理器？", options: [{ label: "npm", description: "默认" }, { label: "pnpm" }], is_multi_select: false, status: "waiting" }),
      expect.objectContaining({ kind: "question", id: "r1:1", is_multi_select: true, status: "waiting" }),
    ]);

    // The CLI only hears back once every question of the call is answered
    expect(parser.answer("r1:1", "lint, test")).toEqual([{ kind: "question", id: "r1:1", status: "answered", answer: "lint, test" }]);
    expect(parser.takeReplies()).toEqual([]);
    expect(parser.answer(undefined, "pnpm")).toEqual([{ kind: "question", id: "r1:0", status: "answered", answer: "pnpm" }]);
    expect(parser.takeReplies()).toEqual([
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "r1",
          response: { behavior: "allow", updatedInput: { ...input, answers: { "选哪个包管理器？": "pnpm", "要哪些检查？": "lint, test" } } },
        },
      },
    ]);
    expect(parser.answer(undefined, "again")).toBeNull();
  });

  it("Claude: other tools the CLI asks about are allowed as-is, and a cancelled question closes", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.feed(JSON.stringify({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } }))).toEqual([]);
    expect(parser.takeReplies()).toEqual([
      { type: "control_response", response: { subtype: "success", request_id: "r2", response: { behavior: "allow", updatedInput: { command: "ls" } } } },
    ]);

    parser.feed(JSON.stringify({ type: "control_request", request_id: "r3", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "继续吗？", options: [{ label: "是" }, { label: "否" }] }] } } }));
    expect(parser.feed(JSON.stringify({ type: "control_cancel_request", request_id: "r3" }))).toEqual([
      { kind: "question", id: "r3:0", status: "answered", answer: "（已取消）" },
    ]);
    expect(parser.answer(undefined, "是")).toBeNull();
  });

  it("Codex: passes through the question events memento's runner prints", () => {
    const parser = new CodexStreamParser();
    const ev = { kind: "question", id: "codex_0_1:0", tool: "request_user_input", header: "颜色", question: "喜欢哪种颜色？", options: ["红", "蓝"], status: "waiting" };
    expect(parser.feed(JSON.stringify({ type: "memento_event", event: ev }))).toEqual([ev]);
  });

  it("UniversalStreamParser handles structured memento_event and CLI confirmation prompts", () => {
    const parser = new UniversalStreamParser();
    const ev1 = parser.feed('{"type":"memento_event","event":{"kind":"question","id":"agy1","question":"是否覆盖文件?","options":["是","否"],"status":"waiting"}}')!;
    expect(ev1).toHaveLength(1);
    expect(ev1[0]).toMatchObject({ kind: "question", id: "agy1", question: "是否覆盖文件?", status: "waiting" });

    const ev2 = parser.feed("Do you want to proceed? [y/N]")!;
    expect(ev2).toHaveLength(1);
    expect(ev2[0]).toMatchObject({ kind: "question", status: "waiting", options: ["y", "n"] });

    const ev3 = parser.feed("⚡ [创建项目数据库]")!;
    expect(ev3).toHaveLength(1);
    expect(ev3[0]).toMatchObject({ kind: "tool", name: "创建项目数据库", status: "running" });

    parser.feed("session id: test-session-1234");
    expect(parser.sessionId).toBe("test-session-1234");

    parser.feed("Hello from agent!");
    expect(parser.finalText).toBe("Hello from agent!");
  });

  it("ClaudeStreamParser parses thinking blocks and WorkBuddy stream-json", () => {
    const parser = new ClaudeStreamParser();
    const ev1 = parser.feed('{"type":"system","subtype":"init","session_id":"wb-session-999","model":"hy4-preview"}')!;
    expect(parser.sessionId).toBe("wb-session-999");
    expect(ev1[0]).toMatchObject({ kind: "session", session_id: "wb-session-999", model: "hy4-preview" });

    const ev2 = parser.feed('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Thinking deeply..."}]}}')!;
    expect(ev2).toHaveLength(1);
    expect(ev2[0]).toMatchObject({ kind: "thinking", text: "Thinking deeply..." });

    const ev3 = parser.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"这是回答内容"}]}}')!;
    expect(ev3).toHaveLength(1);
    expect(ev3[0]).toMatchObject({ kind: "text", text: "这是回答内容" });

    parser.feed('{"type":"result","subtype":"success","is_error":false,"result":"这是回答内容","session_id":"wb-session-999"}');
    expect(parser.finalText).toBe("这是回答内容");
  });

  it("CodexStreamParser emits question event for mcp_tool_call and shell confirmation", () => {
    const parser = new CodexStreamParser();
    const q1 = parser.feed(
      '{"type":"item.started","item":{"id":"mcp1","type":"mcp_tool_call","server":"memento","tool":"ask_question","arguments":{"question":"请确认数据库迁移?","options":["立即迁移","取消"]}}}',
    )!;
    expect(q1.some((e) => e.kind === "question" && e.status === "waiting")).toBe(true);

    const qDone = parser.feed(
      '{"type":"item.completed","item":{"id":"mcp1","type":"mcp_tool_call","server":"memento","tool":"ask_question","result":"立即迁移","status":"completed"}}',
    )!;
    expect(qDone.some((e) => e.kind === "question" && e.status === "answered")).toBe(true);

    const qShell = parser.feed(
      '{"type":"item.started","item":{"id":"s1","type":"command_execution","command":"rm -i old.log","aggregated_output":"remove old.log? [y/N]"}}',
    )!;
    expect(qShell.some((e) => e.kind === "question" && e.status === "waiting")).toBe(true);
  });
});


