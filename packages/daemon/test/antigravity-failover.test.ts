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
});
