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

router = APIRouter(prefix="/api/share", tags=["share"])

VALID_KINDS = ("timeline", "daily", "memory")


def _gen_token() -> str:
    """24 bytes → 40-char unpadded base32, URL-safe, copy-pasteable."""
    raw = secrets.token_bytes(24)
    return base64.b32encode(raw).decode("ascii").rstrip("=").lower()


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
def _client_ip(request: Request) -> str | None:
    """Prefer X-Forwarded-For from our nginx; fall back to socket peer."""
    xff = request.headers.get("X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    xr = request.headers.get("X-Real-IP")
    if xr:
        return xr.strip()
    return request.client.host if request.client else None


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
    ip = _client_ip(request)
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

    raise HTTPException(status_code=400, detail=f"unknown share kind: {link.kind}")
