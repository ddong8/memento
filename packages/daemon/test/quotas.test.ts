import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCredentialAccount,
  claudeCredentialService,
  probeClaudeCodeQuota,
  probeCodexQuota,
  probeAntigravityQuota,
  usableClaudeAccessToken,
} from "../src/quotas.js";
import { agentLoginHint } from "../src/task-runner.js";

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
  }, 15000);

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
  }, 15000);

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
      expect(quota.remaining_percent).toBeLessThanOrEqual(100);
      expect(quota.remaining_percent).toBeGreaterThanOrEqual(0);
      expect(quota.models?.length).toBeGreaterThan(0);
    }
  });
});

describe("agent credentials stay read-only", () => {
  it("never redeems a refresh token or rewrites an agent's stored login", () => {
    // Claude Code and Codex refresh tokens are single use: redeeming one outside the CLI signs it out.
    const src = join(import.meta.dirname, "..", "src");
    for (const name of readdirSync(src).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(src, name), "utf8");
      expect(text, name).not.toMatch(/add-generic-password|delete-generic-password|oauth\/token|grant_type:\s*["']refresh_token/);
    }
  });

  it("uses a still-valid access token and leaves an expired one to Claude Code", () => {
    const now = Date.UTC(2026, 9, 25, 12);
    const creds = (expiresAt?: number) => ({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", ...(expiresAt ? { expiresAt } : {}) } });
    expect(usableClaudeAccessToken(creds(now + 3_600_000), now)).toBe("at");
    expect(usableClaudeAccessToken(creds(now + 30_000), now)).toBeUndefined();
    expect(usableClaudeAccessToken(creds(now - 1), now)).toBeUndefined();
    expect(usableClaudeAccessToken(creds(), now)).toBe("at");
    expect(usableClaudeAccessToken(undefined, now)).toBeUndefined();
    expect(usableClaudeAccessToken({ claudeAiOauth: {} }, now)).toBeUndefined();
  });

  it("reads the keychain item Claude Code itself uses", () => {
    expect(claudeCredentialService({})).toBe("Claude Code-credentials");
    const dir = "/Users/me/.claude-work";
    const suffix = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    expect(claudeCredentialService({ CLAUDE_CONFIG_DIR: dir })).toBe(`Claude Code-credentials-${suffix}`);
    expect(claudeCredentialService({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" })).toBe("Claude Code-credentials");
    expect(claudeCredentialAccount({ USER: "haixing" })).toBe("haixing");
    expect(claudeCredentialAccount({ USER: "董 海" })).toBe("claude-code-user");
  });
});

describe("agentLoginHint", () => {
  it("names the device and the command when the agent's login is gone", () => {
    const claude = agentLoginHint("claude", "Failed to authenticate: OAuth session expired and could not be refreshed", "mac-mini");
    expect(claude).toContain("mac-mini");
    expect(claude).toContain("claude auth login");
    expect(agentLoginHint("/opt/homebrew/bin/claude", "Not logged in · Please run /login", "m")).toBeDefined();
    const codex = agentLoginHint(
      "codex",
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      "m",
    );
    expect(codex).toContain("codex login");
  });

  it("stays quiet for other failures and other agents", () => {
    expect(agentLoginHint("claude", "Prompt is too long", "m")).toBeUndefined();
    expect(agentLoginHint("claude", "API Error: 529 overloaded", "m")).toBeUndefined();
    expect(agentLoginHint("codex", "thread not found", "m")).toBeUndefined();
    expect(agentLoginHint("agy", "Please run /login", "m")).toBeUndefined();
  });
});
