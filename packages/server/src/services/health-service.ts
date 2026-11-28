// System health overview for /api/health/overview & health-check alerts (server/server/services/health_service.py).
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { documents, dreamJournals, knowledgeEntities, machines, userProfiles } from "../db/pulled/schema";
import { pgToIso } from "../pytime";
import * as aiHealth from "./ai-health";
import { getAiProviders } from "./ai-provider";
import { correctionStats } from "./correction-service";
import { evalSummary } from "./eval-service";
import { outcomeSummary, regressionText } from "./learning-eval-service";
import { lifecycleCounts } from "./memory-lifecycle";
import { profileSaturation } from "./profile-read";
import { profileTargets } from "./profile-targets";
import { reviewStats } from "./retrospective-service";
import { skillCounts } from "./skills";
import { todoCounts } from "./todos";

const ONLINE_WINDOW_MS = 180_000;
const DREAM_STALE_MS = 30 * 3600_000;
const BACKLOG_WARN = 20;

export function aiFailing(lastHour: aiHealth.AiHealthSummary): boolean {
  const calls = lastHour.calls;
  return calls.failed >= 3 && calls.failed / Math.max(calls.total, 1) >= 0.2;
}

export function topReasons(stats: aiHealth.AiHealthSummary, n = 2): string {
  return (stats.reasons || [])
    .filter((r) => !aiHealth.RETRY_REASONS.has(r.reason))
    .slice(0, n)
    .map((r) => r.label)
    .join("、");
}

function parseTs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = raw.includes("T") ? raw : raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

export function assess(
  ai: aiHealth.AiHealthSummary,
  lastHour: aiHealth.AiHealthSummary,
  dreaming: Record<string, unknown>,
  profile: Record<string, unknown>,
  pipeline: { embedding_failed: number; knowledge_failed: number },
  nowMs: number,
  learning?: Record<string, unknown> | null,
  evolution?: Record<string, unknown> | null,
): { level: string; area: string; text: string }[] {
  const issues: { level: string; area: string; text: string }[] = [];
  const add = (level: string, area: string, text: string) => issues.push({ level, area, text });

  const calls = ai.calls;
  const reasons = topReasons(ai);
  if (ai.available === false) add("warn", "ai", "读不到 AI 调用统计（Redis 不可用）");
  if (aiFailing(lastHour)) {
    const lc = lastHour.calls;
    const r = topReasons(lastHour);
    add("error", "ai", `最近 1 小时 ${lc.failed}/${lc.total} 次 AI 调用失败${r ? `，主要原因：${r}` : ""}`);
  } else if (calls.failed >= 5 && calls.failed / Math.max(calls.total, 1) >= 0.05) {
    add("warn", "ai", `24 小时内 ${calls.failed} 次 AI 调用所有模型都没答上${reasons ? `，主要原因：${reasons}` : ""}`);
  }
  if (calls.fallback >= 5 && calls.fallback / Math.max(calls.total, 1) >= 0.3) {
    add("warn", "ai", `首选模型不稳定：24 小时内 ${calls.fallback} 次靠备用模型才完成`);
  }

  const lastRun = dreaming.last_run && typeof dreaming.last_run === "object" ? (dreaming.last_run as Record<string, unknown>) : null;
  if (lastRun && lastRun.ok === false) {
    add("error", "dreaming", `上次做梦失败：${String(lastRun.error ?? "未知错误")}`);
  }
  const journals = Array.isArray(dreaming.journals) ? (dreaming.journals as Record<string, unknown>[]) : [];
  const latest = journals[0] ?? null;
  const latestAtMs = latest && typeof latest.created_at === "string" ? parseTs(latest.created_at) : 0;
  const ranEmpty = Boolean(
    lastRun && lastRun.skipped === "no_material" && typeof lastRun.at === "string" && nowMs - parseTs(lastRun.at) <= DREAM_STALE_MS,
  );
  if (!ranEmpty && (!latestAtMs || nowMs - latestAtMs > DREAM_STALE_MS)) {
    add("warn", "dreaming", latestAtMs ? "超过 30 小时没有新的做梦记录" : "还没有做梦记录");
  }
  if (latest && (latest.llm === "failed" || latest.llm === "unparsed")) {
    add(
      "warn",
      "dreaming",
      `上次做梦没拿到模型的有效回答，当晚没有沉淀新记忆${latest.llm === "failed" ? "（模型没有回答）" : "（回答不是有效的 JSON）"}`,
    );
  }
  if (lastRun && (lastRun.profile_status === "llm_failed" || lastRun.profile_status === "error")) {
    add("warn", "profile", "夜间画像草稿生成失败");
  }

  const manual = profile.last_run && typeof profile.last_run === "object" ? (profile.last_run as Record<string, unknown>) : null;
  if (manual && (manual.status === "llm_failed" || manual.status === "error")) {
    add("warn", "profile", "上次手动生成画像失败");
  }
  const pDevices = Array.isArray(profile.devices) ? (profile.devices as Record<string, unknown>[]) : [];
  const broken = pDevices.filter((d) => Array.isArray(d.errors) && d.errors.length).map((d) => String(d.name));
  if (broken.length) {
    add("warn", "profile", `${broken.length} 台设备写入画像出错：${broken.slice(0, 3).join("、")}`);
  }
  const sat = profile.saturation && typeof profile.saturation === "object" ? (profile.saturation as Record<string, unknown>) : null;
  if (sat && Number(sat.ratio ?? 0) >= 0.95) {
    add(
      "warn",
      "profile",
      `常驻画像通用段已达 ${sat.general_chars}/${sat.general_limit} 字符（${Math.round(Number(sat.ratio) * 100)}%），新规矩将触发自动语义压缩或受限`,
    );
  }

  if (learning && Number(learning.learned_repeat_7d ?? 0) >= 2) {
    const stale = pDevices.filter((d) => !d.synced).map((d) => String(d.name));
    let why: string;
    if (!profile.published) why = "画像还没发布，规矩传不到 AI 那里";
    else if (!pDevices.length) why = "没有设备开启画像写入，规矩传不到 AI 那里";
    else if (stale.length) why = `${stale.length} 台设备的画像不是最新版本：${stale.slice(0, 3).join("、")}`;
    else why = "规矩已经写进画像、设备也都是最新版本，AI 读到了还是没照做";
    add("warn", "learning", `最近 7 天有 ${learning.learned_repeat_7d} 次纠正的是已经学会的规矩，${why}`);
  }

  if (evolution) {
    const run = evolution.review_run && typeof evolution.review_run === "object" ? (evolution.review_run as Record<string, unknown>) : {};
    for (const [part, label] of [
      ["sessions", "会话复盘"],
      ["tasks", "任务失败复盘"],
    ] as const) {
      const sub = run[part];
      const err = sub && typeof sub === "object" ? (sub as Record<string, unknown>).error : null;
      if (err) add("warn", "evolution", `上次${label}出错：${String(err).slice(0, 120)}`);
    }
    const reviews = (evolution.reviews as Record<string, unknown>) || {};
    if (Number(reviews.pitfall_repeats ?? 0) >= 3) {
      add(
        "warn",
        "evolution",
        `最近 7 天有 ${reviews.pitfall_repeats} 次又踩了已经记下的坑，AI 可能没在动手前查规矩（检查 MCP 是否接好）`,
      );
    }
    const evalObj = (evolution.eval as Record<string, unknown>) || {};
    const drop = evalObj.regression && typeof evalObj.regression === "object" ? (evalObj.regression as Record<string, unknown>) : null;
    if (drop) {
      const was = Number(drop.was);
      const nowV = Number(drop.now);
      const change =
        drop.metric === "hit5"
          ? `前 5 命中率从 ${Math.round(was * 100)}% 降到 ${Math.round(nowV * 100)}%`
          : `MRR 从 ${was.toFixed(2)} 降到 ${nowV.toFixed(2)}`;
      add("warn", "eval", `检索变差：评测集 v${drop.set_version} ${change}`);
    }
    const outcomesObj = (evolution.outcomes as Record<string, unknown>) || {};
    const worse =
      outcomesObj.regression && typeof outcomesObj.regression === "object" ? (outcomesObj.regression as Record<string, unknown>) : null;
    if (worse) add("warn", "learning", `学过还犯变多：${regressionText(worse)}`);
    const todosObj = (evolution.todos as Record<string, unknown>) || {};
    if (Number(todosObj.overdue ?? 0) >= 5) add("warn", "todo", `${todosObj.overdue} 条待办已经逾期`);
  }

  if (pipeline.knowledge_failed >= BACKLOG_WARN) {
    add("warn", "pipeline", `${pipeline.knowledge_failed} 篇文档知识图谱抽取失败，等待重试`);
  }
  if (pipeline.embedding_failed >= BACKLOG_WARN) {
    add("warn", "pipeline", `${pipeline.embedding_failed} 篇文档向量化失败，等待重试`);
  }

  issues.sort((a, b) => (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1));
  return issues;
}

async function getDreaming(db: Db, redis: Redis | null, user: UserRow) {
  const journals = await db
    .select()
    .from(dreamJournals)
    .where(eq(dreamJournals.userId, user.id))
    .orderBy(desc(dreamJournals.createdAt))
    .limit(7);
  const rows = journals.map((j) => {
    const m = j.stageMetrics && typeof j.stageMetrics === "object" ? (j.stageMetrics as Record<string, unknown>) : {};
    const voice = m.user_voice && typeof m.user_voice === "object" ? (m.user_voice as Record<string, unknown>) : {};
    return {
      date: String(j.dreamDate),
      created_at: pgToIso(j.createdAt),
      scanned: m.scanned_items ?? 0,
      promoted: m.promoted_count ?? 0,
      relations: m.relations_found ?? 0,
      voice: voice.kept ?? null,
      llm: m.llm ?? null,
    };
  });
  return { journals: rows, last_run: await aiHealth.getJson(redis, `dreaming:${user.id}`) };
}

async function getProfile(db: Db, redis: Redis | null, user: UserRow, nowMs: number) {
  const rows = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, user.id))
    .orderBy(desc(userProfiles.createdAt));
  const published =
    rows
      .filter((r) => r.status === "published")
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null;
  const draft = rows.find((r) => r.status === "draft") ?? null;

  const machineRows = await db
    .select()
    .from(machines)
    .where(and(eq(machines.userId, user.id), isNull(machines.mergedInto), eq(machines.isArchived, false)));
  const devices: Record<string, unknown>[] = [];
  for (const m of machineRows) {
    const targets = profileTargets(m);
    if (!targets.length) continue;
    const status = m.profileStatus && typeof m.profileStatus === "object" ? (m.profileStatus as Record<string, unknown>) : {};
    const results = status.results && typeof status.results === "object" ? (status.results as Record<string, unknown>) : {};
    const guards = status.guards && typeof status.guards === "object" ? (status.guards as Record<string, unknown>) : {};
    const guardResults = guards.results && typeof guards.results === "object" ? (guards.results as Record<string, unknown>) : {};
    const mcp = status.mcp && typeof status.mcp === "object" ? (status.mcp as Record<string, unknown>) : {};
    const mcpResults = mcp.results && typeof mcp.results === "object" ? (mcp.results as Record<string, unknown>) : {};
    const errors = [
      ...Object.entries(results)
        .filter(([, r]) => String(r).startsWith("error"))
        .map(([t]) => t),
      ...Object.entries(guardResults)
        .filter(([, r]) => String(r).startsWith("error"))
        .map(([t]) => `${t}（完成核查）`),
      ...Object.entries(mcpResults)
        .filter(([, r]) => String(r).startsWith("error"))
        .map(([t]) => `${t}（MCP 配置）`),
    ];
    const hbMs = parseTs(m.lastHeartbeat);
    devices.push({
      name: m.name,
      online: Boolean(hbMs && nowMs - hbMs < ONLINE_WINDOW_MS),
      targets,
      version: status.version ?? null,
      reported_at: status.reported_at ?? null,
      synced: published !== null && status.version === published.version,
      errors,
    });
  }

  const saturation = profileSaturation(published?.content);
  return {
    published: published
      ? { version: published.version, published_at: pgToIso(published.publishedAt || published.createdAt) }
      : null,
    draft: draft ? { updated_at: pgToIso(draft.updatedAt || draft.createdAt) } : null,
    saturation,
    last_run: await aiHealth.getJson(redis, `profile_run:${user.id}`),
    devices,
  };
}

async function getGraphHealth(db: Db, user: UserRow) {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      stale: sql<number>`count(*) filter (where ${knowledgeEntities.staleAt} is not null)`.mapWith(Number),
    })
    .from(knowledgeEntities)
    .where(eq(knowledgeEntities.userId, user.id));
  return {
    entities: Number(row?.total ?? 0),
    stale_entities: Number(row?.stale ?? 0),
  };
}

function buildReadiness(settings: Settings | undefined, user: UserRow) {
  if (!settings) return null;
  const fgProviders = getAiProviders(settings, { background: false, user });
  const bgProviders = getAiProviders(settings, { background: true, user });
  const llmConfigured = fgProviders.length > 0 || bgProviders.length > 0;
  const embProvider = settings.embeddingProvider || "none";
  const embeddingConfigured =
    embProvider === "local"
      ? Boolean(settings.embeddingServerUrl)
      : embProvider !== "none" && Boolean(settings.embeddingApiKey || llmConfigured);
  const standaloneMode = !settings.redisUrl || settings.redisUrl === "none";
  const hints: string[] = [];
  if (!llmConfigured) {
    hints.push("尚未配置大模型 API Key，做梦整理、纠偏提炼、技能挖掘与画像压缩无法自动运行；请到「个人设置 → 大模型」配置。");
  }
  if (!embeddingConfigured) {
    hints.push("向量检索模型未配置，当前仅使用关键词检索；配置 Embedding 后可开启混合语义检索与场景向量路由。");
  }
  if (!settings.enableScheduler) {
    hints.push("后台定时调度器已关闭（MEMENTO_ENABLE_SCHEDULER=0），夜间自动复盘与生命周期治理不会自动执行。");
  }
  return {
    llm_configured: llmConfigured,
    llm_providers: fgProviders.length,
    embedding_provider: embProvider,
    embedding_configured: embeddingConfigured,
    scheduler_enabled: Boolean(settings.enableScheduler),
    standalone_mode: standaloneMode,
    hints,
  };
}

async function getPipeline(db: Db, user: UserRow) {
  const [row] = await db
    .select({
      emb: sql<number>`count(*) filter (where ${documents.embeddingStatus} = 'failed')`.mapWith(Number),
      kn: sql<number>`count(*) filter (where ${documents.knowledgeStatus} = 'failed')`.mapWith(Number),
    })
    .from(documents)
    .innerJoin(machines, eq(documents.machineId, machines.id))
    .where(eq(machines.userId, user.id));
  return { embedding_failed: row?.emb || 0, knowledge_failed: row?.kn || 0 };
}

async function getDevices(db: Db, user: UserRow, nowMs: number) {
  const rows = await db
    .select({ hb: machines.lastHeartbeat })
    .from(machines)
    .where(and(eq(machines.userId, user.id), isNull(machines.mergedInto), eq(machines.isArchived, false)));
  const online = rows.filter((r) => {
    const ms = parseTs(r.hb);
    return ms > 0 && nowMs - ms < ONLINE_WINDOW_MS;
  }).length;
  return { total: rows.length, online };
}

export async function buildOverview(db: Db, redis: Redis | null, user: UserRow, settings?: Settings) {
  const nowMs = Date.now();
  const [ai, lastHour, dreaming, profile, pipeline, devices, learning, skillsC, reviewsC, todosC, memC, evalC, outcomesC, revRun, lifeRun, graphC] =
    await Promise.all([
      aiHealth.summary(redis, 24),
      aiHealth.summary(redis, 1),
      getDreaming(db, redis, user),
      getProfile(db, redis, user, nowMs),
      getPipeline(db, user),
      getDevices(db, user, nowMs),
      correctionStats(db, user),
      skillCounts(db, user),
      reviewStats(db, user),
      todoCounts(db, user.id),
      lifecycleCounts(db, user),
      evalSummary(db, user),
      outcomeSummary(db, user),
      aiHealth.getJson(redis, `review_run:${user.id}`),
      aiHealth.getJson(redis, `lifecycle_run:${user.id}`),
      getGraphHealth(db, user),
    ]);
  const readiness = buildReadiness(settings, user);
  const latestOutcome = outcomesC?.latest && typeof outcomesC.latest === "object" ? (outcomesC.latest as Record<string, unknown>) : null;
  const trendWeeks = Array.isArray(outcomesC?.trend) ? (outcomesC.trend as Record<string, unknown>[]) : [];
  const rulesTotal = Number(latestOutcome?.rules ?? 0);
  const rulesNeverAgain = Number(latestOutcome?.rules_never_again ?? 0);
  const firstLearned100 = trendWeeks.find((w) => typeof w.learned_per_100 === "number")?.learned_per_100 ?? null;
  const latestLearned100 = typeof latestOutcome?.learned_per_100 === "number" ? latestOutcome.learned_per_100 : null;
  const growth = {
    rules_total: rulesTotal,
    rules_never_again: rulesNeverAgain,
    rules_never_again_rate: rulesTotal > 0 ? Math.round((rulesNeverAgain / rulesTotal) * 1000) / 1000 : null,
    learned_per_100_first: firstLearned100,
    learned_per_100_latest: latestLearned100,
    pending_corrections: Number(learning?.pending ?? 0),
    draft_skills: Number(skillsC?.draft ?? 0),
    published_skills: Number(skillsC?.published ?? 0),
    pending_skill_updates: Number(skillsC?.updates ?? 0),
    graph: graphC,
    attribution: memC?.attribution ?? null,
  };
  const evolution = {
    skills: skillsC,
    reviews: reviewsC,
    todos: todosC,
    memory: memC,
    eval: evalC,
    outcomes: outcomesC,
    review_run: revRun,
    lifecycle_run: lifeRun,
    growth,
  };
  const issues = assess(ai, lastHour, dreaming, profile, pipeline, nowMs, learning, evolution);
  if (readiness && !readiness.llm_configured) {
    issues.unshift({ level: "warn", area: "readiness", text: readiness.hints[0]! });
  }
  const level = issues.some((i) => i.level === "error") ? "error" : issues.length ? "warn" : "ok";
  return {
    generated_at: new Date(nowMs).toISOString().replace("Z", "+00:00"),
    level,
    issues,
    readiness,
    ai,
    dreaming,
    profile,
    pipeline,
    devices,
    learning,
    evolution,
  };
}
