import { describe, expect, it } from "vitest";

import { autoCompactWindow, claudeArgs, codexArgs } from "../src/task-runner.js";

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

  it("the auto-compact window is passed only when Claude Code accepts it (100k–1M tokens)", () => {
    expect(autoCompactWindow(200000)).toBe(200000);
    expect(autoCompactWindow("300000")).toBe(300000);
    expect(autoCompactWindow(1_000_000)).toBe(1_000_000);
    for (const v of [0, 99_999, 1_000_001, 200000.5, "", "200k", null, undefined, NaN]) expect(autoCompactWindow(v)).toBeUndefined();
  });
});
