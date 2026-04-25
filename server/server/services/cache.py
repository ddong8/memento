"""Lightweight Redis-backed JSON cache for hot read endpoints.

Currently used by ``/api/daily`` (list-of-dates aggregate) where the cold-DB
query reads ~65 MB of conversation_messages blocks (2-3 s) but the answer
itself is only kilobytes and stable for tens of seconds at a time.

Failures (Redis down, serialisation glitch) degrade silently to a cache
miss — the caller still computes the live answer.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import redis.asyncio as aioredis

from ..config import settings

logger = logging.getLogger("cache")

_client: aioredis.Redis | None = None


def _get_client() -> aioredis.Redis | None:
    global _client
    if _client is not None:
        return _client
    try:
        _client = aioredis.from_url(settings.redis_url, decode_responses=True)
    except Exception as e:
        logger.warning("Redis cache disabled: %s", e)
        _client = None
    return _client


async def cache_get(key: str) -> Any | None:
    c = _get_client()
    if c is None:
        return None
    try:
        v = await c.get(key)
        if v is None:
            return None
        return json.loads(v)
    except Exception as e:
        logger.debug("cache_get(%s) failed: %s", key, e)
        return None


async def cache_set(key: str, value: Any, ttl_seconds: int) -> None:
    c = _get_client()
    if c is None:
        return
    try:
        await c.set(key, json.dumps(value, ensure_ascii=False, default=str), ex=ttl_seconds)
    except Exception as e:
        logger.debug("cache_set(%s) failed: %s", key, e)
