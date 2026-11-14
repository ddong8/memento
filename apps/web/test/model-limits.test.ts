import { expect, it } from "vitest";

import type { AgentQuotasResponse } from "@/lib/api-client";
import { modelFamily, modelLimitLabel, modelLimitOf, modelQuotaOf } from "@/lib/ask/model-limits";

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

it("gives the quota of the model a conversation runs on, not the default model's", () => {
  const q = {
    tools: {
      antigravity: {
        tool: "antigravity", name: "Antigravity", available: true, remaining_percent: 100, default_model: "gemini-3.8-flash-high", reset_time: "2026-11-14T18:40:29Z",
        models: [
          { label: "Gemini 3.8 Flash (High)", model_id: "gemini-3.8-flash-high", remaining_percent: 100, reset_time: "2026-11-14T18:40:29Z" },
          { label: "Gemini 4 Argon (High)", model_id: "gemini-4-argon-high", remaining_percent: 20, reset_time: "2026-11-21T13:40:29Z" },
          { label: "Gemini 4 Argon (Low)", model_id: "gemini-4-argon-low", remaining_percent: 20 },
          { label: "Gemini 4 Hydrogen (High)", model_id: "gemini-4-hydrogen-high", remaining_percent: null },
        ],
        limited_models: [{ family: "gemini-4-hydrogen", model: "gemini-4-hydrogen-high", until, message: "Individual quota reached" }],
      },
      claude_code: { tool: "claude_code", name: "Claude Code", available: true, remaining_percent: 13, models: [{ label: "opus", model_id: "opus", remaining_percent: 13 }] },
    },
  } as AgentQuotasResponse;
  const argon = modelQuotaOf(q, "antigravity", "gemini-4-argon-high", NOW)!;
  expect([argon.percent, argon.label, argon.resetTime, argon.perModel]).toEqual([20, "Gemini 4 Argon (High)", "2026-11-21T13:40:29Z", true]);
  expect(modelQuotaOf(q, "antigravity", "", NOW)?.modelId).toBe("gemini-3.8-flash-high");
  // A model the device found out of quota counts as 0 until it's back
  expect(modelQuotaOf(q, "antigravity", "gemini-4-hydrogen-high", NOW)).toMatchObject({ percent: 0, perModel: true, resetTime: until });
  // An effort level not listed takes its family's figure
  expect(modelQuotaOf(q, "antigravity", "gemini-4-argon-medium", NOW)?.percent).toBe(20);
  // Claude Code shares one quota: a model name that isn't listed gets the tool's figure
  expect(modelQuotaOf(q, "claude", "claude-opus-5-5", NOW)).toMatchObject({ percent: 13, perModel: false });
  expect(modelQuotaOf(q, "codex", "gpt-6", NOW)).toBeUndefined();
});
