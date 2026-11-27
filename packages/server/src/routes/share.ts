// /api/share: public & directed share links for timelines, dailies, memory & conversations
// (server/server/api/share.py).
import { randomBytes, randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { currentUser, optionalUser, type UserRow } from "../auth/current-user";
import { requestIp, type AppEnv } from "../context";
import type { Db } from "../db/client";
import {
  askConversations,
  conversationMessages,
  documents,
  knowledgeEntities,
  knowledgeRelations,
  shareLinks,
  shareViews,
  users,
} from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, queryInt } from "../http";
import { pgToIso, pyDateFromIso } from "../pytime";
import { lookupGeoIp } from "../services/geoip";
import { signMediaUrl, signVideoLinksInText } from "../services/storage";
import { getDailyData } from "./daily";
import { getProjectConversationsData } from "./projects";

export const shareRoutes = new Hono<AppEnv>();

const VALID_KINDS = ["timeline", "daily", "memory", "conversation"] as const;
const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function genToken(): string {
  const bytes = randomBytes(24);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]!;
  return out;
}

function userLabel(u: Pick<UserRow, "name" | "email">): string {
  return u.name || u.email.split("@")[0]!;
}

function serializeShare(
  link: typeof shareLinks.$inferSelect,
  opts: { viewCount?: number; owner?: Pick<UserRow, "name" | "email"> | null; target?: Pick<UserRow, "name" | "email"> | null } = {},
) {
  return {
    token: link.token,
    kind: link.kind,
    target_id: link.targetId,
    title: link.title,
    expires_at: pgToIso(link.expiresAt),
    revoked_at: pgToIso(link.revokedAt),
    created_at: pgToIso(link.createdAt),
    view_count: opts.viewCount ?? 0,
    target_user_id: link.targetUserId,
    target_user_label: opts.target ? userLabel(opts.target) : null,
    owner_label: opts.owner ? userLabel(opts.owner) : null,
  };
}

function parseConversationTargets(raw: string): [string, number[] | null][] {
  const targetId = raw.trim();
  if (!targetId) return [];
  if (targetId.startsWith("[") || targetId.startsWith("{")) {
    try {
      const parsed = JSON.parse(targetId);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((item: Record<string, unknown>) => {
        const cid = normalizeUuid(String(item.id ?? "").trim());
        if (!cid) throw new Error("invalid uuid");
        let turns: number[] | null = null;
        if (Array.isArray(item.turns)) {
          turns = item.turns.map((x) => String(x)).filter((s) => /^\d+$/.test(s)).map(Number);
        }
        return [cid, turns];
      });
    } catch (e) {
      throw new HttpError(400, `invalid json conversation target_id: ${(e as Error).message}`);
    }
  }

  const chunks = targetId.includes(";")
    ? targetId.split(";").map((x) => x.trim()).filter(Boolean)
    : targetId.includes(":")
      ? [targetId]
      : targetId.split(",").map((x) => x.trim()).filter(Boolean);

  const out: [string, number[] | null][] = [];
  for (const chunk of chunks) {
    if (chunk.includes(":")) {
      const idx = chunk.indexOf(":");
      const cidStr = chunk.slice(0, idx).trim();
      const turnsStr = chunk.slice(idx + 1);
      const cid = normalizeUuid(cidStr);
      if (!cid) throw new HttpError(400, `invalid conversation UUID: ${cidStr}`);
      const tIdx = turnsStr.split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number);
      out.push([cid, tIdx.length ? tIdx : null]);
    } else {
      const cid = normalizeUuid(chunk);
      if (!cid) throw new HttpError(400, `invalid conversation UUID: ${chunk}`);
      out.push([cid, null]);
    }
  }
  return out;
}

function validateTarget(kind: string, targetId: string): void {
  if (kind === "timeline") {
    if (!normalizeUuid(targetId)) throw new HttpError(400, "timeline target_id must be a project UUID");
  } else if (kind === "daily") {
    if (!pyDateFromIso(targetId) || targetId.length !== 10) throw new HttpError(400, "daily target_id must be YYYY-MM-DD");
  } else if (kind === "memory") {
    if (targetId !== "all") throw new HttpError(400, "memory target_id must be 'all'");
  } else if (kind === "conversation") {
    if (!parseConversationTargets(targetId).length) {
      throw new HttpError(400, "conversation target_id must contain at least one conversation UUID");
    }
  }
}

async function loadActiveShare(db: Db, token: string, viewer: UserRow | null) {
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1);
  if (!link) throw new HttpError(404, "Not Found");
  if (link.revokedAt) throw new HttpError(410, "revoked");
  if (link.expiresAt && Date.parse(pgToIso(link.expiresAt) ?? link.expiresAt) <= Date.now()) {
    throw new HttpError(410, "expired");
  }
  if (link.targetUserId) {
    if (!viewer) throw new HttpError(401, "login required");
    if (viewer.id !== link.targetUserId && viewer.id !== link.ownerUserId) {
      throw new HttpError(403, "not your share");
    }
  }
  return link;
}

async function recordView(db: Db, linkId: string, c: Context<AppEnv>): Promise<void> {
  const ip = requestIp(c);
  const geo = ip ? lookupGeoIp(ip) : {};
  await db.insert(shareViews).values({
    shareId: linkId,
    ip: ip || null,
    country: geo.country ?? null,
    region: geo.region ?? null,
    city: geo.city ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    referer: c.req.header("referer") ?? null,
  });
}

// ---- Owner & Viewer Routes ----
shareRoutes.post("", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const kind = typeof body.kind === "string" ? body.kind : "";
  const targetId = typeof body.target_id === "string" ? body.target_id : "";
  if (!(VALID_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(400, `kind must be one of (${VALID_KINDS.map((k) => `'${k}'`).join(", ")})`);
  }
  validateTarget(kind, targetId);

  let targetUserId: string | null = null;
  if (typeof body.target_user_id === "string" && body.target_user_id) {
    targetUserId = normalizeUuid(body.target_user_id);
    if (!targetUserId) throw new HttpError(400, "target_user_id must be a UUID");
    if (targetUserId === user.id) throw new HttpError(400, "cannot target yourself");
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, targetUserId), eq(users.status, "active")))
      .limit(1);
    if (!target) throw new HttpError(404, "target user not found");
  }

  let expiresAt: string | null = null;
  if (typeof body.expires_in_days === "number" && body.expires_in_days > 0) {
    expiresAt = new Date(Date.now() + body.expires_in_days * 86400_000).toISOString();
  }

  let token = "";
  for (let i = 0; i < 5; i++) {
    const cand = genToken();
    const [exists] = await db.select({ id: shareLinks.id }).from(shareLinks).where(eq(shareLinks.token, cand)).limit(1);
    if (!exists) {
      token = cand;
      break;
    }
  }
  if (!token) throw new HttpError(500, "token generation failed");

  const [link] = await db
    .insert(shareLinks)
    .values({
      id: randomUUID(),
      token,
      kind,
      targetId,
      ownerUserId: user.id,
      targetUserId,
      title: typeof body.title === "string" ? body.title : null,
      expiresAt,
    })
    .returning();
  return c.json(serializeShare(link!, { viewCount: 0 }));
});

shareRoutes.get("", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const rows = await db
    .select({ link: shareLinks, viewCount: count(shareViews.id) })
    .from(shareLinks)
    .leftJoin(shareViews, eq(shareViews.shareId, shareLinks.id))
    .where(eq(shareLinks.ownerUserId, user.id))
    .groupBy(shareLinks.id)
    .orderBy(desc(shareLinks.createdAt));

  const targetIds = [...new Set(rows.map((r) => r.link.targetUserId).filter((x): x is string => Boolean(x)))];
  const targets = new Map<string, Pick<UserRow, "name" | "email">>();
  if (targetIds.length) {
    const uRows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, targetIds));
    for (const u of uRows) targets.set(u.id, u);
  }
  return c.json(
    rows.map((r) =>
      serializeShare(r.link, {
        viewCount: Number(r.viewCount ?? 0),
        target: r.link.targetUserId ? targets.get(r.link.targetUserId) ?? null : null,
      }),
    ),
  );
});

shareRoutes.get("/recipients", async (c) => {
  const user = await currentUser(c);
  if (user.role !== "admin" && user.role !== "owner") throw new HttpError(403, "admin only");
  const rows = await c.var.deps.db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(users)
    .where(and(eq(users.status, "active"), ne(users.id, user.id)))
    .orderBy(asc(users.role), asc(users.email));
  return c.json(rows.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, label: userLabel(u) })));
});

shareRoutes.get("/inbox", async (c) => {
  const user = await currentUser(c);
  const rows = await c.var.deps.db
    .select({ link: shareLinks, ownerName: users.name, ownerEmail: users.email })
    .from(shareLinks)
    .innerJoin(users, eq(users.id, shareLinks.ownerUserId))
    .where(and(eq(shareLinks.targetUserId, user.id), isNull(shareLinks.revokedAt)))
    .orderBy(desc(shareLinks.createdAt));
  const nowMs = Date.now();
  const out = [];
  for (const r of rows) {
    if (r.link.expiresAt && Date.parse(pgToIso(r.link.expiresAt) ?? r.link.expiresAt) <= nowMs) continue;
    out.push(serializeShare(r.link, { owner: { name: r.ownerName, email: r.ownerEmail }, target: user }));
  }
  return c.json(out);
});

// ---- Public / Visitor Routes ----
shareRoutes.get("/public/:token", async (c) => {
  const { db } = c.var.deps;
  const viewer = await optionalUser(c);
  const link = await loadActiveShare(db, c.req.param("token"), viewer);
  const [owner] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, link.ownerUserId)).limit(1);
  await recordView(db, link.id, c);
  const [vc] = await db.select({ n: count() }).from(shareViews).where(eq(shareViews.shareId, link.id));
  return c.json({
    kind: link.kind,
    target_id: link.targetId,
    title: link.title,
    owner_name: owner ? userLabel(owner) : "",
    expires_at: pgToIso(link.expiresAt),
    created_at: pgToIso(link.createdAt),
    view_count: Number(vc?.n ?? 0),
    directed: Boolean(link.targetUserId),
  });
});

shareRoutes.get("/public/:token/data", async (c) => {
  const deps = c.var.deps;
  const { db, settings } = deps;
  const viewer = await optionalUser(c);
  const link = await loadActiveShare(db, c.req.param("token"), viewer);
  const [owner] = await db.select().from(users).where(eq(users.id, link.ownerUserId)).limit(1);
  if (!owner) throw new HttpError(404, "Not Found");
  const asOfIso = pgToIso(link.createdAt) ?? link.createdAt;

  if (link.kind === "timeline") {
    const pid = normalizeUuid(link.targetId);
    if (!pid) throw new HttpError(404, "Not Found");
    const data = await getProjectConversationsData(deps, owner, pid, {
      sessionOffset: 0,
      sessionLimit: 10,
      maxMessagesPerSession: 80,
      order: "asc",
      artifacts: true,
      asOfIso,
    });
    return c.json({ kind: "timeline", data });
  }

  if (link.kind === "daily") {
    const data = await getDailyData(deps, owner, link.targetId, 0, asOfIso);
    return c.json({ kind: "daily", data });
  }

  if (link.kind === "memory") {
    const ents = await db
      .select()
      .from(knowledgeEntities)
      .where(and(eq(knowledgeEntities.userId, owner.id), lte(knowledgeEntities.updatedAt, asOfIso)))
      .orderBy(desc(knowledgeEntities.updatedAt))
      .limit(200);
    const ids = ents.map((e) => e.id);
    const nodes = ents.map((e) => ({ id: e.id, name: e.name, type: e.entityType, summary: e.summary }));
    const edges = ids.length
      ? (
          await db
            .select()
            .from(knowledgeRelations)
            .where(and(inArray(knowledgeRelations.sourceId, ids), inArray(knowledgeRelations.targetId, ids), lte(knowledgeRelations.createdAt, asOfIso)))
        ).map((r) => ({ source: r.sourceId, target: r.targetId, type: r.relationType, strength: r.strength }))
      : [];
    return c.json({ kind: "memory", data: { nodes, edges, total_entities: nodes.length, total_relations: edges.length } });
  }

  if (link.kind === "conversation") {
    const parsedTargets = parseConversationTargets(link.targetId);
    if (!parsedTargets.length) throw new HttpError(404, "no conversations in share");
    const convIds = parsedTargets.map(([cid]) => cid);
    const askRows = await db
      .select()
      .from(askConversations)
      .where(and(inArray(askConversations.id, convIds), eq(askConversations.userId, owner.id)));
    const askMap = new Map(askRows.map((x) => [x.id, x]));

    const remIds = convIds.filter((cid) => !askMap.has(cid));
    const docMap = new Map<string, typeof documents.$inferSelect>();
    if (remIds.length) {
      const docRows = await db
        .select()
        .from(documents)
        .where(and(inArray(documents.id, remIds), eq(documents.category, "conversation")));
      for (const d of docRows) docMap.set(d.id, d);
    }

    const conversationsData: Record<string, unknown>[] = [];
    for (const [cid, turnIndices] of parsedTargets) {
      const askConv = askMap.get(cid);
      if (askConv) {
        const rawTurns = Array.isArray(askConv.turns) ? (askConv.turns as Record<string, unknown>[]) : [];
        let effective = turnIndices;
        if (turnIndices && rawTurns.length > 100 && link.title && link.title.includes("提问：")) {
          const targetPrompt = link.title.split("提问：", 2)[1]!.trim().replace(/\.\.\.$/, "").slice(0, 24);
          if (targetPrompt) {
            for (let sIdx = rawTurns.length - 1; sIdx >= Math.max(0, rawTurns.length - 150); sIdx--) {
              const sc = String(rawTurns[sIdx]?.content ?? "");
              if (sc.includes(targetPrompt)) {
                effective = turnIndices.length === 2 && turnIndices[1] === turnIndices[0]! + 1 ? [sIdx, sIdx + 1] : [sIdx];
                break;
              }
            }
          }
        }
        const idxSet = effective ? new Set(effective) : null;
        const turns = rawTurns
          .map((t, idx) => ({ idx, t }))
          .filter(({ idx, t }) => Boolean(t && typeof t === "object") && (!idxSet || idxSet.has(idx)))
          .map(({ idx, t }) => ({
            index: idx,
            role: t.role || "user",
            content: signVideoLinksInText(String(t.content ?? ""), settings.secretKey),
            images: (Array.isArray(t.images) ? t.images : []).map((i) => signMediaUrl(String(i), settings.secretKey)),
            thinking: t.thinking ?? null,
            toolCalls: Array.isArray(t.toolCalls) ? t.toolCalls : [],
            sources: Array.isArray(t.sources) ? t.sources : [],
            created_at: t.created_at ?? null,
          }));
        conversationsData.push({
          id: askConv.id,
          title: askConv.title || "对话",
          type: "ask",
          tool_id: "ask",
          created_at: pgToIso(askConv.createdAt),
          updated_at: pgToIso(askConv.updatedAt),
          message_count: turns.length,
          is_partial: turnIndices !== null,
          total_original_messages: rawTurns.length,
          turns,
        });
      } else {
        const d = docMap.get(cid);
        if (!d) continue;
        const msgs = await db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.documentId, d.id))
          .orderBy(asc(conversationMessages.lineNumber));
        const idxSet = turnIndices ? new Set(turnIndices) : null;
        const turns = msgs
          .map((m, idx) => ({ idx, m }))
          .filter(({ idx }) => !idxSet || idxSet.has(idx))
          .map(({ idx, m }) => {
            const md = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
            const isTool = m.messageType && !["user", "assistant", "system", "message"].includes(m.messageType);
            return {
              index: idx,
              role: m.role || "user",
              content: m.content,
              thinking: md.thinking ?? null,
              toolCalls: isTool ? [{ name: m.messageType, args: md.tool_input }] : [],
              created_at: pgToIso(m.timestamp ?? m.createdAt),
            };
          });
        conversationsData.push({
          id: d.id,
          title: d.title || d.relativePath || "会话",
          type: "collected",
          tool_id: d.toolId,
          created_at: pgToIso(d.createdAt),
          message_count: turns.length,
          is_partial: turnIndices !== null,
          total_original_messages: msgs.length,
          turns,
        });
      }
    }
    if (!conversationsData.length) throw new HttpError(404, "shared conversations not found");
    return c.json({ kind: "conversation", data: { total_conversations: conversationsData.length, conversations: conversationsData } });
  }

  throw new HttpError(400, `unknown share kind: ${link.kind}`);
});

shareRoutes.get("/:token/views", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const limit = queryInt(c, "limit", 100, { ge: 1, le: 1000 });
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.token, c.req.param("token"))).limit(1);
  if (!link || link.ownerUserId !== user.id) throw new HttpError(404, "Not Found");
  const rows = await db
    .select()
    .from(shareViews)
    .where(eq(shareViews.shareId, link.id))
    .orderBy(desc(shareViews.viewedAt))
    .limit(limit);
  return c.json(
    rows.map((v) => ({
      id: Number(v.id),
      ip: v.ip ? String(v.ip) : null,
      country: v.country,
      region: v.region,
      city: v.city,
      user_agent: (v.userAgent || "").slice(0, 400),
      referer: v.referer,
      viewed_at: pgToIso(v.viewedAt),
    })),
  );
});

shareRoutes.delete("/:token", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.token, c.req.param("token"))).limit(1);
  if (!link || link.ownerUserId !== user.id) throw new HttpError(404, "Not Found");
  await db.update(shareLinks).set({ revokedAt: new Date().toISOString() }).where(eq(shareLinks.id, link.id));
  return c.json({ status: "revoked" });
});
