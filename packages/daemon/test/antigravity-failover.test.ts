import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { finalTrajectoryError, getModelCandidates, isTransientError, thinkingHeartbeat } from "../src/agy-runner/runner.js";

describe("Antigravity Failover and Transient Retry Logic", () => {
  it("verifies getModelCandidates ordering for default, flash, and pro tiers", () => {
    expect(getModelCandidates("")).toEqual(["flash", "pro", "flash_lite"]);
    expect(getModelCandidates("gemini-3.8-flash")).toEqual(["flash", "pro", "flash_lite"]);
    expect(getModelCandidates("gemini-4-argon-medium")).toEqual(["gemini-4-argon-medium", "pro", "flash", "flash_lite"]);
    expect(getModelCandidates("gemini-4-argon-high")).toEqual(["gemini-4-argon-high", "pro", "flash", "flash_lite"]);
    expect(getModelCandidates("claude-opus-5-5-high")).toEqual(["claude-opus-5-5-high", "pro", "flash", "flash_lite"]);
    expect(getModelCandidates("gemini-3.8-flash-high")).toEqual(["gemini-3.8-flash-high", "flash", "pro", "flash_lite"]);
    expect(getModelCandidates("pro")).toEqual(["pro", "flash", "flash_lite"]);
    expect(getModelCandidates("flash_lite")).toEqual(["flash_lite", "flash", "pro"]);
    expect(getModelCandidates(" Gemini-2.5-Flash-Lite ")).toEqual(["flash_lite", "flash", "pro"]);
    expect(getModelCandidates("some-lite-model")).toEqual(["some-lite-model", "flash_lite", "flash", "pro"]);
  });

  it("verifies isTransientError handles 503 capacity and all attempt numbers", () => {
    // All attempt numbers must be considered transient
    expect(isTransientError("API error (attempt 1): UNAVAILABLE")).toBe(true);
    expect(isTransientError("API error (attempt 3): UNAVAILABLE")).toBe(true);
    expect(
      isTransientError("API error (attempt 7): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-tiered on the server"),
    ).toBe(true);
    // Out of quota for hours: not something to wait on, unless the server says it's retrying
    expect(isTransientError("RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 54h11m34s.")).toBe(false);
    expect(isTransientError("API error (attempt 2): RESOURCE_EXHAUSTED (code 429): Individual quota reached")).toBe(true);
    expect(isTransientError("RESOURCE_EXHAUSTED (code 429): rate limit, try again")).toBe(true);
    expect(isTransientError("Service Unavailable 503")).toBe(true);

    // Permanent errors must return false
    expect(isTransientError("Invalid conversation ID: ead11d5b")).toBe(false);
    expect(isTransientError("Authentication failed: invalid token")).toBe(false);
    expect(isTransientError("")).toBe(false);
  });

  it("keeps a live run going however long the model takes, with an honest status line", () => {
    expect(thinkingHeartbeat(25, [])).toBe("⏳ [模型思考推理中（已用时 25s），请稍候...]");
    expect(thinkingHeartbeat(625, [])).toContain("远端模型可能在排队重试");
    expect(thinkingHeartbeat(130, ["zsh -c npm run build && npm test"])).toBe("⏳ [命令执行中（已用时 130s）：npm run build && npm test]");
    expect(thinkingHeartbeat(5, [`/bin/bash -c ${"很长的命令".repeat(20)}`])).toBe(`⏳ [命令执行中（已用时 5s）：${"很长的命令".repeat(12)}]`);
    // no more cutting off a live run for thinking long
    expect(readFileSync(fileURLToPath(new URL("../src/agy-runner/runner.ts", import.meta.url)), "utf8")).not.toContain("模型思考超过 600s");
  });

  it("dynamically discovers Gemini 4 Argon and active default model from Antigravity Language Server RPC and caches locally", async () => {
    const http = await import("node:http");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { antigravityCapabilities } = await import("../src/capabilities.js");

    const tempHome = await mkdtemp(join(tmpdir(), "memento-agy-caps-"));
    const server = http.createServer((req, res) => {
      if (req.url === "/exa.language_server_pb.LanguageServerService/GetUserStatus") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            userStatus: {
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    label: "Gemini 4 Argon (Medium)",
                    modelId: "gemini-4-argon-medium",
                    modelOrAlias: { model: "MODEL_PLACEHOLDER_M418" },
                    tagTitle: "New",
                    quotaInfo: { remainingFraction: 0.42 },
                  },
                  {
                    label: "Gemini 4 Argon (High)",
                    modelId: "gemini-4-argon-high",
                    modelOrAlias: { model: "MODEL_PLACEHOLDER_M417" },
                    tagTitle: "New",
                    quotaInfo: { remainingFraction: 0.42 },
                  },
                  {
                    label: "Claude Opus 5.5 (High)",
                    modelId: "claude-opus-5-5-high",
                    modelOrAlias: { model: "MODEL_PLACEHOLDER_M402" },
                    quotaInfo: { remainingFraction: 0.8 },
                  },
                ],
                defaultOverrideModelConfig: {
                  modelOrAlias: { model: "MODEL_PLACEHOLDER_M418" },
                },
              },
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port as number;

    try {
      const caps = await antigravityCapabilities("/usr/local/bin/agy", tempHome, async () => ({
        pid: 1234,
        port,
        csrf: "test-token",
      }));
      expect(caps.default_model).toBe("gemini-4-argon-medium");
      const models = caps.models as Array<{ id: string; name: string }>;
      expect(models[0]?.id).toBe("");
      expect(models[0]?.name).toContain("Gemini 4 Argon (Medium)");
      expect(models.some((m) => m.id === "gemini-4-argon-medium")).toBe(true);
      expect(models.some((m) => m.id === "gemini-4-argon-high")).toBe(true);
      expect(models.some((m) => m.id === "claude-opus-5-5-high")).toBe(true);

      // Verify offline cache fallback when Language Server is closed
      const offlineCaps = await antigravityCapabilities("/usr/local/bin/agy", tempHome, async () => undefined);
      expect(offlineCaps.default_model).toBe("gemini-4-argon-medium");
      const offlineModels = offlineCaps.models as Array<{ id: string; name: string }>;
      expect(offlineModels.some((m) => m.id === "gemini-4-argon-medium")).toBe(true);
    } finally {
      server.close();
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

describe("a trajectory that ends on an error", () => {
  // As Antigravity's language server returned it on 11-12, when the transcript held only the question
  const quotaStep = {
    type: "CORTEX_STEP_TYPE_ERROR_MESSAGE",
    status: "CORTEX_STEP_STATUS_DONE",
    errorMessage: {
      error: {
        userErrorMessage: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 49h37m40s.",
        modelErrorMessage: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 49h37m40s.",
        errorCode: 429,
      },
      shouldShowUser: true,
    },
  };
  const question = { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE" };

  it("is the run's failure when it's the last step and not a retry", () => {
    expect(finalTrajectoryError([question, quotaStep])).toBe(
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 49h37m40s.",
    );
  });

  it("isn't while the run goes on, or the server retries", () => {
    expect(finalTrajectoryError([question])).toBe("");
    expect(finalTrajectoryError([question, quotaStep, { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", status: "CORTEX_STEP_STATUS_DONE" }])).toBe("");
    const retrying = { ...quotaStep, errorMessage: { error: { modelErrorMessage: "API error (attempt 2): UNAVAILABLE (code 503): No capacity available" } } };
    expect(finalTrajectoryError([question, retrying])).toBe("");
  });
});
