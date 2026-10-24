import { describe, expect, it } from "vitest";
import {
  normalizeToolKey,
  resolveQuotaToolsOrder,
  DEFAULT_QUOTA_TOOLS_ORDER,
} from "../src/components/quota/AgentQuotaPopover";

describe("Agent Quotas dynamic tools order", () => {
  it("normalizes tool aliases and variants", () => {
    expect(normalizeToolKey("antigravity")).toBe("antigravity");
    expect(normalizeToolKey("agy")).toBe("antigravity");
    expect(normalizeToolKey("ai")).toBe("antigravity");

    expect(normalizeToolKey("claude")).toBe("claude_code");
    expect(normalizeToolKey("claude_code")).toBe("claude_code");
    expect(normalizeToolKey("ClaudeCode")).toBe("claude_code");

    expect(normalizeToolKey("codex")).toBe("codex");
    expect(normalizeToolKey("openai")).toBe("codex");
    expect(normalizeToolKey("openai_codex")).toBe("codex");

    expect(normalizeToolKey("workbuddy")).toBe("workbuddy");
    expect(normalizeToolKey("codebuddy")).toBe("workbuddy");

    expect(normalizeToolKey("unknown_tool")).toBeNull();
    expect(normalizeToolKey(undefined)).toBeNull();
  });

  it("returns default order when no active tool is specified", () => {
    const order = resolveQuotaToolsOrder();
    expect(order).toEqual(DEFAULT_QUOTA_TOOLS_ORDER);
    expect(order).toEqual(["antigravity", "claude_code", "codex", "workbuddy"]);
  });

  it("hoists current active tool to the first position", () => {
    const claudeOrder = resolveQuotaToolsOrder("claude");
    expect(claudeOrder[0]).toBe("claude_code");
    expect(claudeOrder).toEqual(["claude_code", "antigravity", "codex", "workbuddy"]);

    const workbuddyOrder = resolveQuotaToolsOrder("workbuddy");
    expect(workbuddyOrder[0]).toBe("workbuddy");
    expect(workbuddyOrder).toEqual(["workbuddy", "antigravity", "claude_code", "codex"]);

    const codexOrder = resolveQuotaToolsOrder("codex");
    expect(codexOrder[0]).toBe("codex");
    expect(codexOrder).toEqual(["codex", "antigravity", "claude_code", "workbuddy"]);
  });

  it("prioritizes active tool, then recent tools, and backfills remaining", () => {
    const order = resolveQuotaToolsOrder("workbuddy", ["codex", "claude"]);
    expect(order).toEqual(["workbuddy", "codex", "claude_code", "antigravity"]);
  });

  it("deduplicates active tool and recent tools seamlessly", () => {
    const order = resolveQuotaToolsOrder("claude", ["claude", "workbuddy", "claude_code"]);
    expect(order).toEqual(["claude_code", "workbuddy", "antigravity", "codex"]);
  });
});
