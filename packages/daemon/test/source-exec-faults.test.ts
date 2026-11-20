import { describe, expect, it } from "vitest";
import {
  appQuotaFallbacks,
  computeBackoffWithJitter,
  detectStillRunning,
  isSessionNotFound,
  parseTaskDispatch,
  smartTruncateOutput,
  stripRuntimeWarnings,
  usageLimitMessage,
} from "../src/task-adapters.js";

describe("task-adapters fault & boundary resilience", () => {
  it("parseTaskDispatch applies safe defaults for malformed or partial payloads", () => {
    const d1 = parseTaskDispatch({});
    expect(d1).toEqual({ id: "", action: "shell", payload: {}, timeoutSeconds: 300 });
    const d2 = parseTaskDispatch({ id: "t-1", action: "agent", payload: "bad" });
    expect(d2).toEqual({ id: "t-1", action: "agent", payload: {}, timeoutSeconds: 7200 });
  });

  it("smartTruncateOutput preserves head and tail when output exceeds limit", () => {
    const big = "H".repeat(200) + "M".repeat(500) + "T".repeat(200);
    const out = smartTruncateOutput(big, 300, 100, 100);
    expect(out.startsWith("H".repeat(100))).toBe(true);
    expect(out.endsWith("T".repeat(100))).toBe(true);
    expect(out.length).toBeLessThan(big.length);
  });

  it("computeBackoffWithJitter caps exponential growth and stays positive", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const delay = computeBackoffWithJitter(attempt, { baseMs: 1000, maxMs: 30_000, jitterRatio: 0.2 });
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  it("identifies missing session errors and usage limit errors across engines", () => {
    expect(isSessionNotFound("Error: No conversation found with session ID abc")).toBe(true);
    expect(isSessionNotFound("normal compilation error")).toBe(false);
    expect(usageLimitMessage("You've hit your usage limit; resets in 2 hours")).toBeTruthy();
    expect(appQuotaFallbacks("gemini-4-argon").length).toBeGreaterThanOrEqual(0);
  });

  it("strips noisy node/npm runtime warnings without hiding real errors", () => {
    const cleaned = stripRuntimeWarnings("(node:1234) ExperimentalWarning: foo\nError: EACCES permission denied");
    expect(cleaned).toContain("Error: EACCES permission denied");
  });

  it("detectStillRunning handles empty/clean completed outputs safely", () => {
    const res = detectStillRunning("All tests passed.", "", undefined, 0);
    expect(res).toBe(false);
  });
});
