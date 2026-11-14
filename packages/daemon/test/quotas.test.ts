import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agedClaudeUsage,
  agyCliQuotaModels,
  claudePlanTier,
  claudeCredentialAccount,
  claudeCredentialService,
  probeClaudeCodeQuota,
  probeCodexQuota,
  probeAntigravityQuota,
  usableClaudeAccessToken,
} from "../src/quotas.js";
import { agentLoginHint, usageLimitMessage } from "../src/task-runner.js";
import { parseAgyModels } from "../src/agy-models.js";

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
      // Claude Code 自己的别名（它解析成当前版本），不写死任何版本号
      const ids = quota.models?.map((m) => m.model_id) ?? [];
      expect(ids).toEqual(expect.arrayContaining(["best", "opus", "sonnet", "haiku"]));
      expect(ids.some((id) => /\d/.test(id))).toBe(false);
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
      expect(quota.models?.some((m) => m.model_id === "opus")).toBe(true);
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

  it("treats an expired Codex id_token as signed in while a refresh_token can renew it", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const jwt = (expSecondsFromNow: number) =>
      `h.${Buffer.from(JSON.stringify({ email: "a@example.com", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString("base64url")}.s`;
    const home = await mkdtemp(join(tmpdir(), "memento-codex-quota-"));
    try {
      await mkdir(join(home, ".codex"));
      const write = (tokens: Record<string, string>) =>
        writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ tokens }), "utf8");

      // Real lifetimes: id_token 1 h, access_token 240 h; the CLI renews both on its next run
      await write({ id_token: jwt(-57 * 3600), access_token: jwt(182 * 3600), refresh_token: "r" });
      let quota = await probeCodexQuota(home);
      expect(quota.available).toBe(true);
      expect(quota.logged_in).toBe(true);

      await write({ id_token: jwt(-3600), access_token: jwt(-3600), refresh_token: "r" });
      expect((await probeCodexQuota(home)).logged_in).toBe(true);

      await write({ id_token: jwt(-3600), access_token: jwt(-3600) });
      quota = await probeCodexQuota(home);
      expect(quota.logged_in).toBe(false);
      expect(quota.error).toContain("codex");
    } finally {
      await rm(home, { recursive: true, force: true });
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

describe("usageLimitMessage", () => {
  it("reads the quota message Claude Code and Codex end on", () => {
    expect(usageLimitMessage("x\nYou've hit your session limit · resets 11:40am (Asia/Shanghai)\n")).toBe(
      "You've hit your session limit · resets 11:40am (Asia/Shanghai)",
    );
    expect(usageLimitMessage("You’ve hit your weekly limit · resets Nov 3")).toBe("You’ve hit your weekly limit · resets Nov 3");
    expect(usageLimitMessage("Claude AI usage limit reached|1761710400")).toBe("usage limit reached|1761710400");
  });

  it("stays quiet for other failures", () => {
    expect(usageLimitMessage("API Error: 529 overloaded")).toBeUndefined();
    // Antigravity's quota is per model and another one goes on (agy-models.ts)
    expect(usageLimitMessage("Individual quota reached. Resets in 58h12m23s.")).toBeUndefined();
    expect(usageLimitMessage("Prompt is too long")).toBeUndefined();
    expect(usageLimitMessage("")).toBeUndefined();
  });
});

describe("quota reads that stay readable", () => {
  it("names the Claude plan, not its rate tier", () => {
    expect(claudePlanTier("pro", "default_claude_ai")).toBe("PRO");
    expect(claudePlanTier(undefined, "default_claude_ai")).toBe("PRO");
    expect(claudePlanTier(undefined, "default_claude_max_5x")).toBe("MAX 5X");
    expect(claudePlanTier("max", "default_claude_max_20x")).toBe("MAX");
  });

  it("starts a remembered usage window over once its reset time has passed", () => {
    const now = Date.UTC(2026, 10, 13, 12);
    const usage = {
      five_hour: { utilization: 80, resets_at: new Date(now - 1000).toISOString() },
      seven_day: { utilization: 60, resets_at: new Date(now + 86_400_000).toISOString() },
    };
    const aged = agedClaudeUsage(usage, now);
    expect(aged.five_hour).toEqual({ utilization: 0, resets_at: null });
    expect(aged.seven_day.utilization).toBe(60);
  });

  it("gives every model the agy CLI offers the quota it really draws on", () => {
    const list = parseAgyModels(
      "Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n",
    );
    expect(list.map((m) => m.id)).toEqual(["gemini-4-argon-medium", "gemini-3.8-flash-high", "claude-opus-5-5-low", "gpt-oss-120b-medium"]);
    const { models, defaultId, groups } = agyCliQuotaModels({
      list,
      available: { tieredModelIds: { flashLite: ["gemini-3.5-flash-lite"], flash: ["gemini-3.8-flash-tiered"], pro: ["gemini-3.8-flash-tiered"] }, models: {} },
      quota: {
        buckets: [
          { modelId: "gemini-3.8-flash-tiered", remainingFraction: 0.95419294, resetTime: "2026-11-14T07:42:00Z" },
          { modelId: "claude-opus-5-5-low", remainingFraction: 1, resetTime: "2026-11-14T08:05:56Z" },
          { modelId: "gpt-oss-120b-medium", remainingFraction: 1, resetTime: "2026-11-14T08:05:56Z" },
        ],
      },
      summary: {
        groups: [
          {
            displayName: "Claude and GPT models",
            description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
            buckets: [
              { window: "weekly", resetTime: "2026-11-18T15:33:47Z", remainingFraction: 0.42 },
              { window: "5h", resetTime: "2026-11-14T08:05:56Z", remainingFraction: 1 },
            ],
          },
        ],
      },
    });
    expect(defaultId).toBe("gemini-4-argon-medium");
    const pct = Object.fromEntries(models.map((m) => [m.model_id, m.remaining_percent]));
    // The 3.8 Flash levels are on the tier's Flash pool; Claude and GPT on their weekly limit, not the 5-hour one;
    // Gemini 4's own quota isn't reported anywhere, so it doesn't borrow the Flash pool's
    expect(pct).toEqual({ "gemini-4-argon-medium": null, "gemini-3.8-flash-high": 95.4, "claude-opus-5-5-low": 42, "gpt-oss-120b-medium": 42 });
    expect(models.find((m) => m.model_id === "claude-opus-5-5-low")!.reset_time).toBe("2026-11-18T15:33:47Z");
    expect(groups[0]!.buckets.map((b) => b.label)).toEqual(["周额度", "5 小时额度"]);
  });
});
