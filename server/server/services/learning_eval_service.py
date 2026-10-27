"""Weekly learning eval: does the user have to correct the AI less over time?

Retrieval has its own frozen question set (eval_service). This one measures the
outcome the learning loop is for, with the yardstick fixed on 2026-10-27:

- prompts: the user's own messages in the week, deduplicated by content
  (resent and resumed messages count once), the denominator for everything;
- corrections / learned per 100 prompts: correction moments, and those that
  corrected a rule Memento had already learned (CorrectionEvent.already_learned);
- rules: accepted at least 7 days before the week ended, how often each was
  corrected per week before acceptance and after it (pooled over rules), and
  in the week itself how many corrections hit an accepted rule;
- guard: the completion check's claims in the week (guard_service).

Weeks are recomputed while transcripts arrive late and corrections are rescored,
so a stored week is the latest view of it, not a snapshot.
"""

from __future__ import annotations

import statistics
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import distinct, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, CorrectionEvent, CorrectionTopic, Document, LearningEval, Machine, User
from .dreaming_service import SUBAGENT_PATH_REGEX
from .guard_service import guard_stats

USER_MESSAGE_TYPES = ("user", "USER_INPUT", "message")
RULE_SETTLE = timedelta(days=7)  # a rule is judged once it has had a week to take hold
MIN_PROMPTS = 30  # weeks with fewer prompts say little and aren't compared
BACKFILL_WEEKS = 9
RECOMPUTE_WEEKS = 4
# Alert when the latest week is this much above the median of the 4 weeks before it
LEARNED_RISE = 1.5
LEARNED_MIN_POINTS = 1.0  # and at least this many more per 100 prompts
RULE_RISE = 1.5
RULE_MIN_EVENTS = 3


def _tz(user: User) -> timezone:
    try:
        hours = float((user.proactive_settings or {}).get("timezone_offset_hours", 8))
    except (TypeError, ValueError):
        hours = 8
    return timezone(timedelta(hours=hours))


def week_start(at: datetime, tz: timezone) -> date:
    local = at.astimezone(tz).date()
    return local - timedelta(days=local.weekday())


def week_bounds(week: date, tz: timezone) -> tuple[datetime, datetime]:
    start = datetime.combine(week, time(0), tz)
    return start, start + timedelta(days=7)


def _per100(n: int, prompts: int) -> float | None:
    return round(100 * n / prompts, 2) if prompts else None


async def count_prompts(db: AsyncSession, user_id: uuid.UUID, start: datetime, end: datetime) -> int:
    machines = select(Machine.id).where(Machine.user_id == user_id)
    content = ConversationMessage.content
    q = (
        select(func.count(distinct(func.md5(func.left(content, 500)))))
        .select_from(ConversationMessage)
        .join(Document, Document.id == ConversationMessage.document_id)
        .where(
            Document.machine_id.in_(machines),
            ConversationMessage.role == "user",
            func.coalesce(ConversationMessage.message_type, "").in_(USER_MESSAGE_TYPES),
            ConversationMessage.timestamp >= start,
            ConversationMessage.timestamp < end,
            content.op("!~")(r"^\s*<"),
            ~content.contains("tool_result"),
            ~content.startswith("[Result]"),
            Document.relative_path.op("!~")(SUBAGENT_PATH_REGEX),
            ~func.coalesce(Document.metadata_.has_key("parent_session_id"), False),
        )
    )
    return int((await db.execute(q)).scalar() or 0)


def rule_metrics(rows: list[tuple[Any, ...]], start: datetime, end: datetime) -> dict[str, Any]:
    """rows: (topic_id, statement, status, accepted_at, said_at) for every event of
    a non-dismissed topic said before `end`. Pure, so the yardstick is testable."""
    topics: dict[Any, dict[str, Any]] = {}
    week_events = week_learned_rule = 0
    in_week_by_topic: dict[Any, int] = {}
    for topic_id, statement, status, accepted_at, said_at in rows:
        accepted = status == "accepted" and accepted_at is not None
        if start <= said_at < end:
            week_events += 1
            if accepted and said_at >= accepted_at:
                week_learned_rule += 1
                in_week_by_topic[topic_id] = in_week_by_topic.get(topic_id, 0) + 1
        if not accepted or accepted_at >= end - RULE_SETTLE:
            continue
        t = topics.setdefault(topic_id, {"statement": statement, "accepted_at": accepted_at, "first": said_at, "before": 0, "after": 0})
        t["first"] = min(t["first"], said_at)
        if said_at < accepted_at:
            t["before"] += 1
        else:
            t["after"] += 1

    week = timedelta(days=7)
    before_weeks = sum((t["accepted_at"] - min(t["first"], t["accepted_at"])) / week for t in topics.values())
    after_weeks = sum((end - t["accepted_at"]) / week for t in topics.values())
    before = sum(t["before"] for t in topics.values())
    after = sum(t["after"] for t in topics.values())
    statements = {tid: st for tid, st, *_ in rows}
    stubborn = sorted(in_week_by_topic.items(), key=lambda kv: kv[1], reverse=True)[:5]
    return {
        "week_corrections": week_events,
        "week_on_accepted": week_learned_rule,
        "rules": len(topics),
        "rules_never_again": sum(1 for t in topics.values() if t["after"] == 0),
        "before_per_rule_week": round(before / before_weeks, 2) if before_weeks > 0 else None,
        "after_per_rule_week": round(after / after_weeks, 2) if after_weeks > 0 else None,
        # The week alone: corrections of settled rules per settled rule
        "week_per_rule": round(sum(n for tid, n in in_week_by_topic.items() if tid in topics) / len(topics), 3) if topics else None,
        "stubborn": [{"statement": (statements.get(tid) or "")[:120], "times": n} for tid, n in stubborn],
    }


async def measure_week(db: AsyncSession, user: User, week: date) -> dict[str, Any]:
    start, end = week_bounds(week, _tz(user))
    prompts = await count_prompts(db, user.id, start, end)
    learned = (await db.execute(
        select(func.count())
        .select_from(CorrectionEvent)
        .join(CorrectionTopic, CorrectionTopic.id == CorrectionEvent.topic_id)
        .where(
            CorrectionEvent.user_id == user.id,
            CorrectionEvent.said_at >= start,
            CorrectionEvent.said_at < end,
            CorrectionEvent.already_learned.is_(True),
            CorrectionTopic.status != "dismissed",
        )
    )).scalar() or 0
    rows = (await db.execute(
        select(CorrectionEvent.topic_id, CorrectionTopic.statement, CorrectionTopic.status,
               CorrectionTopic.accepted_at, CorrectionEvent.said_at)
        .join(CorrectionTopic, CorrectionTopic.id == CorrectionEvent.topic_id)
        .where(
            CorrectionEvent.user_id == user.id,
            CorrectionEvent.said_at < end,
            CorrectionTopic.status != "dismissed",
        )
    )).all()
    rules = rule_metrics([tuple(r) for r in rows], start, end)
    corrections = rules.pop("week_corrections")
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "prompts": prompts,
        "corrections": corrections,
        "learned": int(learned),
        "corrections_per_100": _per100(corrections, prompts),
        "learned_per_100": _per100(int(learned), prompts),
        **rules,
        "guard": await guard_stats(db, user.id, start, end),
    }


async def save_week(db: AsyncSession, user: User, week: date, trigger: str) -> dict[str, Any]:
    metrics = await measure_week(db, user, week)
    stmt = pg_insert(LearningEval).values(
        id=uuid.uuid4(), user_id=user.id, week=week, metrics=metrics, trigger=trigger,
    ).on_conflict_do_update(
        constraint="uq_learning_eval_user_week",
        set_={"metrics": metrics, "trigger": trigger, "updated_at": func.now()},
    )
    await db.execute(stmt)
    await db.commit()
    return metrics


async def run_learning_eval(db: AsyncSession, user: User, trigger: str = "scheduled", now: datetime | None = None) -> list[date]:
    """Score the finished weeks: the last few again (late transcripts, rescored
    corrections), or the last BACKFILL_WEEKS on the first run."""
    now = now or datetime.now(timezone.utc)
    this_week = week_start(now, _tz(user))
    have = (await db.execute(select(func.count()).select_from(LearningEval).where(LearningEval.user_id == user.id))).scalar() or 0
    n = RECOMPUTE_WEEKS if have else BACKFILL_WEEKS
    weeks = [this_week - timedelta(weeks=i) for i in range(n, 0, -1)]
    for w in weeks:
        await save_week(db, user, w, trigger if have else "backfill")
    return weeks


async def recent_weeks(db: AsyncSession, user: User, limit: int = 12) -> list[LearningEval]:
    return list((await db.execute(
        select(LearningEval).where(LearningEval.user_id == user.id).order_by(LearningEval.week.desc()).limit(limit)
    )).scalars().all())


def regression(weeks: list[LearningEval]) -> dict[str, Any] | None:
    """The latest week against the median of up to 4 weeks before it (newest first),
    weeks with too few prompts left out. Against a median, not the previous week:
    one quiet week shouldn't make the next one look like a regression."""
    usable = [w for w in weeks if (w.metrics or {}).get("prompts", 0) >= MIN_PROMPTS]
    if len(usable) < 3 or usable[0] is not weeks[0]:
        return None
    latest, earlier = usable[0].metrics, [w.metrics for w in usable[1:5]]

    def median(key: str) -> float | None:
        vals = [m.get(key) for m in earlier if isinstance(m.get(key), (int, float))]
        return statistics.median(vals) if vals else None

    now, was = latest.get("learned_per_100"), median("learned_per_100")
    if isinstance(now, (int, float)) and was is not None and now - was >= LEARNED_MIN_POINTS and now >= LEARNED_RISE * was:
        return {"metric": "learned_per_100", "now": now, "was": round(was, 2), "week": str(usable[0].week)}
    now, was = latest.get("week_per_rule"), median("week_per_rule")
    if (isinstance(now, (int, float)) and was is not None and latest.get("week_on_accepted", 0) >= RULE_MIN_EVENTS
            and now > 0 and now >= RULE_RISE * max(was, 0.01)):
        return {"metric": "week_per_rule", "now": now, "was": round(was, 3), "week": str(usable[0].week)}
    return None


def regression_text(drop: dict[str, Any]) -> str:
    if drop["metric"] == "learned_per_100":
        return (f"{drop['week']} 那周每 100 次提问里有 {drop['now']} 次在纠正已经学会的规矩，"
                f"前几周中位数是 {drop['was']}。")
    return (f"{drop['week']} 那周已采纳的规矩平均每条被纠正 {drop['now']} 次，"
            f"前几周中位数是 {drop['was']}。")


async def outcome_summary(db: AsyncSession, user: User) -> dict[str, Any]:
    weeks = await recent_weeks(db, user)
    latest = weeks[0] if weeks else None
    return {
        "latest": {"week": str(latest.week), **(latest.metrics or {})} if latest else None,
        "stale": bool(latest and latest.updated_at and datetime.now(timezone.utc) - latest.updated_at > timedelta(days=10)),
        "trend": [
            {
                "week": str(w.week),
                "prompts": (w.metrics or {}).get("prompts"),
                "corrections_per_100": (w.metrics or {}).get("corrections_per_100"),
                "learned_per_100": (w.metrics or {}).get("learned_per_100"),
                "week_per_rule": (w.metrics or {}).get("week_per_rule"),
                "unchecked_rate": ((w.metrics or {}).get("guard") or {}).get("unchecked_rate"),
            }
            for w in reversed(weeks)
        ],
        "regression": regression(weeks),
    }
