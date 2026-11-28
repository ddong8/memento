// Learn from user corrections & measure repeat-correction rate (server/server/services/correction_service.py).
import { createHash, randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import { askConversations, correctionEvents, correctionTopics, userMemories, userProfiles } from "../db/pulled/schema";
import { pgToIso } from "../pytime";
import * as aiHealth from "./ai-health";
import { callPlainChat } from "./ai-provider";
import { fetchAskUserTurnsSince } from "./ask-store";
import { safeJsonLoads } from "./dreaming-core";
import { cleanUserVoice, CORRECTION_RE, SUBAGENT_PATH_REGEX } from "./dreaming-voice";
import { recordMemoryFeedback } from "./guidance-service";
import { getDraftProfile, getPublishedProfile, sanitizeProfileContent } from "./profile-read";
import { cleanDeviceName, joinProfileScopes, normScopeName, PROFILE_MAX_CHARS, SCOPED_MAX_CHARS, splitProfileScopes } from "./profile-scopes";

export type CorrectionTopicRow = typeof correctionTopics.$inferSelect;
export type CorrectionEventQuote = { quote: string; saidAt: string };

export const CATEGORY_HEADINGS: Record<string, string> = {
  communication: "沟通",
  rule: "铁律",
  workflow: "工作方式",
  tech: "技术偏好",
};

const BACKFILL_MS = 30 * 86400_000;
const SCAN_LIMIT = 1000;
const LLM_BATCH = 25;
const KNOWN_LIMIT = 120;
const STATEMENT_MAX = 200;

const PUSHBACK_RE =
  /又|还是|怎么变|怎么还|中文|英文|我要的是|我想要|我说的是|不是这个|理解错|搞错|弄错|你没有?|别|不准|不许|不能|不应该|应该|太长|太啰嗦|啰嗦|简洁|简短|直接说|先给结论|说重点|回复我|\bplease\b|\bi said\b|\bagain\b|\bkeep\b|\btoo (?:long|verbose)\b|\bin (?:english|chinese)\b/i;

const STANDING_REQUEST_RE =
  /^.{0,30}?(?:做了什么|干了什么|做了哪些).{0,40}?日报|^.{0,10}?(?:帮我)?写(?:一?份|个)?(?:今天的|昨天的|本周的?)?日报/;

const RULE_NOISE_RE = /[\s，,。.；;：:！!？?、（）()"'“”‘’`*\-—]+/g;

export class ProfileFull extends Error {
  constructor() {
    super("profile is full");
    this.name = "ProfileFull";
  }
}

export function isStandingRequest(text: string): boolean {
  return STANDING_REQUEST_RE.test(text || "");
}

export function looksLikePushback(text: string): boolean {
  return CORRECTION_RE.test(text) || PUSHBACK_RE.test(text);
}

export function cleanStatement(text: string | null | undefined): string {
  let line = (text || "").replace(/\s+/g, " ").trim();
  line = line.replace(/^[-*•\d.、\s]+/, "");
  line = line.replaceAll("<!--", "").replaceAll("-->", "").trim();
  return [...line].slice(0, STATEMENT_MAX).join("");
}

function ruleKey(text: string): string {
  return (text || "").replace(RULE_NOISE_RE, "").toLowerCase();
}

export function topicHeading(topic: Pick<CorrectionTopicRow, "scope" | "category">): string {
  const scope = topic.scope || "global";
  const idx = scope.indexOf(":");
  if (idx > 0) {
    const kind = scope.slice(0, idx);
    const name = scope.slice(idx + 1);
    if (kind === "project" && name) return `项目：${name}`;
    if (kind === "device" && name) return `设备：${name}`;
  }
  return CATEGORY_HEADINGS[topic.category] ?? "铁律";
}

export function profileCovers(content: string, heading: string, line: string): boolean {
  const key = ruleKey(line);
  if (key.length < 4) return false;
  const scopes = splitProfileScopes(content || "");
  const lines = scopes.general.split("\n");
  const scoped = /^(项目|设备)\s*[:：]\s*(.+)$/.exec(heading);
  if (scoped) {
    const bucket = scoped[1] === "项目" ? scopes.projects : scopes.devices;
    const name = normScopeName(scoped[2]!.trim());
    for (const [k, v] of Object.entries(bucket)) {
      if (normScopeName(k) === name) lines.push(...v);
    }
  }
  return lines.some((x) => {
    const t = x.trim();
    return (t.startsWith("-") || t.startsWith("*") || t.startsWith("•")) && ruleKey(x).includes(key);
  });
}

function addGeneralLine(general: string, heading: string, bullet: string): string {
  const lines = general.trim() ? general.trimEnd().split("\n") : [];
  const start = lines.findIndex((l) => {
    const s = l.trim();
    return s.startsWith("#") && s.replace(/^#+/, "").trim() === heading;
  });
  if (start === -1) {
    const order = Object.values(CATEGORY_HEADINGS);
    const idx = order.indexOf(heading);
    const later = new Set(idx >= 0 ? order.slice(idx + 1) : []);
    const before = lines.findIndex((l) => {
      const s = l.trim();
      return s.startsWith("#") && later.has(s.replace(/^#+/, "").trim());
    });
    if (before === -1) {
      return [...lines, ...(lines.length ? [""] : []), `### ${heading}`, bullet].join("\n");
    }
    return [...lines.slice(0, before), `### ${heading}`, bullet, "", ...lines.slice(before)].join("\n");
  }
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trim().startsWith("#")) end++;
  let insertAt = end;
  while (insertAt > start + 1 && !lines[insertAt - 1]!.trim()) insertAt--;
  return [...lines.slice(0, insertAt), bullet, ...lines.slice(insertAt)].join("\n");
}

export function addProfileLine(content: string, heading: string, line: string): string {
  const bullet = `- ${line}`;
  if (profileCovers(content, heading, line)) return (content || "").trim();
  const scopes = splitProfileScopes(content || "");
  const scoped = /^(项目|设备)\s*[:：]\s*(.+)$/.exec(heading);
  if (scoped) {
    const bucket = scoped[1] === "项目" ? scopes.projects : scopes.devices;
    const name = scoped[2]!.trim();
    const existingKey = Object.keys(bucket).find((k) => normScopeName(k) === normScopeName(name)) ?? name;
    if (!bucket[existingKey]) bucket[existingKey] = [];
    bucket[existingKey]!.push(bullet);
  } else {
    scopes.general = addGeneralLine(scopes.general, heading, bullet);
  }
  return joinProfileScopes(scopes);
}

export function overLimit(content: string): boolean {
  const scopes = splitProfileScopes(content);
  if (scopes.general.length > PROFILE_MAX_CHARS) return true;
  for (const bucket of [scopes.projects, scopes.devices]) {
    for (const lines of Object.values(bucket)) {
      if (lines.join("\n").length > SCOPED_MAX_CHARS) return true;
    }
  }
  return false;
}

export function shouldAutoAccept(topic: Pick<CorrectionTopicRow, "statement" | "times" | "category">, text: string): boolean {
  const stmt = (topic.statement || "").trim();
  if (!stmt || stmt.length < 4) return false;
  if (topic.times >= 2) return true;
  const strongSignals = [
    "必须", "严禁", "始终", "统一用", "不要用", "不得", "别再", "禁止", "一律",
    "先给结论", "直接给结论", "不用角标", "用中文", "中文回复", "不能", "铁律",
    "always", "never", "must", "do not",
  ];
  const combined = `${stmt} ${text}`.toLowerCase();
  return strongSignals.some((sig) => combined.includes(sig)) && topic.category in CATEGORY_HEADINGS;
}

interface SaidCorrection {
  messageId: number;
  text: string;
  saidAtIso: string;
  saidAtMs: number;
  project: string | null;
  device: string | null;
}

function saidWhere(s: SaidCorrection): string {
  return [s.project, s.device].filter(Boolean).join(" @ ");
}

function scopeFor(kind: string, s: SaidCorrection): string {
  if (kind === "project" && s.project) return `project:${s.project}`;
  if (kind === "device" && s.device) return `device:${s.device}`;
  return "global";
}

function correctionFingerprint(s: SaidCorrection): string {
  return createHash("sha1").update(`${s.saidAtIso}|${s.text}`, "utf8").digest("hex");
}

function parseTs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = raw.includes("T") ? raw : raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

function learnedBy(topic: CorrectionTopicRow, whenMs: number): boolean {
  if (topic.status !== "accepted") return false;
  if (!topic.acceptedAt) return true;
  return parseTs(topic.acceptedAt) <= whenMs;
}

export async function acceptTopic(
  db: Db,
  user: Pick<UserRow, "id">,
  topic: CorrectionTopicRow,
  statement?: string | null,
  general = false,
): Promise<CorrectionTopicRow> {
  const line = cleanStatement(statement || topic.statement);
  if (!line) throw new Error("statement is empty");
  const nextScope = general ? "global" : topic.scope || "global";
  const heading = topicHeading({ scope: nextScope, category: topic.category });

  const published = await getPublishedProfile(db, user);
  const base = (published?.content ?? "").trim();
  const updated = addProfileLine(base, heading, line);
  if (overLimit(updated)) throw new ProfileFull();
  const nowIso = new Date().toISOString();
  if (updated !== base) {
    const [maxRow] = await db
      .select({ v: sql<number>`coalesce(max(${userProfiles.version}), 0)` })
      .from(userProfiles)
      .where(eq(userProfiles.userId, user.id));
    await db.insert(userProfiles).values({
      id: randomUUID(),
      userId: user.id,
      status: "published",
      version: Number(maxRow?.v ?? 0) + 1,
      content: sanitizeProfileContent(updated),
      stats: { source: "correction" },
      publishedAt: nowIso,
    });
  }
  const draft = await getDraftProfile(db, user);
  if (draft) {
    await db
      .update(userProfiles)
      .set({ content: addProfileLine(draft.content, heading, line), updatedAt: nowIso })
      .where(eq(userProfiles.id, draft.id));
  }

  let memoryId = topic.memoryId;
  if (memoryId) {
    await db.update(userMemories).set({ content: line, updatedAt: nowIso }).where(eq(userMemories.id, memoryId));
  } else {
    memoryId = randomUUID();
    const key = `correction_${topic.id.replaceAll("-", "").slice(0, 8)}`;
    const category = topic.category === "rule" ? "rule" : "preference";
    await db.insert(userMemories).values(
      withoutNul({
        id: memoryId,
        userId: user.id,
        category,
        key,
        content: line,
        confidence: 1.0,
        source: "manual",
        treePath: `/${category}/${key}`,
        isFolder: false,
        recallCount: 0,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
    );
  }

  const [saved] = await db
    .update(correctionTopics)
    .set({
      statement: line,
      scope: nextScope,
      status: "accepted",
      acceptedAt: nowIso,
      memoryId,
      updatedAt: nowIso,
    })
    .where(eq(correctionTopics.id, topic.id))
    .returning();
  return saved ?? topic;
}

export async function acceptCoveredTopics(db: Db, user: Pick<UserRow, "id">): Promise<string[]> {
  const published = await getPublishedProfile(db, user);
  const content = published?.content ?? "";
  if (!content.trim()) return [];
  const pending = await db
    .select()
    .from(correctionTopics)
    .where(and(eq(correctionTopics.userId, user.id), eq(correctionTopics.status, "pending")));
  const accepted: string[] = [];
  for (const t of pending) {
    if (profileCovers(content, topicHeading(t), t.statement)) {
      await acceptTopic(db, user, t);
      accepted.push(t.statement);
    }
  }
  return accepted;
}

const CLASSIFY_PROMPT = (known: string, messages: string) => `下面是用户在各个 AI 工具里亲手打的话，都可能是在纠正 AI。请判断哪些是能长期指导 AI 以后怎么做的"规矩"。

## 已知的话题（用户以前说过、或已经记住的）
${known}

## 用户的原话
${messages}

## 要求
- 只挑长期有效的：沟通方式、必须遵守或禁止的做法、工作习惯、技术偏好。一次性的任务指令（"帮我改这个 bug"、"不要改那个文件"这类只针对当前任务的）不要。
- statement：写成直接对 AI 的一句祈使句，如"始终用中文回复"、"git commit 不要加 Co-Authored-By"。不超过 60 字。
- category：communication（沟通方式）| rule（必须/禁止）| workflow（工作方式）| tech（技术偏好）。
- scope：global（到哪都适用，默认）| project（只在原话所在的那个项目里成立，比如涉及它的业务、数据格式、专有工具）| device（只在那台机器上成立，比如本机磁盘、路径）。原话前的 [项目 @ 设备] 标注说明它是在哪说的。沟通方式、工作习惯这类，即使只在一个项目里说过，也是 global。
- i：表达这条规矩的所有原话编号。同一件事在下面说了好几次，就合成一条，把编号都列上。
- match：如果和某个已知话题说的是同一件事，填它的编号（如 "t3"、"m12"）；否则填 null。宁可匹配已知话题，也不要把同一件事拆成两个。
- 抱怨 AI 又违反了某个已知话题的话也要输出、填上 match，哪怕它本身不像一条规矩。例如已知话题是"始终用中文回复"，原话"怎么又变成英文了"就匹配它。这类重复最重要，不要漏。
- upfront：i 里哪些原话是用户提新请求时顺带交代的要求（如"我今天做了什么，我要写日报，尽量通俗，不要提问题"），而不是在回应 AI 刚做错、刚忘了的事（如"中文！"、"怎么又提问题了"）。没有就填 []。
- unmet：i 里哪些原话只是在说某个功能还没做好、问题还在（如"还是不行啊"、"手机版还是没适配好"、"这张图还是没识别成两个反应"），没有指出 AI 的做法违反了这条规矩。指出 AI 做法的（"你到底测试没"、"怎么又用英文了"、"没验证就说修好了"）不算。没有就填 []。
- 不是规矩的原话直接略过，不用输出。

只输出 JSON：{"items": [{"i": [1, 4], "statement": "...", "category": "rule", "scope": "global", "match": null, "upfront": [], "unmet": []}]}`;

function parseNumbers(raw: unknown): Set<number> {
  const out = new Set<number>();
  if (!Array.isArray(raw)) return out;
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n)) out.add(n);
  }
  return out;
}

export async function learnFromCorrections(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
): Promise<{ scanned: number; events: number; new_topics: string[]; auto_accepted: string[]; covered: string[]; backfill: boolean }> {
  const nowMs = Date.now();
  const covered = await acceptCoveredTopics(db, user);
  const cursorKey = `corrections_cursor:${user.id}`;
  const cursor = await aiHealth.getJson<number | null>(redis, cursorKey);
  const backfillIso = new Date(nowMs - BACKFILL_MS).toISOString();

  const rows = (await db.execute(sql`
    SELECT cm.id, cm.content, cm.timestamp, p.title AS project, m.name AS machine
    FROM conversation_messages cm
    JOIN documents d ON d.id = cm.document_id
    LEFT JOIN projects p ON p.id = d.project_id
    LEFT JOIN machines m ON m.id = d.machine_id
    WHERE d.machine_id IN (SELECT id FROM machines WHERE user_id = ${user.id}::uuid)
      AND cm.role = 'user'
      AND cm.timestamp IS NOT NULL
      AND cm.timestamp >= ${backfillIso}::timestamptz
      AND cm.content NOT LIKE '[Result]%'
      AND NOT (d.relative_path ~ ${SUBAGENT_PATH_REGEX})
      AND NOT coalesce(d.metadata ? 'parent_session_id', false)
      ${cursor != null ? sql`AND cm.id > ${cursor}` : sql``}
    ORDER BY cm.id
    LIMIT ${SCAN_LIMIT}
  `)) as unknown as { id: string | number; content: string; timestamp: string; project: string | null; machine: string | null }[];

  const found: SaidCorrection[] = [];
  const seenTexts = new Set<string>();
  for (const r of rows) {
    const text = cleanUserVoice(r.content);
    if (text && looksLikePushback(text)) {
      seenTexts.add(text);
      const iso = pgToIso(String(r.timestamp)) ?? new Date(nowMs).toISOString().replace("Z", "+00:00");
      found.push({
        messageId: Number(r.id),
        text,
        saidAtIso: iso,
        saidAtMs: parseTs(iso) || nowMs,
        project: r.project,
        device: r.machine ? cleanDeviceName(r.machine) : null,
      });
    }
  }

  const askCursorKey = `corrections_ask_cursor:${user.id}`;
  const askCursorIso = await aiHealth.getJson<string>(redis, askCursorKey);
  const askSinceMs = askCursorIso ? parseTs(askCursorIso) : nowMs - 86400_000;
  const safeAskSinceMs = askSinceMs || nowMs - 86400_000;
  const askSinceIso = new Date(safeAskSinceMs).toISOString();
  const askData = await fetchAskUserTurnsSince(db, user.id, askSinceIso, { maxConvs: 30, maxTurnsPerConv: 200 });
  const recentQuoteRows = await db
    .select({ quote: correctionEvents.quote })
    .from(correctionEvents)
    .where(and(eq(correctionEvents.userId, user.id), gte(correctionEvents.saidAt, new Date(nowMs - 86400_000).toISOString())));
  const recentQuotes = new Set(recentQuoteRows.map((r) => r.quote));

  let latestAskMs = safeAskSinceMs;
  if (askData.latestUpdatedAt) {
    const uMs = parseTs(askData.latestUpdatedAt);
    if (uMs > latestAskMs) latestAskMs = uMs;
  }
  for (const turn of askData.turns) {
    const updMs = parseTs(turn.updatedAt);
    const saidMs = turn.createdAt ? parseTs(turn.createdAt.replace("Z", "+00:00")) : updMs;
    if (!saidMs || saidMs <= safeAskSinceMs) continue;
    const text = cleanUserVoice(turn.content);
    if (!text || seenTexts.has(text) || recentQuotes.has(text) || !looksLikePushback(text)) continue;
    seenTexts.add(text);
    found.push({
      messageId: -1 - turn.turnIdx,
      text,
      saidAtIso: new Date(saidMs).toISOString().replace("Z", "+00:00"),
      saidAtMs: saidMs,
      project: turn.projectId,
      device: null,
    });
  }
  if (latestAskMs > safeAskSinceMs) {
    await aiHealth.putJson(redis, askCursorKey, new Date(latestAskMs).toISOString(), 90 * 86400);
  }
  found.sort((a, b) => a.saidAtMs - b.saidAtMs);
  const nextCursor = rows.length ? Number(rows[rows.length - 1]!.id) : cursor;

  const topics = await db
    .select()
    .from(correctionTopics)
    .where(eq(correctionTopics.userId, user.id))
    .orderBy(sql`${correctionTopics.lastAt} DESC NULLS LAST`)
    .limit(KNOWN_LIMIT);
  const linked = new Set(topics.map((t) => t.memoryId).filter((x): x is string => Boolean(x)));
  const memRows = await db
    .select()
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, user.id),
        inArray(userMemories.category, ["preference", "rule", "rules"]),
        eq(userMemories.isFolder, false),
        eq(userMemories.status, "active"),
      ),
    )
    .orderBy(desc(userMemories.updatedAt))
    .limit(KNOWN_LIMIT);
  const memories = memRows.filter((m) => !linked.has(m.id));

  type RefVal = { kind: "topic"; obj: CorrectionTopicRow } | { kind: "memory"; obj: typeof userMemories.$inferSelect };
  const refs = new Map<string, RefVal>();
  topics.forEach((t, i) => refs.set(`t${i + 1}`, { kind: "topic", obj: t }));
  memories.forEach((m, i) => refs.set(`m${i + 1}`, { kind: "memory", obj: m }));

  let events = 0;
  const newTopics: CorrectionTopicRow[] = [];
  const autoAccepted: CorrectionTopicRow[] = [];

  for (let start = 0; start < found.length; start += LLM_BATCH) {
    const batch = found.slice(start, start + LLM_BATCH);
    const knownText =
      [...refs.entries()]
        .map(([ref, val]) => `${ref}: ${(val.kind === "topic" ? val.obj.statement : val.obj.content).slice(0, 100)}`)
        .join("\n") || "（无）";
    const messages = batch.map((s, i) => `[${i + 1}] ${saidWhere(s) ? `[${saidWhere(s)}] ` : ""}${s.text}`).join("\n");
    const raw = await callPlainChat(
      settings,
      redis,
      [
        { role: "system", content: "You extract durable user preferences. Respond only with valid JSON." },
        { role: "user", content: CLASSIFY_PROMPT(knownText, messages) },
      ],
      { maxTokens: 2000, background: true, user },
    );
    if (!raw) throw new Error("correction classification got no answer from any AI provider");
    const rawItems = Array.isArray(safeJsonLoads(raw).items) ? (safeJsonLoads(raw).items as Record<string, unknown>[]) : [];
    const items: {
      indices: number[];
      statement: string;
      category: string;
      scope: string;
      match: string | null;
      upfront: Set<number>;
      unmet: Set<number>;
    }[] = [];

    for (const item of rawItems) {
      if (!item || typeof item !== "object") continue;
      const rawI = Array.isArray(item.i) ? item.i : [item.i];
      const indices = [...parseNumbers(rawI)].filter((n) => n >= 1 && n <= batch.length).sort((a, b) => a - b);
      const statement = cleanStatement(String(item.statement ?? ""));
      if (!indices.length || !statement) continue;
      const cat = String(item.category ?? "rule");
      const sc = String(item.scope ?? "global");
      const upfront = new Set<number>();
      for (const idx of parseNumbers(item.upfront)) if (indices.includes(idx)) upfront.add(idx);
      for (const idx of indices) if (isStandingRequest(batch[idx - 1]!.text)) upfront.add(idx);
      const unmet = new Set<number>();
      for (const idx of parseNumbers(item.unmet)) if (indices.includes(idx)) unmet.add(idx);
      items.push({
        indices,
        statement,
        category: cat in CATEGORY_HEADINGS ? cat : "rule",
        scope: ["global", "project", "device"].includes(sc) ? sc : "global",
        match: item.match ? String(item.match) : null,
        upfront,
        unmet,
      });
    }

    const occurrences: [SaidCorrection, number, number][] = [];
    items.forEach((it, n) => {
      for (const idx of it.indices) occurrences.push([batch[idx - 1]!, n, idx]);
    });
    occurrences.sort((a, b) => a[0].saidAtMs - b[0].saidAtMs);

    const resolved = new Map<number, CorrectionTopicRow>();
    for (const [s, n, i] of occurrences) {
      const item = items[n]!;
      const pushback = !item.upfront.has(i) && !item.unmet.has(i);
      const fp = correctionFingerprint(s);
      const lowIso = new Date(s.saidAtMs - 30 * 60_000).toISOString();
      const highIso = new Date(s.saidAtMs + 30 * 60_000).toISOString();
      const dup = (await db.execute(sql`
        SELECT id FROM correction_events
        WHERE user_id = ${user.id}::uuid
          AND (fingerprint = ${fp} OR (quote = ${s.text} AND said_at >= ${lowIso}::timestamptz AND said_at <= ${highIso}::timestamptz))
        LIMIT 1
      `)) as unknown as { id: string }[];
      if (dup.length) continue;

      let topic: CorrectionTopicRow;
      let repeat = false;
      let learned = false;
      const prev = resolved.get(n);
      const refHit = !prev && item.match ? refs.get(item.match) : undefined;

      if (prev) {
        topic = prev;
        repeat = true;
        learned = learnedBy(topic, s.saidAtMs) && pushback;
      } else if (refHit?.kind === "memory") {
        const mem = refHit.obj;
        const [created] = await db
          .insert(correctionTopics)
          .values(
            withoutNul({
              id: randomUUID(),
              userId: user.id,
              statement: cleanStatement(mem.content),
              category: item.category,
              status: "accepted",
              scope: "global",
              times: 0,
              acceptedAt: mem.createdAt,
              memoryId: mem.id,
            }),
          )
          .returning();
        topic = created!;
        if (item.match) refs.set(item.match, { kind: "topic", obj: topic });
        resolved.set(n, topic);
        repeat = learnedBy(topic, s.saidAtMs);
        learned = repeat && pushback;
      } else if (refHit?.kind === "topic") {
        topic = refHit.obj;
        repeat = true;
        learned = learnedBy(topic, s.saidAtMs) && pushback;
      } else {
        const [created] = await db
          .insert(correctionTopics)
          .values(
            withoutNul({
              id: randomUUID(),
              userId: user.id,
              statement: item.statement,
              category: item.category,
              status: "pending",
              scope: scopeFor(item.scope, s),
              times: 0,
            }),
          )
          .returning();
        topic = created!;
        refs.set(`t${refs.size + 1}`, { kind: "topic", obj: topic });
        resolved.set(n, topic);
        newTopics.push(topic);
      }

      topic.times += 1;
      const firstMs = topic.firstAt ? Math.min(parseTs(topic.firstAt), s.saidAtMs) : s.saidAtMs;
      const lastMs = topic.lastAt ? Math.max(parseTs(topic.lastAt), s.saidAtMs) : s.saidAtMs;
      topic.firstAt = new Date(firstMs).toISOString();
      topic.lastAt = new Date(lastMs).toISOString();
      await db
        .update(correctionTopics)
        .set({ times: topic.times, firstAt: topic.firstAt, lastAt: topic.lastAt, updatedAt: new Date().toISOString() })
        .where(eq(correctionTopics.id, topic.id));

      if (topic.status === "pending" && shouldAutoAccept(topic, s.text)) {
        try {
          const accepted = await acceptTopic(db, user, topic);
          Object.assign(topic, accepted);
          autoAccepted.push(topic);
        } catch {
          /* profile full or error -> stay pending */
        }
      }

      await db.insert(correctionEvents).values(
        withoutNul({
          userId: user.id,
          topicId: topic.id,
          quote: s.text,
          saidAt: s.saidAtIso,
          repeat,
          alreadyLearned: learned,
          fingerprint: fp,
        }),
      );
      if (learned && topic.memoryId) {
        void recordMemoryFeedback(db, [topic.memoryId], "neg");
      }
      events++;
    }
  }

  await aiHealth.putJson(redis, cursorKey, nextCursor, 90 * 86400);
  return {
    scanned: found.length,
    events,
    new_topics: newTopics.filter((t) => t.status === "pending").map((t) => t.statement),
    auto_accepted: autoAccepted.map((t) => t.statement),
    covered,
    backfill: cursor === null,
  };
}

export async function correctionStats(db: Db, user: Pick<UserRow, "id">, days = 30, weeks = 5) {
  const nowMs = Date.now();
  const sinceIso = new Date(nowMs - Math.max(days, weeks * 7) * 86400_000).toISOString();
  const rows = await db
    .select({
      saidAt: correctionEvents.saidAt,
      repeat: correctionEvents.repeat,
      alreadyLearned: correctionEvents.alreadyLearned,
      topicId: correctionEvents.topicId,
    })
    .from(correctionEvents)
    .innerJoin(correctionTopics, eq(correctionTopics.id, correctionEvents.topicId))
    .where(and(eq(correctionEvents.userId, user.id), gte(correctionEvents.saidAt, sinceIso), ne(correctionTopics.status, "dismissed")));

  const parsed = rows.map((r) => ({ ...r, ms: parseTs(r.saidAt) }));
  const window = parsed.filter((r) => r.ms >= nowMs - days * 86400_000);
  const lastWeek = parsed.filter((r) => r.ms >= nowMs - 7 * 86400_000);

  const weekly = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const endMs = nowMs - 7 * w * 86400_000;
    const chunk = parsed.filter((r) => r.ms >= endMs - 7 * 86400_000 && r.ms < endMs);
    weekly.push({
      end: new Date(endMs).toISOString().replace("Z", "+00:00"),
      total: chunk.length,
      repeat: chunk.filter((r) => r.repeat).length,
      learned_repeat: chunk.filter((r) => r.alreadyLearned).length,
    });
  }

  const counts = new Map<string, number>();
  const learnedCounts = new Map<string, number>();
  for (const r of window) {
    counts.set(r.topicId, (counts.get(r.topicId) ?? 0) + 1);
    if (r.alreadyLearned) learnedCounts.set(r.topicId, (learnedCounts.get(r.topicId) ?? 0) + 1);
  }
  const topIds = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)).slice(0, 8);
  const topicRows = topIds.length ? await db.select().from(correctionTopics).where(inArray(correctionTopics.id, topIds)) : [];
  const topicMap = new Map(topicRows.map((t) => [t.id, t]));

  const [pendingRow] = await db
    .select({ n: count() })
    .from(correctionTopics)
    .where(and(eq(correctionTopics.userId, user.id), eq(correctionTopics.status, "pending")));

  return {
    window_days: days,
    total: window.length,
    repeat: window.filter((r) => r.repeat).length,
    learned_repeat: window.filter((r) => r.alreadyLearned).length,
    learned_repeat_7d: lastWeek.filter((r) => r.alreadyLearned).length,
    pending: Number(pendingRow?.n ?? 0),
    weekly,
    top: topIds
      .filter((id) => topicMap.has(id))
      .map((id) => {
        const t = topicMap.get(id)!;
        return {
          id,
          statement: t.statement,
          status: t.status,
          count: counts.get(id) ?? 0,
          learned_repeat: learnedCounts.get(id) ?? 0,
          last_at: pgToIso(t.lastAt),
        };
      }),
  };
}

export function topicOut(topic: CorrectionTopicRow, quotes: CorrectionEventQuote[] = []) {
  return {
    id: topic.id,
    statement: topic.statement,
    category: topic.category,
    heading: topicHeading(topic),
    scope: topic.scope || "global",
    status: topic.status,
    times: topic.times,
    first_at: pgToIso(topic.firstAt),
    last_at: pgToIso(topic.lastAt),
    quotes: quotes.map((q) => ({ text: q.quote, said_at: pgToIso(q.saidAt) })),
  };
}

export function summarizeNewTopics(statements: string[]): string {
  const head = statements.slice(0, 2).join("；");
  return head + (statements.length > 2 ? ` 等 ${statements.length} 条` : "");
}

/**
 * Soft-dismiss single-occurrence pending correction topics untouched for > staleDays
 * so low-signal one-off phrasing doesn't pile up in the pending queue forever (never hard deleted).
 */
export async function decayStalePendingTopics(db: Db, user: Pick<UserRow, "id">, staleDays = 30, nowMs = Date.now()): Promise<number> {
  const cutoffIso = new Date(nowMs - staleDays * 86400_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const rows = await db
    .update(correctionTopics)
    .set({ status: "dismissed", updatedAt: nowIso })
    .where(
      and(
        eq(correctionTopics.userId, user.id),
        eq(correctionTopics.status, "pending"),
        sql`${correctionTopics.times} <= 1`,
        sql`coalesce(${correctionTopics.lastAt}, ${correctionTopics.updatedAt}, ${correctionTopics.createdAt}) < ${cutoffIso}::timestamptz`,
      ),
    )
    .returning({ id: correctionTopics.id });
  return rows.length;
}
