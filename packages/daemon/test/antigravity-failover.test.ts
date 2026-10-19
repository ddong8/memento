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
});
