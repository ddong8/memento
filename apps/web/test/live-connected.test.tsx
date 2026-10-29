// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useLiveConnected (src/lib/live-events.ts). The running-tasks monitor kept its own copy of whether the
// push connection was up, taken on mount and changed only when the connection came up or dropped: one
// that came up before the monitor listened (started by another component) left it polling every 2 s
// for nine hours on 2026-10-29.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const enc = new TextEncoder();
let streams: ReadableStreamDefaultController<Uint8Array>[] = [];
let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  vi.resetModules();
  streams = [];
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "dr_token" ? "tok" : null) });
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      const body = new ReadableStream<Uint8Array>({ start: (c) => void streams.push(c) });
      resolve(new Response(body, { status: 200 }));
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

const tick = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe("useLiveConnected", () => {
  it("is true when mounted after the connection came up, and follows it after", async () => {
    const live = await import("../src/lib/live-events");
    live.onLiveEvent("notification", () => {}); // another component opens the connection
    await tick();
    expect(streams).toHaveLength(1);
    streams[0]!.enqueue(enc.encode('data: {"type":"keepalive","data":{},"timestamp":1}\n\n'));
    await tick();
    expect(live.isLiveConnected()).toBe(true);

    function Monitor() {
      return <p>{String(live.useLiveConnected())}</p>;
    }
    root = createRoot(host);
    await act(async () => root!.render(<Monitor />));
    expect(host.textContent).toBe("true");

    streams[0]!.close(); // dropped
    await tick();
    expect(host.textContent).toBe("false");
  });

  it("turns true when the connection comes up after mounting", async () => {
    const live = await import("../src/lib/live-events");
    function Monitor() {
      return <p>{String(live.useLiveConnected())}</p>;
    }
    root = createRoot(host);
    await act(async () => root!.render(<Monitor />));
    expect(host.textContent).toBe("false");
    await tick();
    expect(streams).toHaveLength(1); // the hook opens the connection itself
    streams[0]!.enqueue(enc.encode('data: {"type":"keepalive","data":{},"timestamp":1}\n\n'));
    await tick();
    expect(host.textContent).toBe("true");
  });
});
