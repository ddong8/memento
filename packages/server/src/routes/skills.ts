// /api/skills: review & publish skills, collector injection endpoints (server/server/api/skills.py).
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, verifyCollectorToken, type UserRow } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { AppEnv } from "../context";
import { withoutNul, type Db } from "../db/client";
import { machines, skills } from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, parseOptionalJsonObject, requiredHeader } from "../http";
import { profileTargets } from "../services/profile-targets";
import {
  BODY_MAX,
  cleanBody,
  DESCRIPTION_MAX,
  injectionFor,
  oneLine,
  skillCounts,
  skillOut,
  buildSkillEditPatch,
  type SkillEdits,
  type SkillRow,
} from "../services/skills";

export const skillRoutes = new Hono<AppEnv>();

const EDIT_FIELDS = ["title", "description", "body", "slug", "project"] as const;

function parseSkillEdits(obj: Record<string, unknown> | null): SkillEdits | null {
  if (!obj) return null;
  const errors: unknown[] = [];
  const edits: SkillEdits = {};
  for (const k of EDIT_FIELDS) {
    if (!(k in obj) || obj[k] === null) continue;
    if (typeof obj[k] !== "string") {
      errors.push({ type: "string_type", loc: ["body", k], msg: "Input should be a valid string", input: obj[k] });
    } else {
      edits[k] = obj[k] as string;
    }
  }
  if (errors.length) throw new HttpError(422, errors);
  return Object.keys(edits).length ? edits : null;
}

async function ownSkill(db: Db, user: UserRow, skillId: string): Promise<SkillRow> {
  const sid = normalizeUuid(skillId);
  if (!sid) throw new HttpError(404, "not found");
  const [skill] = await db.select().from(skills).where(eq(skills.id, sid)).limit(1);
  if (!skill || skill.userId !== user.id) throw new HttpError(404, "not found");
  return skill;
}

async function bustSkillsCache(c: Parameters<typeof currentUser>[0], userId: string) {
  const redis = c.var.deps.redis();
  await cacheDeletePrefix(redis, `skills:list:${userId}`).catch(() => {});
  await cacheDeletePrefix(redis, `skills_injection:${userId}`).catch(() => {});
}

async function ownMachine(db: Db, user: UserRow, deviceId: string) {
  const [m] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.collectorTokenHash, deviceId), eq(machines.userId, user.id)))
    .limit(1);
  if (!m) throw new HttpError(404, "device not found");
  return m;
}

skillRoutes.get("/", async (c) => {
  const { db } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const cacheKey = `skills:list:${user.id}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const [rows, machineRows, counts] = await Promise.all([
    db
      .select()
      .from(skills)
      .where(eq(skills.userId, user.id))
      .orderBy(sql`${skills.lastSeenAt} DESC NULLS LAST`, desc(skills.createdAt)),
    db
      .select()
      .from(machines)
      .where(and(eq(machines.userId, user.id), isNull(machines.mergedInto), eq(machines.isArchived, false)))
      .orderBy(sql`${machines.lastHeartbeat} DESC NULLS LAST`),
    skillCounts(db, user),
  ]);

  const payload = {
    drafts: rows.filter((s) => s.status === "draft").map((s) => skillOut(s)),
    published: rows.filter((s) => s.status === "published").map((s) => skillOut(s)),
    archived: rows.filter((s) => s.status === "dismissed" || s.status === "retired").map((s) => skillOut(s, false)),
    counts,
    devices: machineRows.map((m) => ({
      device_id: m.collectorTokenHash,
      name: m.name,
      targets: profileTargets(m),
      status: m.skillStatus ?? {},
    })),
  };
  await cacheSet(redis, cacheKey, payload, 30);
  return c.json(payload);
});

// Collector endpoints (must be registered before /:skillId routes)
skillRoutes.get("/injection", async (c) => {
  const { db } = c.var.deps;
  const redis = c.var.deps.redis();
  const deviceId = requiredHeader(c, "x-device-id");
  const user = await verifyCollectorToken(c);

  const cacheKey = `skills_injection:${user.id}:${deviceId}`;
  const cached = await cacheGet(redis, cacheKey).catch(() => null);
  if (cached && typeof cached === "object") return c.json(cached);

  const machine = await ownMachine(db, user, deviceId);
  const res = await injectionFor(db, user, machine);
  await cacheSet(redis, cacheKey, res, 60).catch(() => {});
  return c.json(res);
});

skillRoutes.post("/injection/status", async (c) => {
  const { db } = c.var.deps;
  const deviceId = requiredHeader(c, "x-device-id");
  const user = await verifyCollectorToken(c);
  const body = await parseJsonObject(c);
  const results = body.results;
  if (!results || typeof results !== "object" || Array.isArray(results)) {
    throw new HttpError(422, [{ type: "dict_type", loc: ["body", "results"], msg: "Input should be a valid dictionary", input: results }]);
  }
  const cleanResults: Record<string, string> = {};
  for (const [k, v] of Object.entries(results as Record<string, unknown>).slice(0, 200)) {
    if (typeof v !== "string") {
      throw new HttpError(422, [{ type: "string_type", loc: ["body", "results", k], msg: "Input should be a valid string", input: v }]);
    }
    cleanResults[String(k).slice(0, 120)] = String(v).slice(0, 200);
  }
  const machine = await ownMachine(db, user, deviceId);
  const now = new Date();
  const ms = String(now.getUTCMilliseconds() * 1000).padStart(6, "0");
  const reportedAt = `${now.toISOString().slice(0, 19)}${ms === "000000" ? "" : `.${ms}`}+00:00`;
  await db
    .update(machines)
    .set({ skillStatus: withoutNul({ results: cleanResults, reported_at: reportedAt }) })
    .where(eq(machines.id, machine.id));
  return c.json({ status: "ok" });
});

skillRoutes.put("/:skillId", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const edits = parseSkillEdits(await parseJsonObject(c));
  const skill = await ownSkill(db, user, c.req.param("skillId"));

  let patch: Partial<typeof skills.$inferInsert> = {};
  if (edits) {
    try {
      patch = await buildSkillEditPatch(db, user, skill, edits);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  const publishNow = skill.status === "published";
  if (publishNow) {
    patch.status = "published";
    patch.version = (skill.version || 0) + 1;
  }

  let updated = skill;
  if (Object.keys(patch).length || publishNow) {
    const [row] = await db
      .update(skills)
      .set({
        ...withoutNul(patch),
        ...(publishNow ? { publishedAt: sql`now()` as unknown as string } : {}),
        updatedAt: sql`now()` as unknown as string,
      })
      .where(eq(skills.id, skill.id))
      .returning();
    if (row) updated = row;
  }
  await bustSkillsCache(c, user.id);
  return c.json({ skill: skillOut(updated) });
});

skillRoutes.post("/:skillId/publish", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const edits = parseSkillEdits(await parseOptionalJsonObject(c));
  const skill = await ownSkill(db, user, c.req.param("skillId"));

  let patch: Partial<typeof skills.$inferInsert> = {};
  if (edits) {
    try {
      patch = await buildSkillEditPatch(db, user, skill, edits);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  const nextDesc = patch.description ?? skill.description;
  const nextBody = patch.body ?? skill.body;
  if (!nextDesc.trim() || !nextBody.trim()) {
    throw new HttpError(400, "说明和步骤都不能为空");
  }
  const [updated] = await db
    .update(skills)
    .set({
      ...withoutNul(patch),
      status: "published",
      version: (skill.version || 0) + 1,
      publishedAt: sql`now()` as unknown as string,
      updatedAt: sql`now()` as unknown as string,
    })
    .where(eq(skills.id, skill.id))
    .returning();
  await bustSkillsCache(c, user.id);
  return c.json({ skill: skillOut(updated ?? skill) });
});

skillRoutes.post("/:skillId/dismiss", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const skill = await ownSkill(db, user, c.req.param("skillId"));
  const [updated] = await db
    .update(skills)
    .set({ status: "dismissed", updatedAt: sql`now()` as unknown as string })
    .where(eq(skills.id, skill.id))
    .returning();
  await bustSkillsCache(c, user.id);
  return c.json({ skill: skillOut(updated ?? skill) });
});

skillRoutes.post("/:skillId/retire", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const skill = await ownSkill(db, user, c.req.param("skillId"));
  const [updated] = await db
    .update(skills)
    .set({ status: "retired", updatedAt: sql`now()` as unknown as string })
    .where(eq(skills.id, skill.id))
    .returning();
  await bustSkillsCache(c, user.id);
  return c.json({ skill: skillOut(updated ?? skill) });
});

skillRoutes.post("/:skillId/restore", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const skill = await ownSkill(db, user, c.req.param("skillId"));
  const [updated] = await db
    .update(skills)
    .set({ status: "draft", updatedAt: sql`now()` as unknown as string })
    .where(eq(skills.id, skill.id))
    .returning();
  await bustSkillsCache(c, user.id);
  return c.json({ skill: skillOut(updated ?? skill) });
});

skillRoutes.post("/:skillId/update/apply", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const skill = await ownSkill(db, user, c.req.param("skillId"));
  const pending = skill.pendingUpdate as Record<string, unknown> | null;
  if (!pending || typeof pending !== "object" || !Object.keys(pending).length) {
    throw new HttpError(400, "没有待确认的更新");
  }
  const patch: Partial<typeof skills.$inferInsert> = { pendingUpdate: null };
  if (typeof pending.description === "string" && pending.description) {
    patch.description = oneLine(pending.description, DESCRIPTION_MAX);
  }
  if (typeof pending.body === "string" && pending.body) {
    patch.body = cleanBody(pending.body).slice(0, BODY_MAX);
  }
  const publishNow = skill.status === "published";
  if (publishNow) {
    patch.status = "published";
    patch.version = (skill.version || 0) + 1;
  }
  const [updated] = await db
    .update(skills)
    .set({
      ...withoutNul(patch),
      ...(publishNow ? { publishedAt: sql`now()` as unknown as string } : {}),
      updatedAt: sql`now()` as unknown as string,
    })
    .where(eq(skills.id, skill.id))
    .returning();
  await bustSkillsCache(c, user.id);
  return c.json({ skill: skillOut(updated ?? skill) });
});

skillRoutes.post("/:skillId/update/discard", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const skill = await ownSkill(db, user, c.req.param("skillId"));
  const [updated] = await db
    .update(skills)
    .set({ pendingUpdate: null, updatedAt: sql`now()` as unknown as string })
    .where(eq(skills.id, skill.id))
    .returning();
  await bustSkillsCache(c, user.id);
  return c.json({ skill: skillOut(updated ?? skill) });
});
