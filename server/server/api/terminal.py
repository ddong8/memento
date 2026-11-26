"""Terminals in the web app: a real shell (node-pty in the daemon) on one of the user's devices.

The page opens one (the device starts the shell in the project folder), reads its output as an SSE stream and
posts keystrokes / size changes. The device sends output up as task_chunk frames under the terminal's id, so
the stream can be served by any replica (ws_manager relays task events across them). Who owns a terminal (user
and device) is kept in Redis for an hour after its last use, so every replica can check it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services import device_reports
from ..services.cluster import cluster
from ..services.ws_manager import ws_manager
from .git_review import _resolve_device

logger = logging.getLogger("server.terminal")
router = APIRouter(prefix="/api/terminal", tags=["terminal"])

TERM_ID_RE = re.compile(r"^term-[A-Za-z0-9_-]{6,64}$")
_OWNER_KEY = "memento:term:"
_OWNER_TTL = 3600
_KEEPALIVE = 15.0
_MAX_INPUT = 64 * 1024


class TermOpenRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    cwd: str = ""
    cols: int = Field(80, ge=2, le=500)
    rows: int = Field(24, ge=2, le=500)
    # Re-attach to a terminal the page opened before (after a reload); a new one otherwise
    term_id: str | None = None


class TermInput(BaseModel):
    data: str = Field(..., max_length=_MAX_INPUT)


class TermResize(BaseModel):
    cols: int = Field(..., ge=2, le=500)
    rows: int = Field(..., ge=2, le=500)


# Single replica (no Redis): this process is the only one serving terminals
_local_owners: dict[str, str] = {}


async def _kv_set(key: str, value: str) -> None:
    r = cluster.redis
    if r is None:
        _local_owners[key] = value
    else:
        await r.set(key, value, ex=_OWNER_TTL)


async def _kv_get(key: str) -> str | None:
    r = cluster.redis
    if r is None:
        return _local_owners.get(key)
    raw = await r.get(key)
    if raw is not None:
        await r.expire(key, _OWNER_TTL)
    return raw.decode() if isinstance(raw, bytes) else raw


async def _kv_del(key: str) -> None:
    r = cluster.redis
    if r is None:
        _local_owners.pop(key, None)
    else:
        await r.delete(key)


async def _remember(term_id: str, user: User, candidates: list[str]) -> None:
    await _kv_set(_OWNER_KEY + term_id, json.dumps({"user": str(user.id), "devices": candidates}))


async def _owned(term_id: str, user: User) -> list[str]:
    """The device ids a terminal of this user runs on; 404 for anyone else's (or an expired) terminal."""
    if not TERM_ID_RE.match(term_id):
        raise HTTPException(status_code=400, detail="终端编号不合法")
    raw = await _kv_get(_OWNER_KEY + term_id)
    if not raw:
        raise HTTPException(status_code=404, detail="终端已经关闭")
    info = json.loads(raw)
    if info.get("user") != str(user.id):
        raise HTTPException(status_code=404, detail="终端已经关闭")
    return list(info.get("devices") or [])


async def _send(candidates: list[str], payload: dict) -> bool:
    for cand in candidates:
        if await ws_manager.send_json(cand, payload):
            return True
    return False


@router.post("/open")
async def open_terminal(body: TermOpenRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    machine, candidates = await _resolve_device(db, body.device_id, user)
    if not device_reports.device_has_feature(machine.name, "terminal", user):
        raise HTTPException(status_code=400, detail="这台设备的 Memento 还不支持终端，升级到 1.0.161 及以上后再试")
    term_id = body.term_id if body.term_id and TERM_ID_RE.match(body.term_id) else f"term-{uuid.uuid4().hex[:16]}"
    if body.term_id and body.term_id == term_id:
        await _owned(term_id, user)  # re-attaching: must be this user's
    resp: dict = {"error": "设备不在线", "code": "offline"}
    for cand in candidates:
        resp = await ws_manager.request_device(
            cand, {"type": "term_open", "term_id": term_id, "cwd": body.cwd.strip(), "cols": body.cols, "rows": body.rows}, timeout=12.0,
        )
        if resp.get("code") != "offline":
            break
    if resp.get("code") == "offline":
        raise HTTPException(status_code=503, detail="目标设备当前不在线")
    if not resp.get("ok"):
        raise HTTPException(status_code=400, detail=resp.get("error") or "打开终端失败")
    await _remember(term_id, user, candidates)
    return {"term_id": term_id}


@router.get("/{term_id}/stream")
async def stream_terminal(term_id: str, user: User = Depends(get_current_user)):
    """The terminal's output as SSE: `data: {"type":"output","data":...}`, then `{"type":"exit"}` when the shell ends."""
    await _owned(term_id, user)
    q = await ws_manager.subscribe_task(term_id)

    async def gen():
        try:
            yield f"data: {json.dumps({'type': 'ready'})}\n\n"
            while True:
                try:
                    evt = await asyncio.wait_for(q.get(), timeout=_KEEPALIVE)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                etype = evt.get("type")
                if etype == "task_chunk":
                    yield f"data: {json.dumps({'type': 'output', 'data': evt.get('text', '')}, ensure_ascii=False)}\n\n"
                elif etype == "task_event" and (evt.get("event") or {}).get("kind") == "term_exit":
                    yield f"data: {json.dumps({'type': 'exit', 'exit_code': (evt.get('event') or {}).get('exit_code')})}\n\n"
                    return
        finally:
            await ws_manager.unsubscribe_task(term_id)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/{term_id}/input")
async def terminal_input(term_id: str, body: TermInput, user: User = Depends(get_current_user)):
    if not await _send(await _owned(term_id, user), {"type": "term_input", "term_id": term_id, "data": body.data}):
        raise HTTPException(status_code=503, detail="目标设备当前不在线")
    return {"ok": True}


@router.post("/{term_id}/resize")
async def terminal_resize(term_id: str, body: TermResize, user: User = Depends(get_current_user)):
    await _send(await _owned(term_id, user), {"type": "term_resize", "term_id": term_id, "cols": body.cols, "rows": body.rows})
    return {"ok": True}


@router.post("/{term_id}/close")
async def terminal_close(term_id: str, user: User = Depends(get_current_user)):
    candidates = await _owned(term_id, user)
    await _send(candidates, {"type": "term_close", "term_id": term_id})
    await _kv_del(_OWNER_KEY + term_id)
    return {"ok": True}
