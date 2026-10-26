"""Conversation endpoints under /api/ask: list, get, restore, rename, delete.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from datetime import datetime, timezone


from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User, AskConversation
from ..db.session import get_db, async_session_factory
from ..middleware.auth import get_current_user
from ..services.cache import cache_get, cache_set, cache_delete_prefix
from ..services.user_filter import find_machine_by_id_or_hash
from ..services.ask_runs import ask_runs
from ..services.ask_store import (
    get_or_create_conversation, infer_conversation_config, lookup_project_title,
    recover_orphaned_tasks_for_conv, resolve_concrete_device_for_conv, sanitize_turns_for_response,
)

logger = logging.getLogger("server.ask")

router = APIRouter()

@router.get("/conversations")
async def list_conversations(
    device_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """List recent Ask conversations for the current user."""
    cache_key = f"ask_conv_list:{_user.id}:{device_id or 'all'}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

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
            AskConversation.message_count,
        )
        .where(cond)
        .order_by(AskConversation.updated_at.desc().nulls_last())
        .limit(100)
    )
    res = await db.execute(query)
    rows = res.all()
    from ..services.ingest_service import _is_junk_or_uuid_title

    # 1. 预先收集需要补全元数据的会话 ID，采用单次批量查询替换循环体内的 N+1 次 db.get
    need_turn_ids = []
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
        if need_turns:
            need_turn_ids.append(r.id)

    conv_obj_map: dict[uuid.UUID, AskConversation] = {}
    if need_turn_ids:
        batch_res = await db.execute(
            select(AskConversation).where(AskConversation.id.in_(need_turn_ids))
        )
        for obj in batch_res.scalars().all():
            conv_obj_map[obj.id] = obj

    out_items = []
    dirty_repaired = False
    for r in rows:
        cfg = dict(r.config or {})
        display_title = r.title or "新对话"
        conv_obj = conv_obj_map.get(r.id)
        turns_list = list(conv_obj.turns or []) if conv_obj else None

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

    await cache_set(cache_key, out_items, ttl_seconds=15)
    return out_items


@router.get("/conversations/recent-active")
async def get_recent_active_conversation(
    _user: User = Depends(get_current_user),
):
    """The run going on for the user right now (on any device), for the page's handoff banner and its
    startup restore, which then load the conversation itself.

    Every open page polls this every 12 s, so it reads no conversation at all: it used to return the
    latest conversation with every turn, 1–2 MB per call even gzipped, which made it 91% of the traffic
    through the 3 Mbps public entry and kept reading the turns column from the database.
    """
    active_runs = await ask_runs.active_for_user(_user.id)
    if not active_runs:
        return {"id": None, "active_run": False}
    run = active_runs[0].summary()
    return {
        "id": str(active_runs[0].conversation_id),
        "title": run.get("title") or "",
        "device_id": run.get("device_name"),
        "execution_mode": run.get("execution_mode") or "ai",
        "active_run": True,
    }


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

    if_none_match = request.headers.get("if-none-match", "").strip() if request else ""
    client_tag = if_none_match.strip().strip('"') if if_none_match else ""

    # Fast ETag evaluation path: avoid de-TOASTing megabytes of turns JSON on conditional polls (HTTP 304)
    if client_tag:
        conv = (
            await db.execute(
                select(AskConversation)
                .options(defer(AskConversation.turns))
                .where(cond)
            )
        ).scalars().first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")

        conv_id_str = str(conv.id)
        updated_at_iso = conv.updated_at.isoformat() if conv.updated_at else None
        created_at_iso = conv.created_at.isoformat() if conv.created_at else None
        cfg = conv.config or {}
        conv_dev = conv.device_id or cfg.get("device_id")
        total_turns = conv.message_count

        etag_seed = f"v4:{conv_id_str}:{updated_at_iso or ''}:{total_turns}:{limit}:{conv_dev or ''}"
        etag = f'"{hashlib.sha1(etag_seed.encode("utf-8")).hexdigest()}"'
        server_tag = etag.strip('"')

        if client_tag == server_tag:
            return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, no-cache"})

        # ETag changed: load turns on the existing instance
        await db.refresh(conv, ["turns"])
    else:
        # First load / uncached: load full conversation directly
        conv = (await db.execute(select(AskConversation).where(cond))).scalars().first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")

    cfg, inferred = infer_conversation_config(conv)
    recovered_turns = await recover_orphaned_tasks_for_conv(db, conv, cfg)
    resolved_dev = await resolve_concrete_device_for_conv(db, conv, cfg, inferred)

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
    if total_turns != conv.message_count:
        conv.message_count = total_turns
        need_commit = True
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
            updated_at_iso = conv.updated_at.isoformat()
            etag_seed = f"v4:{conv_id_str}:{updated_at_iso or ''}:{total_turns}:{limit}:{conv_dev or ''}"
            etag = f'"{hashlib.sha1(etag_seed.encode("utf-8")).hexdigest()}"'
        except Exception as e:
            logger.warning("Failed to persist inferred conversation config: %s", e)
    else:
        created_at_iso = conv.created_at.isoformat() if conv.created_at else None
        updated_at_iso = conv.updated_at.isoformat() if conv.updated_at else None
        etag_seed = f"v4:{conv_id_str}:{updated_at_iso or ''}:{total_turns}:{limit}:{conv_dev or ''}"
        etag = f'"{hashlib.sha1(etag_seed.encode("utf-8")).hexdigest()}"'

    if limit > 0 and len(raw_turns) > limit:
        offset = len(raw_turns) - limit
        sliced_raw = raw_turns[-limit:]
        has_more = True
    else:
        offset = 0
        sliced_raw = raw_turns
        has_more = False
    conv_turns = sanitize_turns_for_response(sliced_raw, fallback_iso=updated_at_iso or created_at_iso, start_index=offset)

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "private, no-cache"

    proj_id_val = cfg.get("project_id", "")
    proj_title_val = await lookup_project_title(db, proj_id_val)

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
    conv_id, conv_title, cfg = await get_or_create_conversation(
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
        cfg_final, inferred = infer_conversation_config(conv)
        resolved_dev = await resolve_concrete_device_for_conv(session, conv, cfg_final, inferred)
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
        proj_title_final = await lookup_project_title(session, proj_id_final)
        fb_iso = (conv.updated_at or conv.created_at).isoformat() if (conv.updated_at or conv.created_at) else None
        return {
            "id": str(conv.id),
            "title": conv.title,
            "turns": sanitize_turns_for_response(list(conv.turns or []), fallback_iso=fb_iso),
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
    conv = (await db.execute(select(AskConversation).options(defer(AskConversation.turns)).where(cond))).scalars().first()
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
    await cache_delete_prefix(f"ask_conv_list:{_user.id}")
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
    res = await db.execute(delete(AskConversation).where(cond))
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="Conversation not found")

    await db.commit()
    await cache_delete_prefix(f"ask_conv_list:{_user.id}")
    return {"ok": True}
