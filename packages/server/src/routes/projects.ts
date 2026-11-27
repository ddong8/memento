// /api/projects: browse projects, timelines, conversations, markdown export & blueprints
// (server/server/api/projects.py).
import { randomUUID } from "node:crypto";

import { and, count, desc, eq, ilike, inArray, isNull, lte, max, min, not, notInArray, notLike, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { AppEnv, Deps } from "../context";
import {
  conversationMessages,
  documents,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  projects,
  tools,
} from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, pathUuid, queryInt } from "../http";
import { pgToIso } from "../pytime";
import { codeBlueprintPath, isCodeBlueprintPath } from "../services/blueprint-pick";
import * as biz from "../services/business-blueprint";
import { resumeCost, sessionActivity } from "../services/claude-session";
import type { MachineRow } from "../services/device-merge";
import {
  cleanSourcePath,
  ensureProject,
  IGNORE_PROJECT_NAMES,
  isJunkOrUuidTitle,
  isJunkProject,
  safeDecodePbtxtString,
  titleFromUserMessages,
} from "../services/ingest-service";
import { keysOf, matchAnyExclusion as matchAny } from "../services/project-exclusion";
import { consolidateProjectsIfNeeded, reconcileProjectDocuments } from "../services/project-maintenance";
import {
  deviceIndex,
  discoveredFor,
  discoveredProjects,
  pickProjectPath,
  projectDevices,
  projectPlacements,
  type DeviceRef,
  type Placement,
} from "../services/project-placement";
import { findMachineByIdOrHash } from "../services/user-filter";
import { machineFilter, userMachineIds } from "../services/visibility";

export const projectRoutes = new Hono<AppEnv>();

async function bustProjectCache(deps: Deps, projectId?: string | null, userId?: string | null): Promise<void> {
  const redis = deps.redis();
  try {
    if (userId) {
      await cacheDeletePrefix(redis, `projects:list:${userId}:`);
      await cacheDeletePrefix(redis, `projects:list:v2:${userId}:`);
      if (projectId) {
        await cacheDeletePrefix(redis, `project:conv:${userId}:${projectId}:`);
        await cacheDeletePrefix(redis, `project:conv:v2:${userId}:${projectId}:`);
        await cacheDeletePrefix(redis, `project:conv:v3:${userId}:${projectId}:`);
        await cacheDeletePrefix(redis, `project:timeline:${userId}:${projectId}:`);
      }
    } else {
      await cacheDeletePrefix(redis, "projects:list:");
      await cacheDeletePrefix(redis, "projects:list:v2:");
      if (projectId) {
        await cacheDeletePrefix(redis, "project:conv:");
        await cacheDeletePrefix(redis, "project:conv:v2:");
        await cacheDeletePrefix(redis, "project:conv:v3:");
        await cacheDeletePrefix(redis, "project:timeline:");
      }
    }
    if (projectId) await cacheDeletePrefix(redis, "project:blueprint:");
  } catch {
    /* ignore */
  }
}

function deviceDocScope(targetMachine: MachineRow | null, mids: string[] | null): SQL | undefined {
  if (!targetMachine) {
    if (mids === null) return undefined;
    return mids.length ? inArray(documents.machineId, mids) : sql`false`;
  }
  const targetMid = targetMachine.id;
  const name = (targetMachine.name || "").toLowerCase();
  if (name.includes("mac-mini")) {
    return or(
      eq(documents.machineId, targetMid),
      ilike(documents.relativePath, "%haixingdong%"),
      sql`${documents.metadata}->>'project_path' ILIKE '%haixingdong%'`,
    );
  }
  if (name.includes("macbook")) {
    return or(
      eq(documents.machineId, targetMid),
      ilike(documents.relativePath, "%donghaixing%"),
      sql`${documents.metadata}->>'project_path' ILIKE '%donghaixing%'`,
    );
  }
  if (["windows", "desktop-", "laptop-", "win-", "admin"].some((k) => name.includes(k))) {
    return or(
      eq(documents.machineId, targetMid),
      sql`${documents.metadata}->>'project_path' ILIKE '%d:/%'`,
      sql`${documents.metadata}->>'project_path' ILIKE '%c:/%'`,
      ilike(documents.relativePath, "%users-admin%"),
    );
  }
  return eq(documents.machineId, targetMid);
}

async function resolveCodebaseBlueprint(deps: Deps, project: typeof projects.$inferSelect, mids: string[] | null): Promise<string | null> {
  const copy = await biz.codebaseBlueprintCopy(deps.db, project, mids);
  return copy ? copy[0] : null;
}

async function businessBlueprintFields(deps: Deps, project: typeof projects.$inferSelect, mids: string[] | null, user: UserRow | null) {
  const code = await biz.codebaseBlueprintCopy(deps.db, project, mids);
  let found: [string, string | null] | null = null;
  try {
    found = await biz.resolveBusinessBlueprint(deps.db, project, mids, code ? code[1] : null);
  } catch {
    found = null;
  }
  const text = found ? found[0] : null;
  const out: Record<string, unknown> = {
    business_blueprint: text,
    business_check: text ? biz.checkSummary(text) : null,
  };
  if (user) {
    let rules: string[] = [];
    try {
      rules = await biz.projectRules(deps.db, deps.redis(), user, project);
    } catch {
      rules = [];
    }
    out.business_rules_total = biz.rulesTotal(rules);
    out.business_uncovered_rules = biz.uncoveredRules(text || "", rules);
  }
  return out;
}

function isExportNoise(path: string): boolean {
  return path.includes(".resolved") || path.includes(".meta.json") || path.includes(".metadata.json");
}

// ---- GET /api/projects ----
projectRoutes.get("", async (c) => {
  const deps = c.var.deps;
  const { db, settings } = deps;
  const redis = deps.redis();
  const user = await currentUser(c);
  const toolId = c.req.query("tool_id") || null;
  const deviceId = c.req.query("device_id") || null;
  const sync = (c.req.query("sync") ?? "").toLowerCase() === "true" || c.req.query("sync") === "1";

  const cacheKey = `projects:list:v2:${user.id}:${toolId || "all"}:${deviceId || "all"}`;
  if (!sync) {
    const cached = await cacheGet(redis, cacheKey);
    if (cached != null) return c.json(cached);
  }

  const mids = await userMachineIds(db, user, settings);
  let targetMachine: MachineRow | null = null;
  if (deviceId && !["auto", "ask_only", "all"].includes(deviceId)) {
    targetMachine = await findMachineByIdOrHash(db, settings, deviceId, user);
    if (!targetMachine) return c.json([]);
  }

  await consolidateProjectsIfNeeded(db, sync);

  const scope = deviceDocScope(targetMachine, mids);
  const joinCond = scope ? and(eq(documents.projectId, projects.id), scope) : eq(documents.projectId, projects.id);
  const whereConds: SQL[] = [
    notInArray(projects.title, [...IGNORE_PROJECT_NAMES]),
    notLike(projects.slug, "%/file:"),
    notLike(projects.slug, "%/file"),
  ];
  if (toolId) whereConds.push(eq(projects.toolId, toolId));

  const docCountExpr = count(documents.id);
  const rows = await db
    .select({ project: projects, docCount: docCountExpr })
    .from(projects)
    .leftJoin(documents, joinCond)
    .where(and(...whereConds))
    .groupBy(projects.id)
    .having(sql`count(${documents.id}) > 0`)
    .orderBy(desc(projects.updatedAt));

  const index = await deviceIndex(db, settings, user);
  const placements = await projectPlacements(
    db,
    rows.map((r) => r.project.id),
    scope,
  );
  const discovered = await discoveredProjects(db, targetMachine, mids, toolId);
  const targetRef: DeviceRef | null = targetMachine
    ? { deviceId: targetMachine.collectorTokenHash || targetMachine.id, name: targetMachine.name }
    : null;

  const entry = (p: typeof projects.$inferSelect, path: string, cnt: number, devicesList: unknown[]) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    tool_id: p.toolId,
    source_path: path,
    visibility: p.visibility,
    document_count: cnt,
    created_at: pgToIso(p.createdAt),
    updated_at: pgToIso(p.updatedAt),
    devices: devicesList,
  });

  const items: ReturnType<typeof entry>[] = [];
  for (const r of rows) {
    const p = r.project;
    const cnt = Number(r.docCount ?? 0);
    const found = discoveredFor(p.slug, discovered);
    let path = "";
    let devicesList: Record<string, unknown>[];
    if (targetRef) {
      const pls = placements.get(p.id) ?? [];
      path =
        pickProjectPath(pls, p.slug, p.title) ||
        found
          .map((d) => cleanSourcePath(d.path))
          .find((cPath) => Boolean(cPath && !isJunkProject(null, cPath))) ||
        "";
      let bestMs = 0;
      let bestRaw: string | null = null;
      for (const pl of pls) {
        if (pl.lastActive > bestMs) {
          bestMs = pl.lastActive;
          bestRaw = pl.lastActiveRaw;
        }
      }
      devicesList = [
        {
          device_id: targetRef.deviceId,
          name: targetRef.name,
          source_path: path,
          document_count: cnt,
          last_active: bestMs > 0 ? bestRaw : null,
        },
      ];
    } else {
      devicesList = projectDevices(p.slug, p.title, placements.get(p.id) ?? [], found, index);
      path =
        (devicesList.find((d) => d.source_path)?.source_path as string | undefined) ||
        cleanSourcePath(p.sourcePath) ||
        "";
    }
    if (isJunkProject(p.title, path || p.sourcePath)) continue;
    items.push(entry(p, path, cnt, devicesList));
  }

  const existingSlugs = new Set(items.map((it) => it.slug));
  for (const d of discovered) {
    const cSlug = `${d.toolId}/${d.name}`;
    if (existingSlugs.has(cSlug)) continue;
    const cPath = cleanSourcePath(d.path) || "";
    if (isJunkProject(d.name, cPath)) continue;
    existingSlugs.add(cSlug);
    const found = discoveredFor(cSlug, discovered);
    let projObj: typeof projects.$inferSelect;
    try {
      projObj = await ensureProject(db, d.toolId, d.name, d.path);
    } catch {
      continue;
    }
    if (targetRef) {
      items.push(
        entry(projObj, cPath, 0, [
          { device_id: targetRef.deviceId, name: targetRef.name, source_path: cPath, document_count: 0, last_active: null },
        ]),
      );
    } else {
      const devicesList = projectDevices(cSlug, projObj.title, [], found, index);
      const p = devicesList.find((x) => x.source_path)?.source_path || cPath;
      items.push(entry(projObj, p, 0, devicesList));
    }
  }

  const skip = keysOf(user);
  const filtered = skip.length ? items.filter((it) => !matchAny(skip, it.title)) : items;
  if (!sync) await cacheSet(redis, cacheKey, filtered, 300);
  return c.json(filtered);
});

// ---- GET /api/projects/:project_id ----
projectRoutes.get("/:project_id", async (c) => {
  const deps = c.var.deps;
  const { db, settings } = deps;
  const user = await currentUser(c);
  const pid = pathUuid(c, "project_id");
  const includeContent = (c.req.query("include_content") ?? "").toLowerCase() === "true" || c.req.query("include_content") === "1";

  const mids = await userMachineIds(db, user, settings);
  const [project] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
  if (!project) throw new HttpError(404, "Not Found");

  const docConds: SQL[] = [eq(documents.projectId, pid)];
  const mf = machineFilter(mids, documents.machineId);
  if (mf) docConds.push(mf);

  const docs = await db
    .select({
      id: documents.id,
      relativePath: documents.relativePath,
      category: documents.category,
      title: documents.title,
      fileSizeBytes: documents.fileSizeBytes,
      syncedAt: documents.syncedAt,
      ...(includeContent ? { content: documents.content, aiSummary: documents.aiSummary } : {}),
    })
    .from(documents)
    .where(and(...docConds))
    .orderBy(desc(documents.syncedAt))
    .limit(50);

  const INLINE_CATS = new Set(["identity", "memory", "plan", "learning", "note"]);
  const docRows = docs.map((d) => {
    const row: Record<string, unknown> = {
      id: d.id,
      relative_path: d.relativePath,
      category: d.category,
      title: d.title,
      file_size_bytes: d.fileSizeBytes,
      synced_at: pgToIso(d.syncedAt),
    };
    if (includeContent && INLINE_CATS.has(d.category)) {
      row.content = (d as { content?: string | null }).content ?? null;
      const sum = (d as { aiSummary?: string | null }).aiSummary;
      if (sum) row.ai_summary = sum;
    }
    return row;
  });

  const cleanPath = cleanSourcePath(project.sourcePath);
  const codebaseBlueprint = await resolveCodebaseBlueprint(deps, project, mids);
  const bizFields = await businessBlueprintFields(deps, project, mids, user);

  return c.json({
    id: project.id,
    slug: project.slug,
    title: project.title,
    tool_id: project.toolId,
    source_path: cleanPath,
    visibility: project.visibility,
    codebase_blueprint: codebaseBlueprint,
    ...bizFields,
    documents: docRows,
  });
});

// ---- PATCH /api/projects/:project_id ----
projectRoutes.patch("/:project_id", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const pid = pathUuid(c, "project_id");
  const body = await parseJsonObject(c);
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, pid)).limit(1);
  if (!project) throw new HttpError(404, "Not Found");

  const patch: Partial<typeof projects.$inferInsert> = {};
  if ("source_path" in body && typeof body.source_path === "string") {
    const clean = cleanSourcePath(body.source_path);
    if (clean) patch.sourcePath = clean;
  }
  if ("title" in body && typeof body.title === "string") {
    const t = body.title.trim();
    if (t) patch.title = t;
  }
  let updated = project;
  if (Object.keys(patch).length) {
    const [row] = await deps.db.update(projects).set(patch).where(eq(projects.id, pid)).returning();
    if (row) updated = row;
  }
  await bustProjectCache(deps, pid, user.id);
  return c.json({
    id: updated.id,
    slug: updated.slug,
    title: updated.title,
    source_path: updated.sourcePath,
  });
});

// ---- GET /api/projects/:project_id/timeline ----
projectRoutes.get("/:project_id/timeline", async (c) => {
  const deps = c.var.deps;
  const { db, settings } = deps;
  const redis = deps.redis();
  const user = await currentUser(c);
  const pid = pathUuid(c, "project_id");
  const offset = queryInt(c, "offset", 0, { ge: 0 });
  const limit = queryInt(c, "limit", 50, { ge: 1, le: 200 });
  const category = c.req.query("category") || null;
  const order = c.req.query("order") || "desc";
  if (order !== "asc" && order !== "desc") {
    throw new HttpError(422, [{ type: "string_pattern_mismatch", loc: ["query", "order"], msg: "asc or desc", input: order }]);
  }

  const cacheKey = `project:timeline:${user.id}:${pid}:${category || "all"}:${offset}:${limit}:${order}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const mids = await userMachineIds(db, user, settings);
  const [project] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
  if (!project) throw new HttpError(404, "Not Found");

  const toolRows = await db.select().from(tools);
  const toolMap = new Map(toolRows.map((t) => [t.id, { display_name: t.displayName, icon: t.icon }]));

  const conds: SQL[] = [eq(documents.projectId, pid)];
  if (category) conds.push(eq(documents.category, category));
  const mf = machineFilter(mids, documents.machineId);
  if (mf) conds.push(mf);

  const allRows = await db
    .select({
      id: documents.id,
      toolId: documents.toolId,
      category: documents.category,
      contentType: documents.contentType,
      relativePath: documents.relativePath,
      title: documents.title,
      fileSizeBytes: documents.fileSizeBytes,
      aiSummary: documents.aiSummary,
      metadata: documents.metadata,
      sourceModifiedAt: documents.sourceModifiedAt,
      syncedAt: documents.syncedAt,
    })
    .from(documents)
    .where(and(...conds))
    .orderBy(desc(sql`coalesce(${documents.sourceModifiedAt}, ${documents.syncedAt})`));

  const sessionsMap = new Map<string, Record<string, unknown>>();
  const standalone: Record<string, unknown>[] = [];

  for (const r of allRows) {
    if (isExportNoise(r.relativePath)) continue;
    const md = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>;
    const sessionId = (md.session_id || md.cascade_id || "") as string;
    const ts = pgToIso(r.sourceModifiedAt ?? r.syncedAt) ?? "";
    const toolInfo = toolMap.get(r.toolId);

    if (!sessionId) {
      const ev: Record<string, unknown> = {
        id: r.id,
        type: r.category,
        tool_id: r.toolId,
        tool_name: toolInfo?.display_name ?? r.toolId,
        title: r.title || r.relativePath.split("/").pop(),
        relative_path: r.relativePath,
        content_type: r.contentType,
        timestamp: ts,
        file_size_bytes: r.fileSizeBytes,
        ai_summary: r.aiSummary,
      };
      if (r.category === "conversation") {
        ev.preview_messages = [];
        ev.message_count = 0;
      }
      standalone.push(ev);
      continue;
    }

    let sess = sessionsMap.get(sessionId);
    if (!sess) {
      sess = {
        session_id: sessionId,
        type: "session",
        tool_id: r.toolId,
        tool_name: toolInfo?.display_name ?? r.toolId,
        timestamp: ts,
        conversation: null,
        artifacts: [] as Record<string, unknown>[],
      };
      sessionsMap.set(sessionId, sess);
    }
    if (ts > String(sess.timestamp)) sess.timestamp = ts;

    if (r.category === "conversation") {
      let cTitle = r.title || "";
      if (isJunkOrUuidTitle(cTitle, sessionId)) cTitle = String(md.title || md.ai_title || "");
      if (isJunkOrUuidTitle(cTitle, sessionId)) cTitle = sessionId ? sessionId.slice(0, 8) : "会话";
      sess.conversation = {
        id: r.id,
        title: cTitle,
        message_count: 0,
        preview_messages: [],
        file_size_bytes: r.fileSizeBytes,
      };
    } else if (r.category === "plan") {
      const docType = (r.relativePath.split("/").pop() || "").split(".")[0] || "plan";
      (sess.artifacts as Record<string, unknown>[]).push({
        id: r.id,
        title: r.title || docType,
        doc_type: docType,
        content_preview: null,
        file_size_bytes: r.fileSizeBytes,
      });
    } else {
      (sess.artifacts as Record<string, unknown>[]).push({
        id: r.id,
        title: r.title || r.relativePath.split("/").pop(),
        doc_type: r.category,
        content_preview: null,
        file_size_bytes: r.fileSizeBytes,
      });
    }
  }

  const allEvents = [...sessionsMap.values(), ...standalone];
  allEvents.sort((a, b) => {
    const ta = String(a.timestamp ?? "");
    const tb = String(b.timestamp ?? "");
    return order === "desc" ? (tb > ta ? 1 : tb < ta ? -1 : 0) : ta > tb ? 1 : ta < tb ? -1 : 0;
  });
  const total = allEvents.length;
  const page = allEvents.slice(offset, offset + limit);

  for (const ev of page) {
    if (ev.type === "session") {
      const conv = ev.conversation as { title?: string } | null;
      const arts = (ev.artifacts as { title?: string }[]) ?? [];
      if (conv) {
        let t = conv.title;
        if (!t || t === "transcript" || t === "transcript.jsonl") t = String(ev.session_id).slice(0, 8);
        ev.title = t;
      } else if (arts.length) {
        ev.title = arts[0]!.title;
      } else {
        ev.title = String(ev.session_id).slice(0, 8);
      }
    }
  }

  const pageConvIds = new Set<string>();
  const pagePlanIds = new Set<string>();
  for (const ev of page) {
    if (ev.type === "session") {
      const conv = ev.conversation as { id: string } | null;
      if (conv) pageConvIds.add(conv.id);
      for (const a of (ev.artifacts as { id: string }[]) ?? []) pagePlanIds.add(a.id);
    } else if (ev.type === "conversation") {
      pageConvIds.add(String(ev.id));
    } else {
      pagePlanIds.add(String(ev.id));
    }
  }

  const msgCounts = new Map<string, number>();
  const previews = new Map<string, Record<string, unknown>[]>();
  if (pageConvIds.size) {
    const convIdArr = [...pageConvIds];
    const cntRows = await db
      .select({ did: conversationMessages.documentId, n: count() })
      .from(conversationMessages)
      .where(and(inArray(conversationMessages.documentId, convIdArr), inArray(conversationMessages.role, ["user", "assistant"])))
      .groupBy(conversationMessages.documentId);
    for (const r of cntRows) msgCounts.set(r.did, Number(r.n ?? 0));

    const prevRows = (await db.execute(sql`
      SELECT document_id, role, content, timestamp, line_number FROM (
        SELECT document_id, role, content, timestamp, line_number,
               row_number() OVER (PARTITION BY document_id ORDER BY line_number) AS rn
        FROM conversation_messages
        WHERE document_id IN (${sql.join(convIdArr.map((id) => sql`${id}::uuid`), sql`, `)})
          AND role IN ('user', 'assistant')
      ) sub WHERE rn <= 4 ORDER BY document_id, line_number
    `)) as unknown as { document_id: string; role: string; content: string | null; timestamp: string | null }[];
    for (const r of prevRows) {
      const lst = previews.get(r.document_id) ?? [];
      if (lst.length < 4) {
        lst.push({
          role: r.role,
          content: (r.content || "").slice(0, 300),
          tool_name: "",
          timestamp: pgToIso(r.timestamp),
        });
        previews.set(r.document_id, lst);
      }
    }
  }

  const planPreviews = new Map<string, string>();
  if (pagePlanIds.size) {
    const pRows = await db
      .select({ id: documents.id, category: documents.category, content: documents.content })
      .from(documents)
      .where(inArray(documents.id, [...pagePlanIds]));
    for (const r of pRows) {
      if (r.content) planPreviews.set(r.id, r.content.slice(0, r.category === "plan" ? 500 : 300));
    }
  }

  for (const ev of page) {
    if (ev.type === "session") {
      const conv = ev.conversation as Record<string, unknown> | null;
      if (conv) {
        conv.message_count = msgCounts.get(String(conv.id)) ?? 0;
        conv.preview_messages = previews.get(String(conv.id)) ?? [];
      }
      for (const a of (ev.artifacts as Record<string, unknown>[]) ?? []) {
        a.content_preview = planPreviews.get(String(a.id)) ?? null;
      }
    } else if (ev.type === "conversation") {
      ev.message_count = msgCounts.get(String(ev.id)) ?? 0;
      ev.preview_messages = previews.get(String(ev.id)) ?? [];
    } else {
      ev.content_preview = planPreviews.get(String(ev.id)) ?? null;
    }
  }

  const payload = {
    project: {
      id: project.id,
      slug: project.slug,
      title: project.title,
      tool_id: project.toolId,
      source_path: cleanSourcePath(project.sourcePath),
    },
    total,
    offset,
    limit,
    events: page,
  };
  await cacheSet(redis, cacheKey, payload, 30);
  return c.json(payload);
});

// ---- Exported helper for both route & share.ts ----
const UUID_FIND_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

export async function getProjectConversationsData(
  deps: Deps,
  user: UserRow,
  projectId: string,
  opts: {
    sessionOffset?: number;
    sessionLimit?: number;
    maxMessagesPerSession?: number;
    order?: "asc" | "desc";
    deviceId?: string | null;
    artifacts?: boolean;
    conversationId?: string | null;
    asOfIso?: string | null;
  } = {},
) {
  const { db, settings } = deps;
  const redis = deps.redis();
  let sessionOffset = opts.sessionOffset ?? 0;
  const sessionLimit = opts.sessionLimit ?? 10;
  const maxMessagesPerSession = opts.maxMessagesPerSession ?? 0;
  const order = opts.order ?? "asc";
  const deviceId = opts.deviceId ?? null;
  const artifactsFlag = opts.artifacts ?? true;
  const conversationId = opts.conversationId ?? null;
  const asOfIso = opts.asOfIso ?? null;

  const mids = await userMachineIds(db, user, settings);
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new HttpError(404, "Not Found");

  let targetMid: string | null = null;
  let targetMachine: MachineRow | null = null;
  if (deviceId && !["auto", "ask_only", "all"].includes(deviceId)) {
    targetMachine = await findMachineByIdOrHash(db, settings, deviceId, user);
    if (targetMachine) {
      targetMid = targetMachine.id;
    } else {
      return {
        project: { id: project.id, slug: project.slug, title: project.title, source_path: "" },
        total_sessions: 0,
        session_offset: sessionOffset,
        session_limit: sessionLimit,
        order,
        sessions: [],
      };
    }
  }

  const asOfKey = asOfIso || "live";
  const devKey = deviceId || "all";
  const cacheKey = `project:conv:v3:${user.id}:${projectId}:${devKey}:${sessionOffset}:${sessionLimit}:${maxMessagesPerSession}:${order}:${asOfKey}:${artifactsFlag ? 1 : 0}:${conversationId || ""}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return cached;

  await reconcileProjectDocuments(db, project, targetMid);

  const convConds: SQL[] = [
    eq(documents.projectId, projectId),
    eq(documents.category, "conversation"),
    inArray(documents.contentType, ["jsonl", "json"]),
  ];
  if (targetMid !== null) {
    const nm = (targetMachine?.name || "").toLowerCase();
    if (["windows", "desktop-", "laptop-", "win-", "admin"].some((k) => nm.includes(k))) {
      convConds.push(
        or(
          eq(documents.machineId, targetMid),
          and(
            isNull(documents.machineId),
            or(
              sql`${documents.metadata}->>'project_path' ILIKE '%d:/%'`,
              sql`${documents.metadata}->>'project_path' ILIKE '%c:/%'`,
              ilike(documents.relativePath, "%users-admin%"),
            ),
          ),
        )!,
      );
    } else if (nm.includes("mac-mini")) {
      convConds.push(
        or(
          eq(documents.machineId, targetMid),
          and(
            isNull(documents.machineId),
            or(ilike(documents.relativePath, "%haixingdong%"), sql`${documents.metadata}->>'project_path' ILIKE '%haixingdong%'`),
          ),
        )!,
      );
    } else if (nm.includes("macbook")) {
      convConds.push(
        or(
          eq(documents.machineId, targetMid),
          and(
            isNull(documents.machineId),
            or(ilike(documents.relativePath, "%donghaixing%"), sql`${documents.metadata}->>'project_path' ILIKE '%donghaixing%'`),
          ),
        )!,
      );
    } else {
      convConds.push(eq(documents.machineId, targetMid));
    }
  } else {
    const mf = machineFilter(mids, documents.machineId);
    if (mf) convConds.push(mf);
  }
  if (asOfIso) convConds.push(lte(documents.syncedAt, asOfIso));

  type ConvDocMeta = {
    id: string;
    relativePath: string;
    machineId: string | null;
    toolId: string;
    title: string | null;
    metadata: unknown;
    sourceModifiedAt: string | null;
    syncedAt: string;
    fileSizeBytes: number;
    category: string;
    contentType: string;
  };

  const allConvs: ConvDocMeta[] = await db
    .select({
      id: documents.id,
      relativePath: documents.relativePath,
      machineId: documents.machineId,
      toolId: documents.toolId,
      title: documents.title,
      metadata: documents.metadata,
      sourceModifiedAt: documents.sourceModifiedAt,
      syncedAt: documents.syncedAt,
      fileSizeBytes: documents.fileSizeBytes,
      category: documents.category,
      contentType: documents.contentType,
    })
    .from(documents)
    .where(and(...convConds));

  const mainConvs: ConvDocMeta[] = [];
  const subagentMap = new Map<string, ConvDocMeta[]>();
  const parentPathToId = new Map<string, string>();
  const sidToRp = new Map<string, string>();
  const subagentParentSid = new Map<string, string>();

  for (const d of allConvs) {
    const rp = d.relativePath || "";
    const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
    const docSid = typeof md.session_id === "string" ? md.session_id : null;
    const stem = (rp.split("/").pop() || "").replace(/\.jsonl$/, "");
    const uMatch = UUID_FIND_RE.exec(stem) ?? UUID_FIND_RE.exec(rp);
    const docUuid = uMatch ? uMatch[1]! : null;
    const isSub = rp.includes("/subagents/") || Boolean(md.is_subagent);
    if (!isSub) {
      if (docSid) sidToRp.set(docSid, rp);
      if (docUuid) sidToRp.set(docUuid, rp);
    } else if (typeof md.parent_session_id === "string" && md.parent_session_id) {
      if (docSid) subagentParentSid.set(docSid, md.parent_session_id);
      if (docUuid) subagentParentSid.set(docUuid, md.parent_session_id);
    }
  }

  const resolveRootParentRp = (startSid: string): string | null => {
    let cur = startSid;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (sidToRp.has(cur)) return sidToRp.get(cur)!;
      cur = subagentParentSid.get(cur) ?? "";
    }
    return null;
  };

  for (const d of allConvs) {
    const rp = d.relativePath || "";
    if (isExportNoise(rp)) continue;
    const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
    const parentSid = typeof md.parent_session_id === "string" ? md.parent_session_id : null;
    const resolvedParentRp = parentSid ? resolveRootParentRp(parentSid) : null;
    if (rp.includes("/subagents/")) {
      const parentBase = `${rp.split("/subagents/")[0]}.jsonl`;
      const arr = subagentMap.get(parentBase) ?? [];
      arr.push(d);
      subagentMap.set(parentBase, arr);
    } else if (resolvedParentRp) {
      const arr = subagentMap.get(resolvedParentRp) ?? [];
      arr.push(d);
      subagentMap.set(resolvedParentRp, arr);
    } else {
      mainConvs.push(d);
      parentPathToId.set(rp, d.id);
    }
  }

  for (const [parentBase, children] of subagentMap) {
    if (!parentPathToId.has(parentBase) && children.length) {
      const first = children[0]!;
      const sid = (parentBase.split("/").pop() || "").replace(/\.jsonl$/, "");
      const proxyDoc: ConvDocMeta = {
        id: randomUUID(),
        relativePath: parentBase,
        machineId: first.machineId,
        toolId: project.toolId || "unknown",
        title: `${project.title} 会话`,
        metadata: { session_id: sid, is_subagent: false, project_hash: project.title, synthetic: true },
        sourceModifiedAt: first.sourceModifiedAt,
        syncedAt: first.syncedAt,
        fileSizeBytes: 0,
        category: "conversation",
        contentType: "jsonl",
      };
      mainConvs.push(proxyDoc);
      parentPathToId.set(parentBase, proxyDoc.id);
    }
  }

  const convTs = new Map<string, number>();
  const toMs = (s: string | null | undefined) => {
    if (!s) return 0;
    const iso = pgToIso(s) ?? s;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  };
  if (mainConvs.length) {
    const allQueryIds: string[] = [];
    for (const d of mainConvs) {
      allQueryIds.push(d.id);
      for (const ch of subagentMap.get(d.relativePath) ?? []) allQueryIds.push(ch.id);
    }
    const tsRows = await db
      .select({
        did: conversationMessages.documentId,
        ts: order === "desc" ? max(conversationMessages.timestamp) : min(conversationMessages.timestamp),
      })
      .from(conversationMessages)
      .where(inArray(conversationMessages.documentId, allQueryIds))
      .groupBy(conversationMessages.documentId);
    const aggTsMap = new Map(tsRows.map((r) => [r.did, toMs(r.ts)]));

    for (const d of mainConvs) {
      const cands: number[] = [];
      const selfTs = aggTsMap.get(d.id);
      if (selfTs) cands.push(selfTs);
      for (const ch of subagentMap.get(d.relativePath) ?? []) {
        const ct = aggTsMap.get(ch.id) || toMs(ch.sourceModifiedAt ?? ch.syncedAt);
        if (ct) cands.push(ct);
      }
      if (cands.length) {
        convTs.set(d.id, order === "desc" ? Math.max(...cands) : Math.min(...cands));
      } else {
        convTs.set(d.id, toMs(d.sourceModifiedAt ?? d.syncedAt));
      }
    }
  }

  mainConvs.sort((a, b) => {
    const ta = convTs.get(a.id) ?? toMs(a.syncedAt);
    const tb = convTs.get(b.id) ?? toMs(b.syncedAt);
    return order === "asc" ? ta - tb : tb - ta;
  });

  const filteredMain = conversationId ? mainConvs.filter((d) => d.id === conversationId) : mainConvs;
  if (conversationId) sessionOffset = 0;
  const totalSessions = filteredMain.length;
  const pageConvs = filteredMain.slice(sessionOffset, sessionOffset + sessionLimit);
  const devRefs = await deviceIndex(db, settings, user);

  const docsNeedingTitle = pageConvs.filter((d) => {
    const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
    return isJunkOrUuidTitle(d.title, typeof md.session_id === "string" ? md.session_id : null) || !d.title?.trim();
  });
  const docContents = new Map<string, string>();
  if (docsNeedingTitle.length) {
    const cRows = await db
      .select({ id: documents.id, snippet: sql<string>`substr(${documents.content}, 1, 65536)` })
      .from(documents)
      .where(inArray(documents.id, docsNeedingTitle.map((d) => d.id)));
    for (const r of cRows) docContents.set(r.id, r.snippet || "");
  }

  const plansBySession = new Map<string, { id: string; title: string | null; relativePath: string; fileSizeBytes: number; content: string | null }[]>();
  if (artifactsFlag) {
    const pConds: SQL[] = [eq(documents.projectId, projectId), eq(documents.category, "plan")];
    if (targetMid !== null) pConds.push(eq(documents.machineId, targetMid));
    else {
      const mf = machineFilter(mids, documents.machineId);
      if (mf) pConds.push(mf);
    }
    const pRows = await db
      .select({
        id: documents.id,
        title: documents.title,
        relativePath: documents.relativePath,
        metadata: documents.metadata,
        fileSizeBytes: documents.fileSizeBytes,
        content: sql<string | null>`substr(${documents.content}, 1, 5000)`,
      })
      .from(documents)
      .where(and(...pConds));
    for (const p of pRows) {
      if (isExportNoise(p.relativePath)) continue;
      const md = (p.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>;
      const sid = typeof md.session_id === "string" ? md.session_id : "";
      if (sid) {
        const arr = plansBySession.get(sid) ?? [];
        arr.push(p);
        plansBySession.set(sid, arr);
      }
    }
  }

  const neededIds: string[] = [];
  for (const d of pageConvs) {
    neededIds.push(d.id);
    for (const ch of subagentMap.get(d.relativePath) ?? []) neededIds.push(ch.id);
  }
  const msgsByDoc = new Map<string, Record<string, unknown>[]>();
  const shownByDoc = new Map<string, number>();

  if (neededIds.length) {
    const msgConds: SQL[] = [
      inArray(conversationMessages.documentId, neededIds),
      inArray(conversationMessages.role, ["user", "assistant"]),
      notLike(conversationMessages.content, "[Result]%"),
      notLike(conversationMessages.content, "[Tool:%"),
    ];
    if (asOfIso) msgConds.push(or(isNull(conversationMessages.timestamp), lte(conversationMessages.timestamp, asOfIso))!);

    const rows = await db
      .select({
        documentId: conversationMessages.documentId,
        role: conversationMessages.role,
        content: conversationMessages.content,
        messageType: conversationMessages.messageType,
        timestamp: conversationMessages.timestamp,
        lineNumber: conversationMessages.lineNumber,
        metadata: conversationMessages.metadata,
      })
      .from(conversationMessages)
      .where(and(...msgConds));

    rows.sort((a, b) => {
      const cmp = a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : (a.lineNumber ?? 0) - (b.lineNumber ?? 0);
      return order === "desc" ? -cmp : cmp;
    });

    for (const r of rows) {
      const content = r.content || "";
      if (r.role === "user" && (content.startsWith("[Result]") || content.startsWith("[Tool:") || content.startsWith('{"tool_use_id"'))) {
        continue;
      }
      if (r.role === "assistant" && (content.startsWith("[Tool:") || content.startsWith("[Result]"))) continue;
      shownByDoc.set(r.documentId, (shownByDoc.get(r.documentId) ?? 0) + 1);
      const list = msgsByDoc.get(r.documentId) ?? [];
      if (maxMessagesPerSession > 0 && list.length >= Math.max(maxMessagesPerSession * 5, 50)) continue;
      const meta = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>;
      list.push({
        role: r.role,
        content,
        thinking: meta.thinking ?? null,
        tool_name: typeof meta.tool_name === "string" ? meta.tool_name : "",
        tool_input: typeof meta.tool_input === "string" ? meta.tool_input : "",
        raw_type: r.messageType || "",
        timestamp: pgToIso(r.timestamp),
      });
      msgsByDoc.set(r.documentId, list);
    }
    if (order === "desc") {
      for (const list of msgsByDoc.values()) list.reverse();
    }
  }

  // Backfill Claude Code context_tokens from tail if missing
  const backfillIds = pageConvs
    .filter((d) => {
      const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
      return d.toolId === "claude_code" && !("context_tokens" in md);
    })
    .slice(0, 10)
    .map((d) => d.id);
  if (backfillIds.length) {
    const tails = await db
      .select({ id: documents.id, tail: sql<string | null>`right(${documents.content}, 2000000)` })
      .from(documents)
      .where(inArray(documents.id, backfillIds));
    const foundById = new Map(tails.map((r) => [r.id, sessionActivity(r.tail || "")]));
    for (const d of pageConvs) {
      const f = foundById.get(d.id);
      if (f && Object.keys(f).length) {
        const merged = { ...((d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>), ...f };
        d.metadata = merged;
        await db.update(documents).set({ metadata: merged }).where(eq(documents.id, d.id)).catch(() => {});
      }
    }
  }

  const sessions: Record<string, unknown>[] = [];
  for (const d of pageConvs) {
    const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
    let sessionId =
      (typeof md.session_id === "string" && md.session_id) ||
      (typeof md.cascade_id === "string" && md.cascade_id) ||
      (d.relativePath ? d.relativePath.split("/").pop()!.split(".")[0]! : d.id);
    if ((!sessionId || sessionId === "transcript") && d.relativePath.includes("brain/")) {
      const bm = /brain\/([0-9a-fA-F-]+)\//.exec(d.relativePath);
      if (bm) sessionId = bm[1]!;
    }
    const ts = pgToIso(d.sourceModifiedAt ?? d.syncedAt) ?? "";

    let messages = [...(msgsByDoc.get(d.id) ?? [])];
    const childDocs = subagentMap.get(d.relativePath) ?? [];
    for (const ch of childDocs) {
      const chMd = (ch.metadata && typeof ch.metadata === "object" ? ch.metadata : {}) as Record<string, unknown>;
      const childName =
        (typeof chMd.subagent_name === "string" && chMd.subagent_name) ||
        ch.title ||
        (ch.relativePath.split("/").pop() || "").replace(/\.jsonl$/, "");
      for (const m of msgsByDoc.get(ch.id) ?? []) {
        messages.push({ ...m, subagent_name: childName });
      }
    }

    if (messages.length && messages[0]!.timestamp) {
      messages.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
    }
    const totalMsgs = (shownByDoc.get(d.id) ?? 0) + childDocs.reduce((acc, ch) => acc + (shownByDoc.get(ch.id) ?? 0), 0);
    if (maxMessagesPerSession && messages.length > maxMessagesPerSession) {
      messages = order === "asc" ? messages.slice(0, maxMessagesPerSession) : messages.slice(-maxMessagesPerSession);
    }

    const artifacts = (plansBySession.get(sessionId) ?? []).map((p) => {
      const docType = (p.relativePath.split("/").pop() || "").split(".")[0] || "plan";
      return {
        id: p.id,
        title: p.title || docType,
        doc_type: docType,
        content: p.content ? p.content.slice(0, 5000) : null,
        file_size_bytes: p.fileSizeBytes,
      };
    });

    let convTitle = (d.title || "").trim();
    let isJunk = isJunkOrUuidTitle(convTitle, sessionId);

    // 1. Claude Code latest aiTitle
    if (d.toolId === "claude_code" && docContents.has(d.id)) {
      const matches = [...docContents.get(d.id)!.matchAll(/"aiTitle"\s*:\s*"([^"]+)"/g)];
      const latestAi = matches.length ? matches[matches.length - 1]![1]!.trim() : "";
      if (latestAi && !isJunkOrUuidTitle(latestAi, sessionId)) {
        if (convTitle !== latestAi) {
          convTitle = latestAi;
          await db.update(documents).set({ title: latestAi }).where(eq(documents.id, d.id)).catch(() => {});
          for (const ch of childDocs) {
            await db.update(documents).set({ title: latestAi }).where(eq(documents.id, ch.id)).catch(() => {});
          }
        }
        isJunk = false;
      }
    }

    // 1.1 Antigravity official title
    if (d.toolId === "antigravity") {
      if (typeof md.title === "string" && md.title && !isJunkOrUuidTitle(md.title, sessionId)) {
        const cand = md.title.trim();
        if (convTitle !== cand) {
          convTitle = cand;
          await db.update(documents).set({ title: cand }).where(eq(documents.id, d.id)).catch(() => {});
        }
        isJunk = false;
      }
      if (isJunk || convTitle.includes("<USER_REQUEST>") || convTitle.startsWith("💬") || convTitle.includes("\n") || convTitle.length > 35) {
        const [annDoc] = await db
          .select({ title: documents.title, content: documents.content })
          .from(documents)
          .where(
            and(
              eq(documents.toolId, "antigravity"),
              eq(documents.category, "state"),
              sql`${documents.relativePath} LIKE ${`%annotations/${sessionId}.pbtxt`}`,
            ),
          )
          .limit(1);
        if (annDoc) {
          let candAnn = annDoc.title || "";
          if (!candAnn && annDoc.content) {
            const m = /title:\s*"([^"]+)"/.exec(annDoc.content);
            if (m) candAnn = m[1]!.trim();
          }
          if (candAnn && !candAnn.includes("(.*?)") && !candAnn.endsWith(".pbtxt")) {
            if (candAnn.includes("\\")) candAnn = safeDecodePbtxtString(candAnn);
            if (!isJunkOrUuidTitle(candAnn, sessionId)) {
              if (convTitle !== candAnn) {
                convTitle = candAnn;
                await db.update(documents).set({ title: candAnn }).where(eq(documents.id, d.id)).catch(() => {});
              }
              isJunk = false;
            }
          }
        }
      }
    }

    // 2. Metadata name / title / ai_title / first_user_message
    if (isJunk) {
      const mTitle = md.name || md.title || md.ai_title || md.first_user_message;
      if (mTitle && !isJunkOrUuidTitle(String(mTitle), sessionId)) {
        convTitle = String(mTitle).trim();
        isJunk = false;
        await db.update(documents).set({ title: convTitle }).where(eq(documents.id, d.id)).catch(() => {});
      }
    }

    // 3. Fallback aiTitle in content
    if (isJunk && docContents.has(d.id)) {
      const matches = [...docContents.get(d.id)!.matchAll(/"aiTitle"\s*:\s*"([^"]+)"/g)];
      const cand = matches.length ? matches[matches.length - 1]![1]!.trim() : "";
      if (cand && !isJunkOrUuidTitle(cand, sessionId)) {
        convTitle = cand;
        isJunk = false;
        await db.update(documents).set({ title: cand }).where(eq(documents.id, d.id)).catch(() => {});
      }
    }

    // 4. Parent title if subagent
    if (isJunk && typeof md.parent_session_id === "string" && md.parent_session_id) {
      const parentSid = md.parent_session_id;
      const [pDoc] = await db
        .select({ title: documents.title })
        .from(documents)
        .where(
          and(
            eq(documents.toolId, d.toolId),
            or(sql`${documents.metadata}->>'session_id' = ${parentSid}`, sql`${documents.relativePath} LIKE ${`%${parentSid}%`}`),
          ),
        )
        .limit(1);
      if (pDoc?.title && !isJunkOrUuidTitle(pDoc.title, parentSid)) {
        convTitle = d.toolId === "codex" ? `审核: ${pDoc.title}` : pDoc.title;
        isJunk = false;
        await db.update(documents).set({ title: convTitle }).where(eq(documents.id, d.id)).catch(() => {});
      }
    }

    // 5. Fallback to user messages
    if (isJunk) {
      const uMsgs = messages.filter((m) => m.role === "user").map((m) => String(m.content || ""));
      const cTitle = titleFromUserMessages(uMsgs, sessionId);
      if (cTitle) {
        convTitle = cTitle;
        isJunk = false;
        await db.update(documents).set({ title: cTitle }).where(eq(documents.id, d.id)).catch(() => {});
      }
    }

    if (isJunk) convTitle = sessionId ? sessionId.slice(0, 8) : "会话";
    convTitle = convTitle.trim();

    const fsBytes = d.fileSizeBytes || 0;
    const resume = d.toolId === "claude_code" ? resumeCost(md, settings) : {};
    const hasResume = Object.keys(resume).length > 0;
    const estTokens = (hasResume ? Number(resume.context_tokens) : 0) || Math.max(totalMsgs * 250, Math.floor(fsBytes / 4));
    const compactRec = hasResume ? Boolean(resume.heavy) : totalMsgs > 35 || fsBytes > 300_000;
    const devRef = d.machineId ? devRefs.get(d.machineId) : undefined;

    sessions.push({
      session_id: sessionId,
      title: convTitle,
      conversation_id: d.id,
      timestamp: ts,
      message_count: totalMsgs,
      file_size_bytes: fsBytes,
      estimated_tokens: estTokens,
      compact_recommended: compactRec,
      resume: hasResume ? resume : null,
      messages,
      truncated: Boolean(maxMessagesPerSession && totalMsgs > maxMessagesPerSession),
      artifacts,
      device_id: devRef?.deviceId ?? null,
      device_name: devRef?.name ?? null,
    });
  }

  let sourcePath = "";
  if (targetMachine) {
    const pls: Placement[] = allConvs.map((d) => {
      const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
      return {
        machineId: d.machineId,
        path: typeof md.project_path === "string" ? md.project_path : null,
        documents: 1,
        lastActive: toMs(d.syncedAt),
        lastActiveRaw: pgToIso(d.syncedAt),
      };
    });
    sourcePath = pickProjectPath(pls, project.slug, project.title) || "";
    if (!sourcePath) {
      const found = discoveredFor(project.slug, await discoveredProjects(db, targetMachine, mids, project.toolId));
      sourcePath = found.map((x) => cleanSourcePath(x.path)).find((cp) => Boolean(cp && !isJunkProject(null, cp))) || "";
    }
  } else {
    sourcePath = cleanSourcePath(project.sourcePath) || "";
  }

  const codebaseBlueprint = await resolveCodebaseBlueprint(deps, project, mids);
  const payload = {
    project: { id: project.id, slug: project.slug, title: project.title, source_path: sourcePath },
    codebase_blueprint: codebaseBlueprint,
    total_sessions: totalSessions,
    session_offset: sessionOffset,
    session_limit: sessionLimit,
    order,
    sessions,
  };
  await cacheSet(redis, cacheKey, payload, 300);
  return payload;
}

projectRoutes.get("/:project_id/conversations", async (c) => {
  const user = await currentUser(c);
  const pid = pathUuid(c, "project_id");
  const offsetParam = c.req.query("offset");
  const limitParam = c.req.query("limit");
  const sessionOffset = offsetParam !== undefined ? queryInt(c, "offset", 0, { ge: 0 }) : queryInt(c, "session_offset", 0, { ge: 0 });
  const sessionLimit = limitParam !== undefined ? queryInt(c, "limit", 10, { ge: 1, le: 100 }) : queryInt(c, "session_limit", 10, { ge: 1, le: 100 });
  const maxMessagesPerSession = queryInt(c, "max_messages_per_session", 0, { ge: 0, le: 10000 });
  const order = c.req.query("order") || "asc";
  if (order !== "asc" && order !== "desc") {
    throw new HttpError(422, [{ type: "string_pattern_mismatch", loc: ["query", "order"], msg: "asc or desc", input: order }]);
  }
  const deviceId = c.req.query("device_id") || null;
  const artifactsRaw = (c.req.query("artifacts") ?? "true").toLowerCase();
  const artifacts = artifactsRaw !== "false" && artifactsRaw !== "0";
  const convIdRaw = c.req.query("conversation_id");
  const conversationId = convIdRaw ? normalizeUuid(convIdRaw) : null;
  if (convIdRaw && !conversationId) {
    throw new HttpError(422, [{ type: "uuid_parsing", loc: ["query", "conversation_id"], msg: "invalid uuid", input: convIdRaw }]);
  }
  return c.json(
    await getProjectConversationsData(c.var.deps, user, pid, {
      sessionOffset,
      sessionLimit,
      maxMessagesPerSession,
      order,
      deviceId,
      artifacts,
      conversationId,
    }),
  );
});

// ---- GET /api/projects/:project_id/export.md ----
const CATEGORY_ORDER = ["memory", "plan", "identity", "config", "skill", "learning", "note", "conversation"];
const CATEGORY_HEADERS_ZH: Record<string, string> = {
  memory: "记忆",
  plan: "计划",
  identity: "身份卡",
  config: "配置",
  skill: "技能",
  learning: "学习笔记",
  note: "笔记",
  conversation: "对话",
};

projectRoutes.get("/:project_id/export.md", async (c) => {
  const deps = c.var.deps;
  const { db, settings } = deps;
  const user = await currentUser(c);
  const pid = pathUuid(c, "project_id");
  const incRaw = (c.req.query("include_conversations") ?? "true").toLowerCase();
  const includeConversations = incRaw !== "false" && incRaw !== "0";

  const mids = await userMachineIds(db, user, settings);
  const [project] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
  if (!project) throw new HttpError(404, "Not Found");

  const docConds: SQL[] = [eq(documents.projectId, pid)];
  if (!includeConversations) docConds.push(sql`${documents.category} <> 'conversation'`);
  const mf = machineFilter(mids, documents.machineId);
  if (mf) docConds.push(mf);

  const docs = (
    await db
      .select({
        id: documents.id,
        category: documents.category,
        title: documents.title,
        relativePath: documents.relativePath,
        syncedAt: documents.syncedAt,
        content: documents.content,
        aiSummary: documents.aiSummary,
      })
      .from(documents)
      .where(and(...docConds))
      .orderBy(desc(documents.syncedAt))
  ).filter((d) => !isExportNoise(d.relativePath));

  const entConds: SQL[] = [or(ilike(knowledgeEntities.name, `%${project.title}%`), ilike(knowledgeEntities.name, `%${project.slug}%`))!];
  if (mids !== null) entConds.push(eq(knowledgeEntities.userId, user.id));
  const entities = await db.select().from(knowledgeEntities).where(and(...entConds)).limit(20);

  const lines: string[] = [];
  const title = project.title || project.slug || "Untitled project";
  const exportedStamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  lines.push(`# Memento context — ${title}`, "");
  lines.push(`**Tool**: \`${project.toolId || "unknown"}\`  ·  **Documents**: ${docs.length}  ·  **Exported**: ${exportedStamp}`);
  if (project.sourcePath) lines.push(`**Source path**: \`${project.sourcePath}\``);
  lines.push(
    "",
    "> This file was exported from Memento as a one-shot bootstrap of\n" +
      "> a project's prior context. Drop it into a fresh project as\n" +
      "> `MEMENTO-CONTEXT.md` and add to your `CLAUDE.md` / `AGENTS.md`:\n" +
      "> `Read MEMENTO-CONTEXT.md for prior conversations and decisions on this project.`",
    "",
    "---",
    "",
  );

  const exportBp = await resolveCodebaseBlueprint(deps, project, mids);
  if (exportBp) {
    lines.push("## Living Codebase Architecture Blueprint / 活体代码蓝图", "", exportBp, "", "---", "");
  }

  const byCat = new Map<string, typeof docs>();
  for (const d of docs) {
    if (exportBp && isCodeBlueprintPath(d.relativePath)) continue;
    const cat = d.category || "other";
    const arr = byCat.get(cat) ?? [];
    arr.push(d);
    byCat.set(cat, arr);
  }
  const orderedCats = [...CATEGORY_ORDER.filter((x) => byCat.has(x)), ...[...byCat.keys()].filter((x) => !CATEGORY_ORDER.includes(x)).sort()];

  for (const cat of orderedCats) {
    if (cat === "conversation" && !includeConversations) continue;
    const bucket = byCat.get(cat) ?? [];
    if (!bucket.length) continue;
    const zh = CATEGORY_HEADERS_ZH[cat] ?? cat;
    lines.push(`## ${cat.charAt(0).toUpperCase() + cat.slice(1)} / ${zh}  (${bucket.length})`, "");
    for (const d of bucket) {
      const docTitle = d.title || d.relativePath.split("/").pop() || d.category;
      const stamp = d.syncedAt ? String(d.syncedAt).slice(0, 10) : "";
      lines.push(`### ${docTitle}`, `*${d.relativePath}*  ·  *${stamp}*`, "");
      if (cat === "conversation" && d.aiSummary) {
        lines.push(d.aiSummary);
      } else if (d.content) {
        const blob =
          d.content.length < 200_000
            ? d.content
            : `${d.content.slice(0, 200_000)}\n\n…(truncated; call memory_open() for full text)`;
        lines.push(blob);
      } else {
        lines.push("*(empty)*");
      }
      lines.push("", "---", "");
    }
  }

  if (entities.length) {
    lines.push("## Knowledge graph", "");
    const entIds = entities.map((e) => e.id);
    const relRows = await db
      .select({ sourceId: knowledgeRelations.sourceId, relationType: knowledgeRelations.relationType, targetName: knowledgeEntities.name })
      .from(knowledgeRelations)
      .innerJoin(knowledgeEntities, eq(knowledgeRelations.targetId, knowledgeEntities.id))
      .where(inArray(knowledgeRelations.sourceId, entIds));
    const relsBySource = new Map<string, [string, string][]>();
    for (const r of relRows) {
      const arr = relsBySource.get(r.sourceId) ?? [];
      arr.push([r.relationType, r.targetName]);
      relsBySource.set(r.sourceId, arr);
    }

    const obsRows = await db
      .select()
      .from(knowledgeObservations)
      .where(inArray(knowledgeObservations.entityId, entIds))
      .orderBy(desc(knowledgeObservations.observedAt));
    const obsByEntity = new Map<string, typeof obsRows>();
    for (const o of obsRows) {
      const arr = obsByEntity.get(o.entityId) ?? [];
      arr.push(o);
      obsByEntity.set(o.entityId, arr);
    }

    for (const e of entities) {
      lines.push(`### ${e.name}  *(${e.entityType})*`);
      if (e.summary) lines.push("", e.summary);
      const entRels = relsBySource.get(e.id) ?? [];
      if (entRels.length) {
        lines.push("", "**Relations**:");
        for (const [rt, tn] of entRels.slice(0, 10)) lines.push(`- ${rt} → **${tn}**`);
      }
      const entObs = obsByEntity.get(e.id) ?? [];
      if (entObs.length) {
        lines.push("", "**Recent observations**:");
        for (const o of entObs.slice(0, 10)) {
          const ds = o.observedAt ? `[${String(o.observedAt).slice(0, 10)}] ` : "";
          lines.push(`- ${ds}${o.content}`);
        }
      }
      lines.push("", "---", "");
    }
  }

  const md = lines.join("\n");
  const safe = (project.slug || "project").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return c.body(md, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="memento-context-${safe}.md"`,
    "x-accel-buffering": "no",
  });
});

// ---- GET /api/projects/:project_id/blueprint ----
projectRoutes.get("/:project_id/blueprint", async (c) => {
  const deps = c.var.deps;
  const { db, settings } = deps;
  const redis = deps.redis();
  const user = await currentUser(c);
  const pid = pathUuid(c, "project_id");
  const recentConvs = queryInt(c, "recent_convs", 10, { ge: 0, le: 50 });

  const cacheKey = `project:blueprint:${user.id}:${pid}:${recentConvs}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const mids = await userMachineIds(db, user, settings);
  const [project] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
  if (!project) throw new HttpError(404, "Not Found");

  const mf = machineFilter(mids, documents.machineId);
  const curatedConds: SQL[] = [
    eq(documents.projectId, pid),
    inArray(documents.category, ["identity", "memory", "plan", "learning"]),
    not(codeBlueprintPath(documents.relativePath)),
    notLike(documents.relativePath, "%/BUSINESS_BLUEPRINT.md"),
  ];
  if (mf) curatedConds.push(mf);
  const curatedDocs = (
    await db
      .select({
        id: documents.id,
        category: documents.category,
        title: documents.title,
        relativePath: documents.relativePath,
        syncedAt: documents.syncedAt,
        content: documents.content,
        aiSummary: documents.aiSummary,
      })
      .from(documents)
      .where(and(...curatedConds))
      .orderBy(desc(documents.syncedAt))
      .limit(100)
  ).filter((d) => !isExportNoise(d.relativePath));

  let convs: { id: string; title: string | null; relativePath: string; toolId: string; syncedAt: string; aiSummary: string | null }[] = [];
  if (recentConvs > 0) {
    const convConds: SQL[] = [eq(documents.projectId, pid), eq(documents.category, "conversation")];
    if (mf) convConds.push(mf);
    convs = (
      await db
        .select({
          id: documents.id,
          title: documents.title,
          relativePath: documents.relativePath,
          toolId: documents.toolId,
          syncedAt: documents.syncedAt,
          aiSummary: documents.aiSummary,
        })
        .from(documents)
        .where(and(...convConds))
        .orderBy(desc(documents.syncedAt))
        .limit(recentConvs)
    ).filter((d) => !isExportNoise(d.relativePath));
  }

  const entConds: SQL[] = [or(ilike(knowledgeEntities.name, `%${project.title}%`), ilike(knowledgeEntities.name, `%${project.slug}%`))!];
  if (mids !== null) entConds.push(eq(knowledgeEntities.userId, user.id));
  const entities = await db.select().from(knowledgeEntities).where(and(...entConds)).limit(20);
  const entIds = entities.map((e) => e.id);

  const observationsByEntity = new Map<string, { content: string; observed_at: string | null }[]>();
  const relationsByEntity = new Map<string, { relation: string; target_name: string; target_type: string }[]>();
  if (entIds.length) {
    const obsRows = await db
      .select()
      .from(knowledgeObservations)
      .where(inArray(knowledgeObservations.entityId, entIds))
      .orderBy(desc(knowledgeObservations.observedAt));
    for (const o of obsRows) {
      const arr = observationsByEntity.get(o.entityId) ?? [];
      arr.push({ content: o.content, observed_at: pgToIso(o.observedAt) });
      observationsByEntity.set(o.entityId, arr);
    }
    const relRows = await db
      .select({
        sourceId: knowledgeRelations.sourceId,
        relationType: knowledgeRelations.relationType,
        targetName: knowledgeEntities.name,
        targetType: knowledgeEntities.entityType,
      })
      .from(knowledgeRelations)
      .innerJoin(knowledgeEntities, eq(knowledgeRelations.targetId, knowledgeEntities.id))
      .where(inArray(knowledgeRelations.sourceId, entIds));
    for (const r of relRows) {
      const arr = relationsByEntity.get(r.sourceId) ?? [];
      arr.push({ relation: r.relationType, target_name: r.targetName, target_type: r.targetType });
      relationsByEntity.set(r.sourceId, arr);
    }
  }

  const codebaseBlueprint = await resolveCodebaseBlueprint(deps, project, mids);
  const bizFields = await businessBlueprintFields(deps, project, mids, user);

  const payload = {
    project: {
      id: project.id,
      title: project.title,
      slug: project.slug,
      tool_id: project.toolId,
      source_path: cleanSourcePath(project.sourcePath),
    },
    codebase_blueprint: codebaseBlueprint,
    ...bizFields,
    curated_docs: curatedDocs.map((d) => ({
      id: d.id,
      category: d.category,
      title: d.title,
      relative_path: d.relativePath,
      synced_at: pgToIso(d.syncedAt),
      content: d.content,
      ai_summary: d.aiSummary,
    })),
    recent_conversations: convs.map((d) => ({
      id: d.id,
      title: d.title || d.relativePath.split("/").pop(),
      tool_id: d.toolId,
      synced_at: pgToIso(d.syncedAt),
      ai_summary: d.aiSummary,
    })),
    knowledge_graph: {
      entities: entities.map((e) => ({
        id: e.id,
        name: e.name,
        entity_type: e.entityType,
        summary: e.summary,
        observations: (observationsByEntity.get(e.id) ?? []).slice(0, 15),
        relations: (relationsByEntity.get(e.id) ?? []).slice(0, 15),
      })),
    },
    counts: {
      curated_docs: curatedDocs.length,
      recent_conversations: convs.length,
      entities: entities.length,
      total_observations: [...observationsByEntity.values()].reduce((s, v) => s + v.length, 0),
      total_relations: [...relationsByEntity.values()].reduce((s, v) => s + v.length, 0),
    },
  };
  await cacheSet(redis, cacheKey, payload, 30);
  return c.json(payload);
});

// ---- POST /api/projects/:project_id/business-blueprint/generate ----
projectRoutes.post("/:project_id/business-blueprint/generate", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const pid = pathUuid(c, "project_id");
  const body = await parseJsonObject(c).catch(() => ({} as Record<string, unknown>));
  const mids = await userMachineIds(deps.db, user, deps.settings);
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, pid)).limit(1);
  if (!project) throw new HttpError(404, "Not Found");
  const binary = String(body.binary || "claude").trim();
  if (!["claude", "codex", "agy", "workbuddy"].includes(binary)) throw new HttpError(400, `unknown agent: ${binary}`);
  try {
    return c.json(await biz.dispatchGeneration(deps, user, project, mids, { binary, model: String(body.model || "").trim() }));
  } catch (e) {
    if (e instanceof biz.GenerateUnavailable) throw new HttpError(409, e.message);
    throw e;
  }
});
