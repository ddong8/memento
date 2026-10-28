import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Run status shared between its askers (src/lib/api-client.ts). On 2026-10-28 an iPhone coming back to
// the chat page asked the open conversation's /run 3–6 times and /runs 4 times in the same second: the
// page's watchdog and loader, the runs monitor, the history drawer and the push connection each asked
// on their own, once per wake event (visibilitychange, focus, the app's two).

let sent: string[] = [];
let reply: (url: string) => Response | Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  sent = [];
  reply = (url) =>
    new Response(JSON.stringify(url.includes("/runs") ? [] : { conversation_id: "c1", done: false }), { status: 200 });
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "dr_token" ? "tok" : null), removeItem: () => {} });
  vi.stubGlobal("window", {
    location: { href: "https://mem.ihasy.com/ask", origin: "https://mem.ihasy.com", protocol: "https:", hostname: "mem.ihasy.com", port: "", pathname: "/ask" },
  });
  vi.stubGlobal("fetch", async (url: string) => {
    sent.push(url.replace("https://mem.ihasy.com", ""));
    return reply(url);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a conversation's run status", () => {
  it("is one request for everyone asking within 2 s, a new one after", async () => {
    const { api } = await import("../src/lib/api-client");
    const [a, b] = await Promise.all([api.getAskRunStatus("c1"), api.getAskRunStatus("c1")]);
    vi.advanceTimersByTime(1500);
    const c = await api.getAskRunStatus("c1");
    expect(sent).toEqual(["/api/ask/conversations/c1/run"]);
    expect(a.run?.conversation_id).toBe("c1");
    expect(b).toEqual(a);
    expect(c).toEqual(a);

    // Another conversation is its own
    await api.getAskRunStatus("c2");
    vi.advanceTimersByTime(600);
    await api.getAskRunStatus("c1");
    expect(sent).toEqual(["/api/ask/conversations/c1/run", "/api/ask/conversations/c2/run", "/api/ask/conversations/c1/run"]);
  });

  it("tells none held (404) from the server's trouble, and doesn't share the trouble", async () => {
    const { api } = await import("../src/lib/api-client");
    reply = () => new Response("no run", { status: 404 });
    expect(await api.getAskRunStatus("c1")).toEqual({ ok: true, run: null });

    reply = () => new Response("oops", { status: 502 });
    expect(await api.getAskRunStatus("c2")).toEqual({ ok: false, run: null });
    reply = () => Promise.reject(new TypeError("Load failed"));
    await expect(api.getAskRunStatus("c2")).rejects.toThrow("Load failed");
    reply = () => new Response(JSON.stringify({ conversation_id: "c2", done: true }), { status: 200 });
    expect((await api.getAskRunStatus("c2")).run?.done).toBe(true);
    expect(sent.filter((u) => u.includes("c2"))).toHaveLength(3);
  });

  it("is asked again once forgotten (a run started, stopped or pushed as changed)", async () => {
    const { api, forgetRunStatus } = await import("../src/lib/api-client");
    await api.getAskRunStatus("c1");
    forgetRunStatus("c1");
    await api.getAskRunStatus("c1");
    await api.listAskRuns(20);
    forgetRunStatus();
    await api.getAskRunStatus("c1");
    await api.listAskRuns(20);
    expect(sent).toEqual([
      "/api/ask/conversations/c1/run",
      "/api/ask/conversations/c1/run",
      "/api/ask/runs?recent=20",
      "/api/ask/conversations/c1/run",
      "/api/ask/runs?recent=20",
    ]);
  });

  it("lets one asker stop waiting without cancelling it for the others", async () => {
    const { api } = await import("../src/lib/api-client");
    let answer!: (r: Response) => void;
    reply = () => new Promise<Response>((r) => (answer = r));
    const ctrl = new AbortController();
    const mine = api.getAskRunStatus("c1", ctrl.signal);
    const theirs = api.getAskRunStatus("c1");
    ctrl.abort();
    await expect(mine).rejects.toMatchObject({ name: "AbortError" });
    answer(new Response(JSON.stringify({ conversation_id: "c1", done: false }), { status: 200 }));
    expect((await theirs).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("the run list", () => {
  it("answers a shorter look back from a longer one, not the other way", async () => {
    const { api } = await import("../src/lib/api-client");
    await api.listAskRuns(300);
    await api.listAskRuns(20);
    await api.listAskRuns(0);
    expect(sent).toEqual(["/api/ask/runs?recent=300"]);

    vi.advanceTimersByTime(2500);
    await api.listAskRuns(20);
    await api.listAskRuns(300);
    expect(sent).toEqual(["/api/ask/runs?recent=300", "/api/ask/runs?recent=20", "/api/ask/runs?recent=300"]);
  });

  it("is forgotten when a run start or end is pushed", async () => {
    const enc = new TextEncoder();
    let push!: ReadableStreamDefaultController<Uint8Array>;
    reply = (url) => {
      if (url.includes("/api/events/stream")) {
        return new Response(new ReadableStream<Uint8Array>({ start: (c) => void (push = c) }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    };
    const noop = () => {};
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: noop, removeEventListener: noop });
    vi.stubGlobal("window", {
      location: { href: "https://mem.ihasy.com/ask", origin: "https://mem.ihasy.com", protocol: "https:", hostname: "mem.ihasy.com", port: "", pathname: "/ask" },
      addEventListener: noop,
      removeEventListener: noop,
    });
    const { api } = await import("../src/lib/api-client");
    const live = await import("../src/lib/live-events");
    const got: string[] = [];
    live.onLiveEvent("ask_run", (e) => got.push(String(e.data.conversation_id)));
    await vi.advanceTimersByTimeAsync(0);

    await api.listAskRuns(20);
    await api.listAskRuns(20);
    push.enqueue(enc.encode(`id: 1\ndata: ${JSON.stringify({ type: "ask_run", data: { conversation_id: "c1", done: true } })}\n\n`));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(["c1"]);
    await api.listAskRuns(20);
    expect(sent.filter((u) => u.startsWith("/api/ask/runs"))).toEqual(["/api/ask/runs?recent=20", "/api/ask/runs?recent=20"]);
  });
});
