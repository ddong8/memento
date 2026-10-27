"""Completion check: the Stop hook the collector installs in Claude Code and Codex.

When the AI says it is done / fixed / live, the collector looks at what it ran
since its last change (packages/daemon/src/guard.ts) and sends it back to check
if nothing did. The decision is local; here we keep the switch, each device's
install status and the record of claims, so the learning page and the weekly
learning eval can show how often a claim had no check behind it.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import GuardEvent, Machine, User

GUARD_TOOLS = ("claude_code", "codex")
OUTCOMES = ("verified", "no_evidence", "failed_check", "disclosed", "unread")
SETTING = "completion_guard"


def guard_enabled(user: User) -> bool:
    """On unless turned off: outcome rules the user set ("自测后再交付") hold everywhere."""
    return (user.proactive_settings or {}).get(SETTING, True) is not False


def guard_tools(user: User, machine: Machine) -> list[str]:
    """The tools on this device whose Stop hook should be installed: the ones the
    profile is injected into, so turning a tool off there removes the hook too."""
    if not guard_enabled(user):
        return []
    targets = machine.profile_targets or []
    return [t for t in GUARD_TOOLS if t in targets]


def _parse_at(raw: object) -> datetime:
    if isinstance(raw, str):
        try:
            at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if at.tzinfo is None:
                at = at.replace(tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            # A device clock far off can't put events in the future or years back
            if now - timedelta(days=30) <= at <= now + timedelta(minutes=10):
                return at
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def _text(raw: object, limit: int) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip()
    return s[:limit] or None


def event_rows(user: User, machine: Machine, events: list[dict]) -> list[GuardEvent]:
    rows = []
    for e in events[:50]:
        tool, outcome = e.get("tool"), e.get("outcome")
        if tool not in GUARD_TOOLS or outcome not in OUTCOMES:
            continue
        rows.append(GuardEvent(
            user_id=user.id,
            machine_id=machine.id,
            tool=tool,
            session_id=_text(e.get("session_id"), 100),
            outcome=outcome,
            blocked=bool(e.get("blocked")),
            followup=bool(e.get("followup")),
            deploy=bool(e.get("deploy")),
            claim=_text(e.get("claim"), 200),
            check=_text(e.get("check"), 200),
            cwd=_text(e.get("cwd"), 300),
            said_at=_parse_at(e.get("at")),
        ))
    return rows


def set_status(machine: Machine, results: dict) -> None:
    """Kept beside the profile injection status; report_injection carries it over."""
    status = dict(machine.profile_status or {})
    status["guards"] = {
        "results": {k: str(v)[:200] for k, v in results.items() if k in GUARD_TOOLS or k == "codex_trust"},
        "reported_at": datetime.now(timezone.utc).isoformat(),
    }
    machine.profile_status = status


async def guard_stats(db: AsyncSession, user_id: uuid.UUID, since: datetime, until: datetime | None = None) -> dict:
    """Claims in a window. A first stop is the AI's own claim; a followup is the
    stop right after it was sent back, which shows whether being sent back helped."""
    first = GuardEvent.followup.is_(False)
    q = select(
        func.count().filter(first).label("claims"),
        func.count().filter(first, GuardEvent.outcome == "verified").label("verified"),
        func.count().filter(first, GuardEvent.outcome == "disclosed").label("disclosed"),
        func.count().filter(first, GuardEvent.blocked.is_(True)).label("blocked"),
        func.count().filter(GuardEvent.followup.is_(True)).label("followups"),
        func.count().filter(GuardEvent.followup.is_(True), GuardEvent.outcome == "verified").label("checked_after"),
        func.count().filter(GuardEvent.followup.is_(True), GuardEvent.outcome == "disclosed").label("disclosed_after"),
        func.count().filter(first, GuardEvent.deploy.is_(True)).label("deploy_claims"),
    ).where(GuardEvent.user_id == user_id, GuardEvent.said_at >= since, GuardEvent.outcome != "unread")
    if until is not None:
        q = q.where(GuardEvent.said_at < until)
    r = (await db.execute(q)).one()
    claims = r.claims or 0
    return {
        "claims": claims,
        "verified": r.verified or 0,
        "disclosed": r.disclosed or 0,
        "blocked": r.blocked or 0,
        "followups": r.followups or 0,
        "checked_after": r.checked_after or 0,
        "disclosed_after": r.disclosed_after or 0,
        "deploy_claims": r.deploy_claims or 0,
        # Share of claims made with nothing checked since the last change
        "unchecked_rate": round((r.blocked or 0) / claims, 3) if claims else None,
    }


async def guard_overview(db: AsyncSession, user: User, days: int = 30) -> dict:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    machines = (await db.execute(
        select(Machine).where(
            Machine.user_id == user.id,
            Machine.merged_into.is_(None),
            Machine.is_archived.is_(False),
        ).order_by(Machine.last_heartbeat.desc().nullslast())
    )).scalars().all()
    devices = []
    for m in machines:
        status = (m.profile_status or {}).get("guards") or {}
        tools = [t for t in GUARD_TOOLS if t in (m.profile_targets or [])]
        if not tools and not status:
            continue
        devices.append({
            "id": str(m.id),
            "name": m.name,
            "tools": tools,
            "results": status.get("results") or {},
            "reported_at": status.get("reported_at"),
        })

    per_tool = {
        tool: n for tool, n in (await db.execute(
            select(GuardEvent.tool, func.count())
            .where(GuardEvent.user_id == user.id, GuardEvent.said_at >= since, GuardEvent.followup.is_(False))
            .group_by(GuardEvent.tool)
        )).all()
    }
    names = {m.id: m.name for m in machines}
    recent = (await db.execute(
        select(GuardEvent)
        .where(GuardEvent.user_id == user.id, GuardEvent.said_at >= since)
        .where((GuardEvent.blocked.is_(True)) | (GuardEvent.followup.is_(True)))
        .order_by(GuardEvent.said_at.desc())
        .limit(20)
    )).scalars().all()
    return {
        "enabled": guard_enabled(user),
        "tools": list(GUARD_TOOLS),
        "days": days,
        "devices": devices,
        "stats": {**await guard_stats(db, user.id, since), "per_tool": per_tool},
        "recent": [
            {
                "tool": e.tool,
                "device": names.get(e.machine_id),
                "outcome": e.outcome,
                "blocked": e.blocked,
                "followup": e.followup,
                "deploy": e.deploy,
                "claim": e.claim,
                "check": e.check,
                "cwd": e.cwd,
                "at": e.said_at.isoformat(),
            }
            for e in recent
        ],
    }

