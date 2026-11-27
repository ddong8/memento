// Orchestrator knowledge, memory, blueprint, graph, todo, skill & SSRF-safe web fetch tools
// (server/server/services/orchestrator_tools.py).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Deps } from "../context";
import {
  agentMissions,
  agentPlans,
  conversationMessages,
  dailySummaries,
  deviceTasks,
  documents,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  projects,
  skills,
  todos,
  userMemories,
} from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { pgToIso } from "../pytime";
import { retrieveDocuments } from "./ask-retrieval";
import { codeBlueprintPath, pickFreshest } from "./blueprint-pick";
import { exportCoreMemoryMarkdown, savePitfall } from "./dreaming-core";
import { guidanceFor, renderGuidance, touchRecalled } from "./guidance-service";
import {
  detectScenario,
  enrichCheckRulesResult,
  enrichSearchQueryWithMindset,
  enrichSkillWithMindset,
  enrichTodoCreation,
  renderMindResonanceMarkdown,
  senseResonance,
} from "./mind-resonance-service";
import { termsFor } from "./guidance-service";
import { addTodo, openTodos, parseDue } from "./todos";
import { seesAll } from "./visibility";

export const READ_ONLY_TOOL_NAMES = new Set([
  "search_knowledge",
  "list_projects",
  "get_project_detail",
  "get_project_blueprint",
  "get_document",
  "get_conversation",
  "list_daily_summaries",
  "get_core_memory",
  "search_knowledge_graph",
  "check_rules",
  "get_skill",
  "list_todos",
  "list_missions",
  "list_plans",
  "fetch_url",
  "list_devices",
]);

export const KNOWLEDGE_TOOLS_SCHEMA: Record<string, unknown>[] = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "在用户的全量个人知识库（对话记录、文档、笔记、记忆）中混合检索（语义 + 全文关键词）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索问题或关键词" },
          tool_id: { type: "string", description: "可选：按工具过滤，如 claude_code / codex / antigravity / obsidian" },
          project: { type: "string", description: "可选：按项目名过滤" },
          limit: { type: "integer", description: "返回条数，默认 8，最大 20" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_projects",
      description: "列出用户近期活跃的项目列表（含项目 ID、名称、工具与文档数）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "可选：按项目名模糊过滤" },
          limit: { type: "integer", description: "返回条数，默认 20" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_detail",
      description: "获取某个项目的详情和最近同步的文档/对话列表。",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "项目 UUID 或项目名称" },
          limit: { type: "integer", description: "最近文档数量，默认 15" },
        },
        required: ["project_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_blueprint",
      description: "一键获取项目的完整架构蓝图（CODE_BLUEPRINT.md、精选记忆文档与近期对话摘要）。",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "项目 UUID 或项目名称" },
        },
        required: ["project_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_document",
      description: "按文档 ID 读取某篇文档/笔记的完整正文（过长自动分段截取）。",
      parameters: {
        type: "object",
        properties: {
          document_id: { type: "string", description: "文档 UUID" },
          offset: { type: "integer", description: "起始字符偏移，默认 0" },
          limit: { type: "integer", description: "最大字符数，默认 8000" },
        },
        required: ["document_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_conversation",
      description: "读取某条历史 AI 会话文档的对话消息记录。",
      parameters: {
        type: "object",
        properties: {
          document_id: { type: "string", description: "会话文档 UUID" },
          limit: { type: "integer", description: "消息条数，默认 40" },
          tail: { type: "boolean", description: "是否取最新尾部消息，默认 true" },
        },
        required: ["document_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_daily_summaries",
      description: "查询用户最近几天的每日工作总结（日报）与高光亮点。",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", description: "最近天数，默认 7" },
          date: { type: "string", description: "可选：指定日期 YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_core_memory",
      description: "读取用户的长期核心记忆（MEMORY.md）或按分类检索。",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "可选：rule / architecture / preference / project / pitfall" },
          query: { type: "string", description: "可选：关键词过滤" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge_graph",
      description: "检索用户的知识图谱实体、沉淀经验与一跳关联关系。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "实体名称或关键词" },
          limit: { type: "integer", description: "返回实体数，默认 8" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_rules",
      description: "动手执行重要操作（部署、迁移、发版、改库、删数据）前检查用户的铁律、历史踩坑与可复用技能。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "将要执行的操作类型，如 deploy / release / migration / refactor" },
          project: { type: "string", description: "可选：目标项目名" },
          query: { type: "string", description: "可选：具体任务描述" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_pitfall",
      description: "记录在用户环境中新发现的踩坑经验（现象、原因、解决办法），供后续避坑。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "简短标题" },
          symptom: { type: "string", description: "报错或异常现象" },
          cause: { type: "string", description: "根因" },
          fix: { type: "string", description: "已验证有效的解决办法" },
          project: { type: "string", description: "可选：所属项目名" },
        },
        required: ["title", "symptom", "fix"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_skill",
      description: "读取用户已沉淀的某项可执行技能（Skill）详细步骤。",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "技能 slug 或名称关键词" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todos",
      description: "查看用户当前未完成（或全部）的工作待办列表。",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "open / done / all，默认 open" },
          project: { type: "string", description: "可选：按项目过滤" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_todo",
      description: "为用户创建一条新的工作待办事项。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "待办标题" },
          detail: { type: "string", description: "详细说明" },
          project: { type: "string", description: "关联项目" },
          due_at: { type: "string", description: "截止时间（ISO 日期或自然描述）" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_todo",
      description: "将某条待办标记为已完成。",
      parameters: {
        type: "object",
        properties: {
          todo_id: { type: "string", description: "待办 UUID 或标题关键字" },
          evidence: { type: "string", description: "完成依据" },
        },
        required: ["todo_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_missions",
      description: "查看主动执事（Missions）后台自治任务列表与状态。",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "条数，默认 10" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_plans",
      description: "查看近期多步协同计划（Agent Plans）的执行状态与步骤。",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "条数，默认 10" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "安全抓取公开 HTTP/HTTPS 网页或文档纯文本内容（自动阻止内网 SSRF 地址）。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "公开网页 URL" },
          max_chars: { type: "integer", description: "最大返回字符数，默认 8000" },
        },
        required: ["url"],
      },
    },
  },
];

function isPublicIp(raw: string): boolean {
  const ip = raw.split("%", 1)[0]!.toLowerCase();
  const ver = isIP(ip);
  if (ver === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  if (ver === 6) {
    if (ip === "::" || ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("ff")) return false;
    return true;
  }
  return false;
}

async function isPublicUrl(rawUrl: string): Promise<[boolean, string]> {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return [false, "无效的 URL"];
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return [false, "仅允许 http/https 协议"];
  const host = u.hostname;
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return [false, "禁止访问内网或本地地址"];
  if (isIP(host)) return isPublicIp(host) ? [true, ""] : [false, "禁止访问私有 IP 地址"];
  try {
    const recs = await lookup(host, { all: true });
    if (!recs.length || !recs.every((r) => isPublicIp(r.address))) return [false, "目标域名解析到私有 IP，已被安全策略拦截"];
    return [true, ""];
  } catch {
    return [false, "域名解析失败"];
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function userMachineIds(deps: Deps, user: UserRow): Promise<string[] | null> {
  if (seesAll(user, deps.settings)) return null;
  const rows = await deps.db.select({ id: machines.id }).from(machines).where(eq(machines.userId, user.id));
  return rows.map((r) => r.id);
}

async function findProjectByIdOrName(deps: Deps, idOrName: string) {
  const uid = normalizeUuid(idOrName);
  if (uid) {
    const [p] = await deps.db.select().from(projects).where(eq(projects.id, uid)).limit(1);
    if (p) return p;
  }
  const [p] = await deps.db
    .select()
    .from(projects)
    .where(or(ilike(projects.title, idOrName), ilike(projects.slug, idOrName), ilike(projects.slug, `%/${idOrName}`)))
    .orderBy(desc(projects.updatedAt))
    .limit(1);
  return p ?? null;
}

export async function executeKnowledgeTool(
  deps: Deps,
  user: UserRow,
  name: string,
  args: Record<string, unknown>,
  opts: { userQuestion?: string; projectHint?: string | null } = {},
): Promise<{ output: string; sources?: Record<string, unknown>[] }> {
  const { db, settings } = deps;
  const redis = deps.redis();

  try {
    if (name === "search_knowledge") {
      const rawQ = String(args.query ?? "").trim();
      if (!rawQ) return { output: "缺少 query 参数" };
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8)));
      const scen = detectScenario(termsFor(opts.projectHint, rawQ), `${rawQ} ${opts.projectHint || ""}`);
      const q = enrichSearchQueryWithMindset(rawQ, scen);
      const docs = (await retrieveDocuments(db, settings, redis, user, q, typeof args.tool_id === "string" ? args.tool_id : null, null)).slice(0, limit);
      if (!docs.length) return { output: `未检索到与「${rawQ}」相关的记录。` };
      const lines = docs.map(
        (r, i) =>
          `[${i + 1}] (${r.tool_id}) ${r.title || r.relative_path} [doc_id=${r.id}, ${String(r.synced_at || "").slice(0, 10)}]\n${String(r.excerpt || "").slice(0, 800)}`,
      );
      return { output: lines.join("\n\n"), sources: docs as unknown as Record<string, unknown>[] };
    }

    if (name === "list_projects") {
      const limit = Math.min(40, Math.max(1, Number(args.limit ?? 20)));
      const q = String(args.query ?? "").trim();
      const mids = await userMachineIds(deps, user);
      const conds = q ? [or(ilike(projects.title, `%${q}%`), ilike(projects.slug, `%${q}%`))!] : [];
      const rows = await db
        .select({
          id: projects.id,
          title: projects.title,
          slug: projects.slug,
          toolId: projects.toolId,
          updatedAt: projects.updatedAt,
          docCount: sql<number>`count(${documents.id})::int`,
        })
        .from(projects)
        .leftJoin(
          documents,
          mids ? and(eq(documents.projectId, projects.id), inArray(documents.machineId, mids.length ? mids : [normalizeUuid("00000000-0000-0000-0000-000000000000")!])) : eq(documents.projectId, projects.id),
        )
        .where(conds.length ? and(...conds) : undefined)
        .groupBy(projects.id)
        .orderBy(desc(projects.updatedAt))
        .limit(limit);
      return {
        output: JSON.stringify(
          rows.map((r) => ({ id: r.id, title: r.title, slug: r.slug, tool_id: r.toolId, docs: r.docCount, updated_at: pgToIso(r.updatedAt) })),
          null,
          2,
        ),
      };
    }

    if (name === "get_project_detail") {
      const proj = await findProjectByIdOrName(deps, String(args.project_id ?? ""));
      if (!proj) return { output: `未找到项目：${args.project_id}` };
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 15)));
      const mids = await userMachineIds(deps, user);
      const docConds = [eq(documents.projectId, proj.id)];
      if (mids) docConds.push(inArray(documents.machineId, mids.length ? mids : ["00000000-0000-0000-0000-000000000000"]));
      const docs = await db
        .select({
          id: documents.id,
          title: documents.title,
          category: documents.category,
          toolId: documents.toolId,
          relativePath: documents.relativePath,
          aiSummary: documents.aiSummary,
          syncedAt: documents.syncedAt,
        })
        .from(documents)
        .where(and(...docConds))
        .orderBy(desc(documents.syncedAt))
        .limit(limit);
      return {
        output: JSON.stringify(
          {
            project: { id: proj.id, title: proj.title, slug: proj.slug, tool_id: proj.toolId, source_path: proj.sourcePath },
            recent_documents: docs.map((d) => ({
              id: d.id,
              title: d.title,
              category: d.category,
              tool_id: d.toolId,
              path: d.relativePath,
              summary: d.aiSummary?.slice(0, 300) ?? null,
              synced_at: pgToIso(d.syncedAt),
            })),
          },
          null,
          2,
        ),
      };
    }

    if (name === "get_project_blueprint") {
      const proj = await findProjectByIdOrName(deps, String(args.project_id ?? ""));
      if (!proj) return { output: `未找到项目：${args.project_id}` };
      const mids = await userMachineIds(deps, user);
      const leaf = (proj.title || proj.slug).split("/").pop() || proj.title;
      const bpConds = [
        codeBlueprintPath(documents.relativePath),
        or(eq(documents.projectId, proj.id), codeBlueprintPath(documents.relativePath, leaf))!,
      ];
      if (mids) bpConds.push(inArray(documents.machineId, mids.length ? mids : ["00000000-0000-0000-0000-000000000000"]));
      const bpRows = await db
        .select({ content: documents.content, syncedAt: documents.syncedAt, projectId: documents.projectId })
        .from(documents)
        .where(and(...bpConds))
        .orderBy(desc(documents.syncedAt))
        .limit(20);
      const own = bpRows.filter((r) => r.projectId === proj.id);
      const best = pickFreshest(own, (r) => r.content, (r) => r.syncedAt) ?? pickFreshest(bpRows, (r) => r.content, (r) => r.syncedAt);

      const recentDocs = await db
        .select({ title: documents.title, aiSummary: documents.aiSummary, syncedAt: documents.syncedAt })
        .from(documents)
        .where(and(eq(documents.projectId, proj.id), eq(documents.category, "conversation")))
        .orderBy(desc(documents.syncedAt))
        .limit(8);

      const parts = [`# 项目蓝图：${proj.title} (${proj.slug})`];
      if (best?.content) parts.push("\n## CODE_BLUEPRINT.md\n" + best.content.slice(0, 10_000));
      if (recentDocs.length) {
        parts.push(
          "\n## 近期会话摘要\n" +
            recentDocs.map((d) => `- [${String(pgToIso(d.syncedAt) || "").slice(0, 10)}] ${d.title || "未命名"}：${(d.aiSummary || "（无摘要）").slice(0, 200)}`).join("\n"),
        );
      }
      return { output: parts.join("\n") };
    }

    if (name === "get_document") {
      const docId = normalizeUuid(String(args.document_id ?? ""));
      if (!docId) return { output: "无效的 document_id" };
      const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
      if (!doc) return { output: "文档不存在" };
      const mids = await userMachineIds(deps, user);
      if (mids && doc.machineId && !mids.includes(doc.machineId)) return { output: "无权访问该文档" };
      const offset = Math.max(0, Number(args.offset ?? 0));
      const limit = Math.min(20_000, Math.max(500, Number(args.limit ?? 8000)));
      const content = doc.content || "";
      const slice = content.slice(offset, offset + limit);
      return {
        output: `标题：${doc.title || doc.relativePath}\n工具：${doc.toolId} | 分类：${doc.category} | 总长：${content.length} 字符（展示 ${offset}..${offset + slice.length}）\n\n${slice}`,
      };
    }

    if (name === "get_conversation") {
      const docId = normalizeUuid(String(args.document_id ?? ""));
      if (!docId) return { output: "无效的 document_id" };
      const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
      if (!doc) return { output: "会话不存在" };
      const mids = await userMachineIds(deps, user);
      if (mids && doc.machineId && !mids.includes(doc.machineId)) return { output: "无权访问该会话" };
      const limit = Math.min(100, Math.max(5, Number(args.limit ?? 40)));
      const tail = args.tail !== false;
      let rows = await db
        .select({ role: conversationMessages.role, content: conversationMessages.content, timestamp: conversationMessages.timestamp, lineNumber: conversationMessages.lineNumber })
        .from(conversationMessages)
        .where(eq(conversationMessages.documentId, docId))
        .orderBy(tail ? desc(conversationMessages.lineNumber) : asc(conversationMessages.lineNumber))
        .limit(limit);
      if (tail) rows = rows.reverse();
      const body = rows.map((r) => `[${r.role || "?"} ${String(pgToIso(r.timestamp) || "").slice(0, 16)}] ${(r.content || "").slice(0, 1000)}`).join("\n\n");
      return { output: `会话：${doc.title || doc.relativePath}（共 ${rows.length} 条）\n\n${body.slice(0, 14_000)}` };
    }

    if (name === "list_daily_summaries") {
      const targetDate = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : null;
      const days = Math.min(30, Math.max(1, Number(args.days ?? 7)));
      const conds = [eq(dailySummaries.userId, user.id)];
      if (targetDate) conds.push(eq(dailySummaries.summaryDate, targetDate));
      else {
        const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        conds.push(sql`${dailySummaries.summaryDate} >= ${since}::date`);
      }
      const rows = await db.select().from(dailySummaries).where(and(...conds)).orderBy(desc(dailySummaries.summaryDate)).limit(20);
      if (!rows.length) return { output: "该时间范围内暂无每日总结。" };
      return {
        output: rows.map((r) => `## ${r.summaryDate} · ${r.title}${r.toolId ? ` (${r.toolId})` : ""}\n${r.summary.slice(0, 1500)}`).join("\n\n"),
      };
    }

    if (name === "get_core_memory") {
      const cat = typeof args.category === "string" && args.category.trim() ? args.category.trim() : null;
      const q = typeof args.query === "string" && args.query.trim() ? args.query.trim().toLowerCase() : null;
      if (!cat && !q) {
        const md = await exportCoreMemoryMarkdown(db, user);
        return { output: md.slice(0, 12_000) };
      }
      const conds = [eq(userMemories.userId, user.id), eq(userMemories.status, "active"), eq(userMemories.isFolder, false)];
      if (cat) conds.push(eq(userMemories.category, cat));
      const rows = await db.select().from(userMemories).where(and(...conds)).orderBy(desc(userMemories.updatedAt)).limit(200);
      const filtered = q ? rows.filter((m) => `${m.key} ${m.treePath || ""} ${m.content}`.toLowerCase().includes(q)) : rows;
      const picked = filtered.slice(0, 30);
      if (picked.length) void touchRecalled(db, picked.map((m) => m.id));
      return {
        output: picked.length
          ? picked.map((m) => `- [${m.category}] ${m.key} (${m.treePath || ""}): ${m.content}`).join("\n")
          : "未找到匹配的长期记忆。",
      };
    }

    if (name === "search_knowledge_graph") {
      const q = String(args.query ?? "").trim();
      if (!q) return { output: "缺少 query" };
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8)));
      const ents = await db
        .select()
        .from(knowledgeEntities)
        .where(and(eq(knowledgeEntities.userId, user.id), or(ilike(knowledgeEntities.name, `%${q}%`), ilike(knowledgeEntities.summary, `%${q}%`))))
        .orderBy(desc(knowledgeEntities.updatedAt))
        .limit(limit);
      if (!ents.length) return { output: `知识图谱中未找到「${q}」相关实体。` };
      const ids = ents.map((e) => e.id);
      const obs = await db.select().from(knowledgeObservations).where(inArray(knowledgeObservations.entityId, ids)).orderBy(desc(knowledgeObservations.observedAt));
      const rels = await db
        .select({ sourceId: knowledgeRelations.sourceId, rtype: knowledgeRelations.relationType, targetName: knowledgeEntities.name })
        .from(knowledgeRelations)
        .innerJoin(knowledgeEntities, eq(knowledgeRelations.targetId, knowledgeEntities.id))
        .where(inArray(knowledgeRelations.sourceId, ids));
      const lines = ents.map((e) => {
        const eObs = obs.filter((o) => o.entityId === e.id).slice(0, 4).map((o) => `  · ${o.content}`);
        const eRel = rels.filter((r) => r.sourceId === e.id).slice(0, 4).map((r) => `  → ${r.rtype} ${r.targetName}`);
        return [`- ${e.name} (${e.entityType})${e.staleAt ? " [已过时]" : ""}: ${e.summary || ""}`, ...eObs, ...eRel].join("\n");
      });
      return { output: lines.join("\n\n") };
    }

    if (name === "check_rules") {
      const action = String(args.action ?? "操作");
      const project = typeof args.project === "string" ? args.project : opts.projectHint ?? null;
      const query = typeof args.query === "string" ? args.query : opts.userQuestion ?? null;
      const [g, res] = await Promise.all([
        guidanceFor(db, user, action, project, query),
        senseResonance(db, redis, user, { query: query || action, project, action }),
      ]);
      return { output: enrichCheckRulesResult(renderGuidance(g), res) };
    }

    if (name === "record_pitfall") {
      const mem = await savePitfall(db, redis, user, args, typeof args.project === "string" ? args.project : null, "agent");
      return { output: mem ? `已记录避坑经验：${mem.key}（${mem.treePath}）` : "记录失败或已存在相同避坑条目。" };
    }

    if (name === "get_skill") {
      const slug = String(args.slug ?? "").trim();
      if (!slug) return { output: "缺少 slug" };
      const [sk] = await db
        .select()
        .from(skills)
        .where(and(eq(skills.userId, user.id), or(eq(skills.slug, slug), ilike(skills.slug, `%${slug}%`), ilike(skills.title, `%${slug}%`))))
        .orderBy(desc(skills.updatedAt))
        .limit(1);
      if (!sk) return { output: `未找到技能：${slug}` };
      const scen = detectScenario(termsFor(sk.project, sk.title, sk.description), `${sk.title} ${sk.description}`);
      return { output: enrichSkillWithMindset(`# ${sk.title} (${sk.slug})\n\n${sk.description}\n\n${sk.body}`, scen) };
    }

    if (name === "list_todos") {
      const status = String(args.status ?? "open");
      const proj = typeof args.project === "string" ? args.project.trim() : null;
      if (status === "open") {
        let rows = await openTodos(db, user.id);
        if (proj) rows = rows.filter((t) => (t.project || "").toLowerCase().includes(proj.toLowerCase()));
        return {
          output: rows.length
            ? rows.map((t) => `- [${t.id}] ${t.title}${t.project ? ` (${t.project})` : ""}${t.dueAt ? ` 截止:${pgToIso(t.dueAt)?.slice(0, 10)}` : ""}`).join("\n")
            : "当前没有未完成的待办事项。",
        };
      }
      const conds = [eq(todos.userId, user.id)];
      if (status !== "all") conds.push(eq(todos.status, status));
      const rows = await db.select().from(todos).where(and(...conds)).orderBy(desc(todos.updatedAt)).limit(30);
      return { output: rows.map((t) => `- [${t.status}] [${t.id}] ${t.title}`).join("\n") || "暂无待办。" };
    }

    if (name === "create_todo") {
      const scen = detectScenario(termsFor(typeof args.project === "string" ? args.project : null, String(args.title ?? "")), String(args.title ?? ""));
      const [cleanTitle, proj, hint] = enrichTodoCreation(String(args.title ?? ""), typeof args.project === "string" ? args.project : null, scen);
      const due = typeof args.due_at === "string" ? parseDue(args.due_at) : null;
      const [created, isNew] = await addTodo(db, user.id, cleanTitle, {
        detail: typeof args.detail === "string" ? args.detail : null,
        project: proj,
        dueAt: due,
        source: "ask_agent",
      });
      const base = created ? `${isNew ? "已创建" : "已存在"}待办：${created.title} (id=${created.id})` : "创建待办失败";
      return { output: hint ? `${base}\n${hint}` : base };
    }

    if (name === "complete_todo") {
      const target = String(args.todo_id ?? "").trim();
      const uid = normalizeUuid(target);
      let row = uid ? (await db.select().from(todos).where(and(eq(todos.id, uid), eq(todos.userId, user.id))).limit(1))[0] : undefined;
      if (!row) {
        const open = await openTodos(db, user.id);
        row = open.find((t) => t.title.toLowerCase().includes(target.toLowerCase()));
      }
      if (!row) return { output: `未找到待办：${target}` };
      const nowIso = new Date().toISOString();
      await db
        .update(todos)
        .set({
          status: "done",
          closedAt: nowIso,
          closeEvidence: typeof args.evidence === "string" ? args.evidence : "completed via agent",
          updatedAt: nowIso,
        })
        .where(eq(todos.id, row.id));
      return { output: `已完成待办：${row.title}` };
    }

    if (name === "list_missions") {
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 10)));
      const rows = await db.select().from(agentMissions).where(eq(agentMissions.userId, user.id)).orderBy(desc(agentMissions.updatedAt)).limit(limit);
      return {
        output: rows.length
          ? JSON.stringify(rows.map((m) => ({ id: m.id, title: m.title, status: m.status, current_step: m.currentStep, summary: m.summary, updated_at: pgToIso(m.updatedAt) })), null, 2)
          : "暂无主动执事任务。",
      };
    }

    if (name === "list_plans") {
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 10)));
      const rows = await db.select().from(agentPlans).where(eq(agentPlans.userId, user.id)).orderBy(desc(agentPlans.createdAt)).limit(limit);
      return {
        output: rows.length
          ? JSON.stringify(rows.map((p) => ({ id: p.id, title: p.title, status: p.status, summary: p.summary, created_at: pgToIso(p.createdAt) })), null, 2)
          : "暂无多步计划。",
      };
    }

    if (name === "fetch_url") {
      const rawUrl = String(args.url ?? "").trim();
      const [ok, reason] = await isPublicUrl(rawUrl);
      if (!ok) return { output: `安全拦截：${reason}` };
      const maxChars = Math.min(20_000, Math.max(500, Number(args.max_chars ?? 8000)));
      const resp = await fetch(rawUrl, {
        headers: { "User-Agent": "MementoBot/1.0" },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (loc) {
          const resolved = new URL(loc, rawUrl).toString();
          const [locOk, locReason] = await isPublicUrl(resolved);
          if (!locOk) return { output: `重定向被安全拦截：${locReason}` };
          const r2 = await fetch(resolved, { headers: { "User-Agent": "MementoBot/1.0" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
          const text2 = await r2.text();
          return { output: (r2.headers.get("content-type")?.includes("html") ? htmlToText(text2) : text2).slice(0, maxChars) };
        }
      }
      const text = await resp.text();
      return { output: (resp.headers.get("content-type")?.includes("html") ? htmlToText(text) : text).slice(0, maxChars) };
    }

    return { output: `未知工具：${name}` };
  } catch (e) {
    return { output: `工具 ${name} 执行失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

export { renderMindResonanceMarkdown, senseResonance, deviceTasks };
