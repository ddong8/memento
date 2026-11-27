// The JSON cache hot reads share with the Python server (services/cache.py): an in-process L1 (at most
// 15 s) in front of Redis (L2), the same keys. Dropping a prefix also tells every replica, Python or
// TypeScript, to drop its L1 copies through the cluster channel memento:cl:cache-l1-bust.
import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";

export const L1_BUST_CHANNEL = "memento:cl:cache-l1-bust";
/** This process as an origin on cluster channels ("ts-" so the Python replicas can tell). */
export const ORIGIN = `ts-${randomUUID().slice(0, 12)}`;
const L1_MAX_ITEMS = 2048;
const l1 = new Map<string, { value: unknown; exp: number }>();
const now = () => performance.now() / 1000;

export function l1Get(key: string): unknown {
  const e = l1.get(key);
  if (!e) return undefined;
  if (e.exp > 0 && now() > e.exp) {
    l1.delete(key);
    return undefined;
  }
  return e.value;
}

export function l1Set(key: string, value: unknown, ttlSeconds: number): void {
  if (l1.size >= L1_MAX_ITEMS) {
    const t = now();
    for (const [k, e] of l1) if (e.exp > 0 && t > e.exp) l1.delete(k);
    if (l1.size >= L1_MAX_ITEMS) {
      let n = 0;
      for (const k of l1.keys()) {
        l1.delete(k);
        if (++n >= 100) break;
      }
    }
  }
  l1.set(key, { value, exp: ttlSeconds > 0 ? now() + ttlSeconds : 0 });
}

export function l1DeletePrefix(prefix: string): number {
  let n = 0;
  for (const k of [...l1.keys()]) if (k.startsWith(prefix)) l1.delete(k), n++;
  return n;
}

export function l1ClearForTests(): void {
  l1.clear();
}

export async function cacheGet(redis: Redis | null, key: string, l1TtlSeconds = 3): Promise<unknown> {
  const hit = l1Get(key);
  if (hit !== undefined && hit !== null) return hit;
  if (!redis) return null;
  try {
    const v = await redis.get(key);
    if (v == null) return null;
    const parsed = JSON.parse(v);
    if (l1TtlSeconds > 0) l1Set(key, parsed, l1TtlSeconds);
    return parsed;
  } catch {
    return null;
  }
}

export async function cacheSet(redis: Redis | null, key: string, value: unknown, ttlSeconds: number, opts: { l1?: boolean } = {}): Promise<void> {
  if (opts.l1 !== false) l1Set(key, value, Math.min(ttlSeconds, 15));
  else l1.delete(key);
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* a cache */
  }
}

/** Drop <prefix>* here, in every other replica's L1 (Python and TypeScript), and in Redis. */
export async function cacheDeletePrefix(redis: Redis | null, prefix: string): Promise<number> {
  l1DeletePrefix(prefix);
  if (!redis) return 0;
  let deleted = 0;
  try {
    // Out before the reply, so a read the client sends right after finds the other replicas busted
    await redis.publish(L1_BUST_CHANNEL, JSON.stringify({ prefix, origin: ORIGIN }));
  } catch {
    /* other replicas' L1 expires within 15 s */
  }
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
      cursor = next;
      if (keys.length) deleted += await redis.del(...keys);
    } while (cursor !== "0");
  } catch {
    /* ignore */
  }
  return deleted;
}

/** Listen for the other replicas' L1 busts (a subscribed connection can't run other commands: its own). */
export function listenForBusts(url: string): Redis | null {
  if (!url) return null;
  const sub = new Redis(url, { maxRetriesPerRequest: null, connectTimeout: 3000 });
  sub.on("error", () => {});
  sub.on("ready", () => void sub.subscribe(L1_BUST_CHANNEL).catch(() => {}));
  sub.on("message", (_channel: string, raw: string) => {
    try {
      const msg = JSON.parse(raw) as { prefix?: unknown; origin?: unknown };
      if (msg.origin !== ORIGIN && typeof msg.prefix === "string" && msg.prefix) l1DeletePrefix(msg.prefix);
    } catch {
      /* not ours */
    }
  });
  return sub;
}
