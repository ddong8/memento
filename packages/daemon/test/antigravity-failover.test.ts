import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const agyCliPath = fileURLToPath(new URL("../assets/agy_cli.py", import.meta.url));

describe("Antigravity Failover and Transient Retry Logic", () => {
  it("verifies get_model_candidates ordering for default, flash, and pro tiers", () => {
    const script = `
import sys
sys.path.insert(0, sys.argv[1])
from agy_cli import get_model_candidates

assert get_model_candidates("") == ["flash", "pro", "flash_lite"]
assert get_model_candidates("gemini-3.8-flash") == ["flash", "pro", "flash_lite"]
assert get_model_candidates("gemini-4-argon-medium") == ["gemini-4-argon-medium", "pro", "flash", "flash_lite"]
assert get_model_candidates("gemini-4-argon-high") == ["gemini-4-argon-high", "pro", "flash", "flash_lite"]
assert get_model_candidates("claude-opus-5-5-high") == ["claude-opus-5-5-high", "pro", "flash", "flash_lite"]
assert get_model_candidates("gemini-3.8-flash-high") == ["gemini-3.8-flash-high", "flash", "pro", "flash_lite"]
assert get_model_candidates("pro") == ["pro", "flash", "flash_lite"]
assert get_model_candidates("flash_lite") == ["flash_lite", "flash", "pro"]
print("CANDIDATES_OK")
`;
    const assetsDir = join(agyCliPath, "..");
    const out = execFileSync("python3", ["-c", script, assetsDir], { encoding: "utf8" });
    expect(out.trim()).toBe("CANDIDATES_OK");
  });

  it("verifies is_transient_error handles 503 capacity and all attempt numbers", () => {
    const script = `
import sys
sys.path.insert(0, sys.argv[1])
from agy_cli import is_transient_error

# All attempt numbers must be considered transient
assert is_transient_error("API error (attempt 1): UNAVAILABLE") is True
assert is_transient_error("API error (attempt 3): UNAVAILABLE") is True
assert is_transient_error("API error (attempt 7): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-tiered on the server") is True
assert is_transient_error("RESOURCE_EXHAUSTED (code 429): Individual quota reached") is True
assert is_transient_error("Service Unavailable 503") is True

# Permanent errors must return False
assert is_transient_error("Invalid conversation ID: ead11d5b") is False
assert is_transient_error("Authentication failed: invalid token") is False
assert is_transient_error("") is False
print("TRANSIENT_OK")
`;
    const assetsDir = join(agyCliPath, "..");
    const out = execFileSync("python3", ["-c", script, assetsDir], { encoding: "utf8" });
    expect(out.trim()).toBe("TRANSIENT_OK");
  });

  it("keeps a live run going however long the model takes, with an honest status line", () => {
    const script = `
import sys
sys.path.insert(0, sys.argv[1])
from agy_cli import thinking_heartbeat

assert thinking_heartbeat(25, []) == "⏳ [模型思考推理中（已用时 25s），请稍候...]"
assert "远端模型可能在排队重试" in thinking_heartbeat(625, [])
line = thinking_heartbeat(130, ["zsh -c npm run build && npm test"])
assert line == "⏳ [命令执行中（已用时 130s）：npm run build && npm test]", line
src = open(sys.argv[1] + "/agy_cli.py", encoding="utf-8").read()
assert "模型思考超过 600s" not in src  # no more cutting off a live run for thinking long
print("HEARTBEAT_OK")
`;
    const assetsDir = join(agyCliPath, "..");
    const out = execFileSync("python3", ["-c", script, assetsDir], { encoding: "utf8" });
    expect(out.trim()).toBe("HEARTBEAT_OK");
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
