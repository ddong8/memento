// Manually triggered long jobs (review now, run retrieval eval) with status in Redis (server/server/services/jobs.py).
import type { Redis } from "ioredis";

import * as aiHealth from "./ai-health";
import { cluster } from "./cluster";

const STALE_MS = 45 * 60 * 1000;

function jobKey(name: string, userId: string): string {
  return `job:${name}:${userId}`;
}

export async function status(redis: Redis | null, name: string, userId: string): Promise<Record<string, unknown> | null> {
  return aiHealth.getJson<Record<string, unknown>>(redis, jobKey(name, userId));
}

export async function start(
  redis: () => Redis | null,
  name: string,
  userId: string,
  work: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const key = jobKey(name, userId);
  const now = new Date();
  const r = redis();
  const current = await aiHealth.getJson<Record<string, unknown>>(r, key);
  if (current && current.status === "running" && typeof current.started_at === "string") {
    const startedMs = Date.parse(current.started_at);
    if (Number.isFinite(startedMs) && now.getTime() - startedMs < STALE_MS) {
      return { ...current, already_running: true };
    }
  }
  const state: Record<string, unknown> = { status: "running", started_at: now.toISOString().replace("Z", "+00:00") };
  await aiHealth.putJson(r, key, state);
  cluster.spawn(async () => {
    try {
      const result = await work();
      await aiHealth.putJson(redis(), key, {
        ...state,
        status: "done",
        finished_at: new Date().toISOString().replace("Z", "+00:00"),
        result,
      });
    } catch (e) {
      const err = e as Error;
      console.warn(`[jobs] ${key} failed:`, err);
      await aiHealth.putJson(redis(), key, {
        ...state,
        status: "error",
        finished_at: new Date().toISOString().replace("Z", "+00:00"),
        error: `${err?.name || "Error"}: ${err?.message || String(e)}`.slice(0, 300),
      });
    }
  });
  return state;
}
