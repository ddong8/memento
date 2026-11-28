// Retrieval evaluation against a frozen grounded question set (server/server/services/eval_service.py).
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { documents, evalCases, evalRuns } from "../db/pulled/schema";
import { pgToIso } from "../pytime";
import { callPlainChat } from "./ai-provider";
import { hybridRank, RRF_K, TOP_K } from "./ask-retrieval";
import { safeJsonLoads } from "./dreaming-core";
import { cleanUserVoice, EMBEDDED_CONTEXT_RE, SUBAGENT_PATH_REGEX } from "./dreaming-voice";
import { CHUNK_COUNT_PENALTY, POOL_MIN, POOL_PER_DOC } from "./embedding";
import { COMMON_TERM_SHARE } from "./fulltext";

export type EvalRunRow = typeof evalRuns.$inferSelect;

const SET_SIZE = 60;
const PER_PROJECT = 3;
const DOCS_PER_CALL = 6;
const K = 10;
const REGRESSION = 0.08;
const MRR_REGRESSION = 0.15;
const MIN_CHARS = 800;
const EXCERPT_CHARS = 3000;
const MIN_EVIDENCE = 8;
const STALE_REBUILD = 0.2;
const GENERATED_CATEGORIES = ["discovery", "history", "config", "extension"];
const SPEAKER_RE = /^\s*(?:用户|AI)[：:]\s*/;

export class NoMaterial extends Error {
  constructor(msg = "还没有可出题的资料") {
    super(msg);
    this.name = "NoMaterial";
  }
}

export function scoreRanks(ranks: (number | null)[]): { hit1: number; hit5: number; hit10: number; mrr: number } {
  const n = ranks.length || 1;
  const hit = (k: number) => Math.round((ranks.filter((r) => r !== null && r <= k).length / n) * 10000) / 10000;
  const mrrSum = ranks.reduce<number>((acc, r) => acc + (r ? 1 / r : 0), 0);
  return {
    hit1: hit(1),
    hit5: hit(5),
    hit10: hit(10),
    mrr: Math.round((mrrSum / n) * 10000) / 10000,
  };
}

export function rankOf(expected: string, ordered: string[]): number | null {
  const idx = ordered.slice(0, K).indexOf(expected);
  return idx >= 0 ? idx + 1 : null;
}

export function firstRank(accepted: Set<string>, ordered: string[]): number | null {
  const top = ordered.slice(0, K);
  for (let i = 0; i < top.length; i++) {
    if (accepted.has(top[i]!)) return i + 1;
  }
  return null;
}

function norm(text: string): string {
  return (text || "").replace(/\s+/g, "").toLowerCase();
}

function grounded(evidence: string, passages: string[]): boolean {
  const e = norm(evidence);
  return e.length >= MIN_EVIDENCE && passages.some((p) => norm(p).includes(e));
}

function ahead(expected: string, ordered: string[]): string[] {
  const top = ordered.slice(0, K);
  const idx = top.indexOf(expected);
  return idx >= 0 ? top.slice(0, idx) : top;
}

export async function currentVersion(db: Db, user: Pick<UserRow, "id">): Promise<number | null> {
  const [row] = await db
    .select({ v: sql<number | null>`max(${evalCases.setVersion})` })
    .from(evalCases)
    .where(eq(evalCases.userId, user.id));
  return row?.v != null ? Number(row.v) : null;
}

interface SampleDoc {
  id: string;
  title: string | null;
  category: string;
  aiSummary: string | null;
}

async function sampleDocuments(db: Db, userId: string, size: number): Promise<SampleDoc[]> {
  const rows = (await db.execute(sql`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY coalesce(project_id::text, tool_id)
               ORDER BY random()
             ) AS rn
      FROM documents
      WHERE machine_id IN (SELECT id FROM machines WHERE user_id = ${userId}::uuid)
        AND embedding_status = 'ok'
        AND length(content) >= ${MIN_CHARS}
        AND category NOT IN (${sql.join(GENERATED_CATEGORIES.map((c) => sql`${c}`), sql`, `)})
        AND relative_path !~ ${SUBAGENT_PATH_REGEX}
        AND NOT coalesce(metadata ? 'parent_session_id', false)
    ),
    picked AS (
      SELECT id FROM ranked WHERE rn <= ${PER_PROJECT} ORDER BY random() LIMIT ${size}
    )
    SELECT d.id, d.title, d.category, d.ai_summary
    FROM documents d JOIN picked p ON p.id = d.id
  `)) as unknown as { id: string; title: string | null; category: string; ai_summary: string | null }[];
  return rows.map((r) => ({ id: String(r.id), title: r.title, category: r.category, aiSummary: r.ai_summary }));
}

async function passagesFor(db: Db, doc: SampleDoc): Promise<string[]> {
  if (doc.category !== "conversation") {
    const rows = (await db.execute(sql`SELECT left(content, ${EXCERPT_CHARS}) AS head FROM documents WHERE id = ${doc.id}::uuid`)) as unknown as {
      head: string | null;
    }[];
    return [rows[0]?.head ?? ""];
  }
  const rows = (await db.execute(sql`
    SELECT role, content FROM conversation_messages
    WHERE document_id = ${doc.id}::uuid
      AND role IN ('user', 'assistant')
      AND content NOT LIKE '[Result]%'
      AND content NOT LIKE '[Tool:%'
      AND timestamp IS NOT NULL
    ORDER BY line_number ASC
    LIMIT 80
  `)) as unknown as { role: string; content: string | null }[];
  const out: string[] = [];
  let used = 0;
  for (const r of rows) {
    let text = (r.content || "").trim();
    if (!text || text.startsWith("[AI 思考")) continue;
    if (r.role === "user") {
      if (cleanUserVoice(text) === null) continue;
      text = text.replace(EMBEDDED_CONTEXT_RE, "").trim();
    }
    const line = `${r.role === "user" ? "用户" : "AI"}：${text.slice(0, EXCERPT_CHARS - used)}`;
    if (out.length && out[out.length - 1] === line) continue;
    out.push(line);
    used += line.length;
    if (used >= EXCERPT_CHARS) break;
  }
  return out;
}

const QUESTION_PROMPT = (docs: string) => `下面是一位开发者资料库里的几篇文档（和 AI 的对话、笔记、计划、记忆）。请为每篇写一个他几周后可能会问自己资料库的问题，这个问题的答案就在这篇文档的原文里。

要求：
- 像真人随手问的一样自然，中文，15-40 字。
- 问的是文档里具体的事（某个决定、某个问题怎么解决的、某个配置/命令/数值、某个结论），问题里带上能认出这件事的具体名词（项目、功能、工具、报错）。
- 不要问换一篇文档也成立的泛泛问题，比如用的什么模型、CLI 版本、权限或沙箱设置、系统提示词、"那次会话做了什么"。
- 不要照抄标题，不要出现文件名、路径、会话 ID。
- e 填这篇文档原文里能回答这个问题的那句话，逐字摘抄 10-80 字，不要改写、不要拼接。
- 如果文档内容太杂或没有值得问的，q 填 null。

${docs}

只输出 JSON：{"questions": [{"n": 1, "q": "...", "e": "..."}]}`;

async function questionsFor(
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  docs: SampleDoc[],
  passages: string[][],
): Promise<Map<number, [string, string]>> {
  const blocks = docs.map((d, i) => {
    const summary = d.aiSummary ? `摘要：${d.aiSummary.trim()}\n` : "";
    return `### 文档 ${i + 1}：${d.title || ""}\n${summary}原文：\n${passages[i]!.join("\n").trim()}`;
  });
  const raw = await callPlainChat(
    settings,
    redis,
    [
      { role: "system", content: "You write evaluation questions for a retrieval system. Respond only with valid JSON." },
      { role: "user", content: QUESTION_PROMPT(blocks.join("\n\n")) },
    ],
    { maxTokens: 2000, background: true, user },
  );
  if (!raw) throw new Error("eval question generation got no answer from any AI provider");
  const out = new Map<number, [string, string]>();
  const items = Array.isArray(safeJsonLoads(raw).questions) ? (safeJsonLoads(raw).questions as Record<string, unknown>[]) : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const q = String(item.q ?? "").trim();
    const e = String(item.e ?? "").replace(SPEAKER_RE, "").trim();
    if (q.length < 6 || q.length > 120 || q.toLowerCase() === "null") continue;
    const holders: number[] = [];
    passages.forEach((parts, idx) => {
      if (grounded(e, parts)) holders.push(idx + 1);
    });
    if (holders.length === 1 && !out.has(holders[0]!)) out.set(holders[0]!, [q, e]);
  }
  return out;
}

async function answerStillThere(db: Db, docId: string, category: string, content: string | null, evidence: string): Promise<boolean> {
  const e = norm(evidence);
  if (category !== "conversation") return norm(content || "").includes(e);
  const rows = (await db.execute(sql`
    SELECT 1 FROM conversation_messages
    WHERE document_id = ${docId}::uuid
      AND role IN ('user', 'assistant')
      AND content NOT LIKE '[Result]%'
      AND content NOT LIKE '[Tool:%'
      AND timestamp IS NOT NULL
      AND strpos(lower(regexp_replace(content, '\\s+', '', 'g')), ${e}) > 0
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

async function holdersOf(db: Db, docIds: string[], evidence: string): Promise<Set<string>> {
  const e = norm(evidence || "");
  if (!docIds.length || e.length < MIN_EVIDENCE) return new Set();
  const idList = sql.join(docIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT id AS doc_id FROM documents
    WHERE id IN (${idList}) AND category != 'conversation'
      AND strpos(lower(regexp_replace(coalesce(content, ''), '\\s+', '', 'g')), ${e}) > 0
    UNION
    SELECT document_id AS doc_id FROM conversation_messages
    WHERE document_id IN (${idList})
      AND role IN ('user', 'assistant')
      AND content NOT LIKE '[Result]%'
      AND content NOT LIKE '[Tool:%'
      AND timestamp IS NOT NULL
      AND strpos(lower(regexp_replace(content, '\\s+', '', 'g')), ${e}) > 0
  `)) as unknown as { doc_id: string }[];
  return new Set(rows.map((r) => String(r.doc_id)));
}

export async function buildSet(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  size = SET_SIZE,
): Promise<{ set_version: number; cases: number }> {
  const version = ((await currentVersion(db, user)) ?? 0) + 1;
  const rawDocs = await sampleDocuments(db, user.id, size);
  if (!rawDocs.length) throw new NoMaterial();
  const rawPassages = await Promise.all(rawDocs.map((d) => passagesFor(db, d)));
  const docs: SampleDoc[] = [];
  const passages: string[][] = [];
  rawDocs.forEach((d, i) => {
    const len = rawPassages[i]!.reduce((acc, s) => acc + s.length, 0);
    if (len >= 300) {
      docs.push(d);
      passages.push(rawPassages[i]!);
    }
  });

  let created = 0;
  const asked = new Set<string>();
  for (let start = 0; start < docs.length; start += DOCS_PER_CALL) {
    const chunk = docs.slice(start, start + DOCS_PER_CALL);
    let qs: Map<number, [string, string]>;
    try {
      qs = await questionsFor(settings, redis, user, chunk, passages.slice(start, start + DOCS_PER_CALL));
    } catch {
      continue;
    }
    for (const [n, [q, e]] of qs.entries()) {
      const key = norm(e);
      if (asked.has(key)) continue;
      asked.add(key);
      await db.insert(evalCases).values({
        userId: user.id,
        setVersion: version,
        query: q,
        expectedDocId: chunk[n - 1]!.id,
        evidence: e,
        kind: "doc",
      });
      created++;
    }
  }
  if (created === 0) throw new Error("没有生成任何评测问题（资料太少，或 AI 调用失败）");
  return { set_version: version, cases: created };
}

function evalConfig(settings: Settings) {
  return {
    rrf_k: RRF_K,
    top_k: TOP_K,
    k: K,
    semantic_pool: { min: POOL_MIN, per_doc: POOL_PER_DOC },
    chunk_count_penalty: CHUNK_COUNT_PENALTY,
    common_term_share: COMMON_TERM_SHARE,
    scoring: "any_holder",
    embedding: settings.embeddingModel || "bge-m3",
    build: (settings.buildSha || "").slice(0, 12),
  };
}

export async function runEval(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  trigger = "scheduled",
  setVersion?: number | null,
): Promise<EvalRunRow> {
  let version = setVersion ?? (await currentVersion(db, user));
  if (version === null) version = (await buildSet(db, settings, redis, user)).set_version;

  const allCases = await db
    .select()
    .from(evalCases)
    .where(and(eq(evalCases.userId, user.id), eq(evalCases.setVersion, version)))
    .orderBy(asc(evalCases.id));

  const quotedIds = [...new Set(allCases.filter((c) => c.evidence).map((c) => c.expectedDocId))];
  const textMap = new Map<string, { id: string; category: string; content: string | null }>();
  if (quotedIds.length) {
    const docRows = await db
      .select({
        id: documents.id,
        category: documents.category,
        content: sql<string | null>`CASE WHEN ${documents.category} = 'conversation' THEN NULL ELSE ${documents.content} END`,
      })
      .from(documents)
      .where(inArray(documents.id, quotedIds));
    for (const r of docRows) textMap.set(r.id, r);
  }

  const cases: typeof allCases = [];
  let stale = 0;
  for (const c of allCases) {
    if (c.evidence) {
      const doc = textMap.get(c.expectedDocId);
      if (!doc || !(await answerStillThere(db, doc.id, doc.category, doc.content, c.evidence))) {
        stale++;
        continue;
      }
    }
    cases.push(c);
  }

  const fused: (number | null)[] = [];
  const keyword: (number | null)[] = [];
  const semantic: (number | null)[] = [];
  let semanticEmpty = 0;
  let copies = 0;
  const misses: Record<string, unknown>[] = [];

  for (const c of cases) {
    const { docs, kwOrder, semOrder } = await hybridRank(db, settings, redis, user, c.query, null, null, K);
    const order = docs.map((d) => d.id);
    const expected = c.expectedDocId;
    const otherSet = new Set<string>();
    for (const ranked of [order, kwOrder, semOrder]) {
      for (const id of ahead(expected, ranked)) if (id !== expected) otherSet.add(id);
    }
    const accepted = new Set<string>([expected]);
    if (c.evidence && otherSet.size) {
      for (const h of await holdersOf(db, [...otherSet], c.evidence)) accepted.add(h);
    }
    const r = firstRank(accepted, order);
    fused.push(r);
    if (r !== null && r !== rankOf(expected, order)) copies++;
    keyword.push(firstRank(accepted, kwOrder));
    semantic.push(firstRank(accepted, semOrder));
    if (!semOrder.length) semanticEmpty++;
    if (r === null && misses.length < 10) {
      misses.push({ query: c.query, expected_doc_id: expected, evidence: c.evidence });
    }
  }

  const metrics = {
    hybrid: scoreRanks(fused),
    keyword: scoreRanks(keyword),
    semantic: scoreRanks(semantic),
    semantic_unavailable: semanticEmpty,
    stale,
    answered_by_copy: copies,
    grounded: allCases.some((c) => Boolean(c.evidence)),
    misses,
  };
  const [run] = await db
    .insert(evalRuns)
    .values({
      id: randomUUID(),
      userId: user.id,
      setVersion: version,
      cases: cases.length,
      metrics,
      config: evalConfig(settings),
      trigger,
    })
    .returning();
  return run!;
}

export function needsNewSet(run: EvalRunRow): boolean {
  const m = (run.metrics as Record<string, unknown>) || {};
  if (!m.grounded) return true;
  const stale = Number(m.stale ?? 0);
  const total = run.cases + stale;
  return total > 0 && stale / total >= STALE_REBUILD;
}

export function runOut(run: EvalRunRow) {
  return {
    id: run.id,
    set_version: run.setVersion,
    cases: run.cases,
    metrics: run.metrics || {},
    config: run.config || {},
    trigger: run.trigger,
    created_at: pgToIso(run.createdAt),
  };
}

export async function recentRuns(db: Db, user: Pick<UserRow, "id">, limit = 12): Promise<EvalRunRow[]> {
  return db
    .select()
    .from(evalRuns)
    .where(eq(evalRuns.userId, user.id))
    .orderBy(desc(evalRuns.createdAt))
    .limit(limit);
}

export function regression(runs: EvalRunRow[]): Record<string, unknown> | null {
  if (!runs.length) return null;
  const latest = runs[0]!;
  const earlier = runs.slice(1).filter((r) => r.setVersion === latest.setVersion);
  const metric = (run: EvalRunRow, key: string): number | null => {
    const m = (run.metrics as Record<string, unknown>) || {};
    const h = m.hybrid && typeof m.hybrid === "object" ? (m.hybrid as Record<string, unknown>) : {};
    return typeof h[key] === "number" ? (h[key] as number) : null;
  };
  const checks: [string, (was: number, now: number) => boolean][] = [
    ["hit5", (was, now) => was - now >= REGRESSION],
    ["mrr", (was, now) => was > 0 && (was - now) / was >= MRR_REGRESSION],
  ];
  for (const [key, fell] of checks) {
    const now = metric(latest, key);
    const vals = earlier.map((r) => metric(r, key)).filter((v): v is number => v !== null);
    const was = vals.length ? Math.max(...vals) : null;
    if (now !== null && was !== null && fell(was, now)) {
      return { metric: key, now, was, set_version: latest.setVersion };
    }
  }
  return null;
}

export async function evalSummary(db: Db, user: Pick<UserRow, "id">) {
  const runs = await recentRuns(db, user);
  const latest = runs[0] ?? null;
  const latestMs = latest?.createdAt ? Date.parse(latest.createdAt.includes("T") ? latest.createdAt : latest.createdAt.replace(" ", "T")) : 0;
  return {
    set_version: await currentVersion(db, user),
    latest: latest ? runOut(latest) : null,
    stale: Boolean(latest && latestMs > 0 && Date.now() - latestMs > 10 * 86400_000),
    trend: [...runs].reverse().map((r) => {
      const m = (r.metrics as Record<string, unknown>) || {};
      const h = m.hybrid && typeof m.hybrid === "object" ? (m.hybrid as Record<string, unknown>) : {};
      return {
        at: pgToIso(r.createdAt),
        set_version: r.setVersion,
        hit5: h.hit5 ?? null,
        mrr: h.mrr ?? null,
      };
    }),
    regression: regression(runs),
  };
}
