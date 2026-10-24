import { describe, expect, it } from "vitest";
import { resolveConversationAgent } from "../src/components/ask/HistoryDrawer";
import type { AskConversationSummary } from "../src/lib/api-client";

describe("resolveConversationAgent", () => {
  it("resolves claude agent correctly", () => {
    const c1: AskConversationSummary = {
      id: "1",
      title: "优化搜索功能",
      created_at: null,
      updated_at: null,
      device_id: null,
      message_count: 5,
      config: { executionMode: "claude" },
    };
    expect(resolveConversationAgent(c1)).toEqual({
      id: "claude_code",
      name: "Claude Code",
      brandId: "claude_code",
    });

    const c2: AskConversationSummary = {
      id: "2",
      title: "写点代码",
      created_at: null,
      updated_at: null,
      device_id: null,
      message_count: 3,
      config: { model: "claude-3-7-sonnet" },
    };
    expect(resolveConversationAgent(c2).id).toBe("claude_code");
  });

  it("resolves antigravity agent correctly", () => {
    const c: AskConversationSummary = {
      id: "3",
      title: "深度思考问题",
      created_at: null,
      updated_at: null,
      device_id: null,
      message_count: 10,
      config: { executionMode: "antigravity" },
    };
    expect(resolveConversationAgent(c)).toEqual({
      id: "antigravity",
      name: "Google Antigravity",
      brandId: "antigravity",
    });
  });

  it("resolves codex and workbuddy correctly", () => {
    const cCodex: AskConversationSummary = {
      id: "4",
      title: "Codex 任务",
      created_at: null,
      updated_at: null,
      device_id: null,
      message_count: 2,
      config: { execution_mode: "codex" },
    };
    expect(resolveConversationAgent(cCodex).id).toBe("codex");

    const cWorkbuddy: AskConversationSummary = {
      id: "5",
      title: "WorkBuddy 任务",
      created_at: null,
      updated_at: null,
      device_id: null,
      message_count: 8,
      config: { executionMode: "workbuddy" },
    };
    expect(resolveConversationAgent(cWorkbuddy).id).toBe("workbuddy");
  });

  it("falls back to claude_code as default", () => {
    const cDefault: AskConversationSummary = {
      id: "6",
      title: "常规任务",
      created_at: null,
      updated_at: null,
      device_id: null,
      message_count: 1,
    };
    expect(resolveConversationAgent(cDefault).id).toBe("claude_code");
  });
});
