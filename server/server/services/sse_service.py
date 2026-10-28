"""SSE (Server-Sent Events) service — thread-safe, with cleanup on disconnect.

Events reach subscribers on every api replica: each one is delivered here and
relayed to the other replicas over the cluster bus (services/cluster.py).
"""

from __future__ import annotations

import asyncio
import json
import time
import threading
from collections import deque

from .cluster import PREFIX, cluster

_lock = threading.Lock()
_subscribers: list[tuple[str | None, asyncio.Queue]] = []
_recent_events: deque = deque(maxlen=50)
_CHANNEL = f"{PREFIX}sse"
# A connection without Last-Event-ID gets the events of these last seconds, published while it was
# being opened; anything older its client fetches itself when the connection comes up.
_REPLAY_WINDOW = 10.0


def publish_event(event_type: str, data: dict, user_id: str | None = None) -> None:
    """Publish an event. If user_id is given, deliver only to that user's subscribers.
    user_id=None = broadcast to everyone (used for system-wide events only)."""
    event = {"type": event_type, "data": data, "timestamp": time.time()}
    _deliver(user_id, event)
    cluster.publish(_CHANNEL, {"user_id": user_id, "event": event})


_throttled: dict[tuple[str, str | None], dict] = {}


def publish_event_throttled(event_type: str, data: dict, user_id: str | None = None, interval: float = 5.0) -> None:
    """publish_event, at most once per `interval` seconds per user and type: the latest one waiting
    goes out when the interval is up. For events only a refresh hangs on: a collector uploading a
    backlog published "file_synced" for each file, thousands a day, to every open client.

    Per replica (two replicas may each send one per interval); it only spaces the events out."""
    key = (event_type, user_id)
    now = time.monotonic()
    state = _throttled.get(key)
    if state is None or (state["handle"] is None and now - state["sent"] >= interval):
        _throttled[key] = {"sent": now, "pending": None, "handle": None}
        publish_event(event_type, data, user_id)
        return
    state["pending"] = data
    if state["handle"] is None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # no loop to send it later from: send it now
            state["sent"], state["pending"] = now, None
            publish_event(event_type, data, user_id)
            return
        state["handle"] = loop.call_later(max(0.0, interval - (now - state["sent"])), _send_throttled, key)


def _send_throttled(key: tuple[str, str | None]) -> None:
    state = _throttled.get(key)
    if not state:
        return
    data, state["pending"], state["handle"] = state["pending"], None, None
    if data is not None:
        state["sent"] = time.monotonic()
        publish_event(key[0], data, key[1])


def _on_relay(_channel: str, msg: dict) -> None:
    if msg.get("origin") != cluster.pod_id and isinstance(msg.get("event"), dict):
        _deliver(msg.get("user_id"), msg["event"])


cluster.on(_CHANNEL, _on_relay)


def _deliver(user_id: str | None, event: dict) -> None:
    with _lock:  # with subscribe's snapshot: each event reaches a new reader once, replayed or queued
        _recent_events.append((user_id, event))
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
            # End that stream rather than leave it on keepalives alone: its client would take the
            # connection for live and stop polling while no event reaches it. It reconnects.
            q = entry[1]
            try:
                q.get_nowait()
                q.put_nowait(None)
            except Exception:
                pass


async def subscribe(user_id: str, since: float | None = None):
    """Async generator that yields SSE events for the given user, with keepalives.

    It starts with a keepalive, so the client sees the connection works at once, then what the
    user missed: the events after `since` (the last one the client saw, from Last-Event-ID), or
    without it those of the last few seconds. Replaying the last 50 events to every connection
    (a phone reconnects each time it comes back to the foreground, ~150 times a day) re-ran the
    clients' refreshes for events long handled."""
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    floor = since if since is not None else time.time() - _REPLAY_WINDOW
    with _lock:
        backlog = [e for uid, e in _recent_events if (uid is None or uid == user_id) and e.get("timestamp", 0) > floor]
        _subscribers.append((user_id, q))

    try:
        yield {"type": "keepalive", "data": {}, "timestamp": time.time()}
        for event in backlog:
            yield event

        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=30)
                if event is None:  # fell behind and was dropped (see _deliver)
                    return
                yield event
            except asyncio.TimeoutError:
                yield {"type": "keepalive", "data": {}, "timestamp": time.time()}
    finally:
        with _lock:
            _subscribers[:] = [(u, x) for (u, x) in _subscribers if x is not q]


def format_sse(event: dict) -> str:
    data = json.dumps(event, ensure_ascii=False)
    # The id comes back as Last-Event-ID when the client reconnects (subscribe's `since`)
    head = "" if event["type"] == "keepalive" else f"id: {event.get('timestamp', 0):.6f}\n"
    return f"{head}event: {event['type']}\ndata: {data}\n\n"


def parse_event_id(value: str | None) -> float | None:
    try:
        return float(value) if value else None
    except ValueError:
        return None
