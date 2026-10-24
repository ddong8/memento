import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch, isOwnUrl } from "../src/lib/api-client";

describe("authFetch sends the login only to Memento", () => {
  const store = new Map<string, string>();
  let sent: { url: string; auth?: string }[] = [];

  beforeEach(() => {
    store.clear();
    store.set("dr_token", "tok-secret");
    sent = [];
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    vi.stubGlobal("window", { location: { href: "https://mem.ihasy.com/ask", origin: "https://mem.ihasy.com", protocol: "https:", hostname: "mem.ihasy.com", port: "", pathname: "/ask" } });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      sent.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return new Response("", { status: url.includes("apple") || url.includes("/api/me") ? 401 : 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tells its own URLs from other sites'", () => {
    expect(isOwnUrl("/api/documents/x")).toBe(true);
    expect(isOwnUrl("https://mem.ihasy.com/api/ask")).toBe(true);
    expect(isOwnUrl("https://developer.apple.com/documentation/technotes/tn3179.md")).toBe(false);
  });

  it("never gives another site the token, nor logs out on its 401", async () => {
    await authFetch("https://developer.apple.com/documentation/technotes/tn3179.md");
    expect(sent[0]!.auth).toBeUndefined();
    expect(store.get("dr_token")).toBe("tok-secret");

    await authFetch("/api/documents/proxy-fetch?url=x");
    expect(sent[1]!.auth).toBe("Bearer tok-secret");

    // Memento's own 401 still ends the session
    await authFetch("/api/me");
    expect(store.has("dr_token")).toBe(false);
  });
});
