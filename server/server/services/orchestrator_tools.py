"""Full MCP memory, knowledge, blueprint, todo, plan-status, and safe web-fetch tools for AI 编排.

Provides in-process parity with the 17 tools exposed by `packages/mcp/src/server.ts`,
plus `plan_status` and SSRF-hardened `fetch_url`, without any HTTP loopback overhead.
All queries strictly enforce user/tenant isolation (`user_machine_ids`, `sees_all`,
`can_view_document`, `user.id`).
"""

from __future__ import annotations

import html
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from ..db.models import (
    AgentPlan,
    ConversationMessage,
    Document,
    KnowledgeEntity,
    KnowledgeObservation,
    KnowledgeRelation,
    Project,
    Skill,
    Todo,
    User,
    UserMemory,
)
from .enterprise_policy import sees_all
from .user_filter import apply_user_filter, user_machine_ids

logger = logging.getLogger("server.orchestrator_tools")

_LOCAL_TZ = timezone(timedelta(hours=8), "Asia/Shanghai")
_CODE_BLUEPRINT_FILES = ("CODE_BLUEPRINT.md", "PROJECT_BLUEPRINT.md")
_DOC_OPENING_CHARS = 500
_SCRIPT_STYLE_RE = re.compile(r"<(script|style|noscript|svg)[^>]*>[\s\S]*?</\1>", re.IGNORECASE)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_MULTI_NL_RE = re.compile(r"\n{3,}")


def _is_noise_path(path: str | None) -> bool:
    p = path or ""
    return p.endswith(".meta.json") or ".resolved" in p or "/subagents/" in p


def _is_code_blueprint_path(path: str | None) -> bool:
    p = path or ""
    return any(p == name or p.endswith(f"/{name}") for name in _CODE_BLUEPRINT_FILES)


def _day(val: Any) -> str:
    return str(val or "")[:10]


def _opening(md: str, max_chars: int) -> str:
    if len(md) <= max_chars:
        return md
    end = md.rfind("\n", 0, max_chars)
    if end <= 0:
        end = max_chars
    return md[:end].rstrip()


def _section_number(heading: str) -> str | None:
    m = re.match(r"^##\s+(\d+(?:\.\d+)?)\.", heading)
    return m.group(1) if m else None


def blueprint_section(md: str, section: str = "summary") -> str:
    """Slice CODE_BLUEPRINT.md / USER_BLUEPRINT.md identically to packages/mcp/src/server.ts."""
    want = (section or "summary").strip().lower() or "summary"
    if want in ("all", "full"):
        return md
    lines = md.splitlines()
    heads = [(line, idx) for idx, line in enumerate(lines) if line.startswith("## ")]
    section_list = [f"- {line[3:]} (line {idx + 1})" for line, idx in heads]

    if want == "summary":
        zero = next((k for k, (line, _) in enumerate(heads) if _section_number(line) == "0"), -1)
        if zero >= 0:
            end = heads[zero + 1][1] if zero + 1 < len(heads) else len(lines)
            body = "\n".join(lines[:end]).rstrip()
            return f'{body}\n\n_仅返回速览与索引：需要详细章节请传 section="<编号>"（如 "3" 或 "4,6.5"）或 "all"。_'
        head = "\n".join(lines[:80]).rstrip()
        later = [f"- {line[3:]} (line {idx + 1})" for line, idx in heads if idx >= 80]
        extra = ("\n\n## More sections\n" + "\n".join(later)) if later else ""
        return f'{head}{extra}\n\n_仅返回开头：需要详细章节请传 section="<编号>" 或 "all"。_'

    wanted = {w.rstrip(".") for w in re.split(r"[\s,，、]+", want) if w}
    parts: list[str] = []
    for k, (line, start_idx) in enumerate(heads):
        num = _section_number(line)
        if num and num in wanted:
            end_idx = heads[k + 1][1] if k + 1 < len(heads) else len(lines)
            parts.append("\n".join(lines[start_idx:end_idx]).rstrip())
    if parts:
        return "\n\n".join(parts)
    return f'未找到章节 "{section}"。可用章节：\n' + "\n".join(section_list)


def business_section(md: str, section: str, uncovered: list[str] | None = None) -> str:
    """Slice BUSINESS_BLUEPRINT.md for section='business[:...]'."""
    sub = re.sub(r"^business[:：]?", "", (section or "").strip().lower()).strip() or "summary"
    if sub in ("all", "full"):
        return md
    if sub != "summary":
        return blueprint_section(md, sub)
    lines = md.splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith("<!-- memento:business-index:start")), -1)
    end = next((i for i, l in enumerate(lines) if l.startswith("<!-- memento:business-index:end")), -1)
    head = (lines[:start] + lines[start + 1:end]) if (start >= 0 and end > start) else lines[:40]
    out = ["\n".join(head).rstrip()]
    if uncovered:
        out.append("")
        out.append("### 用户给这个项目定的规则里，业务蓝图还没写的")
        out.extend(f"- {r}" for r in uncovered)
    out.append("")
    out.append('_仅返回索引：传 section="business:<编号>"（如 "business:3"）或 "business:all" 查看全部。_')
    return "\n".join(out)


def _html_to_clean_text(raw: str) -> str:
    text = _SCRIPT_STYLE_RE.sub("\n", raw)
    text = re.sub(r"</?(?:p|div|br|li|tr|h[1-6]|section|article|blockquote|pre)[^>]*>", "\n", text, flags=re.IGNORECASE)
    text = _HTML_TAG_RE.sub("", text)
    text = html.unescape(text)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines()]
    cleaned = "\n".join(ln for ln in lines if ln)
    return _MULTI_NL_RE.sub("\n\n", cleaned).strip()


# ---------------------------------------------------------------------------
# Tool JSON Schemas (OpenAI Function Calling format)
# ---------------------------------------------------------------------------

MEMORY_AND_KNOWLEDGE_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "mind_resonance",
            "description": "心领神会：主动感知用户场景、心智模型、前置激活图谱实体、召回历史避坑防御与铁律。面对极简指令或复杂任务前调用以达成深度默契。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "用户当前指令或任务描述，可选"},
                    "project": {"type": "string", "description": "项目名，可选"},
                    "action": {"type": "string", "description": "操作类型（如 coding / release / deploy / ui / chemistry），可选"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_memory",
            "description": "使用混合语义+全文检索搜索同步到 Memento 的全部历史记忆（Claude Code、Codex、Antigravity、Cursor、WorkBuddy、Obsidian 等对话、笔记、计划）。返回结果含 doc_id，可配合 memory_open / memory_conversation 下钻查看全文。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "自然语言检索词"},
                    "tool_filter": {"type": "string", "description": "可选工具过滤（claude_code, codex, cursor, antigravity, workbuddy, openclaw, obsidian）"},
                    "days": {"type": "integer", "description": "只查最近 N 天，可选"},
                    "limit": {"type": "integer", "description": "最多返回条数（默认 6，最大 15）"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_recall",
            "description": "按类别、项目名、最近天数或指定日期（YYYY-MM-DD）召回近期同步的记忆文档或对话列表（含 doc_id）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "记忆类别：conversation / memory / identity / plan / config / learning / skill / note，默认 conversation"},
                    "project": {"type": "string", "description": "可选项目名称或路径关键词过滤"},
                    "days": {"type": "integer", "description": "回溯天数（默认 7；指定 date 时忽略）"},
                    "limit": {"type": "integer", "description": "最多返回条数（默认 10，最大 30）"},
                    "date": {"type": "string", "description": "指定日期 YYYY-MM-DD，可选"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_open",
            "description": "按 doc_id 读取某篇记忆文档/笔记/计划的完整正文（与 search_memory / memory_recall / memory_context 配合使用）。支持 offset_chars 分段阅读长文档。",
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_id": {"type": "string", "description": "文档 UUID（来自 search_memory / memory_recall 等结果）"},
                    "offset_chars": {"type": "integer", "description": "起始字符偏移（默认 0）"},
                    "max_chars": {"type": "integer", "description": "本次最多读取字符数（默认 10000，最大 20000）"},
                },
                "required": ["doc_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_conversation",
            "description": "按 doc_id 逐条读取历史对话文档的消息内容，用于引用、复盘或接续过去的讨论。",
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_id": {"type": "string", "description": "对话文档 UUID"},
                    "limit": {"type": "integer", "description": "最多返回消息条数（默认 35，最大 100）"},
                    "offset": {"type": "integer", "description": "分页起始偏移（默认 0）"},
                    "include_tools": {"type": "boolean", "description": "是否包含底层工具调用噪声行（默认 false，只返回对话消息）"},
                },
                "required": ["doc_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_context",
            "description": "获取指定项目的精选上下文包：项目元信息、代码蓝图速览、精选文档（identity/memory/plan/learning/note）摘要与正文、其他文档 doc_id 列表。",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {"type": "string", "description": "项目名称（支持模糊匹配）"},
                },
                "required": ["project_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_blueprint",
            "description": "一步读取项目代码蓝图（CODE_BLUEPRINT.md）、业务蓝图（BUSINESS_BLUEPRINT.md）或用户个人全域蓝图（project_name='me' -> USER_BLUEPRINT.md）。包含代码架构速览、业务规则核对、知识图谱实体和近期对话摘要。",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {"type": "string", "description": "项目名称（模糊匹配），或 'me'/'user' 获取个人全域蓝图"},
                    "section": {
                        "type": "string",
                        "description": "蓝图切片：'summary'（默认，速览+章节行号索引）、'all'、章节编号如 '3' 或 '4,6.5'；查业务蓝图用 'business' / 'business:3' / 'business:all'",
                    },
                    "recent_conversations": {"type": "integer", "description": "附带最近对话摘要条数（默认 8，0 表示省略）"},
                },
                "required": ["project_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_project_map",
            "description": "列出 Memento 跟踪的全部跨设备项目全景图（项目名称、slug、主要工具、源码路径、文档数与摘要）。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_graph",
            "description": "查询个人知识图谱中某个实体的结构化信息：摘要、出向/入向关联关系、历史观察记录及相近实体。",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_name": {"type": "string", "description": "实体名称（模糊匹配，如项目名、服务名、技术栈）"},
                    "limit": {"type": "integer", "description": "候选实体数量上限（默认 5）"},
                },
                "required": ["entity_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_core",
            "description": "读取 Dreaming 沉淀的用户长期核心记忆（MEMORY.md）：提炼后的工程铁律、架构决策、项目知识与个人偏好。",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "可选分类过滤：rule / architecture / preference / project / general / pitfall"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_store",
            "description": "将重要决策、事实结论、环境参数或经验观察持久化写入长期记忆知识图谱，供后续所有对话与工具召回。",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "要记住的事实、结论或观察内容"},
                    "entity_name": {"type": "string", "description": "关联实体名称（如项目名、工具名、服务名），可选"},
                    "entity_type": {"type": "string", "description": "实体类型（project / tool / concept / person / technology），默认 concept"},
                },
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "daily_summary",
            "description": "查询指定日期（默认今天）的跨 AI 工具活动统计、主要对话列表及 AI 日报摘要。",
            "parameters": {
                "type": "object",
                "properties": {
                    "date_str": {"type": "string", "description": "日期 YYYY-MM-DD（不填默认今天）"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_rules",
            "description": "关键操作（部署、发版、数据库迁移、删除/改数据、git push、改配置、重启服务）之前调用：返回用户的铁律、历史避坑提醒与可直接照做的技能。",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "要做的操作，如 deploy / release / db_migration / 删除数据"},
                    "project": {"type": "string", "description": "项目名，可选"},
                    "detail": {"type": "string", "description": "具体操作细节，可选，用于匹配相关的坑"},
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "use_skill",
            "description": "取出一个已发布技能的完整步骤（用户环境里验证过的标准流程）。不传 name 时列出全部可用技能。",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "技能名（slug）或要做的事描述；留空列出全部技能"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remember_pitfall",
            "description": "操作失败、查明根因并解决之后记录避坑经验，以后同类操作前会自动提醒。没查明原因或自身操作失误的不要记。",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "一句话概括"},
                    "symptom": {"type": "string", "description": "报错或现象，保留关键原文"},
                    "cause": {"type": "string", "description": "根因"},
                    "fix": {"type": "string", "description": "解决方案"},
                    "project": {"type": "string", "description": "项目名，可选"},
                },
                "required": ["title", "symptom", "fix"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_todo",
            "description": "把用户说以后再做、要记下来的事记成待办（到期会推送提醒）。当前就要做的事不要记。",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "动宾短语，说清做什么"},
                    "detail": {"type": "string", "description": "补充说明，可选"},
                    "due": {"type": "string", "description": "截止日期 YYYY-MM-DD，可选"},
                    "project": {"type": "string", "description": "项目名，可选"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_todos",
            "description": "列出用户还没做完的待办（按截止时间优先排序）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "只看某个项目，可选"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "todo_update",
            "description": "关闭、恢复或修改一条待办的状态/标题/截止时间。",
            "parameters": {
                "type": "object",
                "properties": {
                    "todo_id": {"type": "string", "description": "待办 ID 或前 8 位前缀（来自 list_todos）"},
                    "status": {"type": "string", "enum": ["done", "dropped", "open"], "description": "目标状态：done（已完成）、dropped（放弃）、open（重新打开）"},
                    "title": {"type": "string", "description": "新标题，可选"},
                    "due": {"type": "string", "description": "新截止日期 YYYY-MM-DD（空串清除），可选"},
                },
                "required": ["todo_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_url",
            "description": "安全读取公网网页/技术文档/GitHub Raw 内容（仅允许公网 http/https，自动清洗 HTML 标签为纯文本）。当用户提供链接或需要查阅官方文档时使用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "公网 http/https URL"},
                    "max_chars": {"type": "integer", "description": "最多返回字符数（默认 8000，最大 15000）"},
                },
                "required": ["url"],
            },
        },
    },
]

PLAN_STATUS_TOOL_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "plan_status",
        "description": "查询多设备协作任务（plan_and_run 创建）的实时进度、各子步骤状态与汇总结论；不传 plan_id 则列出最近的协作任务。",
        "parameters": {
            "type": "object",
            "properties": {
                "plan_id": {"type": "string", "description": "协作任务 UUID，不填则列出最近任务"},
                "limit": {"type": "integer", "description": "列表模式返回条数（默认 5，最大 20）"},
            },
        },
    },
}

MEMORY_TOOL_NAMES: set[str] = {
    item["function"]["name"] for item in MEMORY_AND_KNOWLEDGE_TOOL_SCHEMAS
} | {"plan_status"}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

async def _find_project_by_name(db: AsyncSession, user: User, name: str) -> Project | None:
    mids = await user_machine_ids(db, user)
    q = select(Project).order_by(Project.updated_at.desc().nulls_last())
    projects = list((await db.execute(q)).scalars().all())
    if mids is not None:
        # Filter to projects having at least one document on the user's machines
        doc_pids = set(
            (await db.execute(
                select(Document.project_id).where(
                    Document.machine_id.in_(mids),
                    Document.project_id.isnot(None),
                ).distinct()
            )).scalars().all()
        )
        projects = [p for p in projects if p.id in doc_pids]
    needle = name.strip().lower()
    if not needle:
        return None
    # Exact title/slug first, then substring match
    for p in projects:
        if (p.title or "").lower() == needle or (p.slug or "").lower() == needle:
            return p
    for p in projects:
        if needle in (p.title or "").lower() or needle in (p.slug or "").lower():
            return p
    return None


def _parse_uuid(raw: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(raw).strip())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Tool Dispatcher
# ---------------------------------------------------------------------------

async def execute_memory_tool(
    db: AsyncSession,
    user: User,
    name: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Execute any non-device MCP memory, knowledge, blueprint, todo, plan-status, or web tool."""
    try:
        if name == "search_memory":
            return await _run_search_memory(db, user, args)
        if name == "memory_recall":
            return await _run_memory_recall(db, user, args)
        if name == "memory_open":
            return await _run_memory_open(db, user, args)
        if name == "memory_conversation":
            return await _run_memory_conversation(db, user, args)
        if name == "memory_context":
            return await _run_memory_context(db, user, args)
        if name == "memory_blueprint":
            return await _run_memory_blueprint(db, user, args)
        if name == "memory_project_map":
            return await _run_memory_project_map(db, user)
        if name == "memory_graph":
            return await _run_memory_graph(db, user, args)
        if name == "memory_core":
            return await _run_memory_core(db, user, args)
        if name == "memory_store":
            return await _run_memory_store(db, user, args)
        if name == "daily_summary":
            return await _run_daily_summary(db, user, args)
        if name == "check_rules":
            return await _run_check_rules(db, user, args)
        if name == "use_skill":
            return await _run_use_skill(db, user, args)
        if name == "remember_pitfall":
            return await _run_remember_pitfall(db, user, args)
        if name == "add_todo":
            return await _run_add_todo(db, user, args)
        if name == "list_todos":
            return await _run_list_todos(db, user, args)
        if name == "todo_update":
            return await _run_todo_update(db, user, args)
        if name == "mind_resonance":
            return await _run_mind_resonance(db, user, args)
        if name == "plan_status":
            return await _run_plan_status(db, user, args)
        if name == "fetch_url":
            return await _run_fetch_url(user, args)
        return {"error": f"unknown tool: {name}"}
    except Exception as e:
        logger.exception("Orchestrator memory tool %s failed: %s", name, e)
        return {"error": f"{name} 执行失败: {e}"}


async def _run_search_memory(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .ask_retrieval import retrieve
    from .guidance_service import terms_for
    from .mind_resonance_service import detect_scenario, enrich_search_query_with_mindset

    raw_query = str(args.get("query") or "").strip()
    if not raw_query:
        return {"error": "query is required"}
    days = args.get("days")
    tool_filter = str(args.get("tool_filter") or "").strip() or None
    limit = max(1, min(int(args.get("limit") or 6), 15))

    terms = terms_for(None, None, raw_query)
    scen = detect_scenario(terms, raw_query)
    expanded_query = enrich_search_query_with_mindset(raw_query, scen)

    sources = await retrieve(
        db,
        user,
        expanded_query,
        tool_filter,
        int(days) if isinstance(days, (int, float)) and days > 0 else None,
    )
    items = [
        {
            "doc_id": s.get("id"),
            "title": s.get("title"),
            "tool": s.get("tool_id"),
            "category": s.get("category"),
            "path": s.get("relative_path"),
            "happened_at": s.get("happened_at") or s.get("synced_at"),
            "excerpt": (s.get("excerpt") or "")[:700],
        }
        for s in sources[:limit]
    ]
    md_lines = [f"共命中 {len(items)} 条相关记忆（查询：{raw_query}）："]
    for idx, it in enumerate(items, 1):
        did = f" `{it['doc_id']}`" if it.get("doc_id") else ""
        md_lines.append(
            f"{idx}) [{it.get('tool') or 'memory'}] {it.get('title') or it.get('path') or '未命名'}{did} ({_day(it.get('happened_at'))})\n"
            f"   {(it.get('excerpt') or '').replace(chr(10), ' ')[:220]}"
        )
    if not items:
        md_lines = [f"未检索到与「{raw_query}」直接匹配的记忆，可换关键词或调用 memory_recall / memory_project_map / memory_graph 继续排查。"]
    return {
        "query": raw_query,
        "scenario": scen.get("name"),
        "mindset_hint": scen.get("mindset"),
        "results": items,
        "markdown": "\n".join(md_lines),
    }


async def _run_memory_recall(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    category = str(args.get("category") or "conversation").strip().lower() or "conversation"
    project = str(args.get("project") or "").strip().lower()
    days = max(1, min(int(args.get("days") or 7), 180))
    limit = max(1, min(int(args.get("limit") or 10), 30))
    date_str = str(args.get("date") or "").strip()

    if date_str:
        from ..api.daily import get_daily
        daily = await get_daily(date_str=date_str, tz_offset=-480, db=db, _user=user)
        convs = (daily.get("overview") or {}).get("conversations") or []
        if project:
            convs = [c for c in convs if project in str(c.get("title") or "").lower()]
        convs = convs[:limit]
        lines = [f"日期 {date_str} 的对话记录（共 {len(convs)} 条）："]
        for c in convs:
            lines.append(
                f"- [{c.get('tool_id')}] {c.get('title') or str(c.get('id', ''))[:8]} "
                f"(↑{c.get('user_messages', 0)} ↓{c.get('assistant_messages', 0)}) — doc_id: `{c.get('id')}`"
            )
        if not convs:
            lines = [f"{date_str} 没有匹配的对话记录。"]
        return {"date": date_str, "items": convs, "markdown": "\n".join(lines)}

    mids = await user_machine_ids(db, user)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    q = (
        select(
            Document.id,
            Document.tool_id,
            Document.category,
            Document.title,
            Document.relative_path,
            Document.synced_at,
            Document.ai_summary,
        )
        .where(Document.category == category, Document.synced_at >= cutoff)
        .order_by(Document.synced_at.desc())
        .limit(limit * 4)
    )
    q = apply_user_filter(q, mids, Document.machine_id)
    rows = (await db.execute(q)).all()
    items = []
    for doc_id, tool_id, cat, title, rel_path, synced_at, ai_summary in rows:
        if _is_noise_path(rel_path):
            continue
        hay = f"{title or ''} {rel_path or ''}".lower()
        if project and project not in hay:
            continue
        items.append({
            "doc_id": str(doc_id),
            "tool": tool_id,
            "category": cat,
            "title": title or (rel_path.rsplit("/", 1)[-1] if rel_path else "Untitled"),
            "path": rel_path,
            "synced_at": synced_at.isoformat() if synced_at else None,
            "summary": (ai_summary or "")[:240] if ai_summary else None,
        })
        if len(items) >= limit:
            break

    lines = [f"最近 {days} 天的 {category} 记忆（共 {len(items)} 条）："]
    for it in items:
        s_txt = f" · {it['summary'][:120]}" if it.get("summary") else ""
        lines.append(f"- [{it['tool']}] {it['title']} ({_day(it['synced_at'])}) — doc_id: `{it['doc_id']}`{s_txt}")
    if not items:
        lines = [f"最近 {days} 天内没有类别为 {category} 的匹配记忆。"]
    return {"category": category, "days": days, "items": items, "markdown": "\n".join(lines)}


async def _run_memory_open(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .content_staging import with_pending
    from .permission_service import can_view_document

    doc_uuid = _parse_uuid(args.get("doc_id"))
    if not doc_uuid:
        return {"error": "doc_id 必须是有效的文档 UUID"}
    offset = max(0, int(args.get("offset_chars") or 0))
    max_chars = max(500, min(int(args.get("max_chars") or 10000), 20000))

    mids = await user_machine_ids(db, user)
    doc = (await db.execute(
        select(Document).options(defer(Document.rendered_html)).where(Document.id == doc_uuid)
    )).scalar_one_or_none()
    if not doc or not await can_view_document(db, user, doc):
        return {"error": "文档不存在或无权限查看"}
    if mids is not None and doc.machine_id not in mids:
        return {"error": "文档不存在或无权限查看"}

    full_content = await with_pending(db, doc.id, doc.content) or ""
    total_chars = len(full_content)
    chunk = full_content[offset:offset + max_chars]
    has_more = (offset + len(chunk)) < total_chars

    header = (
        f"# {doc.title or doc.relative_path or 'Untitled'}\n"
        f"工具: {doc.tool_id} · 类别: {doc.category} · 同步时间: {_day(doc.synced_at)}\n"
        f"路径: `{doc.relative_path}` · 字符范围: {offset}-{offset + len(chunk)} / {total_chars}"
    )
    if doc.ai_summary:
        header += f"\nAI 摘要: {doc.ai_summary}"
    md = f"{header}\n\n---\n{chunk or '(空文档)'}"
    if has_more:
        md += f"\n\n_(文档尚未读完，后续请传 offset_chars={offset + len(chunk)})_"
    return {
        "doc_id": str(doc.id),
        "title": doc.title or doc.relative_path,
        "tool": doc.tool_id,
        "category": doc.category,
        "path": doc.relative_path,
        "total_chars": total_chars,
        "has_more": has_more,
        "next_offset": offset + len(chunk) if has_more else None,
        "content": chunk,
        "markdown": md,
    }


async def _run_memory_conversation(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .conversation_parser import parse_conversation

    doc_uuid = _parse_uuid(args.get("doc_id"))
    if not doc_uuid:
        return {"error": "doc_id 必须是有效的对话文档 UUID"}
    limit = max(1, min(int(args.get("limit") or 35), 100))
    offset = max(0, int(args.get("offset") or 0))
    include_tools = bool(args.get("include_tools", False))

    mids = await user_machine_ids(db, user)
    doc = (await db.execute(
        select(Document).options(defer(Document.rendered_html), defer(Document.metadata_)).where(Document.id == doc_uuid)
    )).scalar_one_or_none()
    if not doc or (mids is not None and doc.machine_id not in mids):
        return {"error": "对话文档不存在或无权限查看"}

    base_filters = [ConversationMessage.document_id == doc_uuid]
    if not include_tools:
        base_filters.append(ConversationMessage.role.in_(("user", "assistant")))

    total = (await db.execute(select(func.count()).where(*base_filters))).scalar() or 0
    messages: list[dict[str, Any]] = []
    if total > 0:
        rows = (await db.execute(
            select(ConversationMessage)
            .where(*base_filters)
            .order_by(ConversationMessage.line_number.asc(), ConversationMessage.id.asc())
            .offset(offset)
            .limit(limit)
        )).scalars().all()
        for r in rows:
            txt = (r.content or "").strip()
            if not include_tools and (not txt or txt.startswith("[Tool:") or txt.startswith("[Result]")):
                continue
            messages.append({
                "role": r.role or "user",
                "timestamp": r.timestamp.isoformat()[:19].replace("T", " ") if r.timestamp else "",
                "tool_name": r.tool_name,
                "content": txt[:1500],
            })
    elif doc.content:
        parsed = parse_conversation(doc.content, doc.tool_id)
        filtered = [p for p in parsed if include_tools or p.role in ("user", "assistant")]
        total = len(filtered)
        for p in filtered[offset:offset + limit]:
            messages.append({
                "role": p.role,
                "timestamp": str(p.timestamp or "")[:19].replace("T", " "),
                "tool_name": getattr(p, "tool_name", None),
                "content": (p.content or "")[:1500],
            })

    lines = [f"# 对话：{doc.title or doc.relative_path} ({doc.tool_id})", f"_展示第 {offset + 1}-{offset + len(messages)} 条，共 {total} 条_\n"]
    for m in messages:
        head = f"### {m['role']}" + (f" ({m['timestamp']})" if m["timestamp"] else "")
        if m.get("tool_name"):
            head += f" · tool `{m['tool_name']}`"
        lines.append(f"{head}\n{m['content']}")
    if not messages:
        lines.append("(当前分页没有可展示的对话消息)")
    return {
        "doc_id": str(doc.id),
        "title": doc.title or doc.relative_path,
        "total": total,
        "offset": offset,
        "messages": messages,
        "markdown": "\n\n".join(lines),
    }


async def _run_memory_context(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from ..api.projects import _resolve_codebase_blueprint
    from .ingest_service import _clean_source_path

    project_name = str(args.get("project_name") or "").strip()
    if not project_name:
        return {"error": "project_name is required"}
    project = await _find_project_by_name(db, user, project_name)
    if not project:
        return {"error": f"未找到匹配「{project_name}」的项目，可先调用 memory_project_map 查看全部项目。"}

    mids = await user_machine_ids(db, user)
    codebase_bp = await _resolve_codebase_blueprint(db, project, mids)

    curated_cats = ("identity", "memory", "plan", "learning", "note")
    docs_q = (
        select(Document)
        .options(defer(Document.metadata_), defer(Document.rendered_html))
        .where(Document.project_id == project.id)
        .order_by(Document.synced_at.desc())
        .limit(60)
    )
    docs_q = apply_user_filter(docs_q, mids, Document.machine_id)
    docs = [d for d in (await db.execute(docs_q)).scalars().all() if not _is_noise_path(d.relative_path)]

    parts = [
        f"# 项目上下文：{project.title or project.slug}",
        f"工具: {project.tool_id or 'universal'} · 路径: `{_clean_source_path(project.source_path) or '?'}`",
    ]
    if codebase_bp:
        parts.append("\n## 代码蓝图速览 (CODE_BLUEPRINT.md)\n" + blueprint_section(codebase_bp, "summary"))

    curated = [d for d in docs if d.category in curated_cats and not (codebase_bp and _is_code_blueprint_path(d.relative_path))]
    others = [d for d in docs if d not in curated and not (codebase_bp and _is_code_blueprint_path(d.relative_path))]

    if curated:
        parts.append(f"\n## 精选文档（{len(curated)} 篇）")
        for d in curated[:8]:
            parts.append(f"\n### [{d.category}] {d.title or d.relative_path} (doc_id: `{d.id}`)")
            if d.ai_summary:
                parts.append(f"摘要：{d.ai_summary}")
            body = (d.content or "").strip()
            if body:
                parts.append(_opening(body, 900))
    if others:
        parts.append(f"\n## 其他文档与对话（最近 {min(len(others), 15)} 篇）")
        for d in others[:15]:
            parts.append(f"- [{d.category}] {d.title or d.relative_path} ({_day(d.synced_at)}) — doc_id: `{d.id}`")

    md = "\n".join(parts)
    return {
        "project_id": str(project.id),
        "project": project.title or project.slug,
        "source_path": _clean_source_path(project.source_path),
        "markdown": md,
    }


async def _run_memory_blueprint(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    project_name = str(args.get("project_name") or "").strip()
    if not project_name:
        return {"error": "project_name is required"}
    section = str(args.get("section") or "summary").strip() or "summary"
    recent_convs = max(0, min(int(args.get("recent_conversations", 8) or 0), 20))

    if project_name.lower() in ("me", "user", "global", "个人", "用户", "user_blueprint"):
        from .user_blueprint_service import build_user_blueprint
        ubp = await build_user_blueprint(db, user)
        md = str(ubp.get("markdown") or "")
        if not md:
            return {"error": "暂无个人全域蓝图数据"}
        sliced = blueprint_section(md, section)
        return {"scope": "user", "section": section, "markdown": sliced}

    project = await _find_project_by_name(db, user, project_name)
    if not project:
        return {"error": f"未找到匹配「{project_name}」的项目，可先调用 memory_project_map 查看项目清单。"}

    from ..api.projects import get_project_blueprint
    bp = await get_project_blueprint(project_id=project.id, recent_convs=recent_convs, db=db, _user=user)
    proj = bp.get("project") or {}
    counts = bp.get("counts") or {}
    codebase_bp = str(bp.get("codebase_blueprint") or "")
    business_bp = str(bp.get("business_blueprint") or "")
    uncovered = [str(r) for r in (bp.get("business_uncovered_rules") or [])]

    want_business = bool(re.match(r"^business", section, re.IGNORECASE))
    only_sections = (not want_business) and section.lower() not in ("summary", "all", "full", "")

    header = f"# 蓝图 — {proj.get('title') or project_name}"
    if want_business:
        if business_bp:
            md = f"{header}\n\n{business_section(business_bp, section, uncovered)}"
        else:
            extra = ("\n\n用户规则：\n" + "\n".join(f"- {r}" for r in uncovered)) if uncovered else ""
            md = f"{header}\n\n该项目尚未生成 BUSINESS_BLUEPRINT.md。{extra}"
        return {"project": proj.get("title"), "section": section, "markdown": md}

    if only_sections:
        md = f"{header}\n\n{blueprint_section(codebase_bp, section)}" if codebase_bp else f"{header}\n\n该项目暂无代码蓝图。"
        return {"project": proj.get("title"), "section": section, "markdown": md}

    out = [
        header,
        f"工具: `{proj.get('tool_id') or '?'}` · 路径: `{proj.get('source_path') or '?'}`",
        f"_精选文档={counts.get('curated_docs', 0)} · 近期对话={counts.get('recent_conversations', 0)} · 实体={counts.get('entities', 0)} · 观察={counts.get('total_observations', 0)}_",
        "",
    ]
    if codebase_bp:
        out.extend(["## 代码架构蓝图 (CODE_BLUEPRINT.md)", "", blueprint_section(codebase_bp, section), ""])

    check = bp.get("business_check") or {}
    if business_bp or uncovered:
        out.append("## 业务蓝图 (BUSINESS_BLUEPRINT.md)")
        if business_bp and "rules" in check:
            out.append(
                f"规则 {check.get('rules')}（正常 {check.get('ok')} · 预警 {check.get('warn')} · 失效 {check.get('fail')}）"
                f"· 流程 {check.get('flows')} · 术语 {check.get('terms')} · 状态 {check.get('states')}"
            )
        if uncovered:
            out.append(f"另有 {len(uncovered)} 条用户规则尚未写入业务蓝图。")
        out.append('_传 section="business" 查看索引与未覆盖规则，"business:3" 查看规则正文。_')
        out.append("")

    brief = section.lower() not in ("all", "full")
    curated = [
        d for d in (bp.get("curated_docs") or [])
        if not (codebase_bp and _is_code_blueprint_path(d.get("relative_path")))
        and not str(d.get("relative_path") or "").endswith("/BUSINESS_BLUEPRINT.md")
    ]
    if curated:
        out.append("## 精选文档")
        for d in curated[:8]:
            out.append(f"### [{d.get('category')}] {d.get('title') or d.get('relative_path')} (`{d.get('id')}`)")
            if d.get("ai_summary"):
                out.append(f"摘要：{d['ai_summary']}")
            body = str(d.get("content") or "")
            if body:
                head = _opening(body, _DOC_OPENING_CHARS) if brief else body
                out.append(head + ("\n…" if len(head) < len(body) else ""))
        out.append("")

    entities = (bp.get("knowledge_graph") or {}).get("entities") or []
    if entities:
        out.append("## 知识图谱关联")
        for e in entities[:8]:
            out.append(f"- {e.get('name')} ({e.get('entity_type')}): {e.get('summary') or ''}")
            for o in (e.get("observations") or [])[:3]:
                out.append(f"  · [{_day(o.get('observed_at'))}] {o.get('content')}")
        out.append("")

    convs = bp.get("recent_conversations") or []
    if convs:
        out.append("## 近期对话")
        for c in convs[:recent_convs]:
            summ = f" — {str(c.get('ai_summary') or '')[:140]}" if c.get("ai_summary") else ""
            out.append(f"- {c.get('title') or 'Untitled'} ({_day(c.get('synced_at'))}, {c.get('tool_id')}) doc_id=`{c.get('id')}`{summ}")

    return {"project": proj.get("title"), "section": section, "markdown": "\n".join(out)}


async def _run_memory_project_map(db: AsyncSession, user: User) -> dict[str, Any]:
    from .ingest_service import _clean_source_path

    mids = await user_machine_ids(db, user)
    doc_counts_q = select(Document.project_id, func.count().label("cnt")).where(Document.project_id.isnot(None))
    doc_counts_q = apply_user_filter(doc_counts_q, mids, Document.machine_id)
    doc_counts_q = doc_counts_q.group_by(Document.project_id)
    counts_map = {pid: int(cnt) for pid, cnt in (await db.execute(doc_counts_q)).all()}

    projs = (await db.execute(select(Project).order_by(Project.updated_at.desc().nulls_last()))).scalars().all()
    items = []
    for p in projs:
        cnt = counts_map.get(p.id, 0)
        if mids is not None and cnt == 0:
            continue
        items.append({
            "project_id": str(p.id),
            "title": p.title or p.slug,
            "slug": p.slug,
            "tool": p.tool_id or "universal",
            "source_path": _clean_source_path(p.source_path),
            "document_count": cnt,
            "summary": (p.ai_summary or "")[:160] if getattr(p, "ai_summary", None) else "",
        })
    items.sort(key=lambda x: x["document_count"], reverse=True)
    lines = [f"# Memento 项目全景图（共 {len(items)} 个项目）"]
    for it in items[:40]:
        path_part = f" · `{it['source_path']}`" if it.get("source_path") else ""
        sum_part = f" — {it['summary']}" if it.get("summary") else ""
        lines.append(f"- {it['title']} (`{it['slug']}`) [{it['tool']}] · {it['document_count']} 篇文档{path_part}{sum_part}")
    if not items:
        lines = ["当前还没有同步任何项目。"]
    return {"count": len(items), "projects": items[:40], "markdown": "\n".join(lines)}


async def _run_memory_graph(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    entity_name = str(args.get("entity_name") or "").strip()
    if not entity_name:
        return {"error": "entity_name is required"}
    limit = max(1, min(int(args.get("limit") or 5), 15))
    admin = sees_all(user)
    pattern = f"%{entity_name}%"

    name_rank = case(
        (func.lower(KnowledgeEntity.name) == entity_name.lower(), 0),
        (KnowledgeEntity.name.ilike(f"{entity_name}%"), 1),
        (KnowledgeEntity.name.ilike(pattern), 2),
        else_=3,
    )
    ent_q = (
        select(KnowledgeEntity)
        .where(or_(KnowledgeEntity.name.ilike(pattern), KnowledgeEntity.summary.ilike(pattern)))
        .order_by(name_rank, KnowledgeEntity.updated_at.desc().nulls_last())
        .limit(limit)
    )
    if not admin:
        ent_q = ent_q.where(KnowledgeEntity.user_id == user.id)
    entities = list((await db.execute(ent_q)).scalars().all())

    if not entities:
        obs_q = (
            select(KnowledgeObservation, KnowledgeEntity.name)
            .join(KnowledgeEntity, KnowledgeObservation.entity_id == KnowledgeEntity.id)
            .where(KnowledgeObservation.content.ilike(pattern))
            .order_by(KnowledgeObservation.observed_at.desc().nulls_last())
            .limit(limit)
        )
        if not admin:
            obs_q = obs_q.where(KnowledgeEntity.user_id == user.id)
        obs_rows = (await db.execute(obs_q)).all()
        if not obs_rows:
            return {"entity_name": entity_name, "found": False, "markdown": f"知识图谱中未找到与「{entity_name}」相关的实体或观察记录。"}
        lines = [f"# 提及「{entity_name}」的知识观察"]
        obs_out = []
        for o, ename in obs_rows:
            lines.append(f"- [{ename}] {o.content}")
            obs_out.append({"entity": ename, "content": o.content, "observed_at": _day(o.observed_at)})
        return {"entity_name": entity_name, "found": True, "observations": obs_out, "markdown": "\n".join(lines)}

    primary = entities[0]
    obs_list = (await db.execute(
        select(KnowledgeObservation)
        .where(KnowledgeObservation.entity_id == primary.id)
        .order_by(KnowledgeObservation.observed_at.desc().nulls_last())
        .limit(15)
    )).scalars().all()
    outgoing = (await db.execute(
        select(KnowledgeRelation, KnowledgeEntity)
        .join(KnowledgeEntity, KnowledgeRelation.target_id == KnowledgeEntity.id)
        .where(KnowledgeRelation.source_id == primary.id)
        .limit(15)
    )).all()
    incoming = (await db.execute(
        select(KnowledgeRelation, KnowledgeEntity)
        .join(KnowledgeEntity, KnowledgeRelation.source_id == KnowledgeEntity.id)
        .where(KnowledgeRelation.target_id == primary.id)
        .limit(15)
    )).all()

    parts = [f"# 实体：{primary.name} ({primary.entity_type})"]
    if primary.summary:
        parts.append(primary.summary)
    if outgoing:
        parts.append("\n## 关联关系（出向）")
        parts.extend(f"- {rel.relation_type} → {tgt.name} ({tgt.entity_type})" for rel, tgt in outgoing)
    if incoming:
        parts.append("\n## 关联关系（入向）")
        parts.extend(f"- {src.name} ({src.entity_type}) → {rel.relation_type} → {primary.name}" for rel, src in incoming)
    if obs_list:
        parts.append("\n## 最新观察记录")
        parts.extend(f"- [{_day(o.observed_at)}] {o.content}" for o in obs_list)
    if len(entities) > 1:
        parts.append("\n## 其他候选实体")
        parts.extend(f"- {e.name} ({e.entity_type})" for e in entities[1:])

    return {
        "found": True,
        "entity": {
            "id": str(primary.id),
            "name": primary.name,
            "type": primary.entity_type,
            "summary": primary.summary,
        },
        "observations": [{"content": o.content, "observed_at": _day(o.observed_at)} for o in obs_list],
        "outgoing_relations": [{"relation": r.relation_type, "target": t.name, "type": t.entity_type} for r, t in outgoing],
        "incoming_relations": [{"relation": r.relation_type, "source": s.name, "type": s.entity_type} for r, s in incoming],
        "markdown": "\n".join(parts),
    }


async def _run_memory_core(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .dreaming_service import export_core_memory_markdown

    category = str(args.get("category") or "").strip().lower() or None
    if not category:
        md = await export_core_memory_markdown(db, user, exclude=["pitfall"])
        return {"category": "all", "markdown": md or "暂无已沉淀的核心记忆。"}

    stmt = (
        select(UserMemory)
        .where(
            UserMemory.user_id == user.id,
            UserMemory.status == "active",
            UserMemory.is_folder.is_(False),
        )
        .order_by(UserMemory.confidence.desc().nulls_last(), UserMemory.updated_at.desc().nulls_last())
        .limit(40)
    )
    if category in ("rule", "rules"):
        stmt = stmt.where(UserMemory.category.in_(["rule", "rules"]))
    elif category in ("tool", "tools"):
        stmt = stmt.where(UserMemory.category.in_(["tool", "tools"]))
    else:
        stmt = stmt.where(UserMemory.category == category)

    rows = (await db.execute(stmt)).scalars().all()
    if rows:
        try:
            from .memory_lifecycle import touch_recalled
            await touch_recalled(m.id for m in rows)
        except Exception:
            pass
    if not rows:
        return {"category": category, "items": [], "markdown": f"分类「{category}」下暂无核心记忆。"}
    items = [{"key": r.key, "confidence": r.confidence, "content": r.content} for r in rows]
    lines = [f"# 核心记忆（{category}，共 {len(items)} 条）"]
    lines.extend(f"- [{it['key']}] ({it['confidence'] or 1.0}): {it['content']}" for it in items)
    return {"category": category, "items": items, "markdown": "\n".join(lines)}


async def _run_memory_store(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .entity_canon import find_entity

    content = str(args.get("content") or "").strip()
    if not content:
        return {"error": "content is required"}
    name = str(args.get("entity_name") or "").strip() or "Note"
    etype = str(args.get("entity_type") or "concept").strip() or "concept"

    existing = await find_entity(db, user.id, name, etype)
    if existing is None:
        entity = KnowledgeEntity(user_id=user.id, name=name, entity_type=etype)
        db.add(entity)
        await db.flush()
    else:
        entity = existing

    obs = KnowledgeObservation(entity_id=entity.id, content=content)
    db.add(obs)
    await db.commit()
    return {
        "saved": True,
        "entity_id": str(entity.id),
        "entity_name": entity.name,
        "observation_id": str(obs.id),
        "markdown": f"已将记忆写入实体「{entity.name}」({etype})：{content[:160]}",
    }


async def _run_daily_summary(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from ..api.daily import get_daily

    target = str(args.get("date_str") or "").strip() or datetime.now(_LOCAL_TZ).strftime("%Y-%m-%d")
    data = await get_daily(date_str=target, tz_offset=-480, db=db, _user=user)
    total = int(data.get("total_messages") or 0)
    if total == 0:
        return {"date": target, "total_messages": 0, "markdown": f"{target} 暂无同步的活动记录。"}

    overview = data.get("overview") or {}
    tool_stats = overview.get("tool_stats") or {}
    conversations = overview.get("conversations") or []
    summaries = data.get("summaries") or []

    parts = [f"# 日报活动摘要 — {target}", f"总消息数：{total}", "\n## 工具分布"]
    for t_name, cnt in sorted(tool_stats.items(), key=lambda kv: kv[1], reverse=True):
        parts.append(f"- {t_name}: {cnt} 条消息")
    if conversations:
        parts.append("\n## 主要对话")
        for c in conversations[:10]:
            parts.append(
                f"- [{c.get('tool_id')}] {c.get('title') or str(c.get('id', ''))[:8]} "
                f"(↑{c.get('user_messages', 0)} ↓{c.get('assistant_messages', 0)}) — doc_id: `{c.get('id')}`"
            )
    if summaries:
        for sm in summaries:
            parts.append(f"\n## {sm.get('title') or 'AI 日报总结'}\n{sm.get('summary') or ''}")
    return {
        "date": target,
        "total_messages": total,
        "tool_stats": tool_stats,
        "conversations": conversations[:10],
        "markdown": "\n".join(parts),
    }


async def _run_check_rules(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .guidance_service import guidance_for, render_guidance
    from .mind_resonance_service import enrich_check_rules_result, sense_resonance

    act = str(args.get("action") or "")
    proj = args.get("project")
    det = args.get("detail")
    g = await guidance_for(db, user, act, proj, det)
    base_guidance = render_guidance(g)
    res = await sense_resonance(db, user, query=det, project=proj, action=act)
    full_guidance = enrich_check_rules_result(base_guidance, res)
    return {"guidance": full_guidance, "markdown": full_guidance}


async def _run_use_skill(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .guidance_service import score, terms_for
    from .mind_resonance_service import detect_scenario, enrich_skill_with_mindset
    from .skill_service import render_skill_md

    wanted = str(args.get("name") or "").strip().lower()
    skills = (await db.execute(
        select(Skill).where(Skill.user_id == user.id, Skill.status == "published")
        .order_by(Skill.last_seen_at.desc().nulls_last())
    )).scalars().all()
    if not skills:
        return {"skills": [], "markdown": "目前还没有已发布的技能。"}
    if not wanted:
        listing = "\n".join(f"- `{s.slug}` {s.title}：{s.description}" for s in skills[:30])
        return {"available": [s.slug for s in skills], "markdown": f"# 已发布技能列表（{len(skills)} 个）\n{listing}"}

    exact = next((s for s in skills if s.slug.lower() == wanted), None)
    if exact is None:
        terms = terms_for(wanted)
        ranked = sorted(skills, key=lambda s: score(f"{s.slug} {s.title} {s.description}", terms), reverse=True)
        exact = ranked[0] if ranked and score(f"{ranked[0].slug} {ranked[0].title} {ranked[0].description}", terms) else None
    if exact is None:
        return {"error": "没有匹配的技能", "available": [s.slug for s in skills]}

    base_skill_md = render_skill_md(exact)
    terms = terms_for(exact.slug, None, exact.title)
    scen = detect_scenario(terms, f"{exact.slug} {exact.title} {exact.description}")
    enriched_skill_md = enrich_skill_with_mindset(base_skill_md, scen)
    return {"slug": exact.slug, "skill": enriched_skill_md, "markdown": enriched_skill_md}


async def _run_remember_pitfall(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .retrospective_service import save_pitfall

    mem = await save_pitfall(db, user, args, None, "agent")
    await db.commit()
    ok = bool(mem)
    note = None if ok else "信息不全、属于 AI 自己的操作失误，或已经记过"
    return {
        "saved": ok,
        "note": note,
        "markdown": f"已记录避坑经验：{args.get('title')}" if ok else f"未保存：{note}",
    }


async def _run_add_todo(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .guidance_service import terms_for
    from .mind_resonance_service import detect_scenario, enrich_todo_creation
    from .todo_service import add_todo, parse_due, todo_out

    raw_title = str(args.get("title") or "")
    raw_proj = args.get("project")
    terms = terms_for(None, raw_proj, raw_title)
    scen = detect_scenario(terms, raw_title)
    clean_title, aligned_proj, hint = enrich_todo_creation(raw_title, raw_proj, scen)
    try:
        todo, created = await add_todo(
            db, user, clean_title, detail=args.get("detail"), project=aligned_proj,
            due_at=parse_due(args.get("due")), source="agent",
        )
    except ValueError as e:
        return {"error": str(e)}
    await db.commit()
    out = todo_out(todo)
    res_payload: dict[str, Any] = {
        "todo": out,
        "created": created,
        "markdown": f"{'已新增待办' if created else '待办已存在'}：[{str(out.get('id', ''))[:8]}] {out.get('title')}",
    }
    if hint:
        res_payload["mindset_hint"] = hint
    return res_payload


async def _run_list_todos(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .todo_service import open_todos, todo_out

    todos = await open_todos(db, user)
    project = str(args.get("project") or "").lower()
    if project:
        todos = [t for t in todos if project in (t.project or "").lower()]
    items = [todo_out(t) for t in todos[:30]]
    lines = [f"# 未完成待办（共 {len(items)} 条）"]
    for it in items:
        extra = [x for x in (f"截止 {it['due']}" if it.get("due") else "", it.get("project") or "") if x]
        suffix = f" ({', '.join(extra)})" if extra else ""
        lines.append(f"- [{str(it.get('id', ''))[:8]}] {it.get('title')}{suffix}")
    if not items:
        lines = ["当前没有未完成的待办事项。"]
    return {"todos": items, "markdown": "\n".join(lines)}


async def _run_todo_update(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .todo_service import clean_title, close_todo, fingerprint, parse_due, todo_out

    raw_id = str(args.get("todo_id") or "").strip()
    if not raw_id:
        return {"error": "todo_id is required"}

    todo: Todo | None = None
    full_uuid = _parse_uuid(raw_id)
    if full_uuid:
        todo = (await db.execute(
            select(Todo).where(Todo.id == full_uuid, Todo.user_id == user.id)
        )).scalar_one_or_none()
    else:
        rows = (await db.execute(
            select(Todo).where(Todo.user_id == user.id).order_by(Todo.created_at.desc()).limit(200)
        )).scalars().all()
        matches = [t for t in rows if str(t.id).startswith(raw_id.lower())]
        if len(matches) == 1:
            todo = matches[0]
        elif len(matches) > 1:
            return {"error": f"前缀 '{raw_id}' 匹配到 {len(matches)} 条待办，请提供更长 ID"}

    if todo is None:
        return {"error": f"未找到匹配 '{raw_id}' 的待办事项"}

    status = args.get("status")
    if status is not None:
        close_todo(todo, str(status), evidence="ai_orchestrator")
    if args.get("title") is not None:
        new_t = clean_title(str(args.get("title")))
        if new_t:
            todo.title = new_t
            todo.fingerprint = fingerprint(new_t)
    if "due" in args and args["due"] is not None:
        due_val = str(args["due"]).strip()
        todo.due_at = parse_due(due_val) if due_val else None

    await db.commit()
    out = todo_out(todo)
    return {
        "todo": out,
        "updated": True,
        "markdown": f"已更新待办 [{str(out.get('id', ''))[:8]}] {out.get('title')} → 状态：{out.get('status')}",
    }


async def _run_mind_resonance(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from .mind_resonance_service import render_mind_resonance_markdown, sense_resonance

    res = await sense_resonance(db, user, query=args.get("query"), project=args.get("project"), action=args.get("action"))
    md = render_mind_resonance_markdown(res)
    return {"resonance": md, "markdown": md}


async def _run_plan_status(db: AsyncSession, user: User, args: dict[str, Any]) -> dict[str, Any]:
    from . import plan_service

    raw_pid = str(args.get("plan_id") or "").strip()
    if raw_pid:
        pid = _parse_uuid(raw_pid)
        if not pid:
            return {"error": "plan_id 必须是有效的 UUID"}
        plan = await db.get(AgentPlan, pid)
        if not plan or plan.user_id != user.id:
            return {"error": "协作任务不存在或无权限"}
        out = plan_service.plan_out(plan)
        steps = out.get("steps") or []
        lines = [
            f"# 协作任务：{out.get('title') or raw_pid[:8]}",
            f"状态: {out.get('status')} · 链接: `/plans/{out.get('id')}`",
        ]
        if steps:
            lines.append("\n## 子步骤")
            for st in steps:
                lines.append(
                    f"- [{st.get('status')}] {st.get('title') or st.get('id')} "
                    f"({st.get('agent') or '?'} @ {st.get('device_name') or st.get('device_id') or 'auto'})"
                )
        if out.get("summary"):
            lines.append(f"\n## 汇总\n{str(out['summary'])[:1500]}")
        return {"plan": out, "markdown": "\n".join(lines)}

    limit = max(1, min(int(args.get("limit") or 5), 20))
    rows = (await db.execute(
        select(AgentPlan).where(AgentPlan.user_id == user.id).order_by(AgentPlan.created_at.desc()).limit(limit)
    )).scalars().all()
    plans = [plan_service.plan_out(p, full=False) for p in rows]
    lines = [f"# 最近协作任务（{len(plans)} 条）"]
    for p in plans:
        lines.append(f"- [{p.get('status')}] {p.get('title') or str(p.get('id', ''))[:8]} — plan_id: `{p.get('id')}`")
    if not plans:
        lines = ["暂无多设备协作任务记录。"]
    return {"plans": plans, "markdown": "\n".join(lines)}


async def _run_fetch_url(user: User, args: dict[str, Any]) -> dict[str, Any]:
    from ..api.documents import proxy_fetch_document

    url = str(args.get("url") or "").strip()
    if not url:
        return {"error": "url is required"}
    max_chars = max(500, min(int(args.get("max_chars") or 8000), 15000))
    res = await proxy_fetch_document(url=url, user=user)
    raw_content = str(res.get("content") or "")
    ctype = str(res.get("content_type") or "")
    cleaned = _html_to_clean_text(raw_content) if "html" in ctype.lower() else raw_content.strip()
    truncated = len(cleaned) > max_chars
    body = cleaned[:max_chars]
    md = f"来源: {res.get('url') or url} ({ctype or 'text'})\n\n{body}"
    if truncated:
        md += f"\n\n_(内容共 {len(cleaned)} 字符，已截断保留前 {max_chars} 字符)_"
    return {
        "url": res.get("url") or url,
        "content_type": ctype,
        "total_chars": len(cleaned),
        "truncated": truncated,
        "content": body,
        "markdown": md,
    }
