// Project collection exclusions API (server/server/api/collect_exclusions.py): /api/collect/exclusions*.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Redis } from "ioredis";

import { currentUser } from "../auth/current-user";
import type { AppEnv } from "../context";
import type { Db } from "../db/client";
import { users } from "../db/pulled/schema";
import { HttpError, parseJsonObject, queryRequiredString } from "../http";
import { cluster } from "../services/cluster";
import * as px from "../services/project-exclusion";

export const collectExclusionRoutes = new Hono<AppEnv>();

const STALE_MS = 10 * 60_000;

function outEntry(e: px.ExclusionEntry) {
  return {
    key: e.key ?? null,
    name: e.name ?? null,
    added_at: e.added_at ?? null,
    state: e.state ?? null,
    updated_at: e.updated_at ?? null,
    purged: e.purged ?? null,
    error: e.error ?? null,
  };
}

function spawnPurge(db: Db, redis: Redis | null, userId: string, key: string): void {
  cluster.spawn(async () => {
    const lock = await cluster.mutex(`project-exclusion:${userId}:${key}`, 300);
    if (!lock) return;
    try {
      const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!u || !px.keysOf(u).includes(key)) return;
      await px.purgeExclusion(db, redis, u, key);
    } catch (err) {
      try {
        await px.updateExclusionEntry(db, userId, key, { state: "failed", error: String(err).slice(0, 300) });
      } catch {
        /* ignore */
      }
    } finally {
      await lock.release();
    }
  });
}

collectExclusionRoutes.get("/", async (c) => {
  const user = await currentUser(c);
  const { db, redis } = c.var.deps;
  const items = px.entriesOf(user);
  const now = Date.now();
  for (const e of items) {
    if (e.state === "purging" || e.state === "failed") {
      const t = e.updated_at ? Date.parse(e.updated_at) : Number.NaN;
      const stale = Number.isNaN(t) || now - t > STALE_MS;
      if (stale || (e.state === "purging" && !e.purged)) {
        spawnPurge(db, redis(), user.id, e.key);
      }
    }
  }
  return c.json({ items: items.map(outEntry) });
});

collectExclusionRoutes.get("/preview", async (c) => {
  const user = await currentUser(c);
  const name = queryRequiredString(c, "name", { minLength: 1, maxLength: 120 });
  return c.json(await px.previewExclusion(c.var.deps.db, user, name));
});

collectExclusionRoutes.post("/", async (c) => {
  const user = await currentUser(c);
  const { db, redis } = c.var.deps;
  const body = await parseJsonObject(c);
  if (!("name" in body)) {
    throw new HttpError(422, [{ type: "missing", loc: ["body", "name"], msg: "Field required", input: body }]);
  }
  if (typeof body.name !== "string") {
    throw new HttpError(422, [{ type: "string_type", loc: ["body", "name"], msg: "Input should be a valid string", input: body.name }]);
  }
  if (body.name.length < 1 || body.name.length > 120) {
    throw new HttpError(422, [{ type: body.name.length < 1 ? "string_too_short" : "string_too_long", loc: ["body", "name"], msg: "Invalid name length", input: body.name }]);
  }
  let entry: px.ExclusionEntry;
  try {
    entry = await px.addExclusion(db, user.id, body.name);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  await px.invalidateExclusionCaches(redis(), user.id);
  spawnPurge(db, redis(), user.id, entry.key);
  return c.json({ item: outEntry(entry) });
});

collectExclusionRoutes.post("/:key/retry", async (c) => {
  const user = await currentUser(c);
  const { db, redis } = c.var.deps;
  const key = c.req.param("key");
  const entry = await px.updateExclusionEntry(db, user.id, key, { state: "purging", error: null });
  if (!entry) throw new HttpError(404, "Not Found");
  spawnPurge(db, redis(), user.id, key);
  return c.json({ item: outEntry(entry) });
});

collectExclusionRoutes.delete("/:key", async (c) => {
  const user = await currentUser(c);
  const { db, redis } = c.var.deps;
  const key = c.req.param("key");
  const entry = await px.restoreExclusion(db, redis(), user, key);
  if (!entry) throw new HttpError(404, "Not Found");
  return c.json({ item: outEntry(entry) });
});
