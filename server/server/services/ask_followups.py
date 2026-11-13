"""Follow-ups the running agent didn't take, kept per conversation until the next message carries them.

A message typed while a reply runs goes into the running agent when it can (POST /api/tasks/{id}/input).
When it can't — no agent task to take it, the agent doesn't read input mid-run, the device reports it as
late / unsupported, or the task already ended — it lands here instead of in the page's memory, so a page
that was closed, reloaded or put in the background (a phone) doesn't lose it. The page that sees the
reply end takes them (pop) and sends them as one next message; a page opening the conversation later
gets them back into its input box.

Kept in Redis so every replica sees the same queue; a dict when there's no Redis (single replica).
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

from sqlalchemy import select

from ..db.models import DeviceTask
from ..db.session import async_session_factory
from .cluster import PREFIX, cluster

logger = logging.getLogger(__name__)

TTL_SECONDS = 24 * 3600
MAX_ITEMS = 50
MAX_TEXT = 20_000

_local: dict[str, list[dict[str, Any]]] = {}


def _key(user_id: Any, conv_id: str) -> str:
    return f"{PREFIX}ask:followups:{user_id}:{conv_id}"


async def add(user_id: Any, conv_id: str, text: str, at: float | None = None) -> bool:
    """Queue one follow-up; the same text already waiting isn't queued twice. False when nothing was added."""
    text = (text or "").strip()[:MAX_TEXT]
    if not text or not conv_id:
        return False
    item = {"text": text, "at": at if at is not None else time.time()}
    key = _key(user_id, conv_id)
    r = cluster.redis
    if r is None:
        items = _local.setdefault(key, [])
        if any(i["text"] == text for i in items) or len(items) >= MAX_ITEMS:
            return False
        items.append(item)
        return True
    try:
        existing = await r.lrange(key, 0, -1)
        if len(existing) >= MAX_ITEMS or any(_load(raw).get("text") == text for raw in existing):
            return False
        async with r.pipeline(transaction=True) as p:
            p.rpush(key, json.dumps(item, ensure_ascii=False))
            p.expire(key, TTL_SECONDS)
            await p.execute()
        return True
    except Exception as e:
        logger.warning("Could not queue a follow-up for conversation %s: %s", conv_id, e)
        return False


async def peek(user_id: Any, conv_id: str) -> list[dict[str, Any]]:
    key = _key(user_id, conv_id)
    r = cluster.redis
    if r is None:
        return list(_local.get(key, []))
    try:
        return [_load(raw) for raw in await r.lrange(key, 0, -1)]
    except Exception as e:
        logger.warning("Could not read the follow-ups of conversation %s: %s", conv_id, e)
        return []


async def pop(user_id: Any, conv_id: str) -> list[dict[str, Any]]:
    """Take every waiting follow-up, oldest first; a second page asking at the same time gets none."""
    key = _key(user_id, conv_id)
    r = cluster.redis
    if r is None:
        return _local.pop(key, [])
    try:
        async with r.pipeline(transaction=True) as p:
            p.lrange(key, 0, -1)
            p.delete(key)
            raw, _ = await p.execute()
        return sorted((i for i in (_load(x) for x in raw) if i.get("text")), key=lambda i: i.get("at") or 0)
    except Exception as e:
        logger.warning("Could not take the follow-ups of conversation %s: %s", conv_id, e)
        return []


async def remove(user_id: Any, conv_id: str, text: str) -> bool:
    """Take back one waiting follow-up (the user withdrew it before it went out)."""
    text = (text or "").strip()
    key = _key(user_id, conv_id)
    r = cluster.redis
    if r is None:
        items = _local.get(key, [])
        kept = [i for i in items if i["text"] != text]
        _local[key] = kept
        return len(kept) != len(items)
    try:
        removed = 0
        for raw in await r.lrange(key, 0, -1):
            if _load(raw).get("text") == text:
                removed += await r.lrem(key, 1, raw)
        return removed > 0
    except Exception as e:
        logger.warning("Could not withdraw a follow-up of conversation %s: %s", conv_id, e)
        return False


def _load(raw: Any) -> dict[str, Any]:
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except (TypeError, ValueError):
        return {}


async def task_owner(task_id: str) -> tuple[Any, str] | None:
    """(user id, conversation id) of the reply a device task belongs to."""
    try:
        tid = uuid.UUID(str(task_id))
    except (ValueError, TypeError):
        return None
    async with async_session_factory() as db:
        task = (await db.execute(select(DeviceTask).where(DeviceTask.id == tid))).scalar_one_or_none()
    if task is None or task.user_id is None:
        return None
    conv = str((task.payload or {}).get("conversation_id") or "").strip()
    return (task.user_id, conv) if conv else None


async def note_steer(task_id: str, event: dict[str, Any]) -> None:
    """A device said a follow-up didn't reach its agent (late / unsupported): keep it for the next message."""
    if event.get("kind") != "steer" or event.get("status") not in ("late", "unsupported"):
        return
    text = str(event.get("text") or "")
    try:
        owner = await task_owner(task_id)
        if owner:
            await add(owner[0], owner[1], text)
    except Exception as e:
        logger.warning("Could not keep the follow-up of task %s: %s", task_id, e)
