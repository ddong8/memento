"""Projects API — browse projects and their documents."""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
import traceback
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import func, inspect as sa_inspect, or_, select, update
from sqlalchemy.orm import defer, load_only
from sqlalchemy.ext.asyncio import AsyncSession

from ..services import cache
from ..services.cache import cache_delete_prefix, cache_get, cache_set

from ..db.models import (
    ConversationMessage, Document, KnowledgeEntity, KnowledgeObservation,
    KnowledgeRelation, Machine, Project, Tool, User,
)
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.conversation_parser import parse_conversation
from ..services.user_filter import user_machine_ids, apply_user_filter, find_machine_by_id_or_hash
from ..services.project_placement import (
    DeviceRef, Placement, device_index, discovered_for, discovered_projects, is_junk_project,
    pick_project_path, project_devices, project_placements,
)
from ..services.ingest_service import (
    _clean_source_path, _is_junk_or_uuid_title, _title_from_user_messages,
    _prettify_project_name, _is_invalid_project_name, ensure_project,
    _IGNORE_PROJECT_NAMES,
)

router = APIRouter(prefix="/api/projects", tags=["projects"])


_last_consolidation_time: float = 0.0
_CONSOLIDATION_INTERVAL_SECONDS: float = 600.0  # 10 minutes
_consolidation_lock = asyncio.Lock()


async def _consolidate_projects_if_needed(db: AsyncSession, force: bool = False) -> None:
    """Consolidate fragmented projects, deduplicate variants, and heal orphaned docs.
    Throttled to run at most once every 10 minutes to avoid locking tables on every read request.
    """
    global _last_consolidation_time
    now = time.time()
    if not force and (now - _last_consolidation_time < _CONSOLIDATION_INTERVAL_SECONDS):
        return
    if _consolidation_lock.locked():
        return
    async with _consolidation_lock:
        if not force and (time.time() - _last_consolidation_time < _CONSOLIDATION_INTERVAL_SECONDS):
            return
        _last_consolidation_time = time.time()
        try:
            all_projects = (await db.execute(select(Project))).scalars().all()
            has_changes = False
            for p in all_projects:
                raw_name = p.slug.split("/")[-1] if "/" in p.slug else p.slug
                if (
                    _is_invalid_project_name(raw_name)
                    or _is_invalid_project_name(p.title)
                    or p.title in _IGNORE_PROJECT_NAMES
                    or p.title.strip("-_./\\\"'` ") == ""
                    or raw_name.strip("-_./\\\"'` ") == ""
                ):
                    # Unassign orphaned documents
                    await db.execute(
                        update(Document).where(Document.project_id == p.id).values(project_id=None)
                    )
                    await db.delete(p)
                    has_changes = True
                    continue

                clean_name = raw_name.strip("-\"'` ")
                prettified = _prettify_project_name(clean_name).strip("-\"'` ")
                clean_title = (p.title or "").strip("-\"'` ")
                is_dirty = (
                    prettified != raw_name
                    or p.title != clean_title
                    or '"' in (p.title or "")
                    or "'" in (p.title or "")
                    or '"' in p.slug
                    or "'" in p.slug
                )
                if is_dirty and not _is_invalid_project_name(prettified):
                    canonical_slug = f"{p.tool_id}/{prettified}"
                    canonical = (await db.execute(select(Project).where(Project.slug == canonical_slug))).scalar_one_or_none()
                    if canonical and canonical.id != p.id:
                        await db.execute(
                            update(Document).where(Document.project_id == p.id).values(project_id=canonical.id)
                        )
                        await db.delete(p)
                        has_changes = True
                    else:
                        p.slug = canonical_slug
                        p.title = prettified
                        has_changes = True

            # Deduplicate hyphen vs underscore equivalent projects (e.g. favorite_chat vs favorite-chat)
            all_cur_projs = (await db.execute(select(Project))).scalars().all()
            proj_by_equiv: dict[tuple[str, str], list[Project]] = {}
            for p in all_cur_projs:
                equiv_key = (p.tool_id, p.slug.split("/")[-1].replace("-", "_").lower())
                proj_by_equiv.setdefault(equiv_key, []).append(p)
            for equiv_key, plist in proj_by_equiv.items():
                if len(plist) > 1:
                    # Count docs for each project to pick canonical
                    p_counts = []
                    for p_item in plist:
                        cnt = (await db.execute(select(func.count(Document.id)).where(Document.project_id == p_item.id))).scalar() or 0
                        p_counts.append((cnt, p_item))
                    p_counts.sort(key=lambda x: x[0], reverse=True)
                    canonical_p = p_counts[0][1]
                    for cnt, redundant_p in p_counts[1:]:
                        await db.execute(
                            update(Document).where(Document.project_id == redundant_p.id).values(project_id=canonical_p.id)
                        )
                        await db.delete(redundant_p)
                        has_changes = True

            # Auto-adopt orphaned documents across all tools (query only necessary columns)
            orphaned_docs = (await db.execute(
                select(Document.id, Document.tool_id, Document.metadata_, Document.relative_path).where(
                    Document.project_id.is_(None),
                    Document.category == "conversation",
                )
            )).all()
            for od_id, od_tool_id, od_metadata, od_rel_path in orphaned_docs:
                p_cand = None
                if isinstance(od_metadata, dict):
                    p_cand = od_metadata.get("project_hash")
                if not p_cand and od_rel_path and od_rel_path.startswith("projects/"):
                    parts = od_rel_path.split("/")
                    if len(parts) >= 3:
                        p_cand = parts[1]
                if p_cand:
                    prettified = _prettify_project_name(p_cand)
                    if not _is_invalid_project_name(prettified):
                        c_slug = f"{od_tool_id}/{prettified}"
                        canon = (await db.execute(select(Project).where(Project.slug == c_slug))).scalar_one_or_none()
                        if canon:
                            await db.execute(
                                update(Document).where(Document.id == od_id).values(project_id=canon.id)
                            )
                            has_changes = True

            # Auto-heal misassigned conversation documents (fetch only scalar IDs & metadata, never content)
            misassigned_docs = (await db.execute(
                select(
                    Document.id,
                    Document.tool_id,
                    Document.metadata_,
                    Document.project_id,
                    Project.id,
                    Project.slug,
                    Project.title,
                )
                .join(Project, Document.project_id == Project.id)
                .where(
                    Document.category == "conversation",
                    Document.metadata_.isnot(None),
                )
            )).all()
            for doc_id, doc_tool_id, doc_metadata, doc_proj_id, cur_proj_id, cur_proj_slug, cur_proj_title in misassigned_docs:
                if not isinstance(doc_metadata, dict):
                    continue
                p_cand = doc_metadata.get("project_hash")
                if not p_cand:
                    p_path = doc_metadata.get("project_path")
                    if p_path and isinstance(p_path, str):
                        p_cand = p_path.replace("\\", "/").rstrip("/").split("/")[-1]
                if not p_cand:
                    continue
                prettified = _prettify_project_name(str(p_cand)).strip("-\"'` ")
                if not prettified or _is_invalid_project_name(prettified):
                    continue
                cur_slug_name = cur_proj_slug.split("/")[-1].lower()
                cand_lower = prettified.lower()
                if cand_lower != cur_proj_title.lower() and cand_lower != cur_slug_name:
                    correct_slug = f"{doc_tool_id}/{prettified}"
                    correct_p = (await db.execute(select(Project).where(Project.slug == correct_slug))).scalar_one_or_none()
                    if correct_p and correct_p.id != cur_proj_id:
                        await db.execute(
                            update(Document).where(Document.id == doc_id).values(project_id=correct_p.id)
                        )
                        has_changes = True

            # Auto-heal machine_id on documents where machine_id is NULL
            all_machines = (await db.execute(select(Machine))).scalars().all()
            mac_mini_m = next((m for m in all_machines if "mac-mini" in (m.name or "").lower() or "mini" in (m.name or "").lower()), None)
            macbook_m = next((m for m in all_machines if "macbook" in (m.name or "").lower()), None)
            win_m = next((m for m in all_machines if "windows" in (m.name or "").lower()), None)

            if mac_mini_m:
                await db.execute(
                    update(Document)
                    .where(
                        Document.machine_id.is_(None),
                        or_(
                            Document.relative_path.ilike("%haixingdong%"),
                            Document.metadata_["project_path"].astext.ilike("%haixingdong%"),
                        ),
                    )
                    .values(machine_id=mac_mini_m.id)
                )
                has_changes = True
            if macbook_m:
                await db.execute(
                    update(Document)
                    .where(
                        Document.machine_id.is_(None),
                        or_(
                            Document.relative_path.ilike("%donghaixing%"),
                            Document.metadata_["project_path"].astext.ilike("%donghaixing%"),
                        ),
                    )
                    .values(machine_id=macbook_m.id)
                )
                has_changes = True
            if win_m:
                await db.execute(
                    update(Document)
                    .where(
                        Document.machine_id.is_(None),
                        or_(
                            Document.relative_path.ilike("%users-admin%"),
                            Document.metadata_["project_path"].astext.ilike("%users/admin%"),
                            Document.metadata_["project_path"].astext.ilike("%d:/%"),
                            Document.metadata_["project_path"].astext.ilike("%c:/%"),
                        ),
                    )
                    .values(machine_id=win_m.id)
                )
                has_changes = True

            if has_changes:
                await db.commit()
        except Exception as exc:
            print(f"[Projects API] Consolidation error: {exc}\n{traceback.format_exc()}")


async def _bust_project_cache(project_id: uuid.UUID | None = None, user_id: uuid.UUID | None = None) -> None:
    try:
        if user_id:
            await cache.cache_delete_prefix(f"projects:list:{user_id}:")
        else:
            await cache.cache_delete_prefix("projects:list:")
        if project_id:
            await cache.cache_delete_prefix("project:timeline:")
            await cache.cache_delete_prefix("project:conv:")
            await cache.cache_delete_prefix("project:blueprint:")
    except Exception:
        pass


def _loaded_iso(obj, attr: str) -> str | None:
    """ISO time of a column, or None when it isn't loaded (a just-flushed row's server defaults)."""
    if attr in sa_inspect(obj).unloaded:
        return None
    value = getattr(obj, attr)
    return value.isoformat() if value else None


def _device_doc_scope(target_machine: Machine | None, mids: list[uuid.UUID] | None):
    """The documents that count for the device picked (None: no restriction)."""
    if target_machine is None:
        return Document.machine_id.in_(mids) if mids is not None else None
    target_mid = target_machine.id
    name = (target_machine.name or "").lower()
    project_path = Document.metadata_["project_path"].astext
    if "mac-mini" in name:
        return (
            (Document.machine_id == target_mid)
            | Document.relative_path.ilike("%haixingdong%")
            | project_path.ilike("%haixingdong%")
        )
    if "macbook" in name:
        return (
            (Document.machine_id == target_mid)
            | Document.relative_path.ilike("%donghaixing%")
            | project_path.ilike("%donghaixing%")
        )
    if any(k in name for k in ("windows", "desktop-", "laptop-", "win-", "admin")):
        return (
            (Document.machine_id == target_mid)
            | project_path.ilike("%d:/%")
            | project_path.ilike("%c:/%")
            | Document.relative_path.ilike("%users-admin%")
        )
    return Document.machine_id == target_mid


@router.get("")
async def list_projects(
    tool_id: str | None = None,
    device_id: str | None = None,
    sync: bool = False,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """Projects for the ask composer, each with the folder on the devices it lives on.

    With ``device_id``: that device's projects, ``source_path`` being the folder
    on that device (empty when unknown, never another machine's folder).
    Without: every project, ``devices`` listing where each one lives, most
    recently active first.
    """
    cache_key = f"projects:list:v2:{_user.id}:{tool_id or 'all'}:{device_id or 'all'}"
    if not sync:
        cached = await cache_get(cache_key)
        if cached is not None:
            return cached

    mids = await user_machine_ids(db, _user)

    target_machine: Machine | None = None
    if device_id and device_id not in ("auto", "ask_only", "all"):
        target_machine = await find_machine_by_id_or_hash(db, device_id, _user)
        if not target_machine:
            return []

    # Auto-consolidate fragmented projects (throttled to at most once per 10m to keep reads fast)
    await _consolidate_projects_if_needed(db, force=sync)

    scope = _device_doc_scope(target_machine, mids)
    doc_count_col = func.count(Document.id).label("doc_count")
    join_cond = Document.project_id == Project.id
    if scope is not None:
        join_cond = join_cond & scope
    query = (
        select(Project, doc_count_col)
        .outerjoin(Document, join_cond)
        .where(
            ~Project.title.in_(list(_IGNORE_PROJECT_NAMES)),
            ~Project.slug.like("%/file:"),
            ~Project.slug.like("%/file"),
        )
        .group_by(Project.id)
        .order_by(Project.updated_at.desc())
        # Exclude empty projects with zero docs from project selector
        .having(doc_count_col > 0)
    )
    if tool_id:
        query = query.where(Project.tool_id == tool_id)
    rows = (await db.execute(query)).all()

    index = await device_index(db, _user)
    placements = await project_placements(db, [p.id for p, _ in rows], scope)
    discovered = await discovered_projects(db, target_machine, mids, tool_id)
    target_ref = (
        DeviceRef(target_machine.collector_token_hash or str(target_machine.id), target_machine.name)
        if target_machine is not None else None
    )

    def entry(p: Project, path: str, count: int, devices: list[dict]) -> dict:
        return {
            "id": str(p.id),
            "slug": p.slug,
            "title": p.title,
            "tool_id": p.tool_id,
            "source_path": path,
            "visibility": p.visibility,
            "document_count": count,
            "created_at": _loaded_iso(p, "created_at"),
            "updated_at": _loaded_iso(p, "updated_at"),
            "devices": devices,
        }

    items = []
    for p, count in rows:
        found = discovered_for(p.slug, discovered)
        if target_ref is not None:
            pls = placements.get(p.id, [])
            path = pick_project_path(pls, p.slug, p.title) or next(
                (c for c in (_clean_source_path(d.path) for d in found) if c and not is_junk_project(None, c)), ""
            )
            last = max((pl.last_active for pl in pls if pl.last_active), default=None)
            devices = [{
                "device_id": target_ref.device_id,
                "name": target_ref.name,
                "source_path": path,
                "document_count": count or 0,
                "last_active": last.isoformat() if last else None,
            }]
        else:
            devices = project_devices(p.slug, p.title, placements.get(p.id, []), found, index)
            path = next((d["source_path"] for d in devices if d["source_path"]), "") or _clean_source_path(p.source_path) or ""
        if is_junk_project(p.title, path or p.source_path):
            continue
        items.append(entry(p, path, count or 0, devices))

    # Projects a device reported but has no synced documents for yet
    existing_slugs = {item["slug"] for item in items}
    new_projs_created = False
    for d in discovered:
        c_slug = f"{d.tool_id}/{d.name}"
        if c_slug in existing_slugs:
            continue
        c_path = _clean_source_path(d.path) or ""
        if is_junk_project(d.name, c_path):
            continue
        existing_slugs.add(c_slug)
        found = discovered_for(c_slug, discovered)
        try:
            proj_obj = await ensure_project(db, d.tool_id, d.name, source_path=d.path)
            new_projs_created = True
        except Exception as exc:
            print(f"[Projects API] Discovery project error: {exc}\n{traceback.format_exc()}")
            continue
        if target_ref is not None:
            devices = [{"device_id": target_ref.device_id, "name": target_ref.name, "source_path": c_path, "document_count": 0, "last_active": None}]
            path = c_path
        else:
            devices = project_devices(c_slug, proj_obj.title, [], found, index)
            path = next((x["source_path"] for x in devices if x["source_path"]), "") or c_path
        items.append(entry(proj_obj, path, 0, devices))

    if new_projs_created:
        try:
            await db.commit()
        except Exception:
            pass

    if not sync:
        await cache_set(cache_key, items, ttl_seconds=20)

    return items


@router.get("/{project_id}")
async def get_project(
    project_id: uuid.UUID,
    include_content: bool = Query(
        False,
        description="If true, inline full content for curated categories "
                    "(identity/memory/plan/learning/note). Conversation docs "
                    "stay metadata-only to keep payloads sane.",
    ),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    mids = await user_machine_ids(db, _user)

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404)

    docs_q = (
        select(Document)
        .options(defer(Document.content_tsv), defer(Document.metadata_), defer(Document.rendered_html))
        .where(Document.project_id == project_id)
        .order_by(Document.synced_at.desc())
        .limit(50)
    )
    if not include_content:
        docs_q = docs_q.options(defer(Document.content))
    docs_q = apply_user_filter(docs_q, mids, Document.machine_id)
    docs_result = await db.execute(docs_q)
    docs = docs_result.scalars().all()

    # Categories whose content is small + curated + worth inlining so a
    # single fetch is enough for an AI to "know the project". Conversation
    # docs are deliberately excluded — they can be MBs and the caller can
    # always paginate via memory_conversation(doc_id).
    INLINE_CATEGORIES = {"identity", "memory", "plan", "learning", "note"}

    def _doc_row(d: Document) -> dict:
        row = {
            "id": str(d.id),
            "relative_path": d.relative_path,
            "category": d.category,
            "title": d.title,
            "file_size_bytes": d.file_size_bytes,
            "synced_at": d.synced_at.isoformat() if d.synced_at else None,
        }
        if include_content and d.category in INLINE_CATEGORIES:
            row["content"] = d.content
            if d.ai_summary:
                row["ai_summary"] = d.ai_summary
        return row

    return {
        "id": str(project.id),
        "slug": project.slug,
        "title": project.title,
        "tool_id": project.tool_id,
        "source_path": _clean_source_path(project.source_path),
        "visibility": project.visibility,
        "documents": [_doc_row(d) for d in docs],
    }


@router.patch("/{project_id}")
async def update_project(
    project_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404)

    if "source_path" in body:
        clean = _clean_source_path(body["source_path"])
        if clean:
            project.source_path = clean
    if "title" in body:
        new_title = str(body["title"]).strip()
        if new_title:
            project.title = new_title

    await db.commit()
    await _bust_project_cache(project_id, _user.id)
    await db.refresh(project)
    return {
        "id": str(project.id),
        "slug": project.slug,
        "title": project.title,
        "source_path": project.source_path,
    }



@router.get("/{project_id}/timeline")
async def get_project_timeline(
    project_id: uuid.UUID,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    category: str | None = None,
    order: str = Query("desc", pattern="^(asc|desc)$"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Return a session-grouped timeline for a project.

    Groups documents by session_id (cascade_id), showing each session as a unit:
    - conversation with message preview
    - related brain artifacts (task.md, implementation_plan.md, walkthrough.md)
    Filters out .resolved versions and .metadata.json noise.
    """
    from ..services.cache import cache_get, cache_set
    cache_key = f"project:timeline:{_user.id}:{project_id}:{category or 'all'}:{offset}:{limit}:{order}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    mids = await user_machine_ids(db, _user)

    proj_result = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404)

    tool_map: dict[str, dict] = {}
    tools_result = await db.execute(select(Tool))
    for t in tools_result.scalars().all():
        tool_map[t.id] = {"display_name": t.display_name, "icon": t.icon}

    # Phase 1: lightweight scan — only metadata columns, NO content/rendered_html
    # content can be up to 1MB per doc; loading every doc's content is the main cost.
    meta_cols = (
        Document.id, Document.tool_id, Document.category, Document.content_type,
        Document.relative_path, Document.title, Document.file_size_bytes,
        Document.ai_summary, Document.metadata_,
        Document.source_modified_at, Document.synced_at, Document.machine_id,
    )
    q = (
        select(*meta_cols)
        .where(Document.project_id == project_id)
        .order_by(func.coalesce(Document.source_modified_at, Document.synced_at).desc())
    )
    if category:
        q = q.where(Document.category == category)
    q = apply_user_filter(q, mids, Document.machine_id)
    all_rows = (await db.execute(q)).all()

    # Group by session_id — build sessions (no content yet)
    sessions: dict[str, dict] = {}
    standalone: list[dict] = []

    for r in all_rows:
        d_id, d_tool_id, d_category, d_ctype, d_path, d_title, d_size, \
            d_ai_summary, d_meta, d_src_mod, d_synced, _d_mid = r
        # Skip noise files
        # `.meta.json` is the Claude Code subagent sidecar (just type +
        # description, no conversation content). `.metadata.json` and
        # `.resolved` are transient versions. All are noise on a timeline.
        if ".resolved" in d_path or ".meta.json" in d_path or ".metadata.json" in d_path:
            continue

        session_id = (d_meta or {}).get("session_id") or (d_meta or {}).get("cascade_id")
        ts = (d_src_mod or d_synced).isoformat()
        tool_info = tool_map.get(d_tool_id, {})

        if not session_id:
            event: dict = {
                "id": str(d_id),
                "type": d_category,
                "tool_id": d_tool_id,
                "tool_name": tool_info.get("display_name", d_tool_id),
                "title": d_title or d_path.split("/")[-1],
                "relative_path": d_path,
                "content_type": d_ctype,
                "timestamp": ts,
                "file_size_bytes": d_size,
                "ai_summary": d_ai_summary,
            }
            if d_category == "conversation":
                event["preview_messages"] = []
                event["message_count"] = 0
            standalone.append(event)
            continue

        if session_id not in sessions:
            sessions[session_id] = {
                "session_id": session_id,
                "type": "session",
                "tool_id": d_tool_id,
                "tool_name": tool_info.get("display_name", d_tool_id),
                "timestamp": ts,
                "conversation": None,
                "artifacts": [],
            }
        session = sessions[session_id]
        if ts > session["timestamp"]:
            session["timestamp"] = ts

        if d_category == "conversation":
            c_title = d_title
            if _is_junk_or_uuid_title(c_title, session_id):
                c_title = (d_meta or {}).get("title") or (d_meta or {}).get("ai_title") or ""
            if _is_junk_or_uuid_title(c_title, session_id):
                c_title = session_id[:8] if session_id else "会话"
            session["conversation"] = {
                "id": str(d_id),
                "title": c_title,
                "message_count": 0,
                "preview_messages": [],
                "file_size_bytes": d_size,
            }
        elif d_category == "plan":
            doc_type = d_path.split("/")[-1].split(".")[0]
            session["artifacts"].append({
                "id": str(d_id),
                "title": d_title or doc_type,
                "doc_type": doc_type,
                "content_preview": None,
                "file_size_bytes": d_size,
            })
        else:
            session["artifacts"].append({
                "id": str(d_id),
                "title": d_title or d_path.split("/")[-1],
                "doc_type": d_category,
                "content_preview": None,
                "file_size_bytes": d_size,
            })

    # Merge + sort + paginate BEFORE touching content
    all_events = list(sessions.values()) + standalone
    all_events.sort(key=lambda e: e.get("timestamp", ""), reverse=(order == "desc"))
    total = len(all_events)
    page = all_events[offset:offset + limit]

    # Set session title from conversation or first artifact
    for ev in page:
        if ev.get("type") == "session":
            if ev.get("conversation"):
                t = ev["conversation"]["title"]
                if t in ("transcript", "transcript.jsonl", None, ""):
                    t = ev["session_id"][:8]
                ev["title"] = t
            elif ev.get("artifacts"):
                ev["title"] = ev["artifacts"][0]["title"]
            else:
                ev["title"] = ev["session_id"][:8]

    # Phase 2: collect only doc_ids referenced on THIS page
    page_conv_ids: set = set()
    page_plan_ids: set = set()
    for ev in page:
        if ev.get("type") == "session":
            if ev.get("conversation"):
                page_conv_ids.add(uuid.UUID(ev["conversation"]["id"]))
            for a in ev.get("artifacts") or []:
                page_plan_ids.add(uuid.UUID(a["id"]))
        elif ev.get("type") == "conversation":
            page_conv_ids.add(uuid.UUID(ev["id"]))
        else:
            page_plan_ids.add(uuid.UUID(ev["id"]))

    # Message counts for paginated conversations — one GROUP BY query
    msg_counts: dict = {}
    if page_conv_ids:
        cnt_result = await db.execute(
            select(ConversationMessage.document_id, func.count())
            .where(ConversationMessage.document_id.in_(page_conv_ids))
            .where(ConversationMessage.role.in_(("user", "assistant")))
            .group_by(ConversationMessage.document_id)
        )
        msg_counts = {row[0]: row[1] for row in cnt_result.all()}

    # Preview messages — fetch first 4 user/assistant messages per conv doc via SQL window function
    previews: dict = {}
    if page_conv_ids:
        # Window function partitions by document_id and limits rn <= 4 in the database engine,
        # preventing transferring tens of thousands of messages across the network into Python memory.
        subq = (
            select(
                ConversationMessage.document_id,
                ConversationMessage.role,
                ConversationMessage.content,
                ConversationMessage.timestamp,
                ConversationMessage.line_number,
                func.row_number()
                .over(
                    partition_by=ConversationMessage.document_id,
                    order_by=ConversationMessage.line_number,
                )
                .label("rn"),
            )
            .where(ConversationMessage.document_id.in_(page_conv_ids))
            .where(ConversationMessage.role.in_(("user", "assistant")))
        ).subquery()

        msg_rows = await db.execute(
            select(
                subq.c.document_id,
                subq.c.role,
                subq.c.content,
                subq.c.timestamp,
                subq.c.line_number,
            )
            .where(subq.c.rn <= 4)
            .order_by(subq.c.document_id, subq.c.line_number)
        )
        for doc_id, role, content, ts_val, _ln in msg_rows.all():
            lst = previews.setdefault(doc_id, [])
            if len(lst) < 4:
                lst.append({
                    "role": role,
                    "content": (content or "")[:300],
                    "tool_name": "",
                    "timestamp": ts_val.isoformat() if ts_val else None,
                })

    # Plan/other content previews — fetch only content for page plan docs
    plan_previews: dict = {}
    if page_plan_ids:
        plan_rows = await db.execute(
            select(Document.id, Document.category, Document.content)
            .where(Document.id.in_(page_plan_ids))
        )
        for pid, pcat, pcontent in plan_rows.all():
            if pcontent:
                cap = 500 if pcat == "plan" else 300
                plan_previews[pid] = pcontent[:cap]

    # Stitch back onto page
    for ev in page:
        if ev.get("type") == "session":
            conv = ev.get("conversation")
            if conv:
                cid = uuid.UUID(conv["id"])
                conv["message_count"] = msg_counts.get(cid, 0)
                conv["preview_messages"] = previews.get(cid, [])
            for a in ev.get("artifacts") or []:
                a["content_preview"] = plan_previews.get(uuid.UUID(a["id"]))
        elif ev.get("type") == "conversation":
            cid = uuid.UUID(ev["id"])
            ev["message_count"] = msg_counts.get(cid, 0)
            ev["preview_messages"] = previews.get(cid, [])
        else:
            ev["content_preview"] = plan_previews.get(uuid.UUID(ev["id"]))

    payload = {
        "project": {
            "id": str(project.id),
            "slug": project.slug,
            "title": project.title,
            "tool_id": project.tool_id,
            "source_path": _clean_source_path(project.source_path),
        },
        "total": total,
        "offset": offset,
        "limit": limit,
        "events": page,
    }
    await cache_set(cache_key, payload, ttl_seconds=30)
    return payload


_last_reconcile_time: dict[uuid.UUID, float] = {}
_RECONCILE_COOLDOWN_SECONDS: float = 120.0


async def _reconcile_project_documents(
    db: AsyncSession,
    target_project: Project,
    target_mid: uuid.UUID | None = None,
    force: bool = False,
) -> int:
    """Auto-adopt and reconcile conversations belonging to this project.

    Catches documents that were:
      - left orphaned (doc.project_id IS NULL)
      - assigned to fragmented projects (e.g. claude_code/d-dev-2026-0707-pubchem or claude_code/d:)
      - misassigned during initial delta ingest
    Returns the number of adopted documents.
    """
    global _last_reconcile_time
    now = time.time()
    last_t = _last_reconcile_time.get(target_project.id, 0.0)
    if not force and (now - last_t < _RECONCILE_COOLDOWN_SECONDS):
        return 0
    _last_reconcile_time[target_project.id] = now
    try:
        tool_id = target_project.tool_id
        raw_slug_name = target_project.slug.split("/")[-1] if "/" in target_project.slug else target_project.slug
        clean_title = _prettify_project_name(target_project.title or raw_slug_name)
        if _is_invalid_project_name(clean_title):
            return 0

        # 1. Expand candidate aliases (hyphen and underscore variants)
        cand_titles = {
            clean_title,
            clean_title.replace("_", "-"),
            clean_title.replace("-", "_"),
        }
        cand_titles = {t for t in cand_titles if t and not _is_invalid_project_name(t)}

        frag_conditions = [
            Project.slug.in_([f"{tool_id}/d:", f"{tool_id}/c:", f"{tool_id}/d", f"{tool_id}/c"]),
        ]
        for ct in cand_titles:
            frag_conditions.extend([
                Project.slug.ilike(f"%-{ct}"),
                Project.slug.ilike(f"%/{ct}"),
                Project.title.ilike(f"%-{ct}"),
                Project.title.ilike(ct),
                Project.slug.ilike(f"{tool_id}/{ct}"),
            ])

        frag_q = select(Project).where(
            Project.tool_id == tool_id,
            Project.id != target_project.id,
            or_(*frag_conditions),
        )
        frag_rows = (await db.execute(frag_q)).scalars().all()
        frag_ids = [fp.id for fp in frag_rows]

        # 2. Build match conditions for documents that belong to this project
        doc_conds = []
        for ct in cand_titles:
            doc_conds.extend([
                Document.relative_path.ilike(f"%/{ct}/%"),
                Document.relative_path.ilike(f"%-{ct}/%"),
                Document.metadata_["project_hash"].astext == ct,
                Document.metadata_["project_path"].astext.ilike(f"%{ct}"),
                Document.metadata_["project_path"].astext.ilike(f"%{ct}/%"),
                Document.metadata_["project_path"].astext.ilike(f"%{ct}\\%"),
            ])
            if tool_id == "antigravity":
                doc_conds.extend([
                    Document.content.ilike(f"%Active Workspaces:%/{ct}%"),
                    Document.content.ilike(f"%Command Working Directory:%/{ct}%"),
                    Document.content.ilike(f"%\"cwd\"%/{ct}%"),
                    Document.content.ilike(f"%\"Cwd\"%/{ct}%"),
                ])
        adopt_cond = or_(*doc_conds)
        if frag_ids:
            adopt_cond = adopt_cond | Document.project_id.in_(frag_ids)

        match_docs_q = (
            select(Document)
            .options(
                defer(Document.content),
                defer(Document.content_tsv),
                defer(Document.rendered_html),
            )
            .where(
                Document.tool_id == tool_id,
                Document.category == "conversation",
                or_(
                    Document.project_id.is_(None),
                    Document.project_id.in_(frag_ids),
                ) if frag_ids else Document.project_id.is_(None),
                adopt_cond,
            )
        )
        if target_mid is not None:
            match_docs_q = match_docs_q.where(
                or_(
                    Document.machine_id == target_mid,
                    Document.machine_id.is_(None),
                )
            )

        docs_to_adopt = (await db.execute(match_docs_q)).scalars().all()
        adopted_count = len(docs_to_adopt)
        if docs_to_adopt:
            for doc in docs_to_adopt:
                doc.project_id = target_project.id
                if target_mid is not None and doc.machine_id is None:
                    doc.machine_id = target_mid
            # Also adopt any associated state/plan documents sharing session_id
            adopted_sids = [
                d.metadata_.get("session_id")
                for d in docs_to_adopt
                if isinstance(d.metadata_, dict) and d.metadata_.get("session_id")
            ]
            if adopted_sids:
                related_docs_q = (
                    select(Document)
                    .options(
                        defer(Document.content),
                        defer(Document.content_tsv),
                        defer(Document.rendered_html),
                    )
                    .where(
                        Document.tool_id == tool_id,
                        Document.project_id.is_(None),
                        Document.metadata_["session_id"].astext.in_(adopted_sids),
                    )
                )
                related_docs = (await db.execute(related_docs_q)).scalars().all()
                for rd in related_docs:
                    rd.project_id = target_project.id
            await db.flush()

        # 2.5. Auto-materialize parent conversation documents for subagents
        # When subagents (e.g. projects/.../<session_id>/subagents/...) exist in this project
        # but the parent document (projects/.../<session_id>.jsonl) does not exist (e.g. because
        # the parent file was huge or failed upload), the session is orphaned and omitted.
        subagent_q = (
            select(Document)
            .options(
                defer(Document.content),
                defer(Document.content_tsv),
                defer(Document.rendered_html),
            )
            .where(
                Document.project_id == target_project.id,
                Document.category == "conversation",
                Document.relative_path.ilike("%/subagents/%"),
            )
        )
        if target_mid is not None:
            subagent_q = subagent_q.where(Document.machine_id == target_mid)
        subagent_rows = (await db.execute(subagent_q)).scalars().all()

        parent_to_subs: dict[str, list[Document]] = {}
        for s_doc in subagent_rows:
            rp = s_doc.relative_path or ""
            if "/subagents/" in rp:
                parent_base = rp.split("/subagents/")[0] + ".jsonl"
                parent_to_subs.setdefault(parent_base, []).append(s_doc)

        for parent_base, s_docs in parent_to_subs.items():
            # Check if parent Document exists
            p_exist_q = select(Document).where(
                Document.relative_path == parent_base,
            )
            p_exist = (await db.execute(p_exist_q)).scalar_one_or_none()
            if p_exist is None:
                first_sub = s_docs[0]
                session_id = parent_base.split("/")[-1].replace(".jsonl", "")
                parent_title = ""

                # Try to extract title from memory files referencing this session
                mem_q = select(Document).where(
                    Document.project_id == target_project.id,
                    Document.category == "memory",
                    Document.content.ilike(f"%{session_id}%"),
                ).limit(1)
                mem_doc = (await db.execute(mem_q)).scalar_one_or_none()
                if mem_doc and mem_doc.title:
                    clean_mem = mem_doc.title.strip().replace("-", " ")
                    parent_title = clean_mem
                elif first_sub.title and not _is_junk_or_uuid_title(first_sub.title, session_id):
                    parent_title = first_sub.title

                if not parent_title or _is_junk_or_uuid_title(parent_title, session_id):
                    parent_title = f"{clean_title} 会话"

                new_parent = Document(
                    id=uuid.uuid4(),
                    project_id=target_project.id,
                    machine_id=first_sub.machine_id,
                    tool_id=target_project.tool_id,
                    category="conversation",
                    content_type="jsonl",
                    relative_path=parent_base,
                    title=parent_title,
                    file_size_bytes=0,
                    content="",
                    content_hash=f"synthetic-{session_id[:8]}",
                    metadata_={
                        "session_id": session_id,
                        "is_subagent": False,
                        "project_hash": clean_title,
                        "synthetic": True,
                    },
                    synced_at=first_sub.synced_at,
                    source_modified_at=first_sub.source_modified_at,
                )
                db.add(new_parent)
                adopted_count += 1
            elif p_exist.project_id != target_project.id:
                p_exist.project_id = target_project.id
                adopted_count += 1

        # 3. Clean up empty fragmented projects
        for fp in frag_rows:
            remaining_cnt = (await db.execute(
                select(func.count(Document.id)).where(Document.project_id == fp.id)
            )).scalar()
            if not remaining_cnt:
                await db.delete(fp)
        await db.flush()
        return adopted_count
    except Exception:
        return 0


@router.get("/{project_id}/conversations")
async def get_project_conversations(
    project_id: uuid.UUID,
    session_offset: int = Query(0, ge=0),
    session_limit: int = Query(10, ge=1, le=100),
    offset: int | None = Query(None, ge=0),
    limit: int | None = Query(None, ge=1, le=100),
    max_messages_per_session: int = Query(0, ge=0, le=10000),
    order: str = Query("asc", pattern="^(asc|desc)$"),
    device_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
    as_of: datetime | None = None,  # internal — passed by share.py to cap visibility
) -> dict:
    """Return all conversations for a project merged into a continuous flow.

    Groups by session, each session contains:
    - conversation messages (parsed from JSONL)
    - brain artifacts (task.md, implementation_plan.md, walkthrough.md)
    Paginated by session (not by message).

    ``as_of`` (not a public query param — passed by share.py) caps
    docs to those synced and messages to those timestamped on or
    before that instant. Share-link snapshot semantics.
    """
    if offset is not None:
        session_offset = offset
    if limit is not None:
        session_limit = limit

    mids = await user_machine_ids(db, _user)

    proj_result = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404)

    target_mid: uuid.UUID | None = None
    target_machine: Machine | None = None
    if device_id and device_id not in ("auto", "ask_only", "all"):
        target_machine = await find_machine_by_id_or_hash(db, device_id, _user)
        if target_machine:
            target_mid = target_machine.id
        else:
            return {
                "project": {
                    "id": str(project.id),
                    "slug": project.slug,
                    "title": project.title,
                    "source_path": "",
                },
                "total_sessions": 0,
                "session_offset": session_offset,
                "session_limit": session_limit,
                "order": order,
                "sessions": [],
            }

    as_of_key = as_of.isoformat() if as_of else "live"
    dev_key = device_id or "all"
    cache_key = (
        f"project:conv:v2:{_user.id}:{project_id}:{dev_key}:"
        f"{session_offset}:{session_limit}:{max_messages_per_session}:{order}:{as_of_key}"
    )
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    # Auto-adopt any missing / orphaned conversations for this project (throttled to 120s per project)
    adopted_count = await _reconcile_project_documents(db, project, target_mid)
    if adopted_count > 0:
        await db.commit()

    # Phase 1: scan only metadata columns to figure out pagination + subagent
    # grouping. Pulling Document.content (TOAST'd, can be 500 KB+ per doc)
    # for every doc in the project just to discard 90% of them blew up
    # cold-start time on chunky projects (favorite_chat hit 24 s with 152
    # conversations). load_only here ~halves wall time on big projects and
    # dramatically reduces TOAST reads.
    conv_q = (
        select(Document)
        .options(load_only(
            Document.id, Document.relative_path, Document.machine_id,
            Document.tool_id, Document.title, Document.metadata_,
            Document.source_modified_at, Document.synced_at,
            Document.file_size_bytes, Document.category, Document.content_type,
        ))
        .where(
            Document.project_id == project_id,
            Document.category == "conversation",
            Document.content_type.in_(("jsonl", "json")),
        )
    )
    if target_mid is not None:
        if target_machine and any(k in (target_machine.name or "").lower() for k in ("windows", "desktop-", "laptop-", "win-", "admin")):
            conv_q = conv_q.where(
                (Document.machine_id == target_mid)
                | (
                    Document.machine_id.is_(None)
                    & (
                        Document.metadata_["project_path"].astext.ilike("%d:/%")
                        | Document.metadata_["project_path"].astext.ilike("%c:/%")
                        | Document.relative_path.ilike("%users-admin%")
                    )
                )
            )
        elif target_machine and "mac-mini" in (target_machine.name or "").lower():
            conv_q = conv_q.where(
                (Document.machine_id == target_mid)
                | (
                    Document.machine_id.is_(None)
                    & (
                        Document.relative_path.ilike("%haixingdong%")
                        | Document.metadata_["project_path"].astext.ilike("%haixingdong%")
                    )
                )
            )
        elif target_machine and "macbook" in (target_machine.name or "").lower():
            conv_q = conv_q.where(
                (Document.machine_id == target_mid)
                | (
                    Document.machine_id.is_(None)
                    & (
                        Document.relative_path.ilike("%donghaixing%")
                        | Document.metadata_["project_path"].astext.ilike("%donghaixing%")
                    )
                )
            )
        else:
            conv_q = conv_q.where(Document.machine_id == target_mid)
    else:
        conv_q = apply_user_filter(conv_q, mids, Document.machine_id)
    if as_of is not None:
        conv_q = conv_q.where(Document.synced_at <= as_of)
    all_convs = (await db.execute(conv_q)).scalars().all()

    # Group subagents under their parent conversation.
    # Subagent path: .../parent-id/subagents/agent-xxx.jsonl
    # Parent path:   .../parent-id.jsonl
    main_convs: list = []
    subagent_map: dict[str, list] = {}  # parent_doc_id → [subagent docs]
    parent_path_to_id: dict[str, str] = {}

    # Map session IDs / UUIDs to documents for parent linking
    sid_to_rp: dict[str, str] = {}
    for d in all_convs:
        rp = d.relative_path or ""
        if "/subagents/" not in rp and not (d.metadata_ or {}).get("is_subagent"):
            sid = (d.metadata_ or {}).get("session_id")
            if sid:
                sid_to_rp[sid] = rp
            stem = rp.split("/")[-1].replace(".jsonl", "")
            m = re.search(r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", stem)
            if m:
                sid_to_rp[m.group(1)] = rp

    for d in all_convs:
        rp = d.relative_path or ""
        # Skip the sidecar noise that isn't real conversation content.
        if ".meta.json" in rp or ".metadata.json" in rp or ".resolved" in rp:
            continue
        parent_sid = (d.metadata_ or {}).get("parent_session_id")
        if "/subagents/" in rp:
            # Extract parent path: everything before /subagents/
            parent_base = rp.split("/subagents/")[0] + ".jsonl"
            subagent_map.setdefault(parent_base, []).append(d)
        elif parent_sid and parent_sid in sid_to_rp:
            parent_base = sid_to_rp[parent_sid]
            subagent_map.setdefault(parent_base, []).append(d)
        else:
            main_convs.append(d)
            parent_path_to_id[rp] = str(d.id)

    # In-memory safety: if any subagents have a parent_base not in parent_path_to_id,
    # include a parent Document in main_convs so their session is never omitted
    for parent_base, children in list(subagent_map.items()):
        if parent_base not in parent_path_to_id and children:
            first_child = children[0]
            sid = parent_base.split("/")[-1].replace(".jsonl", "")
            p_title = f"{project.title} 会话"
            proxy_doc = Document(
                id=uuid.uuid4(),
                project_id=project.id,
                machine_id=first_child.machine_id,
                tool_id=project.tool_id,
                category="conversation",
                content_type="jsonl",
                relative_path=parent_base,
                title=p_title,
                file_size_bytes=0,
                content="",
                content_hash=f"synthetic-{sid[:8]}",
                metadata_={
                    "session_id": sid,
                    "is_subagent": False,
                    "project_hash": project.title,
                    "synthetic": True,
                },
                synced_at=first_child.synced_at,
                source_modified_at=first_child.source_modified_at,
            )
            main_convs.append(proxy_doc)
            parent_path_to_id[parent_base] = str(proxy_doc.id)

    # Sort main sessions: when order == "desc" (e.g. dropdown / recent sessions),
    # sort by the LATEST activity timestamp (func.max). When order == "asc" (timeline reading),
    # sort by the FIRST message timestamp (func.min).
    conv_ts: dict[str, object] = {}
    if main_convs:
        all_query_ids = [d.id for d in main_convs]
        for d in main_convs:
            for child in subagent_map.get(d.relative_path or "", []):
                all_query_ids.append(child.id)

        agg_fn = func.max if order == "desc" else func.min
        ts_rows = await db.execute(
            select(ConversationMessage.document_id, agg_fn(ConversationMessage.timestamp))
            .where(ConversationMessage.document_id.in_(all_query_ids))
            .group_by(ConversationMessage.document_id)
        )
        agg_ts_map = {row[0]: row[1] for row in ts_rows.all()}
        for d in main_convs:
            candidates = [agg_ts_map.get(d.id)]
            for child in subagent_map.get(d.relative_path or "", []):
                c_ts = agg_ts_map.get(child.id) or child.source_modified_at or child.synced_at
                if c_ts:
                    candidates.append(c_ts)
            valid_ts = [t for t in candidates if t is not None]
            if valid_ts:
                conv_ts[str(d.id)] = max(valid_ts) if order == "desc" else min(valid_ts)
            else:
                conv_ts[str(d.id)] = d.source_modified_at or d.synced_at

    main_convs.sort(
        key=lambda d: conv_ts.get(str(d.id)) or d.synced_at or datetime.min.replace(tzinfo=timezone.utc),
        reverse=(order != "asc"),
    )
    total_sessions = len(main_convs)

    # Paginate by main session (subagents folded into parents)
    page_convs = main_convs[session_offset:session_offset + session_limit]
    # Which device each session ran on, as the device list names it
    device_refs = await device_index(db, _user)

    # For paginated docs, find any that need a real title (junk, UUID, or empty)
    docs_needing_title = [
        d for d in page_convs
        if _is_junk_or_uuid_title(d.title, (d.metadata_ or {}).get("session_id"))
        or (not d.title or not d.title.strip())
    ]
    doc_contents: dict[uuid.UUID, str] = {}
    if docs_needing_title:
        # Avoid pulling 300MB+ content into memory: slice the first 64KB using func.substr
        c_rows = await db.execute(
            select(Document.id, func.substr(Document.content, 1, 65536)).where(
                Document.id.in_([d.id for d in docs_needing_title])
            )
        )
        doc_contents = {r[0]: (r[1] or "") for r in c_rows.all()}

    # Get all plan docs for this project (for artifact embedding) — scalar columns + 5KB content snippet
    plans_cols = (
        Document.id,
        Document.title,
        Document.relative_path,
        Document.metadata_,
        Document.file_size_bytes,
        func.substr(Document.content, 1, 5000).label("content"),
    )
    plans_q = select(*plans_cols).where(Document.project_id == project_id, Document.category == "plan")
    if target_mid is not None:
        plans_q = plans_q.where(Document.machine_id == target_mid)
    else:
        plans_q = apply_user_filter(plans_q, mids, Document.machine_id)
    plans_result = await db.execute(plans_q)
    all_plans = plans_result.all()

    # Index plans by session_id
    plans_by_session: dict[str, list] = {}
    for p in all_plans:
        rp = p.relative_path or ""
        if ".resolved" in rp or ".meta.json" in rp or ".metadata.json" in rp:
            continue
        sid = (p.metadata_ or {}).get("session_id", "")
        if sid:
            plans_by_session.setdefault(sid, []).append(p)

    # Phase 2: read pre-parsed messages from conversation_messages instead of
    # re-walking the JSONL content per request. The original implementation
    # called parse_conversation(d.content, ...) per doc — for a project with
    # 5 sessions × 1 MB of JSONL each (favorite_chat), that is 5+ MB of
    # JSON.loads() + dataclass building per request, which dominated cold
    # latency (30 s observed).
    needed_ids: list = [d.id for d in page_convs]
    for d in page_convs:
        for child in subagent_map.get(d.relative_path or "", []):
            needed_ids.append(child.id)
    msgs_by_doc: dict = {}
    if needed_ids:
        msg_order = (
            ConversationMessage.line_number.desc()
            if order == "desc"
            else ConversationMessage.line_number.asc()
        )
        msg_q = (
            select(
                ConversationMessage.document_id,
                ConversationMessage.role,
                ConversationMessage.content,
                ConversationMessage.message_type,
                ConversationMessage.timestamp,
                ConversationMessage.line_number,
                ConversationMessage.metadata_,
            )
            .where(ConversationMessage.document_id.in_(needed_ids))
            .order_by(ConversationMessage.document_id, msg_order)
        )
        if as_of is not None:
            # Either no timestamp recorded (legacy / parser miss — keep
            # those; the doc itself already passed the synced_at cap) or
            # timestamp before/at the snapshot moment.
            from sqlalchemy import or_ as _or
            msg_q = msg_q.where(_or(
                ConversationMessage.timestamp.is_(None),
                ConversationMessage.timestamp <= as_of,
            ))
        rows = await db.execute(msg_q)
        for did, role, content, mtype, ts, _ln, meta in rows.all():
            if role not in ("user", "assistant"):
                continue
            if role == "user" and (
                content.startswith("[Result]")
                or content.startswith("[Tool:")
                or content.startswith('{"tool_use_id"')
            ):
                continue
            if role == "assistant" and (
                content.startswith("[Tool:")
                or content.startswith("[Result]")
            ):
                continue
            doc_msg_list = msgs_by_doc.setdefault(did, [])
            if max_messages_per_session > 0 and len(doc_msg_list) >= max(max_messages_per_session * 5, 50):
                continue
            doc_msg_list.append({
                "role": role,
                "content": content,
                "thinking": (meta or {}).get("thinking") if meta else None,
                "tool_name": (meta or {}).get("tool_name", "") if meta else "",
                "tool_input": (meta or {}).get("tool_input", "") if meta else "",
                "raw_type": mtype or "",
                "timestamp": ts.isoformat() if ts else None,
            })

        if order == "desc":
            for d_list in msgs_by_doc.values():
                d_list.reverse()

    def _parse_doc_messages(d: Document) -> list[dict]:
        return msgs_by_doc.get(d.id, [])

    # Build session list — merge subagent messages into parent by timestamp
    sessions = []
    for d in page_convs:
        session_id = (
            (d.metadata_ or {}).get("session_id")
            or (d.metadata_ or {}).get("cascade_id")
            or (d.relative_path.split("/")[-1].split(".")[0] if d.relative_path else str(d.id))
        )
        if (not session_id or session_id == "transcript") and d.relative_path and "brain/" in d.relative_path:
            bm = re.search(r"brain/([0-9a-fA-F-]+)/", d.relative_path)
            if bm:
                session_id = bm.group(1)
        ts = (d.source_modified_at or d.synced_at).isoformat()

        # Parse main conversation messages
        messages = _parse_doc_messages(d)

        # Merge subagent messages inline, marked with subagent_name
        child_docs = subagent_map.get(d.relative_path or "", [])
        for child in child_docs:
            child_msgs = _parse_doc_messages(child)
            child_name = child.title or (child.relative_path or "").split("/")[-1].replace(".jsonl", "")
            for m in child_msgs:
                m["subagent_name"] = child_name
            messages.extend(child_msgs)

        # Sort all messages by timestamp (interleaves main + subagent)
        if messages and messages[0].get("timestamp"):
            messages.sort(key=lambda x: x.get("timestamp") or "")

        # Preview mode: clip to N messages per session (0 = no limit).
        # When the user is reading oldest-first (order=asc, default on /timeline),
        # show the *first* N so they see how the session started. When reading
        # newest-first (desc), show the *last* N — the latest state matters
        # more. Picking the wrong end is what made a user see a session
        # "start at 19:50" when the first real prompt was at 19:24 and
        # there were simply more than N messages in between.
        total_msgs = len(messages)
        if max_messages_per_session and total_msgs > max_messages_per_session:
            if order == "asc":
                messages = messages[:max_messages_per_session]
            else:
                messages = messages[-max_messages_per_session:]

        # Get artifacts for this session
        artifacts = []
        for p in plans_by_session.get(session_id, []):
            doc_type = p.relative_path.split("/")[-1].split(".")[0]
            artifacts.append({
                "id": str(p.id),
                "title": p.title or doc_type,
                "doc_type": doc_type,
                "content": p.content[:5000] if p.content else None,
                "file_size_bytes": p.file_size_bytes,
            })

        conv_title = (d.title or "").strip()
        is_title_junk = _is_junk_or_uuid_title(conv_title, session_id)

        # 1. For Claude Code, always extract latest aiTitle from content if available
        if d.tool_id == "claude_code" and d.id in doc_contents:
            c = doc_contents[d.id]
            ai_matches = re.findall(r'"aiTitle"\s*:\s*"([^"]+)"', c)
            if ai_matches:
                latest_ai = ai_matches[-1].strip()
                if latest_ai and not _is_junk_or_uuid_title(latest_ai, session_id):
                    if conv_title != latest_ai:
                        conv_title = latest_ai
                        is_title_junk = False
                        d.title = latest_ai
                        await db.execute(
                            update(Document).where(Document.id == d.id).values(title=latest_ai)
                        )
                        for child in subagent_map.get(d.relative_path or "", []):
                            child.title = latest_ai
                            await db.execute(
                                update(Document).where(Document.id == child.id).values(title=latest_ai)
                            )
                    else:
                        is_title_junk = False

        # 1.1 For Antigravity, extract official title from metadata or annotations doc
        if d.tool_id == "antigravity":
            m_title = (d.metadata_ or {}).get("title")
            if m_title and not _is_junk_or_uuid_title(str(m_title), session_id):
                cand_title = str(m_title).strip()
                if conv_title != cand_title:
                    conv_title = cand_title
                    is_title_junk = False
                    d.title = cand_title
                    await db.execute(update(Document).where(Document.id == d.id).values(title=cand_title))
                else:
                    is_title_junk = False

            # If current title is junk or looks like a raw prompt / code snippet, check annotations table
            if is_title_junk or ("<USER_REQUEST>" in conv_title or conv_title.startswith("💬") or "\n" in conv_title or len(conv_title) > 35):
                ann_doc = (await db.execute(
                    select(Document)
                    .options(defer(Document.content_tsv), defer(Document.rendered_html), defer(Document.metadata_))
                    .where(
                        Document.tool_id == "antigravity",
                        Document.category == "state",
                        Document.relative_path.like(f"%annotations/{session_id}.pbtxt"),
                    ).limit(1)
                )).scalar_one_or_none()
                if ann_doc:
                    cand_ann = ann_doc.title
                    if not cand_ann and ann_doc.content:
                        m = re.search(r'title:\s*"([^"]+)"', ann_doc.content)
                        if m:
                            cand_ann = m.group(1).strip()
                    if cand_ann and "(.*?)" not in cand_ann and not cand_ann.endswith(".pbtxt"):
                        if "\\" in cand_ann:
                            try:
                                cand_ann = cand_ann.encode("raw_unicode_escape").decode("unicode_escape")
                            except Exception:
                                pass
                        if not _is_junk_or_uuid_title(cand_ann, session_id):
                            if conv_title != cand_ann:
                                conv_title = cand_ann
                                is_title_junk = False
                                d.title = cand_ann
                                await db.execute(update(Document).where(Document.id == d.id).values(title=cand_ann))
                            else:
                                is_title_junk = False

        # 2. Try metadata name / title / ai_title / first_user_message
        if is_title_junk:
            m_title = (
                (d.metadata_ or {}).get("name")
                or (d.metadata_ or {}).get("title")
                or (d.metadata_ or {}).get("ai_title")
                or (d.metadata_ or {}).get("first_user_message")
            )
            if m_title and not _is_junk_or_uuid_title(str(m_title), session_id):
                conv_title = str(m_title).strip()
                is_title_junk = False
                d.title = conv_title
                await db.execute(
                    update(Document).where(Document.id == d.id).values(title=conv_title)
                )

        # 3. Try extracting aiTitle from document content (fallback)
        if is_title_junk and d.id in doc_contents:
            c = doc_contents[d.id]
            ai_matches = re.findall(r'"aiTitle"\s*:\s*"([^"]+)"', c)
            if ai_matches:
                cand = ai_matches[-1].strip()
                if not _is_junk_or_uuid_title(cand, session_id):
                    conv_title = cand
                    is_title_junk = False
                    d.title = cand
                    await db.execute(
                        update(Document).where(Document.id == d.id).values(title=cand)
                    )

        # 4. Try parent title if subagent
        if is_title_junk and (d.metadata_ or {}).get("parent_session_id"):
            parent_sid = d.metadata_["parent_session_id"]
            p_doc = (await db.execute(
                select(Document.title).where(
                    Document.tool_id == d.tool_id,
                    or_(
                        Document.metadata_["session_id"].astext == parent_sid,
                        Document.relative_path.like(f"%{parent_sid}%"),
                    ),
                ).limit(1)
            )).scalar_one_or_none()
            if p_doc and not _is_junk_or_uuid_title(p_doc, parent_sid):
                p_cand = f"审核: {p_doc}" if d.tool_id == "codex" else p_doc
                conv_title = p_cand
                is_title_junk = False
                d.title = p_cand
                await db.execute(update(Document).where(Document.id == d.id).values(title=p_cand))

        # 5. Fallback to user messages (scan all user messages for first non-junk)
        if is_title_junk:
            user_msg_contents = [m.get("content") for m in messages if m.get("role") == "user"]
            c = _title_from_user_messages(user_msg_contents, session_id)
            if c:
                conv_title = c
                is_title_junk = False
                d.title = c
                await db.execute(
                    update(Document).where(Document.id == d.id).values(title=c)
                )

        if is_title_junk:
            conv_title = session_id[:8] if session_id else "会话"
        conv_title = conv_title.strip()

        fs_bytes = d.file_size_bytes or 0
        est_tokens = max(total_msgs * 250, fs_bytes // 4)
        compact_rec = total_msgs > 35 or fs_bytes > 300_000

        sessions.append({
            "session_id": session_id,
            "title": conv_title,
            "conversation_id": str(d.id),
            "timestamp": ts,
            "message_count": total_msgs,  # true total, not the clipped count
            "file_size_bytes": fs_bytes,
            "estimated_tokens": est_tokens,
            "compact_recommended": compact_rec,
            "messages": messages,
            "truncated": bool(max_messages_per_session and total_msgs > max_messages_per_session),
            "artifacts": artifacts,
            "device_id": device_refs[d.machine_id].device_id if d.machine_id in device_refs else None,
            "device_name": device_refs[d.machine_id].name if d.machine_id in device_refs else None,
        })

    if target_machine is not None:
        # The folder on the device picked; empty rather than another machine's folder
        source_path = pick_project_path(
            [Placement(d.machine_id, (d.metadata_ or {}).get("project_path"), 1, d.synced_at) for d in all_convs],
            project.slug, project.title,
        )
        if not source_path:
            found = discovered_for(project.slug, await discovered_projects(db, target_machine, mids, project.tool_id))
            source_path = next(
                (c for c in (_clean_source_path(x.path) for x in found) if c and not is_junk_project(None, c)), ""
            )
    else:
        source_path = _clean_source_path(project.source_path) or ""

    payload = {
        "project": {
            "id": str(project.id),
            "slug": project.slug,
            "title": project.title,
            "source_path": source_path,
        },
        "total_sessions": total_sessions,
        "session_offset": session_offset,
        "session_limit": session_limit,
        "order": order,
        "sessions": sessions,
    }
    await db.commit()
    await cache_set(cache_key, payload, ttl_seconds=30)
    return payload


# Heuristic: documents we want to drop on the floor when bootstrapping a
# new AI session. .meta.json is the Claude Code subagent sidecar (no
# conversation content); .metadata.json and .resolved are transient
# variants. Same noise filter the timeline uses.
def _is_export_noise(path: str) -> bool:
    return (
        ".resolved" in path
        or ".meta.json" in path
        or ".metadata.json" in path
    )


# Category order in the rendered Markdown. Memory / plan / identity go
# first because that's the "give the new AI context" payload; long
# conversation transcripts last because they're the bulk. Anything not
# in this list is appended in alphabetical order under a "Other" group.
_CATEGORY_ORDER = ["memory", "plan", "identity", "config", "skill", "learning", "note", "conversation"]
_CATEGORY_HEADERS_ZH = {
    "memory": "记忆", "plan": "计划", "identity": "身份卡",
    "config": "配置", "skill": "技能", "learning": "学习笔记",
    "note": "笔记", "conversation": "对话",
}


@router.get("/{project_id}/export.md")
async def export_project_markdown(
    project_id: uuid.UUID,
    include_conversations: bool = Query(True, description="Include the full conversation transcripts (can be very long)"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Response:
    """Render a single project's documents + knowledge-graph context as a
    Markdown blob that can be dropped into a fresh AI project as
    ``MEMENTO-CONTEXT.md``. This is the "one-shot dump" alternative to
    the live MCP path — useful for portable / offline handoff.

    Same ownership filter as the rest of the project routes (admin /
    owner see everything via apply_user_filter shortcut).
    """
    mids = await user_machine_ids(db, _user)

    project = (await db.execute(
        select(Project).where(Project.id == project_id)
    )).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404)

    # Pull all docs for this project (no 50-row cap; this is an export).
    docs_q = (
        select(Document)
        .options(defer(Document.content_tsv), defer(Document.rendered_html))
        .where(Document.project_id == project_id)
        .order_by(Document.synced_at.desc())
    )
    if not include_conversations:
        docs_q = docs_q.where(Document.category != "conversation")
    docs_q = apply_user_filter(docs_q, mids, Document.machine_id)
    docs = [d for d in (await db.execute(docs_q)).scalars().all()
            if not _is_export_noise(d.relative_path)]

    # Knowledge-graph: any entity whose name fuzzy-matches the project
    # title. Mirrors what memory_context does for MCP, so the Markdown
    # carries the same context an AI calling memory_context would see.
    ent_q = (
        select(KnowledgeEntity)
        .where(or_(
            KnowledgeEntity.name.ilike(f"%{project.title}%"),
            KnowledgeEntity.name.ilike(f"%{project.slug}%"),
        ))
        .limit(20)
    )
    if mids is not None:
        # Non-admin: only entities owned by the caller.
        ent_q = ent_q.where(KnowledgeEntity.user_id == _user.id)
    entities = (await db.execute(ent_q)).scalars().all()

    lines: list[str] = []
    title = project.title or project.slug or "Untitled project"
    lines.append(f"# Memento context — {title}")
    lines.append("")
    lines.append(
        f"**Tool**: `{project.tool_id or 'unknown'}`  ·  "
        f"**Documents**: {len(docs)}  ·  "
        f"**Exported**: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"
    )
    if project.source_path:
        lines.append(f"**Source path**: `{project.source_path}`")
    lines.append("")
    lines.append(
        "> This file was exported from Memento as a one-shot bootstrap of\n"
        "> a project's prior context. Drop it into a fresh project as\n"
        "> `MEMENTO-CONTEXT.md` and add to your `CLAUDE.md` / `AGENTS.md`:\n"
        "> `Read MEMENTO-CONTEXT.md for prior conversations and decisions on this project.`"
    )
    lines.append("")
    lines.append("---")
    lines.append("")

    # Group docs by category.
    by_cat: dict[str, list[Document]] = {}
    for d in docs:
        by_cat.setdefault(d.category or "other", []).append(d)

    ordered_cats = (
        [c for c in _CATEGORY_ORDER if c in by_cat]
        + sorted([c for c in by_cat if c not in _CATEGORY_ORDER])
    )

    for cat in ordered_cats:
        if cat == "conversation" and not include_conversations:
            continue
        bucket = by_cat[cat]
        if not bucket:
            continue
        zh = _CATEGORY_HEADERS_ZH.get(cat, cat)
        lines.append(f"## {cat.title()} / {zh}  ({len(bucket)})")
        lines.append("")
        for d in bucket:
            doc_title = d.title or (d.relative_path.rsplit("/", 1)[-1] if d.relative_path else d.category)
            stamp = d.synced_at.strftime("%Y-%m-%d") if d.synced_at else ""
            lines.append(f"### {doc_title}")
            lines.append(f"*{d.relative_path}*  ·  *{stamp}*")
            lines.append("")
            # For conversations, prefer the AI summary if we have one —
            # the raw JSONL is too long to inline. For everything else,
            # the full content is the point.
            if cat == "conversation" and d.ai_summary:
                lines.append(d.ai_summary)
            elif d.content:
                # Fence as plain text. Don't trust the source for
                # well-formed markdown — but we DO trust it not to be
                # binary because the model rejects binary content_types
                # upstream. Cap per-doc to 200 KB so a single 1 MB
                # conversation log doesn't dominate the file; the AI
                # can call memory_open(id) for the rest.
                blob = d.content if len(d.content) < 200_000 else d.content[:200_000] + "\n\n…(truncated; call memory_open() for full text)"
                lines.append(blob)
            else:
                lines.append("*(empty)*")
            lines.append("")
            lines.append("---")
            lines.append("")

    if entities:
        lines.append("## Knowledge graph")
        lines.append("")
        ent_ids = [e.id for e in entities]
        # Fetch relations + observations in two batched queries.
        rels = (await db.execute(
            select(KnowledgeRelation, KnowledgeEntity)
            .join(KnowledgeEntity, KnowledgeRelation.target_id == KnowledgeEntity.id)
            .where(KnowledgeRelation.source_id.in_(ent_ids))
        )).all()
        rels_by_source: dict[uuid.UUID, list[tuple[str, str]]] = {}
        for r, target in rels:
            rels_by_source.setdefault(r.source_id, []).append((r.relation_type, target.name))

        obs = (await db.execute(
            select(KnowledgeObservation)
            .where(KnowledgeObservation.entity_id.in_(ent_ids))
            .order_by(KnowledgeObservation.observed_at.desc())
        )).scalars().all()
        obs_by_entity: dict[uuid.UUID, list[KnowledgeObservation]] = {}
        for o in obs:
            obs_by_entity.setdefault(o.entity_id, []).append(o)

        for e in entities:
            lines.append(f"### {e.name}  *({e.entity_type})*")
            if e.summary:
                lines.append("")
                lines.append(e.summary)
            ent_rels = rels_by_source.get(e.id, [])
            if ent_rels:
                lines.append("")
                lines.append("**Relations**:")
                for rel_type, target_name in ent_rels[:10]:
                    lines.append(f"- {rel_type} → **{target_name}**")
            ent_obs = obs_by_entity.get(e.id, [])
            if ent_obs:
                lines.append("")
                lines.append("**Recent observations**:")
                for o in ent_obs[:10]:
                    date_str = o.observed_at.strftime("%Y-%m-%d") if o.observed_at else ""
                    prefix = f"[{date_str}] " if date_str else ""
                    lines.append(f"- {prefix}{o.content}")
            lines.append("")
            lines.append("---")
            lines.append("")

    md = "\n".join(lines)
    # Per RFC 6266: file name with simple ASCII fallback + filename* for
    # unicode. The slug is already URL-safe; project.title may have
    # CJK so we just send ASCII fallback derived from slug.
    safe = "".join(c for c in (project.slug or "project") if c.isalnum() or c in "-_")[:64]
    return Response(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="memento-context-{safe}.md"',
            # nginx-friendly: don't buffer multi-MB markdown.
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{project_id}/blueprint")
async def get_project_blueprint(
    project_id: uuid.UUID,
    recent_convs: int = Query(10, ge=0, le=50,
        description="How many recent conversations to include (AI summary only, not full body)"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """One-shot "give me the project blueprint" for an AI agent.

    Combines into a single response everything you'd otherwise need
    ``memory_context`` + N×``memory_open`` + ``memory_graph`` + a
    handful of ``memory_recall`` calls to assemble:

      * project meta (title / tool / source_path)
      * full content of all identity / memory / plan / learning files
        (these are the curated "what is this project" docs)
      * recent conversation AI summaries (titles + ai_summary; no full body)
      * knowledge-graph entities + observations + relations whose name
        fuzzy-matches the project title or slug

    Powers the MCP ``memory_blueprint`` tool — replaces 5-10 sequential
    RPCs with one.
    """
    cache_key = f"project:blueprint:{_user.id}:{project_id}:{recent_convs}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    mids = await user_machine_ids(db, _user)

    project = (await db.execute(
        select(Project).where(Project.id == project_id)
    )).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404)

    # 1. Curated docs full content (identity / memory / plan / learning)
    CURATED = ("identity", "memory", "plan", "learning")
    curated_q = (
        select(Document)
        .options(defer(Document.content_tsv), defer(Document.metadata_), defer(Document.rendered_html))
        .where(
            Document.project_id == project_id,
            Document.category.in_(CURATED),
        )
        .order_by(Document.synced_at.desc())
        .limit(100)
    )
    curated_q = apply_user_filter(curated_q, mids, Document.machine_id)
    curated_docs = [
        d for d in (await db.execute(curated_q)).scalars().all()
        if not _is_export_noise(d.relative_path)
    ]

    # 2. Recent conversations — title + ai_summary only (full body via memory_conversation)
    if recent_convs > 0:
        conv_q = (
            select(Document)
            .options(
                defer(Document.content),
                defer(Document.content_tsv),
                defer(Document.metadata_),
                defer(Document.rendered_html),
            )
            .where(
                Document.project_id == project_id,
                Document.category == "conversation",
            )
            .order_by(Document.synced_at.desc())
            .limit(recent_convs)
        )
        conv_q = apply_user_filter(conv_q, mids, Document.machine_id)
        convs = [
            d for d in (await db.execute(conv_q)).scalars().all()
            if not _is_export_noise(d.relative_path)
        ]
    else:
        convs = []

    # 3. Knowledge graph: entities fuzzy-matching project name/slug
    ent_q = (
        select(KnowledgeEntity)
        .where(or_(
            KnowledgeEntity.name.ilike(f"%{project.title}%"),
            KnowledgeEntity.name.ilike(f"%{project.slug}%"),
        ))
        .limit(20)
    )
    if mids is not None:
        ent_q = ent_q.where(KnowledgeEntity.user_id == _user.id)
    entities = (await db.execute(ent_q)).scalars().all()
    ent_ids = [e.id for e in entities]

    # Batch-fetch observations + outgoing relations for those entities
    observations_by_entity: dict[str, list[dict]] = {}
    relations_by_entity: dict[str, list[dict]] = {}
    if ent_ids:
        obs = (await db.execute(
            select(KnowledgeObservation)
            .where(KnowledgeObservation.entity_id.in_(ent_ids))
            .order_by(KnowledgeObservation.observed_at.desc())
        )).scalars().all()
        for o in obs:
            observations_by_entity.setdefault(str(o.entity_id), []).append({
                "content": o.content,
                "observed_at": o.observed_at.isoformat() if o.observed_at else None,
            })

        rels = (await db.execute(
            select(KnowledgeRelation, KnowledgeEntity)
            .join(KnowledgeEntity, KnowledgeRelation.target_id == KnowledgeEntity.id)
            .where(KnowledgeRelation.source_id.in_(ent_ids))
        )).all()
        for rel, target in rels:
            relations_by_entity.setdefault(str(rel.source_id), []).append({
                "relation": rel.relation_type,
                "target_name": target.name,
                "target_type": target.entity_type,
            })

    payload = {
        "project": {
            "id": str(project.id),
            "title": project.title,
            "slug": project.slug,
            "tool_id": project.tool_id,
            "source_path": _clean_source_path(project.source_path),
        },
        "curated_docs": [
            {
                "id": str(d.id),
                "category": d.category,
                "title": d.title,
                "relative_path": d.relative_path,
                "synced_at": d.synced_at.isoformat() if d.synced_at else None,
                "content": d.content,
                "ai_summary": d.ai_summary,
            }
            for d in curated_docs
        ],
        "recent_conversations": [
            {
                "id": str(d.id),
                "title": d.title or d.relative_path.rsplit("/", 1)[-1],
                "tool_id": d.tool_id,
                "synced_at": d.synced_at.isoformat() if d.synced_at else None,
                "ai_summary": d.ai_summary,
            }
            for d in convs
        ],
        "knowledge_graph": {
            "entities": [
                {
                    "id": str(e.id),
                    "name": e.name,
                    "entity_type": e.entity_type,
                    "summary": e.summary,
                    "observations": observations_by_entity.get(str(e.id), [])[:15],
                    "relations": relations_by_entity.get(str(e.id), [])[:15],
                }
                for e in entities
            ],
        },
        "counts": {
            "curated_docs": len(curated_docs),
            "recent_conversations": len(convs),
            "entities": len(entities),
            "total_observations": sum(len(v) for v in observations_by_entity.values()),
            "total_relations": sum(len(v) for v in relations_by_entity.values()),
        },
    }
    await cache_set(cache_key, payload, ttl_seconds=30)
    return payload
