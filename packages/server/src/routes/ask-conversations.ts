// Ask conversation CRUD, ETag 304 pagination, ensure-by-session, compact & cross-agent handoff
// (server/server/api/ask_conversations.py).
import { createHash, randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { AppEnv, Deps } from "../context";
import { withoutNul, type Db } from "../db/client";
import { askConversations, conversationMessages, documents, machines, projects } from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, queryInt } from "../http";
import { pgToIso } from "../pytime";
import { askRuns } from "../services/ask-runs";
import {
  getOrCreateConversation,
  inferConversationConfig,
  recoverOrphanedTasksForConv,
  resolveConcreteDeviceForConv,
  sanitizeTurnsForResponse,
  sliceTurns,
  storedTurnCount,
  tailTurns,
  turnCount,
} from "../services/ask-store";
import { isInvalidProjectName, isJunkOrUuidTitle } from "../services/ingest-service";
import { buildAiContextStats, compactAiConversation, type CompactState, type HistoryTurn } from "../services/orchestrator-context";
import { messagesToTurns, syncQuietly } from "../services/session-timeline";
import { findMachineByIdOrHash } from "../services/user-filter";

export const CHECKPOINT_CONFIG_KEY = "_ai_compact";

const HANDOFF_MODES: Record<string, string> = {
  ai: "AI 编排",
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  workbuddy: "WorkBuddy",
};

function mediaUrlEpoch(): number {
  return Math.floor(Date.now() / 1000 / (7 * 86400));
}

function convEtag(
  convId: string,
  updatedAtIso: string | null,
  totalTurns: number,
  limit: number,
  before: number | null,
  device: string | null,
): string {
  const page = before === null ? `${limit}` : `${limit}:${before}`;
  const seed = `v5:${convId}:${updatedAtIso || ""}:${totalTurns}:${page}:${device || ""}:${mediaUrlEpoch()}`;
  return `"${createHash("sha1").update(seed, "utf8").digest("hex")}"`;
}

export async function bustConvList(deps: Deps, userId: string): Promise<void> {
  await cacheDeletePrefix(deps.redis(), `ask_conv_list:${userId}:`).catch(() => {});
}

function cleanSourcePath(raw: string | null | undefined): string {
  const p = (raw || "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return p;
}

function cleanMachName(name: string | null | undefined): string {
  return (name || "").replace(/\s*\([^)]*\)\s*$/, "").replace(/\.local$/, "").trim();
}

async function getProjectAndMachineMaps(deps: Deps, userId: string) {
  const cacheKey = `ask_conv_maps:${userId}`;
  const cached = (await cacheGet(deps.redis(), cacheKey)) as Record<string, unknown> | null;
  if (cached && typeof cached === "object") {
    return {
      projIdMap: (cached.proj_id_map ?? {}) as Record<string, string>,
      projSlugMap: (cached.proj_slug_map ?? {}) as Record<string, string>,
      projSlugToId: (cached.proj_slug_to_id ?? {}) as Record<string, string>,
      projPathMap: (cached.proj_path_map ?? {}) as Record<string, [string, string]>,
      machMap: (cached.mach_map ?? {}) as Record<string, string>,
      machRowsSummary: (cached.mach_rows_summary ?? []) as { id: string; name: string; clean_name: string }[],
    };
  }

  const [projRows, machRows] = await Promise.all([
    deps.db.select({ id: projects.id, title: projects.title, slug: projects.slug, sourcePath: projects.sourcePath }).from(projects),
    deps.db.select({ id: machines.id, name: machines.name, collectorTokenHash: machines.collectorTokenHash }).from(machines).where(eq(machines.userId, userId)),
  ]);

  const projIdMap: Record<string, string> = {};
  const projSlugMap: Record<string, string> = {};
  const projSlugToId: Record<string, string> = {};
  const projPathMap: Record<string, [string, string]> = {};
  for (const p of projRows) {
    projIdMap[p.id] = p.title;
    const slugLow = (p.slug || "").toLowerCase();
    const leaf = slugLow.split("/").pop() || slugLow;
    if (slugLow) {
      projSlugMap[slugLow] = p.title;
      projSlugToId[slugLow] = p.id;
    }
    if (leaf) {
      projSlugMap[leaf] = p.title;
      projSlugToId[leaf] = p.id;
    }
    const sp = cleanSourcePath(p.sourcePath);
    if (sp) projPathMap[sp.toLowerCase()] = [p.id, p.title];
  }

  const machMap: Record<string, string> = {};
  const machRowsSummary: { id: string; name: string; clean_name: string }[] = [];
  for (const m of machRows) {
    const clean = cleanMachName(m.name);
    machMap[m.id] = clean;
    if (m.collectorTokenHash) machMap[m.collectorTokenHash] = clean;
    if (m.name) machMap[m.name] = clean;
    if (clean) machMap[clean] = clean;
    machRowsSummary.push({ id: m.id, name: m.name, clean_name: clean });
  }

  await cacheSet(
    deps.redis(),
    cacheKey,
    {
      proj_id_map: projIdMap,
      proj_slug_map: projSlugMap,
      proj_slug_to_id: projSlugToId,
      proj_path_map: projPathMap,
      mach_map: machMap,
      mach_rows_summary: machRowsSummary,
    },
    30,
  ).catch(() => {});

  return { projIdMap, projSlugMap, projSlugToId, projPathMap, machMap, machRowsSummary };
}

async function lookupProjectTitle(db: Db, projectId: unknown): Promise<string | null> {
  const pid = normalizeUuid(typeof projectId === "string" ? projectId : null);
  if (!pid) return null;
  const [p] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, pid)).limit(1);
  return p?.title ?? null;
}

function normalizePermissionMode(mode: string | null | undefined): string {
  const m = (mode || "full").trim().toLowerCase();
  return ["full", "default", "plan", "safe", "readonly", "accept_edits"].includes(m) ? m : "full";
}

function resolveFriendlyDeviceName(
  rawDev: string | null | undefined,
  cfg: Record<string, unknown>,
  effectiveCwd: string,
  machMap: Record<string, string>,
  machRowsSummary: { name: string; clean_name: string }[],
): string | null {
  let name: string | null = null;
  if (rawDev && !["auto", "ask_only", "all"].includes(rawDev)) {
    if (rawDev in machMap) name = machMap[rawDev]!;
    else if (typeof cfg.device_name === "string" && cfg.device_name && !["memento-", "memento"].includes(cfg.device_name)) name = cfg.device_name;
    else if (rawDev.startsWith("memento-")) {
      const clipped = rawDev.replace("memento-", "").slice(0, 8);
      if (clipped && !["memento-", "memento"].includes(clipped)) name = clipped;
    } else if (!/^[0-9a-fA-F-]{36}$/.test(rawDev)) {
      name = rawDev;
    }
  }
  if (!name && effectiveCwd) {
    const cwdLower = effectiveCwd.toLowerCase();
    const isWin = /^[a-z]:/.test(cwdLower) || effectiveCwd.includes("\\");
    for (const m of machRowsSummary) {
      const mn = m.name.toLowerCase();
      if (isWin && (mn.includes("windows") || mn.includes("desktop"))) {
        name = m.clean_name;
        break;
      }
      if (!isWin && (mn.includes("mac") || mn.includes("darwin") || mn.includes("linux"))) {
        name = m.clean_name;
        break;
      }
    }
  }
  if (!name || name === "memento-" || name === "memento") return null;
  return name;
}

function buildHandoffPrompt(opts: {
  srcTitle: string;
  srcMode: string;
  cwd: string;
  turns: HistoryTurn[];
  instruction?: string | null;
  maxRecentTurns: number;
}): string {
  const modeLabel = HANDOFF_MODES[opts.srcMode] ?? opts.srcMode;
  const lines = [
    "【跨智能体任务移交】",
    `1) 来源会话：《${opts.srcTitle}》（原执行模式：${modeLabel}）`,
  ];
  if (opts.cwd) lines.push(`2) 工作目录：${opts.cwd}`);
  const recent = opts.turns.slice(-opts.maxRecentTurns);
  if (recent.length) {
    lines.push("", `【前序对话关键脉络（最近 ${recent.length} 轮）】`);
    recent.forEach((t, i) => {
      const who = t.role === "assistant" ? "智能体" : "用户";
      const body = String(t.content || "").trim();
      const clipped = body.length > 1500 ? `${body.slice(0, 1500)}…（已截断，原文共 ${body.length} 字）` : body;
      lines.push(`${i + 1}) ${who}：${clipped}`);
    });
  }
  lines.push("");
  if (opts.instruction?.trim()) {
    lines.push("【移交后的下一步指令】", opts.instruction.trim());
  } else {
    lines.push("请先基于上述前序脉络快速核对当前工作区代码改动（可用 git status / git diff），然后无缝接续推进未完成的工作。");
  }
  return lines.join("\n");
}

async function findSessionConversation(db: Db, user: UserRow, sessionId: string): Promise<string | null> {
  const owned = or(eq(askConversations.userId, user.id), isNull(askConversations.userId))!;
  const [bound] = await db
    .select({ id: askConversations.id })
    .from(askConversations)
    .where(and(owned, sql`${askConversations.config}->>'session_id' = ${sessionId}`))
    .orderBy(desc(askConversations.updatedAt))
    .limit(1);
  if (bound) return bound.id;
  const [origin] = await db
    .select({ id: askConversations.id })
    .from(askConversations)
    .where(and(owned, sql`${askConversations.config}->>'origin_session_id' = ${sessionId}`, sql`jsonb_array_length(coalesce(${askConversations.turns}, '[]'::jsonb)) = 0`))
    .orderBy(desc(askConversations.updatedAt))
    .limit(1);
  return origin?.id ?? null;
}

export const askConversationRoutes = new Hono<AppEnv>();

askConversationRoutes.get("/conversations", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const deviceId = c.req.query("device_id") || null;
  const limit = queryInt(c, "limit", 500, { ge: 1, le: 500 });
  const offset = queryInt(c, "offset", 0, { ge: 0, le: 100_000 });

  const cacheKey = `ask_conv_list:${user.id}:${deviceId || "all"}:${limit}:${offset}`;
  const cached = await cacheGet(deps.redis(), cacheKey);
  if (cached !== null) return c.json(cached);

  const conds = [or(eq(askConversations.userId, user.id), isNull(askConversations.userId))!];
  if (deviceId && !["auto", "ask_only", "all"].includes(deviceId)) {
    const target = await findMachineByIdOrHash(deps.db, deps.settings, deviceId, user);
    const matchVals = new Set<string>([deviceId]);
    if (target) {
      matchVals.add(target.id);
      if (target.collectorTokenHash) matchVals.add(target.collectorTokenHash);
      if (target.name) matchVals.add(target.name);
      const cn = cleanMachName(target.name);
      if (cn) matchVals.add(cn);
      const merged = await deps.db.select().from(machines).where(eq(machines.mergedInto, target.id));
      for (const mm of merged) {
        matchVals.add(mm.id);
        if (mm.collectorTokenHash) matchVals.add(mm.collectorTokenHash);
        if (mm.name) matchVals.add(mm.name);
      }
    }
    conds.push(inArray(askConversations.deviceId, [...matchVals]));
  }

  const rows = await deps.db
    .select({
      id: askConversations.id,
      title: askConversations.title,
      createdAt: askConversations.createdAt,
      updatedAt: askConversations.updatedAt,
      deviceId: askConversations.deviceId,
      cwd: askConversations.cwd,
      config: askConversations.config,
      messageCount: askConversations.messageCount,
    })
    .from(askConversations)
    .where(and(...conds))
    .orderBy(desc(askConversations.updatedAt))
    .limit(limit)
    .offset(offset);

  const { projIdMap, projSlugMap, projSlugToId, projPathMap, machMap, machRowsSummary } = await getProjectAndMachineMaps(deps, user.id);

  const outItems = rows.map((r) => {
    const cfg = { ...((r.config && typeof r.config === "object" ? r.config : {}) as Record<string, unknown>) };
    const displayTitle = r.title || "新对话";
    const effectiveCwd = String(r.cwd || cfg.cwd || "").trim();
    let resolvedPid = typeof cfg.project_id === "string" && cfg.project_id ? cfg.project_id : null;
    let pTitle: string | null = resolvedPid ? (projIdMap[resolvedPid] ?? null) : null;

    if (!pTitle && effectiveCwd) {
      const cleaned = cleanSourcePath(effectiveCwd);
      if (cleaned) {
        const lower = cleaned.toLowerCase();
        let bestMatch: [string, string] | null = null;
        let bestLen = 0;
        for (const [pPath, pair] of Object.entries(projPathMap)) {
          if (lower === pPath || lower.startsWith(`${pPath}/`)) {
            if (pPath.length > bestLen) {
              bestMatch = pair;
              bestLen = pPath.length;
            }
          }
        }
        if (bestMatch) {
          pTitle = bestMatch[1];
          if (!resolvedPid) resolvedPid = bestMatch[0];
        } else {
          const cand = cleaned.split("/").pop() || "";
          if (cand) {
            const cl = cand.toLowerCase();
            if (cl in projSlugMap) {
              pTitle = projSlugMap[cl]!;
              if (!resolvedPid) resolvedPid = projSlugToId[cl] ?? null;
            } else if (!isInvalidProjectName(cand)) {
              pTitle = cand;
            }
          }
        }
      }
    }

    const rawDev = r.deviceId || (typeof cfg.device_id === "string" ? cfg.device_id : null);
    const devFriendlyName = resolveFriendlyDeviceName(rawDev, cfg, effectiveCwd, machMap, machRowsSummary);

    return {
      id: String(r.id),
      title: displayTitle,
      created_at: pgToIso(r.createdAt),
      updated_at: pgToIso(r.updatedAt),
      device_id: r.deviceId,
      device_name: devFriendlyName,
      project_id: resolvedPid,
      project_title: pTitle,
      cwd: effectiveCwd || r.cwd,
      config: cfg,
      message_count: r.messageCount || 0,
    };
  });

  outItems.sort((a, b) => {
    const ap = a.config?.pinned ? 0 : 1;
    const bp = b.config?.pinned ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const at = a.updated_at ? Date.parse(a.updated_at) : 0;
    const bt = b.updated_at ? Date.parse(b.updated_at) : 0;
    return bt - at;
  });

  await cacheSet(deps.redis(), cacheKey, outItems, 60).catch(() => {});
  return c.json(outItems);
});

askConversationRoutes.get("/conversations/recent-active", async (c) => {
  const user = await currentUser(c);
  const active = await askRuns.listForUser(user.id, true);
  if (!active.length) return c.json({ id: null, active_run: false });
  const run = active[0]!;
  return c.json({
    id: String(run.conversation_id),
    title: run.title || "",
    device_id: run.device_name,
    execution_mode: run.execution_mode || "ai",
    active_run: true,
  });
});

askConversationRoutes.post("/conversations/ensure-by-session", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const sessionId = String(body.session_id ?? "").trim();
  if (!sessionId) throw new HttpError(400, "session_id is required");

  const reqConfig: Record<string, unknown> = {
    execution_mode: typeof body.execution_mode === "string" && body.execution_mode ? body.execution_mode : "ai",
    project_id: typeof body.project_id === "string" ? body.project_id : "",
    session_id: sessionId,
    origin_session_id: sessionId,
    device_id: typeof body.device_id === "string" ? body.device_id : "",
    cwd: typeof body.cwd === "string" ? body.cwd : "",
  };

  const convId = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ask-ensure-by-session:${user.id}:${sessionId}`}, 0))`);
    const existing = await findSessionConversation(tx as unknown as Db, user, sessionId);
    const conv = await getOrCreateConversation(tx as unknown as Db, user, {
      conversationId: existing,
      deviceId: typeof body.device_id === "string" ? body.device_id : null,
      cwd: typeof body.cwd === "string" ? body.cwd : null,
      config: reqConfig,
    });
    return conv.id;
  });

  await syncQuietly(deps.db, convId, { sessionId });

  const [conv] = await deps.db.select().from(askConversations).where(eq(askConversations.id, convId)).limit(1);
  if (!conv) throw new HttpError(404, "Conversation not found");
  const cfg = inferConversationConfig(conv);
  const resolved = await resolveConcreteDeviceForConv(deps.db, user, typeof body.device_id === "string" ? body.device_id : null, conv);
  if (resolved.deviceId && !["auto", "ask_only", "all"].includes(resolved.deviceId)) {
    cfg.device_id = resolved.deviceId;
    if (conv.deviceId !== resolved.deviceId) {
      await deps.db.update(askConversations).set({ deviceId: resolved.deviceId, config: withoutNul(cfg) }).where(eq(askConversations.id, conv.id));
    }
  }
  const projIdFinal = String(cfg.project_id ?? (typeof body.project_id === "string" ? body.project_id : ""));
  const projTitleFinal = await lookupProjectTitle(deps.db, projIdFinal);
  await bustConvList(deps, user.id);

  return c.json({
    id: String(conv.id),
    title: conv.title,
    turns: sanitizeTurnsForResponse(conv.turns, deps.settings.secretKey),
    device_id: resolved.deviceId || conv.deviceId,
    cwd: conv.cwd,
    execution_mode: cfg.execution_mode || (typeof body.execution_mode === "string" ? body.execution_mode : "ai"),
    model: cfg.model || "",
    effort: cfg.effort || "",
    permission_mode: cfg.permission_mode || "full",
    project_id: projIdFinal,
    project_title: projTitleFinal || "",
    session_id: cfg.session_id || sessionId,
    worktree: Boolean(cfg.worktree),
    source_device_id: cfg.source_device_id || "",
    compact_mode: false,
    config: cfg,
    created_at: pgToIso(conv.createdAt),
    updated_at: pgToIso(conv.updatedAt),
  });
});

askConversationRoutes.get("/conversations/:conv_id", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const cid = normalizeUuid(c.req.param("conv_id"));
  if (!cid) throw new HttpError(400, "Invalid conversation ID");

  const limit = queryInt(c, "limit", 0, { ge: 0, le: 5000 });
  const beforeRaw = c.req.query("before");
  const before = beforeRaw !== undefined && beforeRaw !== "" && Number.isFinite(Number(beforeRaw)) ? Math.max(0, Math.trunc(Number(beforeRaw))) : null;

  if (before === null) {
    await syncQuietly(deps.db, cid);
    await recoverOrphanedTasksForConv(deps.db, cid).catch(() => {});
  }

  const cond = and(eq(askConversations.id, cid), or(eq(askConversations.userId, user.id), isNull(askConversations.userId)));
  const [conv] = await deps.db
    .select({
      id: askConversations.id,
      title: askConversations.title,
      deviceId: askConversations.deviceId,
      cwd: askConversations.cwd,
      config: askConversations.config,
      messageCount: askConversations.messageCount,
      createdAt: askConversations.createdAt,
      updatedAt: askConversations.updatedAt,
    })
    .from(askConversations)
    .where(cond)
    .limit(1);

  if (!conv) {
    // Graceful fallback: check Document with category="conversation"
    const [doc] = await deps.db
      .select({
        id: documents.id,
        title: documents.title,
        toolId: documents.toolId,
        projectId: documents.projectId,
        machineId: documents.machineId,
        metadata: documents.metadata,
        createdAt: documents.createdAt,
        syncedAt: documents.syncedAt,
      })
      .from(documents)
      .where(and(eq(documents.id, cid), eq(documents.category, "conversation")))
      .limit(1);
    if (!doc) throw new HttpError(404, "Conversation not found");

    const msgs = await deps.db
      .select({
        lineNumber: conversationMessages.lineNumber,
        role: conversationMessages.role,
        messageType: conversationMessages.messageType,
        content: conversationMessages.content,
        metadata: conversationMessages.metadata,
        timestamp: conversationMessages.timestamp,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.documentId, doc.id))
      .orderBy(asc(conversationMessages.lineNumber));

    const initTurns = sanitizeTurnsForResponse(messagesToTurns(msgs, doc.toolId || "agent"), deps.settings.secretKey);
    const meta = (doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {}) as Record<string, unknown>;
    let convDev: string | null = null;
    if (doc.machineId) {
      const [m] = await deps.db.select().from(machines).where(eq(machines.id, doc.machineId)).limit(1);
      if (m) convDev = m.collectorTokenHash || m.name;
    }
    const modeMap: Record<string, string> = { claude_code: "claude", codex: "codex", antigravity: "antigravity", workbuddy: "workbuddy" };
    const execMode = modeMap[doc.toolId] ?? "ai";
    const cfg: Record<string, unknown> = {
      execution_mode: execMode,
      session_id: String(meta.session_id || meta.cascade_id || ""),
      project_id: doc.projectId || "",
      cwd: String(meta.project_path || meta.cwd || ""),
      device_id: convDev || "",
    };
    const projTitle = await lookupProjectTitle(deps.db, doc.projectId);
    return c.json({
      id: String(doc.id),
      title: doc.title || "历史会话",
      turns: initTurns,
      total_turns: initTurns.length,
      has_more: false,
      offset: 0,
      device_id: convDev,
      device_name: null,
      cwd: cfg.cwd || null,
      execution_mode: execMode,
      model: "",
      effort: "",
      permission_mode: "full",
      project_id: doc.projectId || "",
      project_title: projTitle || "",
      session_id: cfg.session_id,
      worktree: false,
      source_device_id: "",
      compact_mode: false,
      ai_context: buildAiContextStats(String(doc.id), initTurns, null),
      config: cfg,
      created_at: pgToIso(doc.createdAt),
      updated_at: pgToIso(doc.syncedAt),
    });
  }

  const totalTurns = conv.messageCount > 0 ? conv.messageCount : await turnCount(deps.db, cid);
  const createdAtIso = pgToIso(conv.createdAt);
  const updatedAtIso = pgToIso(conv.updatedAt);
  const etag = convEtag(cid, updatedAtIso, totalTurns, limit, before, conv.deviceId);
  const inm = (c.req.header("if-none-match") || "").trim().replace(/^"|"$/g, "");
  if (inm && inm === etag.replace(/^"|"$/g, "")) {
    return c.body(null, 304, { ETag: etag, "Cache-Control": "private, no-cache" });
  }

  let rawTurns: HistoryTurn[] = [];
  let hasMore = false;
  let offset = 0;
  if (before !== null) {
    const pageLimit = limit > 0 ? limit : 60;
    const sliced = await sliceTurns(deps.db, cid, before, pageLimit);
    rawTurns = sliced.turns;
    hasMore = sliced.hasMore;
    offset = Math.max(0, before - rawTurns.length);
  } else if (limit > 0 && totalTurns > limit) {
    rawTurns = await tailTurns(deps.db, cid, limit);
    hasMore = totalTurns > rawTurns.length;
    offset = Math.max(0, totalTurns - rawTurns.length);
  } else {
    const [full] = await deps.db.select({ turns: askConversations.turns }).from(askConversations).where(eq(askConversations.id, cid)).limit(1);
    rawTurns = Array.isArray(full?.turns) ? (full!.turns as HistoryTurn[]) : [];
    hasMore = false;
    offset = 0;
  }

  const cfg = inferConversationConfig({ deviceId: conv.deviceId, cwd: conv.cwd, config: conv.config, turns: rawTurns });
  const convTurns = sanitizeTurnsForResponse(rawTurns, deps.settings.secretKey);
  const projIdVal = String(cfg.project_id ?? "");
  const projTitleVal = await lookupProjectTitle(deps.db, projIdVal);
  const { machMap, machRowsSummary } = await getProjectAndMachineMaps(deps, user.id);
  const effCwd = String(conv.cwd || cfg.cwd || "").trim();
  const devNameVal = resolveFriendlyDeviceName(conv.deviceId, cfg, effCwd, machMap, machRowsSummary);

  const aiCtx = buildAiContextStats(cid, rawTurns, (cfg[CHECKPOINT_CONFIG_KEY] as CompactState | undefined) ?? null);
  if (totalTurns > rawTurns.length) (aiCtx as Record<string, unknown>).total_turns = totalTurns;

  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  return c.json({
    id: cid,
    title: conv.title,
    turns: convTurns,
    total_turns: totalTurns,
    has_more: hasMore,
    offset,
    device_id: conv.deviceId,
    device_name: devNameVal,
    cwd: conv.cwd,
    execution_mode: cfg.execution_mode || "ai",
    model: cfg.model || "",
    effort: cfg.effort || "",
    permission_mode: cfg.permission_mode || "full",
    project_id: projIdVal,
    project_title: projTitleVal || "",
    session_id: cfg.session_id || "",
    worktree: Boolean(cfg.worktree),
    source_device_id: cfg.source_device_id || "",
    compact_mode: Boolean(cfg.compact_mode),
    ai_context: aiCtx,
    config: cfg,
    created_at: createdAtIso,
    updated_at: updatedAtIso,
  });
});

askConversationRoutes.patch("/conversations/:conv_id", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const cid = normalizeUuid(c.req.param("conv_id"));
  if (!cid) throw new HttpError(400, "Invalid conversation ID");
  const body = await parseJsonObject(c);

  const cond = and(eq(askConversations.id, cid), or(eq(askConversations.userId, user.id), isNull(askConversations.userId)));
  const [conv] = await deps.db
    .select({ id: askConversations.id, title: askConversations.title, deviceId: askConversations.deviceId, cwd: askConversations.cwd, config: askConversations.config })
    .from(askConversations)
    .where(cond)
    .limit(1);
  if (!conv) throw new HttpError(404, "Conversation not found");

  const cfg = { ...((conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>) };
  if (body.config && typeof body.config === "object" && !Array.isArray(body.config)) Object.assign(cfg, body.config);
  for (const k of ["execution_mode", "model", "effort", "project_id", "session_id", "worktree", "source_device_id", "compact_mode", "pinned"] as const) {
    if (body[k] !== undefined && body[k] !== null) cfg[k] = body[k];
  }
  if (typeof body.permission_mode === "string") cfg.permission_mode = normalizePermissionMode(body.permission_mode);

  const patch: Partial<typeof askConversations.$inferInsert> = {
    config: withoutNul(cfg),
    updatedAt: new Date().toISOString(),
  };
  if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 500);
  if (typeof body.device_id === "string") patch.deviceId = body.device_id.trim() || null;
  if (typeof body.cwd === "string") patch.cwd = body.cwd.trim() || null;

  await deps.db.update(askConversations).set(patch).where(eq(askConversations.id, cid));
  await bustConvList(deps, user.id);
  return c.json({ ok: true, config: cfg });
});

askConversationRoutes.post("/conversations/:conv_id/compact", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const cid = normalizeUuid(c.req.param("conv_id"));
  if (!cid) throw new HttpError(400, "Invalid conversation ID");
  let keepRecent = 4;
  try {
    const body = await parseJsonObject(c);
    if (typeof body.keep_recent === "number") keepRecent = Math.max(2, Math.min(Math.trunc(body.keep_recent), 12));
  } catch {
    /* optional body */
  }

  const cond = and(eq(askConversations.id, cid), or(eq(askConversations.userId, user.id), isNull(askConversations.userId)));
  const [conv] = await deps.db.select().from(askConversations).where(cond).limit(1);
  if (!conv) throw new HttpError(404, "Conversation not found");

  const turns = Array.isArray(conv.turns) ? (conv.turns as HistoryTurn[]) : [];
  const cfg = { ...((conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>) };
  const result = await compactAiConversation(deps.settings, deps.redis(), turns, {
    user,
    existingState: (cfg[CHECKPOINT_CONFIG_KEY] as CompactState | undefined) ?? null,
    keepRecent,
  });
  cfg[CHECKPOINT_CONFIG_KEY] = result.state;
  await deps.db
    .update(askConversations)
    .set({ config: withoutNul(cfg), updatedAt: new Date().toISOString() })
    .where(eq(askConversations.id, cid));
  await bustConvList(deps, user.id);
  return c.json({
    ok: true,
    conversation_id: cid,
    summary: result.summary,
    covered_turns: result.covered_turns,
    kept_turns: result.kept_turns,
    before_tokens: result.before_tokens,
    after_tokens: result.after_tokens,
    ai_context: buildAiContextStats(cid, turns, result.state),
  });
});

askConversationRoutes.delete("/conversations/:conv_id/compact", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const cid = normalizeUuid(c.req.param("conv_id"));
  if (!cid) throw new HttpError(400, "Invalid conversation ID");

  const cond = and(eq(askConversations.id, cid), or(eq(askConversations.userId, user.id), isNull(askConversations.userId)));
  const [conv] = await deps.db.select({ id: askConversations.id, config: askConversations.config }).from(askConversations).where(cond).limit(1);
  if (!conv) throw new HttpError(404, "Conversation not found");

  const cfg = { ...((conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>) };
  delete cfg[CHECKPOINT_CONFIG_KEY];
  await deps.db
    .update(askConversations)
    .set({ config: withoutNul(cfg), updatedAt: new Date().toISOString() })
    .where(eq(askConversations.id, cid));
  await bustConvList(deps, user.id);
  return c.json({ ok: true });
});

askConversationRoutes.post("/conversations/:conv_id/handoff", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const cid = normalizeUuid(c.req.param("conv_id"));
  if (!cid) throw new HttpError(400, "Invalid conversation ID");
  const body = await parseJsonObject(c);

  const targetMode = String(body.target_execution_mode ?? "").trim().toLowerCase();
  if (!(targetMode in HANDOFF_MODES)) throw new HttpError(400, `不支持的移交目标模式：${targetMode}`);

  const cond = and(eq(askConversations.id, cid), or(eq(askConversations.userId, user.id), isNull(askConversations.userId)));
  const [src] = await deps.db.select().from(askConversations).where(cond).limit(1);
  if (!src) throw new HttpError(404, "Conversation not found");

  const srcCfg = inferConversationConfig(src);
  const srcMode = String(srcCfg.execution_mode ?? "ai").trim().toLowerCase();
  const srcTitle = (src.title || "未命名对话").trim();
  const srcTurns = Array.isArray(src.turns) ? (src.turns as HistoryTurn[]) : [];
  const effCwd = String(src.cwd || srcCfg.cwd || "").trim();
  const resolved = await resolveConcreteDeviceForConv(deps.db, user, typeof body.target_device_id === "string" ? body.target_device_id : null, src);
  const effDeviceId = resolved.deviceId || src.deviceId || String(srcCfg.device_id || "");
  const effProjectId = String(srcCfg.project_id ?? "").trim();
  const effSourceDeviceId = String(srcCfg.source_device_id ?? "").trim();

  const maxRecent = Math.max(2, Math.min(Number(body.max_recent_turns ?? 6), 12));
  const handoffPrompt = buildHandoffPrompt({
    srcTitle,
    srcMode,
    cwd: effCwd,
    turns: srcTurns,
    instruction: typeof body.instruction === "string" ? body.instruction : null,
    maxRecentTurns: maxRecent,
  });

  const nowIso = new Date().toISOString();
  const targetLabel = HANDOFF_MODES[targetMode]!;
  const baseTitle = srcTitle.replace(/\s*·\s*移交\s+.*$/, "").trim() || srcTitle;
  const newTitle = String(body.title || `${baseTitle} · 移交 ${targetLabel}`).trim().slice(0, 120);

  const newCfg: Record<string, unknown> = {
    execution_mode: targetMode,
    model: typeof body.target_model === "string" ? body.target_model.trim() : "",
    effort: typeof body.target_effort === "string" ? body.target_effort.trim() : "",
    project_id: effProjectId,
    device_id: effDeviceId,
    cwd: effCwd,
    session_id: "",
    worktree: Boolean(srcCfg.worktree),
    source_device_id: effSourceDeviceId,
    compact_mode: false,
    handoff_from: {
      conversation_id: String(src.id),
      title: srcTitle,
      execution_mode: srcMode,
      session_id: String(srcCfg.session_id ?? ""),
      handed_off_at: nowIso,
    },
  };

  const [newConv] = await deps.db
    .insert(askConversations)
    .values({
      id: randomUUID(),
      userId: user.id,
      title: newTitle,
      deviceId: effDeviceId || null,
      cwd: effCwd || null,
      config: withoutNul(newCfg),
      turns: [],
      messageCount: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning();
  await bustConvList(deps, user.id);

  const projTitleVal = await lookupProjectTitle(deps.db, effProjectId);
  return c.json({
    conversation: {
      id: String(newConv!.id),
      title: newConv!.title,
      turns: [],
      total_turns: 0,
      has_more: false,
      offset: 0,
      device_id: newConv!.deviceId,
      cwd: newConv!.cwd,
      execution_mode: targetMode,
      model: newCfg.model,
      effort: newCfg.effort,
      project_id: effProjectId,
      project_title: projTitleVal || "",
      session_id: "",
      worktree: Boolean(newCfg.worktree),
      source_device_id: effSourceDeviceId,
      compact_mode: false,
      config: newCfg,
      created_at: pgToIso(newConv!.createdAt),
      updated_at: pgToIso(newConv!.updatedAt),
    },
    handoff_prompt: handoffPrompt,
    latest_checkpoint: null,
  });
});

askConversationRoutes.delete("/conversations/:conv_id", async (c) => {
  const deps = c.get("deps");
  const user = await currentUser(c);
  const cid = normalizeUuid(c.req.param("conv_id"));
  if (!cid) throw new HttpError(400, "Invalid conversation ID");

  const cond = and(eq(askConversations.id, cid), or(eq(askConversations.userId, user.id), isNull(askConversations.userId)));
  const deleted = await deps.db.delete(askConversations).where(cond).returning({ id: askConversations.id });
  if (!deleted.length) throw new HttpError(404, "Conversation not found");

  await bustConvList(deps, user.id);
  return c.json({ ok: true });
});

export { isJunkOrUuidTitle, storedTurnCount };
