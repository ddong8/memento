"""Daily digest task — generates a cross-tool daily summary."""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .celery_app import celery_app
from ..db.models import DailySummary, Document
from ..db.session import async_session_factory
from ..services.summary_service import generate_daily_summary


async def _generate_digest(target_date: date) -> None:
    async with async_session_factory() as db:
        # Check if summary already exists
        existing = await db.execute(
            select(DailySummary).where(
                DailySummary.summary_date == target_date,
                DailySummary.tool_id.is_(None),
            )
        )
        if existing.scalar_one_or_none():
            return  # Already generated

        # Get all documents synced on the target date
        start = datetime(target_date.year, target_date.month, target_date.day, tzinfo=timezone.utc)
        end = start + timedelta(days=1)

        result = await db.execute(
            select(Document)
            .where(Document.synced_at >= start, Document.synced_at < end)
            .order_by(Document.synced_at)
        )
        docs = result.scalars().all()

        if not docs:
            return

        # Group by tool
        tool_summaries: dict[str, list[dict]] = {}
        for d in docs:
            tool_summaries.setdefault(d.tool_id, []).append({
                "title": d.title or d.relative_path,
                "category": d.category,
                "content": (d.content or "")[:1000],
                "ai_summary": d.ai_summary,
            })

        # Generate cross-tool summary
        summary_text = generate_daily_summary(str(target_date), tool_summaries)
        if not summary_text:
            return

        # Store
        daily = DailySummary(
            summary_date=target_date,
            tool_id=None,
            title=f"Daily Summary - {target_date}",
            summary=summary_text,
            highlights={"tool_counts": {k: len(v) for k, v in tool_summaries.items()}},
            source_document_ids=[d.id for d in docs[:100]],
        )
        db.add(daily)
        await db.commit()


@celery_app.task(
    name="server.tasks.daily_digest.generate_daily_digest",
    autoretry_for=(Exception,),
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=600,
    acks_late=True,
)
def generate_daily_digest(date_str: str | None = None) -> str:
    """Generate the daily digest. Defaults to today."""
    target = date.fromisoformat(date_str) if date_str else date.today()
    asyncio.run(_generate_digest(target))
    return f"Daily digest generated for {target}"
