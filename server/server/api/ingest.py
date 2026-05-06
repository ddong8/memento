"""Ingest API — receives files from collectors on multiple devices."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, Header, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import verify_collector_token
from ..services.device_service import ensure_device
from ..services.ingest_service import ingest_file, _get_ingest_semaphore

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


@router.post("/file/upload", response_model=IngestResponse)
async def ingest_file_upload(
    metadata: str = Form(...),
    content: UploadFile = File(...),
    _collector_user: User = Depends(verify_collector_token),
    _throttle: None = Depends(throttle_ingest),
    db: AsyncSession = Depends(get_db),
    x_device_id: str = Header("unknown"),
    x_device_name: str = Header("unknown"),
    x_device_platform: str = Header("unknown"),
) -> IngestResponse:
    """Ingest a large file via multipart upload."""
    meta = json.loads(metadata)
    file_content = (await content.read()).decode("utf-8", errors="replace")
    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)

    doc = await ingest_file(
        db=db,
        tool_id=meta["tool"],
        category=meta["category"],
        content_type=meta["content_type"],
        relative_path=meta["relative_path"],
        content=file_content,
        content_hash=meta["hash"],
        file_size=meta.get("file_size", len(file_content.encode("utf-8"))),
        mode=meta.get("mode", "full"),
        offset=meta.get("offset", 0),
        metadata=meta.get("metadata", {}),
        timestamp=meta.get("timestamp"),
        machine_id=str(machine.id),
        user_id=str(_collector_user.id),
    )
    return IngestResponse(document_id=str(doc.id), message="Uploaded successfully")


@router.post("/sqlite-rows", response_model=IngestResponse)
async def ingest_sqlite_rows(
    req: dict,
    _collector_user: User = Depends(verify_collector_token),
    _throttle: None = Depends(throttle_ingest),
    db: AsyncSession = Depends(get_db),
    x_device_id: str = Header("unknown"),
    x_device_name: str = Header("unknown"),
    x_device_platform: str = Header("unknown"),
) -> IngestResponse:
    """Ingest exported SQLite rows as JSON."""
    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)
    content = json.dumps(req.get("rows", []), ensure_ascii=False)
    doc = await ingest_file(
        db=db,
        tool_id=req["tool"],
        category="state",
        content_type="sqlite_export",
        relative_path=f"{req.get('db_path', 'unknown')}/{req.get('source_table', 'unknown')}",
        content=content,
        content_hash="",
        file_size=len(content.encode("utf-8")),
        mode="delta" if req.get("last_rowid", 0) > 0 else "full",
        offset=req.get("last_rowid", 0),
        metadata={"source_table": req.get("source_table"), "db_path": req.get("db_path")},
        machine_id=str(machine.id),
        user_id=str(_collector_user.id),
    )
    return IngestResponse(document_id=str(doc.id), message="SQLite rows ingested")


# In-memory chunk buffer for chunked uploads
_chunk_buffers: dict[str, dict] = {}


@router.post("/file/chunk", response_model=IngestResponse)
async def ingest_file_chunk(
    metadata: str = Form(...),
    content: UploadFile = File(...),
    _collector_user: User = Depends(verify_collector_token),
    _throttle: None = Depends(throttle_ingest),
    db: AsyncSession = Depends(get_db),
    x_device_id: str = Header("unknown"),
    x_device_name: str = Header("unknown"),
    x_device_platform: str = Header("unknown"),
) -> IngestResponse:
    """Receive a chunk of a large file. Assembles and ingests when all chunks arrive."""
    meta = json.loads(metadata)
    chunk_data = await content.read()
    upload_id = meta["upload_id"]
    chunk_index = meta["chunk_index"]
    total_chunks = meta["total_chunks"]

    # Initialize buffer
    if upload_id not in _chunk_buffers:
        _chunk_buffers[upload_id] = {
            "meta": meta,
            "chunks": {},
            "total_chunks": total_chunks,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    _chunk_buffers[upload_id]["chunks"][chunk_index] = chunk_data

    # Check if all chunks received
    buf = _chunk_buffers[upload_id]
    if len(buf["chunks"]) < total_chunks:
        return IngestResponse(
            document_id="pending",
            message=f"Chunk {chunk_index + 1}/{total_chunks} received",
        )

    # All chunks received — assemble and ingest
    full_content = b"".join(buf["chunks"][i] for i in range(total_chunks))
    del _chunk_buffers[upload_id]

    file_content = full_content.decode("utf-8", errors="replace")
    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)

    doc = await ingest_file(
        db=db,
        tool_id=meta["tool"],
        category=meta["category"],
        content_type=meta["content_type"],
        relative_path=meta["relative_path"],
        content=file_content,
        content_hash=meta["hash"],
        file_size=len(full_content),
        mode=meta.get("mode", "full"),
        offset=meta.get("offset", 0),
        metadata=meta.get("metadata", {}),
        timestamp=meta.get("timestamp"),
        machine_id=str(machine.id),
        user_id=str(_collector_user.id),
    )
    return IngestResponse(
        document_id=str(doc.id),
        message=f"Assembled {total_chunks} chunks ({len(full_content)} bytes), ingested",
    )


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
    from urllib.parse import unquote
    import re as _re
    tools_data = req.get("tools", {})
    for tool_info in tools_data.values():
        if isinstance(tool_info, dict):
            if "root" in tool_info:
                tool_info["root"] = _re.sub(r"^\\\\?\?\\", "", unquote(tool_info["root"]))
            for proj in tool_info.get("projects", []):
                if "path" in proj:
                    proj["path"] = _re.sub(r"^\\\\?\?\\", "", unquote(proj["path"]))

    discovery_content = json.dumps(tools_data, indent=2, ensure_ascii=False)
    doc = await ingest_file(
        db=db, tool_id="system", category="discovery", content_type="json",
        relative_path=f"discovery/{device_id}.json",
        content=discovery_content, content_hash=f"discovery-{device_id}",
        file_size=len(discovery_content), mode="full", offset=0,
        metadata={"device_id": device_id, "device_name": req.get("device_name", ""),
                  "platform": req.get("platform", ""), "tool_count": len(req.get("tools", {}))},
        machine_id=str(machine.id),
        user_id=str(_collector_user.id),
    )
    return {"status": "ok", "tools_discovered": len(req.get("tools", {}))}


@router.get("/status")
async def ingest_status() -> dict:
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@router.post("/heartbeat")
async def heartbeat(
    _collector_user: User = Depends(verify_collector_token),
    _throttle: None = Depends(throttle_ingest),
    db: AsyncSession = Depends(get_db),
    x_device_id: str = Header("unknown"),
    x_device_name: str = Header("unknown"),
    x_device_platform: str = Header("unknown"),
) -> dict:
    """Collector heartbeat — also registers/updates the device."""
    machine = await ensure_device(db, x_device_id, x_device_name, x_device_platform, user_id=_collector_user.id)
    return {
        "status": "ok",
        "device_id": str(machine.id),
        "received_at": datetime.now(timezone.utc).isoformat(),
    }
