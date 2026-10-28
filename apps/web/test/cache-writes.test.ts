import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Turn } from "../src/lib/ask/turns";

// A browser just big enough for the cache module: localStorage, and page events that are never fired
function stubBrowser() {
  const store = new Map<string, string>();
  const setItem = vi.fn((k: string, v: string) => void store.set(k, v));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem,
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  });
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
  return { store, setItem };
}

const SNAPSHOT = "memento_last_conv_snapshot_v2";
const RECENT = "memento_recent_conv_turns_cache_v1";

describe("ask cache writes to localStorage", () => {
  let browser: ReturnType<typeof stubBrowser>;
  let cache: typeof import("../src/lib/ask/cache");

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    browser = stubBrowser();
    cache = await import("../src/lib/ask/cache");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("writes the snapshot later, once, with long tool output cut", () => {
    const longOut = "x".repeat(20_000);
    const turns: Turn[] = [
      { role: "user", content: "跑一下测试" },
      { role: "assistant", content: "跑完了", toolCalls: [{ name: "run_on_device", args: {}, result: { stdout: longOut } }] },
    ];
    cache.saveLocalConvSnapshot({ id: "c1", turns });
    cache.saveLocalConvSnapshot({ id: "c1", turns, totalTurns: 2 });
    expect(browser.setItem).not.toHaveBeenCalled();
    // The screen keeps the whole output
    expect(cache.conversationTurnsCache.get("c1")?.turns[1].toolCalls?.[0].result?.stdout).toHaveLength(20_000);

    vi.advanceTimersByTime(300);
    expect(browser.setItem).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(browser.store.get(SNAPSHOT)!);
    expect(saved.totalTurns).toBe(2);
    expect(saved.turns[1].toolCalls[0].result.stdout).toHaveLength(8000);
  });

  it("reads back a snapshot that is still waiting to be written", () => {
    cache.saveLocalConvSnapshot({ id: "c2", turns: [{ role: "user", content: "你好" }] });
    expect(cache.getLocalConvSnapshot()?.id).toBe("c2");
  });

  it("does not bring back a snapshot cleared for a new chat", () => {
    cache.saveLocalConvSnapshot({ id: "c3", turns: [{ role: "user", content: "旧对话" }] });
    cache.clearLocalConvSnapshot();
    vi.advanceTimersByTime(300);
    expect(browser.store.has(SNAPSHOT)).toBe(false);
    expect(cache.getLocalConvSnapshot()).toBeNull();
  });

  it("keeps the ten most recent conversations, latest first", () => {
    for (let i = 0; i < 12; i++) {
      cache.saveToRecentConvTurnsCache(`r${i}`, [{ role: "user", content: `问题${i}` }]);
    }
    cache.saveToRecentConvTurnsCache("r3", [{ role: "user", content: "问题3 又打开" }]);
    expect(browser.setItem).not.toHaveBeenCalled();
    cache.flushAskCacheWrites();
    const list = JSON.parse(browser.store.get(RECENT)!);
    expect(list).toHaveLength(10);
    expect(list[0]).toMatchObject({ id: "r3", turns: [{ content: "问题3 又打开" }] });
    expect(list.map((e: { id: string }) => e.id)).not.toContain("r0");
  });
});
