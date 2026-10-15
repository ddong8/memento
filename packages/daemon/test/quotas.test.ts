import { describe, expect, it } from "vitest";
import { probeClaudeCodeQuota, probeCodexQuota, probeAntigravityQuota } from "../src/quotas.js";

describe("Real Agent Quotas", () => {
  it("probes Claude Code real utilization from ~/.claude.json fixture", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const testDir = await mkdtemp(join(tmpdir(), "memento-claude-quota-"));
    try {
      const claudeJson = {
        oauthAccount: {
          accountUuid: "test-uuid",
          emailAddress: "test@example.com",
          billingType: "apple_subscription",
          displayName: "Test User",
        },
        cachedUsageUtilization: {
          utilization: {
            seven_day: {
              utilization: 97,
              resets_at: new Date(Date.now() + 86400000).toISOString(),
            },
          },
        },
      };
      await writeFile(join(testDir, ".claude.json"), JSON.stringify(claudeJson), "utf8");

      const quota = await probeClaudeCodeQuota(testDir);
      expect(quota.tool).toBe("claude_code");
      expect(quota.name).toBe("Claude Code");
      expect(quota.available).toBe(true);
      expect(quota.logged_in).toBe(true);
      expect(quota.plan_name).toContain("Claude Pro");
      // 真实剩余百分比应反映 7 天滑动窗口 (97% 消耗 -> 3% 剩余)
      expect(typeof quota.remaining_percent).toBe("number");
      expect(quota.remaining_percent).toBe(3);
      expect(quota.remaining_percent).toBeLessThan(100);
      expect(typeof quota.details?.seven_day_utilization).toBe("number");
      expect(quota.details?.seven_day_utilization).toBe(97);
      // 必须包含最新的 5.5 系列模型
      expect(quota.models?.some((m) => m.model_id === "claude-opus-5-5")).toBe(true);
      expect(quota.models?.some((m) => m.model_id === "claude-sonnet-5-5")).toBe(true);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("probes host Claude Code environment gracefully", async () => {
    const quota = await probeClaudeCodeQuota();
    expect(quota.tool).toBe("claude_code");
    expect(quota.name).toBe("Claude Code");
    if (quota.available) {
      expect(quota.logged_in).toBe(true);
      if (quota.remaining_percent != null) {
        expect(typeof quota.remaining_percent).toBe("number");
        expect(quota.remaining_percent).toBeGreaterThanOrEqual(0);
        expect(quota.remaining_percent).toBeLessThanOrEqual(100);
      }
      expect(quota.models?.length).toBeGreaterThan(0);
      expect(quota.models?.some((m) => m.model_id.includes("5-5"))).toBe(true);
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
