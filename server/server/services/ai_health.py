"""AI call health: hourly counters in Redis, read back by the health page and alerts.

Each chat/completions call records one outcome (ok on the first provider,
fallback when a later provider answered, failed when none did), and every
provider attempt that fell short records why. Counters live in one Redis hash
per UTC hour so both the API and the Celery workers write to the same place.

Recording is best-effort: a Redis hiccup must never fail an LLM call.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import redis.asyncio as aioredis

from ..config import settings

logger = logging.getLogger("server.ai_health")

_PREFIX = "memento:ai_health"
_BUCKET_TTL = 3 * 24 * 3600
_RECENT_KEY = f"{_PREFIX}:recent_errors"
_RECENT_KEEP = 30

# Why a provider attempt fell short. Kept small so the health page can label them.
# Attempts that were asked again on the same provider: not errors on their own
RETRY_REASONS = frozenset({"reasoning_retry", "cut_retry"})
REASON_LABELS = {
    "reasoning_exhausted": "思考耗尽额度",
    "reasoning_retry": "思考超额后加额度重试",
    "cut_retry": "回答被截断后加额度重试",
    "empty": "返回空内容",
    "timeout": "超时",
    "network": "网络错误",
    "rate_limited": "限流 (429)",
    "auth": "鉴权失败",
    "server_error": "服务端错误 (5xx)",
    "bad_request": "请求被拒 (4xx)",
    "error": "其他错误",
}


def reason_for_status(code: int) -> str:
    if code == 429:
        return "rate_limited"
    if code in (401, 403):
        return "auth"
    if code >= 500:
        return "server_error"
    return "bad_request"


def reason_for_exception(e: BaseException) -> str:
    if isinstance(e, httpx.TimeoutException):
        return "timeout"
    if isinstance(e, httpx.TransportError):
        return "network"
    return "error"


def _bucket(at: datetime) -> str:
    return f"{_PREFIX}:h:{at.astimezone(timezone.utc):%Y%m%d%H}"


def _client() -> aioredis.Redis:
    # A fresh client per use: Celery tasks each run in their own event loop
    # (asyncio.run), and a pooled asyncio client can't cross loops.
    return aioredis.from_url(settings.redis_url, decode_responses=True)


async def record_call(
    kind: str,
    outcome: str,
    *,
    provider: str | None = None,
    model: str | None = None,
    latency_ms: int | None = None,
    failures: list[dict[str, str]] | None = None,
) -> None:
    """kind: background | interactive | stream. outcome: ok | fallback | failed.

    failures: one {provider, model, reason, detail} per attempt that fell short.
    """
    now = datetime.now(timezone.utc)
    key = _bucket(now)
    try:
        client = _client()
        try:
            pipe = client.pipeline(transaction=False)
            pipe.hincrby(key, f"calls:{kind}:{outcome}", 1)
            if provider and model and outcome != "failed":
                pipe.hincrby(key, f"model:{provider}|{model}:ok", 1)
                if latency_ms is not None:
                    pipe.hincrby(key, f"model:{provider}|{model}:ms", int(latency_ms))
            for f in failures or []:
                pipe.hincrby(key, f"model:{f['provider']}|{f['model']}:fail", 1)
                pipe.hincrby(key, f"reason:{f['reason']}", 1)
                if f["reason"] not in RETRY_REASONS:
                    pipe.lpush(_RECENT_KEY, json.dumps({
                        "at": now.isoformat(),
                        "kind": kind,
                        "provider": f["provider"],
                        "model": f["model"],
                        "reason": f["reason"],
                        "detail": (f.get("detail") or "")[:300],
                        "fatal": outcome == "failed",
                    }, ensure_ascii=False))
            pipe.ltrim(_RECENT_KEY, 0, _RECENT_KEEP - 1)
            pipe.expire(key, _BUCKET_TTL)
            await pipe.execute()
        finally:
            await client.aclose()
    except Exception as e:  # never let bookkeeping break an LLM call
        logger.debug("AI health record failed: %s", e)


def _empty_calls() -> dict[str, int]:
    return {"ok": 0, "fallback": 0, "failed": 0}


def aggregate(buckets: list[tuple[datetime, dict[str, str]]]) -> dict[str, Any]:
    """Fold hourly hashes (oldest first) into the shape the health page shows."""
    calls = _empty_calls()
    by_kind: dict[str, dict[str, int]] = {}
    models: dict[str, dict[str, int]] = {}
    reasons: dict[str, int] = {}
    hourly: list[dict[str, Any]] = []

    for hour, fields in buckets:
        hour_calls = _empty_calls()
        for field, raw in fields.items():
            n = int(raw)
            parts = field.split(":")
            if parts[0] == "calls" and len(parts) == 3:
                _, kind, outcome = parts
                if outcome in calls:
                    calls[outcome] += n
                    hour_calls[outcome] += n
                    by_kind.setdefault(kind, _empty_calls())[outcome] += n
            elif parts[0] == "model" and len(parts) >= 3:
                name, metric = ":".join(parts[1:-1]), parts[-1]
                m = models.setdefault(name, {"ok": 0, "fail": 0, "ms": 0})
                if metric in m:
                    m[metric] += n
            elif parts[0] == "reason" and len(parts) == 2:
                reasons[parts[1]] = reasons.get(parts[1], 0) + n
        hourly.append({"hour": hour.isoformat(), **hour_calls})

    model_rows = []
    for name, m in models.items():
        provider, _, model = name.partition("|")
        model_rows.append({
            "provider": provider,
            "model": model,
            "ok": m["ok"],
            "failed": m["fail"],
            "avg_latency_ms": round(m["ms"] / m["ok"]) if m["ok"] else None,
        })
    model_rows.sort(key=lambda r: r["ok"] + r["failed"], reverse=True)

    return {
        "calls": {"total": sum(calls.values()), **calls},
        "by_kind": by_kind,
        "models": model_rows,
        "reasons": [
            {"reason": r, "label": REASON_LABELS.get(r, r), "count": c}
            for r, c in sorted(reasons.items(), key=lambda kv: kv[1], reverse=True)
        ],
        "hourly": hourly,
    }


async def summary(hours: int = 24) -> dict[str, Any]:
    """AI call stats for the last `hours` hours, plus the most recent failures."""
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    hours_list = [now - timedelta(hours=i) for i in range(hours - 1, -1, -1)]
    try:
        client = _client()
        try:
            pipe = client.pipeline(transaction=False)
            for h in hours_list:
                pipe.hgetall(_bucket(h))
            pipe.lrange(_RECENT_KEY, 0, _RECENT_KEEP - 1)
            results = await pipe.execute()
        finally:
            await client.aclose()
    except Exception as e:
        logger.warning("AI health read failed: %s", e)
        return {"available": False, "window_hours": hours, **aggregate([])}

    data = aggregate(list(zip(hours_list, results[:-1])))
    recent = []
    for raw in results[-1]:
        try:
            item = json.loads(raw)
        except (TypeError, ValueError):
            continue
        item["label"] = REASON_LABELS.get(item.get("reason", ""), item.get("reason", ""))
        recent.append(item)
    return {"available": True, "window_hours": hours, **data, "recent_errors": recent}


async def claim_alert(name: str, cooldown_seconds: int) -> bool:
    """True the first time `name` fires within the cooldown (so an alert isn't repeated)."""
    try:
        client = _client()
        try:
            return bool(await client.set(f"{_PREFIX}:alert:{name}", "1", nx=True, ex=cooldown_seconds))
        finally:
            await client.aclose()
    except Exception as e:
        logger.debug("AI health alert claim failed: %s", e)
        return False


async def put_json(name: str, value: Any, ttl_seconds: int = 14 * 24 * 3600) -> None:
    """Small status records (last dreaming run, last profile generation)."""
    try:
        client = _client()
        try:
            await client.set(f"{_PREFIX}:{name}", json.dumps(value, ensure_ascii=False, default=str), ex=ttl_seconds)
        finally:
            await client.aclose()
    except Exception as e:
        logger.debug("AI health put %s failed: %s", name, e)


async def get_json(name: str) -> Any | None:
    try:
        client = _client()
        try:
            raw = await client.get(f"{_PREFIX}:{name}")
        finally:
            await client.aclose()
        return json.loads(raw) if raw else None
    except Exception as e:
        logger.debug("AI health get %s failed: %s", name, e)
        return None
