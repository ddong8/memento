// SSE real-time event bus, cross-replica compatible with server/server/services/sse_service.py.
import { cluster, PREFIX } from "./cluster";

export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

const CHANNEL = `${PREFIX}sse`;
const REPLAY_WINDOW = 10;
const MAX_RECENT = 50;
const MAX_QUEUE = 100;

interface Subscriber {
  userId: string;
  push: (ev: SseEvent | null) => void;
  size: () => number;
}

const subscribers = new Set<Subscriber>();
const recentEvents: { userId: string | null; event: SseEvent }[] = [];

function deliver(userId: string | null, event: SseEvent): void {
  recentEvents.push({ userId, event });
  if (recentEvents.length > MAX_RECENT) recentEvents.shift();
  for (const sub of [...subscribers]) {
    if (userId !== null && sub.userId !== userId) continue;
    if (sub.size() >= MAX_QUEUE) {
      subscribers.delete(sub);
      sub.push(null);
      continue;
    }
    sub.push(event);
  }
}

cluster.on(CHANNEL, (_ch, msg) => {
  if (msg.origin !== cluster.podId && msg.event && typeof msg.event === "object") {
    deliver((msg.user_id as string | null) ?? null, msg.event as SseEvent);
  }
});

export function publishEvent(eventType: string, data: Record<string, unknown>, userId: string | null = null): void {
  const event: SseEvent = { type: eventType, data, timestamp: Date.now() / 1000 };
  deliver(userId, event);
  cluster.publish(CHANNEL, { user_id: userId, event });
}

const throttled = new Map<string, { sent: number; pending: Record<string, unknown> | null; timer: NodeJS.Timeout | null }>();

export function publishEventThrottled(eventType: string, data: Record<string, unknown>, userId: string | null = null, intervalSec = 5): void {
  const key = `${eventType}:${userId ?? ""}`;
  const now = performance.now() / 1000;
  const st = throttled.get(key);
  if (!st || (!st.timer && now - st.sent >= intervalSec)) {
    throttled.set(key, { sent: now, pending: null, timer: null });
    publishEvent(eventType, data, userId);
    return;
  }
  st.pending = data;
  if (!st.timer) {
    st.timer = setTimeout(() => {
      st.timer = null;
      const pending = st.pending;
      st.pending = null;
      if (pending) {
        st.sent = performance.now() / 1000;
        publishEvent(eventType, pending, userId);
      }
    }, Math.max(0, (intervalSec - (now - st.sent)) * 1000));
    st.timer.unref?.();
  }
}

export function formatSse(event: SseEvent): string {
  const head = event.type === "keepalive" ? "" : `id: ${(event.timestamp ?? 0).toFixed(6)}\n`;
  return `${head}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function parseEventId(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function subscribeStream(userId: string, since: number | null, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue: (SseEvent | null)[] = [];
  let wake: (() => void) | null = null;
  const floor = since ?? Date.now() / 1000 - REPLAY_WINDOW;
  const backlog = recentEvents.filter((e) => (e.userId === null || e.userId === userId) && (e.event.timestamp ?? 0) > floor).map((e) => e.event);

  const sub: Subscriber = {
    userId,
    push: (ev) => {
      queue.push(ev);
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
    },
    size: () => queue.length,
  };
  subscribers.add(sub);

  let closed = false;
  let keepaliveTimer: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    subscribers.delete(sub);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };
  signal?.addEventListener("abort", cleanup);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: SseEvent) => {
        if (!closed) controller.enqueue(encoder.encode(formatSse(ev)));
      };
      send({ type: "keepalive", data: {}, timestamp: Date.now() / 1000 });
      for (const ev of backlog) send(ev);

      keepaliveTimer = setInterval(() => {
        if (!closed) send({ type: "keepalive", data: {}, timestamp: Date.now() / 1000 });
      }, 30_000);
      keepaliveTimer.unref?.();

      try {
        while (!closed) {
          if (!queue.length) {
            await new Promise<void>((r) => {
              wake = r;
            });
          }
          while (queue.length && !closed) {
            const ev = queue.shift()!;
            if (ev === null) {
              cleanup();
              controller.close();
              return;
            }
            send(ev);
          }
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      } finally {
        cleanup();
      }
    },
    cancel() {
      cleanup();
    },
  });
}
