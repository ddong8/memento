// Todos (services/todo_service.py): the helpers the API needs, matching Python's output byte for byte.
import { createHash } from "node:crypto";

import { and, asc, desc, eq, gte, ilike, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import { cacheDeletePrefix } from "../cache";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { withoutNul } from "../db/client";
import { askConversations, todos } from "../db/pulled/schema";
import { localDate, localMidnight, pgToIso, pyDateFromIso } from "../pytime";
import * as aiHealth from "./ai-health";
import { callPlainChat } from "./ai-provider";
import { safeJsonLoads } from "./dreaming-core";
import { cleanUserVoice, SUBAGENT_PATH_REGEX } from "./dreaming-voice";

export const TITLE_MAX = 200;
export const OPEN_LIMIT = 60;
export type TodoRow = typeof todos.$inferSelect;

/** Python's str[:n] counts code points, not UTF-16 units. */
export const pySlice = (s: string, n: number) => {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(0, n).join("");
};

/** sha1 of the title without whitespace, punctuation and underscores (Python re [\s\W_]+, Unicode-aware). */
export function fingerprint(title: string | null | undefined): string {
  const norm = (title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return createHash("sha1").update(norm, "utf8").digest("hex");
}

/** Python's \s: Unicode whitespace plus the ASCII separators \x1c-\x1f. */
const PY_WS = /[\s\x1c-\x1f\x85]+/gu;

export function cleanTitle(title: string | null | undefined): string {
  return pySlice((title || "").replace(PY_WS, " ").trim(), TITLE_MAX);
}

/** "YYYY-MM-DD" (or another form date.fromisoformat takes) -> that day's local midnight; else null. */
export function parseDue(value: unknown): string | null {
  if (!value) return null;
  const d = pyDateFromIso(String(value));
  return d ? localMidnight(d) : null;
}

export function todoOut(t: TodoRow) {
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    project: t.project,
    status: t.status,
    due: localDate(t.dueAt),
    source: t.source,
    evidence: t.evidence,
    close_evidence: t.closeEvidence,
    source_doc_id: t.sourceDocId,
    created_at: pgToIso(t.createdAt),
    closed_at: pgToIso(t.closedAt),
  };
}

export async function openTodos(db: Db, userId: string, limit = OPEN_LIMIT, project?: string | null): Promise<TodoRow[]> {
  const conds = [eq(todos.userId, userId), eq(todos.status, "open")];
  if (project) conds.push(ilike(todos.project, `%${project.trim()}%`));
  return db
    .select()
    .from(todos)
    .where(and(...conds))
    .orderBy(sql`${todos.dueAt} ASC NULLS LAST`, desc(todos.createdAt))
    .limit(limit);
}

export async function closedTodos(db: Db, userId: string, sinceIso: string, project?: string | null): Promise<TodoRow[]> {
  const conds = [eq(todos.userId, userId), ne(todos.status, "open"), gte(todos.closedAt, sinceIso)];
  if (project) conds.push(ilike(todos.project, `%${project}%`));
  return db.select().from(todos).where(and(...conds)).orderBy(desc(todos.closedAt)).limit(50);
}

/** Counts for the badge: open, overdue (due before today's local midnight), done and added in the last week. */
export async function todoCounts(db: Db, userId: string, days = 7) {
  const nowMs = Date.now();
  const today = localMidnight(new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10));
  const since = new Date(nowMs - days * 86400_000).toISOString();
  const [row] = await db
    .select({
      open: sql<number>`count(*) FILTER (WHERE ${todos.status} = 'open')`.mapWith(Number),
      overdue: sql<number>`count(*) FILTER (WHERE ${todos.status} = 'open' AND ${todos.dueAt} IS NOT NULL AND ${todos.dueAt} < ${today})`.mapWith(Number),
      done: sql<number>`count(*) FILTER (WHERE ${todos.status} = 'done' AND ${todos.closedAt} >= ${since})`.mapWith(Number),
      added: sql<number>`count(*) FILTER (WHERE ${todos.createdAt} >= ${since})`.mapWith(Number),
    })
    .from(todos)
    .where(eq(todos.userId, userId));
  return { open: row?.open || 0, overdue: row?.overdue || 0, done_recent: row?.done || 0, added_recent: row?.added || 0 };
}

/** Add a todo, or return the open one with the same title (filling its empty fields). [todo, created] */
export async function addTodo(
  db: Db,
  userId: string,
  title: string,
  opts: { detail?: string | null; project?: string | null; dueAt?: string | null; source?: string; evidence?: string | null; sourceDocId?: string | null } = {},
): Promise<[TodoRow, boolean]> {
  const clean = cleanTitle(title);
  if (!clean) throw new Error("title is empty");
  const fp = fingerprint(clean);
  const [existing] = await db
    .select()
    .from(todos)
    .where(and(eq(todos.userId, userId), eq(todos.status, "open"), eq(todos.fingerprint, fp)))
    .limit(1);
  if (existing) {
    const fill: Partial<typeof todos.$inferInsert> = {};
    if (!existing.detail && opts.detail) fill.detail = opts.detail;
    if (!existing.dueAt && opts.dueAt) fill.dueAt = opts.dueAt;
    if (!existing.project && opts.project) fill.project = pySlice(opts.project, 120);
    if (!Object.keys(fill).length) return [existing, false];
    const [row] = await db
      .update(todos)
      .set({ ...withoutNul(fill), updatedAt: sql`now()` as unknown as string })
      .where(eq(todos.id, existing.id))
      .returning();
    return [row ?? existing, false];
  }
  const [row] = await db
    .insert(todos)
    .values(
      withoutNul({
        id: crypto.randomUUID(),
        userId,
        title: clean,
        detail: opts.detail || null,
        project: opts.project ? pySlice(opts.project, 120) : null,
        dueAt: opts.dueAt ?? null,
        source: opts.source ?? "manual",
        evidence: opts.evidence || null,
        sourceDocId: opts.sourceDocId ?? null,
        fingerprint: fp,
        status: "open",
      }),
    )
    .returning();
  return [row!, true];
}

export async function closeTodo(db: Db, todoId: string, status: "done" | "dropped" | "open", evidence?: string | null): Promise<void> {
  if (status === "open") {
    await db.update(todos).set({ status, closedAt: null, closeEvidence: null, updatedAt: new Date().toISOString() }).where(eq(todos.id, todoId));
  } else {
    await db
      .update(todos)
      .set({ status, closedAt: new Date().toISOString(), closeEvidence: evidence || null, updatedAt: new Date().toISOString() })
      .where(eq(todos.id, todoId));
  }
}

export function localDayBounds(nowMs = Date.now()): { todayIso: string; tomorrowIso: string; todayMs: number } {
  const local = new Date(nowMs + 8 * 3600_000);
  const dateStr = local.toISOString().slice(0, 10);
  const todayIso = localMidnight(dateStr);
  const todayMs = Date.parse(todayIso);
  const tomorrowIso = new Date(todayMs + 86400_000).toISOString();
  return { todayIso, tomorrowIso, todayMs };
}

export async function dueNow(db: Db, userId: string, nowMs = Date.now()): Promise<{ overdue: TodoRow[]; today: TodoRow[] }> {
  const { tomorrowIso, todayMs } = localDayBounds(nowMs);
  const rows = await db
    .select()
    .from(todos)
    .where(and(eq(todos.userId, userId), eq(todos.status, "open"), isNotNull(todos.dueAt), lt(todos.dueAt, tomorrowIso)))
    .orderBy(asc(todos.dueAt));
  const overdue: TodoRow[] = [];
  const today: TodoRow[] = [];
  for (const t of rows) {
    const raw = t.dueAt || "";
    const ms = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    if (ms < todayMs) overdue.push(t);
    else today.push(t);
  }
  return { overdue, today };
}

export function reminderText(due: { overdue: TodoRow[]; today: TodoRow[] }): [string, string] | null {
  const items = [...due.overdue, ...due.today];
  if (!items.length) return null;
  const parts: string[] = [];
  if (due.today.length) parts.push(`今天到期 ${due.today.length} 条`);
  if (due.overdue.length) parts.push(`逾期 ${due.overdue.length} 条`);
  const body = items.slice(0, 5).map((t) => t.title).join("；") + (items.length > 5 ? "…" : "");
  return [`Memento 待办：${parts.join("，")}`, body];
}

const LATER_RE =
  /待办|todo|记一下|记下来|记得|别忘|提醒我|回头|稍后|晚点|晚些|明天|后天|下周|下个月|周[一二三四五六日天]|星期[一二三四五六日天]|改天|以后再|之后再|有空|下次|先放|先不|暂时不|还要|还得|还需要|还没做|留着|挂起|backlog|\blater\b|tomorrow|next week|remind me/i;
const CLOSE_RE = /搞定|完成了|做完|弄好了|做好了|不用做|不用了|取消|算了|不做了|已经好了|\bdone\b/i;

const TODO_PROMPT = (openText: string, messages: string) => `下面是用户在各个 AI 工具里亲手打的话，每条前面是说话时间（北京时间）和所在项目。请找出其中的"待办"——用户打算以后再做、要记下来的事——以及哪些话说明某条已知待办已经做完或不做了。

## 已知的未完成待办
${openText}

## 用户的原话
${messages}

## 要求
- 待办只算这几种：用户明确把"做这件事"推迟了（"明天再弄""先放着回头处理""下次再说""有空再搞"）；让 AI"记一下 / 记下来 / 提醒我"的事；用户给自己安排、不需要 AI 当场做的事（"下周三要跟张三对一下接口"）。
- 只要这句话是在让 AI 现在就去做某件事，就不是待办——哪怕带着"暂时不要部署""先计划一下怎么做""我还要再加一张表""下周分享要用，帮我写资料"这类限定。这是最常见的误判，务必排除。
- 宁缺毋滥：拿不准就不算。
- title：一句动宾短语，不超过 40 字，说清楚做什么（如"给 memento 的导出接口加分页"）。
- due：用户说了时间就换算成日期 YYYY-MM-DD（以说话那天为准，"明天"就是说话日期加一天）；没说就填 null。
- project：待办所属项目，不确定就用那句话所在的项目。
- 同一件事说了好几次合成一条，i 里列出所有编号。和已知待办是同一件事的不要重复新建。
- close：原话说明某条已知待办已经做完（done）或不做了（dropped），填它的编号（如 "d2"）和依据的原话编号。

只输出 JSON：{"new": [{"i": [1], "title": "...", "detail": "补充说明或 null", "due": null, "project": "..."}], "close": [{"d": "d2", "status": "done", "i": [3]}]}`;

interface SaidTodo {
  messageId: number;
  text: string;
  saidAtMs: number;
  docId: string | null;
  project: string | null;
}

function parseIndices(raw: unknown, size: number): number[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = new Set<number>();
  for (const v of arr) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= size) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export async function learnTodos(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
): Promise<{ scanned: number; created: string[]; closed: number }> {
  const nowMs = Date.now();
  const cursorKey = `todos_cursor:${user.id}`;
  const cursor = await aiHealth.getJson<number | null>(redis, cursorKey);
  let opened = await openTodos(db, user.id);
  const hasOpen = opened.length > 0;
  const backfillIso = new Date(nowMs - 3 * 86400_000).toISOString();

  const rows = (await db.execute(sql`
    SELECT cm.id, cm.content, cm.timestamp, d.id AS doc_id, p.title AS project
    FROM conversation_messages cm
    JOIN documents d ON d.id = cm.document_id
    LEFT JOIN projects p ON p.id = d.project_id
    WHERE d.machine_id IN (SELECT id FROM machines WHERE user_id = ${user.id}::uuid)
      AND cm.role = 'user'
      AND cm.timestamp IS NOT NULL
      AND cm.timestamp >= ${backfillIso}::timestamptz
      AND cm.content NOT LIKE '[Result]%'
      AND NOT (d.relative_path ~ ${SUBAGENT_PATH_REGEX})
      AND NOT coalesce(d.metadata ? 'parent_session_id', false)
      ${cursor != null ? sql`AND cm.id > ${cursor}` : sql``}
    ORDER BY cm.id
    LIMIT 1000
  `)) as unknown as { id: string | number; content: string; timestamp: string; doc_id: string; project: string | null }[];

  const found: SaidTodo[] = [];
  const seenTexts = new Set<string>();
  for (const r of rows) {
    const text = cleanUserVoice(r.content);
    if (!text) continue;
    if (LATER_RE.test(text) || (hasOpen && CLOSE_RE.test(text))) {
      seenTexts.add(text);
      const ts = Date.parse(String(r.timestamp).includes("T") ? String(r.timestamp) : String(r.timestamp).replace(" ", "T"));
      found.push({ messageId: Number(r.id), text, saidAtMs: Number.isFinite(ts) ? ts : nowMs, docId: String(r.doc_id), project: r.project });
    }
  }

  const askCursorKey = `todos_ask_cursor:${user.id}`;
  const askCursorIso = await aiHealth.getJson<string>(redis, askCursorKey);
  const askSinceMs = askCursorIso ? Date.parse(askCursorIso) : nowMs - 86400_000;
  const askSinceIso = new Date(Number.isFinite(askSinceMs) ? askSinceMs : nowMs - 86400_000).toISOString();
  const askConvs = await db
    .select()
    .from(askConversations)
    .where(and(eq(askConversations.userId, user.id), sql`${askConversations.updatedAt} > ${askSinceIso}::timestamptz`))
    .orderBy(asc(askConversations.updatedAt))
    .limit(30);
  let latestAskMs = Number.isFinite(askSinceMs) ? askSinceMs : nowMs - 86400_000;
  for (const conv of askConvs) {
    const updMs = Date.parse(conv.updatedAt.includes("T") ? conv.updatedAt : conv.updatedAt.replace(" ", "T"));
    if (Number.isFinite(updMs) && updMs > latestAskMs) latestAskMs = updMs;
    const cfg = conv.config && typeof conv.config === "object" ? (conv.config as Record<string, unknown>) : {};
    const projName = cfg.project_id ? String(cfg.project_id) : null;
    const turns = Array.isArray(conv.turns) ? (conv.turns as Record<string, unknown>[]) : [];
    turns.forEach((turn, idx) => {
      if (!turn || typeof turn !== "object" || turn.role !== "user" || turn.origin) return;
      const saidMs = turn.created_at ? Date.parse(String(turn.created_at).replace("Z", "+00:00")) : updMs;
      if (!Number.isFinite(saidMs) || saidMs <= askSinceMs) return;
      const text = cleanUserVoice(String(turn.content ?? ""));
      if (text && !seenTexts.has(text) && (LATER_RE.test(text) || (hasOpen && CLOSE_RE.test(text)))) {
        seenTexts.add(text);
        found.push({ messageId: -1 - idx, text, saidAtMs: saidMs, docId: null, project: projName });
      }
    });
  }
  if (latestAskMs > askSinceMs) {
    await aiHealth.putJson(redis, askCursorKey, new Date(latestAskMs).toISOString(), 90 * 86400);
  }

  found.sort((a, b) => a.saidAtMs - b.saidAtMs);
  const nextCursor = rows.length ? Number(rows[rows.length - 1]!.id) : cursor;

  const created: TodoRow[] = [];
  let closed = 0;
  const weekdays = "日一二三四五六";
  for (let start = 0; start < found.length; start += 25) {
    const batch = found.slice(start, start + 25);
    const openText =
      opened.map((t, i) => `d${i + 1}: ${t.title}${t.project ? `（${t.project}）` : ""}`).join("\n") || "（无）";
    const msgs = batch
      .map((s, i) => {
        const local = new Date(s.saidAtMs + 8 * 3600_000);
        const dateStr = local.toISOString().slice(0, 10);
        const hm = local.toISOString().slice(11, 16);
        return `[${i + 1}] (${dateStr} 周${weekdays[local.getUTCDay()]} ${hm} · ${s.project || "未知项目"}) ${s.text}`;
      })
      .join("\n");
    const raw = await callPlainChat(
      settings,
      redis,
      [
        { role: "system", content: "You extract a user's todos from what they typed. Respond only with valid JSON." },
        { role: "user", content: TODO_PROMPT(openText, msgs) },
      ],
      { maxTokens: 1500, background: true, user },
    );
    if (!raw) throw new Error("todo classification got no answer from any AI provider");
    const parsed = safeJsonLoads(raw);
    for (const item of Array.isArray(parsed.new) ? (parsed.new as Record<string, unknown>[]) : []) {
      if (!item || typeof item !== "object") continue;
      const idx = parseIndices(item.i, batch.length);
      const title = cleanTitle(String(item.title ?? ""));
      if (!idx.length || !title) continue;
      const first = batch[idx[0]! - 1]!;
      const [todo, isNew] = await addTodo(db, user.id, title, {
        detail: String(item.detail ?? "").trim() || null,
        project: String(item.project ?? first.project ?? "").trim() || null,
        dueAt: parseDue(item.due),
        source: "voice",
        evidence: idx.map((i) => batch[i - 1]!.text).join(" / ").slice(0, 1000),
        sourceDocId: first.docId,
      });
      if (isNew) {
        created.push(todo);
        opened.push(todo);
      }
    }
    const refs = new Map(opened.map((t, i) => [`d${i + 1}`, t]));
    for (const item of Array.isArray(parsed.close) ? (parsed.close as Record<string, unknown>[]) : []) {
      if (!item || typeof item !== "object") continue;
      const todo = refs.get(String(item.d ?? ""));
      const st = String(item.status ?? "done");
      if (!todo || todo.status !== "open" || (st !== "done" && st !== "dropped")) continue;
      const idx = parseIndices(item.i, batch.length);
      await closeTodo(db, todo.id, st, idx.map((i) => batch[i - 1]!.text).join(" / ").slice(0, 1000) || null);
      todo.status = st;
      closed++;
    }
    opened = opened.filter((t) => t.status === "open");
  }

  if (created.length || closed) await cacheDeletePrefix(redis, `todos:${user.id}:`).catch(() => {});
  await aiHealth.putJson(redis, cursorKey, nextCursor, 90 * 86400);
  return { scanned: found.length, created: created.map((t) => t.title), closed };
}

export { asc };
