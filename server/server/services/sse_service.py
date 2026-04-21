"""SSE (Server-Sent Events) service — thread-safe, with cleanup on disconnect."""

from __future__ import annotations

import asyncio
import json
import time
import threading
from collections import deque

_lock = threading.Lock()
_subscribers: list[tuple[str | None, asyncio.Queue]] = []
_recent_events: deque = deque(maxlen=50)


def publish_event(event_type: str, data: dict, user_id: str | None = None) -> None:
    """Publish an event. If user_id is given, deliver only to that user's subscribers.
    user_id=None = broadcast to everyone (used for system-wide events only)."""
    event = {"type": event_type, "data": data, "timestamp": time.time()}
    _recent_events.append((user_id, event))
    with _lock:
        dead = []
        for uid, q in _subscribers:
            if user_id is not None and uid != user_id:
                continue
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append((uid, q))
        for entry in dead:
            _subscribers.remove(entry)


async def subscribe(user_id: str):
    """Async generator that yields SSE events for the given user, with keepalives."""
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    with _lock:
        _subscribers.append((user_id, q))

    try:
        for uid, event in list(_recent_events):
            if uid is None or uid == user_id:
                yield event

        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=30)
                yield event
            except asyncio.TimeoutError:
                yield {"type": "keepalive", "data": {}, "timestamp": time.time()}
    finally:
        with _lock:
            _subscribers[:] = [(u, x) for (u, x) in _subscribers if x is not q]


def format_sse(event: dict) -> str:
    data = json.dumps(event, ensure_ascii=False)
    return f"event: {event['type']}\ndata: {data}\n\n"
