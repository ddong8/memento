"""Tiered L1 (in-process memory) and L2 (Redis-backed) JSON cache for hot read endpoints.

Hot read endpoints like `/api/devices` and `/api/daily` achieve sub-millisecond response
latencies via the in-process L1 cache while avoiding database and Redis connection spikes.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import redis.asyncio as aioredis

from ..config import settings

logger = logging.getLogger("cache")

_client: aioredis.Redis | None = None

# In-process L1 memory cache: key -> (value, expire_monotonic)
_L1_CACHE: dict[str, tuple[Any, float]] = {}
_L1_MAX_ITEMS = 2048


def l1_cache_get(key: str) -> Any | None:
    """Retrieve a value directly from the in-process L1 memory cache."""
    entry = _L1_CACHE.get(key)
    if entry is None:
        return None
    val, exp = entry
    if exp is not None and exp > 0 and time.monotonic() > exp:
        _L1_CACHE.pop(key, None)
        return None
    return val


def l1_cache_set(key: str, value: Any, ttl_seconds: float) -> None:
    """Store a value in the in-process L1 memory cache with LRU / size eviction."""
    now = time.monotonic()
    if len(_L1_CACHE) >= _L1_MAX_ITEMS:
        # Evict expired items first
        expired = [k for k, (_, exp) in _L1_CACHE.items() if exp is not None and now > exp]
        for k in expired:
            _L1_CACHE.pop(k, None)
        # If still at capacity, evict oldest 100 entries
        if len(_L1_CACHE) >= _L1_MAX_ITEMS:
            for _ in range(min(100, len(_L1_CACHE))):
                _L1_CACHE.pop(next(iter(_L1_CACHE)), None)
    _L1_CACHE[key] = (value, now + ttl_seconds if ttl_seconds > 0 else 0)


def l1_cache_delete(key: str) -> None:
    """Delete a single key from the in-process L1 cache."""
    _L1_CACHE.pop(key, None)


def l1_cache_delete_prefix(prefix: str) -> int:
    """Delete all keys matching prefix from the in-process L1 cache."""
    keys_to_del = [k for k in _L1_CACHE if k.startswith(prefix)]
    for k in keys_to_del:
        _L1_CACHE.pop(k, None)
    return len(keys_to_del)


def redis_client() -> aioredis.Redis | None:
    global _client
    if _client is not None:
        return _client
    try:
        _client = aioredis.from_url(settings.redis_url, decode_responses=True)
    except Exception as e:
        logger.warning("Redis cache disabled: %s", e)
        _client = None
    return _client


async def cache_get(key: str, *, l1_ttl_seconds: float = 3.0) -> Any | None:
    """Get value from L1 memory cache first; on miss, fallback to L2 (Redis)."""
    # 1. Fast-path L1 cache check
    l1_val = l1_cache_get(key)
    if l1_val is not None:
        return l1_val

    # 2. L2 Redis check
    c = redis_client()
    if c is None:
        return None
    try:
        v = await c.get(key)
        if v is None:
            return None
        parsed = json.loads(v)
        # Populate L1 cache for subsequent rapid reads
        if l1_ttl_seconds > 0:
            l1_cache_set(key, parsed, ttl_seconds=l1_ttl_seconds)
        return parsed
    except Exception as e:
        logger.debug("cache_get(%s) failed: %s", key, e)
        return None


async def cache_set(key: str, value: Any, ttl_seconds: int) -> None:
    """Store value in both L1 (in-process) and L2 (Redis) caches."""
    # Write to L1 (capped to at most 15 seconds or ttl_seconds to avoid long-term stale memory)
    l1_cache_set(key, value, ttl_seconds=min(float(ttl_seconds), 15.0))

    c = redis_client()
    if c is None:
        return
    try:
        await c.set(key, json.dumps(value, ensure_ascii=False, default=str), ex=ttl_seconds)
    except Exception as e:
        logger.debug("cache_set(%s) failed: %s", key, e)


async def cache_delete_prefix(prefix: str) -> int:
    """Drop every key matching ``<prefix>*`` in both L1 memory and L2 Redis."""
    l1_cache_delete_prefix(prefix)

    c = redis_client()
    if c is None:
        return 0
    deleted = 0
    try:
        batch = []
        async for key in c.scan_iter(match=f"{prefix}*", count=200):
            batch.append(key)
            if len(batch) >= 100:
                await c.delete(*batch)
                deleted += len(batch)
                batch = []
        if batch:
            await c.delete(*batch)
            deleted += len(batch)
    except Exception as e:
        logger.debug("cache_delete_prefix(%s) failed: %s", prefix, e)
    return deleted

