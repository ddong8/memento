"""Devices API — view and manage registered collector devices."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import mimetypes
import os
import tempfile
import time
import urllib.parse
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AccessLog, ConversationMessage, Document, DocumentVersion, Machine, Project, SyncState, User
from ..db.session import get_db
from ..middleware.auth import get_current_user, get_current_user_flexible, get_optional_user
from ..services.cache import cache_delete_prefix, cache_get, cache_set
from ..services.cluster import PREFIX, cluster
from ..services.user_filter import normalize_device_name, user_machine_ids
from ..services.ws_manager import ws_manager

router = APIRouter(prefix="/api/devices", tags=["devices"])
logger = logging.getLogger("server.devices")

# Command queue per device_id (collector_token_hash), picked up on the device's
# next poll. In Redis so a command queued through one api replica reaches a
# device polling another; this process's memory only without Redis.
# Format: [{id, action, created_at}, ...]
_command_queue: dict[str, list[dict]] = defaultdict(list)
_cmd_counter = 0
_CMD_KEY = f"{PREFIX}devcmd:"
_CMD_SEQ = f"{PREFIX}devcmd-seq"
_CMD_TTL = 7 * 86400


async def _enqueue_command(device_collector_id: str, action: str) -> int:
    """Add a command to the queue for a device."""
    global _cmd_counter
    r = cluster.redis
    if r is not None:
        try:
            cmd_id = int(await r.incr(_CMD_SEQ))
            cmd = {"id": cmd_id, "action": action, "created_at": time.time()}
            pipe = r.pipeline(transaction=False)
            pipe.rpush(_CMD_KEY + device_collector_id, json.dumps(cmd))
            pipe.expire(_CMD_KEY + device_collector_id, _CMD_TTL)
            await pipe.execute()
            return cmd_id
        except Exception as e:
            logger.warning("queueing %s for %s in Redis failed, keeping it here: %s", action, device_collector_id, e)
    _cmd_counter += 1
    _command_queue[device_collector_id].append({
        "id": _cmd_counter,
        "action": action,
        "created_at": time.time(),
    })
    return _cmd_counter


async def _pending_commands(device_collector_id: str) -> list[dict]:
    commands = list(_command_queue.get(device_collector_id, []))
    r = cluster.redis
    if r is not None:
        try:
            commands += [json.loads(c) for c in await r.lrange(_CMD_KEY + device_collector_id, 0, -1)]
        except Exception as e:
            logger.warning("reading commands for %s failed: %s", device_collector_id, e)
    return commands


async def _ack_command(device_collector_id: str, cmd_id: int) -> None:
    queue = _command_queue.get(device_collector_id, [])
    _command_queue[device_collector_id] = [c for c in queue if c["id"] != cmd_id]
    r = cluster.redis
    if r is not None:
        try:
            for raw in await r.lrange(_CMD_KEY + device_collector_id, 0, -1):
                if json.loads(raw).get("id") == cmd_id:
                    await r.lrem(_CMD_KEY + device_collector_id, 0, raw)
        except Exception as e:
            logger.warning("acking command %s for %s failed: %s", cmd_id, device_collector_id, e)


@router.get("")
async def list_devices(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """List all registered collector devices with their stats."""
    machines_q = select(Machine).where(Machine.merged_into.is_(None)).order_by(Machine.last_heartbeat.desc().nulls_last())
    if _user.role not in ("admin", "owner"):
        machines_q = machines_q.where(Machine.user_id == _user.id)
    machines = list((await db.execute(machines_q)).scalars().all())
    if not machines:
        return []

    machine_ids = [m.id for m in machines]

    # One GROUP BY replaces the per-machine COUNT + DISTINCT round-trips (cached for 60s).
    stats_cache_key = f"devices:stats:{_user.id}"
    cached_stats = await cache_get(stats_cache_key)
    if cached_stats is not None:
        totals_by_name = cached_stats.get("totals", {})
        tools_by_name = cached_stats.get("tools", {})
    else:
        stats_q = (
            select(Document.machine_id, Document.tool_id, func.count())
            .where(Document.machine_id.in_(machine_ids), Document.tool_id != "system")
            .group_by(Document.machine_id, Document.tool_id)
        )
        totals_by_name = {}
        tools_by_name = {}
        name_by_mid = {m.id: m.name for m in machines}
        for mid, tid, n in (await db.execute(stats_q)).all():
            mname = name_by_mid.get(mid, "")
            totals_by_name[mname] = totals_by_name.get(mname, 0) + n
            tlist = tools_by_name.setdefault(mname, [])
            if tid not in tlist:
                tlist.append(tid)
        await cache_set(stats_cache_key, {"totals": totals_by_name, "tools": tools_by_name}, ttl_seconds=60)

    items = []
    seen_names = set()
    now_utc = datetime.now(timezone.utc)
    for m in machines:
        if m.name in seen_names:
            continue
        seen_names.add(m.name)
        hb = m.last_heartbeat
        if hb and hb.tzinfo is None:
            hb = hb.replace(tzinfo=timezone.utc)
        age_sec = (now_utc - hb).total_seconds() if hb else None

        has_ws = False
        candidates = [m.collector_token_hash, m.name, normalize_device_name(m.name), str(m.id)]
        for cand in candidates:
            if cand and ws_manager.has_device(cand):
                has_ws = True
                break

        is_online = has_ws or (age_sec is not None and age_sec < 180)

        items.append({
            "id": str(m.id),
            "name": m.name,
            "device_id": m.collector_token_hash,
            "collector_version": m.collector_version,
            "last_heartbeat": hb.isoformat() if hb else None,
            "online": is_online,
            "created_at": m.created_at.isoformat(),
            "document_count": totals_by_name.get(m.name, 0),
            "tools": tools_by_name.get(m.name, []),
        })

    return items


async def _verify_device_ownership(
    db: AsyncSession, device_db_id: uuid.UUID, user: User,
) -> Machine:
    """Fetch a machine and verify the user has access. Raises 404 if not found or not owned."""
    result = await db.execute(select(Machine).where(Machine.id == device_db_id))
    machine = result.scalar_one_or_none()
    if not machine:
        raise HTTPException(status_code=404, detail="Device not found")
    if user.role not in ("admin", "owner") and machine.user_id != user.id:
        raise HTTPException(status_code=404, detail="Device not found")
    return machine


@router.get("/{device_db_id}/discovery")
async def get_device_discovery(
    device_db_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Get discovery data (tool paths, projects) for a device."""
    machine = await _verify_device_ownership(db, device_db_id, _user)

    # Find the discovery document for this device
    doc_result = await db.execute(
        select(Document).where(
            Document.tool_id == "system",
            Document.category == "discovery",
            Document.machine_id == device_db_id,
        ).order_by(Document.synced_at.desc()).limit(1)
    )
    doc = doc_result.scalar_one_or_none()

    if not doc or not doc.content:
        return {"device_id": str(device_db_id), "tools": {}}

    try:
        tools = json.loads(doc.content)
    except Exception:
        tools = {}

    return {
        "device_id": str(device_db_id),
        "device_name": machine.name,
        "synced_at": doc.synced_at.isoformat(),
        "tools": tools,
    }


async def _purge_device_data(
    db: AsyncSession, device_db_id: uuid.UUID, include_system: bool = False,
) -> dict:
    """Delete all data tied to a device: documents and everything that references them,
    plus this device's sync_state. Also cleans up orphaned knowledge entities and projects.

    include_system=True deletes discovery/system docs too (used for full device deletion).
    """
    from ..db.models import DocumentEmbedding, KnowledgeEntity, KnowledgeObservation, KnowledgeRelation

    doc_q = select(Document.id).where(Document.machine_id == device_db_id)
    if not include_system:
        doc_q = doc_q.where(Document.tool_id != "system")
    doc_ids = [r[0] for r in (await db.execute(doc_q)).all()]
    count = len(doc_ids)

    batch_size = 500
    for i in range(0, len(doc_ids), batch_size):
        batch = doc_ids[i:i + batch_size]
        await db.execute(delete(AccessLog).where(AccessLog.document_id.in_(batch)))
        await db.execute(delete(ConversationMessage).where(ConversationMessage.document_id.in_(batch)))
        await db.execute(delete(DocumentVersion).where(DocumentVersion.document_id.in_(batch)))
        await db.execute(delete(DocumentEmbedding).where(DocumentEmbedding.document_id.in_(batch)))
        await db.execute(delete(KnowledgeObservation).where(KnowledgeObservation.source_document_id.in_(batch)))
        await db.execute(delete(Document).where(Document.id.in_(batch)))

    # Drop knowledge entities that have no observations left (fully orphaned by the purge)
    orphan_entity_ids = [r[0] for r in (await db.execute(
        select(KnowledgeEntity.id).where(
            ~KnowledgeEntity.id.in_(
                select(KnowledgeObservation.entity_id).where(KnowledgeObservation.entity_id.isnot(None))
            )
        )
    )).all()]
    if orphan_entity_ids:
        await db.execute(delete(KnowledgeRelation).where(
            KnowledgeRelation.source_id.in_(orphan_entity_ids) | KnowledgeRelation.target_id.in_(orphan_entity_ids)
        ))
        await db.execute(delete(KnowledgeEntity).where(KnowledgeEntity.id.in_(orphan_entity_ids)))

    # Drop projects with no docs left
    orphan_ids = [r[0] for r in (await db.execute(
        select(Project.id).where(
            ~Project.id.in_(select(Document.project_id).where(Document.project_id.isnot(None)))
        )
    )).all()]
    if orphan_ids:
        await db.execute(delete(Project).where(Project.id.in_(orphan_ids)))

    await db.execute(delete(SyncState).where(SyncState.machine_id == device_db_id))

    return {
        "documents_deleted": count,
        "orphaned_entities_deleted": len(orphan_entity_ids),
        "orphaned_projects_deleted": len(orphan_ids),
    }


@router.delete("/{device_db_id}")
async def delete_device(
    device_db_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Delete a device and ALL its associated data (documents, messages, embeddings,
    knowledge observations, sync state, orphaned projects/entities)."""
    machine = await _verify_device_ownership(db, device_db_id, _user)

    stats = await _purge_device_data(db, device_db_id, include_system=True)
    await db.execute(delete(Machine).where(Machine.id == device_db_id))

    await cache_delete_prefix(f"devices:stats:{_user.id}")
    await cache_delete_prefix(f"hierarchy:devices:{_user.id}")
    await cache_delete_prefix(f"dashboard:{_user.id}")
    await cache_delete_prefix(f"tools:list:{_user.id}")
    await cache_delete_prefix(f"projects:list:{_user.id}")

    return {"status": "deleted", "device_id": str(device_db_id), "name": machine.name, **stats}


@router.delete("/{device_db_id}/purge")
async def purge_device(
    device_db_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Delete all documents + related data but keep the device record (used before resync)."""
    machine = await _verify_device_ownership(db, device_db_id, _user)
    stats = await _purge_device_data(db, device_db_id, include_system=False)

    await cache_delete_prefix(f"devices:stats:{_user.id}")
    await cache_delete_prefix(f"hierarchy:devices:{_user.id}")
    await cache_delete_prefix(f"dashboard:{_user.id}")
    await cache_delete_prefix(f"tools:list:{_user.id}")
    await cache_delete_prefix(f"projects:list:{_user.id}")

    return {"status": "purged", "device_id": str(device_db_id), "name": machine.name, **stats}


# ---------------------------------------------------------------------------
# Device commands — server → collector communication
# ---------------------------------------------------------------------------

@router.post("/{device_db_id}/command")
async def send_command(
    device_db_id: uuid.UUID,
    action: str = "resync",
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Send a command to a collector device (picked up on next poll)."""
    machine = await _verify_device_ownership(db, device_db_id, _user)

    # Resync: clear _graph_hash + embeddings + observations for this device's documents
    # so knowledge regenerates from fresh ingest
    if action == "resync":
        from sqlalchemy import text
        from ..db.models import DocumentEmbedding, KnowledgeObservation
        doc_ids_result = await db.execute(
            select(Document.id).where(Document.machine_id == device_db_id)
        )
        doc_ids = [r[0] for r in doc_ids_result.all()]
        if doc_ids:
            for i in range(0, len(doc_ids), 500):
                batch = doc_ids[i:i + 500]
                await db.execute(delete(DocumentEmbedding).where(DocumentEmbedding.document_id.in_(batch)))
                await db.execute(delete(KnowledgeObservation).where(KnowledgeObservation.source_document_id.in_(batch)))
            await db.execute(text(
                "UPDATE documents SET metadata = metadata - '_graph_hash' WHERE machine_id = :mid AND metadata ? '_graph_hash'"
            ), {"mid": device_db_id})

    cmd_id = await _enqueue_command(machine.collector_token_hash, action)
    return {"status": "queued", "command_id": cmd_id, "action": action, "device": machine.name}


@router.get("/commands")
async def get_commands(
    x_device_id: str = Header(..., alias="X-Device-Id"),
    x_collector_version: str = Header("", alias="X-Collector-Version"),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Collector polls this to get pending commands. Also updates heartbeat + version."""
    from datetime import datetime, timezone
    result = await db.execute(
        select(Machine).where(Machine.collector_token_hash == x_device_id)
    )
    machine = result.scalar_one_or_none()
    if machine:
        machine.last_heartbeat = datetime.now(timezone.utc)
        if x_collector_version:
            machine.collector_version = x_collector_version

    return await _pending_commands(x_device_id)


@router.post("/commands/{cmd_id}/ack")
async def ack_command(
    cmd_id: int,
    x_device_id: str = Header(..., alias="X-Device-Id"),
) -> dict:
    """Collector acknowledges a command — remove it from queue."""
    await _ack_command(x_device_id, cmd_id)
    return {"status": "acked", "command_id": cmd_id}


# Active prefetch tasks and in-memory cache registry for media streaming acceleration
_active_prefetch_tasks: dict[str, asyncio.Task] = {}
_known_cache_map: dict[str, tuple[int, str]] = {}  # clean_path -> (total_size, cached_file_path)


def _get_media_cache_dir() -> str:
    """Resolve fast media cache directory on disk, preferring /data2 per architecture guidelines."""
    for candidate in ("/data2/media_cache", "data/media_cache", os.path.join(tempfile.gettempdir(), "memento_media_cache")):
        try:
            os.makedirs(candidate, exist_ok=True)
            test_file = os.path.join(candidate, f".test_{os.getpid()}")
            with open(test_file, "w") as f:
                f.write("ok")
            os.remove(test_file)
            return candidate
        except Exception:
            continue
    return tempfile.gettempdir()


async def _background_prefetch_media(
    dev_token: str,
    device_id: str,
    target_machine_name: str | None,
    clean_path: str,
    total_size: int,
    cached_path: str,
    cache_key: str,
) -> None:
    """Asynchronously prefetch remote media file in 2MB chunks to local disk cache."""
    part_path = f"{cached_path}.part"
    try:
        if os.path.exists(cached_path) and os.path.getsize(cached_path) == total_size:
            return

        chunk_size = 2 * 1024 * 1024  # 2 MB chunks for high-throughput background sync
        curr = 0
        if os.path.exists(part_path):
            curr = os.path.getsize(part_path)
            if curr > total_size:
                curr = 0
                try:
                    os.remove(part_path)
                except Exception:
                    pass

        with open(part_path, "ab" if curr > 0 else "wb") as f:
            while curr < total_size:
                read_len = min(chunk_size, total_size - curr)
                chunk = await ws_manager.request_file_chunk(dev_token, clean_path, curr, read_len)
                if not chunk and device_id != dev_token:
                    chunk = await ws_manager.request_file_chunk(device_id, clean_path, curr, read_len)
                if not chunk and target_machine_name:
                    chunk = await ws_manager.request_file_chunk(target_machine_name, clean_path, curr, read_len)
                if not chunk:
                    logger.warning("Background prefetch interrupted at %d/%d for %s", curr, total_size, clean_path)
                    return
                f.write(chunk)
                curr += len(chunk)
                await asyncio.sleep(0.005)

        if os.path.exists(part_path) and os.path.getsize(part_path) == total_size:
            os.replace(part_path, cached_path)
            logger.info("Successfully cached media file %s (%d bytes) at %s", clean_path, total_size, cached_path)
            _known_cache_map[clean_path] = (total_size, cached_path)
    except Exception as e:
        logger.warning("Failed background prefetch for %s: %s", clean_path, e)
    finally:
        _active_prefetch_tasks.pop(cache_key, None)


@router.api_route("/{device_id}/files/stream", methods=["GET", "HEAD"])
@router.api_route("/{device_id}/files/stream/{filename}", methods=["GET", "HEAD"])
async def stream_device_file(
    device_id: str,
    path: str = Query(..., description="Absolute path on the device or NAS"),
    filename: str = None,
    share_token: str = Query(None, description="Optional public share token for anonymous visitors"),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_optional_user),
):
    """Stream a media or artifact file directly from target device with HTTP 206 Range, disk cache and pipelining."""
    from ..services.user_filter import find_machine_by_id_or_hash
    from ..db.models import ShareLink

    # If unauthenticated, check if a valid public ShareLink token was supplied
    if _user is None:
        effective_token = share_token or (request.query_params.get("token") if request else None)
        if effective_token:
            st_link = (await db.execute(
                select(ShareLink).where(
                    ShareLink.token == effective_token,
                    ShareLink.revoked_at.is_(None),
                )
            )).scalar_one_or_none()
            if st_link and (not st_link.expires_at or st_link.expires_at > datetime.now(timezone.utc)):
                _user = (await db.execute(select(User).where(User.id == st_link.owner_user_id))).scalar_one_or_none()

    if _user is None:
        _user = await get_current_user_flexible(
            authorization=request.headers.get("Authorization") if request else None,
            token_query=request.query_params.get("token") if request else None,
            token_bearer=request.query_params.get("access_token") if request else None,
            db=db,
        )

    target_machine = await find_machine_by_id_or_hash(db, device_id, _user)
    mids = await user_machine_ids(db, _user)

    if _user.role not in ("admin", "owner"):
        if target_machine and mids is not None and target_machine.id not in mids:
            raise HTTPException(status_code=403, detail="Device access denied")

    # Defensive recursive unquote in case client double-encoded or path contains %XX
    clean_path = path.strip()
    for _ in range(3):
        unquoted = urllib.parse.unquote(clean_path)
        if unquoted == clean_path:
            break
        clean_path = unquoted

    clean_path = clean_path.replace("\\", "/")
    if clean_path.startswith("file://"):
        clean_path = clean_path.replace("file://", "")
        if clean_path.startswith("/") and len(clean_path) > 3 and clean_path[2] == ":":
            clean_path = clean_path[1:]

    # Path traversal check
    if any(p == ".." for p in clean_path.split("/")):
        raise HTTPException(status_code=400, detail="Path traversal forbidden")

    raw_clean_path = clean_path
    ext = os.path.splitext(clean_path)[1].lower()
    mime_type, _ = mimetypes.guess_type(clean_path)
    if not mime_type:
        if ext in (".mp4", ".m4v"):
            mime_type = "video/mp4"
        elif ext in (".mov",):
            mime_type = "video/quicktime"
        elif ext in (".webm",):
            mime_type = "video/webm"
        elif ext in (".mp3",):
            mime_type = "audio/mpeg"
        elif ext in (".wav",):
            mime_type = "audio/wav"
        elif ext in (".m4a", ".aac"):
            mime_type = "audio/mp4"
        elif ext in (".srt", ".vtt"):
            mime_type = "text/vtt; charset=utf-8"
        elif ext in (".html", ".htm"):
            mime_type = "text/html; charset=utf-8"
        elif ext in (".png",):
            mime_type = "image/png"
        elif ext in (".jpg", ".jpeg"):
            mime_type = "image/jpeg"
        elif ext in (".webp",):
            mime_type = "image/webp"
        elif ext in (".svg",):
            mime_type = "image/svg+xml"
        else:
            mime_type = "application/octet-stream"

    total_size = 0
    is_local = os.path.exists(clean_path) and os.path.isfile(clean_path)
    if not is_local and "_720p" in clean_path:
        alt_path = clean_path.replace("_720p", "")
        if os.path.exists(alt_path) and os.path.isfile(alt_path):
            clean_path = alt_path
            is_local = True

    cache_dir = _get_media_cache_dir()

    # Check in-memory fast registry for cached media on local SSD
    if not is_local and raw_clean_path in _known_cache_map:
        cached_size, cached_path = _known_cache_map[raw_clean_path]
        if os.path.exists(cached_path) and os.path.getsize(cached_path) == cached_size:
            clean_path = cached_path
            is_local = True
            total_size = cached_size

    dev_token = target_machine.collector_token_hash if target_machine else device_id
    if is_local:
        if total_size <= 0:
            total_size = os.path.getsize(clean_path)
    else:
        stat = await ws_manager.request_file_stat(dev_token, clean_path)
        if not stat.get("exists") and device_id != dev_token:
            stat = await ws_manager.request_file_stat(device_id, clean_path)
        if not stat.get("exists") and target_machine and target_machine.name:
            stat = await ws_manager.request_file_stat(target_machine.name, clean_path)

        # If not found or if device_id was "auto", discover which of the user's online devices hosts this file
        if not stat.get("exists"):
            query = select(Machine)
            if _user.role not in ("admin", "owner") and mids is not None:
                query = query.where(Machine.id.in_(mids))
            user_machines = (await db.execute(query)).scalars().all()

            candidates: list[str] = []
            for m in user_machines:
                if m.collector_token_hash and m.collector_token_hash not in candidates:
                    candidates.append(m.collector_token_hash)
                if m.name and m.name not in candidates:
                    candidates.append(m.name)
            if _user.role in ("admin", "owner"):
                for conn_id in ws_manager.connected_ids():
                    if conn_id not in candidates:
                        candidates.append(conn_id)

            for cand_token in candidates:
                if ws_manager.has_device(cand_token) and cand_token != dev_token:
                    cand_stat = await ws_manager.request_file_stat(cand_token, clean_path, timeout=3.5)
                    if cand_stat.get("exists"):
                        stat = cand_stat
                        dev_token = cand_token
                        break

        if not stat.get("exists"):
            err_msg = stat.get("error") or "offline"
            if err_msg == "offline":
                raise HTTPException(status_code=404, detail=f"Target device is offline or disconnected from WebSocket: {device_id}")
            raise HTTPException(status_code=404, detail=f"File not found on device ({clean_path}): {err_msg}")
        total_size = stat.get("size") or stat.get("total_size") or 0

        # Check if complete local cache exists for this clean_path and total_size
        if total_size > 0:
            cache_key = hashlib.sha256(f"{raw_clean_path}:{total_size}".encode()).hexdigest()
            cached_file_path = os.path.join(cache_dir, f"{cache_key}{ext}")
            if os.path.exists(cached_file_path) and os.path.getsize(cached_file_path) == total_size:
                clean_path = cached_file_path
                is_local = True
                _known_cache_map[raw_clean_path] = (total_size, cached_file_path)
            elif total_size <= 250 * 1024 * 1024 and cache_key not in _active_prefetch_tasks:
                # Trigger non-blocking background prefetch for medium-sized media
                prefetch_task = asyncio.create_task(
                    _background_prefetch_media(
                        dev_token=dev_token,
                        device_id=device_id,
                        target_machine_name=target_machine.name if target_machine else None,
                        clean_path=raw_clean_path,
                        total_size=total_size,
                        cached_path=cached_file_path,
                        cache_key=cache_key,
                    )
                )
                _active_prefetch_tasks[cache_key] = prefetch_task

    etag_key = hashlib.sha256(f"{raw_clean_path}:{total_size}".encode()).hexdigest()[:24]
    etag = f'"{etag_key}"'

    range_header = request.headers.get("range") if request else None

    # HTTP 304 Not Modified conditional response
    if_none_match = request.headers.get("if-none-match") if request else None
    if if_none_match and if_none_match.strip(' "') == etag_key and not range_header:
        return Response(
            status_code=304,
            headers={
                "ETag": etag,
                "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
            },
        )

    start = 0
    end = (total_size - 1) if total_size > 0 else 0
    status_code = 200

    if range_header and range_header.startswith("bytes="):
        parts = range_header.replace("bytes=", "").split("-")
        if parts[0]:
            start = int(parts[0])
        if len(parts) > 1 and parts[1]:
            end = int(parts[1])
        status_code = 206

    if start > end or (total_size > 0 and start >= total_size):
        return Response(status_code=416, headers={"Content-Range": f"bytes */{total_size}"})

    content_length = (end - start + 1) if total_size > 0 else 0

    quoted_fname = urllib.parse.quote(filename or os.path.basename(raw_clean_path) or "media-file")
    headers = {
        "Content-Type": mime_type,
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Content-Disposition": f'inline; filename="{quoted_fname}"; filename*=UTF-8\'\'{quoted_fname}',
        "ETag": etag,
        "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Range, Authorization, Content-Type, If-None-Match",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Content-Disposition, ETag, Cache-Control",
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{total_size}"

    if request and request.method == "HEAD":
        return Response(status_code=status_code, headers=headers)

    async def chunk_generator():
        curr = start
        if is_local:
            # 1 MB chunk for local SSD read
            chunk_size = 1024 * 1024
            with open(clean_path, "rb") as f:
                f.seek(curr)
                while curr <= end:
                    read_len = min(chunk_size, end - curr + 1)
                    data = f.read(read_len)
                    if not data:
                        break
                    curr += len(data)
                    yield data
        else:
            # Remote streaming with adaptive chunking (512KB first chunk for instant TTFB, 2MB subsequent)
            # and pipelined prefetch to eliminate RTT idle waiting
            next_task = None

            async def _fetch(offset: int, length: int) -> bytes | None:
                c = await ws_manager.request_file_chunk(dev_token, clean_path, offset, length)
                if not c and device_id != dev_token:
                    c = await ws_manager.request_file_chunk(device_id, clean_path, offset, length)
                if not c and target_machine and target_machine.name:
                    c = await ws_manager.request_file_chunk(target_machine.name, clean_path, offset, length)
                return c

            while curr <= end:
                # 512 KB first chunk so browser decodes header/metadata in under 50ms, then 2 MB high throughput
                current_chunk_size = (512 * 1024) if curr == start else (2 * 1024 * 1024)
                read_len = min(current_chunk_size, end - curr + 1)

                if next_task is not None:
                    chunk = await next_task
                    next_task = None
                else:
                    chunk = await _fetch(curr, read_len)

                if not chunk:
                    break

                curr += len(chunk)

                # Pipeline next chunk request concurrently while streaming current chunk to client
                if curr <= end:
                    next_chunk_size = 2 * 1024 * 1024
                    next_read_len = min(next_chunk_size, end - curr + 1)
                    next_task = asyncio.create_task(_fetch(curr, next_read_len))

                yield chunk

    return StreamingResponse(chunk_generator(), status_code=status_code, headers=headers)

