"""Share links — project timelines, dailies, and memory.

Two recipient modes on the same `share_links` row:

  - target_user_id IS NULL → public anonymous link (legacy default).
    Anyone with the URL `/s/<token>` can open it; tracked via ShareView.
  - target_user_id IS SET   → directed share. The same `/s/<token>` URL,
    but the API requires the visitor to be logged in as that user. Useful
    for forwarding to a viewer-role teammate without exposing publicly.

Endpoint groups:

  Authenticated owner:
      POST   /api/share              create a share (timeline/daily/memory)
      GET    /api/share              list my shares with view counts
      GET    /api/share/{token}/views  detailed access log
      DELETE /api/share/{token}      revoke
      GET    /api/share/recipients   list users available as recipients
                                     (admin/owner only — used by the picker)

  Authenticated viewer:
      GET    /api/share/inbox        shares targeted at me

  Visitor (auth optional, required iff share has target_user_id):
      GET    /api/share/public/{token}        metadata + records a view
      GET    /api/share/public/{token}/data   actual content (read-only)
"""

from __future__ import annotations

import base64
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    KnowledgeEntity, KnowledgeRelation, ShareLink, ShareView, User,
)
from ..db.session import get_db
from ..middleware.auth import get_current_user, get_optional_user
from ..services.geoip import lookup as geoip_lookup
from ..services.rate_limit import client_ip

router = APIRouter(prefix="/api/share", tags=["share"])

VALID_KINDS = ("timeline", "daily", "memory", "conversation")


def _gen_token() -> str:
    """24 bytes → 40-char unpadded base32, URL-safe, copy-pasteable."""
    raw = secrets.token_bytes(24)
    return base64.b32encode(raw).decode("ascii").rstrip("=").lower()


def _parse_conversation_targets(target_id: str) -> list[tuple[uuid.UUID, list[int] | None]]:
    """Parses conversation targets from target_id string.

    Supports:
    1. JSON: '[{"id": "uuid", "turns": [0, 1]}]' or '{"id": "uuid", "turns": [0, 1]}'
    2. Semicolon/comma separated:
       - "uuid" -> (uuid, None) [all turns]
       - "uuid:0,1" -> (uuid, [0, 1]) [specific turns]
       - "uuid1:0,1;uuid2:2,3" -> [(uuid1, [0, 1]), (uuid2, [2, 3])]
       - "uuid1,uuid2" -> [(uuid1, None), (uuid2, None)]
    """
    target_id = target_id.strip()
    if not target_id:
        return []

    # JSON format
    if target_id.startswith("[") or target_id.startswith("{"):
        try:
            data = json.loads(target_id)
            if isinstance(data, dict):
                data = [data]
            results: list[tuple[uuid.UUID, list[int] | None]] = []
            for item in data:
                cid = uuid.UUID(str(item.get("id")).strip())
                raw_turns = item.get("turns")
                turns: list[int] | None = None
                if raw_turns is not None and isinstance(raw_turns, list):
                    turns = [int(x) for x in raw_turns if isinstance(x, (int, str)) and str(x).isdigit()]
                results.append((cid, turns))
            return results
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"invalid json conversation target_id: {e}")

    # Plain text format
    if ";" in target_id:
        chunks = [x.strip() for x in target_id.split(";") if x.strip()]
    elif ":" in target_id:
        chunks = [target_id]
    else:
        chunks = [x.strip() for x in target_id.split(",") if x.strip()]

    parsed: list[tuple[uuid.UUID, list[int] | None]] = []
    for chunk in chunks:
        if ":" in chunk:
            cid_str, turns_str = chunk.split(":", 1)
            try:
                cid = uuid.UUID(cid_str.strip())
            except ValueError:
                raise HTTPException(status_code=400, detail=f"invalid conversation UUID: {cid_str}")
            try:
                turn_indices = [int(x.strip()) for x in turns_str.split(",") if x.strip().isdigit()]
            except ValueError:
                turn_indices = None
            parsed.append((cid, turn_indices if turn_indices else None))
        else:
            try:
                cid = uuid.UUID(chunk.strip())
            except ValueError:
                raise HTTPException(status_code=400, detail=f"invalid conversation UUID: {chunk}")
            parsed.append((cid, None))

    return parsed


def _validate_target(kind: str, target_id: str) -> None:
    """Reject obviously-wrong target_id shapes per kind so we don't persist garbage."""
    if kind == "timeline":
        try:
            uuid.UUID(target_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="timeline target_id must be a project UUID")
    elif kind == "daily":
        try:
            datetime.strptime(target_id, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="daily target_id must be YYYY-MM-DD")
    elif kind == "memory":
        # v1: only whole-memory share supported. Future: entity UUID for partial.
        if target_id != "all":
            raise HTTPException(status_code=400, detail="memory target_id must be 'all'")
    elif kind == "conversation":
        targets = _parse_conversation_targets(target_id)
        if not targets:
            raise HTTPException(status_code=400, detail="conversation target_id must contain at least one conversation UUID")


# ---------------------------------------------------------------------------
# Owner-side (requires auth)
# ---------------------------------------------------------------------------
class CreateShareBody(BaseModel):
    kind: str                         # "timeline" | "daily" | "memory"
    target_id: str                    # project uuid | YYYY-MM-DD | "all"
    title: str | None = None
    expires_in_days: int | None = None       # None = never
    target_user_id: str | None = None        # None = public anonymous link


@router.post("")
async def create_share(
    body: CreateShareBody,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    if body.kind not in VALID_KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {VALID_KINDS}")
    _validate_target(body.kind, body.target_id)

    target_user_uuid: uuid.UUID | None = None
    if body.target_user_id:
        try:
            target_user_uuid = uuid.UUID(body.target_user_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="target_user_id must be a UUID")
        # Verify target exists and is active. Reject self-targeting (pointless).
        if target_user_uuid == _user.id:
            raise HTTPException(status_code=400, detail="cannot target yourself")
        target = (await db.execute(
            select(User).where(User.id == target_user_uuid, User.status == "active")
        )).scalar_one_or_none()
        if not target:
            raise HTTPException(status_code=404, detail="target user not found")

    expires_at = None
    if body.expires_in_days and body.expires_in_days > 0:
        expires_at = datetime.now(timezone.utc) + timedelta(days=body.expires_in_days)

    # Collision-retry generation — 40 char b32 collisions are astronomically
    # unlikely, but cheap to guard against.
    for _ in range(5):
        token = _gen_token()
        existing = (await db.execute(
            select(ShareLink.id).where(ShareLink.token == token).limit(1)
        )).scalar_one_or_none()
        if not existing:
            break
    else:
        raise HTTPException(status_code=500, detail="token generation failed")

    link = ShareLink(
        token=token,
        kind=body.kind,
        target_id=body.target_id,
        owner_user_id=_user.id,
        target_user_id=target_user_uuid,
        title=body.title,
        expires_at=expires_at,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)

    return _serialize(link, view_count=0)


def _serialize(link: ShareLink, view_count: int = 0, owner: User | None = None,
               target: User | None = None) -> dict:
    return {
        "token": link.token,
        "kind": link.kind,
        "target_id": link.target_id,
        "title": link.title,
        "expires_at": link.expires_at.isoformat() if link.expires_at else None,
        "revoked_at": link.revoked_at.isoformat() if link.revoked_at else None,
        "created_at": link.created_at.isoformat(),
        "view_count": int(view_count),
        "target_user_id": str(link.target_user_id) if link.target_user_id else None,
        "target_user_label": _user_label(target) if target else None,
        "owner_label": _user_label(owner) if owner else None,
    }


def _user_label(u: User) -> str:
    return u.name or u.email.split("@")[0]


@router.get("")
async def list_my_shares(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    rows = (await db.execute(
        select(
            ShareLink,
            func.count(ShareView.id).label("view_count"),
        )
        .outerjoin(ShareView, ShareView.share_id == ShareLink.id)
        .where(ShareLink.owner_user_id == _user.id)
        .group_by(ShareLink.id)
        .order_by(desc(ShareLink.created_at))
    )).all()
    # Bulk-load referenced target users so the picker can show names without
    # an N+1 round-trip.
    target_ids = {link.target_user_id for link, _ in rows if link.target_user_id}
    targets: dict[uuid.UUID, User] = {}
    if target_ids:
        for u in (await db.execute(
            select(User).where(User.id.in_(target_ids))
        )).scalars().all():
            targets[u.id] = u

    return [
        _serialize(link, view_count=int(vc or 0),
                   target=targets.get(link.target_user_id) if link.target_user_id else None)
        for link, vc in rows
    ]


@router.get("/recipients")
async def list_recipients(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """Active users available as a 'share with user' target.

    Limited to admin/owner so a regular user can't enumerate the user list
    just by hitting this endpoint (registration is invite-only but we don't
    want to make membership trivially listable either).
    """
    if _user.role not in ("admin", "owner"):
        raise HTTPException(status_code=403, detail="admin only")
    users = (await db.execute(
        select(User)
        .where(User.status == "active", User.id != _user.id)
        .order_by(User.role, User.email)
    )).scalars().all()
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "label": _user_label(u),
        }
        for u in users
    ]


@router.get("/inbox")
async def list_inbox(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """Active shares targeted at the current user."""
    rows = (await db.execute(
        select(ShareLink, User)
        .join(User, User.id == ShareLink.owner_user_id)
        .where(
            ShareLink.target_user_id == _user.id,
            ShareLink.revoked_at.is_(None),
        )
        .order_by(desc(ShareLink.created_at))
    )).all()
    now = datetime.now(timezone.utc)
    out = []
    for link, owner in rows:
        if link.expires_at and link.expires_at <= now:
            continue
        out.append(_serialize(link, owner=owner, target=_user))
    return out


@router.get("/{token}/views")
async def list_share_views(
    token: str,
    limit: int = Query(100, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    link = (await db.execute(
        select(ShareLink).where(ShareLink.token == token)
    )).scalar_one_or_none()
    if not link or link.owner_user_id != _user.id:
        raise HTTPException(status_code=404)

    rows = (await db.execute(
        select(ShareView)
        .where(ShareView.share_id == link.id)
        .order_by(desc(ShareView.viewed_at))
        .limit(limit)
    )).scalars().all()
    return [
        {
            "id": v.id,
            "ip": str(v.ip) if v.ip else None,
            "country": v.country,
            "region": v.region,
            "city": v.city,
            "user_agent": (v.user_agent or "")[:400],
            "referer": v.referer,
            "viewed_at": v.viewed_at.isoformat(),
        }
        for v in rows
    ]


@router.delete("/{token}")
async def revoke_share(
    token: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    link = (await db.execute(
        select(ShareLink).where(ShareLink.token == token)
    )).scalar_one_or_none()
    if not link or link.owner_user_id != _user.id:
        raise HTTPException(status_code=404)
    link.revoked_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "revoked"}


# ---------------------------------------------------------------------------
# Visitor-side (auth optional; required iff share.target_user_id is set)
# ---------------------------------------------------------------------------
async def _load_active_share(
    db: AsyncSession, token: str, viewer: User | None,
) -> ShareLink:
    link = (await db.execute(
        select(ShareLink).where(ShareLink.token == token)
    )).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404)
    if link.revoked_at is not None:
        raise HTTPException(status_code=410, detail="revoked")
    if link.expires_at and link.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="expired")
    if link.target_user_id is not None:
        # Directed share — must be logged in as that user (or the owner).
        if viewer is None:
            raise HTTPException(status_code=401, detail="login required")
        if viewer.id != link.target_user_id and viewer.id != link.owner_user_id:
            raise HTTPException(status_code=403, detail="not your share")
    return link


async def _record_view(db: AsyncSession, link: ShareLink, request: Request) -> None:
    ip = client_ip(request)
    geo = geoip_lookup(ip) if ip else {}
    ua = request.headers.get("User-Agent")
    referer = request.headers.get("Referer")
    db.add(ShareView(
        share_id=link.id,
        ip=ip,
        country=geo.get("country"),
        region=geo.get("region"),
        city=geo.get("city"),
        user_agent=ua,
        referer=referer,
    ))
    await db.commit()


@router.get("/public/{token}")
async def get_public_share(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    viewer: User | None = Depends(get_optional_user),
) -> dict:
    """Meta + owner display name. Records one view per call.

    For directed shares (target_user_id set), requires Authorization header
    with that user's bearer token.
    """
    link = await _load_active_share(db, token, viewer)
    owner = (await db.execute(
        select(User).where(User.id == link.owner_user_id)
    )).scalar_one_or_none()

    await _record_view(db, link, request)

    view_count = (await db.execute(
        select(func.count()).select_from(ShareView).where(ShareView.share_id == link.id)
    )).scalar() or 0

    return {
        "kind": link.kind,
        "target_id": link.target_id,
        "title": link.title,
        "owner_name": _user_label(owner) if owner else "",
        "expires_at": link.expires_at.isoformat() if link.expires_at else None,
        "created_at": link.created_at.isoformat(),
        "view_count": int(view_count),
        "directed": link.target_user_id is not None,
    }


@router.get("/public/{token}/data")
async def get_public_share_data(
    token: str,
    db: AsyncSession = Depends(get_db),
    viewer: User | None = Depends(get_optional_user),
) -> dict:
    """Return target data from the owner's perspective.

    We reuse the existing service functions but bypass user_filter by
    impersonating the owner identity. Only the specifically shared target
    is returned.
    """
    link = await _load_active_share(db, token, viewer)

    owner = (await db.execute(
        select(User).where(User.id == link.owner_user_id)
    )).scalar_one_or_none()
    if not owner:
        raise HTTPException(status_code=404)

    # Share-link snapshot semantics: cap every downstream read to
    # ``link.created_at`` so a viewer of a 3-week-old share sees what
    # the owner saw 3 weeks ago, not what they're editing today. This
    # is also why we DON'T want the embedded helpers' caches keyed
    # only by user_id — the as_of parameter participates in their
    # cache_key for exactly this isolation.
    as_of = link.created_at

    if link.kind == "timeline":
        from .projects import get_project_conversations
        data = await get_project_conversations(
            project_id=uuid.UUID(link.target_id),
            session_offset=0,
            session_limit=10,
            max_messages_per_session=80,
            order="asc",
            db=db,
            _user=owner,
            as_of=as_of,
        )
        return {"kind": "timeline", "data": data}

    if link.kind == "daily":
        from .daily import get_daily
        data = await get_daily(
            date_str=link.target_id,
            tz_offset=0,
            db=db,
            _user=owner,
            as_of=as_of,
        )
        return {"kind": "daily", "data": data}

    # memory — owner's knowledge graph as of the share creation time.
    # Entities updated AFTER the link was created are excluded; same
    # for relations among them.
    if link.kind == "memory":
        ents = (await db.execute(
            select(KnowledgeEntity)
            .where(
                KnowledgeEntity.user_id == owner.id,
                KnowledgeEntity.updated_at <= as_of,
            )
            .order_by(KnowledgeEntity.updated_at.desc())
            .limit(200)
        )).scalars().all()
        ent_ids = {e.id for e in ents}
        nodes = [
            {
                "id": str(e.id),
                "name": e.name,
                "type": e.entity_type,
                "summary": e.summary,
            }
            for e in ents
        ]
        edges: list[dict] = []
        if ent_ids:
            rels = (await db.execute(
                select(KnowledgeRelation).where(
                    KnowledgeRelation.source_id.in_(ent_ids),
                    KnowledgeRelation.target_id.in_(ent_ids),
                    KnowledgeRelation.created_at <= as_of,
                )
            )).scalars().all()
            edges = [
                {
                    "source": str(r.source_id),
                    "target": str(r.target_id),
                    "type": r.relation_type,
                    "strength": r.strength,
                }
                for r in rels
            ]
        return {
            "kind": "memory",
            "data": {
                "nodes": nodes,
                "edges": edges,
                "total_entities": len(nodes),
                "total_relations": len(edges),
            },
        }

    if link.kind == "conversation":
        from ..db.models import AskConversation, Document, ConversationMessage

        parsed_targets = _parse_conversation_targets(link.target_id)
        if not parsed_targets:
            raise HTTPException(status_code=404, detail="no conversations in share")

        conv_ids = [cid for cid, _ in parsed_targets]

        # 1. Fetch AskConversations
        ask_stmt = (
            select(AskConversation)
            .where(
                AskConversation.id.in_(conv_ids),
                AskConversation.user_id == owner.id,
            )
        )
        ask_results = (await db.execute(ask_stmt)).scalars().all()
        ask_map = {c.id: c for c in ask_results}

        # 2. Fetch Document conversations
        remaining_ids = [cid for cid in conv_ids if cid not in ask_map]
        doc_map = {}
        if remaining_ids:
            doc_stmt = (
                select(Document)
                .where(
                    Document.id.in_(remaining_ids),
                    Document.user_id == owner.id,
                    Document.category == "conversation",
                )
            )
            doc_results = (await db.execute(doc_stmt)).scalars().all()
            doc_map = {d.id: d for d in doc_results}

        conversations_data = []
        for cid, turn_indices in parsed_targets:
            if cid in ask_map:
                c = ask_map[cid]
                raw_turns = c.turns if isinstance(c.turns, list) else []
                # Fallback recovery: if link.title has a prompt excerpt and turn_indices are small relative to a long conversation,
                # resolve to the matching turn in the conversation tail.
                effective_indices = turn_indices
                if turn_indices is not None and len(raw_turns) > 100 and link.title and "提问：" in link.title:
                    target_prompt = link.title.split("提问：", 1)[1].strip().rstrip("...")[:24]
                    if target_prompt:
                        for s_idx in range(len(raw_turns) - 1, max(-1, len(raw_turns) - 150), -1):
                            s_content = (raw_turns[s_idx].get("content") or "")
                            if target_prompt in s_content:
                                if len(turn_indices) == 2 and turn_indices[1] == turn_indices[0] + 1:
                                    effective_indices = [s_idx, s_idx + 1]
                                else:
                                    effective_indices = [s_idx]
                                break

                # If specific turn indices are requested, filter them
                if effective_indices is not None:
                    indexed_raw = [
                        (idx, t) for idx, t in enumerate(raw_turns)
                        if idx in effective_indices and isinstance(t, dict)
                    ]
                else:
                    indexed_raw = [
                        (idx, t) for idx, t in enumerate(raw_turns)
                        if isinstance(t, dict)
                    ]

                turns = []
                for idx, t in indexed_raw:
                    turns.append({
                        "index": idx,
                        "role": t.get("role") or "user",
                        "content": t.get("content") or "",
                        "images": t.get("images") or [],
                        "thinking": t.get("thinking"),
                        "toolCalls": t.get("toolCalls") or [],
                        "sources": t.get("sources") or [],
                        "created_at": t.get("created_at"),
                    })
                conversations_data.append({
                    "id": str(c.id),
                    "title": c.title or "对话",
                    "type": "ask",
                    "tool_id": "ask",
                    "created_at": c.created_at.isoformat() if c.created_at else None,
                    "updated_at": c.updated_at.isoformat() if c.updated_at else None,
                    "message_count": len(turns),
                    "is_partial": turn_indices is not None,
                    "total_original_messages": len(raw_turns),
                    "turns": turns,
                })
            elif cid in doc_map:
                d = doc_map[cid]
                msg_stmt = (
                    select(ConversationMessage)
                    .where(ConversationMessage.document_id == d.id)
                    .order_by(ConversationMessage.line_number)
                )
                messages = (await db.execute(msg_stmt)).scalars().all()
                if turn_indices is not None:
                    indexed_messages = [
                        (idx, m) for idx, m in enumerate(messages)
                        if idx in turn_indices
                    ]
                else:
                    indexed_messages = [
                        (idx, m) for idx, m in enumerate(messages)
                    ]

                turns = [
                    {
                        "index": idx,
                        "role": m.role or "user",
                        "content": m.content,
                        "thinking": m.metadata_.get("thinking") if isinstance(m.metadata_, dict) else None,
                        "toolCalls": [
                            {"name": m.message_type, "args": m.metadata_.get("tool_input")}
                        ] if m.message_type and m.message_type not in ("user", "assistant", "system", "message") else [],
                        "created_at": m.timestamp.isoformat() if m.timestamp else (m.created_at.isoformat() if m.created_at else None),
                    }
                    for idx, m in indexed_messages
                ]
                conversations_data.append({
                    "id": str(d.id),
                    "title": d.title or d.relative_path or "会话",
                    "type": "collected",
                    "tool_id": d.tool_id,
                    "created_at": d.created_at.isoformat() if d.created_at else None,
                    "message_count": len(turns),
                    "is_partial": turn_indices is not None,
                    "total_original_messages": len(messages),
                    "turns": turns,
                })

        if not conversations_data:
            raise HTTPException(status_code=404, detail="shared conversations not found")

        return {
            "kind": "conversation",
            "data": {
                "total_conversations": len(conversations_data),
                "conversations": conversations_data,
            },
        }

    raise HTTPException(status_code=400, detail=f"unknown share kind: {link.kind}")
