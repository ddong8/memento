"""Ingest API — receives files from collectors on multiple devices."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.tasks import REMOTE_EXEC_ENABLED
from ..config import settings
from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import verify_collector_token
from ..services.device_service import ensure_device
from ..services.ingest_service import (
    OffsetMismatch,
    claim_slice,
    lock_slice,
    ensure_project,
    ingest_file,
    _get_ingest_semaphore,
    _is_invalid_project_name,
    _prettify_project_name,
)

logger = logging.getLogger(__name__)

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
    # Where a slice of a log ends in the file (bytes): the server takes it only if it starts where
    # the last one ended (ingest_service.claim_slice). Collectors before 1.0.95 don't send it.
    end_offset: int | None = None


class IngestResponse(BaseModel):
    status: str = "ok"
    document_id: str
    message: str = ""
    # Where the server's copy of the log ends now: the collector's next slice starts there
    next_offset: int | None = None


async def _ingest_one(db: AsyncSession, f: IngestFileRequest, machine_id: str, user_id: str) -> tuple[str, int | None]:
    """Store one file or slice of a log: (document id, where the server's copy of it ends). Raises
    OffsetMismatch for a slice that doesn't fit what's stored."""
    if f.end_offset is not None:
        claimed = await claim_slice(db, f.tool, f.relative_path, machine_id, f.mode, f.offset, f.end_offset)
        if claimed is not None:
            return str(claimed[0]), claimed[1]  # stored already: a retry whose first upload went through
    else:
        await lock_slice(db, machine_id, f.tool, f.relative_path)  # a collector from before end_offset
    doc = await ingest_file(
        db=db,
        tool_id=f.tool,
        category=f.category,
        content_type=f.content_type,
        relative_path=f.relative_path,
        content=f.content,
        content_hash=f.hash,
        file_size=f.file_size or len(f.content.encode("utf-8")),
        mode=f.mode,
        offset=f.offset,
        metadata=f.metadata,
        timestamp=f.timestamp,
        machine_id=machine_id,
        user_id=user_id,
        end_offset=f.end_offset,
    )
    return str(doc.id), f.end_offset


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
    """Ingest a file from the collector (JSON payload, for files < 1MB). 409 with expected_offset for a
    slice of a log that doesn't start where the server's copy ends: the collector reads again from there."""
    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)
    try:
        doc_id, next_offset = await _ingest_one(db, req, str(machine.id), str(_collector_user.id))
    except OffsetMismatch as e:
        await db.commit()  # the device's record; the claim wrote nothing
        raise HTTPException(status_code=409, detail={"expected_offset": e.expected})
    # Before the response: get_db's commit runs only after it's sent (FastAPI 0.118+), so a collector
    # was told 200, moved on, and a failed commit lost the slice for good
    await db.commit()
    return IngestResponse(document_id=doc_id, message="Ingested successfully", next_offset=next_offset)


class IngestFilesRequest(BaseModel):
    files: list[IngestFileRequest] = Field(..., min_length=1, max_length=100)


@router.post("/files")
async def ingest_files_endpoint(
    req: IngestFilesRequest,
    _collector_user: User = Depends(verify_collector_token),
    _throttle: None = Depends(throttle_ingest),
    db: AsyncSession = Depends(get_db),
    x_device_id: str = Header("unknown"),
    x_device_name: str = Header("unknown"),
    x_device_platform: str = Header("unknown"),
) -> dict:
    """Several small files in one request: a collector catching up sent each of 1,600 files on its
    own (2026-10-28, 440 requests a minute from one Windows machine). Each file is committed on its
    own, so one that fails doesn't take the others with it; the result lists them in order."""
    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)
    # Plain strings: a rollback below expires the ORM objects, and reading one then would hit the database
    machine_id, user_id = str(machine.id), str(_collector_user.id)
    await db.commit()
    results: list[dict] = []
    for f in req.files:
        try:
            doc_id, next_offset = await _ingest_one(db, f, machine_id, user_id)
            await db.commit()
            results.append({"ok": True, "document_id": doc_id, "next_offset": next_offset})
        except OffsetMismatch as e:
            await db.rollback()
            results.append({"ok": False, "expected_offset": e.expected})
        except Exception as e:
            await db.rollback()
            logger.warning("Batch ingest of %s failed: %s", f.relative_path, e)
            results.append({"ok": False, "error": str(e)[:200]})
    return {"status": "ok", "results": results}


class ReconcileFile(BaseModel):
    tool: str
    relative_path: str
    offset: int


class ReconcileRequest(BaseModel):
    files: list[ReconcileFile] = Field(..., max_length=1000)


@router.post("/reconcile")
async def reconcile_offsets(
    req: ReconcileRequest,
    _collector_user: User = Depends(verify_collector_token),
    _throttle: None = Depends(throttle_ingest),
    db: AsyncSession = Depends(get_db),
    x_device_id: str = Header("unknown"),
    x_device_name: str = Header("unknown"),
    x_device_platform: str = Header("unknown"),
) -> dict:
    """The logs whose copy here doesn't end where the collector's offset says (a slice whose commit
    failed, an offsets file the collector lost), with where it does end: the collector reads them
    again from there. A log the server has nothing of isn't listed: its data was deleted on purpose."""
    from sqlalchemy import select, tuple_

    from ..db.models import SyncState

    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)
    wanted = {(f.tool, f.relative_path): f.offset for f in req.files}
    out: list[dict] = []
    if wanted:
        rows = await db.execute(
            select(SyncState.tool_id, SyncState.relative_path, SyncState.last_end_offset).where(
                SyncState.machine_id == machine.id,
                SyncState.last_end_offset.isnot(None),
                tuple_(SyncState.tool_id, SyncState.relative_path).in_(list(wanted)),
            )
        )
        for tool_id, path, end in rows.all():
            if wanted.get((tool_id, path)) != end:
                out.append({"tool": tool_id, "relative_path": path, "expected_offset": end})
    await db.commit()
    return {"status": "ok", "files": out}


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
    """Collector heartbeat — also registers/updates the device. The body may carry how collection is
    going ({"collect": {...}}: backlog, failing files, upload lag), shown on the devices page."""
    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)
    try:
        raw = await request.body()
        body = json.loads(raw) if raw else None
    except ValueError:
        body = None
    collect = body.get("collect") if isinstance(body, dict) else None
    if isinstance(collect, dict) and len(json.dumps(collect)) <= 16_000:
        machine.collect_status = {**collect, "reported_at": datetime.now(timezone.utc).isoformat()}
        await db.commit()

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
