import { describe, expect, it } from "vitest";

import { CLAUDE_HOST_KEYS, executionEnvironment } from "../src/exec-env.js";
import { antigravityAcpArgs, antigravityArgs, CLAUDE_CLIENT_NAME, claudeArgs, claudeClientEnv, codexArgs, isSessionNotFound, normalizePermissionMode } from "../src/task-runner.js";

describe("agent launch arguments", () => {
  it("Claude Code runs under the permission mode the user picked, asking over stdio in all of them", () => {
    const flags = (mode?: "full" | "auto_edits" | "supervised" | "auto") => claudeArgs({ permissionMode: mode }).join(" ");
    expect(flags()).toContain("--dangerously-skip-permissions");
    expect(flags("full")).toContain("--dangerously-skip-permissions");
    expect(flags("auto_edits")).toContain("--permission-mode acceptEdits");
    expect(flags("supervised")).toContain("--permission-mode manual");
    expect(flags("auto")).toContain("--permission-mode auto");
    for (const mode of ["auto_edits", "supervised", "auto"] as const) {
      expect(flags(mode)).not.toContain("--dangerously-skip-permissions");
      expect(flags(mode)).toContain("--permission-prompt-tool stdio");
    }
    expect(normalizePermissionMode("supervised")).toBe("supervised");
    expect(normalizePermissionMode("bogus")).toBe("full");
    expect(normalizePermissionMode(undefined)).toBe("full");
  });

  it("Codex and Antigravity pass the permission mode to memento's runners, nothing at full access", () => {
    const codex = (mode?: "full" | "supervised" | "auto") => codexArgs({ runner: "/r/codex_app.mjs", codex: "/bin/codex", prompt: "hi", permissionMode: mode });
    expect(codex()).not.toContain("--permission");
    expect(codex("full")).not.toContain("--permission");
    expect(codex("supervised").join(" ")).toContain("--permission supervised --");
    const agy = antigravityAcpArgs({ runner: "/r/agy_acp.mjs", agy: "/bin/agy", prompt: "hi", permissionMode: "auto" });
    expect(agy.join(" ")).toContain("--permission auto --");
    expect(antigravityAcpArgs({ runner: "/r/agy_acp.mjs", agy: "/bin/agy", prompt: "hi" })).not.toContain("--permission");
  });

  it("the Codex runner maps the modes to app-server approval policies and sandboxes", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../assets/codex_app.mjs", import.meta.url), "utf8");
    expect(src).toContain('if (mode === "supervised") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };');
    expect(src).toContain('return { approvalPolicy: "on-request", sandbox: "workspace-write" };');
    expect(src).toContain('return { approvalPolicy: "never", sandbox: "danger-full-access" };');
  });

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

  it("Claude Code runs under memento's name unless the user keeps sdk-cli, without the Artifact tools", () => {
    for (const v of [undefined, null, "", "memento", "cli"]) {
      expect(claudeClientEnv(v)).toEqual({ CLAUDE_CODE_ENTRYPOINT: "memento", CLAUDE_CODE_DISABLE_ARTIFACT: "1" });
    }
    expect(claudeClientEnv("sdk-cli")).toEqual({});
    // Claude Code rejects names starting with sdk and the ones it uses itself
    expect(CLAUDE_CLIENT_NAME).toMatch(/^(?!sdk)[a-z][a-z0-9_-]{0,31}$/);
  });
});

describe("execution environment", () => {
  it("drops the variables of a Claude Code session memento was started from", async () => {
    const saved = Object.fromEntries(CLAUDE_HOST_KEYS.map((k) => [k, process.env[k]]));
    for (const k of CLAUDE_HOST_KEYS) process.env[k] = "1";
    try {
      const env = await executionEnvironment();
      for (const k of CLAUDE_HOST_KEYS) expect(env[k]).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
