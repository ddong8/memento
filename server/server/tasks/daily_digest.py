"""Daily digest task — generates a cross-tool daily summary."""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from collections import defaultdict
from .celery_app import celery_app
from ..db.models import ConversationMessage, DailySummary, Document, User
from ..db.session import async_session_factory
from ..services.ai_summary_service import generate_daily_summary_from_digests
from ..services.user_filter import user_machine_ids


async def _generate_digest(target_date: date) -> None:
    """(Re)generate the daily digest for ``target_date`` for every active user."""
    tz_cst = timezone(timedelta(hours=8))
    day_start = datetime(target_date.year, target_date.month, target_date.day, tzinfo=tz_cst)
    day_end = day_start + timedelta(days=1)

    async with async_session_factory() as db:
        users = (await db.execute(select(User).where(User.status == "active"))).scalars().all()
        for user in users:
            mids = await user_machine_ids(db, user)
            gen_q = (
                select(ConversationMessage)
                .join(Document, ConversationMessage.document_id == Document.id)
                .where(
                    ConversationMessage.timestamp >= day_start,
                    ConversationMessage.timestamp < day_end,
                    ConversationMessage.role.in_(["user", "assistant"]),
                    ~ConversationMessage.content.like("[Result]%"),
                    ~ConversationMessage.content.like("[Tool:%"),
                    ~Document.relative_path.like("%/subagents/%"),
                )
            )
            if mids is not None:
                gen_q = gen_q.where(Document.machine_id.in_(mids))
            gen_q = gen_q.order_by(ConversationMessage.timestamp)
            messages = (await db.execute(gen_q)).scalars().all()
            if not messages:
                continue

            msgs_by_doc: dict[str, list] = defaultdict(list)
            for m in messages:
                msgs_by_doc[str(m.document_id)].append(m)

            doc_ids = [m.document_id for m in messages]
            doc_rows = (await db.execute(select(Document).where(Document.id.in_(set(doc_ids))))).scalars().all()
            doc_map = {str(d.id): d for d in doc_rows}

            conv_data = []
            tool_counts: dict[str, int] = {}
            for doc_id, doc_msgs in msgs_by_doc.items():
                d = doc_map.get(doc_id)
                tool_id = d.tool_id if d else "unknown"
                title = (d.title if d else doc_id) or doc_id
                tool_counts[tool_id] = tool_counts.get(tool_id, 0) + 1
                parts = []
                for m in doc_msgs:
                    prefix = "👤 用户" if m.role == "user" else "🤖 AI"
                    text = (m.content or "")[:800]
                    if text:
                        parts.append(f"{prefix}: {text}")
                conv_data.append({
                    "tool_id": tool_id,
                    "title": title,
                    "digest": "\n".join(parts),
                })

            summary_text = await generate_daily_summary_from_digests(target_date, conv_data)
            if not summary_text:
                continue

            existing = (await db.execute(
                select(DailySummary).where(
                    DailySummary.summary_date == target_date,
                    DailySummary.tool_id.is_(None),
                    DailySummary.user_id == user.id,
                )
            )).scalar_one_or_none()
            highlights = {"tool_counts": tool_counts}
            date_str = target_date.isoformat()
            if existing is not None:
                existing.title = f"AI 日报 - {date_str}"
                existing.summary = summary_text
                existing.highlights = highlights
                existing.source_document_ids = [d.id for d in doc_rows[:100]]
            else:
                db.add(DailySummary(
                    user_id=user.id,
                    summary_date=target_date,
                    tool_id=None,
                    title=f"AI 日报 - {date_str}",
                    summary=summary_text,
                    highlights=highlights,
                    source_document_ids=[d.id for d in doc_rows[:100]],
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
    """Generate (or regenerate) the daily digest."""
    if date_str:
        target = date.fromisoformat(date_str)
    else:
        tz_cst = timezone(timedelta(hours=8))
        target = datetime.now(tz_cst).date() + timedelta(days=offset_days)
    asyncio.run(_generate_digest(target))
    return f"Daily digest generated for {target}"
