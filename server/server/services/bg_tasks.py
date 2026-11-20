"""Tracked background asyncio tasks with strong references and graceful shutdown."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

logger = logging.getLogger("server.bg_tasks")

_tasks: set[asyncio.Task[Any]] = set()


def _on_done(task: asyncio.Task[Any]) -> None:
    _tasks.discard(task)
    if task.cancelled():
        return
    try:
        exc = task.exception()
    except Exception:
        return
    if exc is not None:
        logger.warning("Background task %s failed: %s", task.get_name(), exc, exc_info=exc)


def spawn(coro: Coroutine[Any, Any, Any], *, name: str | None = None) -> asyncio.Task[Any]:
    """Schedule a fire-and-forget coroutine while keeping a strong reference until completion."""
    task = asyncio.create_task(coro, name=name) if name else asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_on_done)
    return task


def active_count() -> int:
    return len(_tasks)


async def cancel_all(timeout: float = 5.0) -> None:
    """Cancel all tracked background tasks on shutdown and wait briefly for cleanup."""
    pending = [t for t in list(_tasks) if not t.done()]
    if not pending:
        return
    for t in pending:
        t.cancel()
    await asyncio.wait(pending, timeout=timeout)
