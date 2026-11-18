"""SCIM 2.0 user provisioning (RFC 7643 / 7644), the part identity providers use for accounts.

The company's identity provider (Okta, Azure AD / Entra ID, Authing, Keycloak with a SCIM plugin,
...) creates an account when someone joins and deactivates it when they leave. Base URL:
{public_url}/api/scim/v2, authenticated by `Authorization: Bearer <MEMENTO_SCIM_TOKEN>`.

Deactivating (active=false, or DELETE) disables the account rather than deleting it: sign-in, the
API and the user's devices stop working at once, and their data stays for audit and handover
(an owner can still delete it from the admin page).
"""

from __future__ import annotations

import re
import secrets
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import User
from ..db.session import get_db
from ..services import audit_service

router = APIRouter(prefix="/api/scim/v2", tags=["scim"])

USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"
PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
MEDIA = "application/scim+json"


def _scim_error(status: int, detail: str, scim_type: str | None = None) -> HTTPException:
    body = {"schemas": [ERROR_SCHEMA], "status": str(status), "detail": detail}
    if scim_type:
        body["scimType"] = scim_type
    return HTTPException(status_code=status, detail=body)


async def require_scim(authorization: str = Header(None)) -> None:
    token = settings.scim_token
    if not token:
        raise HTTPException(status_code=404, detail="SCIM not enabled")
    if not authorization or not authorization.startswith("Bearer ") \
            or not secrets.compare_digest(authorization[7:].strip(), token):
        raise _scim_error(401, "invalid token")


def _resp(body: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, media_type=MEDIA)


def to_scim(u: User, request: Request | None = None) -> dict:
    name = u.name or ""
    body = {
        "schemas": [USER_SCHEMA],
        "id": str(u.id),
        "userName": u.email,
        "displayName": name,
        "name": {"formatted": name},
        "emails": [{"value": u.email, "primary": True, "type": "work"}],
        "active": u.status == "active",
        "meta": {
            "resourceType": "User",
            "created": u.created_at.isoformat() if u.created_at else None,
            "lastModified": (u.updated_at or u.created_at).isoformat() if (u.updated_at or u.created_at) else None,
        },
    }
    if request is not None:
        body["meta"]["location"] = str(request.url_for("scim_get_user", user_id=str(u.id)))
    return body


def _email_of(body: dict) -> str:
    email = (body.get("userName") or "").strip()
    if "@" not in email:
        for e in body.get("emails") or []:
            if isinstance(e, dict) and "@" in (e.get("value") or ""):
                email = e["value"].strip()
                if e.get("primary"):
                    break
    return email.lower()


def _name_of(body: dict) -> str | None:
    n = body.get("name") or {}
    return body.get("displayName") or n.get("formatted") or \
        " ".join(p for p in (n.get("givenName"), n.get("familyName")) if p) or None


def _bool(v) -> bool:
    return v if isinstance(v, bool) else str(v).strip().lower() == "true"


async def _set_active(db: AsyncSession, u: User, active: bool) -> None:
    if u.role == "owner" and not active:
        others = (await db.execute(select(User.id).where(
            User.role == "owner", User.status == "active", User.id != u.id).limit(1))).scalar_one_or_none()
        if others is None:
            raise _scim_error(400, "cannot deactivate the only owner")
    before = u.status
    u.status = "active" if active else "disabled"
    if active and u.role == "pending":
        u.role = "viewer"
    if active and not u.collector_token:
        u.collector_token = secrets.token_hex(32)
    if before != u.status:
        await audit_service.record(db, None, "scim.user.activate" if active else "scim.user.deactivate",
                                   target_user_id=u.id, detail={"email": u.email})


async def _user(db: AsyncSession, user_id: str) -> User:
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise _scim_error(404, "user not found")
    u = await db.get(User, uid)
    if u is None:
        raise _scim_error(404, "user not found")
    return u


@router.get("/ServiceProviderConfig", dependencies=[Depends(require_scim)])
async def service_provider_config() -> JSONResponse:
    return _resp({
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        "patch": {"supported": True},
        "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
        "filter": {"supported": True, "maxResults": 200},
        "changePassword": {"supported": False},
        "sort": {"supported": False},
        "etag": {"supported": False},
        "authenticationSchemes": [{"type": "oauthbearertoken", "name": "Bearer token", "primary": True}],
    })


@router.get("/ResourceTypes", dependencies=[Depends(require_scim)])
async def resource_types() -> JSONResponse:
    return _resp({"schemas": [LIST_SCHEMA], "totalResults": 1, "Resources": [{
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        "id": "User", "name": "User", "endpoint": "/Users", "schema": USER_SCHEMA,
    }]})


_FILTER = re.compile(r'^\s*(userName|emails(?:\.value)?|externalId|id)\s+eq\s+"([^"]*)"\s*$', re.I)


@router.get("/Users", dependencies=[Depends(require_scim)])
async def list_users(
    request: Request,
    filter: str | None = None,
    startIndex: int = 1,
    count: int = 100,
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    q = select(User)
    if filter:
        m = _FILTER.match(filter)
        if not m:
            raise _scim_error(400, "only `userName eq \"...\"` style filters are supported", "invalidFilter")
        attr, value = m.group(1).lower(), m.group(2)
        if attr == "id":
            try:
                q = q.where(User.id == uuid.UUID(value))
            except ValueError:
                q = q.where(False)
        else:
            q = q.where(func.lower(User.email) == value.lower())
    start = max(1, startIndex)
    count = max(0, min(count, 200))
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    rows = (await db.execute(q.order_by(User.created_at).offset(start - 1).limit(count))).scalars().all()
    return _resp({
        "schemas": [LIST_SCHEMA], "totalResults": total, "startIndex": start, "itemsPerPage": len(rows),
        "Resources": [to_scim(u, request) for u in rows],
    })


@router.get("/Users/{user_id}", name="scim_get_user", dependencies=[Depends(require_scim)])
async def get_user(user_id: str, request: Request, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    return _resp(to_scim(await _user(db, user_id), request))


@router.post("/Users", dependencies=[Depends(require_scim)])
async def create_user(request: Request, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    body = await request.json()
    email = _email_of(body)
    if "@" not in email:
        raise _scim_error(400, "userName or emails must hold an email address", "invalidValue")
    if (await db.execute(select(User).where(func.lower(User.email) == email))).scalar_one_or_none():
        raise _scim_error(409, "user already exists", "uniqueness")
    active = _bool(body.get("active", True))
    u = User(
        email=email,
        name=_name_of(body) or email.split("@")[0],
        hashed_password=None,
        role="viewer",
        status="active" if active else "disabled",
        collector_token=secrets.token_hex(32),
    )
    db.add(u)
    await db.flush()
    await audit_service.record(db, None, "scim.user.create", target_user_id=u.id, detail={"email": email, "active": active})
    await db.refresh(u)
    return _resp(to_scim(u, request), 201)


@router.put("/Users/{user_id}", dependencies=[Depends(require_scim)])
async def replace_user(user_id: str, request: Request, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    u = await _user(db, user_id)
    body = await request.json()
    name = _name_of(body)
    if name:
        u.name = name
    if "active" in body:
        await _set_active(db, u, _bool(body["active"]))
    await db.flush()
    await db.refresh(u)
    return _resp(to_scim(u, request))


@router.patch("/Users/{user_id}", dependencies=[Depends(require_scim)])
async def patch_user(user_id: str, request: Request, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    u = await _user(db, user_id)
    body = await request.json()
    for op in body.get("Operations") or []:
        kind = (op.get("op") or "").lower()
        if kind not in ("replace", "add"):
            continue
        path = (op.get("path") or "").strip()
        value = op.get("value")
        # {"path": "active", "value": false} or {"value": {"active": false, "displayName": ...}}
        changes = {path: value} if path else (value if isinstance(value, dict) else {})
        for key, val in changes.items():
            k = key.lower()
            if k == "active":
                await _set_active(db, u, _bool(val))
            elif k in ("displayname", "name.formatted") and val:
                u.name = str(val)
            elif k == "name" and isinstance(val, dict):
                u.name = _name_of({"name": val}) or u.name
    await db.flush()
    await db.refresh(u)
    return _resp(to_scim(u, request))


@router.delete("/Users/{user_id}", status_code=204, dependencies=[Depends(require_scim)])
async def delete_user(user_id: str, db: AsyncSession = Depends(get_db)):
    u = await _user(db, user_id)
    await _set_active(db, u, False)
    from fastapi import Response
    return Response(status_code=204)
