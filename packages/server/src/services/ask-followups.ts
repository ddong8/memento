// Per-conversation queued follow-ups when a running agent didn't accept mid-run steer (server/server/services/ask_followups.py).
import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { deviceTasks } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { cluster, PREFIX } from "./cluster";

const TTL_SECONDS = 24 * 3600;
const MAX_ITEMS = 50;
const MAX_TEXT = 20_000;

export interface FollowupItem {
  text: string;
  at: number;
}

const localQueue = new Map<string, FollowupItem[]>();

function keyFor(userId: string, convId: string): string {
  return `${PREFIX}ask:followups:${userId}:${convId}`;
}

function parseItem(raw: string): FollowupItem | null {
  try {
    const v = JSON.parse(raw) as Partial<FollowupItem>;
    if (v && typeof v === "object" && typeof v.text === "string" && v.text) {
      return { text: v.text, at: typeof v.at === "number" ? v.at : 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function addFollowup(userId: string, convId: string, text: string, at?: number): Promise<boolean> {
  const clean = (text || "").trim().slice(0, MAX_TEXT);
  if (!clean || !convId) return false;
  const item: FollowupItem = { text: clean, at: at ?? Date.now() / 1000 };
  const key = keyFor(userId, convId);
  const r = cluster.redis;
  if (!r) {
    const items = localQueue.get(key) ?? [];
    if (items.length >= MAX_ITEMS || items.some((i) => i.text === clean)) return false;
    items.push(item);
    localQueue.set(key, items);
    return true;
  }
  try {
    const existing = await r.lrange(key, 0, -1);
    if (existing.length >= MAX_ITEMS || existing.some((raw) => parseItem(raw)?.text === clean)) return false;
    const pipe = r.multi();
    pipe.rpush(key, JSON.stringify(item));
    pipe.expire(key, TTL_SECONDS);
    await pipe.exec();
    return true;
  } catch {
    return false;
  }
}

export async function peekFollowups(userId: string, convId: string): Promise<FollowupItem[]> {
  const key = keyFor(userId, convId);
  const r = cluster.redis;
  if (!r) return [...(localQueue.get(key) ?? [])];
  try {
    const raw = await r.lrange(key, 0, -1);
    return raw.map(parseItem).filter((x): x is FollowupItem => x !== null);
  } catch {
    return [];
  }
}

export async function popFollowups(userId: string, convId: string): Promise<FollowupItem[]> {
  const key = keyFor(userId, convId);
  const r = cluster.redis;
  if (!r) {
    const items = localQueue.get(key) ?? [];
    localQueue.delete(key);
    return items;
  }
  try {
    const res = await r.multi().lrange(key, 0, -1).del(key).exec();
    const raw = (res?.[0]?.[1] as string[] | undefined) ?? [];
    return raw
      .map(parseItem)
      .filter((x): x is FollowupItem => x !== null)
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

export async function removeFollowup(userId: string, convId: string, text: string): Promise<boolean> {
  const clean = (text || "").trim();
  const key = keyFor(userId, convId);
  const r = cluster.redis;
  if (!r) {
    const items = localQueue.get(key) ?? [];
    const kept = items.filter((i) => i.text !== clean);
    localQueue.set(key, kept);
    return kept.length !== items.length;
  }
  try {
    let removed = 0;
    for (const raw of await r.lrange(key, 0, -1)) {
      if (parseItem(raw)?.text === clean) removed += await r.lrem(key, 1, raw);
    }
    return removed > 0;
  } catch {
    return false;
  }
}

export async function taskOwner(db: Db, taskId: string): Promise<[string, string] | null> {
  const tid = normalizeUuid(taskId);
  if (!tid) return null;
  const [task] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
  if (!task || !task.userId) return null;
  const pl = (task.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>;
  const conv = String(pl.conversation_id ?? "").trim();
  return conv ? [task.userId, conv] : null;
}

export async function noteSteer(db: Db, taskId: string, event: Record<string, unknown>): Promise<void> {
  if (event.kind !== "steer" || (event.status !== "late" && event.status !== "unsupported")) return;
  const text = String(event.text ?? "");
  try {
    const owner = await taskOwner(db, taskId);
    if (owner) await addFollowup(owner[0], owner[1], text);
  } catch {
    /* ignore */
  }
}
