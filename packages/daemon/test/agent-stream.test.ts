import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AgentEventLog,
  ClaudeStreamParser,
  claudeToolDetail,
  codexCommand,
  CodexStreamParser,
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
});

describe("Codex exec --json", () => {
  it("commands, final answer and thread id", () => {
    const parser = new CodexStreamParser();
    const events = run(parser, "codex_stream.jsonl");
    const t = tools(events);
    expect(t.map((x) => x.detail)).toEqual(["ls", "printf hi > hello2.txt"]);
    expect(t.every((x) => x.status === "done")).toBe(true);
    expect(parser.finalText).toBe("DONE");
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

