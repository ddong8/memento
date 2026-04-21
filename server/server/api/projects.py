"""Projects API — browse projects and their documents."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, Document, Project, Tool, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.conversation_parser import parse_conversation
from ..services.user_filter import user_machine_ids, apply_user_filter

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
async def list_projects(
    tool_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    mids = await user_machine_ids(db, _user)

    # Single query: projects LEFT JOIN documents, GROUP BY, count documents
    doc_count_col = func.count(Document.id).label("doc_count")
    join_cond = Document.project_id == Project.id
    if mids is not None:
        join_cond = join_cond & Document.machine_id.in_(mids)

    query = (
        select(Project, doc_count_col)
        .outerjoin(Document, join_cond)
        .group_by(Project.id)
        .order_by(Project.updated_at.desc())
    )
    if tool_id:
        query = query.where(Project.tool_id == tool_id)
    if mids is not None:
        # Exclude projects with zero visible docs for non-admin users
        query = query.having(doc_count_col > 0)

    result = await db.execute(query)
    rows = result.all()

    return [
        {
            "id": str(p.id),
            "slug": p.slug,
            "title": p.title,
            "tool_id": p.tool_id,
            "source_path": p.source_path,
            "visibility": p.visibility,
            "document_count": count or 0,
            "created_at": p.created_at.isoformat(),
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        }
        for p, count in rows
    ]


@router.get("/{project_id}")
async def get_project(
    project_id: uuid.UUID,
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
        .where(Document.project_id == project_id)
        .order_by(Document.synced_at.desc())
        .limit(50)
    )
    docs_q = apply_user_filter(docs_q, mids, Document.machine_id)
    docs_result = await db.execute(docs_q)
    docs = docs_result.scalars().all()

    return {
        "id": str(project.id),
        "slug": project.slug,
        "title": project.title,
        "tool_id": project.tool_id,
        "source_path": project.source_path,
        "visibility": project.visibility,
        "documents": [
            {
                "id": str(d.id),
                "relative_path": d.relative_path,
                "category": d.category,
                "title": d.title,
                "file_size_bytes": d.file_size_bytes,
                "synced_at": d.synced_at.isoformat(),
            }
            for d in docs
        ],
    }


@router.get("/{project_id}/timeline")
async def get_project_timeline(
    project_id: uuid.UUID,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    category: str | None = None,
    order: str = Query("desc", regex="^(asc|desc)$"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Return a session-grouped timeline for a project.

    Groups documents by session_id (cascade_id), showing each session as a unit:
    - conversation with message preview
    - related brain artifacts (task.md, implementation_plan.md, walkthrough.md)
    Filters out .resolved versions and .metadata.json noise.
    """
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
        if ".resolved" in d_path or ".metadata.json" in d_path:
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
            session["conversation"] = {
                "id": str(d_id),
                "title": d_title or d_path.split("/")[-1],
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
                ev["title"] = ev["conversation"]["title"]
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

    # Preview messages — fetch first 6 user/assistant messages per conv doc
    previews: dict = {}
    if page_conv_ids:
        # Use a window function via a lateral-like approach: just fetch first 10 rows per doc
        # by line_number, then filter in Python. Small constant per doc.
        msg_rows = await db.execute(
            select(ConversationMessage.document_id, ConversationMessage.role,
                   ConversationMessage.content, ConversationMessage.timestamp,
                   ConversationMessage.line_number)
            .where(ConversationMessage.document_id.in_(page_conv_ids))
            .where(ConversationMessage.role.in_(("user", "assistant")))
            .order_by(ConversationMessage.document_id, ConversationMessage.line_number)
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

    return {
        "project": {
            "id": str(project.id),
            "slug": project.slug,
            "title": project.title,
            "tool_id": project.tool_id,
            "source_path": project.source_path,
        },
        "total": total,
        "offset": offset,
        "limit": limit,
        "events": page,
    }


@router.get("/{project_id}/conversations")
async def get_project_conversations(
    project_id: uuid.UUID,
    session_offset: int = Query(0, ge=0),
    session_limit: int = Query(10, ge=1, le=50),
    order: str = Query("asc", regex="^(asc|desc)$"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Return all conversations for a project merged into a continuous flow.

    Groups by session, each session contains:
    - conversation messages (parsed from JSONL)
    - brain artifacts (task.md, implementation_plan.md, walkthrough.md)
    Paginated by session (not by message).
    """
    mids = await user_machine_ids(db, _user)

    proj_result = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404)

    # Get all conversation docs for this project
    conv_q = (
        select(Document)
        .where(
            Document.project_id == project_id,
            Document.category == "conversation",
            Document.content_type == "jsonl",
        )
    )
    conv_q = apply_user_filter(conv_q, mids, Document.machine_id)
    all_convs = (await db.execute(conv_q)).scalars().all()

    # Group subagents under their parent conversation.
    # Subagent path: .../parent-id/subagents/agent-xxx.jsonl
    # Parent path:   .../parent-id.jsonl
    main_convs: list = []
    subagent_map: dict[str, list] = {}  # parent_doc_id → [subagent docs]
    parent_path_to_id: dict[str, str] = {}

    for d in all_convs:
        rp = d.relative_path or ""
        if "/subagents/" in rp:
            # Extract parent path: everything before /subagents/
            parent_base = rp.split("/subagents/")[0] + ".jsonl"
            subagent_map.setdefault(parent_base, []).append(d)
        else:
            main_convs.append(d)
            parent_path_to_id[rp] = str(d.id)

    # Sort main sessions by first message timestamp — single GROUP BY query
    conv_ts: dict[str, object] = {}
    if main_convs:
        ids = [d.id for d in main_convs]
        ts_rows = await db.execute(
            select(ConversationMessage.document_id, func.min(ConversationMessage.timestamp))
            .where(ConversationMessage.document_id.in_(ids))
            .group_by(ConversationMessage.document_id)
        )
        first_ts_map = {row[0]: row[1] for row in ts_rows.all()}
        for d in main_convs:
            conv_ts[str(d.id)] = first_ts_map.get(d.id) or d.source_modified_at or d.synced_at

    main_convs.sort(
        key=lambda d: conv_ts.get(str(d.id)) or d.synced_at,
        reverse=(order != "asc"),
    )
    total_sessions = len(main_convs)

    # Paginate by main session (subagents folded into parents)
    page_convs = main_convs[session_offset:session_offset + session_limit]

    # Get all plan docs for this project (for artifact embedding)
    plans_q = select(Document).where(Document.project_id == project_id, Document.category == "plan")
    plans_q = apply_user_filter(plans_q, mids, Document.machine_id)
    plans_result = await db.execute(plans_q)
    all_plans = plans_result.scalars().all()

    # Index plans by session_id
    plans_by_session: dict[str, list] = {}
    for p in all_plans:
        if ".resolved" in p.relative_path or ".metadata.json" in p.relative_path:
            continue
        sid = (p.metadata_ or {}).get("session_id", "")
        if sid:
            plans_by_session.setdefault(sid, []).append(p)

    def _parse_doc_messages(d: Document) -> list[dict]:
        """Parse a document's messages, filtering out tool noise."""
        if not d.content:
            return []
        parsed = parse_conversation(d.content, d.tool_id)
        msgs = []
        for m in parsed:
            if m.role not in ("user", "assistant"):
                continue
            if m.role == "user" and (
                m.content.startswith("[Result]")
                or m.content.startswith("[Tool:")
                or m.content.startswith('{"tool_use_id"')
            ):
                continue
            if m.role == "assistant" and (
                m.content.startswith("[Tool:")
                and "\n" not in m.content.split("[Tool:")[0]
            ):
                continue
            msgs.append({
                "role": m.role,
                "content": m.content,
                "thinking": m.thinking or None,
                "tool_name": m.tool_name or "",
                "tool_input": m.tool_input or "",
                "raw_type": m.raw_type or "",
                "timestamp": m.timestamp or None,
            })
        return msgs

    # Build session list — merge subagent messages into parent by timestamp
    sessions = []
    for d in page_convs:
        session_id = (d.metadata_ or {}).get("session_id") or (d.metadata_ or {}).get("cascade_id") or ""
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

        sessions.append({
            "session_id": session_id,
            "title": d.title or session_id[:8],
            "conversation_id": str(d.id),
            "timestamp": ts,
            "message_count": len(messages),
            "messages": messages,
            "artifacts": artifacts,
        })

    return {
        "project": {
            "id": str(project.id),
            "slug": project.slug,
            "title": project.title,
            "source_path": project.source_path,
        },
        "total_sessions": total_sessions,
        "session_offset": session_offset,
        "session_limit": session_limit,
        "order": order,
        "sessions": sessions,
    }
