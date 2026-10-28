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
 *
 * It counts as connected once data arrives (the server opens with a keepalive), not when the request
 * is sent: a request stuck without an answer left the page polling every 2 s for half an hour while it
 * thought pushes would come. Reconnecting, it sends the id of the last event it got (Last-Event-ID)
 * and the server replays only what came after.
 */

import { forgetRunStatus, getApiBase } from "./api-client";

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
let lastEventId = "";
let lastDataAt = 0;

// No answer to the request in this long: it's stuck (a connection the network dropped silently), open
// another. Longer than the server's keepalive interval (30 s), for a server that sends nothing first.
const OPEN_TIMEOUT_MS = 40_000;
// The server sends a keepalive every 30 s: silence for this long means the connection is gone.
const SILENCE_TIMEOUT_MS = 75_000;

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
  // A run started or ended: what was shared of its status is out of date
  if (event.type === "ask_run") forgetRunStatus((event.data as { conversation_id?: string }).conversation_id);
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
    if (document.visibilityState === "hidden") return;
    if (!connected) {
      reconnectSoon(0);
      return;
    }
    // Back from the background, a phone has usually cut the connection without the page hearing of
    // it: silence past a keepalive interval means it's gone, reopen now instead of after 75 s.
    if (Date.now() - lastDataAt > 35_000) abort?.abort();
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
  let openedAt = 0;
  let watchdog = setTimeout(() => ctrl.abort(), OPEN_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "text/event-stream" };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const res = await fetch(`${getApiBase()}/api/events/stream`, {
      headers,
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl.abort(), SILENCE_TIMEOUT_MS);
      lastDataAt = Date.now();
      if (!openedAt) {
        openedAt = lastDataAt;
        retryDelay = 2_000;
        setConnected(true);
      }
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const lines = block.split("\n");
        const id = lines.find((l) => l.startsWith("id:"));
        if (id) lastEventId = id.slice(3).trim();
        const data = lines
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
  } catch {
    // dropped, refused or timed out: retried below
  } finally {
    clearTimeout(watchdog);
    if (abort === ctrl) abort = null;
    setConnected(false);
  }
  // One that was up a while and dropped (a server restart, the phone coming back) reopens at once; one
  // that failed or dropped straight away waits longer each time, up to a minute.
  const wasUp = openedAt > 0 && Date.now() - openedAt > 10_000;
  const delay = wasUp ? 500 : (retryDelay = Math.min(retryDelay * 2, 60_000));
  reconnectSoon(document.visibilityState === "hidden" ? Math.max(delay, 30_000) : delay);
}
