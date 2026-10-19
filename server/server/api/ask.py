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
import time
from datetime import datetime, timezone


from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.ai_provider import get_ai_providers, stream_chat_completion
from ..services.ask_runs import ask_runs
from ..services.ask_prompt import build_messages, classify_continuation
from ..services.ask_retrieval import retrieve, retrieve_core_memories
from ..services.ask_store import append_conversation_turns, get_or_create_conversation
from ..services.ask_stream import SSE_HEADERS, direct_agent_stream, run_response
from . import ask_conversations

logger = logging.getLogger("server.ask")

router = APIRouter(prefix="/api/ask", tags=["ask"])
router.include_router(ask_conversations.router)


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


@router.get("/runs")
async def list_active_runs(
    recent: int = 0,
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """Runs still in progress for this user (e.g. to show them after reopening the app),
    optionally including recently finished runs within `recent` seconds."""
    return [r.summary() for r in await ask_runs.active_for_user(_user.id, include_recent_seconds=float(recent))]


@router.get("/runs/active")
async def list_active_runs_wrapped(
    _user: User = Depends(get_current_user),
) -> dict:
    """Wrapped active runs endpoint consumed by iOS MementoLiveActivityManager."""
    return {"runs": [r.summary() for r in await ask_runs.active_for_user(_user.id)]}


@router.get("/conversations/{conv_id}/run")
async def get_run(conv_id: str, _user: User = Depends(get_current_user)) -> dict:
    run = await ask_runs.get(conv_id, _user.id)
    if run is None:
        raise HTTPException(status_code=404, detail="no run")
    return run.summary()


@router.get("/conversations/{conv_id}/stream")
async def attach_run(conv_id: str, after: int = 0, _user: User = Depends(get_current_user)):
    """Replay a run's frames after `after` and follow it live."""
    run = await ask_runs.get(conv_id, _user.id)
    if run is None:
        raise HTTPException(status_code=404, detail="no run")
    return StreamingResponse(run.stream(after), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/conversations/{conv_id}/cancel")
async def cancel_run(conv_id: str, _user: User = Depends(get_current_user)) -> dict:
    """Stop a run, and with it any device task it is waiting on."""
    if not await ask_runs.cancel(conv_id, _user.id):
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

    retried = await ask_runs.by_request(body.request_id, _user.id)
    if retried is not None:
        return StreamingResponse(retried.stream(0), media_type="text/event-stream", headers=SSE_HEADERS)

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

    conv_id, conv_title, effective_cfg = await get_or_create_conversation(
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

        return await run_response(
            conv_id,
            _user,
            question,
            body.request_id,
            lambda run_db, run_user: _mock_stream(run_user),
            execution_mode=body.execution_mode or "claude",
            model=body.model or "opus",
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
        effective_session_id = body.session_id or (effective_cfg.get("session_id") if body.conversation_id else None) or None
        effective_project_id = body.project_id or (effective_cfg.get("project_id") if body.conversation_id else None) or None
        effective_model = body.model or (effective_cfg.get("model") if body.conversation_id else None) or None
        effective_effort = body.effort or (effective_cfg.get("effort") if body.conversation_id else None) or None
        effective_cwd = body.cwd or (effective_cfg.get("cwd") if body.conversation_id else None) or None

        return await run_response(
            conv_id,
            _user,
            question,
            body.request_id,
            lambda run_db, run_user: direct_agent_stream(
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

    is_cont, is_action, extracted_context = classify_continuation(question, body.history)

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
                    prev_cont, _, _ = classify_continuation(prev_text, None)
                    if not prev_cont:
                        retrieval_query = f"{prev_text} {question}"
                        break
        sources = await retrieve(db, _user, retrieval_query, body.tool, body.days)

    # Fetch prioritized core memories (L3) with active project scoping
    core_mems = await retrieve_core_memories(
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

    # 3. Mind Resonance (前置心领神会与默契共鸣)
    from ..services.mind_resonance_service import sense_resonance
    resonance_data = None
    try:
        resonance_data = await sense_resonance(db, _user, query=question, project=body.project_id)
    except Exception as e:
        logger.warning("Failed to load mind resonance in ask: %s", e)

    messages = build_messages(
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
        resonance_data=resonance_data,
        device_id=device_id or None,
        user=_user,
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
                await append_conversation_turns(
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

        return await run_response(
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
            await append_conversation_turns(
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
    return await run_response(
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
            {"id": "opus", "name": "opus (官方动态最新 Opus 别名)", "desc": "官方推荐别名，极高智能与超长上下文 (当前自动映射 Claude Opus 5.5)"},
            {"id": "sonnet", "name": "sonnet (官方动态最新 Sonnet 别名)", "desc": "官方推荐别名，自动指向最新主力 (当前自动映射 Claude Sonnet 5.5)"},
            {"id": "fable", "name": "fable (官方动态最新 Fable 别名)", "desc": "官方推荐别名，最强智能体与高阶科学推理 (当前为 Claude Fable 5.1)"},
            {"id": "opus[1m]", "name": "opus[1m] (100万上下文增强版)", "desc": "Claude Opus 深度思维 / 100万 Token 超大上下文"},
            {"id": "haiku", "name": "haiku (官方动态最新 Haiku 别名)", "desc": "官方推荐别名，极速轻量 (当前为 Claude Haiku 4.5)"},
            {"id": "claude-opus-5-5", "name": "claude-opus-5-5 (Claude Opus 5.5)", "desc": "顶尖旗舰架构设计与前沿复杂多步推理 (最新顶级旗舰)"},
            {"id": "claude-sonnet-5-5", "name": "claude-sonnet-5-5 (Claude Sonnet 5.5)", "desc": "最新前沿主力编码与多模态推理模型 (最新主力)"},
            {"id": "opus-5.5", "name": "opus-5.5 (Claude Opus 5.5 简写)", "desc": "Claude Opus 5.5 快速别名"},
            {"id": "sonnet-5.5", "name": "sonnet-5.5 (Claude Sonnet 5.5 简写)", "desc": "Claude Sonnet 5.5 快速别名"},
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
        "default_model": "opus",
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
    from ..services.device_reports import get_cached_device_capabilities

    tool_key = tool.lower().strip()
    live = get_cached_device_capabilities(device_id, tool_key, user)
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


async def get_agent_models(
    tool: str = "codex",
    device_id: str | None = None,
    user: User = Depends(get_current_user),
):
    """Compatibility alias returning model list."""
    caps = await get_agent_capabilities(tool=tool, device_id=device_id, user=user)
    return {"tool": tool, "models": caps.get("models", [])}
