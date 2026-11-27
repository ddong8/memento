// Session retrospective reviews, failed-task pitfalls & per-device recurring pitfalls (server/server/services/retrospective_service.py).
import { createHash, randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import { deviceTasks, documents, sessionReviews, skills, userMemories } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { pgToIso } from "../pytime";
import * as aiHealth from "./ai-health";
import { callPlainChat } from "./ai-provider";
import { safeJsonLoads } from "./dreaming-core";
import { cleanUserVoice, SUBAGENT_PATH_REGEX } from "./dreaming-voice";
import { recordOnlineGraphObservation } from "./mind-resonance-service";
import { slugify, uniqueSlug, upsertMinedSkill, type SkillRow } from "./skills";
import { addTodo, cleanTitle, closeTodo, openTodos, parseDue, type TodoRow } from "./todos";

const SETTLE_MS = 20 * 60_000;
const WINDOW_MS = 3 * 86400_000;
const BACKFILL_MS = 14 * 86400_000;
const MIN_MESSAGES = 12;
const MIN_TOOL_CALLS = 3;
const MAX_SESSIONS = 12;
const REGROW = 1.25;
const REGROW_MIN_NEW_MSGS = 30;
const MESSAGE_CAP = 700;
const TRANSCRIPT_CHARS = 14000;
const KNOWN_SKILLS = 60;
const KNOWN_PITFALLS = 50;
const PITFALL_MAX = 600;
const MAX_ERRORS = 3;

const ERR_RE =
  /error|failed|failure|traceback|exception|denied|not found|no such file|cannot|can't|fatal|exit code [1-9]|exit status [1-9]|non-zero|refused|timed? ?out|panic|报错|失败|错误|超时|拒绝/i;
const TOOL_RE = /\[Tool: ([^\]]+)\]\n?/;
const TOOL_ARG_KEYS = [
  "command", "cmd", "commandline", "file_path", "absolutepath", "targetfile", "path",
  "pattern", "url", "query", "prompt", "description",
];

const HARNESS_RE =
  /独立\s*的?\s*shell|工作目录不(会)?(保留|延续|保持)|先\s*read|has not been read|tool_use_error|blocked:\s*sleep|sleep.{0,12}拦截|工具参数|invalid tool|InputValidationError/i;
const SLIP_RE =
  /view_file|replace_file_content|multi_replace|manage_task|old_string|(target|目标)\s*(文本|内容|字符串)?.{0,12}(不匹配|找不到|匹配不上)|task is not running|已结束.{0,10}kill|kill.{0,10}已结束|(转入|转成|被转为|转到)后台|(输出|结果|diff).{0,8}(过长|太长).{0,6}截断|引号.{0,15}(破坏|转义失败|被吞|吞掉|被.{0,8}(解析|展开))|转义.{0,6}失败|猜(测|错)?的?.{0,6}(表名|列名|路径|run id|pod|任务号|文件名)|沙箱(拒绝|拦截)/i;

const MACHINE_RE =
  /command not found|is not recognized|无法将.{0,20}识别为|不是(内部或外部|可用的?|有效的?)?命令|找不到(该)?命令|命令(不存在|不可用|找不到)|(不存在|没有)\s*[\w.+-]{1,24}\s*(命令|可执行)|(未|没有?)安装|not installed|PowerShell|cmd\.exe|cmdlet|ParserError|\bzsh\b|非交互|login shell|GBK|乱码|编码|\bencoding\b|Unicode(De|En)codeError|(git|npm|pnpm|pip|uv|curl|push|pull|clone|下载|拉取)\S{0,6}\s*(因|走|经|用|的)?\s*(代理|proxy)|https?_proxy|镜像源|容器(内|里)(没有|缺)|Windows\s*的?\s*(绝对)?路径|盘符|反斜杠|\bPATH\b|\bLANG=|\bLC_ALL\b/i;

const MANUAL_OPS_RE =
  /kubectl\s+(-n\s+\S+\s+)?(apply|edit|patch|set|delete|scale|rollout)\b|kubectl\s.{0,60}\b(psql|alter|update|delete)\b|ALTER\s+TABLE|DROP\s+TABLE|docker\s+build/i;

export const PITFALL_KINDS =
  "kind 只能是 env 或 slip。env：换一个 AI 来也会踩、记下来能避开的事实——用户某台机器或某个 shell 的特性" +
  "（缺某个命令、PowerShell 不支持 &&、macOS 没有 timeout、某目录 I/O 挂起）、项目约定（测试要用 uv run）、" +
  "表结构、某个服务/接口/客户端的行为，以及用户代码或服务里真实缺陷的根因和修法。slip：AI 自己这一次的操作失误，" +
  "或 AI 工具自身的机制——内联脚本的引号/转义写坏、猜路径/表名/列名/任务号/pod 名、文件名打错、文件查看或编辑工具" +
  "报错（目标文本不匹配、大文件读不出、换行被改坏）、后台任务轮询或去 kill 已结束的任务、输出太长被截断、沙箱拦截、" +
  "AI 工具自己的额度或 429、写文件前要先读、每次 Bash 是独立 shell、这次会话刚写出又当场改好的类型或语法错误、" +
  "自己写的一次性脚本里的 bug。slip 也照样列出、标上 kind，由程序过滤。";

function squash(text: string | null | undefined): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

export function isHarnessPitfall(item: Record<string, unknown>): boolean {
  if (String(item.kind ?? "").trim().toLowerCase() === "slip") return true;
  const failed = ["title", "symptom", "cause"].map((k) => String(item[k] ?? "")).join(" ");
  return HARNESS_RE.test(`${failed} ${String(item.fix ?? "")}`) || SLIP_RE.test(failed);
}

export function isSlipMemory(content: string | null | undefined): boolean {
  const s = content || "";
  const idx = s.indexOf("；解决：");
  const failed = idx >= 0 ? s.slice(0, idx) : s;
  const fix = idx >= 0 ? s.slice(idx + 4) : "";
  return isHarnessPitfall({ title: failed, fix });
}

export function isMachinePitfall(content: string | null | undefined): boolean {
  const s = content || "";
  const idx = s.indexOf("；解决：");
  const failed = idx >= 0 ? s.slice(0, idx) : s;
  const fix = idx >= 0 ? s.slice(idx + 4) : "";
  return MACHINE_RE.test(failed) && !MANUAL_OPS_RE.test(fix);
}

export function formatPitfall(item: Record<string, unknown>, project: string | null): string {
  const f = (k: string, lim: number) => squash(String(item[k] ?? "")).slice(0, lim);
  const head = project ? `【${project}】` : "";
  return `${head}${f("title", 80)}。现象：${f("symptom", 200)}；原因：${f("cause", 160)}；解决：${f("fix", 200)}`.slice(0, PITFALL_MAX);
}

export function pitfallKey(title: string): string {
  return `pitfall_${createHash("sha1").update((title || "").trim().toLowerCase()).digest("hex").slice(0, 10)}`;
}

export function projectKey(name: string | null | undefined): string {
  const leaf = (name || "").trim().split("/").pop()?.toLowerCase() ?? "";
  return leaf.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "general";
}

export async function savePitfall(
  db: Db,
  redis: Redis | null,
  user: Pick<UserRow, "id">,
  item: Record<string, unknown>,
  project: string | null,
  source: string,
): Promise<typeof userMemories.$inferSelect | null> {
  if (!["title", "symptom", "fix"].every((k) => String(item[k] ?? "").trim()) || isHarnessPitfall(item)) return null;
  const display = (project || String(item.project ?? "")).trim().split("/").pop() || null;
  const folder = projectKey(display);
  const key = pitfallKey(String(item.title));
  const [exists] = await db
    .select({ id: userMemories.id })
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), eq(userMemories.category, "pitfall"), eq(userMemories.key, key)))
    .limit(1);
  if (exists) return null;

  const nowIso = new Date().toISOString();
  const [mem] = await db
    .insert(userMemories)
    .values(
      withoutNul({
        id: randomUUID(),
        userId: user.id,
        category: "pitfall",
        key,
        content: formatPitfall(item, display),
        confidence: 0.85,
        source,
        treePath: `/pitfall/${folder}/${key}`,
        isFolder: false,
        recallCount: 0,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
    )
    .returning();

  await recordOnlineGraphObservation(
    db,
    redis,
    user.id,
    display || "工程实践",
    `${item.title}：原因【${item.cause ?? ""}】，解决【${item.fix}】`,
    { entityType: display ? "project" : "concept", summary: `避坑指南: ${item.title}` },
  ).catch(() => {});
  await cacheDeletePrefix(redis, `memory:resonance:${user.id}`).catch(() => {});
  await cacheDeletePrefix(redis, `learning:check:${user.id}`).catch(() => {});
  return mem ?? null;
}

function toolSummary(name: string, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return name;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const lower: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parsed)) lower[k.toLowerCase()] = v;
        for (const k of TOOL_ARG_KEYS) if (lower[k]) return `${name}: ${String(lower[k]).slice(0, 200)}`;
        return `${name}: ${JSON.stringify(lower).slice(0, 160)}`;
      }
    } catch {
      /* fall through */
    }
  }
  return `${name}: ${trimmed.slice(0, 160)}`;
}

export function condense(
  messages: { role: string | null; content: string | null; messageType?: string | null; toolName?: string | null; toolInput?: string | null }[],
): string {
  const lines: string[] = [];
  for (const m of messages) {
    const content = m.content || "";
    if (m.role === "tool" && m.messageType === "tool_call") {
      const name = m.toolName || content.trim().replace(/^\[+|\]+$/g, "") || "tool";
      lines.push(`  ⚙ ${toolSummary(name, m.toolInput || "")}`);
      continue;
    }
    if (m.role === "user") {
      if (content.startsWith("[Result]")) {
        const body = content.slice("[Result]".length).trim();
        if (ERR_RE.test(body.slice(0, 2000))) lines.push(`  ↳ 出错: ${squash(body).slice(0, 240)}`);
        continue;
      }
      const voice = cleanUserVoice(content);
      if (voice) lines.push(`【用户】${voice.slice(0, 400)}`);
      continue;
    }
    if (m.role === "assistant") {
      const parts = content.split(TOOL_RE);
      const text = parts[0]?.trim();
      if (text) lines.push(`【AI】${squash(text).slice(0, 300)}`);
      for (let i = 1; i < parts.length - 1; i += 2) {
        lines.push(`  ⚙ ${toolSummary(parts[i]!, parts[i + 1] || "")}`);
      }
      if (m.toolName) lines.push(`  ⚙ ${toolSummary(m.toolName, m.toolInput || "")}`);
      continue;
    }
    if (ERR_RE.test(content.slice(0, 2000))) lines.push(`  ↳ 出错: ${squash(content).slice(0, 240)}`);
  }
  const text = lines.join("\n");
  if (text.length <= TRANSCRIPT_CHARS) return text;
  const head = Math.floor(TRANSCRIPT_CHARS / 4);
  return `${text.slice(0, head)}\n…（中间省略）…\n${text.slice(-(TRANSCRIPT_CHARS - head))}`;
}

interface Candidate {
  docId: string;
  title: string;
  toolId: string;
  project: string | null;
  projectSlug: string | null;
  messages: number;
  toolCalls: number;
  lastAtIso: string;
  prevMessages: number;
}

async function pickSessions(db: Db, userId: string, sinceMs: number, nowMs: number): Promise<Candidate[]> {
  const sinceIso = new Date(sinceMs).toISOString();
  const settleIso = new Date(nowMs - SETTLE_MS).toISOString();
  const rows = (await db.execute(sql`
    SELECT d.id, d.title, d.tool_id, p.title AS project, p.slug AS project_slug,
           count(cm.id)::int AS n_msgs,
           sum(CASE WHEN cm.message_type = 'tool_call'
                      OR (cm.role = 'assistant' AND cm.metadata ? 'tool_name')
                      OR cm.content LIKE '%[Tool:%' THEN 1 ELSE 0 END)::int AS n_tools,
           max(cm.timestamp) AS last_at
    FROM documents d
    JOIN conversation_messages cm ON cm.document_id = d.id
    LEFT JOIN projects p ON p.id = d.project_id
    WHERE d.machine_id IN (SELECT id FROM machines WHERE user_id = ${userId}::uuid)
      AND d.category = 'conversation'
      AND d.synced_at >= ${sinceIso}::timestamptz
      AND d.relative_path !~ ${SUBAGENT_PATH_REGEX}
      AND NOT coalesce(d.metadata ? 'parent_session_id', false)
    GROUP BY d.id, d.title, d.tool_id, p.title, p.slug
    HAVING count(cm.id) >= ${MIN_MESSAGES}
       AND max(cm.timestamp) <= ${settleIso}::timestamptz
       AND max(cm.timestamp) >= ${sinceIso}::timestamptz
  `)) as unknown as {
    id: string;
    title: string | null;
    tool_id: string;
    project: string | null;
    project_slug: string | null;
    n_msgs: number;
    n_tools: number | null;
    last_at: string;
  }[];

  if (!rows.length) return [];
  const docIds = rows.map((r) => String(r.id));
  const revRows = await db
    .select({
      docId: sessionReviews.documentId,
      messageCount: sessionReviews.messageCount,
      outcome: sessionReviews.outcome,
      result: sessionReviews.result,
    })
    .from(sessionReviews)
    .where(inArray(sessionReviews.documentId, docIds));
  const reviewed = new Map(revRows.map((r) => [r.docId, r]));

  const out: Candidate[] = [];
  for (const r of rows) {
    const tools = Number(r.n_tools ?? 0);
    if (tools < MIN_TOOL_CALLS) continue;
    const before = reviewed.get(String(r.id));
    let prevCount = 0;
    if (before) {
      prevCount = before.messageCount || 0;
      const resObj = before.result && typeof before.result === "object" ? (before.result as Record<string, unknown>) : {};
      if (before.outcome === "error") {
        if (Number(resObj.errors ?? 0) >= MAX_ERRORS) continue;
      } else if (r.n_msgs < prevCount * REGROW && r.n_msgs - prevCount < REGROW_MIN_NEW_MSGS) {
        continue;
      }
    }
    out.push({
      docId: String(r.id),
      title: r.title || "",
      toolId: r.tool_id,
      project: r.project,
      projectSlug: r.project_slug,
      messages: Number(r.n_msgs),
      toolCalls: tools,
      lastAtIso: pgToIso(String(r.last_at)) ?? new Date(nowMs).toISOString().replace("Z", "+00:00"),
      prevMessages: prevCount,
    });
  }
  out.sort((a, b) => b.toolCalls - a.toolCalls || b.messages - a.messages);
  return out.slice(0, MAX_SESSIONS);
}

async function loadTranscript(db: Db, docId: string, prevMessages = 0): Promise<string> {
  const startLine = prevMessages > 0 ? Math.max(0, prevMessages - 20) : 0;
  const lineCond = prevMessages > 0 ? sql`AND line_number >= ${startLine}` : sql``;
  const countRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM conversation_messages WHERE document_id = ${docId}::uuid ${lineCond}
  `)) as unknown as { n: number }[];
  const total = Number(countRows[0]?.n ?? 0);

  type MsgRow = { role: string | null; content: string | null; message_type: string | null; tool_name: string | null; tool_input: string | null };
  let rows: MsgRow[];
  if (total <= MESSAGE_CAP) {
    rows = (await db.execute(sql`
      SELECT role, content, message_type, metadata->>'tool_name' AS tool_name, metadata->>'tool_input' AS tool_input
      FROM conversation_messages
      WHERE document_id = ${docId}::uuid ${lineCond}
      ORDER BY line_number ASC
    `)) as unknown as MsgRow[];
  } else {
    const headLim = Math.floor(MESSAGE_CAP / 5);
    const tailLim = MESSAGE_CAP - headLim;
    const head = (await db.execute(sql`
      SELECT role, content, message_type, metadata->>'tool_name' AS tool_name, metadata->>'tool_input' AS tool_input
      FROM conversation_messages
      WHERE document_id = ${docId}::uuid ${lineCond}
      ORDER BY line_number ASC LIMIT ${headLim}
    `)) as unknown as MsgRow[];
    const tail = (await db.execute(sql`
      SELECT role, content, message_type, metadata->>'tool_name' AS tool_name, metadata->>'tool_input' AS tool_input
      FROM conversation_messages
      WHERE document_id = ${docId}::uuid ${lineCond}
      ORDER BY line_number DESC LIMIT ${tailLim}
    `)) as unknown as MsgRow[];
    rows = [
      ...head,
      { role: "assistant", content: "（中间省略了较早的消息）", message_type: null, tool_name: null, tool_input: null },
      ...tail.reverse(),
    ];
  }
  return condense(
    rows.map((r) => ({ role: r.role, content: r.content, messageType: r.message_type, toolName: r.tool_name, toolInput: r.tool_input })),
  );
}

interface KnownItems {
  skills: Map<string, SkillRow>;
  pitfalls: Map<string, typeof userMemories.$inferSelect>;
  todos: Map<string, TodoRow>;
}

async function loadKnown(db: Db, userId: string, project: string | null): Promise<KnownItems> {
  const skillRows = await db
    .select()
    .from(skills)
    .where(eq(skills.userId, userId))
    .orderBy(sql`${skills.lastSeenAt} DESC NULLS LAST`)
    .limit(KNOWN_SKILLS);
  const pitfallRows = (
    await db
      .select()
      .from(userMemories)
      .where(and(eq(userMemories.userId, userId), eq(userMemories.category, "pitfall"), eq(userMemories.status, "active")))
      .orderBy(desc(userMemories.updatedAt))
      .limit(400)
  ).filter((m) => !isSlipMemory(m.content));
  if (project) {
    const mark = `/pitfall/${projectKey(project)}/`;
    pitfallRows.sort((a, b) => Number(!(a.treePath || "").toLowerCase().includes(mark)) - Number(!(b.treePath || "").toLowerCase().includes(mark)));
  }
  const todoRows = await openTodos(db, userId);
  return {
    skills: new Map(skillRows.map((s, i) => [`s${i + 1}`, s])),
    pitfalls: new Map(pitfallRows.slice(0, KNOWN_PITFALLS).map((m, i) => [`p${i + 1}`, m])),
    todos: new Map(todoRows.map((t, i) => [`d${i + 1}`, t])),
  };
}

function renderKnown(known: KnownItems): { skillsText: string; pitfallsText: string; todosText: string } {
  const stLabel: Record<string, string> = { draft: "草稿", published: "已发布", dismissed: "用户不要", retired: "已停用" };
  const skillsText =
    [...known.skills.entries()].map(([ref, s]) => `${ref} [${stLabel[s.status] ?? s.status}] ${s.slug}：${s.description.slice(0, 120)}`).join("\n") ||
    "（无）";
  const pitfallsText = [...known.pitfalls.entries()].map(([ref, m]) => `${ref} ${m.content.slice(0, 140)}`).join("\n") || "（无）";
  const todosText =
    [...known.todos.entries()].map(([ref, t]) => `${ref} ${t.title}${t.project ? `（${t.project}）` : ""}`).join("\n") || "（无）";
  return { skillsText, pitfallsText, todosText };
}

async function recordReview(db: Db, userId: string, cand: Candidate, outcome: string, summary: string | null, result: Record<string, unknown>) {
  const nowIso = new Date().toISOString();
  await db
    .insert(sessionReviews)
    .values(withoutNul({ documentId: cand.docId, userId, messageCount: cand.messages, outcome, summary, result, reviewedAt: nowIso }))
    .onConflictDoUpdate({
      target: sessionReviews.documentId,
      set: { messageCount: cand.messages, outcome, summary, result, reviewedAt: nowIso },
    });
}

export async function reviewSession(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  cand: Candidate,
): Promise<Record<string, unknown>> {
  const transcript = await loadTranscript(db, cand.docId, cand.prevMessages);
  const known = await loadKnown(db, user.id, cand.project);
  const { skillsText, pitfallsText, todosText } = renderKnown(known);

  const prompt = `你在帮一位开发者复盘他和 AI 编程工具的一次会话，目的是让以后的 AI 少走弯路。下面是会话的压缩记录：【用户】是他亲手打的话，【AI】是 AI 的回复，⚙ 是 AI 调用的工具，↳ 出错 是失败的工具结果。

## 会话
工具：${cand.toolId}　项目：${cand.project || "未知"}　标题：${cand.title || "（无标题）"}
${transcript}

## 已经学到的技能
${skillsText}

## 已经记下的坑
${pitfallsText}

## 还没完成的待办
${todosText}

## 请提炼
1. outcome：done（目标达成）| partial（做了一部分）| failed（没做成）| chat（只是聊天/问答，没干活）。summary：一句话说这次会话干了什么、结果如何。
2. skill：只有当这次会话**成功完成**了一个多步骤流程、而且这个流程绑定了用户自己的环境（他的项目、机器、服务、目录、命令），以后很可能再做时才填，否则填 null。通用知识（怎么写 Python、git 基本用法）不算。
   - 步骤必须来自会话里真实执行过、最终成功的命令和操作，不许编造；失败绕过的弯路写成"注意"。
   - body：Markdown，按"## 何时使用 / ## 步骤（编号，带具体命令和路径）/ ## 验证 / ## 注意"组织，写给 AI 看的祈使句。
   - description：一句话说清"做什么 + 什么时候用"，AI 靠它决定是否调用，60-200 字。slug：英文小写加连字符，如 memento-gitops-deploy。title：中文短名。
   - 如果和已知技能是同一件事，match 填它的编号（如 "s2"），changes 写这次比已知版本多了/改了什么（没有变化就填空字符串）。用户不要的技能不要再提。
3. pitfalls：这次会话里**真实发生**的失败，且找到了原因和解法。每条写清 kind、title（一句话）、symptom（报错/现象，保留关键原文）、cause（根因）、fix（怎么解决的）。只是猜测、没解决的不算。和已记下的坑是同一个的，match 填它的编号（如 "p3"），其余字段照样填。
   - ${PITFALL_KINDS}
4. todos_new：会话结束时还没做完、而用户明确想做的事（用户说了以后再做，或 AI 提出后用户同意留到以后）。AI 自己随口建议但用户没回应的不算。title 是动宾短语，due 为 YYYY-MM-DD 或 null。
5. todos_done：已知待办里，这次会话明确做完了的，填编号（如 "d1"）和一句依据。

宁缺毋滥：拿不准就不填。只输出 JSON：
{"outcome": "done", "summary": "...", "skill": null, "pitfalls": [], "todos_new": [], "todos_done": []}
skill 的格式：{"match": null, "slug": "...", "title": "...", "description": "...", "body": "...", "project": "...", "changes": ""}
pitfall 的格式：{"kind": "env", "match": null, "title": "...", "symptom": "...", "cause": "...", "fix": "...", "project": "..."}
todo 的格式：{"title": "...", "detail": null, "due": null}；done 的格式：{"d": "d1", "evidence": "..."}`;

  const raw = await callPlainChat(
    settings,
    redis,
    [
      { role: "system", content: "You review a developer's AI coding session to extract reusable lessons. Respond only with valid JSON." },
      { role: "user", content: prompt },
    ],
    { maxTokens: 3000, timeoutSec: 180, background: true, user },
  );
  if (!raw) throw new Error("session review got no answer from any AI provider");
  const data = safeJsonLoads(raw);
  const nowIso = new Date().toISOString();
  const evidence = { doc_id: cand.docId, title: cand.title.slice(0, 120), tool_id: cand.toolId, at: cand.lastAtIso };
  const result: Record<string, unknown> = {
    skill: null,
    skill_event: null,
    pitfalls_new: 0,
    pitfalls_seen: [] as string[],
    pitfalls_added: [] as string[],
    slips: 0,
    todos_new: 0,
    todos_done: 0,
  };

  const skill = data.skill;
  if (skill && typeof skill === "object" && !Array.isArray(skill)) {
    const sk = skill as Record<string, unknown>;
    if (String(sk.description ?? "").trim() && String(sk.body ?? "").trim()) {
      const existing = known.skills.get(String(sk.match ?? "")) ?? null;
      const slug = existing ? existing.slug : await uniqueSlug(db, user, slugify(String(sk.slug ?? ""), String(sk.title ?? "")));
      if (!sk.project) sk.project = cand.project;
      const up = await upsertMinedSkill(db, user, sk, existing, evidence, slug, nowIso);
      result.skill = up.skill.slug;
      result.skill_event = up.event;
    }
  }

  for (const item of Array.isArray(data.pitfalls) ? (data.pitfalls as Record<string, unknown>[]) : []) {
    if (!item || typeof item !== "object") continue;
    if (isHarnessPitfall(item)) {
      result.slips = Number(result.slips) + 1;
      continue;
    }
    const matched = known.pitfalls.get(String(item.match ?? ""));
    if (matched) {
      (result.pitfalls_seen as string[]).push(matched.id);
      await db.execute(sql`UPDATE user_memories SET last_recalled_at = ${nowIso}::timestamptz, updated_at = updated_at WHERE id = ${matched.id}::uuid`);
      continue;
    }
    const mem = await savePitfall(db, redis, user, item, cand.project, "outcome");
    if (mem) {
      result.pitfalls_new = Number(result.pitfalls_new) + 1;
      (result.pitfalls_added as string[]).push(mem.id);
    }
  }

  for (const item of Array.isArray(data.todos_new) ? (data.todos_new as Record<string, unknown>[]) : []) {
    if (!item || typeof item !== "object" || !cleanTitle(String(item.title ?? ""))) continue;
    const [, created] = await addTodo(db, user.id, String(item.title), {
      detail: String(item.detail ?? "").trim() || null,
      project: cand.project || null,
      dueAt: parseDue(item.due),
      source: "session",
      evidence: `会话「${cand.title.slice(0, 60)}」结束时还没做完`,
      sourceDocId: cand.docId,
    });
    if (created) result.todos_new = Number(result.todos_new) + 1;
  }

  for (const item of Array.isArray(data.todos_done) ? (data.todos_done as Record<string, unknown>[]) : []) {
    if (!item || typeof item !== "object") continue;
    const todo = known.todos.get(String(item.d ?? ""));
    if (todo && todo.status === "open") {
      await closeTodo(db, todo.id, "done", `会话「${cand.title.slice(0, 60)}」：${String(item.evidence ?? "").slice(0, 300)}`);
      todo.status = "done";
      result.todos_done = Number(result.todos_done) + 1;
    }
  }

  const rawOut = String(data.outcome ?? "unknown");
  const outcome = ["done", "partial", "failed", "chat"].includes(rawOut) ? rawOut : "unknown";
  await recordReview(db, user.id, cand, outcome, String(data.summary ?? "").slice(0, 500), result);
  return result;
}

export async function reviewSessions(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  nowMs = Date.now(),
) {
  const [firstRow] = await db.select({ n: count() }).from(sessionReviews).where(eq(sessionReviews.userId, user.id));
  const firstRun = Number(firstRow?.n ?? 0) === 0;
  const candidates = await pickSessions(db, user.id, nowMs - (firstRun ? BACKFILL_MS : WINDOW_MS), nowMs);
  const totals = {
    reviewed: 0,
    failed: 0,
    skills_new: [] as string[],
    skill_updates: 0,
    pitfalls_new: 0,
    todos_new: 0,
    todos_done: 0,
  };
  for (const cand of candidates) {
    try {
      const res = await reviewSession(db, settings, redis, user, cand);
      totals.reviewed++;
      if (res.skill_event === "new" && typeof res.skill === "string") totals.skills_new.push(res.skill);
      else if (res.skill_event === "update_pending") totals.skill_updates++;
      totals.pitfalls_new += Number(res.pitfalls_new ?? 0);
      totals.todos_new += Number(res.todos_new ?? 0);
      totals.todos_done += Number(res.todos_done ?? 0);
    } catch (e) {
      const err = e as Error;
      totals.failed++;
      const [prior] = await db.select().from(sessionReviews).where(eq(sessionReviews.documentId, cand.docId)).limit(1);
      const priorRes = prior?.result && typeof prior.result === "object" ? (prior.result as Record<string, unknown>) : {};
      const errors = (prior?.outcome === "error" ? Number(priorRes.errors ?? 0) : 0) + 1;
      await recordReview(db, user.id, cand, "error", `${err?.name || "Error"}: ${err?.message || String(e)}`.slice(0, 300), { errors });
    }
  }
  return totals;
}

function taskLine(t: typeof deviceTasks.$inferSelect): string {
  const payload = t.payload && typeof t.payload === "object" ? (t.payload as Record<string, unknown>) : {};
  const what = String(payload.command ?? payload.prompt ?? t.action);
  const out = (t.stderr || t.error || t.stdout || "").trim();
  return (
    `- [${t.status} exit=${t.exitCode ?? ""}] ${t.action}: ${what.slice(0, 300)}` +
    (payload.cwd ? ` (cwd ${payload.cwd})` : "") +
    (out ? `\n  输出: ${squash(out).slice(-500)}` : "")
  );
}

export async function learnFromTasks(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  nowMs = Date.now(),
): Promise<{ tasks: number; pitfalls_new: number }> {
  const cursorKey = `task_outcomes_cursor:${user.id}`;
  const cursor = await aiHealth.getJson<string>(redis, cursorKey);
  const sinceIso = cursor ? cursor : new Date(nowMs - 14 * 86400_000).toISOString();
  const failed = await db
    .select()
    .from(deviceTasks)
    .where(
      and(
        eq(deviceTasks.userId, user.id),
        inArray(deviceTasks.status, ["failed", "timeout"]),
        inArray(deviceTasks.action, ["shell", "agent"]),
        sql`${deviceTasks.finishedAt} > ${sinceIso}::timestamptz`,
      ),
    )
    .orderBy(asc(deviceTasks.finishedAt))
    .limit(30);
  if (!failed.length) {
    await aiHealth.putJson(redis, cursorKey, new Date(nowMs).toISOString(), 90 * 86400);
    return { tasks: 0, pitfalls_new: 0 };
  }

  const blocks: string[] = [];
  for (const t of failed) {
    const finIso = t.finishedAt || t.createdAt;
    const finMs = Date.parse(finIso.includes("T") ? finIso : finIso.replace(" ", "T"));
    const afterEndIso = new Date((Number.isFinite(finMs) ? finMs : nowMs) + 60 * 60_000).toISOString();
    const [after] = await db
      .select()
      .from(deviceTasks)
      .where(
        and(
          eq(deviceTasks.deviceId, t.deviceId),
          eq(deviceTasks.status, "succeeded"),
          sql`${deviceTasks.createdAt} > ${finIso}::timestamptz`,
          sql`${deviceTasks.createdAt} <= ${afterEndIso}::timestamptz`,
        ),
      )
      .orderBy(asc(deviceTasks.createdAt))
      .limit(1);
    blocks.push(taskLine(t) + (after ? `\n  之后成功的: ${taskLine(after)}` : ""));
  }

  const known = await loadKnown(db, user.id, null);
  const { pitfallsText } = renderKnown(known);
  const prompt = `下面是 AI agent 在用户设备上执行失败的任务，以及同一台设备之后成功的任务（可能就是修好的做法）。请提炼出以后值得提醒 AI 的"坑"：什么操作、为什么失败、正确做法是什么。

## 已经记下的坑
${pitfallsText}

## 任务
${blocks.join("\n").slice(0, 12000)}

要求：只写能从上面的输出里看出原因的；看不出原因、或只是偶发网络抖动的不写。和已记下的坑是同一个的，match 填它的编号。
${PITFALL_KINDS}这些命令是 Memento 的助手发到这台设备上的，所以这台设备用什么 shell、缺什么命令算 env。
只输出 JSON：{"pitfalls": [{"kind": "env", "match": null, "title": "...", "symptom": "...", "cause": "...", "fix": "...", "project": null}]}`;

  const raw = await callPlainChat(
    settings,
    redis,
    [
      { role: "system", content: "You extract lessons from failed commands. Respond only with valid JSON." },
      { role: "user", content: prompt },
    ],
    { maxTokens: 2000, background: true, user },
  );
  if (!raw) throw new Error("task outcome review got no answer from any AI provider");
  let created = 0;
  for (const item of Array.isArray(safeJsonLoads(raw).pitfalls) ? (safeJsonLoads(raw).pitfalls as Record<string, unknown>[]) : []) {
    if (item && typeof item === "object" && !known.pitfalls.get(String(item.match ?? ""))) {
      if (await savePitfall(db, redis, user, item, null, "agent_task")) created++;
    }
  }
  const lastFin = failed.map((t) => t.finishedAt).filter((x): x is string => Boolean(x)).sort().pop();
  if (lastFin) await aiHealth.putJson(redis, cursorKey, pgToIso(lastFin) ?? lastFin, 90 * 86400);
  return { tasks: failed.length, pitfalls_new: created };
}

export async function pitfallsInForce(db: Db, userId: string, ids: Set<string>): Promise<Map<string, [string, string]>> {
  const wanted = new Set<string>();
  for (const id of ids) {
    const u = normalizeUuid(id);
    if (u) wanted.add(u);
  }
  const rows = new Map<string, { id: string; content: string; status: string; supersededBy: string | null }>();
  let frontier = [...wanted];
  for (let hop = 0; hop < 4 && frontier.length; hop++) {
    const found = await db
      .select({
        id: userMemories.id,
        content: userMemories.content,
        status: userMemories.status,
        supersededBy: userMemories.supersededBy,
      })
      .from(userMemories)
      .where(and(eq(userMemories.userId, userId), eq(userMemories.category, "pitfall"), inArray(userMemories.id, frontier)));
    for (const r of found) rows.set(r.id, r);
    const next: string[] = [];
    for (const r of found) {
      if (r.status === "superseded" && r.supersededBy && !rows.has(r.supersededBy)) next.push(r.supersededBy);
    }
    frontier = [...new Set(next)];
  }
  const out = new Map<string, [string, string]>();
  for (const pid of wanted) {
    let row = rows.get(pid);
    let hops = 0;
    while (row && row.status === "superseded" && row.supersededBy && hops < 4) {
      row = rows.get(row.supersededBy);
      hops++;
    }
    if (row && row.status === "active" && !isSlipMemory(row.content)) {
      out.set(pid, [row.id, row.content]);
    }
  }
  return out;
}

function reviewPitfallIds(result: unknown): [string[], string[]] {
  const obj = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  const seen = Array.isArray(obj.pitfalls_seen) ? obj.pitfalls_seen.map(String) : [];
  const added = Array.isArray(obj.pitfalls_added) ? obj.pitfalls_added.map(String) : [];
  return [seen, added];
}

export function pitfallsHitAgain(result: unknown, inForce: Map<string, [string, string]>): string[] {
  const [seen, added] = reviewPitfallIds(result);
  const hits: string[] = [];
  const seenSet = new Set<string>();
  for (const id of seen) {
    const hit = inForce.get(id);
    if (hit && !seenSet.has(hit[0])) {
      seenSet.add(hit[0]);
      hits.push(hit[0]);
    }
  }
  for (const id of added) {
    const hit = inForce.get(id);
    if (hit && hit[0] !== id && !seenSet.has(hit[0])) {
      seenSet.add(hit[0]);
      hits.push(hit[0]);
    }
  }
  return hits;
}

export async function reviewStats(db: Db, user: Pick<UserRow, "id">, days = 7) {
  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db
    .select({ outcome: sessionReviews.outcome, result: sessionReviews.result })
    .from(sessionReviews)
    .where(and(eq(sessionReviews.userId, user.id), gte(sessionReviews.reviewedAt, sinceIso)));
  const outcomes: Record<string, number> = {};
  const ids = new Set<string>();
  for (const r of rows) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    const [seen, added] = reviewPitfallIds(r.result);
    for (const id of seen) ids.add(id);
    for (const id of added) ids.add(id);
  }
  const inForce = ids.size ? await pitfallsInForce(db, user.id, ids) : new Map();
  let repeats = 0;
  for (const r of rows) repeats += pitfallsHitAgain(r.result, inForce).length;

  const taskRows = await db
    .select({ status: deviceTasks.status, n: count() })
    .from(deviceTasks)
    .where(and(eq(deviceTasks.userId, user.id), gte(deviceTasks.createdAt, sinceIso), inArray(deviceTasks.action, ["shell", "agent"])))
    .groupBy(deviceTasks.status);
  const taskCounts = new Map(taskRows.map((r) => [r.status, Number(r.n)]));
  const succeeded = taskCounts.get("succeeded") ?? 0;
  const finished = succeeded + (taskCounts.get("failed") ?? 0) + (taskCounts.get("timeout") ?? 0);

  const [[pitfallsNewRow], [pitfallsTotalRow]] = await Promise.all([
    db
      .select({ n: count() })
      .from(userMemories)
      .where(and(eq(userMemories.userId, user.id), eq(userMemories.category, "pitfall"), gte(userMemories.createdAt, sinceIso))),
    db
      .select({ n: count() })
      .from(userMemories)
      .where(and(eq(userMemories.userId, user.id), eq(userMemories.category, "pitfall"), eq(userMemories.status, "active"))),
  ]);

  return {
    days,
    sessions: rows.length,
    outcomes,
    pitfall_repeats: repeats,
    pitfalls_new: Number(pitfallsNewRow?.n ?? 0),
    pitfalls_total: Number(pitfallsTotalRow?.n ?? 0),
    agent_tasks: {
      finished,
      succeeded,
      success_rate: finished ? Math.round((succeeded / finished) * 1000) / 1000 : null,
    },
  };
}

export const DEVICE_PITFALL_DAYS = 30;
export const DEVICE_PITFALL_LIMIT = 6;

export async function devicePitfalls(
  db: Db,
  redis: Redis | null,
  user: Pick<UserRow, "id">,
  days = DEVICE_PITFALL_DAYS,
): Promise<Record<string, { id: string; content: string; hits: number; last: string }[]>> {
  const cacheKey = `device_pitfalls:v3:${user.id}:${days}`;
  try {
    const cached = await cacheGet(redis, cacheKey);
    if (cached && typeof cached === "object" && !Array.isArray(cached)) {
      return cached as Record<string, { id: string; content: string; hits: number; last: string }[]>;
    }
  } catch {
    /* ignore */
  }

  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db
    .select({ machineId: documents.machineId, reviewedAt: sessionReviews.reviewedAt, result: sessionReviews.result })
    .from(sessionReviews)
    .innerJoin(documents, eq(documents.id, sessionReviews.documentId))
    .where(and(eq(sessionReviews.userId, user.id), gte(sessionReviews.reviewedAt, sinceIso), isNotNull(documents.machineId)));

  const ids = new Set<string>();
  for (const r of rows) {
    const [seen, added] = reviewPitfallIds(r.result);
    for (const id of seen) ids.add(id);
    for (const id of added) ids.add(id);
  }
  const inForce = ids.size ? await pitfallsInForce(db, user.id, ids) : new Map();
  const hits = new Map<string, number>();
  const last = new Map<string, string>();
  for (const r of rows) {
    if (!r.machineId) continue;
    for (const pid of pitfallsHitAgain(r.result, inForce)) {
      const k = `${r.machineId}|${pid}`;
      hits.set(k, (hits.get(k) ?? 0) + 1);
      const prev = last.get(k);
      if (!prev || r.reviewedAt > prev) last.set(k, r.reviewedAt);
    }
  }
  const contentMap = new Map<string, string>();
  for (const [pid, c] of inForce.values()) {
    if (c && isMachinePitfall(c)) contentMap.set(pid, c);
  }
  const found: Record<string, { id: string; content: string; hits: number; last: string }[]> = {};
  for (const [k, n] of hits.entries()) {
    const [mid, pid] = k.split("|") as [string, string];
    const c = contentMap.get(pid);
    if (!c) continue;
    if (!found[mid]) found[mid] = [];
    found[mid]!.push({ id: pid, content: c, hits: n, last: pgToIso(last.get(k) ?? null) ?? "" });
  }
  for (const mid of Object.keys(found)) {
    found[mid]!.sort((a, b) => b.hits - a.hits || b.last.localeCompare(a.last));
    found[mid] = found[mid]!.slice(0, DEVICE_PITFALL_LIMIT);
  }
  await cacheSet(redis, cacheKey, found, 600).catch(() => {});
  return found;
}
