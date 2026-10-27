"""Account-level data export — builds a portable ZIP of the caller's own data.

The package is meant to be **round-trippable via import_service** but also
forward-compatible: format_version is a major.minor pair and the importer
is required to ignore unknown JSONL files / unknown columns.

Why not stream the ZIP directly into the response body?
  Python stdlib `zipfile.ZipFile` needs a seekable sink for its central
  directory. A truly streaming alternative (`stream-zip`, `zipstream-ng`)
  is a new dependency we don't want for v1. So: write to a private temp
  file under `tempfile.gettempdir()`, return its path, and let the caller
  (api/data_io.py) wrap it in a `FileResponse` with a `BackgroundTask` to
  unlink. Disk overhead is "size of one export" — bounded by the same
  internal cap we enforce inline (1 GiB uncompressed by default).

Security posture:
  * `caller.user_id` is the **only** source of truth for ownership — we
    deliberately bypass `user_machine_ids()` because that helper returns
    `None` for admin/owner ("see everything"), which would let any admin
    drag the whole instance into a ZIP.
  * Every row is **whitelist-serialized** (no dump-then-filter). The
    fields included are the minimum needed for round-trip + UI;
    `rendered_html`, `metadata_`, `visibility`, secrets and PII outside
    the user's own scope are stripped.
  * Cross-user references (e.g. `knowledge_observations.source_document_id`
    pointing at another user's doc, `daily_summaries.source_document_ids`
    array) are filtered to the caller's export set or NULLed.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import tempfile
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    AccessLog, ConversationMessage, DailySummary, Document, DocumentVersion,
    KnowledgeEntity, KnowledgeObservation, KnowledgeRelation, Machine,
    Project, ShareLink, User,
)
from .content_staging import cap_content, pending_tails

logger = logging.getLogger("memento.export")

# Sync stdlib zip work needs to be off the event loop for big exports.
# 1 GiB uncompressed ceiling — symmetric with the import-side enforcement,
# so a backup that imports must also export. Override via env if you self-
# host with very large datasets.
MAX_EXPORT_UNCOMPRESSED_BYTES = int(
    os.environ.get("MEMENTO_EXPORT_MAX_BYTES", str(1024 * 1024 * 1024))
)

# Wire-level format version. Major bumps are breaking; minor bumps add
# fields. Importer must accept any same-major version and ignore unknown
# keys / unknown JSONL files.
FORMAT_VERSION = "1.0"


@dataclass
class ExportOptions:
    include_access_logs: bool = False


@dataclass
class ExportResult:
    path: str
    filename: str
    size_bytes: int
    counts: dict[str, int] = field(default_factory=dict)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt is not None else None


def _anonymize_ip(raw: str | None) -> str | None:
    """Coarsen an IP for export — keep utility, drop PII precision.

    /24 for IPv4, /48 for IPv6 — matches the convention used in
    GeoLite-based redaction. If parsing fails (placeholder, IPv6 mapped,
    weird proxy headers), return the prefix or just the literal string —
    never raise.
    """
    if not raw:
        return raw
    try:
        addr = ipaddress.ip_address(raw)
        if isinstance(addr, ipaddress.IPv4Address):
            net = ipaddress.ip_network(f"{addr}/24", strict=False)
        else:
            net = ipaddress.ip_network(f"{addr}/48", strict=False)
        return str(net.network_address)
    except ValueError:
        # Already a prefix / hostname / placeholder — leave alone.
        return raw


async def _user_machine_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Caller's machines ONLY — never the helper that returns None for
    admin/owner. An admin exporting their own data must still get only
    their own rows."""
    rows = await db.execute(select(Machine.id).where(Machine.user_id == user_id))
    return [r[0] for r in rows.all()]


async def build_export(
    db: AsyncSession,
    user: User,
    options: ExportOptions | None = None,
) -> ExportResult:
    """Build a ZIP for the given user and return a path to the temp file
    plus a counts manifest. Caller is responsible for serving + deleting."""
    opts = options or ExportOptions()
    machine_ids = await _user_machine_ids(db, user.id)

    # Bookkeeping for ID-cross-reference filtering on observations /
    # daily_summaries.source_document_ids.
    doc_ids: set[uuid.UUID] = set()
    counts: dict[str, int] = {}
    running_bytes = 0

    fd, tmp_path = tempfile.mkstemp(prefix="memento-export-", suffix=".zip")
    os.close(fd)

    def _check_budget(extra: int) -> None:
        nonlocal running_bytes
        running_bytes += extra
        if running_bytes > MAX_EXPORT_UNCOMPRESSED_BYTES:
            raise ValueError(
                f"export exceeds {MAX_EXPORT_UNCOMPRESSED_BYTES // (1024*1024)}MB "
                "uncompressed budget — try export with smaller scope"
            )

    def _write_jsonl(zf: zipfile.ZipFile, name: str, rows: list[dict[str, Any]]) -> None:
        # ZIP_DEFLATED is well worth it for JSONL (text compresses ~10x).
        info = zipfile.ZipInfo(name, date_time=(2025, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        buf = "\n".join(json.dumps(r, ensure_ascii=False, default=str) for r in rows)
        if buf:
            buf += "\n"
        data = buf.encode("utf-8")
        _check_budget(len(data))
        zf.writestr(info, data)
        counts[name.split(".")[0]] = len(rows)

    try:
        with zipfile.ZipFile(tmp_path, "w", allowZip64=True) as zf:
            # 1) Machines — strip token hash, version + heartbeat only.
            mach_rows = (await db.execute(
                select(Machine).where(Machine.user_id == user.id)
            )).scalars().all()
            _write_jsonl(zf, "machines.jsonl", [
                {
                    "id": str(m.id),
                    "name": m.name,
                    "collector_version": m.collector_version,
                    "last_heartbeat": _iso(m.last_heartbeat),
                    "created_at": _iso(m.created_at),
                }
                for m in mach_rows
            ])

            # 2) Documents — content + identity, no rendered HTML, no
            # embedding bookkeeping, no internal tsvector. Capture the
            # ID set as we go for downstream cross-reference filters.
            if machine_ids:
                doc_q = select(Document).where(Document.machine_id.in_(machine_ids))
            else:
                doc_q = select(Document).where(Document.id == uuid.UUID(int=0))  # empty
            docs = (await db.execute(doc_q)).scalars().all()
            pending = await pending_tails(db, [d.id for d in docs])
            doc_rows = []
            for d in docs:
                doc_ids.add(d.id)
                doc_rows.append({
                    "id": str(d.id),
                    "tool_id": d.tool_id,
                    "project_id": str(d.project_id) if d.project_id else None,
                    "machine_id": str(d.machine_id) if d.machine_id else None,
                    "relative_path": d.relative_path,
                    "category": d.category,
                    "content_type": d.content_type,
                    "title": d.title,
                    "content": cap_content(d.content + pending[d.id]) if d.id in pending and d.content else d.content,
                    "content_hash": d.content_hash,
                    "file_size_bytes": d.file_size_bytes,
                    "ai_summary": d.ai_summary,
                    "ai_summary_generated_at": _iso(d.ai_summary_generated_at),
                    "source_modified_at": _iso(d.source_modified_at),
                    "synced_at": _iso(d.synced_at),
                    "created_at": _iso(d.created_at),
                })
            _write_jsonl(zf, "documents.jsonl", doc_rows)

            # 3) Projects — derive owned set from documents (no FK direct
            # to user). Strip visibility; importer always re-creates as
            # private with a fresh slug.
            project_ids = {d.project_id for d in docs if d.project_id}
            if project_ids:
                proj_rows = (await db.execute(
                    select(Project).where(Project.id.in_(project_ids))
                )).scalars().all()
            else:
                proj_rows = []
            _write_jsonl(zf, "projects.jsonl", [
                {
                    "id": str(p.id),
                    "slug": p.slug,
                    "title": p.title,
                    "tool_id": p.tool_id,
                    "source_path": p.source_path,
                    "created_at": _iso(p.created_at),
                }
                for p in proj_rows
            ])

            # 4) Conversation messages — drop BigInt PK + raw metadata_;
            # importer lets Postgres assign new ids.
            if doc_ids:
                msgs = (await db.execute(
                    select(ConversationMessage)
                    .where(ConversationMessage.document_id.in_(doc_ids))
                )).scalars().all()
            else:
                msgs = []
            _write_jsonl(zf, "conversation_messages.jsonl", [
                {
                    "document_id": str(m.document_id),
                    "line_number": m.line_number,
                    "message_type": m.message_type,
                    "role": m.role,
                    "content": m.content,
                    "timestamp": _iso(m.timestamp),
                }
                for m in msgs
            ])

            # 5) Document versions — drop BigInt PK; raw delta only.
            if doc_ids:
                vers = (await db.execute(
                    select(DocumentVersion)
                    .where(DocumentVersion.document_id.in_(doc_ids))
                )).scalars().all()
            else:
                vers = []
            _write_jsonl(zf, "document_versions.jsonl", [
                {
                    "document_id": str(v.document_id),
                    "content_hash": v.content_hash,
                    "content_delta": v.content_delta,
                    "file_size_bytes": v.file_size_bytes,
                    "synced_at": _iso(v.synced_at),
                }
                for v in vers
            ])

            # 6) Daily summaries — filter cross-user UUIDs in
            # source_document_ids to the caller's export set.
            ds_rows = (await db.execute(
                select(DailySummary).where(DailySummary.user_id == user.id)
            )).scalars().all()
            _write_jsonl(zf, "daily_summaries.jsonl", [
                {
                    "summary_date": str(d.summary_date),
                    "tool_id": d.tool_id,
                    "title": d.title,
                    "summary": d.summary,
                    "highlights": d.highlights,
                    "source_document_ids": [
                        str(x) for x in (d.source_document_ids or [])
                        if x in doc_ids
                    ],
                    "created_at": _iso(d.created_at),
                }
                for d in ds_rows
            ])

            # 7) Knowledge graph: entities first, then relations only
            # when BOTH endpoints are the caller's, then observations
            # gated on entity_id ∈ caller's; source_document_id filtered.
            ent_rows = (await db.execute(
                select(KnowledgeEntity).where(KnowledgeEntity.user_id == user.id)
            )).scalars().all()
            ent_ids = {e.id for e in ent_rows}
            _write_jsonl(zf, "knowledge_entities.jsonl", [
                {
                    "id": str(e.id),
                    "name": e.name,
                    "entity_type": e.entity_type,
                    "summary": e.summary,
                    "aliases": e.aliases or [],
                    "stale_at": _iso(e.stale_at),
                    "stale_reason": e.stale_reason,
                    "created_at": _iso(e.created_at),
                    "updated_at": _iso(e.updated_at),
                }
                for e in ent_rows
            ])

            if ent_ids:
                rel_rows = (await db.execute(
                    select(KnowledgeRelation).where(
                        KnowledgeRelation.source_id.in_(ent_ids),
                        KnowledgeRelation.target_id.in_(ent_ids),
                    )
                )).scalars().all()
            else:
                rel_rows = []
            _write_jsonl(zf, "knowledge_relations.jsonl", [
                {
                    "source_id": str(r.source_id),
                    "target_id": str(r.target_id),
                    "relation_type": r.relation_type,
                    "strength": r.strength,
                    "created_at": _iso(r.created_at),
                }
                for r in rel_rows
            ])

            if ent_ids:
                obs_rows = (await db.execute(
                    select(KnowledgeObservation).where(
                        KnowledgeObservation.entity_id.in_(ent_ids)
                    )
                )).scalars().all()
            else:
                obs_rows = []
            _write_jsonl(zf, "knowledge_observations.jsonl", [
                {
                    "entity_id": str(o.entity_id),
                    "content": o.content,
                    "source_document_id": (
                        str(o.source_document_id)
                        if o.source_document_id and o.source_document_id in doc_ids
                        else None
                    ),
                    "observed_at": _iso(o.observed_at),
                }
                for o in obs_rows
            ])

            # 8) Share links — strip token (importer mints fresh) and
            # target_user_id (importer degrades to anonymous).
            sl_rows = (await db.execute(
                select(ShareLink).where(ShareLink.owner_user_id == user.id)
            )).scalars().all()
            _write_jsonl(zf, "share_links.jsonl", [
                {
                    "kind": s.kind,
                    "target_id": s.target_id,
                    "title": s.title,
                    "expires_at": _iso(s.expires_at),
                    "revoked_at": _iso(s.revoked_at),
                    "created_at": _iso(s.created_at),
                }
                for s in sl_rows
            ])

            # 9) Access logs — opt-in, IP coarsened, document_id only
            # kept if pointing at an exported doc.
            if opts.include_access_logs:
                al_rows = (await db.execute(
                    select(AccessLog).where(AccessLog.user_id == user.id)
                )).scalars().all()
                _write_jsonl(zf, "access_logs.jsonl", [
                    {
                        "action": a.action,
                        "ip_address": _anonymize_ip(a.ip_address),
                        "user_agent": a.user_agent,
                        "document_id": (
                            str(a.document_id)
                            if a.document_id and a.document_id in doc_ids
                            else None
                        ),
                        "metadata": a.metadata_ if isinstance(a.metadata_, dict) else None,
                        "created_at": _iso(a.created_at),
                    }
                    for a in al_rows
                ])
            else:
                _write_jsonl(zf, "access_logs.jsonl", [])

            # 10) Manifest LAST so its `counts` reflects what actually
            # made it in. Do not include the caller's email/raw id —
            # the importer trusts its own JWT, not the manifest.
            manifest = {
                "format_version": FORMAT_VERSION,
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "options": {"include_access_logs": opts.include_access_logs},
                "counts": counts,
                "compat": {"major": 1, "min_importer_version": "1.0"},
            }
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))

        size = os.path.getsize(tmp_path)
        date_part = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        # Email could include characters disallowed in filenames; keep
        # only the local-part letters/digits/dash/underscore.
        safe_email = "".join(c for c in (user.email or "user").split("@")[0] if c.isalnum() or c in "-_")
        filename = f"memento-export-{safe_email}-{date_part}.zip"
        return ExportResult(path=tmp_path, filename=filename, size_bytes=size, counts=counts)
    except Exception:
        # Defensive cleanup — FileResponse's BackgroundTask never runs
        # because we never returned a path.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
