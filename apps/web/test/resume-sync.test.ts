import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression tests for resume sync speed:
// 1) listAskConversations(..., { skipCache: true }) bypasses the 60s in-memory _cache on app wake.
// 2) timeoutMs aborts half-open / hung sockets cleanly on listAskConversations & getAskRunStatus.
// 3) getAskRunStatus(..., { force: true }) & listAskRuns(..., { force: true }) bypass stale pre-background promises.

let fetchCalls = 0;
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  fetchCalls = 0;
  fetchImpl = async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "dr_token" ? "tok" : null), removeItem: () => {} });
  vi.stubGlobal("window", {
    location: { href: "https://mem.ihasy.com/ask", origin: "https://mem.ihasy.com", protocol: "https:", hostname: "mem.ihasy.com", port: "", pathname: "/ask" },
  });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetchCalls += 1;
    return fetchImpl(url, init);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("resume sync cache & timeout guards", () => {
  it("bypasses the 60s apiFetch cache when listAskConversations is called with skipCache: true", async () => {
    let seq = 0;
    fetchImpl = async () => {
      seq += 1;
      return new Response(JSON.stringify([{ id: `c-${seq}`, title: `Chat ${seq}` }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const { api } = await import("../src/lib/api-client");

    const first = await api.listAskConversations(undefined, 500);
    expect(first[0]?.id).toBe("c-1");
    expect(fetchCalls).toBe(1);

    // Without skipCache, cached within 60s
    const cached = await api.listAskConversations(undefined, 500);
    expect(cached[0]?.id).toBe("c-1");
    expect(fetchCalls).toBe(1);

    // With skipCache: true (used on app resume), hits server immediately and gets fresh data
    const fresh = await api.listAskConversations(undefined, 500, undefined, { skipCache: true, timeoutMs: 8000 });
    expect(fresh[0]?.id).toBe("c-2");
    expect(fetchCalls).toBe(2);
  });

  it("aborts hung listAskConversations and getAskRunStatus requests when timeoutMs elapses", async () => {
    fetchImpl = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });

    const { api } = await import("../src/lib/api-client");

    const listPromise = api.listAskConversations(undefined, 500, undefined, { skipCache: true, timeoutMs: 100 });
    const listExpect = expect(listPromise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(120);
    await listExpect;

    const runPromise = api.getAskRunStatus("conv-hung", undefined, { force: true, timeoutMs: 100 });
    const runExpect = expect(runPromise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(120);
    await runExpect;
  });

  it("bypasses stale pre-background shared run promises when force: true is passed", async () => {
    let resolveFirst!: (r: Response) => void;
    let callIdx = 0;
    fetchImpl = () => {
      callIdx += 1;
      if (callIdx === 1) {
        return new Promise<Response>((r) => {
          resolveFirst = r;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify([{ conversation_id: "c1", done: true }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const { api } = await import("../src/lib/api-client");
    // Pre-background call hangs on a half-open socket
    const staleCall = api.listAskRuns(300);
    expect(fetchCalls).toBe(1);

    // App resumes and calls with force: true -> launches fresh request immediately without waiting for staleCall
    const freshRuns = await api.listAskRuns(300, { force: true });
    expect(fetchCalls).toBe(2);
    expect(freshRuns).toHaveLength(1);
    expect(freshRuns[0]?.done).toBe(true);

    resolveFirst(new Response("[]", { status: 200 }));
    await staleCall;
  });
});
