import { describe, expect, it } from "vitest";
import {
  formatExcerpt,
  formatTurnDuration,
  formatTurnTimestamp,
  interruptibleSleep,
  normalizeEpochMs,
  normalizeIsoTimestamp,
} from "../src/lib/ask/turns";

describe("turns utility functions", () => {
  it("cleans system tags and internal metadata from prompts", () => {
    const raw = `<USER_REQUEST>请优化检索功能</USER_REQUEST><ADDITIONAL_METADATA>some meta</ADDITIONAL_METADATA>`;
    expect(formatExcerpt(raw)).toBe("用户: 请优化检索功能");
  });

  it("cleans raw session meta JSON to a user-friendly label", () => {
    const rawMeta = '{"timestamp": "2026-10-18T00:00:00Z", "type": "session_meta"}';
    expect(formatExcerpt(rawMeta)).toBe("会话启动信息");
  });

  it("normalizes epoch ms across seconds and ms", () => {
    const sec = 1700000000;
    expect(normalizeEpochMs(sec)).toBe(1700000000000);
    const ms = 1700000000000;
    expect(normalizeEpochMs(ms)).toBe(1700000000000);
  });

  it("normalizes and formats ISO timestamp", () => {
    const iso = "2026-10-18T12:00:00.000Z";
    const normalized = normalizeIsoTimestamp(iso);
    expect(normalized).toBe(iso);

    const formatted = formatTurnTimestamp(iso);
    expect(formatted).not.toBeNull();
    expect(formatted?.full).toContain("2026-10-18");
  });

  it("formats turn duration correctly across ms, s, and m", () => {
    expect(formatTurnDuration(450)).toBe("450ms");
    expect(formatTurnDuration(3500)).toBe("3.5s");
    expect(formatTurnDuration(65000)).toBe("1m 5s");
  });

  it("supports interruptible sleep with early abort", async () => {
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 10);
    await interruptibleSleep(5000, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});
