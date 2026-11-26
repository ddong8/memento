import { describe, expect, it } from "vitest";
import { ACP_MODES, acpModesFor, isAcpMode, isCliAgentMode } from "../src/lib/ask/agent-modes";

describe("agent modes", () => {
  it("treats ACP agents as device agents like Claude Code, not AI 编排 or a shell", () => {
    for (const m of ["claude", "codex", "antigravity", "workbuddy", "opencode", "gemini", "cursor", "kiro", "copilot"]) expect(isCliAgentMode(m), m).toBe(true);
    for (const m of ["ai", "shell", "bogus"]) expect(isCliAgentMode(m), m).toBe(false);
    expect(isAcpMode("gemini")).toBe(true);
    expect(isAcpMode("claude")).toBe(false);
  });

  it("offers only the ACP agents the device has, plus the conversation's own", () => {
    expect(acpModesFor(["gemini"], "claude").map((m) => m.id)).toEqual(["gemini"]);
    expect(acpModesFor([], "opencode").map((m) => m.id)).toEqual(["opencode"]);
    expect(acpModesFor(undefined, "ai")).toEqual([]);
    expect(ACP_MODES.map((m) => m.id)).toEqual(["opencode", "gemini", "cursor", "kiro", "copilot"]);
  });
});
