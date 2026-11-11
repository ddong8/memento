"""Memory lifecycle: what gets used stays, what goes unused sleeps, what's contradicted steps aside.

- Recall: every time a memory is handed to an AI (Ask, the agent, MCP rule checks)
  its last_recalled_at and recall_count move. That is the usage signal.
- Dormancy: machine-made memories that nobody recalled or refreshed for
  DORMANT_AFTER go dormant. They are kept and shown in the app, just no longer
  retrieved. Rules and preferences never go dormant: they hold until replaced.
- Reconcile: new or changed memories are compared with the rest of their group
  for duplicates and contradictions. The loser is marked superseded (never
  deleted) and points at what replaced it. A machine guess never replaces what
  the user wrote or approved, and when a user-approved memory replaces another,
  the published profile loses the old line right away.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User, UserMemory, UserProfile
from ..db.session import async_session_factory
from .ai_provider import call_plain_chat, uses_user_llm
from .dreaming_service import _safe_json_loads
from .memory_vectors import embed_memories, nearest_memories
from .profile_service import get_draft_profile, get_published_profile, sanitize_profile_content

logger = logging.getLogger("server.memory_lifecycle")

ACTIVE, DORMANT, SUPERSEDED = "active", "dormant", "superseded"
DORMANT_AFTER = timedelta(days=60)
ALWAYS_ON = ("rule", "rules", "preference")
NEW_PER_CALL = 30
EXISTING_PER_CALL = 80


def active() -> Any:
    """WHERE clause for memories that may be handed to an AI."""
    return UserMemory.status == ACTIVE


async def touch_recalled(ids: Iterable[uuid.UUID]) -> None:
    """Record that these memories were just given to an AI. Own session: callers
    are often mid-stream and must not have their transaction committed under them."""
    id_list = list({i for i in ids if i})
    if not id_list:
        return
    try:
        async with async_session_factory() as db:
            await db.execute(
                update(UserMemory)
                .where(UserMemory.id.in_(id_list))
                # Keep updated_at: being read is not a change, and reconcile keys off it.
                .values(
                    last_recalled_at=func.now(),
                    recall_count=UserMemory.recall_count + 1,
                    updated_at=UserMemory.updated_at,
                )
                .execution_options(synchronize_session=False)
            )
            await db.commit()
    except Exception as e:
        logger.warning("touch_recalled failed: %s", e)


# ---- dormancy ----

async def sweep_dormant(db: AsyncSession, user: User, now: datetime | None = None) -> int:
    """Put machine-made memories unused for DORMANT_AFTER to sleep. Returns how many."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - DORMANT_AFTER
    last_touch = func.greatest(
        func.coalesce(UserMemory.last_recalled_at, UserMemory.created_at),
        func.coalesce(UserMemory.updated_at, UserMemory.created_at),
    )
    result = await db.execute(
        update(UserMemory)
        .where(
            UserMemory.user_id == user.id,
            active(),
            UserMemory.is_folder.is_(False),
            UserMemory.source != "manual",
            UserMemory.category.not_in(ALWAYS_ON),
            last_touch < cutoff,
        )
        .values(status=DORMANT, status_reason=f"{DORMANT_AFTER.days} 天没有被用到，也没有更新")
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    return result.rowcount or 0


# ---- reconcile ----

def group_key(mem: UserMemory) -> str:
    """Memories that can duplicate or contradict each other share a group."""
    cat = (mem.category or "general").lower()
    if cat in ALWAYS_ON:
        return "rules"
    path = (mem.tree_path or "").strip("/").split("/")
    if cat in ("project", "pitfall") and len(path) >= 2 and path[0] == cat:
        return f"{cat}:{path[1].lower()}"
    return cat


def _touched_at(mem: UserMemory) -> datetime:
    return mem.updated_at or mem.created_at or datetime.min.replace(tzinfo=timezone.utc)


_RECONCILE_PROMPT = """下面是同一类长期记忆。N 开头的是最近新增或改过的，E 开头的是早就有的。请找出以下两种情况，每一组至少要涉及一条 N：

1. duplicate：两条（或多条）说的是同一件事，只是措辞不同。保留信息最完整的一条。
2. conflict：新的一条推翻了旧的（偏好变了、规则改了、做法换了、结论被新证据否定）。保留新的那条。

只报确定的情况。说的是相关但不同的两件事、或只是互相补充的，不要报。

{items}

只输出 JSON：{{"actions": [{{"type": "duplicate|conflict", "keep": "N1", "drop": ["E3"], "reason": "一句话说明"}}]}}"""


def _render_items(new: list[UserMemory], old: list[UserMemory]) -> tuple[str, dict[str, UserMemory]]:
    refs: dict[str, UserMemory] = {}
    lines: list[str] = []
    for prefix, group in (("N", new), ("E", old)):
        for n, mem in enumerate(group, 1):
            ref = f"{prefix}{n}"
            refs[ref] = mem
            origin = "用户手写/确认" if mem.source == "manual" else "自动总结"
            when = _touched_at(mem).strftime("%Y-%m-%d")
            lines.append(f"{ref} [{mem.category}·{origin}·{when}] {(mem.content or '')[:300]}")
    return "\n".join(lines), refs


def settle(action: str, keep: UserMemory, drop: UserMemory) -> tuple[UserMemory, UserMemory]:
    """Final (keep, drop) after the guards: what the user wrote beats a machine guess,
    and between two of the user's own, the newer word wins a conflict."""
    keep_manual, drop_manual = keep.source == "manual", drop.source == "manual"
    if drop_manual and not keep_manual:
        return drop, keep
    if action == "conflict" and keep_manual and drop_manual and _touched_at(drop) > _touched_at(keep):
        return drop, keep
    return keep, drop


def replace_profile_line(content: str, old: str, new: str | None) -> str:
    """The profile with bullet "- old" replaced by "- new" (or removed when new is None,
    or when "- new" is already there). Unchanged if "- old" isn't a line of it."""
    old_bullet = f"- {_one_line(old)}"
    lines = (content or "").split("\n")
    at = next((i for i, line in enumerate(lines) if line.strip() == old_bullet), None)
    if at is None:
        return content
    new_bullet = f"- {_one_line(new)}" if new else None
    if new_bullet is None or any(line.strip() == new_bullet for line in lines):
        del lines[at]
    else:
        lines[at] = new_bullet
    return "\n".join(lines)


def _one_line(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


async def _sync_profile(db: AsyncSession, user: User, pairs: list[tuple[UserMemory, UserMemory]]) -> bool:
    """Drop superseded lines from the published profile (and draft) when the
    replacement is something the user approved. Returns whether a version was published."""
    approved = [(keep, drop) for keep, drop in pairs if keep.source == "manual"]
    if not approved:
        return False
    published = await get_published_profile(db, user)
    draft = await get_draft_profile(db, user)
    changed = False
    if published is not None:
        content = published.content
        for keep, drop in approved:
            content = replace_profile_line(content, drop.content, keep.content)
        if content != published.content:
            last = (await db.execute(
                select(func.max(UserProfile.version)).where(UserProfile.user_id == user.id)
            )).scalar() or 0
            db.add(UserProfile(
                user_id=user.id, status="published", version=last + 1,
                content=sanitize_profile_content(content), stats={"source": "reconcile"},
                published_at=datetime.now(timezone.utc),
            ))
            changed = True
    if draft is not None:
        content = draft.content
        for keep, drop in approved:
            content = replace_profile_line(content, drop.content, keep.content)
        draft.content = content
    return changed


async def _judge(new: list[UserMemory], old: list[UserMemory]) -> tuple[list[dict[str, Any]], dict[str, UserMemory]]:
    items, refs = _render_items(new, old)
    raw = await call_plain_chat(
        messages=[
            {"role": "system", "content": "You deduplicate a user's long-term memories. Respond only with valid JSON."},
            {"role": "user", "content": _RECONCILE_PROMPT.format(items=items)},
        ],
        max_tokens=1500,
    )
    if raw is None:
        raise RuntimeError("memory reconcile got no answer from any AI provider")
    return list(_safe_json_loads(raw).get("actions") or []), refs


@uses_user_llm
async def reconcile_group(
    db: AsyncSession, user: User, new: list[UserMemory], old: list[UserMemory],
) -> list[tuple[UserMemory, UserMemory, str]]:
    """Judge `new` against `old` (and each other); mark losers superseded.
    Returns (keep, drop, reason) for every change. Does not commit."""
    if len(new) + len(old) < 2:
        return []
    actions, refs = await _judge(new, old)
    changes: list[tuple[UserMemory, UserMemory, str]] = []
    gone: set[uuid.UUID] = set()
    for action in actions:
        if not isinstance(action, dict):
            continue
        kind = str(action.get("type") or "")
        keep = refs.get(str(action.get("keep") or ""))
        drops = action.get("drop") or []
        if kind not in ("duplicate", "conflict") or keep is None or not isinstance(drops, list):
            continue
        for ref in drops:
            drop = refs.get(str(ref))
            if drop is None or drop is keep:
                continue
            k, d = settle(kind, keep, drop)
            if k.id in gone or d.id in gone or k.status != ACTIVE or d.status != ACTIVE:
                continue  # one closest to another group's memory may have stepped aside there already
            if not any(m is k or m is d for m in new):
                continue  # only pairs that involve something new
            reason = f"{'和另一条重复' if kind == 'duplicate' else '被新的说法取代'}：{str(action.get('reason') or '')[:200]}"
            d.status = SUPERSEDED
            d.superseded_by = k.id
            d.status_reason = reason
            gone.add(d.id)
            changes.append((k, d, reason))
    return changes


def _related_categories(mem: UserMemory) -> tuple[str, ...]:
    """Where a duplicate of `mem` could be filed: rules and preferences are one group (group_key)."""
    cat = (mem.category or "general").lower()
    return ALWAYS_ON if cat in ALWAYS_ON else (cat,)


async def _closest_first(
    db: AsyncSession, user: User, new: list[UserMemory], others: list[UserMemory],
) -> list[UserMemory]:
    """What `new` is judged against: the memories closest to each new one first, from any project,
    then `others` (the group, most recently touched first). Recency alone missed duplicates: on 11-09
    the memento group held 144 pitfalls, so "pytest isn't on PATH" (10-30) was never put next to
    "no pytest command on macOS" (10-11), and the same PowerShell "&&" pitfall sat in two projects."""
    new_ids = {m.id for m in new}
    seen = set(new_ids)
    picked: list[UserMemory] = []
    for mem in new:
        if mem.embedding is None:
            continue
        for near in await nearest_memories(db, user.id, mem.embedding, categories=_related_categories(mem), exclude=new_ids):
            if near.id not in seen:
                seen.add(near.id)
                picked.append(near)
    picked += [m for m in others if m.id not in seen]
    return picked[:EXISTING_PER_CALL]


async def _embed_quietly(db: AsyncSession, memories: list[UserMemory]) -> None:
    try:
        await embed_memories(db, memories)
    except Exception as e:  # without vectors the group's most recent ones are still compared
        logger.warning("embedding memories before reconcile failed: %s", e)


async def _active_memories(db: AsyncSession, user: User) -> list[UserMemory]:
    return list((await db.execute(
        select(UserMemory).where(UserMemory.user_id == user.id, active(), UserMemory.is_folder.is_(False))
    )).scalars().all())


async def reconcile(db: AsyncSession, user: User, since: datetime | None) -> dict[str, Any]:
    """Check memories changed since `since` (all of them when None) against their groups."""
    memories = await _active_memories(db, user)
    groups: dict[str, list[UserMemory]] = {}
    for mem in memories:
        groups.setdefault(group_key(mem), []).append(mem)

    checked = superseded = 0
    pairs: list[tuple[UserMemory, UserMemory]] = []
    batches: list[tuple[list[UserMemory], list[UserMemory]]] = []
    for members in groups.values():
        members.sort(key=_touched_at, reverse=True)
        new = [m for m in members if since is None or _touched_at(m) > since][:NEW_PER_CALL]
        if new:
            new_ids = {m.id for m in new}
            batches.append((new, [m for m in members if m.id not in new_ids]))
    await _embed_quietly(db, [m for new, _ in batches for m in new])
    for new, others in batches:
        try:
            changes = await reconcile_group(db, user, new, await _closest_first(db, user, new, others))
        except Exception as e:
            logger.warning("reconcile group failed for user %s: %s", user.id, e)
            continue
        checked += 1
        superseded += len(changes)
        pairs.extend((k, d) for k, d, _ in changes)
    profile_updated = await _sync_profile(db, user, pairs)
    await db.commit()
    return {"groups": checked, "superseded": superseded, "profile_updated": profile_updated}


async def reconcile_one(db: AsyncSession, user: User, memory: UserMemory) -> list[tuple[UserMemory, UserMemory, str]]:
    """Check one just-written memory against its group right away (e.g. a rule the user
    just accepted), so a changed preference doesn't sit next to the old one until night."""
    key = group_key(memory)
    await _embed_quietly(db, [memory])
    others = [m for m in await _active_memories(db, user) if m.id != memory.id and group_key(m) == key]
    others.sort(key=_touched_at, reverse=True)
    changes = await reconcile_group(db, user, [memory], await _closest_first(db, user, [memory], others))
    await _sync_profile(db, user, [(k, d) for k, d, _ in changes])
    await db.commit()
    return changes


async def reconcile_in_background(user_id: uuid.UUID, memory_id: uuid.UUID) -> None:
    """reconcile_one in its own session, for request handlers that shouldn't wait on a model."""
    try:
        async with async_session_factory() as db:
            user = await db.get(User, user_id)
            memory = await db.get(UserMemory, memory_id)
            if user is None or memory is None or memory.status != ACTIVE:
                return
            changes = await reconcile_one(db, user, memory)
            if changes:
                logger.info("Accepted memory %s superseded %d older ones", memory_id, len(changes))
    except Exception as e:
        logger.warning("reconcile after accept failed for %s: %s", memory_id, e)


async def lifecycle_counts(db: AsyncSession, user: User, days: int = 7) -> dict[str, int]:
    rows = (await db.execute(
        select(UserMemory.status, func.count()).where(
            UserMemory.user_id == user.id, UserMemory.is_folder.is_(False),
        ).group_by(UserMemory.status)
    )).all()
    counts = {status: n for status, n in rows}
    since = datetime.now(timezone.utc) - timedelta(days=days)
    recent = (await db.execute(
        select(func.count()).select_from(UserMemory).where(
            UserMemory.user_id == user.id,
            UserMemory.status == SUPERSEDED,
            UserMemory.updated_at >= since,
        )
    )).scalar() or 0
    recalled = (await db.execute(
        select(func.count()).select_from(UserMemory).where(
            UserMemory.user_id == user.id,
            UserMemory.last_recalled_at >= since,
        )
    )).scalar() or 0
    return {
        "active": counts.get(ACTIVE, 0),
        "dormant": counts.get(DORMANT, 0),
        "superseded": counts.get(SUPERSEDED, 0),
        "superseded_recent": recent,
        "recalled_recent": recalled,
    }
