// Attempt counters for login and friends (services/rate_limit.py): fixed windows in Redis under "rl:<key>",
// the same keys the Python server uses, so both count together. Redis down: this process's memory.
import type { Redis } from "ioredis";

import { HttpError } from "./http";

const PREFIX = "rl:";
const LOCAL_MAX_KEYS = 10_000;
const local = new Map<string, { n: number; end: number }>();
const now = () => performance.now() / 1000;

function localCount(key: string): [number, number] {
  const e = local.get(key);
  if (!e) return [0, 0];
  const left = e.end - now();
  return left > 0 ? [e.n, Math.floor(left) + 1] : [0, 0];
}

async function count(redis: Redis | null, key: string): Promise<[number, number]> {
  if (redis) {
    try {
      const res = await redis.multi().get(PREFIX + key).ttl(PREFIX + key).exec();
      if (res) {
        const value = res[0]?.[1] as string | null;
        const ttl = Number(res[1]?.[1] ?? 0);
        return [Number(value || 0), Math.max(ttl, 0)];
      }
    } catch {
      /* fall back */
    }
  }
  return localCount(key);
}

export async function check(redis: Redis | null, key: string, limit: number): Promise<void> {
  const [n, ttl] = await count(redis, key);
  if (n >= limit) {
    const wait = Math.max(ttl, 1);
    throw new HttpError(429, `Too many attempts, try again in ${wait} seconds`, { "Retry-After": String(wait) });
  }
}

export async function hit(redis: Redis | null, key: string, window: number): Promise<void> {
  if (redis) {
    try {
      // SET NX EX + INCR together: the counter never exists without an expiry
      await redis.multi().set(PREFIX + key, "0", "EX", window, "NX").incr(PREFIX + key).exec();
      return;
    } catch {
      /* fall back */
    }
  }
  const t = now();
  if (local.size >= LOCAL_MAX_KEYS) for (const [k, e] of local) if (e.end <= t) local.delete(k);
  let e = local.get(key);
  if (!e || e.end <= t) e = { n: 0, end: t + window };
  local.set(key, { n: e.n + 1, end: e.end });
}

export async function reset(redis: Redis | null, key: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(PREFIX + key);
    } catch {
      /* ignore */
    }
  }
  local.delete(key);
}

export function resetLocalForTests(): void {
  local.clear();
}
