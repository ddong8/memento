import { describe, expect, it } from "vitest";
import { conversationTurnsCache, saveToRecentConvTurnsCache } from "../src/lib/ask/cache";
import type { Turn } from "../src/lib/ask/turns";

describe("ask cache module", () => {
  it("stores and retrieves turns in memory cache", () => {
    const dummyTurns: Turn[] = [
      { role: "user", content: "你好，请检查系统状态" },
      { role: "assistant", content: "系统运行正常，所有服务在线" },
    ];

    saveToRecentConvTurnsCache("conv-test-123", dummyTurns, {
      execution_mode: "antigravity",
      model: "claude-3-7-sonnet",
    });

    const cached = conversationTurnsCache.get("conv-test-123");
    expect(cached).toBeDefined();
    expect(cached?.turns.length).toBe(2);
    expect(cached?.turns[0].content).toBe("你好，请检查系统状态");
    expect(cached?.config?.executionMode).toBe("antigravity");
  });
});
