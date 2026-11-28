// Dreaming Consolidation Service: Light -> REM -> Deep -> MEMORY.md & DREAMS.md + Backfill + Bootstrap
// (server/server/services/dreaming_service.py + server/server/tasks/dreaming_tasks.py).
import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import { cacheDeletePrefix } from "../cache";
import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import {
  askConversations,
  conversationMessages,
  dailySummaries,
  documents,
  dreamJournals,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  projects,
  userMemories,
  users,
} from "../db/pulled/schema";
import * as aiHealth from "./ai-health";
import { callPlainChat, getAiProviders } from "./ai-provider";
import { fetchAskUserTurnsSince } from "./ask-store";
import { cluster, PREFIX, type Mutex } from "./cluster";
import { safeJsonLoads } from "./dreaming-core";
import { cleanUserVoice, fetchUserVoiceRows, planUserVoiceBatches, renderUserVoice, sanitizeTransientText } from "./dreaming-voice";
import { callEmbeddingServer, toVectorLiteral } from "./embedding";
import { findEntity, markStaleEntities, mergeDuplicateEntities } from "./entity-canon";
import { getAllScenarios, loadDynamicScenariosFromDb, registerScenario } from "./mind-resonance-service";
import { notifyUser } from "./notify";
import { buildProfileDraft } from "./profile-draft";

export type DreamJournalRow = typeof dreamJournals.$inferSelect;

const IGNORE_SLUGS = new Set([
  "home", "haixingdong", "donghaixing", "admin", "users_admin", "users_haixingdong",
  "desktop", "workspace", "temp", "tmp", "var", "folders",
  "test", "tests", "test_项目", "analysis", "demo", "ban", "le", "foo", "scratch",
  "api", "server", "web", "frontend", "mobile", "ios", "data", "scripts", "docs",
  "mcp", "mcp_server", "collector", "deploy", "uiux", "cineflow", "gitops",
  "codex", "antigravity", "claude_code", "cursor", "hermes", "hermes_hermes",
  "antigravity_history", "antigravity_con", "antigravity_online",
]);

function isSuspiciousNonProject(slug: string, rawName: string): boolean {
  const s = slug.toLowerCase().trim();
  const r = rawName.toLowerCase().trim();
  if (/^(\d+[._])+\d+$/.test(s) || /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(r)) return true;
  if (["smiles", "cid", "cas_", "inchi", "corpus", "reaction_", "二氮杂", "苯并", "甲基"].some((k) => r.includes(k) || s.includes(k))) {
    return true;
  }
  if (/^\d+$/.test(s) || /^\d{4}[-_]?\d{2,4}$/.test(s)) return true;
  return false;
}

export function resolveCanonicalSlug(rawName: string): string {
  let n = rawName.toLowerCase().trim();
  for (const prefix of [
    "antigravity/", "claude_code/", "codex/", "cursor/", "ddong8/",
    "pskoett/", "fenio/", "jrei/", "linuxserver/", "onerahmet/",
    "gitee_vavafan/", "gitlab_aiphacas_com_frank/",
  ]) {
    if (n.startsWith(prefix)) n = n.slice(prefix.length);
  }
  n = n.replace(/[\s\-/.]+/g, "_").replace(/^_+|_+$/g, "").replace(/_\([^)]+\)$/, "");
  return n || "other";
}

export interface CanonicalProject {
  slug: string;
  title: string;
  summary: string;
  doc_count: number;
  obs_count: number;
  is_curated: boolean;
}

export async function extractCanonicalProjects(db: Db, user: Pick<UserRow, "id">): Promise<CanonicalProject[]> {
  const docProjects = (await db.execute(sql`
    SELECT p.slug, p.title, count(d.id)::int AS cnt
    FROM projects p
    LEFT JOIN documents d ON d.project_id = p.id
    WHERE d.machine_id IN (SELECT id FROM machines WHERE user_id = ${user.id}::uuid)
    GROUP BY p.id
  `)) as unknown as { slug: string | null; title: string | null; cnt: number }[];

  const keProjects = (await db.execute(sql`
    SELECT ke.name, ke.summary, count(ko.id)::int AS cnt
    FROM knowledge_entities ke
    LEFT JOIN knowledge_observations ko ON ko.entity_id = ke.id
    WHERE ke.user_id = ${user.id}::uuid AND ke.entity_type = 'project'
    GROUP BY ke.id
  `)) as unknown as { name: string | null; summary: string | null; cnt: number }[];

  const results = new Map<string, CanonicalProject>();
  for (const row of docProjects) {
    const rawName = String(row.slug || row.title || "").trim();
    if (!rawName) continue;
    const slug = resolveCanonicalSlug(rawName);
    const cnt = Number(row.cnt ?? 0);
    const prev = results.get(slug);
    if (prev) {
      prev.doc_count += cnt;
    } else if (cnt >= 5 && !IGNORE_SLUGS.has(slug) && slug.length >= 3 && !isSuspiciousNonProject(slug, rawName)) {
      results.set(slug, {
        slug,
        title: row.title || slug,
        summary: `活跃研发工程，关联 ${cnt} 份代码与工作会话。`,
        doc_count: cnt,
        obs_count: 0,
        is_curated: false,
      });
    }
  }
  for (const row of keProjects) {
    const rawName = String(row.name || "").trim();
    if (!rawName) continue;
    const slug = resolveCanonicalSlug(rawName);
    const existing = results.get(slug);
    if (existing) {
      existing.obs_count += Number(row.cnt ?? 0);
      const sum = (row.summary || "").trim();
      if (sum && sum.length > existing.summary.length) existing.summary = sum;
    }
  }
  return [...results.values()]
    .filter((p) => p.doc_count > 0 || p.obs_count > 0)
    .sort((a, b) => b.doc_count + b.obs_count - (a.doc_count + a.obs_count));
}

export async function deduplicateAndMergeEntities(db: Db, redis: Redis | null, userId: string) {
  const stats = { merged_entities: 0, merged_observations: 0, updated_relations: 0, stale_entities: 0 };
  try {
    const res = await db.transaction(async (tx) => {
      const got = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`graph-tidy:${userId}`})) AS ok`)) as unknown as {
        ok: boolean;
      }[];
      if (!got[0]?.ok) return stats;
      const tdb = tx as unknown as Db;
      const merged = await mergeDuplicateEntities(tdb, userId);
      const stale = await markStaleEntities(tdb, userId);
      return { ...stats, ...merged, stale_entities: stale };
    });
    Object.assign(stats, res);
  } catch (e) {
    console.warn("[dreaming] deduplicateAndMergeEntities failed:", (e as Error).message);
  }
  if (stats.merged_entities || stats.stale_entities) {
    await Promise.allSettled([
      cacheDeletePrefix(redis, `memory:resonance:${userId}`),
      cacheDeletePrefix(redis, `profile_injection:${userId}`),
      cacheDeletePrefix(redis, `user:blueprint:v4:${userId}`),
    ]);
  }
  return stats;
}

const DREAM_PROMPT = (existing: string, recent: string, daysBack: number) => `你是一个高阶智能大脑的认知记忆固化中枢（负责模拟人类睡眠时的记忆重组与知识固化机制）。
你的目标是分析用户最近的交互记录、每日研发小结与历史核心记忆，提炼出真正值得沉淀为【长期核心记忆 (MEMORY.md)】的高价值知识，并生成一份充满洞察的《梦境日记 (DREAMS.md)》。

### 用户已有的长期核心记忆 (L3 现有库)
${existing}

### 阶段一已清洗的近期活动与会话脉络 (近 ${daysBack} 天)
${recent}

---

### 做梦任务指导：
1. REM 快速眼动反思：挖掘跨会话、跨工具模式、架构约定与偏好。preference 与 rule 只能依据【用户亲口说的话】一节。
2. Deep 深度睡眠固化：坚决过滤临时琐事；category 仅限 project, architecture, rule, tools, preference；confidence >= 0.75 才写入。
3. 知识图谱关系：输出 discovered_relations。
4. 自进化心智场景：如发现新兴独立领域输出 discovered_scenarios。

请严格输出合法的 JSON 格式：
{
  "light_sleep_notes": "...",
  "rem_reflections": "...",
  "deep_consolidations": "...",
  "promoted_memories": [{"category": "project", "tree_path": "/project/x/overview", "key": "proj_x", "content": "...", "confidence": 0.95}],
  "discovered_relations": [{"source": "A", "target": "B", "relation": "uses"}],
  "discovered_scenarios": []
}`;

export async function runDreamingPipeline(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  opts: { daysBack?: number; startDate?: string | null; endDate?: string | null; tag?: string; skipIfEmpty?: boolean } = {},
): Promise<DreamJournalRow | null> {
  const daysBack = opts.daysBack ?? 2;
  const tag = opts.tag ?? "nightly";
  const skipIfEmpty = opts.skipIfEmpty ?? false;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  let sinceDate: string;
  let untilDate: string;
  let sinceIso: string;
  let untilIso: string;
  if (opts.startDate && opts.endDate) {
    sinceDate = opts.startDate;
    untilDate = opts.endDate;
    sinceIso = `${sinceDate}T00:00:00.000Z`;
    untilIso = `${untilDate}T23:59:59.000Z`;
  } else if (daysBack <= 0) {
    sinceDate = "2020-01-01";
    untilDate = today;
    sinceIso = "2020-01-01T00:00:00.000Z";
    untilIso = now.toISOString();
  } else {
    untilDate = today;
    sinceDate = new Date(now.getTime() - daysBack * 86400_000).toISOString().slice(0, 10);
    untilIso = now.toISOString();
    sinceIso = new Date(now.getTime() - daysBack * 86400_000).toISOString();
  }

  const canonicalProjects = await extractCanonicalProjects(db, user);
  const dailyRows = await db
    .select()
    .from(dailySummaries)
    .where(
      and(
        or(eq(dailySummaries.userId, user.id), isNull(dailySummaries.userId)),
        gte(dailySummaries.summaryDate, sinceDate),
        lte(dailySummaries.summaryDate, untilDate),
      ),
    )
    .orderBy(asc(dailySummaries.summaryDate));

  const askData = await fetchAskUserTurnsSince(db, user.id, sinceIso, { untilIso, maxConvs: 30, maxTurnsPerConv: 6 });

  const voiceRows = await fetchUserVoiceRows(db, user.id, sinceIso, untilIso);
  const { batches: voiceBatches, stats: voiceStats } = planUserVoiceBatches(voiceRows);

  const docLimit = daysBack <= 0 ? 100 : 30;
  const windowDocs = (await db.execute(sql`
    SELECT title, category, ai_summary FROM documents
    WHERE machine_id IN (SELECT id FROM machines WHERE user_id = ${user.id}::uuid)
      AND created_at >= ${sinceIso}::timestamptz AND created_at <= ${untilIso}::timestamptz
    ORDER BY created_at DESC LIMIT ${docLimit}
  `)) as unknown as { title: string | null; category: string | null; ai_summary: string | null }[];

  const entLimit = daysBack <= 0 ? 50 : 20;
  const windowEnts = await db
    .select({ name: knowledgeEntities.name, entityType: knowledgeEntities.entityType, summary: knowledgeEntities.summary })
    .from(knowledgeEntities)
    .where(and(eq(knowledgeEntities.userId, user.id), gte(knowledgeEntities.updatedAt, sinceIso), lte(knowledgeEntities.updatedAt, untilIso)))
    .orderBy(desc(knowledgeEntities.updatedAt))
    .limit(entLimit);

  const scannedCount =
    dailyRows.length + askData.convCount + (voiceStats.kept ?? 0) + windowDocs.length + windowEnts.length + canonicalProjects.length;
  if (skipIfEmpty && scannedCount === 0) return null;

  const snippets: string[] = [];
  if (canonicalProjects.length) {
    snippets.push(
      "### 【用户核心业务项目全景一览】\n" +
        canonicalProjects.map((p) => `- ${p.slug} (${p.title}): ${p.summary} (关联文档: ${p.doc_count}, 观察事实: ${p.obs_count})`).join("\n"),
    );
  }
  if (dailyRows.length) {
    snippets.push("### 【每日研发摘要】");
    for (const ds of dailyRows) snippets.push(`- [${ds.summaryDate}] ${ds.title}:\n${sanitizeTransientText(ds.summary)}`);
  }
  if (askData.turns.length) {
    snippets.push("\n### 【近期交互对话】");
    const byConv = new Map<string, { title: string; lines: string[] }>();
    for (const t of askData.turns) {
      const clean = cleanUserVoice(t.content);
      if (!clean) continue;
      let grp = byConv.get(t.convId);
      if (!grp) {
        grp = { title: t.title, lines: [] };
        byConv.set(t.convId, grp);
      }
      grp.lines.push(`  [user]: ${clean}`);
    }
    for (const grp of byConv.values()) {
      if (grp.lines.length) snippets.push(`- 对话《${grp.title}》:\n${grp.lines.join("\n")}`);
    }
  }
  if (windowDocs.length) {
    snippets.push("\n### 【开发会话与文档主题】");
    for (const d of windowDocs) {
      if (!d.title && !d.ai_summary) continue;
      const cat = (d.category || "session").trim();
      const title = (d.title || "未命名会话").trim();
      snippets.push(d.ai_summary ? `- [${cat}] ${title}: ${sanitizeTransientText(d.ai_summary).slice(0, 180)}` : `- [${cat}] ${title}`);
    }
  }
  if (windowEnts.length) {
    snippets.push("\n### 【提炼技术实体与知识图谱】");
    for (const e of windowEnts) {
      snippets.push(e.summary ? `- [${e.entityType}] ${e.name}: ${e.summary.trim().slice(0, 150)}` : `- [${e.entityType}] ${e.name}`);
    }
  }
  const userVoiceStr = await renderUserVoice(settings, redis, user, voiceBatches);
  if (userVoiceStr) {
    const condensed = (voiceStats.batches ?? 0) > 1 ? "（按批提炼）" : "";
    snippets.push(`\n### 【用户亲口说的话${condensed}】（窗口内 ${voiceStats.kept ?? 0} 条有效输入，其中 ${voiceStats.corrections ?? 0} 条带纠正/要求语气）`);
    snippets.push(userVoiceStr);
  }

  const existingMems = await db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), eq(userMemories.status, "active")))
    .orderBy(asc(userMemories.category), desc(userMemories.updatedAt));
  const existingStr = existingMems.length
    ? existingMems.map((m) => `- [${m.category}/${m.key}] (${Number(m.confidence ?? 0).toFixed(2)}): ${m.content}`).join("\n")
    : "(尚未沉淀任何长期核心记忆)";

  let llmOutput: Record<string, unknown> = {};
  let llmStatus = "skipped";
  if (getAiProviders(settings, { background: true, user }).length && scannedCount > 0) {
    const daysSpan = Math.max(1, Math.round((Date.parse(untilDate) - Date.parse(sinceDate)) / 86400_000) + 1);
    try {
      const raw = await callPlainChat(
        settings,
        redis,
        [
          { role: "system", content: "You are the Memento Dreaming Memory Consolidation Kernel. Respond only with valid JSON." },
          { role: "user", content: DREAM_PROMPT(existingStr, snippets.join("\n") || "(近期无显著交互记录)", daysSpan) },
        ],
        { maxTokens: 4096, background: true, user },
      );
      if (raw) {
        llmOutput = safeJsonLoads(raw);
        llmStatus = Object.keys(llmOutput).length ? "ok" : "unparsed";
      } else {
        llmStatus = "failed";
      }
    } catch {
      llmStatus = "failed";
    }
  }

  let lightNotes: string;
  let remNotes: string;
  let deepNotes: string;
  let promoted: Record<string, unknown>[] = [];
  let relations: Record<string, unknown>[] = [];
  if (!Object.keys(llmOutput).length) {
    lightNotes = `扫描了近 ${daysBack} 天的 ${scannedCount} 条记录（含 ${dailyRows.length} 篇日报、${askData.convCount} 组问答、${voiceStats.kept ?? 0} 条用户原话）。完成临时垃圾过滤与去噪。`;
    if (llmStatus === "failed" || llmStatus === "unparsed") {
      const reason = llmStatus === "failed" ? "模型没有回答" : "模型的回答不是有效的 JSON";
      remNotes = `REM 反思阶段：${reason}，本次没有做反思。`;
      deepNotes = "深睡阶段：本次没有沉淀新的长期记忆。";
    } else {
      remNotes = "REM 反思阶段：数据量稳定，未发现需要突破阈值的跨周期冲突。保持当前长时记忆稳固。";
      deepNotes = "深睡阶段：常规巡检完成，暂无新增晋升条目。";
    }
  } else {
    lightNotes = String(llmOutput.light_sleep_notes || "完成近期交互与日报的去噪与切片。");
    remNotes = String(llmOutput.rem_reflections || "完成跨时空模式识别与经验沉淀。");
    deepNotes = String(llmOutput.deep_consolidations || "完成长期记忆加权门控与固化。");
    promoted = Array.isArray(llmOutput.promoted_memories) ? (llmOutput.promoted_memories as Record<string, unknown>[]) : [];
    relations = Array.isArray(llmOutput.discovered_relations) ? (llmOutput.discovered_relations as Record<string, unknown>[]) : [];
  }

  const nowIso = now.toISOString();
  let promotedCount = 0;
  const promotedDetails: string[] = [];
  const touchedIds: { id: string; content: string }[] = [];

  for (const item of promoted) {
    if (!item || typeof item !== "object") continue;
    const cat = String(item.category ?? "general").trim();
    const key = String(item.key ?? "note").trim().toLowerCase().replaceAll(" ", "_");
    const content = String(item.content ?? "").trim();
    const confidence = Number(item.confidence ?? 0.9);
    const treePath = String(item.tree_path ?? `/${cat}/${key}`).trim();
    if (!content || confidence < 0.7) continue;

    const [existing] = await db
      .select()
      .from(userMemories)
      .where(and(eq(userMemories.userId, user.id), eq(userMemories.category, cat), eq(userMemories.key, key)))
      .limit(1);
    if (existing) {
      if (existing.source === "manual") {
        promotedDetails.push(`- ⏸️ 保留手写【${existing.treePath || treePath}】，未采纳梦境改写: ${content}`);
        continue;
      }
      if (existing.status === "superseded") {
        promotedDetails.push(`- ⏸️ 【${existing.treePath || treePath}】已被新的记忆取代，不再恢复`);
        continue;
      }
      await db
        .update(userMemories)
        .set(
          withoutNul({
            status: existing.status === "dormant" ? "active" : existing.status,
            statusReason: existing.status === "dormant" ? null : existing.statusReason,
            content,
            confidence: Math.max(existing.confidence, confidence),
            source: "dreaming",
            treePath,
            updatedAt: nowIso,
          }),
        )
        .where(eq(userMemories.id, existing.id));
      touchedIds.push({ id: existing.id, content });
      promotedDetails.push(`- 🔄 更新【${treePath}】: ${content}`);
    } else {
      const id = randomUUID();
      await db.insert(userMemories).values(
        withoutNul({
          id,
          userId: user.id,
          category: cat,
          key,
          content,
          confidence,
          source: "dreaming",
          treePath,
          isFolder: false,
          recallCount: 0,
          status: "active",
          createdAt: nowIso,
          updatedAt: nowIso,
        }),
      );
      touchedIds.push({ id, content });
      promotedDetails.push(`- 🌟 新增【${treePath}】: ${content}`);
    }
    promotedCount++;
  }

  for (const rel of relations) {
    if (!rel || typeof rel !== "object") continue;
    const srcName = String(rel.source ?? "").trim();
    const tgtName = String(rel.target ?? "").trim();
    const relType = String(rel.relation ?? "relates_to").trim();
    if (!srcName || !tgtName) continue;
    try {
      const ends: (typeof knowledgeEntities.$inferSelect)[] = [];
      for (const name of [srcName, tgtName]) {
        let ent = await findEntity(db, user.id, name, "concept");
        if (!ent) {
          const [created] = await db
            .insert(knowledgeEntities)
            .values({ id: randomUUID(), userId: user.id, name, entityType: "concept", aliases: [], createdAt: nowIso, updatedAt: nowIso })
            .returning();
          ent = created!;
        }
        ends.push(ent);
      }
      const [sEnt, tEnt] = ends as [typeof knowledgeEntities.$inferSelect, typeof knowledgeEntities.$inferSelect];
      if (sEnt.id === tEnt.id) continue;
      const [same] = await db
        .select()
        .from(knowledgeRelations)
        .where(and(eq(knowledgeRelations.sourceId, sEnt.id), eq(knowledgeRelations.targetId, tEnt.id), eq(knowledgeRelations.relationType, relType)))
        .limit(1);
      if (same) {
        await db.update(knowledgeRelations).set({ strength: (same.strength ?? 1) + 0.9 }).where(eq(knowledgeRelations.id, same.id));
      } else {
        await db.insert(knowledgeRelations).values({ id: randomUUID(), sourceId: sEnt.id, targetId: tEnt.id, relationType: relType, strength: 0.9 });
      }
    } catch {
      /* non-blocking */
    }
  }

  let learnedScenariosCount = 0;
  try {
    const discovered = Array.isArray(llmOutput.discovered_scenarios) ? [...(llmOutput.discovered_scenarios as Record<string, unknown>[])] : [];
    if (discovered.length || canonicalProjects.length) await loadDynamicScenariosFromDb(db, user.id);
    const activeScenarios = getAllScenarios(user.id);
    const activeIds = new Set(activeScenarios.map((s) => s.id));
    const activeProjs = new Set(activeScenarios.map((s) => (s.target_project || "").toLowerCase()).filter(Boolean));
    if (!discovered.length && canonicalProjects.length) {
      for (const p of canonicalProjects) {
        if (!activeIds.has(p.slug) && !activeProjs.has(p.slug.toLowerCase())) {
          const cleanTitle = p.title.split("(")[0]!.trim();
          discovered.push({
            id: `proj_${p.slug}`,
            name: `${cleanTitle} 领域研发`,
            keywords: [p.slug, cleanTitle.toLowerCase()],
            mindset: `专注 ${p.title} 业务目标，交付前严格验证，保持代码整洁。`,
            target_project: p.slug,
            anchors: [cleanTitle, p.slug],
            defense_rules: [`1) 涉及 ${p.slug} 项目的所有改动必须遵循系统架构设计，交付前先自测确认。`],
            device_affinity: null,
          });
        }
      }
    }
    for (const scen of discovered) {
      if (!scen || !scen.id) continue;
      const reg = registerScenario(scen, { userId: user.id });
      const scenContent = JSON.stringify(reg);
      const scenKey = `scenario_${reg.id}`;
      const scenPath = `/scenario/${reg.id}`;
      const [existingScen] = await db
        .select()
        .from(userMemories)
        .where(and(eq(userMemories.userId, user.id), eq(userMemories.category, "resonance_scenario"), eq(userMemories.key, scenKey)))
        .limit(1);
      if (existingScen) {
        await db
          .update(userMemories)
          .set({ content: scenContent, confidence: 0.95, source: "dreaming", treePath: scenPath, updatedAt: nowIso })
          .where(eq(userMemories.id, existingScen.id));
        touchedIds.push({ id: existingScen.id, content: scenContent });
      } else {
        const id = randomUUID();
        await db.insert(userMemories).values({
          id,
          userId: user.id,
          category: "resonance_scenario",
          key: scenKey,
          content: scenContent,
          confidence: 0.95,
          source: "dreaming",
          treePath: scenPath,
          isFolder: false,
          recallCount: 0,
          status: "active",
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        touchedIds.push({ id, content: scenContent });
      }
      learnedScenariosCount++;
    }
  } catch {
    /* non-blocking */
  }

  if (touchedIds.length) {
    try {
      const vecs = await callEmbeddingServer(settings, redis, touchedIds.map((t) => t.content.slice(0, 800)), 10);
      if (vecs) {
        for (let i = 0; i < touchedIds.length; i++) {
          const v = vecs[i];
          if (v?.length) {
            await db.execute(sql`UPDATE user_memories SET embedding = ${toVectorLiteral(v)}::vector WHERE id = ${touchedIds[i]!.id}::uuid`);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  const dedupStats = await deduplicateAndMergeEntities(db, redis, user.id);
  if (dedupStats.merged_entities > 0) {
    deepNotes += `\n- 知识图谱自愈：消歧合并 ${dedupStats.merged_entities} 个同义实体，精简整合 ${dedupStats.merged_observations} 条观测事实。`;
  }
  if (dedupStats.stale_entities > 0) {
    deepNotes += `\n- 知识图谱：${dedupStats.stale_entities} 个实体的描述说它已不在、之后的对话却还在用，已标记为过时（不再注入，未删除）。`;
  }

  const dateLabel = sinceDate !== untilDate ? `${sinceDate} ~ ${untilDate}` : untilDate;
  const reportLines = [
    `# 🌙 梦境反思日记 (Dream Journal) — ${dateLabel}`,
    "",
    `> 做梦时间：${nowIso.replace("T", " ").slice(0, 19)} UTC`,
    `> 记忆扫描：检索近期 ${scannedCount} 条记录 | 固化新增/更新 ${promotedCount} 条长期记忆`,
    "",
    "## 💤 阶段一：浅度睡眠 (Light Sleep · 清洗去噪)",
    lightNotes,
    "",
    "## 🧠 阶段二：REM 快速眼动期 (REM Sleep · 联想与模式反思)",
    remNotes,
    "",
    "## 💎 阶段三：深度睡眠 (Deep Sleep · 长期记忆固化)",
    deepNotes,
    "",
  ];
  if (promotedDetails.length) {
    reportLines.push("### 🌟 本次晋升至 MEMORY.md 的核心知识：", ...promotedDetails, "");
  }

  const metrics = {
    scanned_items: scannedCount,
    promoted_count: promotedCount,
    relations_found: relations.length,
    discovered_scenarios: learnedScenariosCount,
    llm: llmStatus,
    user_voice: voiceStats,
    days_back: Math.max(1, Math.round((Date.parse(untilDate) - Date.parse(sinceDate)) / 86400_000) + 1),
    start_date: sinceDate,
    end_date: untilDate,
    tag,
  };

  const [journal] = await db
    .insert(dreamJournals)
    .values({
      id: randomUUID(),
      userId: user.id,
      dreamDate: untilDate,
      stageMetrics: metrics,
      lightSleepNotes: lightNotes,
      remReflections: remNotes,
      deepConsolidations: deepNotes,
      reportMarkdown: reportLines.join("\n"),
      createdAt: nowIso,
    })
    .returning();
  return journal!;
}

const backfillStatusMem = new Map<string, Record<string, unknown>>();
const BACKFILL_KEY = `${PREFIX}dream-backfill:`;
export const BACKFILL_LOCK = "dream-backfill:";

export async function getBackfillStatus(userId: string): Promise<Record<string, unknown>> {
  let status = backfillStatusMem.get(userId);
  if (status && status.status === "running") return status;
  const r = cluster.redis;
  if (r) {
    try {
      const raw = await r.get(BACKFILL_KEY + userId);
      if (raw) status = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  if (!status) return { status: "idle" };
  if (status.status === "running" && !(await cluster.locked(BACKFILL_LOCK + userId))) {
    return { status: "error", error: "回填所在的服务实例已重启，回填中断，可以重新发起" };
  }
  return status;
}

export function setBackfillStatus(userId: string, status: Record<string, unknown>): void {
  backfillStatusMem.set(userId, status);
  const blob = JSON.stringify(status);
  cluster.write((r) => r.set(BACKFILL_KEY + userId, blob, "EX", 7 * 86400));
}

export async function runDreamingBackfill(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  chunkDays = 3,
  maxChunks = 30,
  onProgress?: (p: Record<string, unknown>) => void,
) {
  const today = new Date().toISOString().slice(0, 10);
  const [minRow] = (await db.execute(sql`
    SELECT least(
      (SELECT min(summary_date) FROM daily_summaries WHERE user_id = ${user.id}::uuid OR user_id IS NULL),
      (SELECT min(created_at)::date FROM documents WHERE machine_id IN (SELECT id FROM machines WHERE user_id = ${user.id}::uuid)),
      (SELECT min(created_at)::date FROM ask_conversations WHERE user_id = ${user.id}::uuid),
      (SELECT min(created_at)::date FROM knowledge_entities WHERE user_id = ${user.id}::uuid)
    ) AS earliest
  `)) as unknown as { earliest: string | null }[];
  if (!minRow?.earliest) {
    return { status: "completed", total_windows: 0, processed_windows: 0, skipped_windows: 0, total_promoted: 0, message: "暂无历史活动记录需要回溯" };
  }
  const windows: [string, string][] = [];
  let currMs = Date.parse(`${String(minRow.earliest).slice(0, 10)}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  while (currMs <= todayMs) {
    const nxtMs = Math.min(currMs + (chunkDays - 1) * 86400_000, todayMs);
    windows.push([new Date(currMs).toISOString().slice(0, 10), new Date(nxtMs).toISOString().slice(0, 10)]);
    currMs = nxtMs + 86400_000;
  }
  const toProcess = windows.slice(0, maxChunks);
  let totalPromoted = 0;
  let processed = 0;
  let skipped = 0;
  const journalIds: string[] = [];

  for (let i = 0; i < toProcess.length; i++) {
    const [wStart, wEnd] = toProcess[i]!;
    const journal = await runDreamingPipeline(db, settings, redis, user, {
      startDate: wStart,
      endDate: wEnd,
      tag: "backfill",
      skipIfEmpty: true,
    });
    if (!journal) {
      skipped++;
      onProgress?.({ current: i + 1, total: toProcess.length, window: [wStart, wEnd], status: "skipped_empty", promoted_total: totalPromoted });
      continue;
    }
    const m = journal.stageMetrics && typeof journal.stageMetrics === "object" ? (journal.stageMetrics as Record<string, unknown>) : {};
    const pCount = Number(m.promoted_count ?? 0);
    totalPromoted += pCount;
    processed++;
    journalIds.push(journal.id);
    onProgress?.({ current: i + 1, total: toProcess.length, window: [wStart, wEnd], status: "processed", promoted_in_chunk: pCount, promoted_total: totalPromoted });
  }
  return {
    status: "completed",
    total_windows: windows.length,
    processed_windows: processed,
    skipped_windows: skipped,
    total_promoted: totalPromoted,
    journal_ids: journalIds,
  };
}

export async function runUserBackfillAsync(
  deps: { db: Db; settings: Settings; redis: () => Redis | null },
  userId: string,
  chunkDays = 3,
  maxChunks = 30,
  mutex?: Mutex | null,
) {
  try {
    setBackfillStatus(userId, { status: "running", current: 0, total: 0, promoted_total: 0, message: "正在初始化时间切片与历史活动探测..." });
    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
      setBackfillStatus(userId, { status: "error", error: "User not found" });
      return { error: "User not found" };
    }
    const result = await runDreamingBackfill(deps.db, deps.settings, deps.redis(), user, chunkDays, maxChunks, (p) => {
      setBackfillStatus(userId, { status: "running", ...p });
    });
    setBackfillStatus(userId, { status: "completed", result });
    return result;
  } catch (e) {
    setBackfillStatus(userId, { status: "error", error: (e as Error).message || String(e) });
    throw e;
  } finally {
    if (mutex) {
      await cluster.flush();
      await mutex.release();
    }
  }
}

export async function runAllUsersNightlyDreaming(
  deps: { db: Db; settings: Settings; redis: () => Redis | null },
  daysBack = 1,
): Promise<{ processed: number; errors: number }> {
  const activeUsers = await deps.db.select().from(users).where(eq(users.status, "active"));
  let processed = 0;
  let errors = 0;
  for (const user of activeUsers) {
    const run: Record<string, unknown> = { at: new Date().toISOString().replace("Z", "+00:00"), ok: true };
    try {
      const journal = await runDreamingPipeline(deps.db, deps.settings, deps.redis(), user, { daysBack, skipIfEmpty: true });
      processed++;
      if (!journal) {
        run.skipped = "no_material";
      } else {
        const m = journal.stageMetrics && typeof journal.stageMetrics === "object" ? (journal.stageMetrics as Record<string, unknown>) : {};
        run.promoted = m.promoted_count ?? 0;
      }
    } catch (e) {
      const err = e as Error;
      errors++;
      run.ok = false;
      run.error = `${err?.name || "Error"}: ${err?.message || String(e)}`.slice(0, 300);
    }
    try {
      const [, st] = await buildProfileDraft(deps.db, deps.settings, deps.redis(), user);
      run.profile_status = st;
    } catch (e) {
      const err = e as Error;
      run.profile_status = "error";
      run.profile_error = `${err?.name || "Error"}: ${err?.message || String(e)}`.slice(0, 300);
    }
    await aiHealth.putJson(deps.redis(), `dreaming:${user.id}`, run);
    const problems: string[] = [];
    if (!run.ok) problems.push(`做梦失败：${run.error ?? ""}`);
    if (run.profile_status === "llm_failed" || run.profile_status === "error") {
      problems.push(`画像草稿生成失败：${run.profile_error || "AI 没有返回可用内容"}`);
    }
    if (problems.length) {
      await notifyUser(deps, user.id, "health", "Memento 夜间任务出错", problems.join("\n").slice(0, 500), { url: "/profile?tab=health" });
    }
    if (run.ok && Number(run.promoted ?? 0) > 0) {
      const now = new Date(Date.now() + 8 * 3600_000);
      const todayStr = `${String(now.getUTCMonth() + 1).padStart(2, "0")}月${String(now.getUTCDate()).padStart(2, "0")}日`;
      await notifyUser(
        deps,
        user.id,
        "briefing",
        `🧠 Memento 心智晨报 · ${todayStr}`,
        `昨夜心智深度做梦提炼完成：固化沉淀了 ${run.promoted} 条高价值业务记忆，个人画像已自进化更新。`,
        { url: "/memory?tab=dreams" },
      ).catch(() => {});
    }
  }
  return { processed, errors };
}

export async function bootstrapMemoriesFromKnowledgeGraph(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
) {
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const canonicalProjects = await extractCanonicalProjects(db, user);
  const techs = (await db.execute(sql`
    SELECT ke.name, ke.entity_type, ke.summary, count(ko.id)::int AS cnt
    FROM knowledge_entities ke
    LEFT JOIN knowledge_observations ko ON ko.entity_id = ke.id
    WHERE ke.user_id = ${user.id}::uuid AND ke.entity_type IN ('technology', 'tool')
    GROUP BY ke.id
    ORDER BY count(ko.id) DESC LIMIT 20
  `)) as unknown as { name: string; entity_type: string; summary: string | null; cnt: number }[];
  const obs = (await db.execute(sql`
    SELECT ko.content FROM knowledge_observations ko
    JOIN knowledge_entities ke ON ke.id = ko.entity_id
    WHERE ke.user_id = ${user.id}::uuid AND length(ko.content) >= 15
    ORDER BY ko.observed_at DESC LIMIT 40
  `)) as unknown as { content: string }[];

  const memoriesToPersist: { category: string; key: string; content: string; confidence: number; tree_path: string }[] = [];
  let summaryText = "启发式多维度规则自举：按项目、架构设计、开发规范、工具生态与个人习惯分层梳理记忆树。";

  if (getAiProviders(settings, { background: true, user }).length && (canonicalProjects.length || techs.length || obs.length)) {
    const prompt =
      "根据用户历史核心项目、技术栈与观察事实，输出五大维度记忆树 JSON：{\"summary\": \"...\", \"memories\": [{\"category\": \"project|architecture|rule|tools|preference\", \"tree_path\": \"/...\", \"key\": \"...\", \"content\": \"...\", \"confidence\": 0.95}]}\n\n" +
      "### 项目\n" +
      (canonicalProjects.map((p) => `- ${p.slug} (${p.title}): ${p.summary}`).join("\n") || "(无)") +
      "\n\n### 技术栈\n" +
      (techs.filter((t) => t.summary).map((t) => `- [${t.entity_type}] ${t.name}: ${t.summary!.slice(0, 140)}`).join("\n") || "(无)") +
      "\n\n### 观察\n" +
      (obs.map((o) => `- ${o.content.slice(0, 180)}`).join("\n") || "(无)");
    try {
      const raw = await callPlainChat(
        settings,
        redis,
        [
          { role: "system", content: "You are the Memento Multi-Dimensional Memory Kernel. Output valid JSON only." },
          { role: "user", content: prompt },
        ],
        { maxTokens: 4096, background: true, user },
      );
      const parsed = raw ? safeJsonLoads(raw) : {};
      if (Array.isArray(parsed.memories) && parsed.memories.length) {
        summaryText = String(parsed.summary || summaryText);
        for (const item of parsed.memories as Record<string, unknown>[]) {
          const cat = String(item.category ?? "general").trim().toLowerCase();
          const key = String(item.key ?? "note").trim().toLowerCase().replaceAll(" ", "_");
          const content = String(item.content ?? "").trim();
          const confidence = Number(item.confidence ?? 0.92);
          const treePath = String(item.tree_path ?? `/${cat}/${key}`).trim();
          if (content && confidence >= 0.7) memoriesToPersist.push({ category: cat, key, content, confidence, tree_path: treePath });
        }
      }
    } catch {
      /* heuristic fallback */
    }
  }

  if (!memoriesToPersist.length) {
    for (const p of canonicalProjects) {
      memoriesToPersist.push({
        category: "project",
        key: `proj_${p.slug}_overview`,
        content: `【${p.title}】${p.summary}`,
        confidence: 0.92,
        tree_path: `/project/${p.slug}/overview`,
      });
    }
  }

  let promotedCount = 0;
  const details: string[] = [];
  for (const item of memoriesToPersist) {
    const [existing] = await db
      .select()
      .from(userMemories)
      .where(and(eq(userMemories.userId, user.id), eq(userMemories.category, item.category), eq(userMemories.key, item.key)))
      .limit(1);
    if (existing) {
      if (existing.source === "manual" || existing.status === "superseded") continue;
      await db
        .update(userMemories)
        .set({
          status: existing.status === "dormant" ? "active" : existing.status,
          statusReason: existing.status === "dormant" ? null : existing.statusReason,
          content: item.content,
          confidence: Math.max(existing.confidence, item.confidence),
          source: "bootstrap",
          treePath: item.tree_path,
          updatedAt: nowIso,
        })
        .where(eq(userMemories.id, existing.id));
      details.push(`- 🔄 更新【${item.tree_path}】: ${item.content}`);
    } else {
      await db.insert(userMemories).values({
        id: randomUUID(),
        userId: user.id,
        category: item.category,
        key: item.key,
        content: item.content,
        confidence: item.confidence,
        source: "bootstrap",
        treePath: item.tree_path,
        isFolder: false,
        recallCount: 0,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      details.push(`- 🌟 新增【${item.tree_path}】: ${item.content}`);
    }
    promotedCount++;
  }

  const report = `# 🌌 全量知识图谱冷启动自举报告 (Knowledge Bootstrap)\n\n自举时间: ${nowIso.replace("T", " ").slice(0, 19)} UTC\n晋升记忆数量: ${promotedCount}\n\n## 📋 自举总结\n${summaryText}\n\n## 🌟 沉淀的长期核心记忆\n${details.join("\n")}`;
  const [journal] = await db
    .insert(dreamJournals)
    .values({
      id: randomUUID(),
      userId: user.id,
      dreamDate: today,
      stageMetrics: { tag: "bootstrap", projects_scanned: canonicalProjects.length, tech_scanned: techs.length, observations_scanned: obs.length, promoted_count: promotedCount },
      lightSleepNotes: `扫描历史库中 ${canonicalProjects.length} 个核心项目、${techs.length} 个技术工具实体及 ${obs.length} 条深度观察事实。`,
      remReflections: summaryText,
      deepConsolidations: `完成全局认知记忆自举，确立 ${promotedCount} 条高置信度长时核心记忆。`,
      reportMarkdown: report,
      createdAt: nowIso,
    })
    .returning();
  return { status: "success", summary: summaryText, promoted_count: promotedCount, journal_id: journal!.id, memories: memoriesToPersist };
}
