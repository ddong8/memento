// /api/daily: browse daily activity, messages and AI summaries (server/server/api/daily.py).
import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, ne, notLike, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { AppEnv, Deps } from "../context";
import { withoutNul } from "../db/client";
import { conversationMessages, dailySummaries, documents } from "../db/pulled/schema";
import { HttpError, queryInt } from "../http";
import { pgToIso, pyDateFromIso } from "../pytime";
import { generateDailySummaryFromDigests } from "../services/ai-summary";
import { CHAT_MESSAGE_SQL } from "../services/pulse";
import { seesAll, userMachineIds } from "../services/visibility";

export const dailyRoutes = new Hono<AppEnv>();

function dayBoundsUtc(dateIso: string, tzOffset: number): [string, string] {
  // tzOffset: JS getTimezoneOffset() (e.g. -480 for UTC+8) -> local = UTC - tzOffset min -> UTC = local + tzOffset min
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  const shiftMs = tzOffset * 60_000;
  const start = new Date(Date.UTC(y, m - 1, d) + shiftMs);
  const end = new Date(Date.UTC(y, m - 1, d + 1) + shiftMs);
  return [start.toISOString(), end.toISOString()];
}

export async function getDailyData(
  deps: Deps,
  user: UserRow,
  dateStr: string,
  tzOffset: number,
  asOfIso?: string | null,
) {
  const { db, settings } = deps;
  const redis = deps.redis();
  const asOfKey = asOfIso || "live";
  const cacheKey = `daily:detail:${user.id}:${dateStr}:${tzOffset}:${asOfKey}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return cached;

  const targetDate = pyDateFromIso(dateStr);
  if (!targetDate || dateStr.length !== 10) {
    throw new HttpError(400, "Invalid date format, use YYYY-MM-DD");
  }

  const mids = await userMachineIds(db, user, settings);
  const [dayStart, dayEnd] = dayBoundsUtc(targetDate, tzOffset);

  const msgConds: (SQL | undefined)[] = [
    gte(conversationMessages.timestamp, dayStart),
    lt(conversationMessages.timestamp, dayEnd),
    CHAT_MESSAGE_SQL,
    notLike(documents.relativePath, "%/subagents/%"),
    mids !== null ? (mids.length ? inArray(documents.machineId, mids) : sql`false`) : undefined,
    asOfIso ? lte(conversationMessages.timestamp, asOfIso) : undefined,
  ];

  const sumConds: (SQL | undefined)[] = [
    eq(dailySummaries.summaryDate, targetDate),
    !seesAll(user, settings) ? eq(dailySummaries.userId, user.id) : undefined,
    asOfIso ? lte(dailySummaries.createdAt, asOfIso) : undefined,
  ];

  const [msgRows, summaries] = await Promise.all([
    db
      .select({
        docId: documents.id,
        toolId: documents.toolId,
        title: documents.title,
        relPath: documents.relativePath,
        contentType: documents.contentType,
        role: conversationMessages.role,
        cnt: count(),
      })
      .from(conversationMessages)
      .innerJoin(documents, eq(conversationMessages.documentId, documents.id))
      .where(and(...msgConds))
      .groupBy(documents.id, documents.toolId, documents.title, documents.relativePath, documents.contentType, conversationMessages.role),
    db.select().from(dailySummaries).where(and(...sumConds)),
  ]);

  const convMap = new Map<
    string,
    { id: string; tool_id: string; title: string; user_messages: number; assistant_messages: number; content_type: string }
  >();
  for (const r of msgRows) {
    let entry = convMap.get(r.docId);
    if (!entry) {
      entry = {
        id: r.docId,
        tool_id: r.toolId,
        title: r.title || r.relPath,
        user_messages: 0,
        assistant_messages: 0,
        content_type: r.contentType,
      };
      convMap.set(r.docId, entry);
    }
    const n = Number(r.cnt);
    if (r.role === "user") entry.user_messages += n;
    else if (r.role === "assistant") entry.assistant_messages += n;
  }

  const toolStats: Record<string, number> = {};
  const conversations = [...convMap.values()];
  for (const conv of conversations) {
    toolStats[conv.tool_id] = (toolStats[conv.tool_id] ?? 0) + conv.user_messages + conv.assistant_messages;
  }
  conversations.sort((a, b) => b.user_messages - a.user_messages);
  const totalMessages = conversations.reduce((s, x) => s + x.user_messages + x.assistant_messages, 0);

  const payload = {
    date: dateStr,
    total_messages: totalMessages,
    overview: {
      conversations,
      key_changes: [],
      tool_stats: toolStats,
    },
    summaries: summaries.map((s) => ({
      id: s.id,
      tool_id: s.toolId,
      title: s.title,
      summary: s.summary,
      highlights: s.highlights,
    })),
  };
  await cacheSet(redis, cacheKey, payload, 60);
  return payload;
}

dailyRoutes.get("/", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const days = queryInt(c, "days", 365, { ge: 1, le: 3650 });
  const tzOffset = queryInt(c, "tz_offset", 0);

  const cacheKey = `daily:dates:${user.id}:${days}:${tzOffset}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const mids = await userMachineIds(db, user, settings);
  if (mids !== null && !mids.length) {
    await cacheSet(redis, cacheKey, [], 1800);
    return c.json([]);
  }
  const cutoffIso = new Date(Date.now() - days * 86400_000).toISOString();
  const shiftMinutes = -tzOffset;
  const dayExpr = sql<string>`CAST((${conversationMessages.timestamp} + make_interval(mins => ${shiftMinutes})) AS date)::text`;

  const rows = await db
    .select({
      day: dayExpr.as("day"),
      total: count(),
      tools: sql<string[]>`array_agg(DISTINCT ${documents.toolId})`,
    })
    .from(conversationMessages)
    .innerJoin(documents, eq(conversationMessages.documentId, documents.id))
    .where(
      and(
        gte(conversationMessages.timestamp, cutoffIso),
        CHAT_MESSAGE_SQL,
        ne(documents.toolId, "system"),
        mids !== null ? inArray(documents.machineId, mids) : undefined,
      ),
    )
    .groupBy(sql.raw("day"))
    .orderBy(sql.raw("day DESC"));

  const payload = rows.map((r) => ({
    date: r.day,
    document_count: Number(r.total),
    message_count: Number(r.total),
    tools: (Array.isArray(r.tools) ? r.tools : []).filter(Boolean).sort(),
  }));
  await cacheSet(redis, cacheKey, payload, 1800);
  return c.json(payload);
});

dailyRoutes.get("/:dateStr", async (c) => {
  const user = await currentUser(c);
  const tzOffset = queryInt(c, "tz_offset", 0);
  return c.json(await getDailyData(c.var.deps, user, c.req.param("dateStr"), tzOffset));
});

dailyRoutes.get("/:dateStr/messages", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const dateStr = c.req.param("dateStr");
  const offset = queryInt(c, "offset", 0, { ge: 0 });
  const limit = queryInt(c, "limit", 100, { ge: 1, le: 500 });
  const tzOffset = queryInt(c, "tz_offset", 0);

  const targetDate = pyDateFromIso(dateStr);
  if (!targetDate || dateStr.length !== 10) throw new HttpError(400, "Invalid date format");

  const mids = await userMachineIds(db, user, settings);
  const [dayStart, dayEnd] = dayBoundsUtc(targetDate, tzOffset);
  const where = and(
    gte(conversationMessages.timestamp, dayStart),
    lt(conversationMessages.timestamp, dayEnd),
    CHAT_MESSAGE_SQL,
    notLike(documents.relativePath, "%/subagents/%"),
    mids !== null ? (mids.length ? inArray(documents.machineId, mids) : sql`false`) : undefined,
  );

  const [[tot], rows] = await Promise.all([
    db
      .select({ n: count() })
      .from(conversationMessages)
      .innerJoin(documents, eq(conversationMessages.documentId, documents.id))
      .where(where),
    db
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
        timestamp: conversationMessages.timestamp,
        toolId: documents.toolId,
        docTitle: documents.title,
      })
      .from(conversationMessages)
      .innerJoin(documents, eq(conversationMessages.documentId, documents.id))
      .where(where)
      .orderBy(asc(conversationMessages.timestamp), asc(conversationMessages.documentId), asc(conversationMessages.lineNumber))
      .offset(offset)
      .limit(limit),
  ]);

  return c.json({
    date: dateStr,
    total: Number(tot?.n ?? 0),
    offset,
    limit,
    messages: rows.map((r) => ({
      role: r.role,
      content: r.content || "",
      timestamp: pgToIso(r.timestamp),
      tool_id: r.toolId,
      conversation_title: r.docTitle,
    })),
  });
});

dailyRoutes.get("/:dateStr/summary", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const dateStr = c.req.param("dateStr");
  const targetDate = pyDateFromIso(dateStr);
  if (!targetDate || dateStr.length !== 10) throw new HttpError(400, "Invalid date format");

  const [summary] = await db
    .select()
    .from(dailySummaries)
    .where(and(eq(dailySummaries.summaryDate, targetDate), isNull(dailySummaries.toolId), eq(dailySummaries.userId, user.id)))
    .limit(1);
  if (!summary) throw new HttpError(404, "No summary for this date");

  const mids = await userMachineIds(db, user, settings);
  const [dayStart, dayEnd] = dayBoundsUtc(targetDate, -480); // CST UTC+8
  let newestTs: string | null = null;
  if (mids === null || mids.length) {
    const base = db
      .select({ ts: conversationMessages.timestamp })
      .from(conversationMessages);
    const q = mids !== null ? base.innerJoin(documents, eq(conversationMessages.documentId, documents.id)) : base;
    const [row] = await q
      .where(
        and(
          gte(conversationMessages.timestamp, dayStart),
          lt(conversationMessages.timestamp, dayEnd),
          inArray(conversationMessages.role, ["user", "assistant"]),
          mids !== null ? inArray(documents.machineId, mids) : undefined,
        ),
      )
      .orderBy(desc(conversationMessages.timestamp))
      .limit(1);
    newestTs = row?.ts ?? null;
  }

  const newestIso = pgToIso(newestTs);
  const createdIso = pgToIso(summary.createdAt);
  const stale = Boolean(newestIso && createdIso && Date.parse(newestIso) > Date.parse(createdIso));

  return c.json({
    date: dateStr,
    title: summary.title,
    summary: summary.summary,
    highlights: summary.highlights,
    created_at: createdIso,
    stale,
    newest_message_at: newestIso,
  });
});

dailyRoutes.post("/:dateStr/generate-summary", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const dateStr = c.req.param("dateStr");
  const targetDate = pyDateFromIso(dateStr);
  if (!targetDate || dateStr.length !== 10) throw new HttpError(400, "Invalid date format");

  const mids = await userMachineIds(db, user, settings);
  const [dayStart, dayEnd] = dayBoundsUtc(targetDate, -480); // CST UTC+8
  if (mids !== null && !mids.length) throw new HttpError(404, "No conversation messages on this date");

  const base = db
    .select({
      docId: conversationMessages.documentId,
      role: conversationMessages.role,
      content: conversationMessages.content,
    })
    .from(conversationMessages);
  const q = mids !== null ? base.innerJoin(documents, eq(conversationMessages.documentId, documents.id)) : base;
  const msgs = await q
    .where(
      and(
        gte(conversationMessages.timestamp, dayStart),
        lt(conversationMessages.timestamp, dayEnd),
        CHAT_MESSAGE_SQL,
        mids !== null ? inArray(documents.machineId, mids) : undefined,
      ),
    )
    .orderBy(asc(conversationMessages.timestamp));

  if (!msgs.length) throw new HttpError(404, "No conversation messages on this date");

  const byDoc = new Map<string, typeof msgs>();
  for (const m of msgs) {
    const arr = byDoc.get(m.docId) ?? [];
    arr.push(m);
    byDoc.set(m.docId, arr);
  }
  const docIds = [...byDoc.keys()];
  const docRows = await db
    .select({ id: documents.id, toolId: documents.toolId, title: documents.title })
    .from(documents)
    .where(inArray(documents.id, docIds));
  const docMap = new Map(docRows.map((d) => [d.id, d]));

  const convData = docIds.map((docId) => {
    const d = docMap.get(docId);
    const parts: string[] = [];
    for (const m of byDoc.get(docId)!) {
      const prefix = m.role === "user" ? "👤 用户" : "🤖 AI";
      const text = (m.content || "").slice(0, 800);
      if (text) parts.push(`${prefix}: ${text}`);
    }
    return {
      tool_id: d?.toolId || "unknown",
      title: d?.title || docId,
      digest: parts.join("\n"),
    };
  });

  const summaryText = await generateDailySummaryFromDigests(settings, redis, targetDate, convData, { user });
  if (!summaryText) throw new HttpError(500, "AI summary generation failed");

  const title = `AI 日报 - ${dateStr}`;
  const [existing] = await db
    .select()
    .from(dailySummaries)
    .where(and(eq(dailySummaries.summaryDate, targetDate), isNull(dailySummaries.toolId), eq(dailySummaries.userId, user.id)))
    .limit(1);

  if (existing) {
    await db
      .update(dailySummaries)
      .set({ title, summary: withoutNul(summaryText), updatedAt: sql`now()` as unknown as string })
      .where(eq(dailySummaries.id, existing.id));
  } else {
    await db.insert(dailySummaries).values(
      withoutNul({
        id: randomUUID(),
        userId: user.id,
        summaryDate: targetDate,
        toolId: null,
        title,
        summary: summaryText,
      }),
    );
  }
  await cacheDeletePrefix(redis, `daily:detail:${user.id}:${dateStr}:`);
  return c.json({ date: dateStr, title, summary: summaryText, status: "generated" });
});
