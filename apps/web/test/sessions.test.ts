import { describe, expect, it } from "vitest";

import { formatContextTokens, isJunkSessionTitle, resumeCostNotes } from "@/lib/ask/sessions";
import type { SessionResumeCost } from "@/lib/api-client";

const cost = (over: Partial<SessionResumeCost>): SessionResumeCost => ({
  context_tokens: 342_668,
  heavy: true,
  last_client: "Memento",
  minutes_since_activity: 600,
  other_client_recent: false,
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
    expect(notes[1]).toContain("智能瘦身续接");
    expect(resumeCostNotes(cost({}), false, true)[1]).toContain("建议智能瘦身续接");
  });

  it("another client just used it: its cache isn't shared", () => {
    const notes = resumeCostNotes(cost({ other_client_recent: true, cache_cold: false, minutes_since_activity: 3, last_client: "VS Code", heavy: false }), false, true);
    expect(notes).toEqual(["3 分钟前刚在 VS Code 里用过：两边的缓存不通用，第一步要重新缓存全部上下文（约 34 万 token）。"]);
  });

  it("a light, warm session needs no note", () => {
    expect(resumeCostNotes(cost({ heavy: false, cache_cold: false, context_tokens: 40_000 }), false, true)).toEqual([]);
    expect(resumeCostNotes(null, false, true)).toEqual([]);
  });
});
