"""Where a project lives: which devices, and the folder on each.

One project row is shared by every machine that worked in a folder of the same
name (a single ``antigravity/memento`` for the Mac mini, the MacBook and the
Windows box), so ``Project.source_path`` is right for one of them at most. The
ask composer needs the folder on the device the user picked, and in auto mode
the device a project lives on; both come from the documents each machine
synced and from each machine's discovery report.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from ..db.models import Document, Machine, User
from .ingest_service import _clean_source_path, _is_invalid_project_name, _prettify_project_name, is_junk_project

_EPOCH = datetime.min.replace(tzinfo=timezone.utc)

@dataclass(frozen=True)
class Placement:
    """Documents of one project synced by one machine from one folder."""

    machine_id: uuid.UUID | None
    path: str | None
    documents: int
    last_active: datetime | None


@dataclass(frozen=True)
class DeviceRef:
    device_id: str
    name: str


def _ts(value: datetime | None) -> datetime:
    if value is None:
        return _EPOCH
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _leaf(name: str) -> str:
    return name.replace("\\", "/").rstrip("/").split("/")[-1].strip("-\"'` ").lower()


def pick_project_path(placements: Iterable[Placement], slug: str, title: str | None) -> str | None:
    """The folder the project lives in among these placements, or None.

    Only folders named after the project count, so a session started in
    ``memento/web`` does not move the project. An exact name beats a partial
    one, then the most recently active folder wins (the project may have moved).
    """
    p_leaf = _leaf(slug)
    p_title = (title or "").strip("-\"'` ").lower()
    best_key: tuple[int, datetime, int] | None = None
    best_path: str | None = None
    for pl in placements:
        raw = (pl.path or "").strip()
        if len(raw) <= 3 or raw.isdigit():
            continue
        path = _clean_source_path(raw)
        if not path or is_junk_project(None, path):
            continue
        leaf = _leaf(path)
        if leaf in (p_leaf, p_title):
            rank = 2
        elif p_leaf and p_leaf in leaf:
            rank = 1
        else:
            continue
        key = (rank, _ts(pl.last_active), pl.documents)
        if best_key is None or key > best_key:
            best_key, best_path = key, path
    return best_path


async def device_index(db: AsyncSession, user: User) -> dict[uuid.UUID, DeviceRef]:
    """Map every machine record, merged ones included, to the device the device list shows for it."""
    q = select(Machine)
    if user.role not in ("admin", "owner"):
        q = q.where(Machine.user_id == user.id)
    machines = list((await db.execute(q)).scalars().all())
    by_id = {m.id: m for m in machines}

    def live(m: Machine) -> Machine:
        seen: set[uuid.UUID] = set()
        while m.merged_into is not None and m.merged_into in by_id and m.id not in seen:
            seen.add(m.id)
            m = by_id[m.merged_into]
        return m

    # Like GET /api/devices: one entry per name, the live record with the latest heartbeat.
    shown: dict[str, Machine] = {}
    for m in sorted((m for m in machines if m.merged_into is None), key=lambda m: _ts(m.last_heartbeat), reverse=True):
        shown.setdefault(m.name, m)
    index: dict[uuid.UUID, DeviceRef] = {}
    for m in machines:
        root = live(m)
        target = shown.get(root.name, root)
        if target.collector_token_hash:
            index[m.id] = DeviceRef(target.collector_token_hash, target.name)
    return index


async def project_placements(
    db: AsyncSession, project_ids: Iterable[uuid.UUID], scope=None,
) -> dict[uuid.UUID, list[Placement]]:
    """Documents per project, machine and folder (``scope``: an extra WHERE on Document)."""
    ids = list(project_ids)
    if not ids:
        return {}
    path_col = Document.metadata_["project_path"].astext
    q = (
        select(Document.project_id, Document.machine_id, path_col, func.count(Document.id), func.max(Document.synced_at))
        .where(Document.project_id.in_(ids))
        .group_by(Document.project_id, Document.machine_id, path_col)
    )
    if scope is not None:
        q = q.where(scope)
    out: dict[uuid.UUID, list[Placement]] = {}
    for pid, mid, path, n, last in (await db.execute(q)).all():
        out.setdefault(pid, []).append(Placement(mid, path, int(n or 0), last))
    return out


@dataclass(frozen=True)
class DiscoveredProject:
    machine_id: uuid.UUID | None
    tool_id: str
    name: str
    path: str | None


async def discovered_projects(
    db: AsyncSession, machine: Machine | None, machine_ids: list[uuid.UUID] | None, tool_id: str | None,
) -> list[DiscoveredProject]:
    """Projects each machine reported in its latest discovery document."""
    q = (
        select(Document)
        .options(defer(Document.content_tsv), defer(Document.rendered_html), defer(Document.metadata_))
        .where(Document.tool_id == "system", Document.category == "discovery")
        .order_by(Document.synced_at.desc())
    )
    docs: list[Document] = []
    if machine is not None:
        doc = (await db.execute(q.where(Document.machine_id == machine.id).limit(1))).scalar_one_or_none()
        if doc is None and machine.collector_token_hash:
            doc = (await db.execute(
                q.where(Document.relative_path == f"discovery/{machine.collector_token_hash}.json").limit(1)
            )).scalar_one_or_none()
        if doc is not None:
            docs.append(doc)
    else:
        if machine_ids is not None:
            q = q.where(Document.machine_id.in_(machine_ids))
        seen: set[str] = set()
        for doc in (await db.execute(q)).scalars().all():
            key = str(doc.machine_id or doc.relative_path)
            if key not in seen:
                seen.add(key)
                docs.append(doc)

    found: list[DiscoveredProject] = []
    for doc in docs:
        try:
            tools_map = json.loads(doc.content or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(tools_map, dict):
            continue
        machine_id = machine.id if machine is not None else doc.machine_id
        for t in ([tool_id] if tool_id else list(tools_map.keys())):
            info = tools_map.get(t)
            if not isinstance(info, dict):
                continue
            for entry in info.get("projects", []):
                if not isinstance(entry, dict):
                    continue
                path = entry.get("path")
                raw_name = entry.get("name") or (path or "").replace("\\", "/").rstrip("/").split("/")[-1]
                if not raw_name:
                    continue
                name = _prettify_project_name(raw_name).strip("-\"'` ")
                if not name or _is_invalid_project_name(name):
                    continue
                found.append(DiscoveredProject(machine_id, t, name, path))
    return found


def project_devices(
    slug: str,
    title: str | None,
    placements: Iterable[Placement],
    discovered: Iterable[DiscoveredProject],
    index: dict[uuid.UUID, DeviceRef],
) -> list[dict]:
    """Devices a project lives on, most recently active first, each with its own folder."""
    groups: dict[str, list[Placement]] = {}
    refs: dict[str, DeviceRef] = {}
    for pl in placements:
        ref = index.get(pl.machine_id) if pl.machine_id else None
        if ref is None:
            continue
        refs[ref.device_id] = ref
        groups.setdefault(ref.device_id, []).append(pl)

    devices: dict[str, dict] = {}
    last_seen: dict[str, datetime] = {}
    for device_id, pls in groups.items():
        last = max((_ts(p.last_active) for p in pls), default=_EPOCH)
        last_seen[device_id] = last
        devices[device_id] = {
            "device_id": device_id,
            "name": refs[device_id].name,
            "source_path": pick_project_path(pls, slug, title) or "",
            "document_count": sum(p.documents for p in pls),
            "last_active": last.isoformat() if last > _EPOCH else None,
        }
    for d in discovered:
        ref = index.get(d.machine_id) if d.machine_id else None
        if ref is None:
            continue
        path = _clean_source_path(d.path) or ""
        if path and is_junk_project(None, path):
            path = ""
        entry = devices.get(ref.device_id)
        if entry is None:
            last_seen[ref.device_id] = _EPOCH
            devices[ref.device_id] = {
                "device_id": ref.device_id,
                "name": ref.name,
                "source_path": path,
                "document_count": 0,
                "last_active": None,
            }
        elif not entry["source_path"] and path:
            entry["source_path"] = path
    return sorted(
        devices.values(),
        key=lambda d: (last_seen[d["device_id"]], d["document_count"]),
        reverse=True,
    )


def discovered_for(slug: str, discovered: Iterable[DiscoveredProject]) -> list[DiscoveredProject]:
    """The discovery entries naming this project (same tool, same prettified name)."""
    return [d for d in discovered if f"{d.tool_id}/{d.name}" == slug]
