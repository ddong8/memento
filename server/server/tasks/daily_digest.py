"""Daily digest task — generates a cross-tool daily summary."""

from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select

from collections import defaultdict
from .celery_app import celery_app
from ..db.models import CHAT_MESSAGE, ConversationMessage, DailySummary, Document, User
from ..db.session import async_session_factory
from ..services.ai_summary_service import generate_daily_summary_from_digests
from ..services.user_filter import user_machine_ids

# A day whose report couldn't be (re)written because the model didn't answer is tried again this
# often: the model or the network can be out for a while at night, and the 03:30 re-bake is the
# only pass that picks up the conversations synced after 23:30.
RETRY_DELAY_S = 1800
RETRIES = 3


async def _generate_digest(target_date: date, user_ids: list[str] | None = None) -> list[str]:
    """(Re)generate the daily digest for ``target_date`` for every active user (or those in user_ids).
    Returns the users whose report wasn't written because a summary failed, to try again later."""
    tz_cst = timezone(timedelta(hours=8))
    day_start = datetime(target_date.year, target_date.month, target_date.day, tzinfo=tz_cst)
    day_end = day_start + timedelta(days=1)
    pending: list[str] = []

    async with async_session_factory() as db:
        users_q = select(User).where(User.status == "active")
        if user_ids:
            users_q = users_q.where(User.id.in_([uuid.UUID(u) for u in user_ids]))
        users = (await db.execute(users_q)).scalars().all()
        for user in users:
            mids = await user_machine_ids(db, user)
            gen_q = (
                select(ConversationMessage)
                .join(Document, ConversationMessage.document_id == Document.id)
                .where(
                    ConversationMessage.timestamp >= day_start,
                    ConversationMessage.timestamp < day_end,
                    CHAT_MESSAGE,
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

            existing = (await db.execute(
                select(DailySummary).where(
                    DailySummary.summary_date == target_date,
                    DailySummary.tool_id.is_(None),
                    DailySummary.user_id == user.id,
                )
            )).scalar_one_or_none()
            # Re-baking a day that has a report (03:30): if the model can't be reached for some conversations,
            # they would go in as their first 300 characters over the 23:30 report. Keep that one instead.
            summary_text = await generate_daily_summary_from_digests(
                target_date, conv_data, require_complete=existing is not None
            )
            if not summary_text:
                pending.append(str(user.id))
                continue
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
    return pending


@celery_app.task(
    name="server.tasks.daily_digest.generate_daily_digest",
    autoretry_for=(Exception,),
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=600,
    acks_late=True,
)
def generate_daily_digest(
    date_str: str | None = None, offset_days: int = 0, user_ids: list[str] | None = None, attempt: int = 0,
) -> str:
    """Generate (or regenerate) the daily digest."""
    if date_str:
        target = date.fromisoformat(date_str)
    else:
        tz_cst = timezone(timedelta(hours=8))
        target = datetime.now(tz_cst).date() + timedelta(days=offset_days)
    pending = asyncio.run(_generate_digest(target, user_ids))
    if pending and attempt < RETRIES:
        generate_daily_digest.apply_async(
            kwargs={"date_str": target.isoformat(), "user_ids": pending, "attempt": attempt + 1},
            countdown=RETRY_DELAY_S,
        )
        return f"Daily digest for {target}: {len(pending)} user(s) to retry in {RETRY_DELAY_S}s"
    return f"Daily digest generated for {target}"
