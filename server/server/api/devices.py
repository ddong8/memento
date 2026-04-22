"""Devices API — view and manage registered collector devices."""

from __future__ import annotations

import json
import time
import uuid
from collections import defaultdict

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AccessLog, ConversationMessage, Document, DocumentVersion, Machine, Project, SyncState, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.user_filter import user_machine_ids

router = APIRouter(prefix="/api/devices", tags=["devices"])

# In-memory command queue per device_id (collector_token_hash)
# Format: {device_id: [{id, action, created_at}, ...]}
_command_queue: dict[str, list[dict]] = defaultdict(list)
_cmd_counter = 0


def _enqueue_command(device_collector_id: str, action: str) -> int:
    """Add a command to the queue for a device."""
    global _cmd_counter
    _cmd_counter += 1
    _command_queue[device_collector_id].append({
        "id": _cmd_counter,
        "action": action,
        "created_at": time.time(),
    })
    return _cmd_counter


@router.get("")
async def list_devices(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """List all registered collector devices with their stats."""
    machines_q = select(Machine).order_by(Machine.name)
    if _user.role not in ("admin", "owner"):
        machines_q = machines_q.where(Machine.user_id == _user.id)
    result = await db.execute(machines_q)
    machines = result.scalars().all()

    items = []
    for m in machines:
        doc_count = await db.execute(
            select(func.count()).where(Document.machine_id == m.id, Document.tool_id != "system")
        )
        count = doc_count.scalar() or 0

        tools_result = await db.execute(
            select(Document.tool_id).where(Document.machine_id == m.id, Document.tool_id != "system").distinct()
        )
        tool_ids = [r[0] for r in tools_result.all()]

        items.append({
            "id": str(m.id),
            "name": m.name,
            "device_id": m.collector_token_hash,
            "collector_version": m.collector_version,
            "last_heartbeat": m.last_heartbeat.isoformat() if m.last_heartbeat else None,
            "created_at": m.created_at.isoformat(),
            "document_count": count,
            "tools": tool_ids,
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

    cmd_id = _enqueue_command(machine.collector_token_hash, action)
    return {"status": "queued", "command_id": cmd_id, "action": action, "device": machine.name}


@router.post("/command-by-collector-id")
async def send_command_by_collector_id(
    collector_id: str,
    action: str = "resync",
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Send a command using the collector's device_id (survives purge)."""
    # Authorize: non-admin can only command devices they own. Without this,
    # a logged-in user could guess/obtain another user's collector token hash
    # and force resync/purge on their device.
    result = await db.execute(
        select(Machine).where(Machine.collector_token_hash == collector_id)
    )
    machine = result.scalar_one_or_none()
    if _user.role not in ("admin", "owner"):
        if not machine or machine.user_id != _user.id:
            raise HTTPException(status_code=404, detail="Device not found")
    cmd_id = _enqueue_command(collector_id, action)
    return {"status": "queued", "command_id": cmd_id, "action": action}


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

    commands = _command_queue.get(x_device_id, [])
    return commands


@router.post("/commands/{cmd_id}/ack")
async def ack_command(
    cmd_id: int,
    x_device_id: str = Header(..., alias="X-Device-Id"),
) -> dict:
    """Collector acknowledges a command — remove it from queue."""
    queue = _command_queue.get(x_device_id, [])
    _command_queue[x_device_id] = [c for c in queue if c["id"] != cmd_id]
    return {"status": "acked", "command_id": cmd_id}
