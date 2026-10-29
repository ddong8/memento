"""Commands for a collector, picked up on its next poll (GET /api/devices/commands).

In Redis, so a command queued through one api replica, or by a Celery task (the audit asking a device
to send some logs again, message_audit.py), reaches a device polling any replica.
Format: {id, action, created_at[, payload]}.
"""

from __future__ import annotations

import json
import time

from .cluster import PREFIX

CMD_KEY = f"{PREFIX}devcmd:"
CMD_SEQ = f"{PREFIX}devcmd-seq"
CMD_TTL = 7 * 86400


async def push(redis, device_collector_id: str, action: str, payload: dict | None = None) -> int:
    """Queue a command for a device (keyed by its collector_token_hash); its id."""
    cmd_id = int(await redis.incr(CMD_SEQ))
    cmd: dict = {"id": cmd_id, "action": action, "created_at": time.time()}
    if payload:
        cmd["payload"] = payload
    pipe = redis.pipeline(transaction=False)
    pipe.rpush(CMD_KEY + device_collector_id, json.dumps(cmd, ensure_ascii=False))
    pipe.expire(CMD_KEY + device_collector_id, CMD_TTL)
    await pipe.execute()
    return cmd_id


async def pending(redis, device_collector_id: str) -> list[dict]:
    return [json.loads(c) for c in await redis.lrange(CMD_KEY + device_collector_id, 0, -1)]


async def ack(redis, device_collector_id: str, cmd_id: int) -> None:
    for raw in await redis.lrange(CMD_KEY + device_collector_id, 0, -1):
        if json.loads(raw).get("id") == cmd_id:
            await redis.lrem(CMD_KEY + device_collector_id, 0, raw)
