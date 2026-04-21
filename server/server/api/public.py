"""Public API — no authentication required. Used by the marketing landing page.

Exposes lightweight aggregate counts. Intentionally omits any per-user /
per-device detail so leaking them is low-risk for self-hosted instances.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, Document, Machine
from ..db.session import get_db

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/stats")
async def public_stats(db: AsyncSession = Depends(get_db)) -> dict:
    """Aggregate counts displayed on the public landing page."""
    total_documents = (await db.execute(
        select(func.count(Document.id)).where(Document.tool_id != "system")
    )).scalar() or 0
    total_messages = (await db.execute(
        select(func.count(ConversationMessage.id))
    )).scalar() or 0
    total_devices = (await db.execute(
        select(func.count(Machine.id))
    )).scalar() or 0
    total_tools = (await db.execute(
        select(func.count(func.distinct(Document.tool_id)))
        .where(Document.tool_id != "system")
    )).scalar() or 0

    return {
        "total_documents": int(total_documents),
        "total_messages": int(total_messages),
        "total_devices": int(total_devices),
        "total_tools": int(total_tools),
    }
