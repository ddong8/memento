"""Access logging middleware — records document/page views to audit log."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AccessLog


async def log_access(
    db: AsyncSession,
    request: Request,
    action: str,
    user_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
) -> None:
    """Record an access event in the audit log."""
    log = AccessLog(
        user_id=user_id,
        document_id=document_id,
        action=action,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        metadata_={"path": str(request.url.path), "method": request.method},
    )
    db.add(log)
