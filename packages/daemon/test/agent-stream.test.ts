import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AgentEventLog,
  AgyCliStreamParser,
  ClaudeStreamParser,
  claudeToolDetail,
  clipOutput,
  codexCommand,
  CodexStreamParser,
  TOOL_OUTPUT_HEAD,
  TOOL_OUTPUT_TAIL,
  toolArgsDetail,
  UniversalStreamParser,
  cleanSessionId,
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

  it("an auto-compaction and the cache read / written are reported", () => {
    const parser = new ClaudeStreamParser();
    expect(
      parser.feed('{"type":"system","subtype":"compact_boundary","session_id":"s","compact_metadata":{"trigger":"auto","pre_tokens":201234}}'),
    ).toEqual([{ kind: "compact", trigger: "auto", pre_tokens: 201234 }]);
    const usage = parser
      .feed('{"type":"result","subtype":"success","total_cost_usd":1.5,"num_turns":4,"usage":{"input_tokens":10,"cache_read_input_tokens":900000,"cache_creation_input_tokens":40000,"output_tokens":3000}}')!
      .find((e) => e.kind === "usage")!;
    expect(usage).toMatchObject({ input_tokens: 940010, cache_read_tokens: 900000, cache_write_tokens: 40000, output_tokens: 3000, turns: 4 });
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

it("tool details for tools not known by name come from their arguments", () => {
  expect(claudeToolDetail("TaskStop", { task_id: "b1x2" })).toBe("b1x2");
  expect(claudeToolDetail("ToolSearch", { query: "select:Monitor", max_results: 3 })).toBe("select:Monitor");
  expect(claudeToolDetail("Skill", { skill: "loop", args: "5m /foo" })).toBe("loop  5m /foo");
  expect(claudeToolDetail("AskUserQuestion", { questions: [{ question: "用哪个？" }] })).toBe("用哪个？");
  expect(claudeToolDetail("mcp__memento-memory__memory_search", { query: "部署", limit: 5 })).toBe("部署");
  expect(claudeToolDetail("mcp__x__y", { limit: 5, verbose: true })).toBe("limit=5 verbose=true");
  expect(toolArgsDetail({ Path: "/a/b.ts", StartLine: 1 })).toBe("/a/b.ts");
});

it("long tool output keeps its head and tail", () => {
  const out = clipOutput(`${"a".repeat(3000)}\nlast line`);
  expect(out.startsWith("a".repeat(TOOL_OUTPUT_HEAD))).toBe(true);
  expect(out.endsWith("last line")).toBe(true);
  expect(out).toContain("省略");
  expect(out.length).toBeLessThan(TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL + 40);
  expect(clipOutput("  short  ")).toBe("short");
});

it("event log keeps one row per tool and, when full, lets go of the oldest finished steps", () => {
  const log = new AgentEventLog(3);
  log.add({ kind: "tool", id: "a", name: "Bash", status: "running" });
  log.add({ kind: "tool", id: "a", status: "done" });
  log.add({ kind: "tool", id: "b", name: "Read", status: "running" });
  log.add({ kind: "usage", turns: 1 });
  log.add({ kind: "tool", id: "c", name: "Edit", status: "running" });
  expect(log.events.map((e) => e.id ?? e.kind)).toEqual(["b", "usage", "c"]);
  // the indexes follow the rows that moved
  log.add({ kind: "tool", id: "b", status: "done", output: "ok" });
  log.add({ kind: "tool", id: "c", status: "failed" });
  expect(log.events[0]).toMatchObject({ id: "b", name: "Read", status: "done", output: "ok" });
  expect(log.events[2]).toMatchObject({ id: "c", name: "Edit", status: "failed" });
  expect(log.dropped).toBe(1);
  // nothing finished to let go of: the new row isn't kept
  const busy = new AgentEventLog(1);
  busy.add({ kind: "tool", id: "x", status: "running" });
  busy.add({ kind: "error", message: "dropped" });
  expect(busy.events).toHaveLength(1);
});

it("event log cuts the oldest outputs down once they add up past the budget", () => {
  const log = new AgentEventLog(100, 2500);
  for (const id of ["a", "b", "c"]) log.add({ kind: "tool", id, status: "done", output: id.repeat(1000) });
  const [a, b, c] = log.events.map((e) => String(e.output));
  expect(a!.length).toBeLessThan(400);
  expect(b).toBe("b".repeat(1000));
  expect(c).toBe("c".repeat(1000));
});

describe("Background task detection", () => {
  it("Claude detects background bash command", () => {
    const parser = new ClaudeStreamParser();
    parser.feed('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm run build","run_in_background":true}}]}}');
    parser.feed('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Command running in background with ID: bg-998"}]}}');
    expect(parser.activeBackgroundTasks.has("bg-998")).toBe(true);

    parser.feed('{"type":"result","result":"已在后台启动构建任务"}');
    expect(parser.isStillRunning).toBe(true);
  });

  const started = (id: string) => `{"type":"system","subtype":"task_started","task_id":"${id}","tool_use_id":"t-${id}","description":"npm run build","task_type":"local_bash","is_backgrounded":true}`;
  const notified = (id: string, status = "completed") => `{"type":"system","subtype":"task_notification","task_id":"${id}","tool_use_id":"t-${id}","status":"${status}","output_file":"","summary":""}`;

  it("Claude: a background task that ended before the answer leaves nothing running", () => {
    const parser = new ClaudeStreamParser();
    parser.feed(started("b1"));
    parser.feed('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t-b1","content":"Command running in background with ID: b1. Output is being written to: /tmp/b1.output"}]}}');
    parser.feed(notified("b1"));
    parser.feed('{"type":"result","result":"构建完成"}');
    expect(parser.activeBackgroundTasks.size).toBe(0);
    expect(parser.isStillRunning).toBe(false);
  });

  it("Claude: a task still open at the answer is left running, until its end is reported", () => {
    const parser = new ClaudeStreamParser();
    parser.feed(started("b1"));
    parser.feed(started("b2"));
    parser.feed(notified("b1", "failed"));
    parser.feed('{"type":"result","result":"已在后台启动"}');
    expect(parser.isStillRunning).toBe(true);
    expect([...parser.activeBackgroundTasks]).toEqual(["b2"]);

    parser.feed(notified("b2", "stopped"));
    expect(parser.isStillRunning).toBe(false);
  });

  it("Claude: reports what is still running in the background each time it changes, once per task", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.feed(started("b1"))).toEqual([{ kind: "background", tasks: [{ id: "b1", description: "npm run build" }] }]);
    expect(parser.feed(started("b1"))).toEqual([]);
    expect(parser.feed('{"type":"system","subtype":"task_started","task_id":"b2"}')).toEqual([
      { kind: "background", tasks: [{ id: "b1", description: "npm run build" }, { id: "b2" }] },
    ]);
    expect(parser.feed(notified("b1"))).toEqual([{ kind: "background", tasks: [{ id: "b2" }] }]);
    expect(parser.feed('{"type":"system","subtype":"task_updated","task_id":"b2","patch":{"status":"killed"}}')).toEqual([{ kind: "background", tasks: [] }]);
    // An end reported twice says nothing new
    expect(parser.feed(notified("b2"))).toEqual([]);
  });

  it("Claude: task_updated with a final status ends the task", () => {
    const parser = new ClaudeStreamParser();
    parser.feed(started("a1"));
    parser.feed('{"type":"system","subtype":"task_updated","task_id":"a1","patch":{"status":"running"}}');
    expect(parser.activeBackgroundTasks.has("a1")).toBe(true);
    parser.feed('{"type":"system","subtype":"task_updated","task_id":"a1","patch":{"status":"killed","end_time":1761600000000}}');
    parser.feed('{"type":"result","result":"done"}');
    expect(parser.isStillRunning).toBe(false);
  });

  it("Claude: a late tool result naming an ended task doesn't bring it back", () => {
    const parser = new ClaudeStreamParser();
    parser.feed(started("b1"));
    parser.feed(notified("b1"));
    parser.feed('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t-b1","content":"Command running in background with ID: b1"}]}}');
    parser.feed('{"type":"result","result":"ok"}');
    expect(parser.isStillRunning).toBe(false);
  });

  it("Codex detects background nohup execution", () => {
    const parser = new CodexStreamParser();
    parser.feed('{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"nohup python train.py &","aggregated_output":"[1] 12345","exit_code":0,"status":"completed"}}');
    expect(parser.isStillRunning).toBe(true);
  });
});

describe("Approvals below full access", () => {
  const ask = (parser: ClaudeStreamParser, id: string, tool: string, input: Record<string, unknown>) =>
    parser.feed(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input } }))!;
  const behavior = (parser: ClaudeStreamParser) =>
    parser.takeReplies().map((r) => (r as { response: { response: { behavior: string; message?: string } } }).response.response);

  it("full access allows tool calls without asking", () => {
    const parser = new ClaudeStreamParser();
    expect(ask(parser, "r1", "Bash", { command: "rm -rf build" })).toEqual([]);
    expect(behavior(parser)).toEqual([expect.objectContaining({ behavior: "allow" })]);
  });

  it("other modes turn a tool call into an approval card, and the user's choice goes back to Claude", () => {
    const parser = new ClaudeStreamParser({ approvals: true });
    const card = ask(parser, "r1", "Bash", { command: "npm publish" });
    expect(card).toEqual([
      expect.objectContaining({ kind: "question", id: "r1:approval", tool: "Bash", header: "需要你批准", question: "运行命令：npm publish", approval: true, status: "waiting" }),
    ]);
    expect(parser.takeReplies()).toEqual([]);
    expect(parser.answer("r1:approval", "允许")).toEqual([{ kind: "question", id: "r1:approval", status: "answered", answer: "允许" }]);
    expect(behavior(parser)).toEqual([expect.objectContaining({ behavior: "allow" })]);

    // a typed reply is a no, passed to the agent as feedback
    ask(parser, "r2", "Write", { file_path: "/repo/.env", content: "x" });
    expect(parser.answer(undefined, "别动 .env")).toEqual([{ kind: "question", id: "r2:approval", status: "answered", answer: "拒绝：别动 .env" }]);
    expect(behavior(parser)).toEqual([{ behavior: "deny", message: "用户没有批准这个操作，回复：别动 .env" }]);

    // "allow all" stops asking about that tool for the rest of the run
    ask(parser, "r3", "Edit", { file_path: "/repo/a.ts" });
    parser.answer("r3:approval", "本次都允许 Edit");
    behavior(parser);
    expect(ask(parser, "r4", "Edit", { file_path: "/repo/b.ts" })).toEqual([]);
    expect(behavior(parser)).toEqual([expect.objectContaining({ behavior: "allow" })]);
    expect(ask(parser, "r5", "Bash", { command: "ls" })).toHaveLength(1);

    // the CLI withdrawing the request closes the card
    expect(parser.feed(JSON.stringify({ type: "control_cancel_request", request_id: "r5" }))).toEqual([
      { kind: "question", id: "r5:approval", status: "answered", answer: "（已取消）" },
    ]);
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

    parser.feed("Conversation ID: agy-conv-uuid-5678");
    expect(parser.sessionId).toBe("agy-conv-uuid-5678");

    parser.feed('{"conversation_id": "json-conv-9999"}');
    expect(parser.sessionId).toBe("json-conv-9999");

    parser.feed("Hello from agent!");
    expect(parser.finalText).toBe("Hello from agent!");
  });

  it("UniversalStreamParser takes a session only from a line saying so, and only an id an agent could make", () => {
    const parser = new UniversalStreamParser();
    parser.feed("session id: 6f3d1184-787b-4878-a8f5-2f5ade4fb738");
    // Source code and quoted text in the output: none of it is a session (2026-11-16: `\\"\\"`)
    parser.feed('persistCurrentConfig({ project_id: "", session_id: "" });');
    parser.feed('session id: \\"\\"');
    parser.feed("conversation id: `、`conversation");
    parser.feed(JSON.stringify({ type: "memento_event", event: { kind: "tool", id: "t1", status: "done", output: 'session id: ""\nsession_id: "x"' } }));
    expect(parser.sessionId).toBe("6f3d1184-787b-4878-a8f5-2f5ade4fb738");

    // memento's runners report it on stderr: their stdout is never read for it
    const runner = new UniversalStreamParser({ sessionFromStdout: false });
    runner.feed("session id: 6f3d1184-787b-4878-a8f5-2f5ade4fb738");
    runner.feed('{"conversation_id": "json-conv-9999"}');
    expect(runner.sessionId).toBeUndefined();
  });

  it("cleanSessionId keeps ids agents make and drops text taken for one", () => {
    expect(cleanSessionId(" 6f3d1184-787b-4878-a8f5-2f5ade4fb738 ")).toBe("6f3d1184-787b-4878-a8f5-2f5ade4fb738");
    expect(cleanSessionId("wb-session-999")).toBe("wb-session-999");
    for (const bad of ['\\"\\"', '""', "`、`conversation", "", "ab", "a b", "../etc", "会话", undefined, 42]) {
      expect(cleanSessionId(bad)).toBeUndefined();
    }
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



describe("Google's agy CLI stream-json", () => {
  const feed = (p: AgyCliStreamParser, ...lines: unknown[]) => lines.flatMap((l) => p.feed(JSON.stringify(l)) ?? []);
  const cid = "9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f";

  it("joins a reply's text deltas, reports the conversation once and keeps the turn's response", () => {
    const p = new AgyCliStreamParser();
    const events = feed(
      p,
      { event: "init", conversation_id: cid, init: { cwd: "/w" } },
      { event: "step_update", step_update: { conversation_id: cid, step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "app" } },
      { event: "step_update", step_update: { conversation_id: cid, step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "le\n" } },
      { event: "result", result: { conversation_id: cid, status: "SUCCESS", response: "apple\n", num_turns: 1, usage: { input_tokens: 5 } } },
    );
    expect(events.filter((e) => e.kind === "session")).toEqual([{ kind: "session", session_id: cid }]);
    expect(events).toContainEqual({ kind: "text", text: "apple" });
    expect(events).toContainEqual({ kind: "usage", input_tokens: 5, turns: 1 });
    expect(p.finalText).toBe("apple");
    expect(p.sessionId).toBe(cid);
  });

  it("a failed run's error goes to the errors retries read; subagents get a row; other lines pass through", () => {
    const p = new AgyCliStreamParser();
    const events = feed(
      p,
      { event: "step_update", step_update: { step_index: 4, state: "ACTIVE", step_type: "subagent", subagent_info: { subagents: [{ role: "审查" }, { type_name: "researcher" }] } } },
      { event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication required" } },
    );
    expect(events).toContainEqual({ kind: "tool", id: "agy_step_4", name: "invoke_subagent", detail: "审查、researcher", status: "running" });
    expect(events).toContainEqual({ kind: "error", message: "authentication required" });
    expect(p.errors).toContain("authentication required");
    expect(p.finalText).toBeUndefined();
    expect(p.feed("Warning: something on stdout")).toBeNull();
  });

  it("streams backgrounded tool transitions, thinking, and completed replies from transcript without duplicating stdout flush", () => {
    const p = new AgyCliStreamParser();
    const t0 = Date.parse("2026-11-22T02:14:00Z");
    const initEvs = feed(
      p,
      { event: "init", conversation_id: cid, init: { cwd: "/w" } },
      { event: "step_update", step_update: { conversation_id: cid, step_index: 250, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "kubectl exec deploy/filmkit -- tail -f daemon.log" } } } },
    );
    expect(initEvs).toContainEqual(expect.objectContaining({ kind: "tool", id: "agy_step_250", status: "running" }));

    // Transcript writes step 249 (tool call), step 250 (backgrounded RUNNING), step 252 (reply + thinking)
    // while agy stdout is head-of-line blocked waiting for step 250 to exit.
    const ev249 = p.feedTranscriptStep(
      {
        step_index: 249,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-22T02:14:17Z",
        thinking: "检查集群守护进程存活。",
        tool_calls: [{ name: "run_command", args: { CommandLine: "\"kubectl exec deploy/filmkit -- tail -f daemon.log\"" } }],
      },
      t0,
    );
    expect(ev249).toEqual([{ kind: "thinking", text: "检查集群守护进程存活。\n\n" }]);

    const ev250 = p.feedTranscriptStep(
      {
        step_index: 250,
        source: "MODEL",
        type: "GENERIC",
        status: "RUNNING",
        created_at: "2026-11-22T02:14:30Z",
        content: `Created At: 2026-11-22T10:14:30+08:00\nTool is running as a background task with task id: ${cid}/task-250\nTask Description: kubectl exec deploy/filmkit`,
      },
      t0,
    );
    expect(ev250).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        id: "agy_step_250",
        name: "run_command",
        detail: "kubectl exec deploy/filmkit -- tail -f daemon.log",
        status: "background",
      }),
    );
    expect(ev250).toContainEqual(
      expect.objectContaining({
        kind: "background",
        tasks: [expect.objectContaining({ id: "task-250" })],
      }),
    );
    expect(String(ev250[0]?.output)).toContain("已转入后台持续运行（task-250）");
    expect(p.activeBackgroundTaskIds.get(`${cid}/task-250`)).toBe("task-250");
    expect(p.activeBackgroundTasks.has(`${cid}/task-250`)).toBe(true);

    // Repeated ACTIVE from stdout must NOT revert step 250 back to "running"
    expect(
      feed(p, { event: "step_update", step_update: { conversation_id: cid, step_index: 250, state: "ACTIVE", step_type: "tool", tool_name: "run_command" } }),
    ).toEqual([]);

    // Step 252 reply is immediately delivered from transcript
    const ev252 = p.feedTranscriptStep(
      {
        step_index: 252,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-22T02:14:33Z",
        content: "完全没有卡住，已完成 10 / 40 镜。",
      },
      t0,
    );
    expect(ev252).toEqual([{ kind: "text", text: "完全没有卡住，已完成 10 / 40 镜。" }]);
    expect(p.finalText).toBe("完全没有卡住，已完成 10 / 40 镜。");

    // Later, when step 250 finally finishes and stdout flushes steps 250 and 252, step 250 updates
    // with its final output and step 252 is NOT duplicated.
    const flushed = feed(
      p,
      { event: "step_update", step_update: { conversation_id: cid, step_index: 250, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", output: "ALL_DONE" } } },
      { event: "step_update", step_update: { conversation_id: cid, step_index: 252, state: "DONE", step_type: "agent_response", text_delta: "完全没有卡住，已完成 10 / 40 镜。\n" } },
    );
    expect(flushed).toContainEqual(expect.objectContaining({ kind: "tool", id: "agy_step_250", status: "done", output: "ALL_DONE" }));
    expect(flushed.filter((e) => e.kind === "text")).toEqual([]);
  });

  it("keeps step_index tool mapping aligned across RUNNING and DONE transcript lines for parallel tools", () => {
    const p = new AgyCliStreamParser();
    const t0 = Date.parse("2026-11-22T02:20:00Z");
    p.feedTranscriptStep(
      {
        step_index: 10,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-22T02:20:01Z",
        tool_calls: [
          { name: "run_command", args: { CommandLine: '"sleep 5"' } },
          { name: "read_file", args: { Path: '"/srv/app/a.ts"' } },
        ],
      },
      t0,
    );
    // Step 11 writes RUNNING (backgrounded), then DONE later — must NOT shift step 12's read_file metadata!
    const ev11Run = p.feedTranscriptStep(
      {
        step_index: 11,
        source: "MODEL",
        type: "GENERIC",
        status: "RUNNING",
        created_at: "2026-11-22T02:20:02Z",
        content: `Created At: 2026-11-22T10:20:02+08:00\nTool is running as a background task with task id: ${cid}/task-11\nTask Description: sleep 5`,
      },
      t0,
    );
    expect(ev11Run).toContainEqual(expect.objectContaining({ kind: "tool", id: "agy_step_11", name: "run_command", detail: "sleep 5", status: "background" }));

    const ev11Done = p.feedTranscriptStep(
      {
        step_index: 11,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-22T02:20:07Z",
        content: "exited 0",
      },
      t0,
    );
    expect(ev11Done).toContainEqual(expect.objectContaining({ kind: "tool", id: "agy_step_11", name: "run_command", detail: "sleep 5", status: "done" }));

    const ev12Done = p.feedTranscriptStep(
      {
        step_index: 12,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-22T02:20:08Z",
        content: "export const x = 1;",
      },
      t0,
    );
    expect(ev12Done).toContainEqual(expect.objectContaining({ kind: "tool", id: "agy_step_12", name: "read_file", detail: "/srv/app/a.ts", status: "done" }));
  });
});

describe("Codex errors", () => {
  it("shows the API's message, once, rather than its JSON body twice", () => {
    const body = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.", code: "model_not_found" } });
    const parser = new CodexStreamParser();
    const first = parser.feed(JSON.stringify({ type: "error", message: body }));
    const again = parser.feed(JSON.stringify({ type: "turn.failed", error: { message: body } }));
    expect(first).toEqual([{ kind: "error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }]);
    expect(again).toEqual([]);
    expect(parser.errors.trim()).toBe("The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.");
  });
});

describe("Multi-agent & subagent streams", () => {
  it("ClaudeStreamParser groups Agent/Task calls, parent_tool_use_id child tools, and background task notifications", () => {
    const parser = new ClaudeStreamParser();
    const log = new AgentEventLog();
    const push = (obj: unknown) => {
      const evs = parser.feed(JSON.stringify(obj)) ?? [];
      for (const e of evs) if (e.kind !== "text") log.add(e);
      return evs;
    };

    // Main agent invokes a background subagent
    const started = push({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent_1",
            name: "Agent",
            input: { name: "CodeReviewer", subagent_type: "researcher", description: "审查路由变更", run_in_background: true },
          },
        ],
      },
    });
    expect(started).toContainEqual(
      expect.objectContaining({
        kind: "subagent",
        id: "toolu_agent_1",
        name: "CodeReviewer",
        role: "researcher",
        detail: "审查路由变更",
        status: "running",
      }),
    );

    // Child tool call with parent_tool_use_id is nested under the subagent
    const childTool = push({
      type: "assistant",
      parent_tool_use_id: "toolu_agent_1",
      message: {
        content: [
          { type: "text", text: "child internal commentary should not leak to main finalText" },
          { type: "tool_use", id: "toolu_child_read", name: "Read", input: { file_path: "src/app.ts" } },
        ],
      },
    });
    expect(childTool).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        id: "toolu_child_read",
        name: "Read",
        detail: "src/app.ts",
        subagent_id: "toolu_agent_1",
        subagent_name: "CodeReviewer",
        status: "running",
      }),
    );
    expect(childTool.some((e) => e.kind === "text")).toBe(false);

    // Child tool result completes the nested tool
    push({
      type: "user",
      parent_tool_use_id: "toolu_agent_1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_child_read", content: "ok", is_error: false }],
      },
    });

    // Background task_started links task_id -> tool_use_id, and task_notification completes it
    push({ type: "system", subtype: "task_started", task_id: "bg_task_9", tool_use_id: "toolu_agent_1", description: "审查路由变更" });
    push({ type: "system", subtype: "task_notification", task_id: "bg_task_9", tool_use_id: "toolu_agent_1", status: "completed", summary: "未发现高危问题" });

    // Main final answer
    push({ type: "assistant", message: { content: [{ type: "text", text: "全部检查通过" }] } });

    expect(parser.finalText).toBe("全部检查通过");
    const subEv = log.events.find((e) => e.kind === "subagent" && e.id === "toolu_agent_1");
    expect(subEv).toMatchObject({ kind: "subagent", id: "toolu_agent_1", status: "done", output: "未发现高危问题" });
    const nestedTool = log.events.find((e) => e.kind === "tool" && e.id === "toolu_child_read");
    expect(nestedTool).toMatchObject({ kind: "tool", subagent_id: "toolu_agent_1", status: "done" });
  });

  it("CodexStreamParser tracks collab_agent_tool_call and subagent_thread_id child steps without polluting finalText", () => {
    const parser = new CodexStreamParser();
    const log = new AgentEventLog();
    const push = (obj: unknown) => {
      const evs = parser.feed(JSON.stringify(obj)) ?? [];
      for (const e of evs) if (e.kind !== "text") log.add(e);
      return evs;
    };

    // Main thread spawns a child agent via collab_agent_tool_call
    push({
      type: "item.completed",
      item: {
        id: "collab_1",
        type: "collab_agent_tool_call",
        tool: "spawn_agent",
        status: "completed",
        prompt: "检查数据库迁移",
        receiver_thread_ids: ["thread-child-1"],
        agents_states: { "thread-child-1": { status: "running", message: "检查数据库迁移" } },
      },
    });

    // Child thread executes a command and produces a child message
    push({
      type: "item.started",
      subagent_thread_id: "thread-child-1",
      item: { id: "cmd_1", type: "command_execution", command: "pytest server/tests", status: "in_progress" },
    });
    push({
      type: "item.completed",
      subagent_thread_id: "thread-child-1",
      item: { id: "cmd_1", type: "command_execution", command: "pytest server/tests", status: "completed", exit_code: 0, aggregated_output: "10 passed" },
    });
    push({
      type: "item.completed",
      subagent_thread_id: "thread-child-1",
      item: { id: "msg_child", type: "agent_message", text: "迁移无冲突" },
    });

    // Main thread completes wait + main final message
    push({
      type: "item.completed",
      item: {
        id: "collab_2",
        type: "collab_agent_tool_call",
        tool: "wait",
        status: "completed",
        receiver_thread_ids: ["thread-child-1"],
        agents_states: { "thread-child-1": { status: "completed", message: "迁移无冲突" } },
      },
    });
    push({
      type: "item.completed",
      item: { id: "msg_main", type: "agent_message", text: "主代理汇总：一切正常" },
    });

    expect(parser.finalText).toBe("主代理汇总：一切正常");
    const subEv = log.events.find((e) => e.kind === "subagent" && e.id === "thread-child-1");
    expect(subEv).toMatchObject({ kind: "subagent", id: "thread-child-1", status: "done", output: "迁移无冲突" });
    const childTool = log.events.find((e) => e.kind === "tool" && e.subagent_id === "thread-child-1");
    expect(childTool).toMatchObject({ kind: "tool", name: "Shell", detail: "pytest server/tests", status: "done", subagent_id: "thread-child-1" });
  });

  it("AgyCliStreamParser emits subagent rows alongside invoke_subagent tool and UniversalStreamParser accepts subagent events", () => {
    const agy = new AgyCliStreamParser();
    const agyEvents = agy.feed(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 9,
        state: "ACTIVE",
        step_type: "subagent",
        subagent_info: { subagents: [{ role: "前端专家", type_name: "research" }] },
      },
    })) ?? [];
    expect(agyEvents).toContainEqual(
      expect.objectContaining({ kind: "subagent", name: "前端专家", role: "research", status: "running" }),
    );

    const univ = new UniversalStreamParser();
    const res = univ.feed(JSON.stringify({ kind: "subagent", id: "swarm:worker-1", name: "worker-1", agent_type: "swarm", detail: "构建模块 A", status: "running" }));
    expect(res).toEqual([{ kind: "subagent", id: "swarm:worker-1", name: "worker-1", agent_type: "swarm", detail: "构建模块 A", status: "running" }]);
  });
});
