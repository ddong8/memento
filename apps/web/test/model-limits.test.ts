import { expect, it } from "vitest";

import type { AgentQuotasResponse } from "@/lib/api-client";
import { modelFamily, modelLimitLabel, modelLimitOf } from "@/lib/ask/model-limits";

const NOW = Date.parse("2026-11-12T08:00:00Z");
const until = new Date(NOW + 3 * 3_600_000).toISOString();
const quotas = {
  tools: {
    claude_code: { tool: "claude_code", name: "Claude Code", available: true, default_model: "claude-opus-5-5", limited_models: [{ family: "opus", model: "claude-opus-5-5", until, message: "You've hit your Opus limit" }] },
    antigravity: { tool: "antigravity", name: "Antigravity", available: true, limited_models: [{ family: "gemini-4-pro", model: "gemini-4-pro-high", until, message: "Individual quota reached" }] },
  },
} as AgentQuotasResponse;

it("marks every model of a family that ran out, the default one by the model it runs", () => {
  expect(modelFamily("antigravity", "Gemini-4-Pro-Low")).toBe("gemini-4-pro");
  expect(modelLimitOf(quotas, "claude", "opus", NOW)?.family).toBe("opus");
  expect(modelLimitOf(quotas, "claude", "", NOW)?.family).toBe("opus");
  expect(modelLimitOf(quotas, "claude", "sonnet", NOW)).toBeUndefined();
  expect(modelLimitOf(quotas, "antigravity", "gemini-4-pro-low", NOW)?.model).toBe("gemini-4-pro-high");
  expect(modelLimitOf(quotas, "antigravity", "", NOW)).toBeUndefined();
  expect(modelLimitOf(quotas, "codex", "gpt-6", NOW)).toBeUndefined();
  expect(modelLimitOf(quotas, "claude", "opus", NOW + 4 * 3_600_000)).toBeUndefined();
});

it("says roughly when it's back", () => {
  const limit = modelLimitOf(quotas, "claude", "opus", NOW)!;
  expect(modelLimitLabel(limit, true, NOW)).toBe("额度用完·约 3 小时后恢复");
  expect(modelLimitLabel(limit, true, NOW + 3 * 3_600_000 - 20 * 60_000)).toBe("额度用完·约 20 分钟后恢复");
  expect(modelLimitLabel(limit, false, NOW)).toBe("out of quota · ~3h");
});

it("a model the account can't use says so, not when it's back", () => {
  const limit = { family: "gpt-6-astra", model: "gpt-6-astra", until: new Date(NOW + 86_400_000).toISOString(), message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." };
  expect(modelLimitLabel(limit, true, NOW)).toBe("账号不支持");
});
