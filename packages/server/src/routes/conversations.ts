// Conversations API (server/server/api/conversations.py): /api/conversations/*.
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import { cacheDeletePrefix } from "../cache";
import type { AppEnv } from "../context";
import { conversationMessages, documents } from "../db/pulled/schema";
import { HttpError, parseJsonObject, parseOptionalJsonObject, pathUuid, queryInt } from "../http";
import { pgToIso } from "../pytime";
import { countConversationMessages, parseConversation } from "../services/conversation-parser";
import { extractCustomTitle, isJunkOrUuidTitle, titleFromUserMessages } from "../services/ingest-service";
import { buildCompactedContinuation, getSessionStats } from "../services/session-compactor";
import { userMachineIds } from "../services/visibility";

export const conversationRoutes = new Hono<AppEnv>();

conversationRoutes.get("/:id/stats", async (c) => {
  const user = await currentUser(c);
  const { db, settings } = c.var.deps;
  const sessionId = c.req.param("id");
  const mids = await userMachineIds(db, user, settings);
  const stats = await getSessionStats(db, settings, sessionId, mids);
  return c.json(stats);
});

conversationRoutes.post("/:id/compact", async (c) => {
  const user = await currentUser(c);
  const { db, settings, redis } = c.var.deps;
  const sessionId = c.req.param("id");
  const body = await parseOptionalJsonObject(c);
  let recentTurns = 6;
  let newPrompt = "";
  if (body) {
    if ("recent_turns" in body && body.recent_turns !== undefined) {
      if (typeof body.recent_turns !== "number" || !Number.isInteger(body.recent_turns)) {
        throw new HttpError(422, [{ type: "int_parsing", loc: ["body", "recent_turns"], msg: "Input should be a valid integer", input: body.recent_turns }]);
      }
      if (body.recent_turns < 2 || body.recent_turns > 30) {
        throw new HttpError(422, [{ type: body.recent_turns < 2 ? "greater_than_equal" : "less_than_equal", loc: ["body", "recent_turns"], msg: "recent_turns must be between 2 and 30", input: body.recent_turns }]);
      }
      recentTurns = body.recent_turns;
    }
    if ("new_prompt" in body && body.new_prompt !== undefined) {
      if (typeof body.new_prompt !== "string") {
        throw new HttpError(422, [{ type: "string_type", loc: ["body", "new_prompt"], msg: "Input should be a valid string", input: body.new_prompt }]);
      }
      newPrompt = body.new_prompt;
    }
  }
  const mids = await userMachineIds(db, user, settings);
  const res = await buildCompactedContinuation(db, settings, redis(), user, sessionId, newPrompt, recentTurns, mids);
  if (!res.injected_context) throw new HttpError(404, "session not found");
  return c.json(res);
});

conversationRoutes.get("/:doc_id/messages", async (c) => {
  const user = await currentUser(c);
  const { db, settings } = c.var.deps;
  const docId = pathUuid(c, "doc_id");
  const offset = queryInt(c, "offset", 0, { ge: 0 });
  const limit = queryInt(c, "limit", 50, { ge: 1, le: 200 });
  const mids = await userMachineIds(db, user, settings);

  const [doc] = await db
    .select({ id: documents.id, toolId: documents.toolId, machineId: documents.machineId })
    .from(documents)
    .where(eq(documents.id, docId))
    .limit(1);
  if (!doc || (mids !== null && (!doc.machineId || !mids.includes(doc.machineId)))) throw new HttpError(404, "Not Found");

  const [cntRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(conversationMessages)
    .where(eq(conversationMessages.documentId, docId));
  let total = Number(cntRow?.c ?? 0);

  if (total > 0) {
    const msgs = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.documentId, docId))
      .orderBy(asc(conversationMessages.lineNumber))
      .offset(offset)
      .limit(limit);
    return c.json({
      total,
      offset,
      limit,
      messages: msgs.map((m) => {
        const meta = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
        return {
          id: Number(m.id),
          line_number: m.lineNumber,
          role: m.role || m.messageType,
          content: m.content,
          thinking: meta.thinking ?? null,
          tool_name: (meta.tool_name as string | undefined) ?? "",
          tool_input: (meta.tool_input as string | undefined) ?? "",
          status: meta.status ?? null,
          exit_code: meta.exit_code ?? null,
          error: meta.error ?? null,
          timestamp: pgToIso(m.timestamp),
          raw_type: m.messageType || "",
        };
      }),
    });
  }

  const [cRow] = await db.select({ content: documents.content }).from(documents).where(eq(documents.id, docId)).limit(1);
  if (cRow?.content) {
    total = countConversationMessages(cRow.content, doc.toolId);
    const page = parseConversation(cRow.content, doc.toolId, offset, limit);
    return c.json({
      total,
      offset,
      limit,
      messages: page.map((m, i) => ({
        id: offset + i,
        line_number: offset + i + 1,
        role: m.role,
        content: m.content,
        thinking: m.thinking || null,
        tool_name: m.toolName,
        tool_input: m.toolInput,
        status: m.status || null,
        exit_code: m.exitCode,
        error: m.error || null,
        timestamp: m.timestamp || null,
        raw_type: m.rawType,
      })),
    });
  }
  return c.json({ total: 0, offset, limit, messages: [] });
});

conversationRoutes.get("/:doc_id", async (c) => {
  const user = await currentUser(c);
  const { db, settings } = c.var.deps;
  const docId = pathUuid(c, "doc_id");
  const mids = await userMachineIds(db, user, settings);

  const [doc] = await db
    .select({
      id: documents.id,
      toolId: documents.toolId,
      title: documents.title,
      relativePath: documents.relativePath,
      metadata: documents.metadata,
      machineId: documents.machineId,
      syncedAt: documents.syncedAt,
    })
    .from(documents)
    .where(eq(documents.id, docId))
    .limit(1);
  if (!doc || (mids !== null && (!doc.machineId || !mids.includes(doc.machineId)))) throw new HttpError(404, "Not Found");

  const meta = (doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {}) as Record<string, unknown>;
  const sid = typeof meta.session_id === "string" ? meta.session_id : null;
  let title = doc.title;

  if (isJunkOrUuidTitle(title, sid)) {
    const userMsgs = await db
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.documentId, docId), eq(conversationMessages.role, "user")))
      .orderBy(asc(conversationMessages.lineNumber))
      .limit(25);
    let cand = titleFromUserMessages(userMsgs.map((m) => m.content), sid);
    if (!cand) {
      const [cRow] = await db.select({ content: documents.content }).from(documents).where(eq(documents.id, docId)).limit(1);
      if (cRow?.content) {
        cand = extractCustomTitle(cRow.content, sid);
        if (!cand) {
          const mReq = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(cRow.content.slice(0, 15_000));
          if (mReq) cand = titleFromUserMessages([mReq[1]!], sid);
        }
      }
    }
    if (cand && cand !== title) {
      title = cand;
      await db.update(documents).set({ title: cand }).where(eq(documents.id, docId));
    }
  }

  const [cntRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(conversationMessages)
    .where(eq(conversationMessages.documentId, docId));
  let messageCount = Number(cntRow?.c ?? 0);
  if (messageCount === 0) {
    const [cRow] = await db.select({ content: documents.content }).from(documents).where(eq(documents.id, docId)).limit(1);
    if (cRow?.content) messageCount = countConversationMessages(cRow.content, doc.toolId);
  }

  const relatedPlans: Record<string, unknown>[] = [];
  const sessionId = (meta.session_id || meta.cascade_id) as string | undefined;
  if (sessionId && doc.toolId === "antigravity") {
    const planConds = [eq(documents.toolId, "antigravity"), eq(documents.category, "plan"), sql`${documents.metadata}->>'session_id' = ${sessionId}`];
    if (mids !== null) {
      if (!mids.length) {
        planConds.push(sql`false`);
      } else {
        planConds.push(inArray(documents.machineId, mids));
      }
    }
    const plans = await db
      .select({
        id: documents.id,
        title: documents.title,
        relativePath: documents.relativePath,
        category: documents.category,
        contentType: documents.contentType,
        content: documents.content,
        fileSizeBytes: documents.fileSizeBytes,
        syncedAt: documents.syncedAt,
      })
      .from(documents)
      .where(and(...planConds))
      .orderBy(desc(documents.syncedAt));
    for (const p of plans) {
      if (p.relativePath.includes(".resolved") || p.relativePath.includes(".metadata.json")) continue;
      relatedPlans.push({
        id: p.id,
        title: p.title,
        relative_path: p.relativePath,
        category: p.category,
        content_type: p.contentType,
        content: p.content ? p.content.slice(0, 5000) : null,
        file_size_bytes: p.fileSizeBytes,
        synced_at: pgToIso(p.syncedAt),
      });
    }
  }

  return c.json({
    id: doc.id,
    tool_id: doc.toolId,
    title,
    relative_path: doc.relativePath,
    metadata: doc.metadata,
    message_count: messageCount,
    synced_at: pgToIso(doc.syncedAt),
    related_plans: relatedPlans,
  });
});

conversationRoutes.patch("/:doc_id", async (c) => {
  const user = await currentUser(c);
  const { db, settings, redis } = c.var.deps;
  const docId = pathUuid(c, "doc_id");
  const body = await parseJsonObject(c);
  if (!("title" in body)) {
    throw new HttpError(422, [{ type: "missing", loc: ["body", "title"], msg: "Field required", input: body }]);
  }
  if (typeof body.title !== "string") {
    throw new HttpError(422, [{ type: "string_type", loc: ["body", "title"], msg: "Input should be a valid string", input: body.title }]);
  }
  if (body.title.length < 1 || body.title.length > 255) {
    throw new HttpError(422, [
      {
        type: body.title.length < 1 ? "string_too_short" : "string_too_long",
        loc: ["body", "title"],
        msg: body.title.length < 1 ? "String should have at least 1 character" : "String should have at most 255 characters",
        input: body.title,
      },
    ]);
  }
  const mids = await userMachineIds(db, user, settings);
  const [doc] = await db
    .select({ id: documents.id, machineId: documents.machineId, projectId: documents.projectId, relativePath: documents.relativePath })
    .from(documents)
    .where(eq(documents.id, docId))
    .limit(1);
  if (!doc || (mids !== null && (!doc.machineId || !mids.includes(doc.machineId)))) throw new HttpError(404, "Not Found");

  const newTitle = body.title.trim();
  await db.update(documents).set({ title: newTitle }).where(eq(documents.id, docId));
  if (doc.relativePath.endsWith(".jsonl") && doc.projectId) {
    const parentPrefix = `${doc.relativePath.slice(0, -6)}/subagents/`;
    await db
      .update(documents)
      .set({ title: newTitle })
      .where(and(eq(documents.projectId, doc.projectId), like(documents.relativePath, `${parentPrefix}%`)));
  }

  const r = redis();
  if (doc.projectId) {
    await cacheDeletePrefix(r, `project:conv:${user.id}:${doc.projectId}:`);
    await cacheDeletePrefix(r, `project:conv:v2:${user.id}:${doc.projectId}:`);
    await cacheDeletePrefix(r, `project:timeline:${user.id}:${doc.projectId}:`);
  }
  await cacheDeletePrefix(r, `projects:list:${user.id}:`);
  await cacheDeletePrefix(r, `projects:list:v2:${user.id}:`);

  return c.json({ status: "ok", id: doc.id, title: newTitle });
});
