import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { acpRunnerArgs } from "../src/acp.js";
import { ACP_AGENTS, acpAgent, autoPermissionOption, chosenPermissionOption, updateToEvents } from "../src/acp-runner/protocol.js";

const RUNNER = fileURLToPath(new URL("../assets/acp_runner.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

/** Runs the bundled runner against the fake agent; answers approval cards with `answer`. */
function run(opts: { permission: string; session?: string; answer?: string }) {
  return new Promise<{ code: number | null; events: Record<string, unknown>[] }>((resolve) => {
    const p = spawn(process.execPath, [RUNNER, "--cmd", process.execPath, "--arg", FAKE, "-C", "/tmp", "--permission", opts.permission, "--label", "Fake",
      ...(opts.session ? ["--session", opts.session] : []), "--", "跑测试"], { stdio: ["pipe", "pipe", "pipe"] });
    const events: Record<string, unknown>[] = [];
    createInterface({ input: p.stdout }).on("line", (line) => {
      const ev = (JSON.parse(line) as { event: Record<string, unknown> }).event;
      events.push(ev);
      if (ev.kind === "question" && ev.status === "waiting") p.stdin.write(`${JSON.stringify({ type: "memento_answer", question_id: ev.id, answer: opts.answer ?? "允许" })}\n`);
    });
    p.on("exit", (code) => resolve({ code, events }));
  });
}

describe("generic ACP runner", () => {
  it("full access: streams the reply and the tool, allowing it without asking", async () => {
    const { code, events } = await run({ permission: "full" });
    expect(code).toBe(0);
    expect(events[0]).toEqual({ kind: "session", session_id: "s-new" });
    expect(events).toContainEqual({ kind: "text_delta", text: "收到：跑测试" });
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "t1", name: "execute", detail: "npm test", status: "running" }));
    expect(events).toContainEqual({ kind: "tool", id: "t1", status: "done", output: "12 passed" });
    expect(events.some((e) => e.kind === "question")).toBe(false);
  }, 20_000);

  it("supervised: an approval card, and a typed no fails the tool", async () => {
    const { code, events } = await run({ permission: "supervised", answer: "先别跑" });
    expect(code).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ kind: "question", header: "需要你批准", question: "Fake 想要：npm test", approval: true, status: "waiting" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "question", status: "answered", answer: "先别跑" }));
    expect(events).toContainEqual({ kind: "tool", id: "t1", status: "failed", output: "denied" });
  }, 20_000);

  it("resumes the agent's own session without replaying its history", async () => {
    const { events } = await run({ permission: "full", session: "s-old" });
    expect(events[0]).toEqual({ kind: "session", session_id: "s-old" });
    expect(events).not.toContainEqual({ kind: "text_delta", text: "（旧历史）" });
  }, 20_000);
});

describe("ACP protocol pieces", () => {
  const opts = [
    { optionId: "a1", kind: "allow_once" },
    { optionId: "a2", kind: "allow_always" },
    { optionId: "r1", kind: "reject_once" },
  ];

  it("answers permission requests by mode", () => {
    expect(autoPermissionOption(opts, "execute", "full")).toBe("a1");
    expect(autoPermissionOption(opts, "read", "supervised")).toBeNull();
    expect(autoPermissionOption(opts, "edit", "auto_edits")).toBe("a1");
    expect(autoPermissionOption(opts, "execute", "auto_edits")).toBeNull();
    expect(autoPermissionOption(opts, "search", "auto")).toBe("a1");
    expect(autoPermissionOption(opts, "execute", "auto")).toBeNull();
    expect(chosenPermissionOption(opts, "允许")).toEqual({ optionId: "a1", allowAll: false });
    expect(chosenPermissionOption(opts, "本次都允许 execute")).toEqual({ optionId: "a2", allowAll: true });
    expect(chosenPermissionOption(opts, "拒绝")).toEqual({ optionId: "r1", allowAll: false });
  });

  it("knows the agents and how memento starts them", () => {
    expect(ACP_AGENTS.map((a) => a.id)).toEqual(["opencode", "gemini", "cursor", "kiro", "copilot"]);
    expect(acpAgent("Gemini")?.args).toEqual(["--experimental-acp"]);
    const args = acpRunnerArgs({ runner: "/r.mjs", agent: acpAgent("opencode")!, agentExe: "/bin/opencode", workDir: "/w", sessionId: "s", permissionMode: "auto", prompt: "hi" });
    expect(args).toEqual(["/r.mjs", "--cmd", "/bin/opencode", "--arg", "acp", "-C", "/w", "--session", "s", "--permission", "auto", "--label", "OpenCode", "--", "hi"]);
  });

  it("turns plans and thoughts into thinking, unknown updates into nothing", () => {
    const st = { tools: new Map<string, string>() };
    expect(updateToEvents({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想一下" } }, st)).toEqual([{ kind: "thinking", text: "想一下" }]);
    expect(updateToEvents({ sessionUpdate: "plan", entries: [{ content: "写测试", status: "completed" }, { content: "改代码", status: "pending" }] }, st)[0]!.text).toContain("☑ 写测试");
    expect(updateToEvents({ sessionUpdate: "available_commands_update" }, st)).toEqual([]);
  });
});
