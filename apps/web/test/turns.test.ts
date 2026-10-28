import { describe, expect, it } from "vitest";
import {
  formatExcerpt,
  formatTurnDuration,
  formatTurnTimestamp,
  interruptibleSleep,
  mergeFinishedTurns,
  normalizeEpochMs,
  normalizeIsoTimestamp,
  turnsChanged,
  type Turn,
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
    // Chinese by default
    expect(formatTurnDuration(450)).toBe("450ms");
    expect(formatTurnDuration(3500)).toBe("3.5秒");
    expect(formatTurnDuration(65000)).toBe("1分5秒");
    expect(formatTurnDuration(120000)).toBe("2分钟");
    // English keeps minutes and seconds together on one line
    expect(formatTurnDuration(3500, undefined, undefined, false)).toBe("3.5s");
    expect(formatTurnDuration(65000, undefined, undefined, false)).toBe("1m 5s");
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

describe("mergeFinishedTurns", () => {
  const call = { name: "run_on_device", args: { command: "ls" } };

  it("keeps the streamed reply and tool calls the saved turn does not have yet", () => {
    const shown: Turn[] = [
      { role: "user", content: "看下目录" },
      { role: "assistant", content: "目录里有三个文件", toolCalls: [call] },
    ];
    const saved: Turn[] = [
      { role: "user", content: "看下目录", created_at: "2026-10-28T08:00:00Z" },
      { role: "assistant", content: "", created_at: "2026-10-28T08:00:05Z" },
    ];
    const merged = mergeFinishedTurns(shown, saved);
    expect(merged[0]).toBe(saved[0]);
    expect(merged[1]).toMatchObject({ content: "目录里有三个文件", toolCalls: [call], created_at: "2026-10-28T08:00:05Z" });
    // Neither input is changed: a 304 hands back the cached object
    expect(saved[1].content).toBe("");
    expect(saved[1].toolCalls).toBeUndefined();
  });

  it("takes the saved turns as they are when they have the reply", () => {
    const shown: Turn[] = [{ role: "assistant", content: "半截回" }];
    const saved: Turn[] = [{ role: "assistant", content: "完整回答", toolCalls: [call] }];
    expect(mergeFinishedTurns(shown, saved)).toBe(saved);
  });

  it("does not carry a reply over to a different kind of turn", () => {
    const shown: Turn[] = [{ role: "assistant", content: "上一个对话的回答" }];
    const saved: Turn[] = [{ role: "user", content: "新问题" }];
    expect(mergeFinishedTurns(shown, saved)).toBe(saved);
    expect(mergeFinishedTurns([], saved)).toBe(saved);
  });
});

describe("turnsChanged", () => {
  const turn = (role: Turn["role"], content: string, at: string): Turn => ({ role, content, created_at: at });
  const shown = [turn("user", "问", "t1"), turn("assistant", "答", "t2")];

  it("sees nothing new in the same turns", () => {
    expect(turnsChanged(shown, shown.map((t) => ({ ...t })), 30)).toBe(false);
  });

  it("sees a turn added or the last reply grown", () => {
    expect(turnsChanged(shown, [...shown, turn("user", "再问", "t3")], 30)).toBe(true);
    expect(turnsChanged(shown, [shown[0], turn("assistant", "答得更长了", "t2")], 30)).toBe(true);
    expect(turnsChanged(shown, [shown[0], { ...shown[1], error: true }], 30)).toBe(true);
  });

  it("compares the tail when earlier history was loaded on top", () => {
    const older = Array.from({ length: 4 }, (_, i) => turn(i % 2 ? "assistant" : "user", `早${i}`, `e${i}`));
    // The screen holds 6 turns, the saved page only the last 2 of a limit of 2
    expect(turnsChanged([...older, ...shown], shown, 2)).toBe(false);
    expect(turnsChanged([...older, ...shown], [shown[0], turn("assistant", "新答", "t9")], 2)).toBe(true);
  });

  it("sees turns removed while everything fits in one page", () => {
    expect(turnsChanged(shown, [shown[0]], 30)).toBe(true);
  });
});
