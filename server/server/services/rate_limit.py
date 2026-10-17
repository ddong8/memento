"""Attempt counters for abuse-prone endpoints (login, register).

Fixed windows in Redis, shared by every api replica. When Redis is
unreachable the counters fall back to this process's memory, so an outage
never switches the limits off.
"""

from __future__ import annotations

import ipaddress
import logging
import time

from fastapi import HTTPException, Request

from .cache import redis_client

logger = logging.getLogger("rate_limit")

_PREFIX = "rl:"
_local: dict[str, tuple[int, float]] = {}  # key -> (count, monotonic window end)
_LOCAL_MAX_KEYS = 10_000


def client_ip(request: Request) -> str | None:
    """The address our nginx saw. It sets X-Real-IP to $remote_addr, which a
    client can't forge; the first X-Forwarded-For entry is whatever the
    client sent, so it is only a fallback for requests that skipped nginx.
    None when no candidate is a valid IP."""
    xff = request.headers.get("X-Forwarded-For")
    for candidate in (
        request.headers.get("X-Real-IP"),
        xff.split(",")[0] if xff else None,
        request.client.host if request.client else None,
    ):
        if candidate:
            try:
                return str(ipaddress.ip_address(candidate.strip()))
            except ValueError:
                continue
    return None


def _local_count(key: str) -> tuple[int, int]:
    n, end = _local.get(key, (0, 0.0))
    left = end - time.monotonic()
    return (n, int(left) + 1) if left > 0 else (0, 0)


async def _count(key: str) -> tuple[int, int]:
    """(attempts in the current window, seconds until it resets)."""
    c = redis_client()
    if c is not None:
        try:
            pipe = c.pipeline()
            pipe.get(_PREFIX + key)
            pipe.ttl(_PREFIX + key)
            value, ttl = await pipe.execute()
            return int(value or 0), max(int(ttl), 0)
        except Exception as e:
            logger.debug("rate limit read for %s fell back to local counters: %s", key, e)
    return _local_count(key)


async def check(key: str, limit: int) -> None:
    """Raise 429 when `key` has already used up `limit` attempts in its window."""
    n, ttl = await _count(key)
    if n >= limit:
        wait = max(ttl, 1)
        raise HTTPException(
            status_code=429,
            detail=f"Too many attempts, try again in {wait} seconds",
            headers={"Retry-After": str(wait)},
        )


async def hit(key: str, window: int) -> None:
    """Count one attempt; the window starts with the first attempt."""
    c = redis_client()
    if c is not None:
        try:
            # SET NX EX + INCR in one transaction: the counter can never exist
            # without an expiry (which would lock the key out for good).
            pipe = c.pipeline(transaction=True)
            pipe.set(_PREFIX + key, 0, ex=window, nx=True)
            pipe.incr(_PREFIX + key)
            await pipe.execute()
            return
        except Exception as e:
            logger.debug("rate limit write for %s fell back to local counters: %s", key, e)
    now = time.monotonic()
    if len(_local) >= _LOCAL_MAX_KEYS:
        for k in [k for k, (_, end) in _local.items() if end <= now]:
            del _local[k]
    n, end = _local.get(key, (0, 0.0))
    if end <= now:
        n, end = 0, now + window
    _local[key] = (n + 1, end)


async def reset(key: str) -> None:
    c = redis_client()
    if c is not None:
        try:
            await c.delete(_PREFIX + key)
        except Exception as e:
            logger.debug("rate limit reset for %s failed: %s", key, e)
    _local.pop(key, None)
