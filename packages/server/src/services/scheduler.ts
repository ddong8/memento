// All 21 scheduled jobs (replacing Celery Beat + Celery Workers in server/server/tasks/celery_app.py).
// Uses croner (Asia/Shanghai timezone) + cluster.holdLease so only one replica runs each tick,
// and in single-process desktop mode (no Redis) runs locally without locks.
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { Cron } from "croner";
import { and, asc, desc, eq, inArray, isNull, lt, notLike, or, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { Settings } from "../config";
import type { Db } from "../db/client";
import {
  accessLogs,
  conversationMessages,
  dailySummaries,
  deviceTasks,
  documents,
  documentSearch,
  evalRuns,
  todos,
  users,
} from "../db/pulled/schema";
import { generateDailySummaryFromDigests } from "./ai-summary";
import * as aiHealth from "./ai-health";
import { cluster } from "./cluster";
import { mergeDue } from "./content-staging";
import { learnFromCorrections, summarizeNewTopics } from "./correction-service";
import { runAllUsersNightlyDreaming } from "./dreaming-service";
import { embedPendingDocuments } from "./embedding";
import { buildSet, needsNewSet, NoMaterial, recentRuns, regression as evalRegression, runEval } from "./eval-service";
import { extractKnowledgeFromDocument } from "./graph-service";
import { aiFailing, topReasons } from "./health-service";
import {
  extractLatestAiTitle,
  isJunkOrUuidTitle,
  parentSessionIdFromContent,
  safeDecodePbtxtString,
  titleFromUserMessages,
} from "./ingest-service";
import * as learningEval from "./learning-eval-service";
import { runCompaction } from "./memory-compaction";
import { reconcile, sweepDormant } from "./memory-lifecycle";
import { backfillMemoryVectors } from "./memory-vectors";
import { auditDue } from "./message-audit";
import { notifyUser } from "./notify";
import { CHAT_MESSAGE_SQL } from "./pulse";
import { learnFromTasks, reviewSessions } from "./retrospective-service";
import { uploadBytes } from "./storage";
import { dueNow, learnTodos, reminderText } from "./todos";
import { tokenizeForIndex } from "./tokenize";
import { userMachineIds } from "./visibility";

export interface SchedulerDeps {
  db: Db;
  settings: Settings;
  redis: () => Redis | null;
}

export interface JobSpec {
  name: string;
  cron: string;
  leaseSeconds: number;
  run: (deps: SchedulerDeps) => Promise<unknown>;
}

const PUSH_COOLDOWN = 3600;
const HEALTH_ALERT_COOLDOWN = 6 * 3600;
const BALANCE_ALERT_COOLDOWN = 24 * 3600;
const EVAL_EVERY_MS = (6 * 24 + 12) * 3600_000;
const TZ = "Asia/Shanghai";

async function activeUsers(db: Db) {
  return db.select().from(users).where(eq(users.status, "active"));
}

// 1 & 2) daily-digest (23:30) and daily-digest-late (03:30, offsetDays=-1)
export async function runDailyDigest(deps: SchedulerDeps, offsetDays = 0): Promise<Record<string, unknown>> {
  const cstNow = new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000);
  const dateStr = cstNow.toISOString().slice(0, 10);
  const dayStart = `${dateStr}T00:00:00+08:00`;
  const nextDate = new Date(Date.parse(`${dateStr}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  const dayEnd = `${nextDate}T00:00:00+08:00`;

  const allUsers = await activeUsers(deps.db);
  let generated = 0;
  for (const user of allUsers) {
    const mids = await userMachineIds(deps.db, user, deps.settings);
    const msgs = await deps.db
      .select({
        documentId: conversationMessages.documentId,
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .innerJoin(documents, eq(conversationMessages.documentId, documents.id))
      .where(
        and(
          sql`${conversationMessages.timestamp} >= ${dayStart}::timestamptz`,
          sql`${conversationMessages.timestamp} < ${dayEnd}::timestamptz`,
          CHAT_MESSAGE_SQL,
          notLike(documents.relativePath, "%/subagents/%"),
          mids !== null ? (mids.length ? inArray(documents.machineId, mids) : sql`false`) : sql`true`,
        ),
      )
      .orderBy(asc(conversationMessages.timestamp));
    if (!msgs.length) continue;

    const byDoc = new Map<string, typeof msgs>();
    for (const m of msgs) {
      const list = byDoc.get(m.documentId) ?? [];
      list.push(m);
      byDoc.set(m.documentId, list);
    }
    const docIds = [...byDoc.keys()];
    const docRows = await deps.db
      .select({ id: documents.id, toolId: documents.toolId, title: documents.title })
      .from(documents)
      .where(inArray(documents.id, docIds));
    const docMap = new Map(docRows.map((d) => [d.id, d]));

    const convData = [];
    const toolCounts: Record<string, number> = {};
    for (const [docId, list] of byDoc.entries()) {
      const d = docMap.get(docId);
      const toolId = d?.toolId ?? "unknown";
      toolCounts[toolId] = (toolCounts[toolId] ?? 0) + 1;
      const parts = list
        .map((m) => {
          const text = (m.content || "").slice(0, 800);
          return text ? `${m.role === "user" ? "👤 用户" : "🤖 AI"}: ${text}` : "";
        })
        .filter(Boolean);
      convData.push({ tool_id: toolId, title: d?.title || docId, digest: parts.join("\n") });
    }

    const [existing] = await deps.db
      .select()
      .from(dailySummaries)
      .where(and(eq(dailySummaries.summaryDate, dateStr), isNull(dailySummaries.toolId), eq(dailySummaries.userId, user.id)))
      .limit(1);

    const summaryText = await generateDailySummaryFromDigests(deps.settings, deps.redis(), dateStr, convData, {
      user,
      requireComplete: Boolean(existing),
    });
    if (!summaryText) continue;

    const srcIds = docRows.slice(0, 100).map((d) => d.id);
    if (existing) {
      await deps.db
        .update(dailySummaries)
        .set({ title: `AI 日报 - ${dateStr}`, summary: summaryText, highlights: { tool_counts: toolCounts }, sourceDocumentIds: srcIds })
        .where(eq(dailySummaries.id, existing.id));
    } else {
      await deps.db.insert(dailySummaries).values({
        id: randomUUID(),
        userId: user.id,
        summaryDate: dateStr,
        toolId: null,
        title: `AI 日报 - ${dateStr}`,
        summary: summaryText,
        highlights: { tool_counts: toolCounts },
        sourceDocumentIds: srcIds,
      });
    }
    generated++;
  }
  return { date: dateStr, generated };
}

// 7) knowledge-retry (2,17,32,47 * * * *)
export async function runKnowledgeRetry(deps: SchedulerDeps): Promise<Record<string, number>> {
  const docs = await deps.db
    .select()
    .from(documents)
    .where(and(inArray(documents.knowledgeStatus, ["failed", "pending"]), lt(documents.knowledgeAttempts, 5)))
    .limit(8);
  let retried = 0;
  let recovered = 0;
  for (const doc of docs) {
    try {
      const n = await extractKnowledgeFromDocument(deps.db, deps.settings, deps.redis(), doc);
      retried++;
      if (n > 0) recovered++;
    } catch {
      /* continue */
    }
  }
  return { scanned: docs.length, retried, recovered };
}

// 8) weekly-db-backup (30 3 * * 0)
export async function runWeeklyBackup(deps: SchedulerDeps): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `backups/weekly/${today}.json.gz`;
  const tables = (await deps.db.execute(sql`
    SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `)) as unknown as { name: string }[];
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
    const rows = (await deps.db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${name}"`))) as unknown as { n: number }[];
    counts[name] = Number(rows[0]?.n ?? 0);
  }
  const manifest = gzipSync(Buffer.from(JSON.stringify({ generated_at: new Date().toISOString(), counts }), "utf8"));
  await uploadBytes(deps.settings, key, manifest, "application/gzip");
  return { ok: true, key, tables: Object.keys(counts).length, counts };
}

// 9) title-backfill (7 * * * *)
export async function runTitleBackfill(deps: SchedulerDeps): Promise<{ scanned: number; healed: number }> {
  let scanned = 0;
  let healed = 0;
  let lastId: string | null = null;
  const recentSince = new Date(Date.now() - 3 * 3600_000).toISOString();

  while (true) {
    const rows = await deps.db
      .select({ id: documents.id, title: documents.title, metadata: documents.metadata, relativePath: documents.relativePath, updatedAt: documents.updatedAt })
      .from(documents)
      .where(lastId ? sql`${documents.id} > ${lastId}::uuid` : sql`true`)
      .orderBy(asc(documents.id))
      .limit(200);
    if (!rows.length) break;

    for (const r of rows) {
      lastId = r.id;
      const recent = Boolean(r.updatedAt && r.updatedAt >= recentSince);
      const meta = r.metadata && typeof r.metadata === "object" ? { ...(r.metadata as Record<string, unknown>) } : {};
      let sid = typeof meta.session_id === "string" ? meta.session_id : null;
      let cand: string | null = null;

      let parentSid = typeof meta.parent_session_id === "string" ? meta.parent_session_id : null;
      if (!parentSid && recent && (r.relativePath.includes("agent-") || r.relativePath.includes("rollout-"))) {
        const [cRow] = await deps.db.select({ content: documents.content }).from(documents).where(eq(documents.id, r.id)).limit(1);
        if (cRow?.content) parentSid = parentSessionIdFromContent(cRow.content);
      }
      if (parentSid) {
        const [pRow] = await deps.db
          .select({ title: documents.title })
          .from(documents)
          .where(or(sql`${documents.metadata}->>'session_id' = ${parentSid}`, sql`${documents.relativePath} LIKE ${`%${parentSid}%`}`))
          .limit(1);
        if (pRow?.title && !isJunkOrUuidTitle(pRow.title, parentSid)) {
          cand = r.relativePath.includes("rollout-") ? `审核: ${pRow.title}` : pRow.title;
        }
      }
      if ((!sid || sid === "transcript") && r.relativePath.includes("brain/")) {
        const bm = /brain\/([0-9a-fA-F-]+)\//.exec(r.relativePath);
        if (bm) {
          sid = bm[1]!;
          meta.session_id = sid;
          await deps.db.update(documents).set({ metadata: meta }).where(eq(documents.id, r.id));
        }
      }
      if (!cand && recent && r.relativePath.includes("projects/") && r.relativePath.endsWith(".jsonl") && !parentSid) {
        const [cRow] = await deps.db.select({ content: documents.content }).from(documents).where(eq(documents.id, r.id)).limit(1);
        const aiCand = extractLatestAiTitle(cRow?.content);
        if (aiCand && !isJunkOrUuidTitle(aiCand, sid)) cand = aiCand;
      }
      if (!cand && r.relativePath.includes("antigravity") && (r.relativePath.includes("brain/") || r.relativePath.includes("conversations/"))) {
        const mTitle = typeof meta.title === "string" ? meta.title.trim() : "";
        if (mTitle && !isJunkOrUuidTitle(mTitle, sid)) cand = mTitle;
        if (!cand && sid) {
          const [ann] = await deps.db
            .select({ title: documents.title, content: documents.content })
            .from(documents)
            .where(and(eq(documents.toolId, "antigravity"), eq(documents.category, "state"), sql`${documents.relativePath} LIKE ${`%annotations/${sid}.pbtxt`}`))
            .limit(1);
          if (ann) {
            let ca = ann.title || "";
            if (!ca && ann.content) {
              const mm = /title:\s*"([^"]+)"/.exec(ann.content);
              if (mm) ca = mm[1]!.trim();
            }
            if (ca && !ca.includes("(.*?)") && !ca.endsWith(".pbtxt")) {
              if (ca.includes("\\")) ca = safeDecodePbtxtString(ca);
              if (!isJunkOrUuidTitle(ca, sid)) cand = ca;
            }
          }
        }
      }
      if (!cand && !isJunkOrUuidTitle(r.title, sid)) continue;
      scanned++;
      if (!cand) {
        const nameCand = String(meta.name || meta.title || meta.first_user_message || "").trim();
        if (nameCand) cand = titleFromUserMessages([nameCand], sid);
      }
      if (!cand) {
        const msgs = await deps.db
          .select({ content: conversationMessages.content })
          .from(conversationMessages)
          .where(and(eq(conversationMessages.documentId, r.id), eq(conversationMessages.role, "user")))
          .orderBy(asc(conversationMessages.lineNumber))
          .limit(8);
        cand = titleFromUserMessages(msgs.map((m) => m.content), sid);
      }
      if (cand && cand !== r.title) {
        await deps.db.update(documents).set({ title: cand }).where(eq(documents.id, r.id));
        healed++;
      }
    }
  }
  return { scanned, healed };
}

// 10) health-check (5,35 * * * *)
export async function runHealthCheck(deps: SchedulerDeps): Promise<{ alerted: number; balance_alerted: number }> {
  const r = deps.redis();
  const admins = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, ["owner", "admin"])));

  let alerted = 0;
  const lastHour = await aiHealth.summary(r, 1);
  if (aiFailing(lastHour) && (await aiHealth.claimAlert(r, "ai_failing", HEALTH_ALERT_COOLDOWN))) {
    const reasons = topReasons(lastHour);
    const body = `最近 1 小时 ${lastHour.calls.failed}/${lastHour.calls.total} 次 AI 调用失败${reasons ? `，主要原因：${reasons}` : ""}。在 Memento「设备 → 系统健康」查看详情。`;
    for (const a of admins) {
      if (await notifyUser(deps, a.id, "health", "Memento AI 调用异常", body, { url: "/profile?tab=health" })) alerted++;
    }
  }

  let balanceAlerted = 0;
  const base = (process.env.MEMENTO_AI_BASE_URL || "").replace(/\/+$/, "");
  const key = (process.env.MEMENTO_AI_API_KEY || "").trim();
  const threshold = Number(process.env.MEMENTO_AI_BALANCE_ALERT || "10") || 10;
  if (key && base.includes("api.deepseek.com")) {
    try {
      const resp = await fetch(`${base}/user/balance`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        const data = (await resp.json()) as { balance_infos?: { total_balance?: string; currency?: string }[] };
        const info = data.balance_infos?.[0];
        if (info) {
          const bal = Number(info.total_balance ?? 0);
          if (bal < threshold && (await aiHealth.claimAlert(r, "ai_balance_low", BALANCE_ALERT_COOLDOWN))) {
            const body = `DeepSeek 账户余额只剩 ${bal.toFixed(2)} ${info.currency || ""}（提醒线 ${threshold}），用完后问答、知识抽取、摘要都会失败，请尽快充值。`;
            for (const a of admins) {
              if (await notifyUser(deps, a.id, "health", "Memento AI 余额不足", body, { url: "/profile?tab=health" })) balanceAlerted++;
            }
          }
        }
      }
    } catch {
      /* non-fatal */
    }
  }
  return { alerted, balance_alerted: balanceAlerted };
}

// 11) audit-retention (20 4 * * *)
export async function runAuditRetention(deps: SchedulerDeps) {
  const days = deps.settings.auditRetentionDays;
  if (!days || days <= 0) return { kept: "all" };
  const cutoffIso = new Date(Date.now() - days * 86400_000).toISOString();
  const removed = (await deps.db.delete(accessLogs).where(lt(accessLogs.createdAt, cutoffIso)).returning({ id: accessLogs.id })).length;
  return { removed, days };
}

// 12) close-stale-tasks (9,19,29,39,49,59 * * * *)
export async function runCloseStaleTasks(deps: SchedulerDeps) {
  const nowMs = Date.now();
  const graceMs = 3600_000;
  const openEndedMs = 24 * 3600_000;
  const cutoffIso = new Date(nowMs - graceMs).toISOString();
  const openTasks = await deps.db
    .select()
    .from(deviceTasks)
    .where(and(inArray(deviceTasks.status, ["queued", "running", "still_running"]), isNull(deviceTasks.finishedAt), lt(deviceTasks.createdAt, cutoffIso)));
  let closed = 0;
  const nowIso = new Date(nowMs).toISOString();
  for (const t of openTasks) {
    const createdMs = Date.parse(t.createdAt.includes("T") ? t.createdAt : t.createdAt.replace(" ", "T"));
    let reason: string | null = null;
    if (t.status === "queued" && nowMs - createdMs > openEndedMs) {
      reason = "设备一直没有领取这个任务（超过 24 小时），已由服务端结束";
    } else if (t.status === "still_running" && nowMs - createdMs > openEndedMs) {
      reason = "后台任务超过 24 小时没有新的回报，已由服务端结束跟踪";
    } else if (t.status === "running") {
      const startedRaw = t.dispatchedAt || t.createdAt;
      const startedMs = Date.parse(startedRaw.includes("T") ? startedRaw : startedRaw.replace(" ", "T"));
      const budgetMs = t.timeoutSeconds && t.timeoutSeconds > 0 ? t.timeoutSeconds * 1000 : openEndedMs;
      if (nowMs - startedMs > budgetMs + graceMs) {
        reason = "超过超时时间仍未收到设备回报（设备可能已离线或重启），已由服务端结束";
      }
    }
    if (!reason) continue;
    await deps.db
      .update(deviceTasks)
      .set({ status: "timeout", error: t.error ? `${t.error}\n${reason}` : reason, finishedAt: nowIso })
      .where(eq(deviceTasks.id, t.id));
    closed++;
  }
  return { open: openTasks.length, closed };
}

// 13) learn-corrections (*/10 * * * *)
export async function runLearnCorrections(deps: SchedulerDeps) {
  const allUsers = await activeUsers(deps.db);
  const totals = { events: 0, new_topics: 0 };
  for (const user of allUsers) {
    try {
      const res = await learnFromCorrections(deps.db, deps.settings, deps.redis(), user);
      totals.events += res.events;
      totals.new_topics += res.new_topics.length;
      if (res.auto_accepted.length && (await aiHealth.claimAlert(deps.redis(), `learned:auto:${user.id}`, PUSH_COOLDOWN))) {
        await notifyUser(
          deps,
          user.id,
          "learning",
          "Memento 已即时采纳新铁律",
          `${summarizeNewTopics(res.auto_accepted)}。该规则已自动同步写入常驻画像，后续所有交互和终端已即时生效。`,
        );
      } else if (res.new_topics.length && (await aiHealth.claimAlert(deps.redis(), `learned:${user.id}`, PUSH_COOLDOWN))) {
        const verb = res.backfill ? "从最近 30 天里找到" : "刚学到";
        await notifyUser(
          deps,
          user.id,
          "learning",
          `Memento ${verb}新的规矩`,
          `${summarizeNewTopics(res.new_topics)}。到「个人设置 → 常驻画像」确认后，各个 AI 工具下次同步就会用上。`,
        );
      }
    } catch {
      /* per-user isolate */
    }
  }
  return totals;
}

// 14) learn-todos (4,14,24,34,44,54 * * * *)
export async function runLearnTodos(deps: SchedulerDeps) {
  const allUsers = await activeUsers(deps.db);
  const totals = { created: 0, closed: 0 };
  for (const user of allUsers) {
    try {
      const res = await learnTodos(deps.db, deps.settings, deps.redis(), user);
      totals.created += res.created.length;
      totals.closed += res.closed;
    } catch {
      /* isolate */
    }
  }
  return totals;
}

// 15) review-sessions (20 2 * * *)
export async function runReviewSessions(deps: SchedulerDeps) {
  const allUsers = await activeUsers(deps.db);
  const out: Record<string, unknown> = {};
  for (const user of allUsers) {
    const run: Record<string, unknown> = { at: new Date().toISOString().replace("Z", "+00:00") };
    let sessions: Record<string, unknown>;
    try {
      sessions = await reviewSessions(deps.db, deps.settings, deps.redis(), user);
    } catch (e) {
      sessions = { error: ((e as Error).message || String(e)).slice(0, 200) };
    }
    let tasks: Record<string, unknown>;
    try {
      tasks = await learnFromTasks(deps.db, deps.settings, deps.redis(), user);
    } catch (e) {
      tasks = { error: ((e as Error).message || String(e)).slice(0, 200) };
    }
    run.sessions = sessions;
    run.tasks = tasks;
    await aiHealth.putJson(deps.redis(), `review_run:${user.id}`, run);
    const parts: string[] = [];
    const sNew = Array.isArray(sessions.skills_new) ? (sessions.skills_new as string[]) : [];
    if (sNew.length) parts.push(`${sNew.length} 个新技能待确认（${sNew.slice(0, 3).join("、")}）`);
    if (Number(sessions.skill_updates ?? 0) > 0) parts.push(`${sessions.skill_updates} 个技能有改进`);
    const pitfalls = Number(sessions.pitfalls_new ?? 0) + Number(tasks.pitfalls_new ?? 0);
    if (pitfalls > 0) parts.push(`记下 ${pitfalls} 个踩过的坑`);
    if (Number(sessions.todos_new ?? 0) > 0) parts.push(`${sessions.todos_new} 条没做完的事进了待办`);
    if (parts.length) {
      const base = (deps.settings.publicUrl || "").replace(/\/+$/, "");
      const url = base ? `${base}/memory?tab=skills` : "/memory?tab=skills";
      await notifyUser(deps, user.id, "learning", "Memento 昨晚的复盘", `复盘了 ${sessions.reviewed ?? 0} 个会话：${parts.join("；")}。到「记忆库 → 技能」确认。`, { url });
    }
    out[user.id] = run;
  }
  return out;
}

// 16) memory-lifecycle (10 4 * * *)
export async function runMemoryLifecycle(deps: SchedulerDeps) {
  const allUsers = await activeUsers(deps.db);
  const out: Record<string, unknown> = {};
  for (const user of allUsers) {
    const cursorKey = `reconcile_cursor:${user.id}`;
    const cursor = await aiHealth.getJson<string>(deps.redis(), cursorKey);
    const startedMs = Date.now();
    const sinceMs = cursor ? Date.parse(cursor) : null;
    let reconciled: unknown;
    try {
      reconciled = await reconcile(deps.db, deps.settings, deps.redis(), user, Number.isFinite(sinceMs) ? sinceMs : null);
      await aiHealth.putJson(deps.redis(), cursorKey, new Date(startedMs).toISOString(), 90 * 86400);
    } catch (e) {
      reconciled = { error: ((e as Error).message || String(e)).slice(0, 200) };
    }
    let dormant: unknown;
    try {
      dormant = await sweepDormant(deps.db, user);
    } catch (e) {
      dormant = { error: ((e as Error).message || String(e)).slice(0, 200) };
    }
    const run = { at: new Date(startedMs).toISOString().replace("Z", "+00:00"), reconcile: reconciled, dormant };
    await aiHealth.putJson(deps.redis(), `lifecycle_run:${user.id}`, run);
    out[user.id] = run;
  }
  return out;
}

// 18) remind-todos (5 9 * * *)
export async function runRemindTodos(deps: SchedulerDeps) {
  const allUsers = await activeUsers(deps.db);
  const nowIso = new Date().toISOString();
  let sent = 0;
  for (const user of allUsers) {
    const due = await dueNow(deps.db, user.id);
    const text = reminderText(due);
    const base = (deps.settings.publicUrl || "").replace(/\/+$/, "");
    const url = base ? `${base}/daily` : "/daily";
    if (text && (await notifyUser(deps, user.id, "todo", text[0], `${text[1]}\n打开「日报待办」查看。`, { url }))) {
      sent++;
      const ids = [...due.overdue, ...due.today].map((t) => t.id);
      if (ids.length) await deps.db.update(todos).set({ remindedAt: nowIso }).where(inArray(todos.id, ids));
    }
  }
  return { sent };
}

// 19) tsvector-backfill (25 4 * * *)
export async function runTsvectorBackfill(deps: SchedulerDeps) {
  let total = 0;
  let updated = 0;
  while (true) {
    const rows = (await deps.db.execute(sql`
      SELECT d.id, d.title, substr(d.content, 1, 200000) AS content
      FROM documents d
      LEFT JOIN document_search ds ON ds.document_id = d.id
      WHERE ds.document_id IS NULL
      LIMIT 100
    `)) as unknown as { id: string; title: string | null; content: string | null }[];
    if (!rows.length) break;
    for (const r of rows) {
      total++;
      const tsvInput = tokenizeForIndex(`${r.title || ""} ${r.content || ""}`);
      await deps.db
        .insert(documentSearch)
        .values({ documentId: String(r.id), contentTsv: sql`to_tsvector('simple', ${tsvInput})` as unknown as string })
        .onConflictDoNothing({ target: documentSearch.documentId });
      updated++;
    }
  }
  return { scanned: total, updated };
}

// 20) evaluate-retrieval (40 4 * * *)
export async function runEvaluateRetrieval(deps: SchedulerDeps) {
  const nowMs = Date.now();
  const out: Record<string, unknown> = {};
  for (const user of await activeUsers(deps.db)) {
    const [last] = await deps.db
      .select({ createdAt: evalRuns.createdAt })
      .from(evalRuns)
      .where(and(eq(evalRuns.userId, user.id), eq(evalRuns.trigger, "scheduled")))
      .orderBy(desc(evalRuns.createdAt))
      .limit(1);
    if (last?.createdAt) {
      const ms = Date.parse(last.createdAt.includes("T") ? last.createdAt : last.createdAt.replace(" ", "T"));
      if (Number.isFinite(ms) && nowMs - ms < EVAL_EVERY_MS) {
        out[user.id] = { skipped: "ran this week" };
        continue;
      }
    }
    try {
      let run = await runEval(deps.db, deps.settings, deps.redis(), user, "scheduled");
      if (needsNewSet(run)) {
        const ver = (await buildSet(deps.db, deps.settings, deps.redis(), user)).set_version;
        run = await runEval(deps.db, deps.settings, deps.redis(), user, "scheduled", ver);
      }
      out[user.id] = { set_version: run.setVersion, hybrid: (run.metrics as Record<string, unknown>)?.hybrid };
      const drop = evalRegression(await recentRuns(deps.db, user, 6));
      if (drop) {
        const was = Number(drop.was);
        const nowV = Number(drop.now);
        const change =
          drop.metric === "hit5"
            ? `前 5 命中率从最好时的 ${Math.round(was * 100)}% 降到 ${Math.round(nowV * 100)}%`
            : `MRR 从最好时的 ${was.toFixed(2)} 降到 ${nowV.toFixed(2)}`;
        await notifyUser(deps, user.id, "health", "Memento 检索变差了", `评测集 v${drop.set_version} ${change}，到「系统健康」查看。`);
      }
    } catch (e) {
      if (e instanceof NoMaterial) {
        out[user.id] = { skipped: "no documents" };
      } else {
        const msg = ((e as Error).message || String(e)).slice(0, 200);
        out[user.id] = { error: msg };
        if (await aiHealth.claimAlert(deps.redis(), `eval_failed:${user.id}`, 6 * 86400)) {
          await notifyUser(deps, user.id, "health", "Memento 检索评测没跑成", `本周检索评测出错：${msg.slice(0, 120)}。明天凌晨会自动重跑，可到「系统健康」查看。`);
        }
      }
    }
  }
  return out;
}

// 21) evaluate-learning (50 4 * * 1)
export async function runEvaluateLearning(deps: SchedulerDeps) {
  const out: Record<string, unknown> = {};
  for (const user of await activeUsers(deps.db)) {
    try {
      const weeks = await learningEval.runLearningEval(deps.db, user);
      const drop = learningEval.regression(await learningEval.recentWeeks(deps.db, user, 6));
      out[user.id] = { weeks, regression: drop };
      if (drop && (await aiHealth.claimAlert(deps.redis(), `learning_eval:${user.id}:${drop.week}`, 30 * 86400))) {
        await notifyUser(deps, user.id, "health", "Memento 学过还犯变多了", `${learningEval.regressionText(drop)}到「系统健康」看是哪些规矩。`);
      }
    } catch (e) {
      out[user.id] = { error: ((e as Error).message || String(e)).slice(0, 200) };
    }
  }
  return out;
}

// Exact 21 scheduled jobs matching server/server/tasks/celery_app.py (Asia/Shanghai)
export const SCHEDULED_JOBS: JobSpec[] = [
  { name: "daily-digest", cron: "30 23 * * *", leaseSeconds: 600, run: (d) => runDailyDigest(d, 0) },
  { name: "daily-digest-late", cron: "30 3 * * *", leaseSeconds: 600, run: (d) => runDailyDigest(d, -1) },
  { name: "nightly-dreaming", cron: "0 3 * * *", leaseSeconds: 1800, run: (d) => runAllUsersNightlyDreaming(d, 1) },
  { name: "embedding-retry", cron: "* * * * *", leaseSeconds: 55, run: (d) => embedPendingDocuments(d.db, d.settings, 50) },
  { name: "merge-staged-deltas", cron: "* * * * *", leaseSeconds: 55, run: (d) => mergeDue(d.db, 50) },
  { name: "message-audit", cron: "3-58/5 * * * *", leaseSeconds: 240, run: (d) => auditDue(d.db, d.settings.messageAuditMode, d.redis(), 120) },
  { name: "knowledge-retry", cron: "2,17,32,47 * * * *", leaseSeconds: 600, run: runKnowledgeRetry },
  { name: "weekly-db-backup", cron: "30 3 * * 0", leaseSeconds: 1800, run: runWeeklyBackup },
  { name: "title-backfill", cron: "7 * * * *", leaseSeconds: 600, run: runTitleBackfill },
  { name: "health-check", cron: "5,35 * * * *", leaseSeconds: 300, run: runHealthCheck },
  { name: "audit-retention", cron: "20 4 * * *", leaseSeconds: 600, run: runAuditRetention },
  { name: "close-stale-tasks", cron: "9,19,29,39,49,59 * * * *", leaseSeconds: 300, run: runCloseStaleTasks },
  { name: "learn-corrections", cron: "*/10 * * * *", leaseSeconds: 500, run: runLearnCorrections },
  { name: "learn-todos", cron: "4,14,24,34,44,54 * * * *", leaseSeconds: 500, run: runLearnTodos },
  { name: "review-sessions", cron: "20 2 * * *", leaseSeconds: 2900, run: runReviewSessions },
  { name: "memory-lifecycle", cron: "10 4 * * *", leaseSeconds: 1700, run: runMemoryLifecycle },
  { name: "memory-compaction", cron: "15 4 * * *", leaseSeconds: 1200, run: (d) => runCompaction(d.db, d.settings, d.redis()) },
  { name: "memory-vectors", cron: "6,16,26,36,46,56 * * * *", leaseSeconds: 540, run: (d) => backfillMemoryVectors(d.db, d.settings, d.redis()) },
  { name: "remind-todos", cron: "5 9 * * *", leaseSeconds: 600, run: runRemindTodos },
  { name: "tsvector-backfill", cron: "25 4 * * *", leaseSeconds: 1700, run: runTsvectorBackfill },
  { name: "evaluate-retrieval", cron: "40 4 * * *", leaseSeconds: 1700, run: runEvaluateRetrieval },
  { name: "evaluate-learning", cron: "50 4 * * 1", leaseSeconds: 1700, run: runEvaluateLearning },
];

export class Scheduler {
  private tasks: Cron[] = [];
  private running = new Set<string>();

  start(deps: SchedulerDeps): void {
    if (!deps.settings.enableScheduler) return;
    if (this.tasks.length) return;
    for (const job of SCHEDULED_JOBS) {
      const cronTask = new Cron(job.cron, { timezone: TZ, protect: true }, () => {
        if (this.running.has(job.name)) return;
        this.running.add(job.name);
        void (async () => {
          const leaseKey = `sched:${job.name}`;
          const got = await cluster.holdLease(leaseKey, job.leaseSeconds);
          if (!got) return;
          try {
            await job.run(deps);
          } catch (e) {
            console.warn(`[scheduler] job ${job.name} failed:`, (e as Error).message);
          } finally {
            await cluster.releaseLease(leaseKey);
          }
        })().finally(() => {
          this.running.delete(job.name);
        });
      });
      this.tasks.push(cronTask);
    }
    console.log(`[scheduler] started ${this.tasks.length} cron jobs (${TZ})`);
  }

  stop(): void {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
  }
}

export const scheduler = new Scheduler();
