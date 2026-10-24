"""Ingest API — receives files from collectors on multiple devices."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.tasks import REMOTE_EXEC_ENABLED
from ..config import settings
from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import verify_collector_token
from ..services.device_service import ensure_device
from ..services.ingest_service import (
    ensure_project,
    ingest_file,
    _get_ingest_semaphore,
    _is_invalid_project_name,
    _prettify_project_name,
)

router = APIRouter(prefix="/api/ingest", tags=["ingest"])


async def throttle_ingest():
    """Cap concurrent ingest endpoint handlers at 16 (see _get_ingest_semaphore).
    Collector storms beyond that get queued at the semaphore, NOT at the
    DB connection pool, so login / dashboard / search keep their own slots."""
    sem = _get_ingest_semaphore()
    await sem.acquire()
    try:
        yield
    finally:
        sem.release()


class IngestFileRequest(BaseModel):
    tool: str
    category: str
    content_type: str
    relative_path: str
    hash: str
    mode: str = "full"
    offset: int = 0
    file_size: int = 0
    sync_strategy: str = "full"
    metadata: dict = {}
    timestamp: float | None = None
    content: str = ""


class IngestResponse(BaseModel):
    status: str = "ok"
    document_id: str
    message: str = ""


@router.post("/file", response_model=IngestResponse)
async def ingest_file_endpoint(
    req: IngestFileRequest,
    _collector_user: User = Depends(verify_collector_token),
    _throttle: None = Depends(throttle_ingest),
    db: AsyncSession = Depends(get_db),
    x_device_id: str = Header("unknown"),
    x_device_name: str = Header("unknown"),
    x_device_platform: str = Header("unknown"),
) -> IngestResponse:
    """Ingest a file from the collector (JSON payload, for files < 1MB)."""
    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)

    doc = await ingest_file(
        db=db,
        tool_id=req.tool,
        category=req.category,
        content_type=req.content_type,
        relative_path=req.relative_path,
        content=req.content,
        content_hash=req.hash,
        file_size=req.file_size or len(req.content.encode("utf-8")),
        mode=req.mode,
        offset=req.offset,
        metadata=req.metadata,
        timestamp=req.timestamp,
        machine_id=str(machine.id),
        user_id=str(_collector_user.id),
    )
    return IngestResponse(document_id=str(doc.id), message="Ingested successfully")


@router.post("/discovery")
async def ingest_discovery(
    req: dict,
    _collector_user: User = Depends(verify_collector_token),
    _throttle: None = Depends(throttle_ingest),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Receive tool discovery data from a collector."""
    device_id = req.get("device_id", "unknown")
    machine = await ensure_device(db, device_id, req.get("device_name", ""), req.get("platform", ""), user_id=_collector_user.id)

    # Clean up paths in discovery data (URL decode, strip \\?\)
    tools_data = req.get("tools", {})
    for t_id, tool_info in tools_data.items():
        if isinstance(tool_info, dict):
            if "root" in tool_info:
                tool_info["root"] = re.sub(r"^\\\\?\?\\", "", unquote(tool_info["root"]))
            for proj in tool_info.get("projects", []):
                if isinstance(proj, dict):
                    if "path" in proj:
                        proj["path"] = re.sub(r"^\\\\?\?\\", "", unquote(proj["path"]))
                    p_name = proj.get("name") or (proj.get("path") or "").replace("\\", "/").rstrip("/").split("/")[-1]
                    p_path = proj.get("path")
                    if p_name:
                        clean_name = _prettify_project_name(p_name)
                        if clean_name and not _is_invalid_project_name(clean_name):
                            try:
                                await ensure_project(db, t_id, clean_name, source_path=p_path)
                            except Exception:
                                pass

    discovery_content = json.dumps(tools_data, indent=2, ensure_ascii=False)
    content_hash = hashlib.sha256(discovery_content.encode("utf-8")).hexdigest()
    await ingest_file(
        db=db, tool_id="system", category="discovery", content_type="json",
        relative_path=f"discovery/{device_id}.json",
        content=discovery_content, content_hash=content_hash,
        file_size=len(discovery_content), mode="full", offset=0,
        metadata={"device_id": device_id, "device_name": req.get("device_name", ""),
                  "platform": req.get("platform", ""), "tool_count": len(req.get("tools", {}))},
        machine_id=str(machine.id),
        user_id=str(_collector_user.id),
    )
    return {"status": "ok", "tools_discovered": len(req.get("tools", {}))}


@router.post("/heartbeat")
async def heartbeat(
    request: Request,
    _collector_user: User = Depends(verify_collector_token),
    _throttle: None = Depends(throttle_ingest),
    db: AsyncSession = Depends(get_db),
    x_device_id: str = Header("unknown"),
    x_device_name: str = Header("unknown"),
    x_device_platform: str = Header("unknown"),
) -> dict:
    """Collector heartbeat — also registers/updates the device."""
    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)

    resp = {
        "status": "ok",
        "device_id": str(machine.id),
        "received_at": datetime.now(timezone.utc).isoformat(),
    }
    # On the server's LAN the device can skip the public entry; lan-hello lets it check it reached this server
    lan_urls = [u.strip().rstrip("/") for u in settings.lan_urls.split(",") if u.strip()]
    if lan_urls:
        resp["lan"] = {"urls": lan_urls, "key": _lan_key(x_device_id)}

    # Remote execution: mint this device's key on first heartbeat after the
    # operator turns the feature on, and hand it back over this already
    # authenticated channel. The point is that enabling remote execution is a
    # single server-side switch — no per-device configuration to copy around.
    #
    # When the switch is off we send nothing, so a collector that has never
    # been enabled simply never learns a key and never polls for work.
    if REMOTE_EXEC_ENABLED:
        if not machine.remote_exec_key:
            machine.remote_exec_key = secrets.token_urlsafe(32)
            await db.commit()
        resp["remote_exec_key"] = machine.remote_exec_key

    return resp


def _lan_key(device_id: str) -> str:
    """Per-device key the heartbeat hands out over TLS; only this server can derive it."""
    return hmac.new(settings.secret_key.encode(), f"lan:{device_id}".encode(), hashlib.sha256).hexdigest()


def _came_from_lan(request: Request) -> bool:
    """Every hop private: a request through the public entry carries the caller's public address in
    X-Forwarded-For (the entry's nginx appends it, so the caller can't scrub it)."""
    hops = [h.strip() for h in (request.headers.get("x-forwarded-for") or "").split(",") if h.strip()]
    if not hops and request.client and request.client.host:
        hops.append(request.client.host)  # straight to the pod, inside the cluster
    try:
        return bool(hops) and all(ipaddress.ip_address(h).is_private or ipaddress.ip_address(h).is_loopback for h in hops)
    except ValueError:
        return False


@router.get("/lan-hello")
async def lan_hello(device: str, challenge: str, request: Request) -> dict:
    """Proves to a device on the LAN that it reached this server before it sends its token over plain
    HTTP: HMAC of its challenge under the key its heartbeat got. Only answered for LAN callers, so a
    host posing as the server on another network can't fetch proofs through the public entry."""
    if not _came_from_lan(request) or not (8 <= len(challenge) <= 128):
        raise HTTPException(status_code=404)
    return {"proof": hmac.new(_lan_key(device).encode(), challenge.encode(), hashlib.sha256).hexdigest()}
