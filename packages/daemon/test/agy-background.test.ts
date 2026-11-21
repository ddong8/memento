// Which background tasks an Antigravity conversation left running, read from its transcript the way
// Google's agy CLI writes it (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agyCliOpenBackgroundTasks, openBackgroundTasks } from "../src/antigravity.js";

const CID = "b01809fb-e47c-42c6-b116-f5c871c5a257";
const since = Date.parse("2026-11-19T04:30:00Z");
const started = (n: number, at = "2026-11-19T04:30:59Z") => ({
  step_index: n,
  source: "MODEL",
  type: "GENERIC",
  status: "RUNNING",
  created_at: at,
  content: `Created At: ${at}\nTool is running as a background task with task id: ${CID}/task-${n}\nTask Description: npm test`,
});
const finished = (n: number) => ({
  step_index: n + 2,
  source: "SYSTEM",
  type: "SYSTEM_MESSAGE",
  status: "DONE",
  created_at: "2026-11-19T04:31:32Z",
  content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T04:31:32Z sender=${CID}/task-${n} priority=MESSAGE_PRIORITY_HIGH content=Task id "${CID}/task-${n}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`,
});
const jsonl = (...steps: unknown[]) => steps.map((s) => JSON.stringify(s)).join("\n") + "\n";

const dir = mkdtempSync(join(tmpdir(), "agy-bg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("background tasks left running by an Antigravity run", () => {
  it("none once each one's own message says it finished (the run on vps3 that read as still running)", () => {
    const reply = { step_index: 467, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "正在后台执行构建与测试（task-466），完成后截图核验。" };
    expect(openBackgroundTasks(jsonl(started(466), reply, finished(466), started(470, "2026-11-19T04:31:53Z"), finished(470)), since)).toEqual([]);
  });

  it("one with no end yet is open; one from before this run isn't this run's", () => {
    expect(openBackgroundTasks(jsonl(started(127, "2026-11-17T15:30:00Z"), started(466)), since)).toEqual([`${CID}/task-466`]);
  });

  it("another task's end, a longer id with the same start, or a file showing the id end nothing", () => {
    const fileView = { step_index: 480, type: "GENERIC", status: "DONE", content: "File Path: `/w/log.txt`\ntask-46 finished with result" };
    const other = { step_index: 481, type: "GENERIC", status: "DONE", content: "task-466 finished with result: ok" };
    expect(openBackgroundTasks(jsonl(started(46), fileView, other), since)).toEqual([`${CID}/task-46`]);
  });

  it("the agent stopping it ends it; a cancelled one ends too", () => {
    const kill = { step_index: 490, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "manage_task", args: JSON.stringify({ Action: "kill", TaskId: "task-466" }) }] };
    const cancelled = { step_index: 491, type: "GENERIC", status: "DONE", content: `Task "${CID}/task-470" cancelled. Status: CANCELLED` };
    expect(openBackgroundTasks(jsonl(started(466), started(470), kill, cancelled), since)).toEqual([]);
  });

  it("read from the CLI's conversation; undefined when there's no transcript or the id isn't one", () => {
    const logs = join(dir, ".gemini", "antigravity-cli", "brain", CID, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript_full.jsonl"), jsonl(started(466), finished(466), started(470)));
    expect(agyCliOpenBackgroundTasks(CID, since, dir)).toEqual([`${CID}/task-470`]);
    expect(agyCliOpenBackgroundTasks("5b41bd4a-db6f-4654-8ee9-1b6696186d57", since, dir)).toBeUndefined();
    expect(agyCliOpenBackgroundTasks("../x", since, dir)).toBeUndefined();
  });

  it("tracks invoke_subagent conversation ids until SYSTEM_MESSAGE reply or manage_subagents kill", () => {
    const sub1 = "11111111-2222-3333-4444-555555555551";
    const sub2 = "11111111-2222-3333-4444-555555555552";
    const invoke1 = {
      step_index: 500,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-19T04:31:00Z",
      tool_calls: [{ name: "invoke_subagent", args: JSON.stringify({ TypeName: "research", Role: "Code Auditor" }) }],
    };
    const invokeRes1 = {
      step_index: 501,
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-19T04:31:01Z",
      content: `Subagent started with conversationId: "${sub1}"`,
    };
    const invoke2 = {
      step_index: 502,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-19T04:31:02Z",
      tool_calls: [{ name: "invoke_subagent", args: JSON.stringify({ TypeName: "browser", Role: "UI Verifier" }) }],
    };
    const invokeRes2 = {
      step_index: 503,
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-19T04:31:03Z",
      content: `Launched subagent conversationId: "${sub2}"`,
    };
    const sub1Reply = {
      step_index: 504,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: "2026-11-19T04:32:00Z",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T04:32:00Z sender=${sub1} content=Audit finished\n</SYSTEM_MESSAGE>`,
    };
    const killSub2 = {
      step_index: 505,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-19T04:32:10Z",
      tool_calls: [{ name: "manage_subagents", args: JSON.stringify({ Action: "kill", ConversationIds: [sub2] }) }],
    };

    expect(openBackgroundTasks(jsonl(invoke1, invokeRes1, invoke2, invokeRes2), since)).toEqual([sub1, sub2]);
    expect(openBackgroundTasks(jsonl(invoke1, invokeRes1, invoke2, invokeRes2, sub1Reply), since)).toEqual([sub2]);
    expect(openBackgroundTasks(jsonl(invoke1, invokeRes1, invoke2, invokeRes2, sub1Reply, killSub2), since)).toEqual([]);
  });
});
