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
    """(Re)generate the daily digest for ``target_date``.

    Previously short-circuited if a DailySummary row already existed,
    which made every late-arriving message permanently invisible after
    the 23:30 bake. Now overwrites: a 23:30 snapshot of the day plus a
    03:30 next-day re-bake (see celery_app beat) lets cross-midnight
    syncs roll into the digest.
    """
    async with async_session_factory() as db:
        # Snapshot the docs synced into this calendar day.
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

        # UPSERT — overwrite the existing row instead of skipping. The
        # unique index covers (user_id, summary_date, tool_id), but
        # Postgres treats NULL as distinct in unique indexes, so we
        # can't lean on ON CONFLICT for the (NULL, date, NULL) row;
        # explicit find-then-update is the safe play.
        existing = (await db.execute(
            select(DailySummary).where(
                DailySummary.summary_date == target_date,
                DailySummary.tool_id.is_(None),
                DailySummary.user_id.is_(None),
            )
        )).scalar_one_or_none()
        highlights = {"tool_counts": {k: len(v) for k, v in tool_summaries.items()}}
        if existing is not None:
            existing.title = f"Daily Summary - {target_date}"
            existing.summary = summary_text
            existing.highlights = highlights
            existing.source_document_ids = [d.id for d in docs[:100]]
        else:
            db.add(DailySummary(
                summary_date=target_date,
                tool_id=None,
                title=f"Daily Summary - {target_date}",
                summary=summary_text,
                highlights=highlights,
                source_document_ids=[d.id for d in docs[:100]],
            ))
        await db.commit()


@celery_app.task(
    name="server.tasks.daily_digest.generate_daily_digest",
    autoretry_for=(Exception,),
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=600,
    acks_late=True,
)
def generate_daily_digest(date_str: str | None = None, offset_days: int = 0) -> str:
    """Generate (or regenerate) the daily digest.

    Args:
        date_str: explicit YYYY-MM-DD. If omitted, defaults to today
            shifted by ``offset_days``.
        offset_days: e.g. -1 from the early-morning beat to re-bake
            "yesterday" with messages that synced after the 23:30 bake.
    """
    if date_str:
        target = date.fromisoformat(date_str)
    else:
        target = date.today() + timedelta(days=offset_days)
    asyncio.run(_generate_digest(target))
    return f"Daily digest generated for {target}"
