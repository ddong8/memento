// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});

// A conversation deleted on the server (elsewhere, or by a clean-up) kept opening from the cache on
// every start (11-17): everything this device keeps of it goes.
describe("forgetting a conversation that is gone", () => {
  it("drops its turns, its list entry, the last-opened id and the snapshot", async () => {
    const { CONVERSATIONS_CACHE_KEY, conversationTurnsCache, forgetConversation, getLocalConvSnapshot, saveLocalConvSnapshot, saveToRecentConvTurnsCache } =
      await import("../src/lib/ask/cache");
    const turns = [{ role: "user", content: "hi" }] as never[];
    saveToRecentConvTurnsCache("gone", turns);
    saveToRecentConvTurnsCache("kept", turns);
    localStorage.setItem(CONVERSATIONS_CACHE_KEY, JSON.stringify([{ id: "gone" }, { id: "kept" }]));
    localStorage.setItem("memento_last_ask_conv_id", "gone");
    saveLocalConvSnapshot({ id: "gone", turns });
    expect(getLocalConvSnapshot()?.id).toBe("gone");

    forgetConversation("gone");
    expect(conversationTurnsCache.has("gone")).toBe(false);
    expect(conversationTurnsCache.has("kept")).toBe(true);
    expect(JSON.parse(localStorage.getItem(CONVERSATIONS_CACHE_KEY)!)).toEqual([{ id: "kept" }]);
    expect(localStorage.getItem("memento_last_ask_conv_id")).toBeNull();
    expect(getLocalConvSnapshot()).toBeNull();
  });
});
