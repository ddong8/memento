import { afterEach, describe, expect, it } from "vitest";

import {
  agyQuotaMessage,
  isExhausted,
  modelFamily,
  nextAgyModel,
  noteDefaultModel,
  noteQuotaExhausted,
  parseAgyModels,
  quotaResetMs,
  resetAgyQuotaState,
} from "../src/agy-models.js";

// `agy models` on vps3, 2026-11-11 (agy 1.5.5)
const LISTED = `Fetching available models...
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;
const QUOTA =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 58h12m23s.\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached."}';

afterEach(() => resetAgyQuotaState());

describe("agy model quota", () => {
  it("reads the quota message and when it resets, not a model out of capacity", () => {
    expect(agyQuotaMessage(QUOTA)).toBe("Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 58h12m23s.");
    expect(agyQuotaMessage("RESOURCE_EXHAUSTED (code 503): No capacity available")).toBeUndefined();
    expect(quotaResetMs("Resets in 58h12m23s.")).toBe(((58 * 60 + 12) * 60 + 23) * 1000);
    expect(quotaResetMs("Resets in 1d2h")).toBe(26 * 3_600_000);
    expect(quotaResetMs("no time")).toBeUndefined();
  });

  it("lists the CLI's models and groups thinking levels into one family", () => {
    const models = parseAgyModels(LISTED);
    expect(models).toHaveLength(10);
    expect(models[0]).toEqual({ id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" });
    expect(modelFamily("gemini-4-argon-high")).toBe("gemini-4-argon");
    expect(modelFamily("claude-opus-5-5-low")).toBe("claude-opus-5-5");
    expect(modelFamily("gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  it("goes on with the next family at the asked thinking level", () => {
    const models = parseAgyModels(LISTED);
    expect(nextAgyModel(models, "gemini-4-argon-medium")?.id).toBe("gemini-3.8-flash-medium");
    expect(nextAgyModel(models, "gemini-4-argon-low", "high")?.id).toBe("gemini-3.8-flash-high");
    expect(nextAgyModel(models, "gemini-4-argon-low", "max")?.id).toBe("gemini-3.8-flash-high");
    // A family without the level: medium, else its first
    noteQuotaExhausted("gemini-3.8-flash-low", "Resets in 1h");
    expect(nextAgyModel(models, "gemini-4-argon-low", "high")?.id).toBe("claude-opus-5-5-medium");
  });

  it("skips models out of quota until they reset, the CLI default included", () => {
    const models = parseAgyModels(LISTED);
    const now = Date.now();
    noteDefaultModel("gemini-4-argon-medium");
    noteQuotaExhausted("", "Resets in 2h", now);
    expect(isExhausted("", now)).toBe(true);
    expect(isExhausted("gemini-4-argon-high", now)).toBe(true);
    expect(isExhausted("gemini-3.8-flash-medium", now)).toBe(false);
    noteQuotaExhausted("gemini-3.8-flash-medium", "Resets in 5m", now);
    expect(nextAgyModel(models, "", "", now)?.id).toBe("claude-opus-5-5-medium");
    // Reset: usable again
    expect(isExhausted("gemini-4-argon-medium", now + 3 * 3_600_000)).toBe(false);
    // All out: none
    for (const m of models) noteQuotaExhausted(m.id, "Resets in 1h", now);
    expect(nextAgyModel(models, "", "", now)).toBeUndefined();
  });
});
