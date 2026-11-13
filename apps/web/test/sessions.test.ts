import { describe, expect, it } from "vitest";

import { formatContextTokens, isJunkSessionTitle, resumeCostNotes } from "@/lib/ask/sessions";
import type { SessionResumeCost } from "@/lib/api-client";

const cost = (over: Partial<SessionResumeCost>): SessionResumeCost => ({
  context_tokens: 342_668,
  heavy: true,
  last_client: "Memento",
  minutes_since_activity: 600,
  cache_cold: true,
  ...over,
});

describe("session resume banner", () => {
  it("sizes context in 万 / k", () => {
    expect(formatContextTokens(342_668, true)).toBe("约 34 万 token");
    expect(formatContextTokens(8_400, true)).toBe("约 8 千 token");
    expect(formatContextTokens(342_668, false)).toBe("~343k tokens");
  });

  it("titles the agent made before anything was said are skipped", () => {
    for (const v of [undefined, "", " start ", "Starting the conversation…", "新对话", "Untitled"]) expect(isJunkSessionTitle(v)).toBe(true);
    expect(isJunkSessionTitle("修复登录")).toBe(false);
  });

  it("a heavy session idle past the cache says the first step re-caches it all, and what compact means", () => {
    const notes = resumeCostNotes(cost({}), true, true);
    expect(notes[0]).toContain("缓存已过期");
    expect(notes[0]).toContain("约 34 万 token");
    expect(notes[1]).toContain("核心记忆快照新开一个会话");
    // raw, as in Claude Code: compacted in place by the model's own context
    expect(resumeCostNotes(cost({}), false, true)[1]).toContain("由 Claude Code 按模型自己的大小压缩");
  });

  it("another client just used it: the cache is shared, so nothing to warn about", () => {
    expect(resumeCostNotes(cost({ cache_cold: false, minutes_since_activity: 3, last_client: "VS Code", heavy: false }), false, true)).toEqual([]);
  });

  it("a light, warm session needs no note", () => {
    expect(resumeCostNotes(cost({ heavy: false, cache_cold: false, context_tokens: 40_000 }), false, true)).toEqual([]);
    expect(resumeCostNotes(null, false, true)).toEqual([]);
  });
});

describe("a heavy session resumed raw", () => {
  it("stays one session: Claude Code compacts it in place by its model's own context", () => {
    const warm = cost({ context_tokens: 150_575, minutes_since_activity: 1, cache_cold: false });
    expect(resumeCostNotes(warm, false, true)).toEqual([expect.stringContaining("接着在原会话里做")]);
    expect(resumeCostNotes(warm, false, true)[0]).toContain("不会新开会话");
    expect(resumeCostNotes(warm, false, false)).toEqual([expect.stringContaining("compacted by Claude Code by its model's own context")]);
  });
});
