"""Code on one device, agent on another: the server carries the code between them.

The device running the agent (the executor) asks over its own WebSocket (``ws_relay``) and the
server passes each request on to the device holding the code (the source) over that one's:

- ``export``: the source packs the directory into a git bundle (history + a snapshot of the
  working tree); the server keeps where it is under a token, for the executor to fetch;
- ``chunk``: one piece of that bundle, read from the source like any other device file;
- ``apply``: what the agent changed, as a patch for the source to apply to its working tree.

Neither device has to reach the other: both only hold their connection to the server. Only
devices of the same account can reach each other this way.
"""
from __future__ import annotations

import base64
import json
import logging
import time
import uuid
from typing import Any

from ..db.session import async_session_factory
from .cluster import cluster
from .user_filter import find_machine_by_id_or_hash
from .ws_manager import ws_manager

logger = logging.getLogger(__name__)

TOKEN_TTL = 1800
_TOKEN_KEY = "memento:ws:bundle:"
# Single replica without Redis: token -> (expires, entry)
_local_tokens: dict[str, tuple[float, dict[str, Any]]] = {}

EXPORT_TIMEOUT = 150.0
APPLY_TIMEOUT = 150.0
CHUNK_TIMEOUT = 60.0
CHUNK_MAX = 8 * 1024 * 1024
# gzip+base64 of a patch, as the executor caps it
PATCH_MAX = 10 * 1024 * 1024 + 1024


async def _source_device(source_id: str, user_id: Any) -> tuple[str | None, str | None]:
    """The source's connection id when it belongs to the same account as the executor; else (None, why)."""
    async with async_session_factory() as db:
        m = await find_machine_by_id_or_hash(db, source_id)
    if not m or not m.collector_token_hash:
        return None, "找不到代码所在的设备"
    if user_id is None or m.user_id != user_id:
        return None, "代码所在的设备不属于这个账号"
    if getattr(m, "is_archived", False):
        return None, "代码所在的设备已解除关联"
    if not ws_manager.is_online(m.collector_token_hash):
        return None, f"{m.name or '代码所在的设备'} 不在线，打开它上面的 Memento 后再试"
    return m.collector_token_hash, None


async def _put_token(entry: dict[str, Any]) -> str:
    token = uuid.uuid4().hex
    r = cluster.redis
    if r is not None:
        await r.set(_TOKEN_KEY + token, json.dumps(entry), ex=TOKEN_TTL)
    else:
        now = time.monotonic()
        for k in [k for k, (exp, _) in _local_tokens.items() if exp < now]:
            _local_tokens.pop(k, None)
        _local_tokens[token] = (now + TOKEN_TTL, entry)
    return token


async def _get_token(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    r = cluster.redis
    if r is not None:
        raw = await r.get(_TOKEN_KEY + token)
        return json.loads(raw) if raw else None
    hit = _local_tokens.get(token)
    return hit[1] if hit and hit[0] >= time.monotonic() else None


async def _export(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id)
    if not source:
        return {"error": why, "code": "source_unavailable"}
    have = [str(h) for h in (data.get("have") or []) if isinstance(h, str)][:20]
    res = await ws_manager.request_device(
        source, {"type": "workspace_export_req", "path": str(data.get("path") or ""), "have": have}, EXPORT_TIMEOUT,
    )
    if res.get("error"):
        return {"error": res["error"], "code": res.get("code") or "failed"}
    out = {k: res.get(k) for k in ("size", "head", "branch", "snapshot", "tree", "root", "rel", "up_to_date")}
    if not res.get("up_to_date"):
        out["token"] = await _put_token({
            "device": source, "path": res.get("bundle_path"), "size": int(res.get("size") or 0), "user": str(user_id),
        })
    return out


async def _chunk(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    entry = await _get_token(str(data.get("token") or ""))
    if not entry or entry.get("user") != str(user_id):
        return {"error": "代码包已过期，重新开始任务", "code": "expired"}
    offset = max(0, int(data.get("offset") or 0))
    length = max(1, min(int(data.get("length") or CHUNK_MAX), CHUNK_MAX, int(entry["size"]) - offset))
    if offset >= int(entry["size"]):
        return {"data_b64": "", "bytes_read": 0}
    chunk = await ws_manager.request_file_chunk(entry["device"], entry["path"], offset, length, timeout=CHUNK_TIMEOUT)
    if chunk is None:
        return {"error": "从代码所在的设备读取代码包失败（设备离线或文件已清理）", "code": "source_unavailable"}
    return {"data_b64": base64.b64encode(chunk).decode("ascii"), "bytes_read": len(chunk)}


async def _apply(data: dict[str, Any], user_id: Any) -> dict[str, Any]:
    source, why = await _source_device(str(data.get("source_device_id") or ""), user_id)
    if not source:
        return {"error": why, "code": "source_unavailable"}
    patch = str(data.get("patch_b64") or "")
    if not patch:
        return {"error": "补丁是空的"}
    if len(patch) > PATCH_MAX:
        return {"error": "补丁太大", "code": "too_big"}
    files = data.get("files") if isinstance(data.get("files"), list) else []
    res = await ws_manager.request_device(source, {
        "type": "workspace_apply_req",
        "path": str(data.get("path") or ""),
        "task_id": str(data.get("task_id") or ""),
        "base_tree": str(data.get("base_tree") or ""),
        "mode": "save" if data.get("mode") == "save" else "apply",
        "patch_b64": patch,
        "files": files[:2000],
    }, APPLY_TIMEOUT)
    if res.get("error"):
        return {"error": res["error"], "code": res.get("code") or "failed"}
    return {k: res[k] for k in ("applied", "conflict", "branch", "files", "patch_path", "detail") if k in res}


_OPS = {"export": _export, "chunk": _chunk, "apply": _apply}


async def handle(data: dict[str, Any], executor_id: str, user_id: Any) -> None:
    """One ws_relay request from executor_id; the answer goes back as ws_relay_reply (run off the receive loop)."""
    req_id = data.get("req_id")
    op = str(data.get("op") or "")
    fn = _OPS.get(op)
    try:
        reply = await fn(data, user_id) if fn else {"error": f"unknown op {op}"}
    except Exception as e:  # the executor waits on this reply: always send one
        logger.warning("workspace relay %s for %s failed: %s", op, executor_id, e)
        reply = {"error": f"服务器中转失败：{e or type(e).__name__}"}
    if op != "chunk" or reply.get("error"):
        logger.info("workspace relay %s for %s: %s", op, executor_id, reply.get("error") or "ok")
    await ws_manager.send_json(executor_id, {**reply, "type": "ws_relay_reply", "req_id": req_id})
