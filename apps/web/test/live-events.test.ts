import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page's one push connection (src/lib/live-events.ts). On 2026-10-28 a desktop client polled the
// run list every 2 s for half an hour with a push request open: it was counted live only on an answer,
// and a request stuck without one was never retried.

interface Call {
  headers: Record<string, string>;
  ctrl?: ReadableStreamDefaultController<Uint8Array>;
}

const enc = new TextEncoder();
let calls: Call[] = [];
let answer = true;

function send(call: Call, frame: string) {
  call.ctrl!.enqueue(enc.encode(frame));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  calls = [];
  answer = true;
  const noop = () => {};
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "dr_token" ? "tok" : null) });
  vi.stubGlobal("window", {
    location: { href: "https://mem.ihasy.com/ask", origin: "https://mem.ihasy.com", protocol: "https:", hostname: "mem.ihasy.com", port: "", pathname: "/ask" },
    addEventListener: noop,
    removeEventListener: noop,
  });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: noop, removeEventListener: noop });
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    const call: Call = { headers: { ...(init.headers as Record<string, string>) } };
    calls.push(call);
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
        try {
          call.ctrl?.error(new DOMException("aborted", "AbortError"));
        } catch {
          // already closed
        }
      });
      if (!answer) return;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (call.ctrl = c) });
      resolve(new Response(body, { status: 200 }));
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live events", () => {
  it("counts as connected when data arrives, not when the request goes out", async () => {
    const live = await import("../src/lib/live-events");
    const got: string[] = [];
    live.onLiveEvent("ask_run", (e) => got.push(String((e.data as { conversation_id: string }).conversation_id)));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(live.isLiveConnected()).toBe(false);

    send(calls[0]!, 'data: {"type":"keepalive","data":{},"timestamp":1}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.isLiveConnected()).toBe(true);

    send(calls[0]!, 'id: 100.5\nevent: ask_run\ndata: {"type":"ask_run","data":{"conversation_id":"c1"},"timestamp":100.5}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(["c1"]);
  });

  it("gives up on a request left without an answer and opens another", async () => {
    answer = false;
    const live = await import("../src/lib/live-events");
    live.onLiveStatus(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    answer = true;
    await vi.advanceTimersByTimeAsync(12_000 + 4_000);
    expect(calls).toHaveLength(2);
    send(calls[1]!, 'data: {"type":"keepalive","data":{},"timestamp":1}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.isLiveConnected()).toBe(true);
  });

  it("reconnecting, asks only for what came after the last event it got", async () => {
    const live = await import("../src/lib/live-events");
    live.onLiveStatus(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]!.headers["Last-Event-ID"]).toBeUndefined();

    send(calls[0]!, 'data: {"type":"keepalive","data":{},"timestamp":1}\n\n');
    send(calls[0]!, 'id: 1761650000.250000\nevent: ask_run\ndata: {"type":"ask_run","data":{},"timestamp":1761650000.25}\n\n');
    await vi.advanceTimersByTimeAsync(15_000);
    calls[0]!.ctrl!.close(); // a server restart, after it was up a while

    await vi.advanceTimersByTimeAsync(600);
    expect(live.isLiveConnected()).toBe(false);
    expect(calls).toHaveLength(2); // reopened at once, no back-off
    expect(calls[1]!.headers["Last-Event-ID"]).toBe("1761650000.250000");
  });

  it("drops a connection gone silent for 50 s", async () => {
    const live = await import("../src/lib/live-events");
    live.onLiveStatus(() => {});
    await vi.advanceTimersByTimeAsync(0);
    send(calls[0]!, 'data: {"type":"keepalive","data":{},"timestamp":1}\n\n');
    await vi.advanceTimersByTimeAsync(49_000);
    expect(live.isLiveConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(live.isLiveConnected()).toBe(false);
  });

  it("reopens immediately without backoff on native app resume after backgrounding", async () => {
    const winListeners = new Map<string, Set<() => void>>();
    const docListeners = new Map<string, Set<() => void>>();
    let visState: DocumentVisibilityState = "visible";
    vi.stubGlobal("window", {
      location: { href: "https://mem.ihasy.com/ask", origin: "https://mem.ihasy.com", protocol: "https:", hostname: "mem.ihasy.com", port: "", pathname: "/ask" },
      addEventListener: (ev: string, fn: () => void) => {
        if (!winListeners.has(ev)) winListeners.set(ev, new Set());
        winListeners.get(ev)!.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => winListeners.get(ev)?.delete(fn),
    });
    vi.stubGlobal("document", {
      get visibilityState() {
        return visState;
      },
      addEventListener: (ev: string, fn: () => void) => {
        if (!docListeners.has(ev)) docListeners.set(ev, new Set());
        docListeners.get(ev)!.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => docListeners.get(ev)?.delete(fn),
    });

    const live = await import("../src/lib/live-events");
    live.onLiveStatus(() => {});
    await vi.advanceTimersByTimeAsync(0);
    send(calls[0]!, 'data: {"type":"keepalive","data":{},"timestamp":1}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.isLiveConnected()).toBe(true);

    // Switch away for 4 seconds (< 10s wasUp threshold, so backoff would be 4s without wake fast-path)
    visState = "hidden";
    for (const fn of docListeners.get("visibilitychange") ?? []) fn();
    await vi.advanceTimersByTimeAsync(4_000);

    // Return via native app active event: old frozen socket is aborted and reopened at 0ms delay
    visState = "visible";
    for (const fn of winListeners.get("memento_app_active") ?? []) fn();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(2);
    send(calls[1]!, 'data: {"type":"keepalive","data":{},"timestamp":2}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.isLiveConnected()).toBe(true);
  });
});
