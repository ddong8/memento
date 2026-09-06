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
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import or_, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, Machine, User, AskConversation
from ..db.session import get_db, async_session_factory
from ..middleware.auth import get_current_user
from ..services.user_filter import user_machine_ids, apply_user_filter
from ..services.ai_provider import get_ai_providers, stream_chat_completion
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


async def _retrieve(
    db: AsyncSession, user: User, q: str, tool: str | None, days: int | None
) -> list[dict]:
    """Hybrid retrieval — the same keyword+vector RRF fusion as /api/search."""
    from ..services.tokenize import tokenize_for_query

    mids = await user_machine_ids(db, user)
    tsquery = tokenize_for_query(q)
    term = f"%{q}%"

    conds = [Document.title.ilike(term), Document.relative_path.ilike(term)]
    if tsquery:
        conds.append(Document.content_tsv.op("@@")(func.to_tsquery("simple", tsquery)))

    kw_q = select(Document).where(or_(*conds))
    if tool:
        kw_q = kw_q.where(Document.tool_id == tool)
    if days:
        from datetime import datetime, timedelta, timezone

        kw_q = kw_q.where(
            Document.synced_at >= datetime.now(timezone.utc) - timedelta(days=days)
        )
    kw_q = apply_user_filter(kw_q, mids, Document.machine_id)
    kw_docs = (
        await db.execute(kw_q.order_by(Document.synced_at.desc()).limit(TOP_K))
    ).scalars().all()

    sem_order, sem_snippets = await _semantic_doc_ranks(
        db, q, mids, tool, None, days, want=TOP_K
    )

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

    sources = []
    for d in docs[:TOP_K]:
        # Prefer the semantically-matched chunk — it is the passage that
        # actually answered the query. Fall back to the head of the document.
        text = sem_snippets.get(d.id) or (d.content or "")[:CHARS_PER_DOC]
        sources.append({
            "id": str(d.id),
            "title": d.title or (d.relative_path or "").split("/")[-1],
            "relative_path": d.relative_path,
            "tool_id": d.tool_id,
            "category": d.category,
            "synced_at": d.synced_at.isoformat() if d.synced_at else None,
            "excerpt": (text or "")[:CHARS_PER_DOC],
        })
    return sources


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
) -> list[dict]:
    context = "\n\n".join(
        f"[{i + 1}] {s['title']} ({s['tool_id']}, {s['relative_path']})\n{s['excerpt']}"
        for i, s in enumerate(sources)
    ) or "(没有检索到相关资料)"

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
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
) -> tuple[uuid.UUID, str]:
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
                    return conv.id, conv.title
            except Exception:
                pass

        # Create new conversation with title extracted from question
        title = question.strip().replace("\n", " ")[:50] or "新对话"
        conv = AskConversation(
            user_id=user.id,
            title=title,
            turns=[],
            device_id=device_id,
            cwd=cwd,
        )
        session.add(conv)
        await session.commit()
        await session.refresh(conv)
        return conv.id, conv.title


async def _append_conversation_turns(
    conv_id: uuid.UUID,
    user_content: str,
    assistant_content: str,
    sources: list[dict] | None = None,
    tool_calls: list[dict] | None = None,
    device_id: str | None = None,
    cwd: str | None = None,
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
            turns.append({
                "role": "user",
                "content": user_content,
                "created_at": now_iso,
            })
            asst_turn: dict = {
                "role": "assistant",
                "content": assistant_content,
                "created_at": now_iso,
            }
            if sources:
                asst_turn["sources"] = sources
            if tool_calls:
                asst_turn["toolCalls"] = tool_calls
            turns.append(asst_turn)

            conv.turns = turns
            conv.updated_at = datetime.now(timezone.utc)
            if device_id:
                conv.device_id = device_id
            if cwd:
                conv.cwd = cwd
            await session.commit()
    except Exception as e:
        logger.exception("Failed to persist conversation %s turns: %s", conv_id, e)


@router.get("/conversations")
async def list_conversations(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """List recent Ask conversations for the current user."""
    cond = (AskConversation.user_id == _user.id) | (AskConversation.user_id.is_(None))
    query = (
        select(
            AskConversation.id,
            AskConversation.title,
            AskConversation.created_at,
            AskConversation.updated_at,
            AskConversation.device_id,
            func.jsonb_array_length(AskConversation.turns).label("message_count"),
        )
        .where(cond)
        .order_by(AskConversation.updated_at.desc().nulls_last())
        .limit(100)
    )
    res = await db.execute(query)
    rows = res.all()
    return [
        {
            "id": str(r.id),
            "title": r.title,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            "device_id": r.device_id,
            "message_count": r.message_count or 0,
        }
        for r in rows
    ]


@router.get("/conversations/{conv_id}")
async def get_conversation(
    conv_id: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Get full conversation history with all turns."""
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

    return {
        "id": str(conv.id),
        "title": conv.title,
        "turns": conv.turns or [],
        "device_id": conv.device_id,
        "cwd": conv.cwd,
        "created_at": conv.created_at.isoformat() if conv.created_at else None,
        "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
    }


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
    if not get_ai_providers():
        raise HTTPException(status_code=503, detail="AI provider not configured")

    device_id = (body.device_id or "").strip()

    conv_id, conv_title = await _get_or_create_conversation(
        body.conversation_id,
        _user,
        question,
        device_id or None,
        body.cwd,
    )

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

    messages = _build_messages(
        question,
        sources,
        body.history,
        is_continuation=is_cont,
        is_action=is_action,
        extracted_context=extracted_context,
    )

    is_agent = (body.agent_mode or (bool(device_id) and device_id != "ask_only")) and device_id != "ask_only"

    # Agent mode: the model may also dispatch work to the user's devices when
    # synced memory isn't enough, or when a device was explicitly selected.
    # Opt-in per request — plain asks stay a single-shot RAG call with no ability to touch any machine.
    if is_agent:
        from ..services.orchestrator import ORCHESTRATOR_SYSTEM, run_agent_loop

        system_content = ORCHESTRATOR_SYSTEM
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

        async def agent_stream():
            yield f"data: {json.dumps({'type': 'conversation_id', 'id': str(conv_id), 'title': conv_title}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'sources', 'sources': sources}, ensure_ascii=False)}\n\n"
            accumulated_text: list[str] = []
            tool_calls_map: dict[str, dict] = {}
            saved = False

            async def _persist():
                nonlocal saved
                if saved:
                    return
                saved = True
                await _append_conversation_turns(
                    conv_id,
                    question,
                    "".join(accumulated_text),
                    sources=sources,
                    tool_calls=list(tool_calls_map.values()),
                    device_id=device_id or None,
                    cwd=body.cwd,
                )

            try:
                async for evt in run_agent_loop(db, _user, agent_messages):
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

            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        return StreamingResponse(
            agent_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    async def stream():
        yield f"data: {json.dumps({'type': 'conversation_id', 'id': str(conv_id), 'title': conv_title}, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'type': 'sources', 'sources': sources}, ensure_ascii=False)}\n\n"
        accumulated_text: list[str] = []
        saved = False

        async def _persist():
            nonlocal saved
            if saved:
                return
            saved = True
            await _append_conversation_turns(
                conv_id,
                question,
                "".join(accumulated_text),
                sources=sources,
                tool_calls=None,
                device_id=device_id or None,
                cwd=body.cwd,
            )

        if not sources:
            empty_msg = "没有检索到相关资料。"
            accumulated_text.append(empty_msg)
            yield f"data: {json.dumps({'type': 'delta', 'text': empty_msg}, ensure_ascii=False)}\n\n"
            await _persist()
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return

        try:
            async for delta in stream_chat_completion(
                messages=messages,
                temperature=0.3,
                max_tokens=1500,
                timeout=120.0,
            ):
                accumulated_text.append(delta)
                yield f"data: {json.dumps({'type': 'delta', 'text': delta}, ensure_ascii=False)}\n\n"
        except Exception as e:
            logger.exception("ask stream failed: %s", e)
            yield f"data: {json.dumps({'type': 'error', 'message': f'生成失败: {e}'}, ensure_ascii=False)}\n\n"
            return
        finally:
            await _persist()

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
