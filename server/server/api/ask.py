"""Ask API — RAG question answering over the user's synced memory.

Retrieval reuses the hybrid search built for /api/search (keyword + BGE-M3
vectors fused with RRF), then streams an LLM answer grounded in the retrieved
chunks, with citations back to the source documents.

Streaming is a raw SSE passthrough of the upstream OpenAI-compatible stream
rather than the pub/sub bus in services/sse_service.py — that bus is for
broadcasting sync events to a user's open tabs, whereas this is a per-request
token stream belonging to one caller.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from typing import AsyncGenerator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import or_, select, func
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, Machine, User, AskConversation, UserMemory, Project
from ..db.session import get_db, async_session_factory
from ..middleware.auth import get_current_user
from ..services.user_filter import user_machine_ids, apply_user_filter, find_machine_by_id_or_hash
from ..services.ai_provider import get_ai_providers, stream_chat_completion
from ..services.ask_runs import RunConflict, ask_runs
from ..services.memory_lifecycle import touch_recalled
from .search import _semantic_doc_ranks, RRF_K

logger = logging.getLogger("server.ask")

router = APIRouter(prefix="/api/ask", tags=["ask"])

# How many documents to ground the answer in. Above ~8 the prompt gets long
# enough that recall degrades (lost-in-the-middle) for no accuracy gain.
TOP_K = 6
# Per-document context budget. 6 x 1500 ~= 9k chars, comfortably inside a
# 32k-token context alongside the conversation history.
CHARS_PER_DOC = 1500
# Conversation turns kept for follow-ups. Older turns are dropped rather than
# summarized — cheap, and follow-ups nearly always reference recent context.
MAX_HISTORY_TURNS = 6

SYSTEM_PROMPT = """你是 Memento 的记忆助手。用户把自己在各种 AI 编程工具里的对话、笔记、计划都同步到了这里,你的任务是基于检索到的资料回答问题。

规则:
1. 只根据提供的「资料」回答。资料里没有的,直接说不知道,不要编造。
2. 引用时用 [1] [2] 这样的编号标注来源,编号对应资料的序号。
3. 用户问什么语言就用什么语言回答。
4. 简洁直接。有具体命令、配置、路径就原样给出,不要改写。
5. 如果资料只是部分相关,说清楚你能确定什么、不能确定什么。"""


class AskRequest(BaseModel):
    question: str
    conversation_id: str | None = None
    # Client-generated per send. A retry carrying the same id attaches to the run
    # the first attempt started instead of starting (and dispatching) it twice.
    request_id: str | None = None
    # [{"role": "user"|"assistant", "content": "..."}] — prior turns.
    history: list[dict] | None = None
    tool: str | None = None
    days: int | None = None
    # When true the model may also dispatch work to the user's devices.
    # Off by default: a plain ask must never be able to run anything.
    agent_mode: bool = False
    # Target device ID, or 'auto' for dynamic routing, or 'ask_only' for pure RAG.
    device_id: str | None = None
    # Optional default working directory for commands.
    cwd: str | None = None
    # Execution mode: 'ai' (default RAG/orchestrator), 'claude', 'codex', 'antigravity', 'shell'
    execution_mode: str | None = None
    # Model selection (e.g. 'gpt-5.5', 'claude-3-7-sonnet', 'flash', 'pro')
    model: str | None = None
    # Reasoning effort selection (e.g. 'low', 'medium', 'high')
    effort: str | None = None
    # Project ID (to scope context or working directory)
    project_id: str | None = None
    # Session ID to resume an existing conversation
    session_id: str | None = None
    # Force fork mode instead of resume when continuing conversation
    fork: bool | None = None
    # Run the agent in its own git worktree and branch, so parallel tasks on one
    # repository don't step on each other.
    worktree: bool | None = None
    # Smart sliding-window hierarchical context compaction
    compact_mode: bool | None = None
    # Optional execution timeout override in seconds (up to 3600)
    timeout_seconds: int | None = None
    # Multimodal image URLs / Base64 DataURLs (e.g. screenshots, camera photos)
    images: list[str] | None = None
    # Uploaded file / code attachments
    attachments: list[dict] | None = None


async def hybrid_rank(
    db: AsyncSession, user: User, q: str, tool: str | None, days: int | None, k: int = TOP_K,
) -> tuple[list[Document], list[uuid.UUID], list[uuid.UUID], dict]:
    """Documents for `q`, best first, plus each channel's own order (keyword, semantic)
    and the semantically matched snippets. The retrieval evaluation scores exactly this."""
    from ..services.tokenize import tokenize_for_query_any

    mids = await user_machine_ids(db, user)
    # Questions are natural language: any content word may match, best matches first.
    # (All-words-must-match with newest-first order returned nothing useful for real
    # questions; see the retrieval evaluation.)
    tsquery = tokenize_for_query_any(q)
    term = f"%{q}%"

    conds = [Document.title.ilike(term), Document.relative_path.ilike(term)]
    rank = None
    if tsquery:
        ts = func.to_tsquery("simple", tsquery)
        conds.append(Document.content_tsv.op("@@")(ts))
        rank = func.ts_rank(Document.content_tsv, ts, 1)

    kw_q = select(Document).where(or_(*conds))
    if tool:
        kw_q = kw_q.where(Document.tool_id == tool)
    if days:
        from datetime import datetime, timedelta, timezone

        kw_q = kw_q.where(
            Document.synced_at >= datetime.now(timezone.utc) - timedelta(days=days)
        )
    kw_q = apply_user_filter(kw_q, mids, Document.machine_id)
    order = (rank.desc(), Document.synced_at.desc()) if rank is not None else (Document.synced_at.desc(),)

    async def _fetch_kw():
        async with async_session_factory() as kw_db:
            return (await kw_db.execute(kw_q.order_by(*order).limit(k))).scalars().all()

    async def _fetch_sem():
        async with async_session_factory() as sem_db:
            return await _semantic_doc_ranks(sem_db, q, mids, tool, None, days, want=k)

    kw_docs, (sem_order, sem_snippets) = await asyncio.gather(_fetch_kw(), _fetch_sem())

    kw_rank = {d.id: i for i, d in enumerate(kw_docs)}
    sem_rank = {doc_id: i for i, doc_id in enumerate(sem_order)}

    docs = list(kw_docs)
    missing = [doc_id for doc_id in sem_order if doc_id not in kw_rank]
    if missing:
        extra_q = select(Document).where(Document.id.in_(missing))
        extra_q = apply_user_filter(extra_q, mids, Document.machine_id)
        docs += list((await db.execute(extra_q)).scalars().all())

    def rrf(d) -> float:
        score = 0.0
        if d.id in kw_rank:
            score += 1.0 / (RRF_K + kw_rank[d.id] + 1)
        if d.id in sem_rank:
            score += 1.0 / (RRF_K + sem_rank[d.id] + 1)
        return score

    docs.sort(key=rrf, reverse=True)
    return docs[:k], [d.id for d in kw_docs], list(sem_order), sem_snippets


def clean_conversation_excerpt(text: str, tool_id: str | None = None) -> str:
    """Transform raw conversation chunks/JSONL into human-readable dialogue excerpts."""
    if not text:
        return ""

    from ..services.conversation_parser import _iter_json_objects, parse_conversation_line

    cleaned_parts: list[str] = []
    has_json = "{" in text and "}" in text
    if has_json:
        for raw_obj_str in _iter_json_objects(text):
            raw_obj_str = raw_obj_str.strip()
            if not raw_obj_str:
                continue
            norm = parse_conversation_line(raw_obj_str, tool_id or "antigravity")
            if not norm and tool_id != "codex":
                norm = parse_conversation_line(raw_obj_str, "codex")
            if not norm and tool_id != "claude_code":
                norm = parse_conversation_line(raw_obj_str, "claude_code")

            if norm and norm.role in ("user", "assistant"):
                role_label = "用户" if norm.role == "user" else "助手"
                clean_body = norm.content.strip()
                clean_body = re.sub(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", r"\1", clean_body, flags=re.DOTALL)
                clean_body = re.sub(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", "", clean_body, flags=re.DOTALL)
                clean_body = re.sub(r"<USER_SETTINGS_CHANGE>.*?</USER_SETTINGS_CHANGE>", "", clean_body, flags=re.DOTALL)
                clean_body = re.sub(r"<system-reminder>.*?</system-reminder>", "", clean_body, flags=re.DOTALL)
                clean_body = re.sub(r"<ide_opened_file>.*?</ide_opened_file>", "", clean_body, flags=re.DOTALL)
                clean_body = clean_body.strip()
                if clean_body and clean_body != "[Request interrupted by user]":
                    cleaned_parts.append(f"{role_label}: {clean_body}")
            elif norm and norm.role == "tool" and norm.tool_name:
                cleaned_parts.append(f"[调用工具: {norm.tool_name}]")

    if cleaned_parts:
        return "\n\n".join(cleaned_parts)

    plain = text.strip()
    plain = re.sub(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", r"用户: \1", plain, flags=re.DOTALL)
    plain = re.sub(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", "", plain, flags=re.DOTALL)
    plain = re.sub(r"<USER_SETTINGS_CHANGE>.*?</USER_SETTINGS_CHANGE>", "", plain, flags=re.DOTALL)
    plain = re.sub(r"<system-reminder>.*?</system-reminder>", "", plain, flags=re.DOTALL)
    plain = re.sub(r"<ide_opened_file>.*?</ide_opened_file>", "", plain, flags=re.DOTALL)

    if plain.startswith(("{", "{\"timestamp\"", "{\"type\"", "{\"ordinal\"")):
        return ""
    return plain.strip()


async def _retrieve(
    db: AsyncSession, user: User, q: str, tool: str | None, days: int | None
) -> list[dict]:
    """Hybrid retrieval — the same keyword+vector RRF fusion as /api/search."""
    from ..services.ingest_service import _is_junk_or_uuid_title
    from ..db.models import ConversationMessage

    docs, _, _, sem_snippets = await hybrid_rank(db, user, q, tool, days)

    # Batch preload top conversation messages for conversation documents
    conv_doc_ids = [d.id for d in docs[:TOP_K] if d.category == "conversation"]
    cached_msgs: dict[uuid.UUID, list[tuple[str, str]]] = {}
    if conv_doc_ids:
        try:
            msg_rows = (await db.execute(
                select(ConversationMessage.document_id, ConversationMessage.role, ConversationMessage.content)
                .where(ConversationMessage.document_id.in_(conv_doc_ids))
                .where(ConversationMessage.role.in_(("user", "assistant")))
                .order_by(ConversationMessage.document_id, ConversationMessage.line_number)
            )).all()
            for doc_id, role, content in msg_rows:
                if doc_id not in cached_msgs:
                    cached_msgs[doc_id] = []
                if len(cached_msgs[doc_id]) < 4 and content and content.strip():
                    cached_msgs[doc_id].append((role, content.strip()))
        except Exception as e:
            logger.warning("Failed to preload conversation messages: %s", e)

    sources = []
    for d in docs[:TOP_K]:
        raw_text = sem_snippets.get(d.id) or ""
        clean_text = ""
        if d.category == "conversation":
            if raw_text:
                clean_text = clean_conversation_excerpt(raw_text, d.tool_id)
            if not clean_text and d.id in cached_msgs and cached_msgs[d.id]:
                clean_text = "\n\n".join(
                    f"{'用户' if r == 'user' else '助手'}: {c}"
                    for r, c in cached_msgs[d.id]
                )
            if not clean_text and d.content:
                clean_text = clean_conversation_excerpt(d.content[:3000], d.tool_id)
        else:
            clean_text = raw_text or (d.content or "")[:CHARS_PER_DOC]
            clean_text = re.sub(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", r"\1", clean_text, flags=re.DOTALL)
            clean_text = re.sub(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", "", clean_text, flags=re.DOTALL)

        if not clean_text:
            clean_text = "(无文字摘要)"

        # Fix display title if title is junk like "[Request interrupted by user]"
        display_title = d.title or (d.relative_path or "").split("/")[-1]
        if _is_junk_or_uuid_title(display_title):
            if d.id in cached_msgs and cached_msgs[d.id]:
                for r, c in cached_msgs[d.id]:
                    if r == "user" and c:
                        cand_title = c.split("\n")[0][:50].strip()
                        if not _is_junk_or_uuid_title(cand_title):
                            display_title = cand_title
                            break

        sources.append({
            "id": str(d.id),
            "title": display_title,
            "relative_path": d.relative_path,
            "tool_id": d.tool_id,
            "category": d.category,
            "synced_at": d.synced_at.isoformat() if d.synced_at else None,
            "excerpt": clean_text[:CHARS_PER_DOC],
        })
    return sources


async def _retrieve_core_memories(
    db: AsyncSession,
    user: User,
    question: str,
    project_id: str | None = None,
    cwd: str | None = None,
    session_id: str | None = None,
    limit: int = 12,
) -> list[UserMemory]:
    """Retrieve high-signal core memories (L3) with project-scoped prioritization.

    Prevents cross-project memory contamination (e.g. 30+ projects) by:
    1. Always including global rules and user preferences (rule, preference, general).
    2. Pinpointing project-specific memories (matching active project slug/path).
    3. Fusing keyword matching against UserMemory content for the current question.
    """
    proj_slug: str | None = None

    # A. Resolve active project identifier
    if project_id:
        try:
            p_uuid = uuid.UUID(project_id)
            p_obj = (await db.execute(select(Project).where(Project.id == p_uuid))).scalar_one_or_none()
            if p_obj:
                proj_slug = p_obj.slug
        except (ValueError, TypeError):
            proj_slug = project_id.strip()

    if not proj_slug and cwd:
        clean_cwd = cwd.strip().rstrip("/\\")
        bname = os.path.basename(clean_cwd)
        if bname:
            p_obj = (await db.execute(
                select(Project).where(or_(Project.slug == bname, Project.source_path.ilike(f"%{bname}%"))).limit(1)
            )).scalar_one_or_none()
            if p_obj:
                proj_slug = p_obj.slug
            else:
                proj_slug = bname

    collected: list[UserMemory] = []
    seen_ids: set[uuid.UUID] = set()

    def _add_mem(mem: UserMemory):
        if mem.id not in seen_ids and not mem.is_folder and (mem.content or "").strip():
            seen_ids.add(mem.id)
            collected.append(mem)

    # 1. Active project-scoped memories (Top priority)
    if proj_slug:
        slug_clean = proj_slug.lower()
        proj_q = (
            select(UserMemory)
            .where(
                UserMemory.user_id == user.id,
                UserMemory.is_folder.is_(False),
                UserMemory.status == "active",
                or_(
                    UserMemory.tree_path.ilike(f"%{slug_clean}%"),
                    UserMemory.key.ilike(f"%{slug_clean}%"),
                    UserMemory.category == "architecture",
                ),
            )
            .order_by(UserMemory.confidence.desc(), UserMemory.updated_at.desc())
            .limit(6)
        )
        for m in (await db.execute(proj_q)).scalars().all():
            _add_mem(m)

    # 2. Global rules, guidelines & developer preferences (Always preserved)
    rules_q = (
        select(UserMemory)
        .where(
            UserMemory.user_id == user.id,
            UserMemory.is_folder.is_(False),
            UserMemory.status == "active",
            UserMemory.category.in_(["rule", "rules", "preference", "general"]),
        )
        .order_by(UserMemory.confidence.desc(), UserMemory.updated_at.desc())
        .limit(6)
    )
    for m in (await db.execute(rules_q)).scalars().all():
        _add_mem(m)

    # 3. Keyword matching against user memory content for the current question
    tokens = [t.strip() for t in re.split(r"[\s,;，；]+", question) if len(t.strip()) >= 2]
    if tokens:
        kw_conds = [UserMemory.content.ilike(f"%{tok[:20]}%") for tok in tokens[:4]]
        if kw_conds:
            kw_q = (
                select(UserMemory)
                .where(
                    UserMemory.user_id == user.id,
                    UserMemory.is_folder.is_(False),
                    UserMemory.status == "active",
                    or_(*kw_conds),
                )
                .order_by(UserMemory.confidence.desc(), UserMemory.updated_at.desc())
                .limit(4)
            )
            for m in (await db.execute(kw_q)).scalars().all():
                _add_mem(m)

    # 4. Fill remaining budget with highest confidence general memories if needed
    if len(collected) < limit:
        remain = limit - len(collected)
        fill_q = (
            select(UserMemory)
            .where(
                UserMemory.user_id == user.id,
                UserMemory.is_folder.is_(False),
                UserMemory.status == "active",
            )
            .order_by(UserMemory.confidence.desc(), UserMemory.updated_at.desc())
            .limit(remain + 5)
        )
        for m in (await db.execute(fill_q)).scalars().all():
            if len(collected) >= limit:
                break
            _add_mem(m)

    chosen = collected[:limit]
    await touch_recalled(m.id for m in chosen)
    return chosen


ACTION_VERBS = (
    "关闭", "关掉", "关了", "关一下", "关了它", "关掉它", "把它关了", "把它关掉", "帮我关",
    "杀死", "杀掉", "杀了", "杀一下", "干掉", "结束", "终止", "掐死",
    "停止", "停掉", "停了", "停一下", "停了它", "停掉它", "把它停了",
    "清理", "清掉", "清除", "清理掉", "把它清理了", "帮我清理",
    "重启", "重新启动", "重启一下",
    "启动", "运行", "跑一下", "执行",
    "修复", "解决", "搞定", "搞一下", "处理", "接着修",
    "排查", "检查", "查一下", "查看", "看下", "看看",
    "删除", "删掉", "移除",
)

REFERENCE_TERMS = (
    "它", "它们", "这个", "那个", "这些", "那些", "上面", "刚才", "之前", "上个", "上一个",
    "遗留", "残留", "进程", "任务", "守护进程", "端口", "服务", "容器", "机器", "设备",
)

CONFIRMATION_TERMS = (
    "好", "好的", "行", "行吧", "可以", "可以的", "没问题", "确认", "同意", "同意执行",
    "搞起", "执行吧", "弄吧", "处理吧", "清理吧", "关吧", "杀吧", "停吧", "干吧",
    "ok", "OK", "yes", "YES", "y", "Y",
)

CONTINUATION_PHRASES = (
    "继续", "修复", "重试", "接着", "还没好", "没好", "再试", "重新",
    "还是报错", "依然报错", "解决一下", "搞定它", "接着修", "排查", "查一下", "启动一下",
    "怎么回事", "为什么", "关掉", "关闭", "杀掉", "杀死", "停掉", "停止", "清理掉",
)


def _classify_continuation(
    question: str,
    history: list[dict] | None,
) -> tuple[bool, bool, dict]:
    """Classify if the question is a continuation and whether it requires device action.

    Returns: (is_continuation, is_action, extracted_context)
    """
    q = question.strip()
    extracted = {
        "device_name": None,
        "device_id": None,
        "entities": [],
        "last_assistant_text": "",
    }
    if not history:
        return False, False, extracted

    last_asst = None
    for turn in reversed(history):
        if turn.get("role") == "assistant":
            last_asst = turn
            break

    last_asst_content = (last_asst.get("content") or "").strip() if last_asst else ""
    last_tool_calls = (last_asst.get("tool_calls") or last_asst.get("toolCalls") or []) if last_asst else []
    extracted["last_assistant_text"] = last_asst_content[:300]

    # Extract target device from previous tool calls
    for tc in reversed(last_tool_calls):
        args = tc.get("args") or {}
        dev = tc.get("device_name") or args.get("device_id")
        if dev and dev not in ("auto", "ask_only"):
            extracted["device_name"] = dev
            extracted["device_id"] = args.get("device_id") or dev
            break

    # If device not in tool_calls, search in assistant text
    if not extracted["device_name"] and last_asst_content:
        m_dev = re.search(r"(?:在|于|目标设备|设备)\s*[:：]?\s*([A-Za-z0-9_\-\s]{2,20}?)(?:上|的|设备|机器|\n|,|，)", last_asst_content)
        if m_dev:
            dev_candidate = m_dev.group(1).strip()
            if len(dev_candidate) >= 2 and not dev_candidate.isdigit():
                extracted["device_name"] = dev_candidate

    # Extract PID(s) and processes from assistant text
    if last_asst_content:
        pids = re.findall(r"(?:PID|pid)\s*[:：=]?\s*(\d{2,7})", last_asst_content)
        if not pids:
            pids = re.findall(r"\(PID\s*(\d{2,7})\)", last_asst_content)
        for pid in pids:
            ent = f"PID {pid}"
            if ent not in extracted["entities"]:
                extracted["entities"].append(ent)

        tasks = re.findall(r"(\d+\.\s*[^:\n]+(?:\(PID\s*\d+\))?\s*:\s*[^\n]+)", last_asst_content)
        for t in tasks[:2]:
            clean_t = t.strip()
            if clean_t not in extracted["entities"]:
                extracted["entities"].append(clean_t)

    q_lower = q.lower()
    has_continuation_phrase = any(kw in q for kw in CONTINUATION_PHRASES)
    has_action_verb = any(v in q for v in ACTION_VERBS)
    has_reference = any(r in q for r in REFERENCE_TERMS)
    is_confirmation = any(c == q_lower or q_lower.startswith(c) for c in CONFIRMATION_TERMS)

    asst_offered_action = any(
        phrase in last_asst_content
        for phrase in ("可以告诉我帮你清理", "帮你清理", "是否需要关闭", "帮您关闭", "要不要关掉", "是否关闭", "是否终止", "是否重启", "可以告诉我帮你", "需要我帮你")
    )

    is_cont = False
    is_action = False

    if len(q) <= 60:
        if has_continuation_phrase or is_confirmation:
            is_cont = True
        elif has_action_verb and (has_reference or "帮" in q or len(q) <= 15):
            is_cont = True
        elif has_reference and (has_action_verb or "吗" in q or "怎么" in q or "为什么" in q or "干嘛" in q or len(q) <= 20):
            is_cont = True
        elif asst_offered_action and (is_confirmation or has_action_verb or has_reference):
            is_cont = True

    if is_cont:
        if has_action_verb:
            is_action = True
        elif is_confirmation and asst_offered_action:
            is_action = True
        elif any(act in q for act in ("关", "杀", "停", "清", "重", "修", "执", "跑")):
            is_action = True

    return is_cont, is_action, extracted


def _format_tool_calls_summary(tool_calls: list[dict]) -> str:
    if not tool_calls:
        return ""
    lines = ["[系统记录：上一轮在设备上的操作与执行结果 (只读事实参考)]:"]
    for tc in tool_calls:
        name = tc.get("name") or "run_on_device"
        args = tc.get("args") or {}
        dev = tc.get("device_name") or args.get("device_id") or ""
        cmd = args.get("command") or args.get("prompt") or ""
        action = args.get("action") or ("shell" if "command" in args else "agent")
        status = tc.get("status") or "executed"
        exit_code = tc.get("exit_code")
        err = tc.get("stderr") or tc.get("error") or ""
        out = tc.get("stdout") or ""

        info = f"- 工具: {name} (类型: {action}"
        if dev:
            info += f", 目标设备: {dev}"
        info += ")"
        if cmd:
            info += f"\n  执行内容: {cmd}"
        info += f"\n  执行状态: {status}"
        if exit_code is not None:
            info += f" (退出码: {exit_code})"
        if err:
            info += f"\n  错误输出/stderr:\n```\n{err.strip()[:1500]}\n```"
        elif out:
            info += f"\n  终端输出/stdout:\n```\n{out.strip()[:600]}\n```"
        lines.append(info)
    return "\n".join(lines)


def _build_messages(
    question: str,
    sources: list[dict],
    history: list[dict] | None,
    is_continuation: bool = False,
    is_action: bool = False,
    extracted_context: dict | None = None,
    images: list[str] | None = None,
    attachments: list[dict] | None = None,
    core_memories: list[UserMemory] | None = None,
    user_profile_content: str | None = None,
    guidance_data: dict | None = None,
    device_id: str | None = None,
) -> list[dict]:
    context = "\n\n".join(
        f"[{i + 1}] {s['title']} ({s['tool_id']}, {s['relative_path']})\n{s['excerpt']}"
        for i, s in enumerate(sources)
    ) or "(没有检索到相关资料)"

    system_prompt = SYSTEM_PROMPT

    # 1. Resident User Profile (Highest priority: About Me, Rules, Preferences)
    if user_profile_content and user_profile_content.strip():
        system_prompt += f"\n\n【用户常驻画像与最高铁律 (关于我)】\n{user_profile_content.strip()}"

    # 2. Guidance (Rules & Pitfalls & Verified Skills)
    if guidance_data:
        from ..services.guidance_service import render_guidance
        rendered_g = render_guidance(guidance_data)
        if rendered_g.strip():
            system_prompt += f"\n\n{rendered_g.strip()}"

    # 3. Core Memories
    if core_memories:
        core_snippets = "\n".join(
            f"- [{m.category}/{m.key}]: {m.content}" for m in core_memories
        )
        system_prompt += f"\n\n【用户长期核心记忆与工程规范 (MEMORY.md)】\n{core_snippets}"

    # 4. Device Environment Fingerprint
    if device_id and device_id not in ("auto", "ask_only"):
        from .tasks import get_device_environment_summary
        env_summary = get_device_environment_summary(device_id)
        if env_summary:
            system_prompt += f"\n\n【目标设备就绪环境指纹画像】\n{env_summary}"

    messages = [{"role": "system", "content": system_prompt}]
    for turn in (history or [])[-MAX_HISTORY_TURNS:]:
        role = turn.get("role")
        content = (turn.get("content") or "").strip()
        tool_calls = turn.get("tool_calls") or turn.get("toolCalls") or []

        if role == "assistant":
            parts = []
            t_summary = _format_tool_calls_summary(tool_calls)
            if t_summary:
                parts.append(t_summary)
            # Filter out misleading empty or bogus fallback messages from previous turns
            if content and content != "任务已执行完成。" and "未获取到需要执行的具体设备操作" not in content:
                parts.append(content)
            combined = "\n\n".join(parts)
            if combined:
                messages.append({"role": role, "content": combined})
        elif role == "user" and content:
            messages.append({"role": role, "content": content})

    # Format text/code attachments into structured snippets
    attachment_snippets = []
    for att in (attachments or []):
        name = att.get("name") or "attachment"
        text = att.get("text_content")
        if text:
            ext = os.path.splitext(name)[1].lstrip(".") or ""
            attachment_snippets.append(f"【用户附加的文件: {name}】\n```{ext}\n{text}\n```")
    att_prefix = "\n\n".join(attachment_snippets)

    if is_action:
        dev_info = ""
        if extracted_context and extracted_context.get("device_name"):
            dev_info += f"- 目标设备: {extracted_context['device_name']}\n"
        if extracted_context and extracted_context.get("entities"):
            dev_info += f"- 涉及对象: {', '.join(extracted_context['entities'])}\n"

        user_prompt = (
            f"【跟进操作指令】\n"
            f"用户指令: 「{question}」\n"
        )
        if dev_info:
            user_prompt += f"上下文参考:\n{dev_info}"
        user_prompt += (
            f"规则与要求:\n"
            f"1. 必须仔细结合前序交互历史，主动调用 run_on_device 工具在目标物理机上执行真实操作（如 kill 进程、停止服务、重启等）！\n"
            f"2. 绝对严禁在文本中编写或伪造执行状态，所有操作必须通过触发真实的 run_on_device 工具下发！\n"
            f"3. 严禁在未调用工具前回复「未获取到操作」或直接结束！"
        )
        if sources:
            user_prompt = f"参考资料:\n{context}\n\n{user_prompt}"
    elif is_continuation:
        user_prompt = (
            f"【跟进与继续排查/修复指令】\n"
            f"用户指令: 「{question}」\n"
            f"请仔细结合上方历史记录中上一轮在设备上执行的命令、退出码以及报错日志（stderr），"
            f"分析原因，并在目标设备上主动调用 run_on_device 执行下一步排查或修复操作"
            f"（例如杀死占用端口的进程、修复代码/配置、安装依赖、重启并检查状态）。\n"
            f"若涉及设备排查，必须调用 run_on_device 执行，绝对不可在未执行排查时直接结束！"
        )
        if sources:
            user_prompt = f"参考资料:\n{context}\n\n{user_prompt}"
    else:
        user_prompt = f"资料:\n{context}\n\n问题: {question}"

    if att_prefix:
        user_prompt = f"{att_prefix}\n\n{user_prompt}"

    # Build multimodal content payload if images present (OpenAI Vision standard)
    if images:
        content_parts: list[dict] = [{"type": "text", "text": user_prompt}]
        for img_url in images:
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": img_url}
            })
        messages.append({
            "role": "user",
            "content": content_parts,
        })
    else:
        messages.append({
            "role": "user",
            "content": user_prompt,
        })

    return messages


async def _get_or_create_conversation(
    conv_id_str: str | None,
    user: User,
    question: str,
    device_id: str | None,
    cwd: str | None,
    session_id: str | None = None,
    history: list[dict] | None = None,
    config: dict | None = None,
) -> tuple[uuid.UUID, str, dict]:
    """Retrieve existing conversation or create a new one."""
    async with async_session_factory() as session:
        if conv_id_str:
            try:
                cid = uuid.UUID(conv_id_str)
                conv = (await session.execute(
                    select(AskConversation).where(
                        (AskConversation.id == cid) &
                        ((AskConversation.user_id == user.id) | (AskConversation.user_id.is_(None)))
                    )
                )).scalars().first()
                if conv:
                    updated = False
                    cfg = dict(conv.config or {})
                    if config:
                        for k, v in config.items():
                            if v is not None and v != "":
                                if k == "execution_mode" and v == "ai" and cfg.get("execution_mode") and cfg.get("execution_mode") != "ai":
                                    continue
                                if k == "device_id" and v == "auto" and cfg.get("device_id") and cfg.get("device_id") not in ("auto", "ask_only", "all"):
                                    continue
                                if k == "compact_mode":
                                    continue
                                cfg[k] = v
                        cfg["compact_mode"] = False
                        conv.config = cfg
                        updated = True
                    elif "compact_mode" in cfg and cfg["compact_mode"]:
                        cfg["compact_mode"] = False
                        conv.config = cfg
                        updated = True

                    if device_id and conv.device_id != device_id:
                        if device_id != "auto" or not conv.device_id:
                            conv.device_id = device_id
                            updated = True
                    if cwd and conv.cwd != cwd:
                        conv.cwd = cwd
                        updated = True
                    if updated:
                        conv.updated_at = datetime.now(timezone.utc)
                        await session.commit()
                    return conv.id, conv.title, dict(conv.config or {})
            except Exception:
                pass

        # 尝试通过底层 session_id 复用已有 AskConversation，避免续接时重复新开会话
        effective_sess_id = session_id
        if not effective_sess_id and conv_id_str:
            try:
                doc_cid = uuid.UUID(conv_id_str)
                doc_item = (await session.execute(
                    select(Document).where(Document.id == doc_cid)
                )).scalars().first()
                if doc_item:
                    meta = doc_item.metadata_ or {}
                    effective_sess_id = meta.get("session_id") or meta.get("cascade_id")
            except Exception:
                pass

        if effective_sess_id:
            try:
                sess_conv = (await session.execute(
                    select(AskConversation).where(
                        (AskConversation.config.op("->>")("session_id") == effective_sess_id) &
                        ((AskConversation.user_id == user.id) | (AskConversation.user_id.is_(None)))
                    ).order_by(AskConversation.updated_at.desc().nulls_last()).limit(1)
                )).scalars().first()

                if not sess_conv:
                    # 备选深层匹配：遍历最近的会话，推导检查 session_id
                    recent_cands = (await session.execute(
                        select(AskConversation).where(
                            ((AskConversation.user_id == user.id) | (AskConversation.user_id.is_(None)))
                        ).order_by(AskConversation.updated_at.desc().nulls_last()).limit(50)
                    )).scalars().all()
                    for rc in recent_cands:
                        rc_cfg, rc_inf = _infer_conversation_config(rc)
                        if rc_cfg.get("session_id") == effective_sess_id or rc_inf.get("session_id") == effective_sess_id:
                            sess_conv = rc
                            break

                if sess_conv:
                    updated = False
                    cfg = dict(sess_conv.config or {})
                    if config:
                        for k, v in config.items():
                            if v is not None and v != "":
                                if k == "execution_mode" and v == "ai" and cfg.get("execution_mode") and cfg.get("execution_mode") != "ai":
                                    continue
                                if k == "device_id" and v == "auto" and cfg.get("device_id") and cfg.get("device_id") not in ("auto", "ask_only", "all"):
                                    continue
                                if k == "compact_mode":
                                    continue
                                cfg[k] = v
                    cfg["compact_mode"] = False
                    cfg["session_id"] = effective_sess_id
                    sess_conv.config = cfg
                    if device_id and sess_conv.device_id != device_id:
                        if device_id != "auto" or not sess_conv.device_id:
                            sess_conv.device_id = device_id
                            updated = True
                    if cwd and sess_conv.cwd != cwd:
                        sess_conv.cwd = cwd
                        updated = True
                    sess_conv.updated_at = datetime.now(timezone.utc)
                    await session.commit()
                    return sess_conv.id, sess_conv.title, dict(sess_conv.config or {})
            except Exception:
                pass

        # Determine title
        from ..services.ingest_service import _is_junk_or_uuid_title
        title = None
        if session_id:
            try:
                doc_row = (await session.execute(
                    select(Document.title).where(
                        (Document.metadata_.op("->>")("session_id") == session_id)
                        | (Document.metadata_.op("->>")("cascade_id") == session_id)
                    ).limit(1)
                )).scalar_one_or_none()
                if not doc_row:
                    try:
                        doc_uuid = uuid.UUID(session_id)
                        doc_row = (await session.execute(
                            select(Document.title).where(Document.id == doc_uuid)
                        )).scalar_one_or_none()
                    except Exception:
                        pass
                if doc_row and doc_row.strip() and not _is_junk_or_uuid_title(doc_row.strip(), session_id):
                    title = doc_row.strip()
            except Exception:
                pass

        def _clean_smart_conversation_title(raw_text: str) -> str | None:
            if not raw_text:
                return None
            c = raw_text.strip()
            c = re.sub(r"^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*", "", c)
            c = re.sub(r"^【前文对话历史】[\s\S]*?【当前用户指令】\s*", "", c)
            if "进行图像分析与代码实现。" in c:
                c = c.split("进行图像分析与代码实现。", 1)[-1].strip()
            c = re.sub(r"【用户上传了图片[\s\S]*?】", "", c).strip()
            c = re.sub(r"【用户附加文件[\s\S]*?】", "", c).strip()
            c = re.sub(r"^(请问下|请问|请帮我|帮我看下|帮我查看|能不能帮我|麻烦帮我|你好[，, ]*|您好[，, ]*|请[，, ]*)", "", c).strip()
            c = " ".join(c.split())
            if c and not _is_junk_or_uuid_title(c, session_id):
                return c[:36]
            return None

        if not title and history:
            for h in history:
                if h.get("role") == "user" and h.get("content"):
                    t_cand = _clean_smart_conversation_title(h["content"])
                    if t_cand:
                        title = t_cand
                        break

        if not title and question:
            t_cand = _clean_smart_conversation_title(question)
            if t_cand:
                title = t_cand

        if not title:
            title = f"会话 {session_id[:8]}" if session_id else "新对话"

        # Prepopulate turns with existing history if provided
        init_turns = []
        if history:
            now_iso = datetime.now(timezone.utc).isoformat()
            init_turns = [
                {
                    "role": t.get("role", "user"),
                    "content": t.get("content", ""),
                    "toolCalls": t.get("tool_calls") or t.get("toolCalls") or [],
                    "thinking": t.get("thinking"),
                    "created_at": t.get("created_at") or now_iso,
                    **({"started_at": t["started_at"]} if t.get("started_at") else {}),
                    **({"duration_ms": t["duration_ms"]} if t.get("duration_ms") is not None else {}),
                }
                for t in history
                if t.get("content")
            ]
        elif session_id:
            try:
                from ..db.models import ConversationMessage
                doc_target = (await session.execute(
                    select(Document).where(
                        (Document.metadata_.op("->>")("session_id") == session_id)
                        | (Document.metadata_.op("->>")("cascade_id") == session_id)
                    ).limit(1)
                )).scalars().first()
                if doc_target:
                    if (not device_id or device_id == "auto") and doc_target.machine_id:
                        doc_mach = await session.get(Machine, doc_target.machine_id)
                        if doc_mach:
                            device_id = doc_mach.collector_token_hash or doc_mach.name
                    msgs = (await session.execute(
                        select(ConversationMessage).where(ConversationMessage.document_id == doc_target.id)
                        .order_by(ConversationMessage.line_number.asc())
                    )).scalars().all()
                    for m in msgs:
                        init_turns.append({
                            "role": m.role or "user",
                            "content": m.content or "",
                            "toolCalls": [],
                            "created_at": m.timestamp.isoformat() if m.timestamp else datetime.now(timezone.utc).isoformat(),
                        })
            except Exception:
                pass

        conv_cfg = dict(config or {})
        conv_cfg["compact_mode"] = False
        if session_id:
            conv_cfg["session_id"] = session_id
        if device_id and device_id != "auto":
            conv_cfg["device_id"] = device_id

        conv = AskConversation(
            user_id=user.id,
            title=title,
            turns=init_turns,
            device_id=device_id,
            cwd=cwd,
            config=conv_cfg,
        )
        session.add(conv)
        await session.commit()
        await session.refresh(conv)
        return conv.id, conv.title, dict(conv.config or {})


def _compress_b64_image_safe(data_uri: str, max_size: int = 1600, quality: int = 82) -> str:
    """Safely compress base64 image if it exceeds threshold (>80KB).
    Returns compressed data URL (image/jpeg) or original if already small or invalid.
    """
    if not isinstance(data_uri, str) or not data_uri.startswith("data:image"):
        return data_uri

    if len(data_uri) < 80_000:
        return data_uri

    try:
        header, b64_part = data_uri.split(",", 1)
        raw_bytes = base64.b64decode(b64_part)
        from io import BytesIO
        from PIL import Image

        img = Image.open(BytesIO(raw_bytes))
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > max_size:
            ratio = max_size / max(w, h)
            new_w, new_h = int(w * ratio), int(h * ratio)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        out_io = BytesIO()
        img.save(out_io, format="JPEG", quality=quality, optimize=True)
        out_bytes = out_io.getvalue()
        if len(out_bytes) < len(raw_bytes):
            new_b64 = base64.b64encode(out_bytes).decode("ascii")
            return f"data:image/jpeg;base64,{new_b64}"
        return data_uri
    except Exception as e:
        logger.warning("Failed to compress base64 image: %s", e)
        return data_uri


async def _append_conversation_turns(
    conv_id: uuid.UUID,
    user_content: str,
    assistant_content: str,
    sources: list[dict] | None = None,
    tool_calls: list[dict] | None = None,
    thinking: str | None = None,
    device_id: str | None = None,
    cwd: str | None = None,
    images: list[str] | None = None,
    attachments: list[dict] | None = None,
    config: dict | None = None,
    user_created_at: str | None = None,
    assistant_created_at: str | None = None,
    duration_ms: int | None = None,
):
    """Persist user and assistant turns into the conversation row."""
    try:
        async with async_session_factory() as session:
            conv = (await session.execute(
                select(AskConversation).where(AskConversation.id == conv_id)
            )).scalars().first()
            if not conv:
                return

            turns = list(conv.turns or [])
            now_iso = datetime.now(timezone.utc).isoformat()
            u_iso = user_created_at or now_iso
            a_iso = assistant_created_at or now_iso
            user_turn: dict = {
                "role": "user",
                "content": user_content,
                "created_at": u_iso,
            }
            if images:
                user_turn["images"] = [_compress_b64_image_safe(img) for img in images]
            if attachments:
                user_turn["attachments"] = attachments
            turns.append(user_turn)
            asst_turn: dict = {
                "role": "assistant",
                "content": assistant_content,
                "created_at": a_iso,
                "started_at": u_iso,
            }
            if duration_ms is not None:
                asst_turn["duration_ms"] = duration_ms
            if thinking:
                asst_turn["thinking"] = thinking
            if sources:
                asst_turn["sources"] = sources
            inferred_tc_dev = None
            if tool_calls:
                clean_tool_calls = []
                for tc in tool_calls:
                    if isinstance(tc, dict):
                        tc_copy = dict(tc)
                        res_d = tc_copy.get("result") if isinstance(tc_copy.get("result"), dict) else {}
                        args_d = tc_copy.get("args") if isinstance(tc_copy.get("args"), dict) else {}
                        for d_cand in (res_d.get("device_id"), res_d.get("device_name"), tc_copy.get("device_name"), args_d.get("device_id")):
                            if d_cand and str(d_cand).strip() not in ("", "auto", "ask_only", "all"):
                                inferred_tc_dev = str(d_cand).strip()
                                break
                        args = tc_copy.get("args")
                        if isinstance(args, dict) and "images" in args:
                            clean_args = dict(args)
                            img_val = clean_args.get("images")
                            if isinstance(img_val, list):
                                clean_args["images"] = [f"<image attachment {i+1}>" for i in range(len(img_val))]
                            else:
                                del clean_args["images"]
                            tc_copy["args"] = clean_args
                        clean_tool_calls.append(tc_copy)
                    else:
                        clean_tool_calls.append(tc)
                    asst_turn["toolCalls"] = clean_tool_calls
            turns.append(asst_turn)

            conv.turns = turns
            flag_modified(conv, "turns")
            conv.updated_at = datetime.now(timezone.utc)
            effective_dev = device_id
            if (not effective_dev or effective_dev == "auto") and inferred_tc_dev:
                effective_dev = inferred_tc_dev
            if effective_dev and (effective_dev != "auto" or not conv.device_id):
                conv.device_id = effective_dev
            if cwd:
                conv.cwd = cwd
            if config or (effective_dev and effective_dev != "auto"):
                cfg = dict(conv.config or {})
                if config:
                    for k, v in config.items():
                        if v is not None and v != "":
                            if k == "execution_mode" and v == "ai" and cfg.get("execution_mode") and cfg.get("execution_mode") != "ai":
                                continue
                            if k == "device_id" and v == "auto" and cfg.get("device_id") and cfg.get("device_id") not in ("auto", "ask_only", "all"):
                                continue
                            cfg[k] = v
                if effective_dev and effective_dev != "auto":
                    cfg["device_id"] = effective_dev
                conv.config = cfg
            await session.commit()

            # Sync non-CLI AskConversation turns (ai, agent, shell, rag, or sessions without a local daemon JSONL file)
            # into Document + ConversationMessage so RAG retrieval, daily digest, and session reviews all include them.
            cfg_now = dict(conv.config or {})
            exec_mode_now = (cfg_now.get("execution_mode") or "ai").lower()
            has_cli_session = bool(cfg_now.get("session_id")) and exec_mode_now in ("claude", "codex", "antigravity", "workbuddy")
            if not has_cli_session and conv.user_id:
                try:
                    import hashlib
                    from ..db.models import ConversationMessage, Tool

                    tool_row = await session.get(Tool, "memento")
                    if not tool_row:
                        session.add(Tool(id="memento", display_name="Memento"))
                        await session.flush()

                    mach_id = None
                    if conv.device_id:
                        m = (await session.execute(
                            select(Machine.id).where(
                                (Machine.collector_token_hash == conv.device_id) | (Machine.name == conv.device_id)
                            ).limit(1)
                        )).scalar_one_or_none()
                        mach_id = m
                    if not mach_id:
                        mach_id = (await session.execute(
                            select(Machine.id).where(Machine.user_id == conv.user_id)
                            .order_by(Machine.last_heartbeat.desc().nulls_last()).limit(1)
                        )).scalar_one_or_none()

                    if mach_id:
                        rel_path = f"ask-conversations/{conv.id}.jsonl"
                        doc = (await session.execute(
                            select(Document).where(
                                Document.machine_id == mach_id,
                                Document.tool_id == "memento",
                                Document.relative_path == rel_path,
                            )
                        )).scalar_one_or_none()
                        full_text = "\n".join(
                            f"{t.get('role')}: {t.get('content', '')}" for t in turns if isinstance(t, dict)
                        )
                        content_hash = hashlib.sha256(full_text.encode("utf-8", errors="ignore")).hexdigest()
                        now_dt = datetime.now(timezone.utc)
                        if not doc:
                            doc = Document(
                                tool_id="memento",
                                machine_id=mach_id,
                                relative_path=rel_path,
                                category="conversation",
                                content_type="jsonl",
                                title=conv.title or "客户端对话",
                                content=full_text[:200000],
                                content_hash=content_hash,
                                file_size_bytes=len(full_text.encode("utf-8", errors="ignore")),
                                synced_at=now_dt,
                                source_modified_at=now_dt,
                            )
                            session.add(doc)
                            await session.flush()
                        else:
                            doc.title = conv.title or doc.title
                            doc.content = full_text[:200000]
                            doc.content_hash = content_hash
                            doc.file_size_bytes = len(full_text.encode("utf-8", errors="ignore"))
                            doc.synced_at = now_dt
                            doc.source_modified_at = now_dt

                        u_dt = datetime.fromisoformat(u_iso.replace("Z", "+00:00"))
                        a_dt = datetime.fromisoformat(a_iso.replace("Z", "+00:00"))
                        line_base = max(1, len(turns) - 1)
                        existing_lines = set((await session.execute(
                            select(ConversationMessage.line_number).where(
                                ConversationMessage.document_id == doc.id,
                                ConversationMessage.line_number.in_([line_base, line_base + 1]),
                            )
                        )).scalars().all())
                        if line_base not in existing_lines:
                            session.add(ConversationMessage(
                                document_id=doc.id,
                                line_number=line_base,
                                message_type="user",
                                role="user",
                                content=user_content,
                                timestamp=u_dt,
                            ))
                        if (line_base + 1) not in existing_lines:
                            tc_suffix = ""
                            if tool_calls:
                                tc_lines = [
                                    f"[Tool: {tc.get('name', 'tool')}]\n{json.dumps(tc.get('args') or {}, ensure_ascii=False)}"
                                    for tc in tool_calls if isinstance(tc, dict)
                                ]
                                if tc_lines:
                                    tc_suffix = "\n" + "\n".join(tc_lines)
                            session.add(ConversationMessage(
                                document_id=doc.id,
                                line_number=line_base + 1,
                                message_type="assistant",
                                role="assistant",
                                content=(assistant_content or "") + tc_suffix,
                                timestamp=a_dt,
                            ))
                        await session.commit()
                except Exception as sync_ex:
                    logger.debug("Non-CLI AskConversation mirror to Document skipped: %s", sync_ex)

            # Fast-path self-evolution: immediately trigger background correction and todo learning
            user_id_val = conv.user_id
            from ..services.correction_service import looks_like_pushback, learn_from_corrections
            from ..services.todo_service import looks_like_later, looks_like_close, learn_todos
            from ..services.notify_service import spawn

            need_corr = looks_like_pushback(user_content)
            need_todo = looks_like_later(user_content) or looks_like_close(user_content)
            if (need_corr or need_todo) and user_id_val:
                async def _bg_instant_learn():
                    try:
                        async with async_session_factory() as sdb:
                            u = await sdb.get(User, user_id_val)
                            if not u:
                                return
                            if need_corr:
                                await learn_from_corrections(sdb, u)
                            if need_todo:
                                await learn_todos(sdb, u)
                    except Exception as ex:
                        logger.debug("Background instant learning scan skipped: %s", ex)

                spawn(_bg_instant_learn())
    except Exception as e:
        logger.exception("Failed to persist conversation %s turns: %s", conv_id, e)


@router.get("/conversations")
async def list_conversations(
    device_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """List recent Ask conversations for the current user."""
    cond = (AskConversation.user_id == _user.id) | (AskConversation.user_id.is_(None))
    if device_id and device_id not in ("auto", "ask_only", "all"):
        target_machine = await find_machine_by_id_or_hash(db, device_id, _user)
        match_vals = [device_id]
        if target_machine:
            match_vals.extend([str(target_machine.id), target_machine.collector_token_hash, target_machine.name])
        match_vals = list(set(filter(None, match_vals)))
        cond = cond & AskConversation.device_id.in_(match_vals)

    query = (
        select(
            AskConversation.id,
            AskConversation.title,
            AskConversation.created_at,
            AskConversation.updated_at,
            AskConversation.device_id,
            AskConversation.cwd,
            AskConversation.config,
            func.jsonb_array_length(AskConversation.turns).label("message_count"),
        )
        .where(cond)
        .order_by(AskConversation.updated_at.desc().nulls_last())
        .limit(100)
    )
    res = await db.execute(query)
    rows = res.all()
    from ..services.ingest_service import _is_junk_or_uuid_title

    out_items = []
    dirty_repaired = False
    for r in rows:
        cfg = dict(r.config or {})
        display_title = r.title or "新对话"
        bad_title = _is_junk_or_uuid_title(display_title, cfg.get("session_id"))

        need_turns = (
            not cfg.get("_meta_scanned")
            and (
                not cfg.get("session_id")
                or not cfg.get("execution_mode")
                or cfg.get("execution_mode") == "ai"
                or bad_title
            )
        ) or bad_title

        conv_obj = None
        turns_list = None
        if need_turns:
            conv_obj = await db.get(AskConversation, r.id)
            turns_list = list(conv_obj.turns or []) if conv_obj else []

        # 补全 session_id / execution_mode
        if turns_list and (not cfg.get("session_id") or not cfg.get("execution_mode") or cfg.get("execution_mode") == "ai"):
            for turn in reversed(turns_list):
                tcs = turn.get("toolCalls") or turn.get("tool_calls") or []
                for tc in reversed(tcs):
                    if not isinstance(tc, dict):
                        continue
                    tc_args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                    tc_res = tc.get("result") if isinstance(tc.get("result"), dict) else {}
                    sid = tc_res.get("session_id") or tc_args.get("session_id") or (tc.get("call") or {}).get("session_id")
                    if sid and not cfg.get("session_id"):
                        cfg["session_id"] = str(sid)
                    bin_name = str(tc_args.get("binary") or tc.get("binary") or "").lower()
                    if "agy" in bin_name or "antigravity" in bin_name:
                        cfg["execution_mode"] = "antigravity"
                    elif "workbuddy" in bin_name or "codebuddy" in bin_name:
                        cfg["execution_mode"] = "workbuddy"
                    elif "claude" in bin_name:
                        cfg["execution_mode"] = "claude"
                    elif "codex" in bin_name:
                        cfg["execution_mode"] = "codex"
                if cfg.get("session_id") and cfg.get("execution_mode"):
                    break

        # 清洗修复垃圾标题
        if turns_list and _is_junk_or_uuid_title(display_title, cfg.get("session_id")):
            for turn in turns_list:
                if turn.get("role") == "user" and turn.get("content"):
                    c_text = str(turn["content"]).strip()
                    c_text = re.sub(r"^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*", "", c_text)
                    c_text = re.sub(r"^【前文对话历史】[\s\S]*?【当前用户指令】\s*", "", c_text)
                    c_text = c_text.strip().replace("\n", " ")
                    if c_text and not _is_junk_or_uuid_title(c_text, cfg.get("session_id")):
                        display_title = c_text[:50]
                        break

        if conv_obj is not None:
            cfg["_meta_scanned"] = True
            conv_obj.config = dict(cfg)
            if display_title != (conv_obj.title or ""):
                conv_obj.title = display_title
            dirty_repaired = True

        out_items.append({
            "id": str(r.id),
            "title": display_title,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            "device_id": r.device_id,
            "cwd": r.cwd,
            "config": cfg,
            "message_count": r.message_count or 0,
        })

    # Sort pinned conversations to the top, then newest updated first
    out_items.sort(
        key=lambda x: (
            0 if (x.get("config") or {}).get("pinned") else 1,
            -(datetime.fromisoformat(x["updated_at"]).timestamp() if x.get("updated_at") else 0),
        )
    )

    if dirty_repaired:
        try:
            await db.commit()
        except Exception:
            await db.rollback()
    return out_items


def _infer_conversation_config(conv: AskConversation) -> tuple[dict, dict]:
    """Extract runtime config (execution_mode, model, effort, project_id, session_id, device_id, cwd)
    from historical turns if missing or defaulted to 'ai'."""
    cfg = dict(conv.config or {})
    existing_mode = cfg.get("execution_mode")
    mode_needed = not existing_mode or existing_mode == "ai"

    inferred: dict = {}
    for turn in reversed(conv.turns or []):
        tcs = turn.get("toolCalls") or turn.get("tool_calls") or []
        for tc in reversed(tcs):
            if not isinstance(tc, dict):
                continue

            raw_args = tc.get("args") or {}
            if isinstance(raw_args, str):
                try:
                    args = json.loads(raw_args)
                except Exception:
                    args = {}
            elif isinstance(raw_args, dict):
                args = raw_args
            else:
                args = {}

            call_dict = tc.get("call") or {}
            if isinstance(call_dict, str):
                try:
                    call_dict = json.loads(call_dict)
                except Exception:
                    call_dict = {}
            elif not isinstance(call_dict, dict):
                call_dict = {}

            res_dict = tc.get("result") or {}
            if isinstance(res_dict, str):
                try:
                    res_dict = json.loads(res_dict)
                except Exception:
                    res_dict = {}
            elif not isinstance(res_dict, dict):
                res_dict = {}

            binary = str(
                args.get("binary")
                or tc.get("binary")
                or call_dict.get("binary")
                or res_dict.get("binary")
                or ""
            ).lower().strip()

            action = str(
                res_dict.get("action")
                or args.get("action")
                or tc.get("action")
                or call_dict.get("action")
                or ("shell" if tc.get("name") == "run_on_device" and "command" in args else "")
                or ""
            ).lower().strip()

            name = str(tc.get("name") or call_dict.get("name") or "").lower().strip()
            cmd = str(args.get("command") or args.get("prompt") or tc.get("command") or call_dict.get("command") or "")

            detected_mode = None
            if "claude" in binary or name == "claude" or "[claude" in cmd.lower() or "[claude" in (tc.get("command") or "").lower():
                detected_mode = "claude"
            elif "codex" in binary or name == "codex" or "[codex" in cmd.lower() or "[codex" in (tc.get("command") or "").lower():
                detected_mode = "codex"
            elif "agy" in binary or "antigravity" in binary or name == "antigravity" or "[antigravity" in cmd.lower() or "[agy" in cmd.lower():
                detected_mode = "antigravity"
            elif "workbuddy" in binary or "codebuddy" in binary or name == "workbuddy" or "[workbuddy" in cmd.lower() or "[workbuddy" in (tc.get("command") or "").lower():
                detected_mode = "workbuddy"
            elif action == "shell" or binary in ("bash", "sh", "zsh") or "[shell" in cmd.lower():
                detected_mode = "shell"

            if detected_mode and ("execution_mode" not in inferred):
                inferred["execution_mode"] = detected_mode

            pid = args.get("project_id") or call_dict.get("project_id") or res_dict.get("project_id")
            if pid and "project_id" not in inferred:
                inferred["project_id"] = str(pid)

            sid = (
                res_dict.get("session_id")
                or args.get("session_id")
                or call_dict.get("session_id")
            )
            if sid and "session_id" not in inferred:
                inferred["session_id"] = str(sid)

            mod = args.get("model") or call_dict.get("model")
            if mod and "model" not in inferred:
                inferred["model"] = str(mod)

            eff = args.get("effort") or call_dict.get("effort")
            if eff and "effort" not in inferred:
                inferred["effort"] = str(eff)

            tc_cwd = args.get("cwd") or call_dict.get("cwd")
            if tc_cwd and "cwd" not in inferred:
                inferred["cwd"] = str(tc_cwd)

            for cand_dev in (
                res_dict.get("device_id"),
                res_dict.get("device_name"),
                tc.get("device_name"),
                args.get("device_id"),
                call_dict.get("device_name"),
            ):
                if cand_dev and str(cand_dev).strip() not in ("", "auto", "ask_only", "all"):
                    if "device_id" not in inferred:
                        inferred["device_id"] = str(cand_dev).strip()
                    break

            if detected_mode and inferred.get("session_id") and inferred.get("project_id") and inferred.get("device_id"):
                break
        if inferred.get("execution_mode") and inferred.get("session_id") and inferred.get("project_id") and inferred.get("device_id"):
            break

    if conv.device_id and conv.device_id not in ("auto", "ask_only", "all") and (not cfg.get("device_id") or cfg.get("device_id") == "auto"):
        cfg["device_id"] = conv.device_id

    if mode_needed and inferred.get("execution_mode"):
        cfg["execution_mode"] = inferred["execution_mode"]

    for k in ("project_id", "session_id", "model", "effort", "cwd", "device_id"):
        cur_val = cfg.get(k)
        if (not cur_val or (k == "device_id" and cur_val == "auto")) and inferred.get(k):
            cfg[k] = inferred[k]

    return cfg, inferred


async def _resolve_concrete_device_for_conv(
    db: AsyncSession,
    conv: AskConversation,
    cfg: dict,
    inferred: dict,
) -> str | None:
    """Resolve the concrete execution device (collector_token_hash or name) for a conversation
    when device_id is missing, 'auto', or a display name rather than collector_token_hash."""
    candidate: str | None = None
    for raw_cand in (
        inferred.get("device_id"),
        conv.device_id,
        cfg.get("device_id"),
    ):
        s = str(raw_cand or "").strip()
        if s and s not in ("auto", "ask_only", "all"):
            candidate = s
            break

    # 1. If still no concrete device, check underlying session Document -> Machine
    sess_id = str(cfg.get("session_id") or "").strip()
    if not candidate and sess_id:
        try:
            doc_mid = (await db.execute(
                select(Document.machine_id).where(
                    Document.machine_id.is_not(None),
                    (Document.metadata_.op("->>")("session_id") == sess_id)
                    | (Document.metadata_.op("->>")("cascade_id") == sess_id),
                ).limit(1)
            )).scalar_one_or_none()
            if not doc_mid:
                try:
                    doc_uuid = uuid.UUID(sess_id)
                    doc_mid = (await db.execute(
                        select(Document.machine_id).where(Document.id == doc_uuid)
                    )).scalar_one_or_none()
                except Exception:
                    pass
            if doc_mid:
                mach = await db.get(Machine, doc_mid)
                if mach and mach.merged_into:
                    mach = await db.get(Machine, mach.merged_into) or mach
                if mach:
                    candidate = mach.collector_token_hash or mach.name
        except Exception:
            pass

    # 2. If still no concrete device, infer from cwd path signature
    cwd_val = str(conv.cwd or cfg.get("cwd") or inferred.get("cwd") or "").strip().lower()
    if not candidate and cwd_val:
        try:
            if "/users/haixingdong" in cwd_val:
                mach = (await db.execute(
                    select(Machine).where(
                        Machine.merged_into.is_(None),
                        Machine.name.ilike("%mac-mini%"),
                    ).order_by(Machine.last_heartbeat.desc().nulls_last()).limit(1)
                )).scalars().first()
                if mach:
                    candidate = mach.collector_token_hash or mach.name
            elif "/users/donghaixing" in cwd_val:
                mach = (await db.execute(
                    select(Machine).where(
                        Machine.merged_into.is_(None),
                        Machine.name.ilike("%macbook%"),
                    ).order_by(Machine.last_heartbeat.desc().nulls_last()).limit(1)
                )).scalars().first()
                if mach:
                    candidate = mach.collector_token_hash or mach.name
        except Exception:
            pass

    # 3. If still no concrete device, infer from project's most recent Document -> Machine
    proj_id_str = str(cfg.get("project_id") or "").strip()
    if not candidate and proj_id_str:
        try:
            pid = uuid.UUID(proj_id_str)
            doc_mid = (await db.execute(
                select(Document.machine_id).where(
                    Document.project_id == pid,
                    Document.machine_id.is_not(None),
                ).order_by(Document.synced_at.desc().nulls_last()).limit(1)
            )).scalar_one_or_none()
            if doc_mid:
                mach = await db.get(Machine, doc_mid)
                if mach and mach.merged_into:
                    mach = await db.get(Machine, mach.merged_into) or mach
                if mach:
                    candidate = mach.collector_token_hash or mach.name
        except Exception:
            pass

    if not candidate:
        return conv.device_id or cfg.get("device_id")

    # Normalize candidate (which might be a machine name like 'haixingdeMac-mini' or a merged machine's old hash) to active collector_token_hash
    try:
        clean_name = re.sub(
            r"\.local$",
            "",
            re.sub(r"\s*\([^)]*\)\s*$", "", candidate),
            flags=re.IGNORECASE,
        ).strip()
        mach = (await db.execute(
            select(Machine).where(
                (Machine.collector_token_hash == candidate)
                | (Machine.name == candidate)
                | (Machine.name == clean_name)
                | (func.lower(Machine.name) == clean_name.lower())
                | (Machine.name.ilike(f"{clean_name}.local%"))
                | (Machine.name.ilike(f"{clean_name} (%")),
            ).order_by(
                Machine.merged_into.is_(None).desc(),
                Machine.last_heartbeat.desc().nulls_last(),
            ).limit(1)
        )).scalars().first()
        if mach and mach.merged_into:
            mach = await db.get(Machine, mach.merged_into) or mach
        if mach and mach.collector_token_hash:
            return mach.collector_token_hash
    except Exception:
        pass

    return candidate


def _fix_iso_timestamp(val: Any) -> str | None:
    if not val:
        return None
    if isinstance(val, (int, float)):
        sec = val / 1000.0 if val >= 1e11 else float(val)
        return datetime.fromtimestamp(sec, tz=timezone.utc).isoformat()
    s = str(val).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.year < 2000:
            ts = dt.timestamp()
            if ts > 1_000_000:
                return datetime.fromtimestamp(ts * 1000.0, tz=timezone.utc).isoformat()
    except Exception:
        pass
    return s


def _sanitize_turns_for_response(turns: list[dict], fallback_iso: str | None = None, start_index: int = 0) -> list[dict]:
    """Strip bloated duplicate inlined base64 images from tool_calls args, compress oversized user images, and ensure turn timestamps and absolute indices."""
    sanitized = []
    prev_user_ts: str | None = None
    fixed_fallback = _fix_iso_timestamp(fallback_iso)
    for i, t in enumerate(turns):
        t_copy = dict(t)
        t_copy["index"] = start_index + i
        if t_copy.get("created_at"):
            t_copy["created_at"] = _fix_iso_timestamp(t_copy.get("created_at"))
        elif fixed_fallback:
            t_copy["created_at"] = fixed_fallback
        if t_copy.get("started_at"):
            t_copy["started_at"] = _fix_iso_timestamp(t_copy.get("started_at"))
        role = t_copy.get("role")
        if role == "user":
            prev_user_ts = t_copy.get("created_at")
        elif role == "assistant":
            if not t_copy.get("started_at") and prev_user_ts and prev_user_ts != t_copy.get("created_at"):
                t_copy["started_at"] = prev_user_ts
            start_iso = t_copy.get("started_at")
            end_iso = t_copy.get("created_at")
            if start_iso and end_iso and t_copy.get("duration_ms") is None:
                try:
                    dt_s = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
                    dt_e = datetime.fromisoformat(str(end_iso).replace("Z", "+00:00"))
                    dur = int((dt_e - dt_s).total_seconds() * 1000)
                    if dur > 0:
                        t_copy["duration_ms"] = dur
                except Exception:
                    pass
        imgs = t_copy.get("images")
        if imgs and isinstance(imgs, list):
            t_copy["images"] = [_compress_b64_image_safe(img) for img in imgs]
        tcs = t_copy.get("toolCalls") or t_copy.get("tool_calls")
        if tcs and isinstance(tcs, list):
            clean_tcs = []
            for tc in tcs:
                if not isinstance(tc, dict):
                    clean_tcs.append(tc)
                    continue
                tc_copy = dict(tc)
                args = tc_copy.get("args")
                if isinstance(args, dict) and "images" in args:
                    clean_args = dict(args)
                    img_val = clean_args.get("images")
                    if isinstance(img_val, list):
                        clean_args["images"] = [f"<image attachment {i+1}>" for i in range(len(img_val))]
                    else:
                        del clean_args["images"]
                    tc_copy["args"] = clean_args

                # If this turn has assistant content, any hanging tool calls should be marked executed/succeeded
                if role == "assistant" and (t_copy.get("content") or "").strip():
                    cur_status = tc_copy.get("status")
                    res = tc_copy.get("result")
                    if not res or (isinstance(res, dict) and res.get("status") in ("running", "queued")):
                        res_status = "succeeded"
                        if isinstance(res, dict) and res.get("status") == "failed":
                            res_status = "failed"
                        tc_copy["status"] = "executed" if res_status == "succeeded" else "failed"
                        tc_copy["result"] = {
                            **(res if isinstance(res, dict) else {}),
                            "status": res_status,
                            "stdout": (res.get("stdout") if isinstance(res, dict) else None) or "任务执行完成",
                        }
                    elif cur_status in ("running", "queued"):
                        tc_copy["status"] = "executed"

                clean_tcs.append(tc_copy)
            t_copy["toolCalls"] = clean_tcs
        sanitized.append(t_copy)
    return sanitized


async def _lookup_project_title(db: AsyncSession, project_id_val: str | None) -> str | None:
    if not project_id_val:
        return None
    try:
        pid = uuid.UUID(str(project_id_val))
        p_obj = (await db.execute(select(Project).where(Project.id == pid))).scalars().first()
        if p_obj:
            return p_obj.title or p_obj.slug
    except Exception:
        pass
    return None


async def _recover_orphaned_tasks_for_conv(db: AsyncSession, conv: AskConversation, cfg: dict) -> list[dict] | None:
    """If deploy/api restarted while a DeviceTask was running, recover completed turns that were not persisted to conv.turns."""
    try:
        from ..db.models import DeviceTask
        from ..services.ask_runs import ask_runs

        conv_id_str = str(conv.id)
        active_run = ask_runs.get(conv_id_str, conv.user_id) if conv.user_id else None
        if active_run and not active_run.done:
            return None

        raw_turns = list(conv.turns or [])
        recorded_task_ids: set[str] = set()
        last_turn_dt: datetime | None = None
        for t in raw_turns:
            ts_str = t.get("created_at")
            if ts_str:
                try:
                    dt = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
                    if dt.year >= 2000 and (last_turn_dt is None or dt > last_turn_dt):
                        last_turn_dt = dt
                except Exception:
                    pass
            for tc in (t.get("toolCalls") or t.get("tool_calls") or []):
                if isinstance(tc, dict):
                    res = tc.get("result")
                    if isinstance(res, dict) and res.get("task_id"):
                        recorded_task_ids.add(str(res["task_id"]))
                    if tc.get("task_id"):
                        recorded_task_ids.add(str(tc["task_id"]))

        sess_id = str(cfg.get("session_id") or "").strip()
        q = (
            select(DeviceTask)
            .where(
                DeviceTask.user_id == conv.user_id,
                DeviceTask.status.in_(["succeeded", "failed", "timeout"]),
            )
            .order_by(DeviceTask.created_at.desc())
            .limit(8)
        )
        recent_tasks = (await db.execute(q)).scalars().all()
        to_recover: list[DeviceTask] = []
        for dt_row in reversed(recent_tasks):
            tid = str(dt_row.id)
            if tid in recorded_task_ids:
                continue
            pl = dt_row.payload or {}
            pl_conv = str(pl.get("conversation_id") or "").strip()
            pl_sess = str(pl.get("session_id") or "").strip()
            matched = (pl_conv == conv_id_str) or (not pl_conv and sess_id and pl_sess == sess_id)
            if not matched:
                continue
            fin_dt = dt_row.finished_at or dt_row.created_at
            if last_turn_dt and fin_dt and fin_dt <= last_turn_dt:
                continue
            to_recover.append(dt_row)

        if not to_recover:
            return None

        for dt_row in to_recover:
            pl = dt_row.payload or {}
            user_q = str(pl.get("user_question") or "").strip()
            if not user_q:
                raw_prompt = str(pl.get("prompt") or "").strip()
                if "【当前用户指令】\n" in raw_prompt:
                    user_q = raw_prompt.split("【当前用户指令】\n", 1)[1].strip()
                elif "提示: 你可以使用视觉/文件查看工具" in raw_prompt:
                    parts = raw_prompt.split("进行图像分析与代码实现。")
                    user_q = parts[-1].strip() or raw_prompt
                else:
                    user_q = raw_prompt
            ans = (dt_row.stdout or "").strip() or (dt_row.stderr or "").strip() or (dt_row.error or "任务执行完成")
            start_dt = dt_row.dispatched_at or dt_row.created_at or datetime.now(timezone.utc)
            end_dt = dt_row.finished_at or datetime.now(timezone.utc)
            dur_ms = max(0, int((end_dt - start_dt).total_seconds() * 1000))
            call_id = f"direct_{str(dt_row.id).replace('-', '')[:8]}"
            clean_pl = {k: v for k, v in pl.items() if k != "images"}
            tc_entry = {
                "id": call_id,
                "tool_call_id": call_id,
                "name": "run_on_device",
                "device_name": dt_row.device_id or "auto",
                "args": clean_pl,
                "action": dt_row.action,
                "binary": pl.get("binary"),
                "status": "executed" if dt_row.status == "succeeded" else "failed",
                "result": {
                    "task_id": str(dt_row.id),
                    "status": dt_row.status,
                    "exit_code": dt_row.exit_code,
                    "stdout": dt_row.stdout,
                    "stderr": dt_row.stderr,
                    "error": dt_row.error,
                    "events": dt_row.events or [],
                },
            }
            raw_turns.append({
                "role": "user",
                "content": user_q,
                "created_at": start_dt.isoformat(),
            })
            raw_turns.append({
                "role": "assistant",
                "content": ans,
                "started_at": start_dt.isoformat(),
                "created_at": end_dt.isoformat(),
                "duration_ms": dur_ms,
                "toolCalls": [tc_entry],
            })
        conv.turns = raw_turns
        conv.updated_at = datetime.now(timezone.utc)
        await db.commit()
        return raw_turns
    except Exception as e:
        logger.warning("Failed to recover orphaned device tasks for conv %s: %s", conv.id, e)
        return None


@router.get("/conversations/{conv_id}")
async def get_conversation(
    conv_id: str,
    request: Request,
    response: Response,
    limit: int = 0,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Get conversation history with runtime configuration and optional recent turn limiting."""
    try:
        cid = uuid.UUID(conv_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")

    cond = (AskConversation.id == cid) & (
        (AskConversation.user_id == _user.id) | (AskConversation.user_id.is_(None))
    )
    conv = (await db.execute(select(AskConversation).where(cond))).scalars().first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    cfg, inferred = _infer_conversation_config(conv)
    recovered_turns = await _recover_orphaned_tasks_for_conv(db, conv, cfg)
    resolved_dev = await _resolve_concrete_device_for_conv(db, conv, cfg, inferred)

    # Extract all model attributes into locals BEFORE any db.commit() to prevent
    # asyncpg MissingGreenlet errors triggered by expired attribute access.
    conv_id_str = str(conv.id)
    conv_title = conv.title
    raw_turns = recovered_turns if recovered_turns is not None else list(conv.turns or [])
    total_turns = len(raw_turns)

    conv_dev = resolved_dev or conv.device_id or cfg.get("device_id")
    conv_cwd = conv.cwd or cfg.get("cwd")

    if resolved_dev and resolved_dev not in ("auto", "ask_only", "all"):
        cfg["device_id"] = resolved_dev

    need_commit = False
    if conv.config != cfg:
        conv.config = cfg
        need_commit = True
    if not conv.cwd and inferred.get("cwd"):
        conv.cwd = inferred["cwd"]
        conv_cwd = inferred["cwd"]
        need_commit = True
    if resolved_dev and resolved_dev not in ("auto", "ask_only", "all") and conv.device_id != resolved_dev:
        conv.device_id = resolved_dev
        conv_dev = resolved_dev
        need_commit = True

    if need_commit:
        now_utc = datetime.now(timezone.utc)
        conv.updated_at = now_utc
        try:
            await db.commit()
        except Exception as e:
            logger.warning("Failed to persist inferred conversation config: %s", e)

    created_at_iso = conv.created_at.isoformat() if conv.created_at else None
    updated_at_iso = conv.updated_at.isoformat() if conv.updated_at else None

    # Fast ETag evaluation before full turns sanitization and slicing
    etag_seed = f"v4:{conv_id_str}:{updated_at_iso or ''}:{total_turns}:{limit}:{conv_dev or ''}"
    etag = f'"{hashlib.sha1(etag_seed.encode("utf-8")).hexdigest()}"'

    if_none_match = request.headers.get("if-none-match", "").strip() if request else ""
    if if_none_match:
        client_tag = if_none_match.strip().strip('"')
        server_tag = etag.strip('"')
        if client_tag == server_tag:
            return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, no-cache"})

    if limit > 0 and len(raw_turns) > limit:
        offset = len(raw_turns) - limit
        sliced_raw = raw_turns[-limit:]
        has_more = True
    else:
        offset = 0
        sliced_raw = raw_turns
        has_more = False
    conv_turns = _sanitize_turns_for_response(sliced_raw, fallback_iso=updated_at_iso or created_at_iso, start_index=offset)

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "private, no-cache"

    proj_id_val = cfg.get("project_id", "")
    proj_title_val = await _lookup_project_title(db, proj_id_val)

    return {
        "id": conv_id_str,
        "title": conv_title,
        "turns": conv_turns,
        "total_turns": total_turns,
        "has_more": has_more,
        "device_id": conv_dev,
        "cwd": conv_cwd,
        "execution_mode": cfg.get("execution_mode", "ai"),
        "model": cfg.get("model", ""),
        "effort": cfg.get("effort", ""),
        "project_id": proj_id_val,
        "project_title": proj_title_val or "",
        "session_id": cfg.get("session_id", ""),
        "worktree": bool(cfg.get("worktree", False)),
        "compact_mode": bool(cfg.get("compact_mode", False)),
        "config": cfg,
        "created_at": created_at_iso,
        "updated_at": updated_at_iso,
    }


class EnsureConversationBySessionRequest(BaseModel):
    session_id: str
    project_id: str | None = None
    execution_mode: str | None = None
    device_id: str | None = None
    cwd: str | None = None


@router.post("/conversations/ensure-by-session")
async def ensure_conversation_by_session(
    body: EnsureConversationBySessionRequest,
    _user: User = Depends(get_current_user),
):
    """Ensure a linked AskConversation exists for the given underlying session_id and return it."""
    req_config = {
        "execution_mode": body.execution_mode or "ai",
        "project_id": body.project_id or "",
        "session_id": body.session_id,
        "device_id": body.device_id or "",
        "cwd": body.cwd or "",
    }
    conv_id, conv_title, cfg = await _get_or_create_conversation(
        conv_id_str=None,
        user=_user,
        question="",
        device_id=body.device_id,
        cwd=body.cwd,
        session_id=body.session_id,
        history=None,
        config=req_config,
    )
    async with async_session_factory() as session:
        conv = (await session.execute(
            select(AskConversation).where(AskConversation.id == conv_id)
        )).scalars().first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")
        cfg_final, inferred = _infer_conversation_config(conv)
        resolved_dev = await _resolve_concrete_device_for_conv(session, conv, cfg_final, inferred)
        if resolved_dev and resolved_dev not in ("auto", "ask_only", "all"):
            cfg_final["device_id"] = resolved_dev
            if conv.device_id != resolved_dev:
                conv.device_id = resolved_dev
                conv.config = cfg_final
                try:
                    await session.commit()
                except Exception:
                    pass
        proj_id_final = cfg_final.get("project_id", body.project_id or "")
        proj_title_final = await _lookup_project_title(session, proj_id_final)
        fb_iso = (conv.updated_at or conv.created_at).isoformat() if (conv.updated_at or conv.created_at) else None
        return {
            "id": str(conv.id),
            "title": conv.title,
            "turns": _sanitize_turns_for_response(list(conv.turns or []), fallback_iso=fb_iso),
            "device_id": resolved_dev or conv.device_id,
            "cwd": conv.cwd,
            "execution_mode": cfg_final.get("execution_mode", body.execution_mode or "ai"),
            "model": cfg_final.get("model", ""),
            "effort": cfg_final.get("effort", ""),
            "project_id": proj_id_final,
            "project_title": proj_title_final or "",
            "session_id": cfg_final.get("session_id", body.session_id),
            "worktree": bool(cfg_final.get("worktree", False)),
            "compact_mode": False,
            "config": cfg_final,
            "created_at": conv.created_at.isoformat() if conv.created_at else None,
            "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
        }


@router.get("/conversations/recent-active")
async def get_recent_active_conversation(
    _user: User = Depends(get_current_user),
):
    """Get the most relevant active or recent conversation to restore seamlessly on client startup."""
    active_runs = ask_runs.active_for_user(_user.id)
    target_conv_id = None
    if active_runs:
        target_conv_id = active_runs[0].conversation_id

    async with async_session_factory() as session:
        if target_conv_id:
            try:
                cid = uuid.UUID(target_conv_id)
                conv = (await session.execute(
                    select(AskConversation).where(
                        (AskConversation.id == cid) &
                        ((AskConversation.user_id == _user.id) | (AskConversation.user_id.is_(None)))
                    )
                )).scalars().first()
                if conv:
                    cfg, inferred = _infer_conversation_config(conv)
                    resolved_dev = await _resolve_concrete_device_for_conv(session, conv, cfg, inferred)
                    if resolved_dev and resolved_dev not in ("auto", "ask_only", "all"):
                        cfg["device_id"] = resolved_dev
                    pid_str = cfg.get("project_id", "")
                    ptitle = await _lookup_project_title(session, pid_str)
                    fb_iso = (conv.updated_at or conv.created_at).isoformat() if (conv.updated_at or conv.created_at) else None
                    return {
                        "id": str(conv.id),
                        "title": conv.title,
                        "turns": _sanitize_turns_for_response(list(conv.turns or []), fallback_iso=fb_iso),
                        "device_id": resolved_dev or conv.device_id,
                        "cwd": conv.cwd,
                        "execution_mode": cfg.get("execution_mode", "ai"),
                        "session_id": cfg.get("session_id", ""),
                        "project_id": pid_str,
                        "project_title": ptitle or "",
                        "config": cfg,
                        "active_run": True,
                    }
            except Exception:
                pass

        recent_conv = (await session.execute(
            select(AskConversation).where(
                ((AskConversation.user_id == _user.id) | (AskConversation.user_id.is_(None)))
            ).order_by(AskConversation.updated_at.desc().nulls_last()).limit(1)
        )).scalars().first()

        if recent_conv:
            cfg, inferred = _infer_conversation_config(recent_conv)
            resolved_dev = await _resolve_concrete_device_for_conv(session, recent_conv, cfg, inferred)
            if resolved_dev and resolved_dev not in ("auto", "ask_only", "all"):
                cfg["device_id"] = resolved_dev
            pid_str = cfg.get("project_id", "")
            ptitle = await _lookup_project_title(session, pid_str)
            fb_iso = (recent_conv.updated_at or recent_conv.created_at).isoformat() if (recent_conv.updated_at or recent_conv.created_at) else None
            return {
                "id": str(recent_conv.id),
                "title": recent_conv.title,
                "turns": _sanitize_turns_for_response(list(recent_conv.turns or []), fallback_iso=fb_iso),
                "device_id": resolved_dev or recent_conv.device_id,
                "cwd": recent_conv.cwd,
                "execution_mode": cfg.get("execution_mode", "ai"),
                "session_id": cfg.get("session_id", ""),
                "project_id": pid_str,
                "project_title": ptitle or "",
                "config": cfg,
                "active_run": False,
            }

        return {"id": None}


class UpdateConversationRequest(BaseModel):
    title: str | None = None
    device_id: str | None = None
    cwd: str | None = None
    execution_mode: str | None = None
    model: str | None = None
    effort: str | None = None
    project_id: str | None = None
    session_id: str | None = None
    worktree: bool | None = None
    compact_mode: bool | None = None
    pinned: bool | None = None
    config: dict | None = None


@router.patch("/conversations/{conv_id}")
async def update_conversation(
    conv_id: str,
    body: UpdateConversationRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Update conversation metadata and configuration."""
    try:
        cid = uuid.UUID(conv_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")

    cond = (AskConversation.id == cid) & (
        (AskConversation.user_id == _user.id) | (AskConversation.user_id.is_(None))
    )
    conv = (await db.execute(select(AskConversation).where(cond))).scalars().first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if body.title is not None:
        conv.title = body.title.strip()
    if body.device_id is not None:
        conv.device_id = body.device_id.strip() or None
    if body.cwd is not None:
        conv.cwd = body.cwd.strip() or None

    cfg = dict(conv.config or {})
    if body.config:
        cfg.update(body.config)
    if body.execution_mode is not None:
        cfg["execution_mode"] = body.execution_mode
    if body.model is not None:
        cfg["model"] = body.model
    if body.effort is not None:
        cfg["effort"] = body.effort
    if body.project_id is not None:
        cfg["project_id"] = body.project_id
    if body.session_id is not None:
        cfg["session_id"] = body.session_id
    if body.worktree is not None:
        cfg["worktree"] = body.worktree
    if body.compact_mode is not None:
        cfg["compact_mode"] = body.compact_mode
    if body.pinned is not None:
        cfg["pinned"] = body.pinned

    conv.config = cfg
    conv.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "config": cfg}


@router.delete("/conversations/{conv_id}")
async def delete_conversation(
    conv_id: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Delete an Ask conversation."""
    try:
        cid = uuid.UUID(conv_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")

    cond = (AskConversation.id == cid) & (
        (AskConversation.user_id == _user.id) | (AskConversation.user_id.is_(None))
    )
    conv = (await db.execute(select(AskConversation).where(cond))).scalars().first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    await db.delete(conv)
    await db.commit()
    return {"ok": True}


class _KeepaliveSentinel:
    pass


class _GeneratorError:
    def __init__(self, exc: BaseException):
        self.exc = exc


async def sse_keepalive_generator(
    generator: AsyncGenerator[str, None],
    interval: float = 8.0,
    keepalive_msg: str = ": keepalive\n\n",
) -> AsyncGenerator[str, None]:
    """Wraps an SSE generator to send keepalive comments (: keepalive\\n\\n) whenever
    the inner generator is idle for more than `interval` seconds. This prevents
    Traefik / Nginx / Cloudflare / client socket idle timeouts."""
    queue: asyncio.Queue = asyncio.Queue()
    sentinel = _KeepaliveSentinel()

    async def worker():
        try:
            async for item in generator:
                await queue.put(item)
            await queue.put(sentinel)
        except (asyncio.CancelledError, GeneratorExit):
            pass
        except BaseException as e:
            await queue.put(_GeneratorError(e))

    task = asyncio.create_task(worker())
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=interval)
                if item is sentinel:
                    break
                if isinstance(item, _GeneratorError):
                    raise item.exc
                yield item
            except asyncio.TimeoutError:
                yield keepalive_msg
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, GeneratorExit, Exception):
                pass


async def _direct_agent_stream(
    db: AsyncSession,
    user: User,
    question: str,
    conv_id: uuid.UUID,
    conv_title: str,
    execution_mode: str,
    device_id: str | None,
    cwd: str | None,
    model: str | None = None,
    effort: str | None = None,
    session_id: str | None = None,
    project_id: str | None = None,
    fork: bool | None = None,
    compact_mode: bool | None = None,
    history: list[dict] | None = None,
    timeout_seconds: int | None = None,
    images: list[str] | None = None,
    attachments: list[dict] | None = None,
    worktree: bool = False,
):
    """Directly dispatch an agent/shell task to the user's online device without LLM intermediate step."""
    from ..services.orchestrator import _tool_run_on_device, is_likely_long_running_task

    user_created_at = datetime.now(timezone.utc).isoformat()
    req_start_mono = time.monotonic()

    yield f"data: {json.dumps({'type': 'conversation_id', 'id': str(conv_id), 'title': conv_title, 'user_created_at': user_created_at}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type': 'sources', 'sources': []}, ensure_ascii=False)}\n\n"

    action = "shell" if execution_mode == "shell" else "agent"

    # Determine effective timeout: respect user choice; otherwise auto-expand for heavy migration/sync/build tasks
    effective_timeout = timeout_seconds
    if effective_timeout is None or effective_timeout < 0:
        if is_likely_long_running_task(question):
            effective_timeout = 14400  # 4 hours for migration/archive/build tasks
        else:
            effective_timeout = 7200 if action == "agent" else 60
    # Note: effective_timeout == 0 is explicitly preserved as unlimited!

    args = {
        "action": action,
        "device_id": device_id or "",
        "cwd": cwd or "",
        "timeout_seconds": effective_timeout,
        "conversation_id": str(conv_id),
        "user_question": question,
    }
    if model:
        args["model"] = model
    if effort:
        args["effort"] = effort
    if session_id:
        args["session_id"] = session_id
    if project_id:
        args["project_id"] = project_id
    if fork is not None:
        args["fork"] = fork
    if worktree and action == "agent":
        args["worktree"] = True

    orig_session_id = session_id
    if compact_mode and session_id and action == "agent":
        try:
            from ..services.session_compactor import build_compacted_continuation
            comp_res = await build_compacted_continuation(db, session_id, question, recent_turns=6)
            injected_ctx = comp_res.get("injected_context", "")
            if injected_ctx:
                args["compact_mode"] = True
                args["parent_session_id"] = session_id
                args["system_prompt_append"] = injected_ctx
                args["prompt"] = f"{injected_ctx}\n\n当前用户指令：\n{question}"
                args.pop("session_id", None)
                session_id = None
        except Exception as e:
            logger.warning("Failed to perform compact continuation for session %s: %s", session_id, e)

    # Format attachments and images for agent prompt
    att_notes = []
    for a in (attachments or []):
        name = a.get("name") or "attachment"
        content = a.get("text_content")
        if content:
            ext = os.path.splitext(name)[1].lstrip(".") or ""
            att_notes.append(f"【用户附加文件: {name}】\n```{ext}\n{content}\n```")
        elif a.get("type") == "image":
            att_notes.append(f"【用户上传了截图/图片: {name}】")

    if images:
        args["images"] = images
        for idx, img in enumerate(images):
            if img.startswith("data:image/"):
                try:
                    header, b64data = img.split(",", 1)
                    mime = header.split(";")[0].split(":")[1] if ":" in header else "image/png"
                    ext = mime.split("/")[1] if "/" in mime else "png"
                    if ext == "jpeg":
                        ext = "jpg"
                    img_dir = Path("/tmp/memento_images") / str(conv_id)
                    img_dir.mkdir(parents=True, exist_ok=True)
                    img_path = img_dir / f"image_{idx + 1}.{ext}"
                    img_path.write_bytes(base64.b64decode(b64data))
                    att_notes.append(
                        f"【用户上传了图片 #{idx + 1}】\n"
                        f"本地文件路径: {img_path.as_posix()}\n"
                        f"提示: 你可以使用视觉/文件查看工具（如 view_file）直接读取该文件进行图像分析与代码实现。"
                    )
                except Exception as e:
                    logger.warning("Failed to save image attachment to disk: %s", e)
                    att_notes.append(f"【用户上传了图片 #{idx + 1} (多模态图像数据)】")
            else:
                att_notes.append(f"【用户上传了图片 #{idx + 1}: {img}】")

    att_summary = "\n\n".join(att_notes)

    if action == "shell":
        args["command"] = question
        cmd_display = question
    else:
        binary_map = {
            "claude": "claude",
            "codex": "codex",
            "antigravity": "agy",
            "workbuddy": "workbuddy",
        }
        binary = binary_map.get(execution_mode, execution_mode)

        # Context injection for multi-turn conversations
        final_prompt = question
        if att_summary:
            final_prompt = f"{att_summary}\n\n{final_prompt}"

        if not orig_session_id and history and "prompt" not in args:
            prior_turns = []
            msgs = history[:-1] if (history and history[-1].get("role") == "user" and (history[-1].get("content") or "").strip() == question.strip()) else history
            for m in msgs:
                r = m.get("role")
                c = (m.get("content") or "").strip()
                if not c:
                    continue
                if len(c) > 800:
                    c = c[:750] + "\n...[输出过长已节略]..."
                role_label = "用户" if r == "user" else "助手"
                prior_turns.append(f"{role_label}: {c}")

            if prior_turns:
                ctx_summary = "\n\n".join(prior_turns[-6:])
                final_prompt = (
                    f"【前文对话历史】\n"
                    f"{ctx_summary}\n\n"
                    f"--------------------\n"
                    f"【当前用户指令】\n"
                    f"{question}"
                )

        if "prompt" not in args:
            args["prompt"] = final_prompt
        args["binary"] = binary

        from .tasks import get_device_environment_summary
        env_summary = get_device_environment_summary(device_id)
        if env_summary and not orig_session_id:
            curr_spa = args.get("system_prompt_append") or ""
            args["system_prompt_append"] = f"{curr_spa}\n\n【目标设备就绪环境指纹画像】\n{env_summary}".strip()
        if orig_session_id:
            tag = "compact" if compact_mode else ("fork" if fork else "resume")
            resume_tag = f" [{tag}:{orig_session_id[:8]}]"
        else:
            resume_tag = ""
        model_tag = f" ({model})" if model else ""
        effort_tag = f" [{effort}]" if effort else ""
        cmd_display = f"[{execution_mode.upper()}{model_tag}{effort_tag}]{resume_tag} {question}"

    call_id = f"direct_{uuid.uuid4().hex[:8]}"
    tool_call_item = {
        "id": call_id,
        "tool_call_id": call_id,
        "name": "run_on_device",
        "device_name": device_id or "auto",
        "args": args,
        "command": cmd_display,
        "action": action,
        "binary": args.get("binary"),
        "status": "running",
    }
    yield f"data: {json.dumps({'type': 'tool_call', 'id': call_id, 'tool_call_id': call_id, 'name': 'run_on_device', 'args': args, 'device_name': device_id or 'auto', 'call': tool_call_item}, ensure_ascii=False)}\n\n"

    result_dict = None
    summary_text = ""
    saved = False
    assistant_created_at_final: str | None = None
    duration_ms_final: int | None = None

    async def _persist():
        nonlocal saved, assistant_created_at_final, duration_ms_final
        if saved:
            return
        saved = True
        assistant_created_at_final = datetime.now(timezone.utc).isoformat()
        duration_ms_final = int((time.monotonic() - req_start_mono) * 1000)
        tool_calls_to_save = []
        if tool_call_item:
            saved_call = dict(tool_call_item)
            if result_dict:
                saved_call["result"] = result_dict
                saved_call["status"] = result_dict.get("status", "executed")
            else:
                saved_call["status"] = "executed"
                saved_call["result"] = {
                    "status": "succeeded",
                    "stdout": summary_text or "任务执行完成",
                    "exit_code": 0,
                }
            if isinstance(saved_call.get("args"), dict) and "images" in saved_call["args"]:
                clean_args = dict(saved_call["args"])
                img_val = clean_args.get("images")
                if isinstance(img_val, list):
                    clean_args["images"] = [f"<image attachment {i+1}>" for i in range(len(img_val))]
                else:
                    del clean_args["images"]
                saved_call["args"] = clean_args
            tool_calls_to_save.append(saved_call)

        persisted_session_id = ""
        if result_dict and result_dict.get("session_id"):
            persisted_session_id = str(result_dict.get("session_id"))
        elif session_id:
            persisted_session_id = str(session_id)
        elif orig_session_id:
            persisted_session_id = str(orig_session_id)

        persisted_dev_id = (
            (result_dict.get("device_id") or result_dict.get("device_name"))
            if (result_dict and (not device_id or device_id == "auto"))
            else device_id
        )

        await _append_conversation_turns(
            conv_id=conv_id,
            user_content=question,
            assistant_content=summary_text or "任务执行完成",
            sources=None,
            tool_calls=tool_calls_to_save,
            thinking=None,
            device_id=persisted_dev_id,
            cwd=cwd,
            images=images,
            attachments=attachments,
            config={
                "execution_mode": execution_mode,
                "model": model or "",
                "effort": effort or "",
                "project_id": project_id or "",
                "session_id": persisted_session_id,
                "device_id": persisted_dev_id or "",
                "worktree": bool(worktree),
                "compact_mode": False,  # 瘦身完成后复位，后续在当前对话中默认以正常会话无缝续接
            },
            user_created_at=user_created_at,
            assistant_created_at=assistant_created_at_final,
            duration_ms=duration_ms_final,
        )

    try:
        try:
            async for evt in _tool_run_on_device(db, user, args):
                etype = evt.get("type")
                if etype == "task_chunk":
                    stream_name = evt.get("stream", "stdout")
                    text = evt.get("text", "")
                    yield f"data: {json.dumps({'type': 'task_chunk', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'device_name': evt.get('device_name'), 'stream': stream_name, 'text': text}, ensure_ascii=False)}\n\n"
                elif etype == "task_progress":
                    yield f"data: {json.dumps({'type': 'task_progress', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'device_name': evt.get('device_name'), 'status': evt.get('status')}, ensure_ascii=False)}\n\n"
                elif etype == "task_alert":
                    yield f"data: {json.dumps({'type': 'task_alert', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'device_name': evt.get('device_name'), 'alert': evt.get('alert')}, ensure_ascii=False)}\n\n"
                elif etype == "task_event":
                    yield f"data: {json.dumps({'type': 'task_event', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'event': evt.get('event')}, ensure_ascii=False)}\n\n"
                elif etype == "tool_result":
                    result_dict = evt.get("result") or {}
                    if result_dict.get("device_name"):
                        tool_call_item["device_name"] = result_dict["device_name"]
                    yield f"data: {json.dumps({'type': 'tool_result', 'task_id': result_dict.get('task_id'), 'tool_call_id': call_id, 'result': result_dict}, ensure_ascii=False)}\n\n"
                elif etype == "ping":
                    yield "data: {\"type\": \"ping\"}\n\n"
        except Exception as e:
            logger.exception("Error in direct agent stream: %s", e)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

        # Summary delta message
        if result_dict:
            status = result_dict.get("status", "completed")
            exit_code = result_dict.get("exit_code")
            stdout = (result_dict.get("stdout") or "").strip()
            stderr = (result_dict.get("stderr") or "").strip()
            err_msg = result_dict.get("error") or stderr or f"退出码 {exit_code}"

            is_only_tool_calls = False
            if action == "agent" and stdout:
                non_empty_lines = [line.strip() for line in stdout.splitlines() if line.strip()]
                if non_empty_lines and all(l.startswith(("[Tool:", "⚡ [", "[Tool ")) for l in non_empty_lines):
                    is_only_tool_calls = True

            if status == "failed":
                summary_text = f"❌ {err_msg}"
            elif status == "timeout" or exit_code == 124:
                if stdout:
                    summary_text = f"{stdout}\n\n> ⚠️ *[任务执行耗时较长触发安全保护中断，已记录上述排查过程。请发送“继续”以获取完整结论]*"
                else:
                    summary_text = f"⚠️ 任务执行超时（{err_msg[:100]}）。您可以发送“继续”继续获取结果。"
            elif status == "still_running":
                if stdout:
                    summary_text = f"{stdout}\n\n> ⏳ *[原始工具后台任务仍在持续执行中，请稍候]*"
                else:
                    summary_text = "⏳ 任务已转入后台持续执行中。"
            elif action == "agent" and stdout:
                if is_only_tool_calls:
                    summary_text = f"{stdout}\n\n> 💡 *[阶段工具排查已完成，正在生成结论。如未显示完整回复，请发送“继续”]*"
                else:
                    summary_text = stdout
            elif status == "succeeded" or exit_code == 0:
                summary_text = f"✅ {execution_mode.capitalize()} 任务在设备上执行完毕。"
            else:
                summary_text = f"⚠️ 任务执行完成（{err_msg[:100]}）。"
        else:
            summary_text = "任务执行结束。"

        yield f"data: {json.dumps({'type': 'delta', 'text': summary_text}, ensure_ascii=False)}\n\n"
    finally:
        await _persist()

    yield f"data: {json.dumps({'type': 'done', 'assistant_created_at': assistant_created_at_final, 'duration_ms': duration_ms_final})}\n\n"
    await asyncio.sleep(0.05)


_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _run_response(
    conv_id,
    user: User,
    question: str,
    request_id: str | None,
    factory,
    *,
    execution_mode: str | None = None,
    model: str | None = None,
    device_name: str | None = None,
    title: str | None = None,
) -> StreamingResponse:
    """Start the ask as a background run and stream it. The run survives the
    client disconnecting; see services/ask_runs.py."""
    try:
        run = ask_runs.start(
            str(conv_id),
            user.id,
            question,
            factory,
            request_id=request_id,
            execution_mode=execution_mode,
            model=model,
            device_name=device_name,
            title=title,
        )
    except RunConflict:
        raise HTTPException(status_code=409, detail="这个对话还有任务在运行，请等它结束或先停止")
    return StreamingResponse(run.stream(0), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.get("/runs")
async def list_active_runs(
    recent: int = 0,
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """Runs still in progress for this user (e.g. to show them after reopening the app),
    optionally including recently finished runs within `recent` seconds."""
    return [r.summary() for r in ask_runs.active_for_user(_user.id, include_recent_seconds=float(recent))]


@router.get("/runs/active")
async def list_active_runs_wrapped(
    _user: User = Depends(get_current_user),
) -> dict:
    """Wrapped active runs endpoint consumed by iOS MementoLiveActivityManager."""
    return {"runs": [r.summary() for r in ask_runs.active_for_user(_user.id)]}


@router.get("/conversations/{conv_id}/run")
async def get_run(conv_id: str, _user: User = Depends(get_current_user)) -> dict:
    run = ask_runs.get(conv_id, _user.id)
    if run is None:
        raise HTTPException(status_code=404, detail="no run")
    return run.summary()


@router.get("/conversations/{conv_id}/stream")
async def attach_run(conv_id: str, after: int = 0, _user: User = Depends(get_current_user)):
    """Replay a run's frames after `after` and follow it live."""
    run = ask_runs.get(conv_id, _user.id)
    if run is None:
        raise HTTPException(status_code=404, detail="no run")
    return StreamingResponse(run.stream(after), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.post("/conversations/{conv_id}/cancel")
async def cancel_run(conv_id: str, _user: User = Depends(get_current_user)) -> dict:
    """Stop a run, and with it any device task it is waiting on."""
    if not ask_runs.cancel(conv_id, _user.id):
        raise HTTPException(status_code=404, detail="no running task")
    return {"status": "cancelling"}


@router.post("")
async def ask(
    body: AskRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Answer a question over the user's memory, streaming the response as SSE.

    Event protocol (each line ``data: <json>``):
      {"type": "conversation_id", "id": "...", "title": "..."} — emitted first
      {"type": "sources", "sources": [...]}   — emitted once, before generation
      {"type": "delta",   "text": "..."}      — incremental answer tokens
      {"type": "done"}                        — end of stream
      {"type": "error",   "message": "..."}   — generation failed
    """
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")

    retried = ask_runs.by_request(body.request_id, _user.id)
    if retried is not None:
        return StreamingResponse(retried.stream(0), media_type="text/event-stream", headers=_SSE_HEADERS)

    device_id = (body.device_id or "").strip()

    req_config = {
        "execution_mode": body.execution_mode or "ai",
        "model": body.model or "",
        "effort": body.effort or "",
        "project_id": body.project_id or "",
        "session_id": body.session_id or "",
        "worktree": bool(body.worktree),
        "compact_mode": bool(body.compact_mode),
    }

    conv_id, conv_title, effective_cfg = await _get_or_create_conversation(
        body.conversation_id,
        _user,
        question,
        device_id or None,
        body.cwd,
        session_id=body.session_id,
        history=body.history,
        config=req_config,
    )

    if question.startswith("__mock_long_run__"):
        async def _mock_stream(run_user: User):
            yield f"data: {json.dumps({'type': 'conversation_id', 'id': str(conv_id), 'title': 'Claude Code Agent Task'}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'thinking', 'text': '正在深入推演项目状态...'}, ensure_ascii=False)}\n\n"
            await asyncio.sleep(2.5)
            yield f"data: {json.dumps({'type': 'tool_call', 'name': 'run_command', 'args': {'command': 'git status -s'}}, ensure_ascii=False)}\n\n"
            await asyncio.sleep(3.0)
            yield f"data: {json.dumps({'type': 'task_progress', 'status': '执行中 50%'}, ensure_ascii=False)}\n\n"
            await asyncio.sleep(3.5)
            yield f"data: {json.dumps({'type': 'delta', 'text': 'Agent 执行完成，状态已同步。'}, ensure_ascii=False)}\n\n"
            await asyncio.sleep(1.0)
            yield "data: {\"type\": \"done\"}\n\n"

        return _run_response(
            conv_id,
            _user,
            question,
            body.request_id,
            lambda run_db, run_user: _mock_stream(run_user),
            execution_mode=body.execution_mode or "claude",
            model=body.model or "claude-3-7-sonnet",
            device_name="haixing-mac",
            title="Claude Code Agent Task",
        )

    resolved_device_name: str | None = None
    if device_id and device_id not in ("auto", "ask_only"):
        from ..services.task_alerts import display_device_name
        mach_lookup = (await db.execute(
            select(Machine).where(
                (Machine.collector_token_hash == device_id) | (Machine.name == device_id)
            ).order_by(Machine.last_heartbeat.desc().nulls_last())
        )).scalars().first()
        resolved_device_name = display_device_name(mach_lookup.name if mach_lookup else device_id)

    exec_mode = (body.execution_mode or effective_cfg.get("execution_mode") or "ai").lower().strip()
    if exec_mode in ("claude", "codex", "antigravity", "workbuddy", "shell"):
        effective_session_id = body.session_id or effective_cfg.get("session_id") or None
        effective_project_id = body.project_id or effective_cfg.get("project_id") or None
        effective_model = body.model or effective_cfg.get("model") or None
        effective_effort = body.effort or effective_cfg.get("effort") or None
        effective_cwd = body.cwd or effective_cfg.get("cwd") or None

        return _run_response(
            conv_id,
            _user,
            question,
            body.request_id,
            lambda run_db, run_user: _direct_agent_stream(
                db=run_db,
                user=run_user,
                question=question,
                conv_id=conv_id,
                conv_title=conv_title,
                execution_mode=exec_mode,
                device_id=device_id or None,
                cwd=effective_cwd,
                model=effective_model,
                effort=effective_effort,
                session_id=effective_session_id,
                project_id=effective_project_id,
                fork=body.fork,
                compact_mode=body.compact_mode,
                history=body.history,
                timeout_seconds=body.timeout_seconds,
                images=body.images,
                attachments=body.attachments,
                worktree=bool(body.worktree),
            ),
            execution_mode=exec_mode,
            model=effective_model,
            device_name=resolved_device_name,
            title=conv_title,
        )

    if not get_ai_providers():
        raise HTTPException(status_code=503, detail="AI provider not configured")

    if body.compact_mode and body.session_id:
        try:
            from ..services.session_compactor import build_compacted_continuation
            comp_res = await build_compacted_continuation(db, body.session_id, question, recent_turns=6)
            injected_ctx = comp_res.get("injected_context", "")
            if injected_ctx:
                question = f"{injected_ctx}\n\n当前用户指令：\n{question}"
        except Exception as e:
            logger.warning("Failed to compact session in AI mode: %s", e)

    is_cont, is_action, extracted_context = _classify_continuation(question, body.history)

    # In action continuation (e.g. "帮我关闭它", "关掉", "清理掉"), suppress RAG retrieval
    # to prevent irrelevant memory notes from confusing the model and suppressing device execution.
    if is_action:
        sources = []
    else:
        retrieval_query = question
        if is_cont and body.history:
            for prev in reversed(body.history):
                if prev.get("role") == "user" and prev.get("content"):
                    prev_text = prev["content"].strip()
                    prev_cont, _, _ = _classify_continuation(prev_text, None)
                    if not prev_cont:
                        retrieval_query = f"{prev_text} {question}"
                        break
        sources = await _retrieve(db, _user, retrieval_query, body.tool, body.days)

    # Fetch prioritized core memories (L3) with active project scoping
    core_mems = await _retrieve_core_memories(
        db=db,
        user=_user,
        question=question,
        project_id=body.project_id,
        cwd=body.cwd,
        session_id=body.session_id,
        limit=12,
    )

    # 1. Fetch published resident profile (About Me & core rules)
    from ..services.profile_service import get_published_profile
    prof = await get_published_profile(db, _user)
    user_prof_content = prof.content.strip() if prof and (prof.content or "").strip() else None

    # 2. Fetch guidance (pitfalls, rules, verified skills)
    from ..services.guidance_service import guidance_for
    guidance_data = None
    try:
        guidance_data = await guidance_for(db, _user, action="ask", project=body.project_id, query=question)
    except Exception as e:
        logger.warning("Failed to load guidance in ask: %s", e)

    messages = _build_messages(
        question,
        sources,
        body.history,
        is_continuation=is_cont,
        is_action=is_action,
        extracted_context=extracted_context,
        images=body.images,
        attachments=body.attachments,
        core_memories=core_mems,
        user_profile_content=user_prof_content,
        guidance_data=guidance_data,
        device_id=device_id or None,
    )

    is_agent = (body.agent_mode or (bool(device_id) and device_id != "ask_only")) and device_id != "ask_only"

    # Agent mode: the model may also dispatch work to the user's devices when
    # synced memory isn't enough, or when a device was explicitly selected.
    # Opt-in per request — plain asks stay a single-shot RAG call with no ability to touch any machine.
    if is_agent:
        from ..services.orchestrator import ORCHESTRATOR_SYSTEM, agent_memory_prompt, run_agent_loop

        system_content = ORCHESTRATOR_SYSTEM + "\n\n" + await agent_memory_prompt(db, _user, project=body.project_id, query=question)
        if core_mems:
            core_snippets = "\n".join(
                f"- [{m.category}/{m.key}]: {m.content}" for m in core_mems
            )
            system_content += f"\n\n【用户长期核心记忆与工程规范 (MEMORY.md)】\n{core_snippets}"

        if device_id and device_id not in ("auto", "ask_only"):
            mach = (await db.execute(
                select(Machine).where(
                    (Machine.collector_token_hash == device_id) | (Machine.name == device_id)
                ).order_by(Machine.last_heartbeat.desc().nulls_last())
            )).scalars().first()
            target_device_id = mach.collector_token_hash if mach else device_id
            mach_name = mach.name if mach else device_id
            cwd_text = f"，默认工作目录 cwd 为 \"{body.cwd}\"" if body.cwd else ""
            system_content += (
                f"\n\n【用户已指定操作设备】\n"
                f"目标设备名称：\"{mach_name}\"（device_id: \"{target_device_id}\"{cwd_text}）。\n"
                f"规则：如果用户的指令需要在机器上查看状态、运行命令或处理代码，必须直接针对该设备调用 run_on_device 执行，无需再调用 list_devices。\n"
            )
            if body.cwd:
                system_content += f"除非用户在对话中另外指定路径，请优先将执行命令的 cwd 设为 \"{body.cwd}\"。"
        elif extracted_context.get("device_name"):
            prev_dev_name = extracted_context["device_name"]
            prev_dev_id = extracted_context.get("device_id") or prev_dev_name
            cwd_text = f"，默认工作目录 cwd 为 \"{body.cwd}\"" if body.cwd else ""
            system_content += (
                f"\n\n【上下文前序操作设备】\n"
                f"上一轮交互中已在设备 \"{prev_dev_name}\"（device_id: \"{prev_dev_id}\"{cwd_text}）上成功执行过操作。\n"
                f"规则：用户的跟进指令（如关闭、杀死进程、重启、排查）若未另外指定其他机器，必须直接继续针对该设备 \"{prev_dev_name}\" 调用 run_on_device 执行，无需重复调用 list_devices。\n"
            )
        elif body.cwd:
            system_content += f"\n\n【默认工作目录】用户指定默认工作目录为 \"{body.cwd}\"，执行命令时若无特殊说明请使用此 cwd。"

        agent_messages = [{"role": "system", "content": system_content}] + messages[1:]

        async def agent_stream(run_db: AsyncSession, run_user: User):
            user_created_at = datetime.now(timezone.utc).isoformat()
            req_start_mono = time.monotonic()
            yield f"data: {json.dumps({'type': 'conversation_id', 'id': str(conv_id), 'title': conv_title, 'user_created_at': user_created_at}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'sources', 'sources': sources}, ensure_ascii=False)}\n\n"
            accumulated_text: list[str] = []
            accumulated_thinking: list[str] = []
            tool_calls_map: dict[str, dict] = {}
            saved = False
            assistant_created_at_final: str | None = None
            duration_ms_final: int | None = None

            async def _persist():
                nonlocal saved, assistant_created_at_final, duration_ms_final
                if saved:
                    return
                saved = True
                assistant_created_at_final = datetime.now(timezone.utc).isoformat()
                duration_ms_final = int((time.monotonic() - req_start_mono) * 1000)
                await _append_conversation_turns(
                    conv_id,
                    question,
                    "".join(accumulated_text),
                    sources=sources,
                    tool_calls=list(tool_calls_map.values()),
                    thinking="".join(accumulated_thinking).strip() or None,
                    device_id=device_id or None,
                    cwd=body.cwd,
                    images=body.images,
                    attachments=body.attachments,
                    config=req_config,
                    user_created_at=user_created_at,
                    assistant_created_at=assistant_created_at_final,
                    duration_ms=duration_ms_final,
                )

            try:
                async for evt in run_agent_loop(run_db, run_user, agent_messages, conv_id=str(conv_id)):
                    if evt.get("type") == "ping":
                        yield ": ping\n\n"
                        yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
                    else:
                        etype = evt.get("type")
                        if etype == "tool_call":
                            cid = evt.get("id") or evt.get("tool_call_id") or ""
                            tool_calls_map[cid] = {
                                "name": evt.get("name"),
                                "args": evt.get("args"),
                                "device_name": evt.get("device_name"),
                            }
                        elif etype == "tool_result":
                            cid = evt.get("tool_call_id") or ""
                            if cid in tool_calls_map:
                                tool_calls_map[cid]["result"] = evt.get("result")
                        elif etype == "thinking":
                            accumulated_thinking.append(evt.get("text") or "")
                        elif etype == "delta":
                            accumulated_text.append(evt.get("text") or "")

                        yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
            except (asyncio.CancelledError, GeneratorExit):
                logger.info("agent stream cancelled by client")
                await _persist()
                return
            except Exception as e:
                logger.exception("agent loop failed: %s", e)
                yield f"data: {json.dumps({'type': 'error', 'message': f'调度失败: {e}'}, ensure_ascii=False)}\n\n"
            finally:
                await _persist()

            yield f"data: {json.dumps({'type': 'done', 'assistant_created_at': assistant_created_at_final, 'duration_ms': duration_ms_final})}\n\n"
            await asyncio.sleep(0.05)

        return _run_response(
            conv_id,
            _user,
            question,
            body.request_id,
            agent_stream,
            execution_mode="agent",
            model=body.model,
            device_name=resolved_device_name,
            title=conv_title,
        )

    async def stream(run_user: User = _user):
        user_created_at = datetime.now(timezone.utc).isoformat()
        req_start_mono = time.monotonic()
        yield f"data: {json.dumps({'type': 'conversation_id', 'id': str(conv_id), 'title': conv_title, 'user_created_at': user_created_at}, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'type': 'sources', 'sources': sources}, ensure_ascii=False)}\n\n"
        accumulated_text: list[str] = []
        accumulated_thinking: list[str] = []
        saved = False
        assistant_created_at_final: str | None = None
        duration_ms_final: int | None = None

        async def _persist():
            nonlocal saved, assistant_created_at_final, duration_ms_final
            if saved:
                return
            saved = True
            assistant_created_at_final = datetime.now(timezone.utc).isoformat()
            duration_ms_final = int((time.monotonic() - req_start_mono) * 1000)
            await _append_conversation_turns(
                conv_id,
                question,
                "".join(accumulated_text),
                sources=sources,
                tool_calls=None,
                thinking="".join(accumulated_thinking).strip() or None,
                device_id=device_id or None,
                cwd=body.cwd,
                images=body.images,
                attachments=body.attachments,
                config=req_config,
                user_created_at=user_created_at,
                assistant_created_at=assistant_created_at_final,
                duration_ms=duration_ms_final,
            )

        if not sources and not body.images and not body.attachments:
            empty_msg = "没有检索到相关资料。"
            accumulated_text.append(empty_msg)
            yield f"data: {json.dumps({'type': 'delta', 'text': empty_msg}, ensure_ascii=False)}\n\n"
            await _persist()
            yield f"data: {json.dumps({'type': 'done', 'assistant_created_at': assistant_created_at_final, 'duration_ms': duration_ms_final})}\n\n"
            await asyncio.sleep(0.05)
            return

        try:
            async for chunk in stream_chat_completion(
                messages=messages,
                temperature=0.3,
                max_tokens=1500,
                timeout=120.0,
                user=run_user,
            ):
                if chunk.get("type") == "thinking":
                    accumulated_thinking.append(chunk.get("text") or "")
                    yield f"data: {json.dumps({'type': 'thinking', 'text': chunk.get('text') or ''}, ensure_ascii=False)}\n\n"
                else:
                    accumulated_text.append(chunk.get("text") or "")
                    yield f"data: {json.dumps({'type': 'delta', 'text': chunk.get('text') or ''}, ensure_ascii=False)}\n\n"
        except Exception as e:
            logger.exception("ask stream failed: %s", e)
            yield f"data: {json.dumps({'type': 'error', 'message': f'生成失败: {e}'}, ensure_ascii=False)}\n\n"
            return
        finally:
            await _persist()

        yield f"data: {json.dumps({'type': 'done', 'assistant_created_at': assistant_created_at_final, 'duration_ms': duration_ms_final})}\n\n"
        await asyncio.sleep(0.05)

    # Plain answers need no database session of their own.
    return _run_response(
        conv_id,
        _user,
        question,
        body.request_id,
        lambda run_db, run_user: stream(run_user),
        execution_mode="rag",
        model=body.model,
        device_name=None,
        title=conv_title,
    )


# ---------------------------------------------------------------------------
# Dynamic Agent Capabilities & Models Discovery
# ---------------------------------------------------------------------------

FALLBACK_AGENT_CAPABILITIES = {
    "codex": {
        "tool": "codex",
        "models": [
            {"id": "", "name": "⚡ 默认模型 (跟随客户端/CLI配置)", "desc": "使用本地 Codex 客户端配置的默认模型", "is_default": True},
            {"id": "gpt-6-astra", "name": "GPT-6-Astra (最新旗舰)", "desc": "前沿深度多步推理模型，复杂编码首选"},
            {"id": "gpt-reserve", "name": "GPT-Reserve (极速主力)", "desc": "高性价比快速编码与日常任务"},
            {"id": "gpt-5.6-sol", "name": "GPT-5.6-Sol (日常主力)", "desc": "可靠的主力 Agent 编码模型"},
            {"id": "gpt-5.6-terra", "name": "GPT-5.6-Terra", "desc": "均衡的高性价比日常模型"},
            {"id": "gpt-5.6-luna", "name": "GPT-5.6-Luna", "desc": "极速响应日常编码模型"},
            {"id": "gpt-5.5", "name": "GPT-5.5 (经典稳定)", "desc": "经典全能编码与推理模型"},
            {"id": "o3", "name": "o3 (深度思维)", "desc": "OpenAI 深度思维链"},
            {"id": "o4-mini", "name": "o4-mini", "desc": "轻量高速响应"},
        ],
        "default_model": "gpt-5.6-sol",
        "supports_effort": True,
        "default_effort": "medium",
        "effort_options": [
            {"id": "", "name": "⚡ 默认 Effort (跟随配置)", "desc": "使用本地配置的 reasoning_effort"},
            {"id": "low", "name": "Low (快速 / 低思考量)", "desc": "轻量思考，极速响应，节省 Token"},
            {"id": "medium", "name": "Medium (标准思考量)", "desc": "平衡速度与推理质量，适合日常编程"},
            {"id": "high", "name": "High (深度推理 / 高思考量)", "desc": "深入思维链，攻坚复杂架构与疑难排错"},
        ],
    },
    "claude": {
        "tool": "claude",
        "models": [
            {"id": "", "name": "⚡ 默认模型 (跟随客户端/CLI配置)", "desc": "使用本地 Claude 客户端配置默认模型", "is_default": True},
            {"id": "sonnet", "name": "sonnet (官方动态最新 Sonnet 别名)", "desc": "官方推荐别名，自动指向最新主力 (当前为 Claude Sonnet 5)"},
            {"id": "opus", "name": "opus (官方动态最新 Opus 别名)", "desc": "官方推荐别名，极高智能与超长上下文 (当前为 Claude Opus 5)"},
            {"id": "fable", "name": "fable (官方动态最新 Fable 别名)", "desc": "官方推荐别名，最强智能体与高阶科学推理 (当前为 Claude Fable 5.1)"},
            {"id": "opus[1m]", "name": "opus[1m] (100万上下文增强版)", "desc": "Claude Opus 深度思维 / 100万 Token 超大上下文"},
            {"id": "haiku", "name": "haiku (官方动态最新 Haiku 别名)", "desc": "官方推荐别名，极速轻量 (当前为 Claude Haiku 4.5)"},
            {"id": "claude-fable-5-1", "name": "claude-fable-5-1 (Claude Fable 5.1)", "desc": "官方最强智能体与高阶科学推理模型 (顶尖旗舰)"},
            {"id": "claude-opus-5", "name": "claude-opus-5 (Claude Opus 5)", "desc": "官方顶级旗舰架构设计与复杂推演 (当前旗舰)"},
            {"id": "claude-sonnet-5", "name": "claude-sonnet-5 (Claude Sonnet 5)", "desc": "官方最新主力编码与推理模型 (当前主力)"},
            {"id": "claude-opus-4-8", "name": "claude-opus-4-8 (Claude Opus 4.8)", "desc": "高阶复杂推理模型"},
            {"id": "claude-opus-4-6", "name": "claude-opus-4-6 (Claude Opus 4.6)", "desc": "前沿架构分析与深度推演模型"},
            {"id": "claude-sonnet-4-6", "name": "claude-sonnet-4-6 (Claude Sonnet 4.6)", "desc": "前沿高效编码与推理模型"},
            {"id": "claude-opus-4-5-20251101", "name": "claude-opus-4-5-20251101 (Claude Opus 4.5)", "desc": "高阶深度思维与复杂推演模型"},
            {"id": "claude-sonnet-4-5-20250929", "name": "claude-sonnet-4-5-20250929 (Claude Sonnet 4.5)", "desc": "前沿多步推理与编码模型"},
            {"id": "claude-haiku-4-5-20251001", "name": "claude-haiku-4-5-20251001 (Claude Haiku 4.5)", "desc": "毫秒级响应极速轻量模型"},
            {"id": "claude-opus-4-1-20250805", "name": "claude-opus-4-1-20250805 (Claude Opus 4.1)", "desc": "顶级复杂推理与工程攻坚"},
            {"id": "claude-3-7-sonnet-20250219", "name": "claude-3-7-sonnet-20250219 (Claude 3.7 Sonnet)", "desc": "经典混合推理与编码模型 (早期版本)"},
            {"id": "claude-3-5-sonnet-20241022", "name": "claude-3-5-sonnet-20241022 (Claude 3.5 Sonnet)", "desc": "经典高性价比编码模型"},
            {"id": "claude-3-5-haiku-20241022", "name": "claude-3-5-haiku-20241022 (Claude 3.5 Haiku)", "desc": "极速轻量日常模型"},
        ],
        "default_model": "opus[1m]",
        "supports_effort": True,
        "default_effort": "max",
        "effort_options": [
            {"id": "", "name": "⚡ 默认 Effort (跟随配置)", "desc": "使用本地配置的 effortLevel"},
            {"id": "low", "name": "Low (快速 / 低思考量)", "desc": "轻量思考，极速响应，节省 Token"},
            {"id": "medium", "name": "Medium (标准思考量)", "desc": "平衡速度与推理质量，适合日常编程"},
            {"id": "high", "name": "High (深度推理 / 高思考量)", "desc": "深入思维链，攻坚复杂架构与排错"},
            {"id": "max", "name": "Max (最大思考量)", "desc": "顶级复杂任务深度多步探索"},
        ],
    },
    "antigravity": {
        "tool": "antigravity",
        "models": [
            {"id": "", "name": "⚡ 默认模型 (系统配置: Gemini 3.8 Flash)", "desc": "使用当前 Antigravity 默认模型配置", "is_default": True},
            {"id": "gemini-3.8-flash", "name": "Gemini 3.8 Flash (High, Fast)", "desc": "最新高智能极速响应模型 (Antigravity 默认推荐)"},
            {"id": "gemini-3.7-flash", "name": "Gemini 3.7 Flash (Medium, Fast)", "desc": "极速日常编码与高吞吐分析"},
            {"id": "gemini-3.6-flash", "name": "Gemini 3.6 Flash (Fast)", "desc": "轻量超低延迟模型"},
            {"id": "gemini-3.1-pro", "name": "Gemini 3.1 Pro (深度推理)", "desc": "高复杂度架构攻坚与深度逻辑推演"},
            {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (Thinking)", "desc": "原生嵌入 Antigravity 的高阶思维模型"},
            {"id": "claude-opus-4-6", "name": "Claude Opus 4.6 (Thinking)", "desc": "顶级架构分析与复杂逻辑推演"},
            {"id": "gpt-oss-120b", "name": "GPT-OSS 120B (Medium)", "desc": "开源高性价比大模型"},
            {"id": "flash", "name": "Gemini Flash (快速推荐)", "desc": "标准 Flash 阶梯 (自动映射最新 Gemini 3.8 Flash)"},
            {"id": "pro", "name": "Gemini Pro (强力推理)", "desc": "标准 Pro 阶梯 (自动映射最新 Gemini 3.1 Pro / Claude)"},
            {"id": "flash_lite", "name": "Gemini Flash-Lite (超轻量)", "desc": "超轻量阶梯 (自动映射 Gemini 3.6 Flash)"},
        ],
        "default_model": "gemini-3.8-flash",
        "supports_effort": False,
        "default_effort": "",
        "effort_options": [],
    },
    "workbuddy": {
        "tool": "workbuddy",
        "models": [
            {"id": "", "name": "⚡ 默认模型 (跟随 WorkBuddy 配置)", "desc": "使用当前 WorkBuddy 客户端配置的默认模型", "is_default": True},
            {"id": "deep-model", "name": "极致 (Deep Model)", "desc": "旗舰模型组合，专为复杂决策与高难度任务打造"},
            {"id": "balanced-model", "name": "均衡 (Balanced Model)", "desc": "性能与成本兼顾，稳定应对日常工作"},
            {"id": "fast-model", "name": "快速 (Fast Model)", "desc": "低成本极速响应，适合轻量高频操作"},
            {"id": "hy4-preview", "name": "Tencent HY 4.0 Preview", "desc": "腾讯混元旗舰大模型 4.0 预览版"},
            {"id": "hy3-x", "name": "Tencent HY 3.0-X", "desc": "腾讯混元 3.0 增强推理模型"},
            {"id": "hy3", "name": "Tencent HY 3.0", "desc": "腾讯混元 3.0 主力大模型"},
            {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "desc": "DeepSeek V4 旗舰深度推理模型"},
            {"id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "desc": "DeepSeek V4.1 高速响应模型"},
            {"id": "glm-5.3", "name": "GLM-5.3", "desc": "智谱旗舰编码与 Agent 模型"},
            {"id": "glm-5.3-flash", "name": "GLM-5.3-Flash", "desc": "智谱高速轻量模型"},
            {"id": "glm-5.2", "name": "GLM-5.2", "desc": "智谱主力通用大模型"},
            {"id": "glm-5.1", "name": "GLM-5.1", "desc": "智谱稳定编码模型"},
            {"id": "glm-5v-turbo", "name": "GLM-5V-Turbo", "desc": "智谱多模态视觉极速模型"},
            {"id": "minimax-m3", "name": "MiniMax-M3", "desc": "MiniMax M3 原生智能体模型"},
            {"id": "kimi-k3-1", "name": "Kimi-K3.1", "desc": "月之暗面 Kimi K3.1 旗舰长上下文模型"},
            {"id": "kimi-k2.8-preview", "name": "Kimi-K2.8-Preview", "desc": "月之暗面 Kimi K2.8 预览版"},
            {"id": "kimi-k2.7", "name": "Kimi-K2.7", "desc": "月之暗面 Kimi K2.7 模型"},
            {"id": "kimi-k2.6", "name": "Kimi-K2.6", "desc": "月之暗面 Kimi K2.6 模型"},
        ],
        "default_model": "",
        "supports_effort": True,
        "default_effort": "medium",
        "effort_options": [
            {"id": "", "name": "⚡ 默认思考量 (跟随 WorkBuddy 配置)", "desc": "使用当前模型默认思考深度"},
            {"id": "minimal", "name": "Minimal (极简思考)", "desc": "最低思考开销，极速直出"},
            {"id": "low", "name": "Low (低思考量)", "desc": "轻量思考，快速响应"},
            {"id": "medium", "name": "Medium (中等思考量)", "desc": "平衡推理速度与深度"},
            {"id": "high", "name": "High (高思考量)", "desc": "深入推理，适合复杂编码"},
            {"id": "xhigh", "name": "XHigh (超高思考量)", "desc": "高强度多步逻辑推演"},
            {"id": "max", "name": "Max (最大思考量)", "desc": "全量深度思维链探索"},
        ],
    },
}


@router.get("/capabilities")
@router.get("/agent/capabilities")
@router.get("/api/agent/capabilities")
async def get_agent_capabilities(
    tool: str = "codex",
    device_id: str | None = None,
    user: User = Depends(get_current_user),
):
    """Retrieve dynamic models, default configs, and reasoning effort options for a specified agent tool."""
    from .tasks import get_cached_device_capabilities

    tool_key = tool.lower().strip()
    live = get_cached_device_capabilities(device_id, tool_key)
    if live and isinstance(live, dict) and live.get("models"):
        # Ensure models is a list of structured dicts
        norm_models = []
        for m in live.get("models", []):
            if isinstance(m, dict):
                norm_models.append(m)
            elif isinstance(m, str):
                norm_models.append({"id": m, "name": m, "desc": ""})
        live_copy = dict(live)
        live_copy["models"] = norm_models
        return live_copy

    return FALLBACK_AGENT_CAPABILITIES.get(
        tool_key,
        {
            "tool": tool_key,
            "models": [
                {"id": "", "name": "⚡ 默认模型 (跟随客户端/CLI配置)", "desc": "使用客户端配置默认模型", "is_default": True}
            ],
            "default_model": "",
            "supports_effort": False,
            "default_effort": "",
            "effort_options": [],
        },
    )


@router.get("/models")
@router.get("/agent/models")
@router.get("/api/agent/models")
async def get_agent_models(
    tool: str = "codex",
    device_id: str | None = None,
    user: User = Depends(get_current_user),
):
    """Compatibility alias returning model list."""
    caps = await get_agent_capabilities(tool=tool, device_id=device_id, user=user)
    return {"tool": tool, "models": caps.get("models", [])}

