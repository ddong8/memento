import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

import { HookBridge } from "../src/hook-bridge.js";

// Claude Code's PreToolUse hook posts each call; a call this device must not run gets a deny back.
describe("the tool-call hook", () => {
  it("reports every call and turns down the ones it is told to, with the reason for the model", async () => {
    const seen: string[] = [];
    const bridge = new HookBridge(
      (_t, use) => seen.push(use.input.command ?? ""),
      (taskId, use) => (taskId === "t1" && use.input.command === "npm test" ? "这台设备只改代码" : undefined),
    );
    const hooks = (await bridge.claudeHooks("t1")) as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    const command = hooks.PreToolUse[0]!.hooks[0]!.command;
    // The hook as Claude Code runs it: the call on stdin, the answer on stdout
    const run = (cmd: string) =>
      new Promise<unknown>((resolve, reject) => {
        const child = execFile("/bin/sh", ["-c", command], { encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
        child.stdin!.end(JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }));
      });
    expect(await run("npm test")).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "这台设备只改代码" },
    });
    expect(await run("git status")).toEqual({});
    expect(seen).toEqual(["npm test", "git status"]);
    await bridge.stop();
  });
});
