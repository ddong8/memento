"""Audit trail of who did what: sign-ins, account and permission changes, remote commands, settings.

Entries go into access_logs (the table the admin audit log page reads) with the actor in user_id,
the action name in action and the particulars in metadata. They're kept for
MEMENTO_AUDIT_RETENTION_DAYS (tasks/audit_retention.py removes older ones).

Recording never fails the request it belongs to: an error is logged and the action goes on.
"""

from __future__ import annotations

import logging
import uuid
from contextvars import ContextVar
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AccessLog

logger = logging.getLogger("server.audit")

# The request being served (set by the middleware in main.py), for the client address and agent
_request: ContextVar[Any] = ContextVar("memento_audit_request", default=None)


def bind_request(request) -> object:
    return _request.set(request)


def unbind_request(token) -> None:
    _request.reset(token)


def _client(request) -> tuple[str | None, str | None]:
    if request is None:
        return None, None
    try:
        from . import rate_limit
        ip = rate_limit.client_ip(request)
    except Exception:
        ip = request.client.host if getattr(request, "client", None) else None
    return ip, request.headers.get("user-agent")


async def record(
    db: AsyncSession,
    actor,
    action: str,
    *,
    target_user_id: uuid.UUID | str | None = None,
    detail: dict | None = None,
    request=None,
    commit: bool = False,
) -> None:
    try:
        req = request if request is not None else _request.get()
        ip, ua = _client(req)
        meta: dict = {"audit": True}
        if actor is not None:
            meta["actor_email"] = getattr(actor, "email", None)
            meta["actor_role"] = getattr(actor, "role", None)
        if target_user_id is not None:
            meta["target_user_id"] = str(target_user_id)
        if detail:
            meta.update(detail)
        if req is not None:
            meta.setdefault("path", str(req.url.path))
            meta.setdefault("method", req.method)
        db.add(AccessLog(
            user_id=getattr(actor, "id", None),
            action=action,
            ip_address=(ip or "")[:45] or None,
            user_agent=ua,
            metadata_=meta,
        ))
        if commit:
            await db.commit()
        else:
            await db.flush()
    except Exception:
        logger.exception("couldn't record audit entry %s", action)
