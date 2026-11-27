// Learning routes: corrections, check, reviews, evals, outcomes, pitfalls, guard (server/server/api/learning.py).
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { currentUser, verifyCollectorToken, type UserRow } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { AppEnv } from "../context";
import type { Db } from "../db/client";
import { correctionTopics, documents, guardEvents, machines, sessionReviews, users } from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, queryInt } from "../http";
import { pgToIso } from "../pytime";
import { cluster } from "../services/cluster";
import { acceptTopic, correctionStats, ProfileFull, topicOut } from "../services/correction-service";
import { buildSet, evalSummary, runEval, runOut } from "../services/eval-service";
import { buildEventRows, guardOverview, mergeGuardStatus, SETTING as GUARD_SETTING } from "../services/guard-service";
import { guidanceFor, renderGuidance } from "../services/guidance-service";
import * as jobs from "../services/jobs";
import { outcomeSummary, runLearningEval } from "../services/learning-eval-service";
import { reconcile, reconcileInBackground } from "../services/memory-lifecycle";
import { enrichCheckRulesResult, senseResonance } from "../services/mind-resonance-service";
import { PROFILE_MAX_CHARS, SCOPED_MAX_CHARS } from "../services/profile-scopes";
import { learnFromTasks, reviewSessions, reviewStats, savePitfall } from "../services/retrospective-service";

const AcceptSchema = z.object({
  statement: z.string().nullable().optional(),
  general: z.boolean().optional().default(false),
});

const PitfallSchema = z.object({
  title: z.string(),
  symptom: z.string(),
  fix: z.string(),
  cause: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
});

const GuardBodySchema = z.object({ enabled: z.boolean() });
const GuardEventsSchema = z.object({ events: z.array(z.record(z.string(), z.unknown())) });
const GuardStatusSchema = z.object({ results: z.record(z.string(), z.string()) });

async function parseZod<T extends z.ZodTypeAny>(c: Parameters<typeof parseJsonObject>[0], schema: T): Promise<z.infer<T>> {
  const raw = await parseJsonObject(c);
  const res = schema.safeParse(raw);
  if (!res.success) {
    throw new HttpError(
      422,
      res.error.issues.map((i) => ({ type: i.code, loc: ["body", ...i.path], msg: i.message })),
    );
  }
  return res.data;
}

async function ownTopic(db: Db, user: UserRow, topicId: string) {
  const tid = normalizeUuid(topicId);
  if (!tid) throw new HttpError(404, "not found");
  const [topic] = await db.select().from(correctionTopics).where(eq(correctionTopics.id, tid)).limit(1);
  if (!topic || topic.userId !== user.id) throw new HttpError(404, "not found");
  return topic;
}

async function collectorMachine(db: Db, user: UserRow, deviceId: string) {
  const [m] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.collectorTokenHash, deviceId), eq(machines.userId, user.id)))
    .limit(1);
  if (!m) throw new HttpError(404, "device not found");
  return m;
}

export const learningRoutes = new Hono<AppEnv>();

learningRoutes.get("/corrections", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const r = deps.redis();
  const cacheKey = `learning:corrections:${user.id}`;
  const cached = await cacheGet(r, cacheKey);
  if (cached !== null) return c.json(cached);

  const pending = await deps.db
    .select()
    .from(correctionTopics)
    .where(and(eq(correctionTopics.userId, user.id), eq(correctionTopics.status, "pending")))
    .orderBy(desc(correctionTopics.times), desc(correctionTopics.lastAt))
    .limit(30);

  const quotesByTopic = new Map<string, { quote: string; saidAt: string }[]>();
  if (pending.length) {
    const ids = pending.map((t) => t.id);
    const evRows = (await deps.db.execute(sql`
      SELECT topic_id, quote, said_at FROM (
        SELECT topic_id, quote, said_at,
               row_number() OVER (PARTITION BY topic_id ORDER BY said_at DESC) AS rn
        FROM correction_events
        WHERE topic_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      ) sub
      WHERE rn <= 3
    `)) as unknown as { topic_id: string; quote: string; said_at: string }[];
    for (const row of evRows) {
      const tid = String(row.topic_id);
      const arr = quotesByTopic.get(tid) ?? [];
      arr.push({ quote: row.quote, saidAt: String(row.said_at) });
      quotesByTopic.set(tid, arr);
    }
  }

  const payload = {
    pending: pending.map((t) => topicOut(t, quotesByTopic.get(t.id) ?? [])),
    stats: await correctionStats(deps.db, user),
  };
  await cacheSet(r, cacheKey, payload, 30);
  return c.json(payload);
});

learningRoutes.post("/corrections/:topic_id/accept", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const body = await parseZod(c, AcceptSchema);
  const topic = await ownTopic(deps.db, user, c.req.param("topic_id"));
  let accepted;
  try {
    accepted = await acceptTopic(deps.db, user, topic, body.statement ?? null, body.general);
  } catch (e) {
    if (e instanceof ProfileFull) {
      throw new HttpError(
        409,
        `常驻画像这一部分已接近上限（通用 ${PROFILE_MAX_CHARS} 字、每个项目或设备 ${SCOPED_MAX_CHARS} 字），先删减一些再采纳。`,
      );
    }
    throw new HttpError(400, (e as Error).message || String(e));
  }
  if (accepted.memoryId) {
    const memId = accepted.memoryId;
    cluster.spawn(() => reconcileInBackground(deps.db, deps.settings, deps.redis(), user.id, memId));
  }
  const r = deps.redis();
  await cacheDeletePrefix(r, `learning:corrections:${user.id}`).catch(() => {});
  await cacheDeletePrefix(r, `learning:check:${user.id}`).catch(() => {});
  return c.json({ topic: topicOut(accepted) });
});

learningRoutes.post("/corrections/:topic_id/dismiss", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const topic = await ownTopic(deps.db, user, c.req.param("topic_id"));
  const [updated] = await deps.db
    .update(correctionTopics)
    .set({ status: "dismissed", updatedAt: new Date().toISOString() })
    .where(eq(correctionTopics.id, topic.id))
    .returning();
  const r = deps.redis();
  await cacheDeletePrefix(r, `learning:corrections:${user.id}`).catch(() => {});
  await cacheDeletePrefix(r, `learning:check:${user.id}`).catch(() => {});
  return c.json({ topic: topicOut(updated ?? { ...topic, status: "dismissed" }) });
});

learningRoutes.get("/check", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const action = c.req.query("action") || null;
  const project = c.req.query("project") || null;
  const query = c.req.query("query") || null;
  const format = c.req.query("format") || "json";
  const r = deps.redis();
  const cacheKey = `learning:check:${user.id}:${action || ""}:${project || ""}:${query || ""}:${format}`;
  const cached = await cacheGet(r, cacheKey);
  if (cached !== null) return c.json(cached);

  const g = await guidanceFor(deps.db, user, action, project, query);
  let res: unknown;
  if (format === "markdown") {
    const baseMd = renderGuidance(g);
    try {
      const resObj = await senseResonance(deps.db, r, user, { query: query ?? undefined, project, action });
      const fullMd = enrichCheckRulesResult(baseMd, resObj);
      res = { markdown: fullMd, guidance: g, resonance: resObj };
    } catch {
      res = { markdown: baseMd };
    }
  } else {
    res = g;
  }
  await cacheSet(r, cacheKey, res, 30);
  return c.json(res);
});

learningRoutes.post("/review", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const uid = user.id;
  return c.json(
    await jobs.start(deps.redis, "review", uid, async () => {
      const [u] = await deps.db.select().from(users).where(eq(users.id, uid)).limit(1);
      if (!u) return { error: "user not found" };
      const sessions = await reviewSessions(deps.db, deps.settings, deps.redis(), u);
      let tasks: unknown;
      try {
        tasks = await learnFromTasks(deps.db, deps.settings, deps.redis(), u);
      } catch (e) {
        tasks = { error: ((e as Error).message || String(e)).slice(0, 200) };
      }
      const reconciled = await reconcile(deps.db, deps.settings, deps.redis(), u, Date.now() - 86400_000);
      return { sessions, tasks, reconcile: reconciled };
    }),
  );
});

learningRoutes.get("/reviews", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const rawDays = queryInt(c, "days", 14) ?? 14;
  const days = Math.max(1, Math.min(rawDays, 90));
  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await deps.db
    .select({ review: sessionReviews, title: documents.title, toolId: documents.toolId })
    .from(sessionReviews)
    .innerJoin(documents, eq(documents.id, sessionReviews.documentId))
    .where(and(eq(sessionReviews.userId, user.id), gte(sessionReviews.reviewedAt, sinceIso)))
    .orderBy(desc(sessionReviews.reviewedAt))
    .limit(60);

  return c.json({
    reviews: rows.map((r) => ({
      doc_id: r.review.documentId,
      title: r.title,
      tool_id: r.toolId,
      outcome: r.review.outcome,
      summary: r.review.summary,
      result: r.review.result || {},
      reviewed_at: pgToIso(r.review.reviewedAt),
    })),
    stats: await reviewStats(deps.db, user),
    job: await jobs.status(deps.redis(), "review", user.id),
  });
});

learningRoutes.get("/evals", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  return c.json({
    ...(await evalSummary(deps.db, user)),
    job: await jobs.status(deps.redis(), "eval", user.id),
  });
});

learningRoutes.post("/evals/run", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const rebuild = ["1", "true", "yes"].includes((c.req.query("rebuild") || "").toLowerCase());
  const uid = user.id;
  return c.json(
    await jobs.start(deps.redis, "eval", uid, async () => {
      const [u] = await deps.db.select().from(users).where(eq(users.id, uid)).limit(1);
      if (!u) throw new Error("user not found");
      const version = rebuild ? (await buildSet(deps.db, deps.settings, deps.redis(), u)).set_version : null;
      const run = await runEval(deps.db, deps.settings, deps.redis(), u, "manual", version);
      return runOut(run);
    }),
  );
});

learningRoutes.get("/outcomes", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  return c.json(await outcomeSummary(deps.db, user));
});

learningRoutes.post("/outcomes/run", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const weeks = await runLearningEval(deps.db, user, "manual");
  return c.json({ weeks, ...(await outcomeSummary(deps.db, user)) });
});

learningRoutes.post("/pitfalls", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const body = await parseZod(c, PitfallSchema);
  const mem = await savePitfall(deps.db, deps.redis(), user, body, body.project ?? null, "mcp");
  if (!mem) {
    return c.json({ saved: false, note: "信息不全、属于 AI 自己的操作失误或工具自身的限制，或已经记过" });
  }
  return c.json({ saved: true, id: mem.id, content: mem.content });
});

learningRoutes.get("/guard", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const rawDays = queryInt(c, "days", 30) ?? 30;
  const days = Math.max(1, Math.min(rawDays, 365));
  return c.json(await guardOverview(deps.db, user, days));
});

learningRoutes.put("/guard", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const body = await parseZod(c, GuardBodySchema);
  const prev =
    user.proactiveSettings && typeof user.proactiveSettings === "object" && !Array.isArray(user.proactiveSettings)
      ? (user.proactiveSettings as Record<string, unknown>)
      : {};
  await deps.db
    .update(users)
    .set({ proactiveSettings: { ...prev, [GUARD_SETTING]: body.enabled } })
    .where(eq(users.id, user.id));
  await cacheDeletePrefix(deps.redis(), `profile_injection:${user.id}`).catch(() => {});
  return c.json({ enabled: body.enabled });
});

learningRoutes.post("/guard/events", async (c) => {
  const deps = c.var.deps;
  const user = await verifyCollectorToken(c);
  const deviceId = c.req.header("x-device-id");
  if (!deviceId) throw new HttpError(422, "X-Device-Id header required");
  const body = await parseZod(c, GuardEventsSchema);
  const machine = await collectorMachine(deps.db, user, deviceId);
  const rows = buildEventRows(user.id, machine.id, body.events);
  if (rows.length) await deps.db.insert(guardEvents).values(rows);
  return c.json({ saved: rows.length });
});

learningRoutes.post("/guard/status", async (c) => {
  const deps = c.var.deps;
  const user = await verifyCollectorToken(c);
  const deviceId = c.req.header("x-device-id");
  if (!deviceId) throw new HttpError(422, "X-Device-Id header required");
  const body = await parseZod(c, GuardStatusSchema);
  const machine = await collectorMachine(deps.db, user, deviceId);
  const nextStatus = mergeGuardStatus(machine.profileStatus, body.results);
  await deps.db.update(machines).set({ profileStatus: nextStatus }).where(eq(machines.id, machine.id));
  return c.json({ status: "ok" });
});
