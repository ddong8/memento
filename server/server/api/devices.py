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
from pydantic import BaseModel
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
    include_archived: bool = Query(False, description="Whether to include unlinked/archived devices"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """List all registered collector devices with their stats."""
    inc_arch = include_archived if isinstance(include_archived, bool) else getattr(include_archived, "default", False)
    machines_q = select(Machine).where(Machine.merged_into.is_(None)).order_by(Machine.last_heartbeat.desc().nulls_last())
    if not inc_arch:
        machines_q = machines_q.where(Machine.is_archived.is_(False))
    if _user.role not in ("admin", "owner"):
        machines_q = machines_q.where(Machine.user_id == _user.id)
    machines = list((await db.execute(machines_q)).scalars().all())
    if not machines:
        return []

    machine_ids = [m.id for m in machines]

    # One GROUP BY replaces the per-machine COUNT + DISTINCT round-trips (cached for 60s).
    stats_cache_key = f"devices:stats:{_user.id}:{inc_arch}"
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
        is_arch = bool(getattr(m, "is_archived", False))

        items.append({
            "id": str(m.id),
            "name": m.name,
            "device_id": m.collector_token_hash,
            "collector_version": m.collector_version,
            "last_heartbeat": hb.isoformat() if hb else None,
            "online": is_online and not is_arch,
            "created_at": m.created_at.isoformat(),
            "document_count": totals_by_name.get(m.name, 0),
            "tools": tools_by_name.get(m.name, []),
            "is_archived": is_arch,
            "archived_at": m.archived_at.isoformat() if getattr(m, "archived_at", None) else None,
            "direct_endpoints": (m.profile_status or {}).get("direct_endpoints", []),
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
    keep_data: bool = Query(False, description="If True, archive/unbind device and keep all documents/data"),
) -> dict:
    """Delete or unbind a device.
    If keep_data=True, marks the device as archived so it disappears from the active device list,
    but retains all its documents, embeddings, knowledge observations, and user data intact.
    If keep_data=False, permanently purges all documents and the machine record.
    """
    machine = await _verify_device_ownership(db, device_db_id, _user)

    should_keep = keep_data if isinstance(keep_data, bool) else getattr(keep_data, "default", False)
    if should_keep:
        machine.is_archived = True
        machine.archived_at = datetime.now(timezone.utc)
        await db.commit()

        await cache_delete_prefix(f"devices:stats:{_user.id}")
        await cache_delete_prefix(f"hierarchy:devices:{_user.id}")
        await cache_delete_prefix(f"dashboard:{_user.id}")
        await cache_delete_prefix(f"tools:list:{_user.id}")
        await cache_delete_prefix(f"projects:list:{_user.id}")

        return {
            "status": "archived",
            "device_id": str(device_db_id),
            "name": machine.name,
            "keep_data": True,
            "documents_deleted": 0,
            "orphaned_entities_deleted": 0,
            "orphaned_projects_deleted": 0,
        }

    stats = await _purge_device_data(db, device_db_id, include_system=True)
    await db.execute(delete(Machine).where(Machine.id == device_db_id))

    await cache_delete_prefix(f"devices:stats:{_user.id}")
    await cache_delete_prefix(f"hierarchy:devices:{_user.id}")
    await cache_delete_prefix(f"dashboard:{_user.id}")
    await cache_delete_prefix(f"tools:list:{_user.id}")
    await cache_delete_prefix(f"projects:list:{_user.id}")

    return {"status": "deleted", "device_id": str(device_db_id), "name": machine.name, "keep_data": False, **stats}


@router.post("/{device_db_id}/archive")
async def archive_device(
    device_db_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Unbind/archive a device while keeping all its documents and data."""
    machine = await _verify_device_ownership(db, device_db_id, _user)
    machine.is_archived = True
    machine.archived_at = datetime.now(timezone.utc)
    await db.commit()

    await cache_delete_prefix(f"devices:stats:{_user.id}")
    await cache_delete_prefix(f"hierarchy:devices:{_user.id}")
    await cache_delete_prefix(f"dashboard:{_user.id}")
    await cache_delete_prefix(f"tools:list:{_user.id}")
    await cache_delete_prefix(f"projects:list:{_user.id}")

    return {"status": "archived", "device_id": str(device_db_id), "name": machine.name, "keep_data": True}


@router.post("/{device_db_id}/unarchive")
async def unarchive_device(
    device_db_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Restore an archived device back to the active device list."""
    machine = await _verify_device_ownership(db, device_db_id, _user)
    machine.is_archived = False
    machine.archived_at = None
    await db.commit()

    await cache_delete_prefix(f"devices:stats:{_user.id}")
    await cache_delete_prefix(f"hierarchy:devices:{_user.id}")
    await cache_delete_prefix(f"dashboard:{_user.id}")
    await cache_delete_prefix(f"tools:list:{_user.id}")
    await cache_delete_prefix(f"projects:list:{_user.id}")

    return {"status": "unarchived", "device_id": str(device_db_id), "name": machine.name}


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
    from ..services.device_service import touch_heartbeat
    result = await db.execute(
        select(Machine).where(Machine.collector_token_hash == x_device_id)
    )
    machine = result.scalar_one_or_none()
    if machine:
        touch_heartbeat(machine, datetime.now(timezone.utc))
        if x_collector_version and machine.collector_version != x_collector_version:
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
_initial_chunk_cache: dict[str, tuple[bytes, float]] = {}  # cache_key -> (initial_bytes, timestamp)
_negative_stat_cache: dict[str, float] = {}  # f"{dev_token}:{clean_path}" -> timestamp
_file_stat_cache: dict[str, tuple[int, str, float]] = {}  # clean_path -> (total_size, real_dev_token, timestamp)
_FILE_STAT_CACHE_TTL = 600.0  # 10 minutes cache for file stat and owner device
_MAX_INITIAL_CHUNKS = 50  # Max 50 chunks (approx 25 MB max in memory)
_INITIAL_CHUNK_TTL_SECONDS = 300  # 5 minutes TTL
_MAX_DISK_CACHE_BYTES = int(os.environ.get("MEMENTO_MEDIA_CACHE_MAX_BYTES", 5 * 1024 * 1024 * 1024))  # 5 GB default quota
# The cache sits on an emptyDir with a hard sizeLimit (deploy/k8s/api.yaml): going past it
# makes the kubelet evict the whole api pod. So room is reserved before a download starts,
# in-flight downloads count at their full size, and big files are streamed without caching.
_MAX_CACHED_FILE_BYTES = _MAX_DISK_CACHE_BYTES // 4
_MAX_CONCURRENT_PREFETCH = 2
_prefetch_reserved: dict[str, int] = {}  # cache_key -> bytes reserved for an in-flight download


async def _get_cached_stat(path: str) -> tuple[int, str] | None:
    """Retrieve positive file existence & size metadata from memory or cluster Redis."""
    now = time.time()
    if path in _file_stat_cache:
        size, token, ts = _file_stat_cache[path]
        if now - ts < _FILE_STAT_CACHE_TTL:
            return size, token
    r = cluster.redis
    if r is not None:
        try:
            val = await r.get(f"{PREFIX}fstat:{hashlib.sha256(path.encode()).hexdigest()}")
            if val:
                d = json.loads(val)
                size = int(d.get("size") or 0)
                token = str(d.get("token") or "")
                if size > 0 and token:
                    _file_stat_cache[path] = (size, token, now)
                    return size, token
        except Exception:
            pass
    return None


async def _set_cached_stat(path: str, size: int, token: str) -> None:
    """Cache positive file existence & size metadata across all API replicas."""
    now = time.time()
    _file_stat_cache[path] = (size, token, now)
    if len(_file_stat_cache) > 2000:
        for k in [k for k, (_, _, ts) in list(_file_stat_cache.items()) if now - ts > _FILE_STAT_CACHE_TTL]:
            _file_stat_cache.pop(k, None)
    r = cluster.redis
    if r is not None and size > 0 and token:
        try:
            await r.set(
                f"{PREFIX}fstat:{hashlib.sha256(path.encode()).hexdigest()}",
                json.dumps({"size": size, "token": token}),
                ex=int(_FILE_STAT_CACHE_TTL),
            )
        except Exception:
            pass


def _set_initial_chunk(key: str, data: bytes) -> None:
    """Store initial media chunk with LRU eviction and memory bounds."""
    now = time.time()
    # Purge expired entries
    expired = [k for k, (_, ts) in _initial_chunk_cache.items() if now - ts > _INITIAL_CHUNK_TTL_SECONDS]
    for k in expired:
        _initial_chunk_cache.pop(k, None)
    # Evict oldest entry if size limit reached
    if len(_initial_chunk_cache) >= _MAX_INITIAL_CHUNKS:
        oldest_k = min(_initial_chunk_cache.keys(), key=lambda k: _initial_chunk_cache[k][1])
        _initial_chunk_cache.pop(oldest_k, None)
    _initial_chunk_cache[key] = (data, now)


def _get_initial_chunk(key: str) -> bytes | None:
    """Retrieve cached initial media chunk if not expired."""
    entry = _initial_chunk_cache.get(key)
    if not entry:
        return None
    data, ts = entry
    if time.time() - ts > _INITIAL_CHUNK_TTL_SECONDS:
        _initial_chunk_cache.pop(key, None)
        return None
    return data


def _make_room_for(cache_dir: str, size: int, max_bytes: int | None = None) -> bool:
    """Make room for a `size`-byte download within the cache quota, deleting the oldest
    cached files (and leftover partial downloads) if needed. False when the file is too
    big to cache, enough downloads are already running, or there's no room even then."""
    max_bytes = _MAX_DISK_CACHE_BYTES if max_bytes is None else max_bytes
    if size > max_bytes // 4 or len(_prefetch_reserved) >= _MAX_CONCURRENT_PREFETCH:
        return False
    budget = max_bytes - sum(_prefetch_reserved.values()) - size
    if budget < 0:
        return False
    in_flight = set(_prefetch_reserved)
    files: list[tuple[str, int, float]] = []
    used = 0
    try:
        for entry in os.scandir(cache_dir):
            if not entry.is_file() or entry.name.startswith(".test_"):
                continue
            if entry.name.endswith(".part") and entry.name.split(".", 1)[0] in in_flight:
                continue  # already counted at full size through its reservation
            try:
                st = entry.stat()
            except OSError:
                continue
            files.append((entry.path, st.st_size, st.st_mtime))
            used += st.st_size
    except OSError as e:
        logger.warning("Cannot inspect media cache %s: %s", cache_dir, e)
        return False
    if used <= budget:
        return True
    files.sort(key=lambda f: f[2])  # oldest first
    for path, fsize, _ in files:
        try:
            os.remove(path)
        except OSError:
            continue
        used -= fsize
        for k, v in list(_known_cache_map.items()):
            if v[1] == path:
                _known_cache_map.pop(k, None)
        if used <= budget:
            break
    logger.info("Media cache %s trimmed to %d bytes to fit a %d-byte download", cache_dir, used, size)
    return used <= budget


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
        # Delay background prefetch by 3.5s to let the user's initial video Range stream start smoothly without contention
        await asyncio.sleep(3.5)
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
        _prefetch_reserved.pop(cache_key, None)


async def _stat_on_devices(
    db: AsyncSession, _user: User, mids, device_id: str, target_machine, dev_token: str, clean_path: str,
) -> tuple[dict, str]:
    """Stat a file on the device it names, by its other aliases, or (for "auto" / unknown devices) on
    whichever of the user's online devices has it. Returns the stat and the device token that answered."""
    stat = await ws_manager.request_file_stat(dev_token, clean_path)
    err_msg = str(stat.get("error") or "").lower()
    if not stat.get("exists") and ("not found" in err_msg or "enoent" in err_msg):
        return stat, dev_token
    if not stat.get("exists") and device_id != dev_token:
        stat = await ws_manager.request_file_stat(device_id, clean_path)
    if not stat.get("exists") and target_machine and target_machine.name:
        stat = await ws_manager.request_file_stat(target_machine.name, clean_path)
    if not stat.get("exists") and (device_id == "auto" or not target_machine):
        query = select(Machine)
        if _user.role not in ("admin", "owner") and mids is not None:
            query = query.where(Machine.id.in_(mids))
        candidates: list[str] = []
        for m in (await db.execute(query)).scalars().all():
            for alias in (m.collector_token_hash, m.name):
                if alias and alias not in candidates:
                    candidates.append(alias)
        if _user.role in ("admin", "owner"):
            candidates += [c for c in ws_manager.connected_ids() if c not in candidates]
        for cand_token in candidates:
            if ws_manager.has_device(cand_token) and cand_token != dev_token:
                cand_stat = await ws_manager.request_file_stat(cand_token, clean_path, timeout=5.0)
                if cand_stat.get("exists"):
                    return cand_stat, cand_token
    return stat, dev_token


def _clean_device_path(path: str) -> str:
    """The absolute path the client meant: unquoted (also when double-encoded), forward slashes, no file://."""
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
    if any(p == ".." for p in clean_path.split("/")):
        raise HTTPException(status_code=400, detail="Path traversal forbidden")
    return clean_path


async def _authorized_machine(db: AsyncSession, device_id: str, _user: User):
    from ..services.user_filter import find_machine_by_id_or_hash
    target_machine = await find_machine_by_id_or_hash(db, device_id, _user)
    mids = await user_machine_ids(db, _user)
    if _user.role not in ("admin", "owner") and target_machine and mids is not None and target_machine.id not in mids:
        raise HTTPException(status_code=403, detail="Device access denied")
    return target_machine, mids


def _ice_servers() -> list[str]:
    from ..config import settings
    return [u.strip() for u in settings.stun_urls.split(",") if u.strip()]


@router.get("/{device_id}/files/locate")
async def locate_device_file(
    device_id: str,
    path: str = Query(..., description="Absolute path on the device"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Which of the user's devices holds a file, so the page can fetch it from that device directly over
    WebRTC instead of through the server: {"device", "size", "ice_servers"}, or {"local": true} when the
    server has it itself (on its disk or in its media cache)."""
    target_machine, mids = await _authorized_machine(db, device_id, _user)
    clean_path = _clean_device_path(path)
    if (os.path.isfile(clean_path) and os.path.exists(clean_path)) or clean_path in _known_cache_map:
        return {"local": True}
    cached = await _get_cached_stat(clean_path)
    if cached and cached[0] > 0 and (device_id == "auto" or not target_machine):
        return {"device": cached[1], "size": cached[0], "ice_servers": _ice_servers()}
    dev_token = target_machine.collector_token_hash if target_machine else device_id
    stat, dev_token = await _stat_on_devices(db, _user, mids, device_id, target_machine, dev_token, clean_path)
    if not stat.get("exists"):
        raise HTTPException(status_code=404, detail=f"File not found on any online device: {stat.get('error') or 'offline'}")
    size = int(stat.get("size") or stat.get("total_size") or 0)
    if size > 0:
        await _set_cached_stat(clean_path, size, dev_token)
    return {"device": dev_token, "size": size, "ice_servers": _ice_servers()}


class P2POffer(BaseModel):
    sdp: str


@router.post("/{device_id}/p2p/offer")
async def p2p_offer(
    device_id: str,
    body: P2POffer,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Relays the page's WebRTC offer to its device and returns the device's answer: only this exchange
    (a few KB) goes through the server; the file data then flows between the two directly."""
    target_machine, _ = await _authorized_machine(db, device_id, _user)
    if not target_machine and _user.role not in ("admin", "owner"):
        raise HTTPException(status_code=404, detail="Unknown device")
    token = target_machine.collector_token_hash if target_machine and target_machine.collector_token_hash else device_id
    if not ws_manager.has_device(token):
        raise HTTPException(status_code=409, detail="Device is offline")
    res = await ws_manager.request_p2p_answer(token, body.sdp, _ice_servers())
    if res.get("error") or not res.get("sdp"):
        raise HTTPException(status_code=502, detail=str(res.get("error") or "no answer from device"))
    return {"sdp": res["sdp"]}


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
        # Fast path 1: Check positive stat cache across all replicas (avoids WebSocket RTT & timeouts on follow-up Ranges)
        cached_stat = await _get_cached_stat(raw_clean_path)
        if cached_stat:
            cached_size, cached_dev_token = cached_stat
            if cached_size > 0:
                total_size = cached_size
                if device_id == "auto" or not target_machine:
                    dev_token = cached_dev_token

        # Fast path 2: Check 404 negative cache if not already found
        if total_size <= 0:
            neg_key = f"{dev_token}:{raw_clean_path}"
            if neg_key in _negative_stat_cache and (time.time() - _negative_stat_cache[neg_key] < 60.0):
                raise HTTPException(status_code=404, detail=f"File not found on device (cached 404): {raw_clean_path}")

            stat, dev_token = await _stat_on_devices(db, _user, mids, device_id, target_machine, dev_token, clean_path)
            err_msg = str(stat.get("error") or "")
            if not stat.get("exists") and ("not found" in err_msg.lower() or "enoent" in err_msg.lower()):
                # The device affirmatively returned ENOENT: cache the 404 so follow-up Ranges fail fast
                _negative_stat_cache[neg_key] = time.time()
                if len(_negative_stat_cache) > 2000:
                    now = time.time()
                    for k in [k for k, ts in list(_negative_stat_cache.items()) if now - ts > 60.0]:
                        _negative_stat_cache.pop(k, None)

            if not stat.get("exists"):
                err_msg = stat.get("error") or "offline"
                if err_msg == "offline":
                    raise HTTPException(status_code=404, detail=f"Target device is offline or disconnected from WebSocket: {device_id}")
                raise HTTPException(status_code=404, detail=f"File not found on device ({clean_path}): {err_msg}")
            total_size = stat.get("size") or stat.get("total_size") or 0
            if total_size > 0 and dev_token:
                await _set_cached_stat(raw_clean_path, total_size, dev_token)

        # Check if complete local cache exists for this clean_path and total_size
        if total_size > 0:
            cache_key = hashlib.sha256(f"{raw_clean_path}:{total_size}".encode()).hexdigest()
            cached_file_path = os.path.join(cache_dir, f"{cache_key}{ext}")
            if os.path.exists(cached_file_path) and os.path.getsize(cached_file_path) == total_size:
                clean_path = cached_file_path
                is_local = True
                _known_cache_map[raw_clean_path] = (total_size, cached_file_path)

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

    # Trigger background full prefetch for non-local media unless this is an iOS 0-1 probe
    if not is_local and total_size > 0 and total_size <= 250 * 1024 * 1024:
        cache_key = hashlib.sha256(f"{raw_clean_path}:{total_size}".encode()).hexdigest()
        cached_file_path = os.path.join(cache_dir, f"{cache_key}{ext}")
        is_probe = (start == 0 and end <= 1)
        if not is_probe and cache_key not in _active_prefetch_tasks and _make_room_for(cache_dir, total_size):
            _prefetch_reserved[cache_key] = total_size
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
                    try:
                        yield data
                    except (asyncio.CancelledError, Exception):
                        break
        else:
            # Remote streaming with 512KB chunks for smooth playback and zero channel starvation
            chunk_size = 512 * 1024
            next_task = None

            async def _fetch(offset: int, length: int) -> bytes | None:
                c = await ws_manager.request_file_chunk(dev_token, clean_path, offset, length)
                if not c and device_id != dev_token:
                    c = await ws_manager.request_file_chunk(device_id, clean_path, offset, length)
                if not c and target_machine and target_machine.name:
                    c = await ws_manager.request_file_chunk(target_machine.name, clean_path, offset, length)
                return c

            # iOS AVPlayer probe fast-path (Range: bytes=0-1):
            if curr == 0 and end <= 1:
                probe_chunk = await _fetch(0, min(chunk_size, total_size))
                if probe_chunk:
                    _set_initial_chunk(cache_key, probe_chunk)
                    try:
                        yield probe_chunk[:end + 1]
                    except (asyncio.CancelledError, Exception):
                        pass
                    return

            # Check in-memory initial chunk cache for instant first-frame playback
            init_chunk = _get_initial_chunk(cache_key)
            if init_chunk and curr == 0:
                avail = min(len(init_chunk), end - curr + 1)
                if avail > 0:
                    try:
                        yield init_chunk[:avail]
                    except (asyncio.CancelledError, Exception):
                        return
                    curr += avail
                    if curr > end:
                        return
                    next_read_len = min(chunk_size, end - curr + 1)
                    next_task = asyncio.create_task(_fetch(curr, next_read_len))

            while curr <= end:
                read_len = min(chunk_size, end - curr + 1)

                if next_task is not None:
                    try:
                        chunk = await next_task
                    except (asyncio.CancelledError, Exception):
                        chunk = None
                    next_task = None
                else:
                    try:
                        chunk = await _fetch(curr, read_len)
                    except (asyncio.CancelledError, Exception):
                        chunk = None

                if not chunk:
                    break

                curr += len(chunk)

                # Pipeline next chunk request concurrently while streaming current chunk to client
                if curr <= end:
                    next_read_len = min(chunk_size, end - curr + 1)
                    next_task = asyncio.create_task(_fetch(curr, next_read_len))

                try:
                    yield chunk
                except (asyncio.CancelledError, Exception):
                    if next_task and not next_task.done():
                        next_task.cancel()
                    break

    # A video can stream for many minutes: end this request's read transaction first rather than
    # leave it open until the database cuts the connection (idle_in_transaction_session_timeout, 60 s).
    await db.commit()
    return StreamingResponse(chunk_generator(), status_code=status_code, headers=headers)

