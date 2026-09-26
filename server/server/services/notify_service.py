"""Phone push notifications via Bark (https://github.com/Finb/Bark).

The user pastes the push address the Bark app shows (https://api.day.app/<key>/...)
once; the server then pushes risky agent operations and finished tasks to it.
Everything here is fire-and-forget: a failed push is logged and never affects the
task that triggered it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import uuid
from urllib.parse import urlparse

import httpx
from sqlalchemy import select

from ..config import settings
from ..db.models import User
from ..db.session import async_session_factory

logger = logging.getLogger("server.notify")

# Pushes per task for risky operations; beyond this they're recorded but not pushed,
# so a looping agent can't flood the phone.
RISKY_PUSHES_PER_TASK = 5
_risky_push_counts: dict[str, int] = {}
_background: set[asyncio.Task] = set()


def parse_bark_url(raw: str | None) -> tuple[str, str] | None:
    """'https://api.day.app/KEY[/anything]' -> ('https://api.day.app', 'KEY')."""
    if not raw:
        return None
    parsed = urlparse(raw.strip())
    if parsed.scheme != "https" or not parsed.hostname:
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if not parts:
        return None
    return f"https://{parsed.netloc}", parts[0]


def mask_bark_url(raw: str | None) -> str | None:
    parsed = parse_bark_url(raw)
    if not parsed:
        return None
    base, key = parsed
    return f"{base}/{key[:4]}…"


async def _is_public_host(host: str) -> bool:
    """Refuse to push to private/loopback/link-local addresses: the URL is user
    supplied, and the server must not be usable to probe its own network."""
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, 443)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


async def send_bark(
    bark_url: str,
    title: str,
    body: str,
    *,
    url: str | None = None,
    level: str = "active",
) -> bool:
    parsed = parse_bark_url(bark_url)
    if not parsed:
        return False
    base, key = parsed
    if not await _is_public_host(urlparse(base).hostname or ""):
        logger.warning("Bark push refused: %s does not resolve to a public address", base)
        return False
    payload = {"device_key": key, "title": title, "body": body, "group": "Memento", "level": level}
    if url:
        payload["url"] = url
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            resp = await client.post(f"{base}/push", json=payload)
        if resp.status_code != 200:
            logger.warning("Bark push failed: HTTP %s %s", resp.status_code, resp.text[:200])
            return False
        return True
    except httpx.HTTPError as e:
        logger.warning("Bark push failed: %s", e)
        return False


def task_link(task_id: str) -> str | None:
    base = (settings.public_url or "").rstrip("/")
    return f"{base}/tasks/{task_id}" if base else None


async def notify_user(
    user_id: uuid.UUID | str | None,
    kind: str,
    title: str,
    body: str,
    *,
    url: str | None = None,
) -> bool:
    """Push to the user's phone if they set up Bark and haven't turned `kind` off.

    kind: "risky" (agent did something dangerous) | "task_done" (task finished
    while nobody was watching).
    """
    if not user_id:
        return False
    async with async_session_factory() as db:
        user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    prefs = (user.notify_settings or {}) if user else {}
    if not prefs.get("bark_url"):
        return False
    toggle = "notify_risky" if kind == "risky" else "notify_task_done"
    if not prefs.get(toggle, True):
        return False
    level = "timeSensitive" if kind == "risky" else "active"
    return await send_bark(prefs["bark_url"], title, body, url=url, level=level)


def allow_risky_push(task_id: str) -> bool:
    count = _risky_push_counts.get(task_id, 0)
    if count >= RISKY_PUSHES_PER_TASK:
        return False
    _risky_push_counts[task_id] = count + 1
    return True


def forget_task(task_id: str) -> None:
    _risky_push_counts.pop(task_id, None)


def spawn(coro) -> None:
    """Run a notification in the background, keeping a reference until it's done."""
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)
