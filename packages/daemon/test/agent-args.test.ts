import { describe, expect, it } from "vitest";

import { antigravityArgs, autoCompactWindow, claudeArgs, codexArgs, isSessionNotFound } from "../src/task-runner.js";

describe("agent launch arguments", () => {
  it("Claude Code asks its questions over stdio, with every other tool still allowed", () => {
    const args = claudeArgs({ model: "opus" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args.join(" ")).toContain("--permission-prompt-tool stdio");
    expect(args.join(" ")).toContain("--input-format stream-json --output-format stream-json");
  });

  it("Codex runs through memento's app-server runner", () => {
    const base = { runner: "/r/codex_app.mjs", codex: "/bin/codex", workDir: "/w", effort: "high", model: "gpt-5.5", prompt: "--fork is just text" };
    expect(codexArgs(base)).toEqual(["/r/codex_app.mjs", "--codex", "/bin/codex", "-C", "/w", "--effort", "high", "--model", "gpt-5.5", "--", "--fork is just text"]);
    expect(codexArgs({ ...base, sessionId: "rollout-x 01a16bcf-623c-7741-8cda-e17297cccf40", fork: true })).toEqual([
      "/r/codex_app.mjs", "--codex", "/bin/codex", "-C", "/w",
      "--resume", "01a16bcf-623c-7741-8cda-e17297cccf40", "--fork",
      "--effort", "high", "--model", "gpt-5.5", "--", "--fork is just text",
    ]);
  });

  it("Antigravity uses official Go CLI protocol with --conversation and --print-timeout", () => {
    const base = { prompt: "Hello Antigravity" };
    expect(antigravityArgs(base)).toEqual([
      "--dangerously-skip-permissions",
      "-p",
      "Hello Antigravity",
    ]);

    expect(antigravityArgs({
      ...base,
      sessionId: "ead11d5b-428c-48b6-a7e8-232114fc98f5",
      model: "pro",
      effort: "high",
      timeoutSeconds: 300,
    })).toEqual([
      "--conversation", "ead11d5b-428c-48b6-a7e8-232114fc98f5",
      "--model", "pro",
      "--effort", "high",
      "--print-timeout", "285s",
      "--dangerously-skip-permissions",
      "-p", "Hello Antigravity",
    ]);

    // Session resumption with noisy prefix extracts UUID
    expect(antigravityArgs({
      ...base,
      sessionId: "memento: ead11d5b-428c-48b6-a7e8-232114fc98f5 (win)",
    })).toEqual([
      "--conversation", "ead11d5b-428c-48b6-a7e8-232114fc98f5",
      "--dangerously-skip-permissions",
      "-p", "Hello Antigravity",
    ]);

    // Timeout 0 or negative is omitted (official CLI default is 0s)
    expect(antigravityArgs({
      ...base,
      timeoutSeconds: 0,
    })).not.toContain("--print-timeout");
    expect(antigravityArgs({
      ...base,
      timeoutSeconds: 0,
    })).not.toContain("--timeout");
    expect(antigravityArgs(base)).not.toContain("--resume");
  });

  it("detects session missing or flag mismatches as session-not-found for automatic recovery", () => {
    expect(isSessionNotFound("❌ flags provided but not defined: -resume\nUsage of agy.exe:")).toBe(true);
    expect(isSessionNotFound("Usage of agy:\n  --conversation string")).toBe(true);
    expect(isSessionNotFound("Error resuming conversation: conv-123")).toBe(true);
    expect(isSessionNotFound("thread not found")).toBe(true);
    expect(isSessionNotFound("session not found")).toBe(true);
    expect(isSessionNotFound("Normal response without errors")).toBe(false);
  });

  it("the auto-compact window is passed only when Claude Code accepts it (100k–1M tokens)", () => {
    expect(autoCompactWindow(200000)).toBe(200000);
    expect(autoCompactWindow("300000")).toBe(300000);
    expect(autoCompactWindow(1_000_000)).toBe(1_000_000);
    for (const v of [0, 99_999, 1_000_001, 200000.5, "", "200k", null, undefined, NaN]) expect(autoCompactWindow(v)).toBeUndefined();
  });
});
