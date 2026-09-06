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

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import or_, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, Machine, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.user_filter import user_machine_ids, apply_user_filter
from .search import _semantic_doc_ranks, RRF_K

logger = logging.getLogger("server.ask")

router = APIRouter(prefix="/api/ask", tags=["ask"])

# Reuse the same provider config the summary/knowledge passes already use, so
# deployments need no new credentials.
AI_BASE_URL = os.environ.get("MEMENTO_AI_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1")
AI_API_KEY = os.environ.get("MEMENTO_AI_API_KEY", "")
AI_MODEL = os.environ.get("MEMENTO_AI_MODEL", "kimi-k2.5")

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


CONTINUATION_KEYWORDS = (
    "继续", "修复", "重试", "接着", "还没好", "没好", "再试", "重新",
    "还是报错", "依然报错", "解决一下", "搞定它", "接着修", "排查", "查一下", "启动一下", "怎么回事", "为什么",
)


def _is_continuation(question: str) -> bool:
    q = question.strip()
    if len(q) <= 30 and any(kw in q for kw in CONTINUATION_KEYWORDS):
        return True
    return False


def _format_tool_calls_summary(tool_calls: list[dict]) -> str:
    if not tool_calls:
        return ""
    lines = ["【在设备上调用的工具与执行结果记录】:"]
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
            if content and content != "任务已执行完成。":
                parts.append(content)
            combined = "\n\n".join(parts)
            if combined:
                messages.append({"role": role, "content": combined})
        elif role == "user" and content:
            messages.append({"role": role, "content": content})

    if is_continuation:
        user_prompt = (
            f"【跟进与继续修复指令】\n"
            f"用户指令: 「{question}」\n"
            f"请仔细结合上方历史记录中上一轮在设备上执行的命令、退出码以及报错日志（stderr），"
            f"分析失败根因，并在目标设备上主动调用 run_on_device 执行下一步排查或修复操作"
            f"（例如杀死占用端口的进程、修复代码/配置、安装依赖、重启并检查状态）。\n"
            f"绝对不可在未执行修复操作时直接结束或回答「任务已完成」！"
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


@router.post("")
async def ask(
    body: AskRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Answer a question over the user's memory, streaming the response as SSE.

    Event protocol (each line ``data: <json>``):
      {"type": "sources", "sources": [...]}   — emitted once, before generation
      {"type": "delta",   "text": "..."}      — incremental answer tokens
      {"type": "done"}                        — end of stream
      {"type": "error",   "message": "..."}   — generation failed
    """
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    if not AI_API_KEY:
        raise HTTPException(status_code=503, detail="AI provider not configured")

    is_cont = _is_continuation(question)
    retrieval_query = question
    if is_cont and body.history:
        for prev in reversed(body.history):
            if prev.get("role") == "user" and prev.get("content"):
                prev_text = prev["content"].strip()
                if not _is_continuation(prev_text):
                    retrieval_query = f"{prev_text} {question}"
                    break

    sources = await _retrieve(db, _user, retrieval_query, body.tool, body.days)
    messages = _build_messages(question, sources, body.history, is_continuation=is_cont)

    device_id = (body.device_id or "").strip()
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
        elif body.cwd:
            system_content += f"\n\n【默认工作目录】用户指定默认工作目录为 \"{body.cwd}\"，执行命令时若无特殊说明请使用此 cwd。"

        agent_messages = [{"role": "system", "content": system_content}] + messages[1:]

        async def agent_stream():
            yield f"data: {json.dumps({'type': 'sources', 'sources': sources}, ensure_ascii=False)}\n\n"
            try:
                async for evt in run_agent_loop(db, _user, agent_messages):
                    if evt.get("type") == "ping":
                        # Both SSE comment and JSON data ping to prevent proxy/browser idle timeouts
                        yield ": ping\n\n"
                        yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
                    else:
                        yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
            except (asyncio.CancelledError, GeneratorExit):
                logger.info("agent stream cancelled by client")
                return
            except Exception as e:
                logger.exception("agent loop failed: %s", e)
                yield f"data: {json.dumps({'type': 'error', 'message': f'调度失败: {e}'}, ensure_ascii=False)}\n\n"
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
        # Sources go out first so the UI can render citations while the model
        # is still thinking.
        yield f"data: {json.dumps({'type': 'sources', 'sources': sources}, ensure_ascii=False)}\n\n"

        if not sources:
            yield f"data: {json.dumps({'type': 'delta', 'text': '没有检索到相关资料。'}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{AI_BASE_URL}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {AI_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": AI_MODEL,
                        "messages": messages,
                        "temperature": 0.3,
                        "max_tokens": 1500,
                        "stream": True,
                    },
                ) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode("utf-8", "replace")[:300]
                        logger.warning("AI API %d: %s", resp.status_code, detail)
                        yield f"data: {json.dumps({'type': 'error', 'message': f'AI 服务返回 {resp.status_code}'}, ensure_ascii=False)}\n\n"
                        return

                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        payload = line[6:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        delta = (
                            chunk.get("choices", [{}])[0].get("delta", {}).get("content")
                        )
                        if delta:
                            yield f"data: {json.dumps({'type': 'delta', 'text': delta}, ensure_ascii=False)}\n\n"
        except Exception as e:
            logger.exception("ask stream failed: %s", e)
            yield f"data: {json.dumps({'type': 'error', 'message': '生成失败,请重试'}, ensure_ascii=False)}\n\n"
            return

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # nginx/ingress buffers SSE by default, which makes the whole
            # answer land at once instead of streaming.
            "X-Accel-Buffering": "no",
        },
    )
