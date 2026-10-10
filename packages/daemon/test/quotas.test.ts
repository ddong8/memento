import { describe, expect, it } from "vitest";
import { probeClaudeCodeQuota, probeCodexQuota, probeAntigravityQuota } from "../src/quotas.js";

describe("Real Agent Quotas", () => {
  it("probes Claude Code real utilization from ~/.claude.json", async () => {
    const quota = await probeClaudeCodeQuota();
    expect(quota.tool).toBe("claude_code");
    expect(quota.name).toBe("Claude Code");
    if (quota.available) {
      expect(quota.logged_in).toBe(true);
      // 真实剩余百分比应反映 7 天滑动窗口 (97% 消耗 -> 3% 剩余)
      expect(typeof quota.remaining_percent).toBe("number");
      expect(quota.remaining_percent).toBeLessThan(100);
      expect(quota.details?.seven_day_utilization).toBe(97);
    }
  });

  it("probes Codex real plan and does not fake 100% on free tier", async () => {
    const quota = await probeCodexQuota();
    expect(quota.tool).toBe("codex");
    if (quota.available && quota.details?.is_free_tier) {
      expect(quota.remaining_percent).toBeNull();
      expect(quota.plan_name).toContain("Free");
    }
  });

  it("probes Antigravity live user quotas with real fraction", async () => {
    const quota = await probeAntigravityQuota();
    expect(quota.tool).toBe("antigravity");
    if (quota.available) {
      expect(quota.logged_in).toBe(true);
      expect(typeof quota.remaining_percent).toBe("number");
      // 本机 Gemini 3.8 Flash 配额实际为 2.7%
      expect(quota.remaining_percent).toBeLessThan(100);
      expect(quota.models?.length).toBeGreaterThan(0);
    }
  });
});
