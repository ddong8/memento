// Weekly learning evaluation (server/server/services/learning_eval_service.py).
import { randomUUID } from "node:crypto";

import { and, count, desc, eq, gte, lt, ne, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Db } from "../db/client";
import { correctionEvents, correctionTopics, learningEvals } from "../db/pulled/schema";
import { GENERATED_PROMPT_SQL_RE, SUBAGENT_IMAGE_SQL_RE, SUBAGENT_PATH_REGEX } from "./dreaming-voice";
import { guardStats } from "./guard-service";

export type LearningEvalRow = typeof learningEvals.$inferSelect;

const USER_MESSAGE_TYPES = ["user", "USER_INPUT", "message"];
const RULE_SETTLE_MS = 7 * 86400_000;
const MIN_PROMPTS = 30;
const BACKFILL_WEEKS = 9;
const RECOMPUTE_WEEKS = 4;
const LEARNED_RISE = 1.5;
const LEARNED_MIN_POINTS = 1.0;
const RULE_RISE = 1.5;
const RULE_MIN_EVENTS = 3;

function tzOffsetMs(user: Pick<UserRow, "proactiveSettings">): number {
  const s = user.proactiveSettings && typeof user.proactiveSettings === "object" ? (user.proactiveSettings as Record<string, unknown>) : {};
  const n = Number(s.timezone_offset_hours ?? 8);
  return (Number.isFinite(n) ? n : 8) * 3600_000;
}

function fmtOffset(offsetMs: number): string {
  const totalMin = Math.round(offsetMs / 60_000);
  const sign = totalMin >= 0 ? "+" : "-";
  const abs = Math.abs(totalMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function weekStartDate(nowMs: number, offsetMs: number): string {
  const local = new Date(nowMs + offsetMs);
  const dow = (local.getUTCDay() + 6) % 7; // Monday=0
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow));
  return monday.toISOString().slice(0, 10);
}

export function weekBounds(weekIso: string, offsetMs: number): { startIso: string; endIso: string; startMs: number; endMs: number } {
  const [y, m, d] = weekIso.split("-").map(Number) as [number, number, number];
  const startUtcMs = Date.UTC(y, m - 1, d) - offsetMs;
  const endUtcMs = startUtcMs + 7 * 86400_000;
  const off = fmtOffset(offsetMs);
  const startLocal = new Date(startUtcMs + offsetMs).toISOString().slice(0, 19);
  const endLocal = new Date(endUtcMs + offsetMs).toISOString().slice(0, 19);
  return {
    startIso: `${startLocal}${off}`,
    endIso: `${endLocal}${off}`,
    startMs: startUtcMs,
    endMs: endUtcMs,
  };
}

function per100(n: number, prompts: number): number | null {
  return prompts ? Math.round(((100 * n) / prompts) * 100) / 100 : null;
}

function parseTs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = raw.includes("T") ? raw : raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

export async function countPrompts(db: Db, userId: string, startIso: string, endIso: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(DISTINCT md5(left(cm.content, 500))) AS n
    FROM conversation_messages cm
    JOIN documents d ON d.id = cm.document_id
    WHERE d.machine_id IN (SELECT id FROM machines WHERE user_id = ${userId}::uuid)
      AND cm.role = 'user'
      AND coalesce(cm.message_type, '') IN (${sql.join(USER_MESSAGE_TYPES.map((t) => sql`${t}`), sql`, `)})
      AND cm.timestamp >= ${startIso}::timestamptz
      AND cm.timestamp < ${endIso}::timestamptz
      AND cm.content !~ '^\\s*<'
      AND cm.content NOT LIKE '%tool_result%'
      AND cm.content NOT LIKE '[Result]%'
      AND cm.content !~ ${GENERATED_PROMPT_SQL_RE}
      AND cm.content !~* ${SUBAGENT_IMAGE_SQL_RE}
      AND d.relative_path !~ ${SUBAGENT_PATH_REGEX}
      AND NOT coalesce(d.metadata ? 'parent_session_id', false)
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

export interface RuleEventRow {
  topicId: string;
  statement: string;
  status: string;
  acceptedAt: string | null;
  saidAt: string;
}

export function ruleMetrics(rows: RuleEventRow[], startMs: number, endMs: number): Record<string, unknown> {
  const topics = new Map<string, { statement: string; acceptedMs: number; firstMs: number; before: number; after: number }>();
  let weekEvents = 0;
  let weekLearnedRule = 0;
  const inWeekByTopic = new Map<string, number>();
  const statements = new Map<string, string>();

  for (const r of rows) {
    statements.set(r.topicId, r.statement);
    const saidMs = parseTs(r.saidAt);
    const acceptedMs = r.acceptedAt ? parseTs(r.acceptedAt) : 0;
    const accepted = r.status === "accepted" && acceptedMs > 0;
    if (saidMs >= startMs && saidMs < endMs) {
      weekEvents++;
      if (accepted && saidMs >= acceptedMs) {
        weekLearnedRule++;
        inWeekByTopic.set(r.topicId, (inWeekByTopic.get(r.topicId) ?? 0) + 1);
      }
    }
    if (!accepted || acceptedMs >= endMs - RULE_SETTLE_MS) continue;
    let t = topics.get(r.topicId);
    if (!t) {
      t = { statement: r.statement, acceptedMs, firstMs: saidMs, before: 0, after: 0 };
      topics.set(r.topicId, t);
    }
    if (saidMs < t.firstMs) t.firstMs = saidMs;
    if (saidMs < acceptedMs) t.before++;
    else t.after++;
  }

  const weekMs = 7 * 86400_000;
  let beforeWeeks = 0;
  let afterWeeks = 0;
  let before = 0;
  let after = 0;
  let neverAgain = 0;
  for (const t of topics.values()) {
    beforeWeeks += (t.acceptedMs - Math.min(t.firstMs, t.acceptedMs)) / weekMs;
    afterWeeks += (endMs - t.acceptedMs) / weekMs;
    before += t.before;
    after += t.after;
    if (t.after === 0) neverAgain++;
  }

  let settledInWeek = 0;
  for (const [tid, n] of inWeekByTopic) if (topics.has(tid)) settledInWeek += n;

  const stubborn = [...inWeekByTopic.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tid, n]) => ({ statement: (statements.get(tid) || "").slice(0, 120), times: n }));

  return {
    week_corrections: weekEvents,
    week_on_accepted: weekLearnedRule,
    rules: topics.size,
    rules_never_again: neverAgain,
    before_per_rule_week: beforeWeeks > 0 ? Math.round((before / beforeWeeks) * 100) / 100 : null,
    after_per_rule_week: afterWeeks > 0 ? Math.round((after / afterWeeks) * 100) / 100 : null,
    week_per_rule: topics.size ? Math.round((settledInWeek / topics.size) * 1000) / 1000 : null,
    stubborn,
  };
}

export async function measureWeek(db: Db, user: UserRow, weekIso: string): Promise<Record<string, unknown>> {
  const { startIso, endIso, startMs, endMs } = weekBounds(weekIso, tzOffsetMs(user));
  const prompts = await countPrompts(db, user.id, startIso, endIso);
  const [learnedRow] = await db
    .select({ n: count() })
    .from(correctionEvents)
    .innerJoin(correctionTopics, eq(correctionTopics.id, correctionEvents.topicId))
    .where(
      and(
        eq(correctionEvents.userId, user.id),
        gte(correctionEvents.saidAt, startIso),
        lt(correctionEvents.saidAt, endIso),
        eq(correctionEvents.alreadyLearned, true),
        ne(correctionTopics.status, "dismissed"),
      ),
    );
  const learned = Number(learnedRow?.n ?? 0);

  const eventRows = await db
    .select({
      topicId: correctionEvents.topicId,
      statement: correctionTopics.statement,
      status: correctionTopics.status,
      acceptedAt: correctionTopics.acceptedAt,
      saidAt: correctionEvents.saidAt,
    })
    .from(correctionEvents)
    .innerJoin(correctionTopics, eq(correctionTopics.id, correctionEvents.topicId))
    .where(
      and(
        eq(correctionEvents.userId, user.id),
        lt(correctionEvents.saidAt, endIso),
        ne(correctionTopics.status, "dismissed"),
      ),
    );

  const rules = ruleMetrics(eventRows, startMs, endMs);
  const corrections = Number(rules.week_corrections ?? 0);
  delete rules.week_corrections;

  return {
    start: startIso,
    end: endIso,
    prompts,
    corrections,
    learned,
    corrections_per_100: per100(corrections, prompts),
    learned_per_100: per100(learned, prompts),
    ...rules,
    guard: await guardStats(db, user.id, startIso, endIso),
  };
}

export async function saveWeek(db: Db, user: UserRow, weekIso: string, trigger: string): Promise<Record<string, unknown>> {
  const metrics = await measureWeek(db, user, weekIso);
  await db
    .insert(learningEvals)
    .values({
      id: randomUUID(),
      userId: user.id,
      week: weekIso,
      metrics,
      trigger,
    })
    .onConflictDoUpdate({
      target: [learningEvals.userId, learningEvals.week],
      set: { metrics, trigger, updatedAt: sql`now()` as unknown as string },
    });
  return metrics;
}

export async function runLearningEval(db: Db, user: UserRow, trigger = "scheduled", nowMs = Date.now()): Promise<string[]> {
  const thisWeek = weekStartDate(nowMs, tzOffsetMs(user));
  const [haveRow] = await db.select({ n: count() }).from(learningEvals).where(eq(learningEvals.userId, user.id));
  const have = Number(haveRow?.n ?? 0);
  const n = have ? RECOMPUTE_WEEKS : BACKFILL_WEEKS;
  const [y, m, d] = thisWeek.split("-").map(Number) as [number, number, number];
  const baseMs = Date.UTC(y, m - 1, d);
  const weeks: string[] = [];
  for (let i = n; i >= 1; i--) {
    weeks.push(new Date(baseMs - i * 7 * 86400_000).toISOString().slice(0, 10));
  }
  for (const w of weeks) {
    await saveWeek(db, user, w, have ? trigger : "backfill");
  }
  return weeks;
}

export async function recentWeeks(db: Db, user: Pick<UserRow, "id">, limit = 12): Promise<LearningEvalRow[]> {
  return db
    .select()
    .from(learningEvals)
    .where(eq(learningEvals.userId, user.id))
    .orderBy(desc(learningEvals.week))
    .limit(limit);
}

function median(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function regression(weeks: LearningEvalRow[]): Record<string, unknown> | null {
  const usable = weeks.filter((w) => Number(((w.metrics as Record<string, unknown>) || {}).prompts ?? 0) >= MIN_PROMPTS);
  if (usable.length < 3 || usable[0] !== weeks[0]) return null;
  const latest = (usable[0]!.metrics as Record<string, unknown>) || {};
  const earlier = usable.slice(1, 5).map((w) => (w.metrics as Record<string, unknown>) || {});

  const med = (key: string): number | null => {
    const vals = earlier.map((m) => m[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return median(vals);
  };

  const nowLearned = latest.learned_per_100;
  const wasLearned = med("learned_per_100");
  if (typeof nowLearned === "number" && wasLearned !== null && nowLearned - wasLearned >= LEARNED_MIN_POINTS && nowLearned >= LEARNED_RISE * wasLearned) {
    return { metric: "learned_per_100", now: nowLearned, was: Math.round(wasLearned * 100) / 100, week: String(usable[0]!.week) };
  }
  const nowRule = latest.week_per_rule;
  const wasRule = med("week_per_rule");
  if (
    typeof nowRule === "number" &&
    wasRule !== null &&
    Number(latest.week_on_accepted ?? 0) >= RULE_MIN_EVENTS &&
    nowRule > 0 &&
    nowRule >= RULE_RISE * Math.max(wasRule, 0.01)
  ) {
    return { metric: "week_per_rule", now: nowRule, was: Math.round(wasRule * 1000) / 1000, week: String(usable[0]!.week) };
  }
  return null;
}

export function regressionText(drop: Record<string, unknown>): string {
  if (drop.metric === "learned_per_100") {
    return `${drop.week} 那周每 100 次提问里有 ${drop.now} 次在纠正已经学会的规矩，前几周中位数是 ${drop.was}。`;
  }
  return `${drop.week} 那周已采纳的规矩平均每条被纠正 ${drop.now} 次，前几周中位数是 ${drop.was}。`;
}

export async function outcomeSummary(db: Db, user: Pick<UserRow, "id">) {
  const weeks = await recentWeeks(db, user);
  const latest = weeks[0] ?? null;
  const latestUpdatedMs = latest?.updatedAt ? parseTs(latest.updatedAt) : 0;
  return {
    latest: latest ? { week: String(latest.week), ...((latest.metrics as Record<string, unknown>) || {}) } : null,
    stale: Boolean(latest && latestUpdatedMs > 0 && Date.now() - latestUpdatedMs > 10 * 86400_000),
    trend: [...weeks].reverse().map((w) => {
      const m = (w.metrics as Record<string, unknown>) || {};
      const g = (m.guard && typeof m.guard === "object" ? (m.guard as Record<string, unknown>) : {}) || {};
      return {
        week: String(w.week),
        prompts: m.prompts ?? null,
        corrections_per_100: m.corrections_per_100 ?? null,
        learned_per_100: m.learned_per_100 ?? null,
        week_per_rule: m.week_per_rule ?? null,
        unchecked_rate: g.unchecked_rate ?? null,
      };
    }),
    regression: regression(weeks),
  };
}
