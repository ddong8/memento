"use client";

/**
 * One live connection per tab to /api/events/stream (server-sent events). The server pushes
 * "ask_run" when a run starts or ends, "ask_run_step" when a running one moves on and "notification"
 * when one is sent, so the running-tasks monitor, the history drawer and the notification feed
 * refresh at once instead of polling every few seconds; while the connection is up their polls only
 * back it up.
 *
 * fetch, not EventSource: it sends the token in the Authorization header (EventSource can only put
 * it in the URL, which ends up in the access log).
 */

import { getApiBase } from "./api-client";

export interface LiveEvent<T = Record<string, unknown>> {
  type: string;
  data: T;
  timestamp: number;
}

type Handler = (event: LiveEvent) => void;

const handlers = new Map<string, Set<Handler>>();
const statusHandlers = new Set<(connected: boolean) => void>();
let connected = false;
let started = false;
let abort: AbortController | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 2_000;

/** Whether pushes are arriving: callers stretch their polling while this holds. */
export function isLiveConnected(): boolean {
  return connected;
}

/** Calls `handler` for each pushed event of `type`; returns the unsubscribe. */
export function onLiveEvent(type: string, handler: Handler): () => void {
  ensureStarted();
  let set = handlers.get(type);
  if (!set) handlers.set(type, (set = new Set()));
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
}

/** Calls `handler` when the connection comes up (true: catch up on what was missed) or drops. */
export function onLiveStatus(handler: (connected: boolean) => void): () => void {
  ensureStarted();
  statusHandlers.add(handler);
  return () => {
    statusHandlers.delete(handler);
  };
}

function setConnected(value: boolean): void {
  if (connected === value) return;
  connected = value;
  for (const h of statusHandlers) {
    try {
      h(value);
    } catch {
      // a listener's failure is its own
    }
  }
}

function dispatch(event: LiveEvent): void {
  const set = handlers.get(event.type);
  if (!set) return;
  for (const h of set) {
    try {
      h(event);
    } catch {
      // a listener's failure is its own
    }
  }
}

function ensureStarted(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  // Come back right away when the tab is shown again or the network returns
  const wake = () => {
    if (!connected && document.visibilityState !== "hidden") reconnectSoon(0);
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  void connect();
}

function reconnectSoon(delay: number): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (abort) return;
  const token = localStorage.getItem("dr_token");
  if (!token) {
    reconnectSoon(10_000); // not logged in yet
    return;
  }
  const ctrl = new AbortController();
  abort = ctrl;
  try {
    const res = await fetch(`${getApiBase()}/api/events/stream`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
    retryDelay = 2_000;
    setConnected(true);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // The server sends a keepalive every 30 s: silence for 75 s means the connection is gone
    let watchdog = setTimeout(() => ctrl.abort(), 75_000);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl.abort(), 75_000);
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const event = JSON.parse(data) as LiveEvent;
          if (event?.type && event.type !== "keepalive") dispatch(event);
        } catch {
          // a malformed frame is skipped
        }
      }
    }
    clearTimeout(watchdog);
  } catch {
    // dropped or refused: retried below
  } finally {
    if (abort === ctrl) abort = null;
    setConnected(false);
  }
  retryDelay = Math.min(retryDelay * 2, 60_000);
  reconnectSoon(document.visibilityState === "hidden" ? Math.max(retryDelay, 30_000) : retryDelay);
}
