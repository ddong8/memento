"""Async summary generation tasks."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .celery_app import celery_app
from ..db.models import Document
from ..db.session import async_session_factory
from ..services.summary_service import generate_document_summary


async def _generate_summary(document_id: str) -> None:
    async with async_session_factory() as db:
        result = await db.execute(
            select(Document).where(Document.id == uuid.UUID(document_id))
        )
        doc = result.scalar_one_or_none()
        if not doc or not doc.content:
            return

        # Skip if already has a recent summary
        if doc.ai_summary and doc.ai_summary_generated_at:
            age = (datetime.now(timezone.utc) - doc.ai_summary_generated_at).total_seconds()
            if age < 3600:  # Don't re-generate within 1 hour
                return

        summary = generate_document_summary(
            title=doc.title or doc.relative_path,
            content=doc.content[:50000],
            tool_name=doc.tool_id,
            category=doc.category,
        )

        if summary:
            doc.ai_summary = summary
            doc.ai_summary_generated_at = datetime.now(timezone.utc)
            await db.commit()


@celery_app.task(
    name="server.tasks.summary_tasks.generate_document_summary_task",
    autoretry_for=(Exception,),
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=600,
    acks_late=True,
)
def generate_document_summary_task(document_id: str) -> str:
    """Celery task wrapper for async summary generation."""
    asyncio.run(_generate_summary(document_id))
    return f"Summary generated for {document_id}"
