"""Conversation endpoints under /api/ask: list, get, restore, rename, delete.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from datetime import datetime, timezone


from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User, AskConversation, Project, Machine, Document, ConversationMessage
from ..db.session import get_db, async_session_factory
from ..middleware.auth import get_current_user
from ..services.cache import cache_get, cache_set
from ..services.storage_service import media_url_epoch
from ..services.user_filter import find_machine_by_id_or_hash
from ..services.ask_runs import ask_runs
from ..services.ask_store import (
    bust_conv_list, get_or_create_conversation, infer_conversation_config, lookup_project_title,
    recover_orphaned_tasks_for_conv, resolve_concrete_device_for_conv, sanitize_turns_for_response,
    slice_turns, tail_turns, turn_count,
)

logger = logging.getLogger("server.ask")

router = APIRouter()

@router.get("/conversations")
async def list_conversations(
    device_id: str | None = None,
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """List recent Ask conversations for the current user."""
    cache_key = f"ask_conv_list:{_user.id}:{device_id or 'all'}:{limit}:{offset}"
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
        .limit(limit)
        .offset(offset)
    )
    res = await db.execute(query)
    rows = res.all()
    from ..services.ingest_service import _clean_source_path, _is_invalid_project_name, _is_junk_or_uuid_title

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

    # 2. 批量预查项目与设备元数据，构建 O(1) 内存字典映射，消除 N+1 查询
    proj_rows = (await db.execute(select(Project))).scalars().all()
    proj_id_map: dict[str, str] = {}
    proj_slug_map: dict[str, str] = {}
    proj_slug_to_id: dict[str, str] = {}
    proj_path_map: dict[str, tuple[str, str]] = {}
    for p in proj_rows:
        pid_str = str(p.id)
        title = p.title or p.slug or ""
        proj_id_map[pid_str] = title
        if p.slug:
            slug_lower = p.slug.lower()
            proj_slug_map[slug_lower] = title
            proj_slug_to_id[slug_lower] = pid_str
        if p.source_path:
            cleaned_p = _clean_source_path(p.source_path)
            if cleaned_p:
                proj_path_map[cleaned_p.lower()] = (pid_str, title)

    mach_rows = (await db.execute(select(Machine))).scalars().all()
    mach_by_id = {m.id: m for m in mach_rows}
    mach_map: dict[str, str] = {}
    for m in mach_rows:
        target = m
        seen_merge = set()
        while target.merged_into and target.merged_into in mach_by_id and target.id not in seen_merge:
            seen_merge.add(target.id)
            target = mach_by_id[target.merged_into]
        clean_name = re.sub(r"\.local$", "", re.sub(r"\s*\([^)]*\)\s*$", "", target.name or ""), flags=re.IGNORECASE).strip()
        disp_name = clean_name or target.name or ""
        if disp_name:
            if m.collector_token_hash:
                mach_map[m.collector_token_hash] = disp_name
            mach_map[str(m.id)] = disp_name
            if m.name:
                mach_map[m.name] = disp_name
                mach_map[clean_name] = disp_name

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
                    # A saved "" is a choice: a new session, or one gone from its device
                    if sid and cfg.get("session_id") is None:
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

        # 解析 project_title 与 project_id
        pid_raw = str(cfg.get("project_id") or "").strip()
        p_title: str | None = None
        resolved_pid: str | None = pid_raw or None

        if pid_raw:
            if pid_raw in proj_id_map:
                p_title = proj_id_map[pid_raw]
            elif pid_raw.lower() in proj_slug_map:
                p_title = proj_slug_map[pid_raw.lower()]
                resolved_pid = proj_slug_to_id.get(pid_raw.lower(), pid_raw)

        if not p_title and r.cwd:
            cleaned_cwd = _clean_source_path(r.cwd)
            if cleaned_cwd:
                cleaned_lower = cleaned_cwd.lower()
                best_match = None
                best_len = 0
                for p_path, (p_id, p_tit) in proj_path_map.items():
                    if cleaned_lower == p_path or cleaned_lower.startswith(p_path + "/"):
                        if len(p_path) > best_len:
                            best_match = (p_id, p_tit)
                            best_len = len(p_path)
                if best_match:
                    p_title = best_match[1]
                    if not resolved_pid:
                        resolved_pid = best_match[0]
                else:
                    cand_name = cleaned_cwd.replace("\\", "/").rstrip("/").split("/")[-1]
                    if cand_name:
                        if cand_name.lower() in proj_slug_map:
                            p_title = proj_slug_map[cand_name.lower()]
                            if not resolved_pid:
                                resolved_pid = proj_slug_to_id.get(cand_name.lower())
                        elif not _is_invalid_project_name(cand_name):
                            p_title = cand_name

        # 解析 device_name 友好名
        dev_friendly_name: str | None = None
        raw_dev = r.device_id or cfg.get("device_id")
        if raw_dev and raw_dev not in ("auto", "ask_only", "all"):
            if raw_dev in mach_map:
                dev_friendly_name = mach_map[raw_dev]
            elif cfg.get("device_name") and cfg.get("device_name") not in ("memento-", "memento"):
                dev_friendly_name = cfg["device_name"]
            elif raw_dev.startswith("memento-"):
                clipped = raw_dev.replace("memento-", "")[:8]
                if clipped and clipped not in ("memento-", "memento"):
                    dev_friendly_name = clipped
            else:
                dev_friendly_name = raw_dev

        if dev_friendly_name in ("memento-", "memento", ""):
            dev_friendly_name = None

        out_items.append({
            "id": str(r.id),
            "title": display_title,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            "device_id": r.device_id,
            "device_name": dev_friendly_name,
            "project_id": resolved_pid,
            "project_title": p_title,
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

    # Writers drop it (bust_conv_list); the TTL only bounds one that doesn't
    await cache_set(cache_key, out_items, ttl_seconds=60)
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


def _conv_etag(conv_id: str, updated_at_iso: str | None, total_turns: int, limit: int, before: int | None, device: str | None) -> str:
    page = f"{limit}" if before is None else f"{limit}:{before}"
    # The week's image signatures are in the body: a new week is a new body
    seed = f"v5:{conv_id}:{updated_at_iso or ''}:{total_turns}:{page}:{device or ''}:{media_url_epoch()}"
    return f'"{hashlib.sha1(seed.encode("utf-8")).hexdigest()}"'


@router.get("/conversations/{conv_id}")
async def get_conversation(
    conv_id: str,
    request: Request,
    response: Response,
    limit: int = 0,
    before: int | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Get conversation history with runtime configuration and optional recent turn limiting or cursor pagination."""
    try:
        cid = uuid.UUID(conv_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")

    cond = (AskConversation.id == cid) & (
        (AskConversation.user_id == _user.id) | (AskConversation.user_id.is_(None))
    )

    if_none_match = request.headers.get("if-none-match", "").strip() if request else ""
    client_tag = if_none_match.strip().strip('"') if if_none_match else ""

    # Fast metadata load: avoid de-TOASTing megabytes of turns JSON on initial fetch and conditional polls
    conv = (
        await db.execute(
            select(AskConversation)
            .options(defer(AskConversation.turns))
            .where(cond)
        )
    ).scalars().first()
    if not conv:
        # Graceful fallback: check if cid corresponds to a Document with category="conversation"
        doc = (
            await db.execute(
                select(Document)
                .options(
                    defer(Document.content),
                    defer(Document.content_tsv),
                    defer(Document.rendered_html),
                )
                .where(Document.id == cid, Document.category == "conversation")
            )
        ).scalars().first()
        if doc:
            msg_rows = (
                await db.execute(
                    select(ConversationMessage.role, ConversationMessage.content, ConversationMessage.timestamp)
                    .where(ConversationMessage.document_id == doc.id)
                    .order_by(ConversationMessage.line_number.asc())
                )
            ).all()
            init_turns = []
            for role, content, ts in msg_rows:
                init_turns.append({
                    "role": role or "user",
                    "content": content or "",
                    "toolCalls": [],
                    "created_at": ts.isoformat() if ts else datetime.now(timezone.utc).isoformat(),
                })
            doc_meta = dict(doc.metadata_ or {})
            conv_dev = None
            if doc.machine_id:
                try:
                    doc_mach = await db.get(Machine, doc.machine_id)
                    if doc_mach:
                        conv_dev = doc_mach.collector_token_hash or doc_mach.name
                except Exception:
                    pass
            if not conv_dev:
                conv_dev = doc_meta.get("device_id")

            conv_cfg = {
                "compact_mode": False,
                "session_id": doc_meta.get("session_id") or doc_meta.get("cascade_id") or str(cid),
                "device_id": conv_dev or "",
                "project_id": str(doc.project_id) if doc.project_id else "",
                "execution_mode": doc.tool_id or "ai",
                "cwd": doc_meta.get("cwd") or doc_meta.get("working_directory") or "",
                "_materialized_from_doc": True,
            }
            conv = AskConversation(
                id=cid,
                user_id=_user.id,
                title=doc.title or "历史会话",
                turns=init_turns,
                message_count=len(init_turns),
                device_id=conv_dev,
                cwd=conv_cfg["cwd"] or None,
                config=conv_cfg,
            )
            db.add(conv)
            try:
                await db.commit()
                await db.refresh(conv, ["updated_at", "created_at"])
            except Exception as e:
                logger.warning("Failed to commit materialized AskConversation for doc %s: %s", cid, e)
                try:
                    await db.rollback()
                except Exception:
                    pass
            now_utc = datetime.now(timezone.utc)
            if not conv.created_at:
                conv.created_at = now_utc
            if not conv.updated_at:
                conv.updated_at = now_utc
        else:
            raise HTTPException(status_code=404, detail="Conversation not found")

    conv_id_str = str(conv.id)
    updated_at_iso = conv.updated_at.isoformat() if conv.updated_at else None
    created_at_iso = conv.created_at.isoformat() if conv.created_at else None
    cfg = conv.config or {}
    conv_dev = conv.device_id or cfg.get("device_id")
    total_turns = conv.message_count

    etag = _conv_etag(conv_id_str, updated_at_iso, total_turns, limit, before, conv_dev)
    server_tag = etag.strip('"')

    if client_tag and client_tag == server_tag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, no-cache"})

    # Read only the page asked for, sliced inside Postgres: the last `limit` turns, or with `before`
    # the `limit` (default 40) turns ahead of that index, for scrolling up
    # true_count: the real number of turns when this read tells it, to fix a stale message_count
    true_count: int | None = None
    if before is not None and before >= 0:
        page = limit if limit > 0 else 40
        offset = max(0, before - page)
        raw_turns = await slice_turns(db, cid, offset, before)
        has_more = offset > 0
    elif limit > 0:
        raw_turns = await tail_turns(db, cid, limit)
        if not raw_turns and conv.turns:
            raw_turns = list(conv.turns)[-limit:]
        if len(raw_turns) < limit:
            true_count = len(raw_turns)  # the page is the whole conversation
        elif total_turns < len(raw_turns):
            true_count = await turn_count(db, cid)
        if true_count is not None:
            total_turns = true_count
        offset = max(0, total_turns - len(raw_turns))
        has_more = offset > 0
    else:
        if conv.turns is not None:
            raw_turns = list(conv.turns or [])
        else:
            try:
                await db.refresh(conv, ["turns"])
            except Exception:
                pass
            raw_turns = list(conv.turns or [])
        true_count = total_turns = len(raw_turns)
        offset, has_more = 0, False

    cfg, inferred = infer_conversation_config(conv, sample_turns=raw_turns)
    if before is None:
        recovered_turns = await recover_orphaned_tasks_for_conv(db, conv, cfg, sample_turns=raw_turns)
        if recovered_turns is not None:
            added = len(recovered_turns) - len(raw_turns)
            total_turns += added
            if true_count is not None:
                true_count += added
            raw_turns = recovered_turns
            # Appended in SQL; the row's updated_at moved past what this instance holds
            await db.refresh(conv, ["updated_at", "message_count"])

    resolved_dev = await resolve_concrete_device_for_conv(db, conv, cfg, inferred)

    # Extract all model attributes into locals BEFORE any db.commit() to prevent
    # asyncpg MissingGreenlet errors triggered by expired attribute access.
    conv_id_str = str(conv.id)
    conv_title = conv.title

    conv_dev = resolved_dev or conv.device_id or cfg.get("device_id")
    conv_cwd = conv.cwd or cfg.get("cwd")

    if resolved_dev and resolved_dev not in ("auto", "ask_only", "all"):
        cfg["device_id"] = resolved_dev

    need_commit = False
    if true_count is not None and true_count != conv.message_count:
        conv.message_count = true_count
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

    # Read before the commit below; both branches need them (a missing created_at_iso was a 500)
    created_at_iso = conv.created_at.isoformat() if conv.created_at else None
    updated_at_iso = conv.updated_at.isoformat() if conv.updated_at else None
    if need_commit:
        now_utc = datetime.now(timezone.utc)
        conv.updated_at = now_utc
        try:
            await db.commit()
            updated_at_iso = now_utc.isoformat()
            await bust_conv_list(_user.id)
        except Exception as e:
            logger.warning("Failed to persist inferred conversation config: %s", e)
    # From what the row holds now, so the next poll's 304 check above matches
    etag = _conv_etag(conv_id_str, updated_at_iso, total_turns, limit, before, conv_dev)

    conv_turns = sanitize_turns_for_response(raw_turns, fallback_iso=updated_at_iso or created_at_iso, start_index=offset)

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "private, no-cache"

    proj_id_val = cfg.get("project_id", "")
    proj_title_val = await lookup_project_title(db, proj_id_val)

    dev_name_val = None
    if conv_dev and conv_dev not in ("auto", "ask_only", "all"):
        if cfg.get("device_name") and cfg.get("device_name") not in ("memento-", "memento"):
            dev_name_val = cfg["device_name"]
        elif conv_dev.startswith("memento-"):
            clipped = conv_dev.replace("memento-", "")[:8]
            if clipped and clipped not in ("memento-", "memento"):
                dev_name_val = clipped
        else:
            dev_name_val = conv_dev
    if dev_name_val in ("memento-", "memento", ""):
        dev_name_val = None

    return {
        "id": conv_id_str,
        "title": conv_title,
        "turns": conv_turns,
        "total_turns": total_turns,
        "has_more": has_more,
        "offset": offset,
        "device_id": conv_dev,
        "device_name": dev_name_val,
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
    await bust_conv_list(_user.id)
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
    await bust_conv_list(_user.id)
    return {"ok": True}
