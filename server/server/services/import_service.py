"""Account-level data import — restore a memento-export ZIP into the
caller's account.

Security posture (informed by the adversarial review):

* **Hard caps before any DB work.** Three concentric limits enforced
  while reading the zip:
    1. `Content-Length` header rejected if > MAX_UPLOAD_BYTES (the API
       endpoint owns this — see api/data_io.py).
    2. Per-entry uncompressed bytes capped at MAX_ENTRY_BYTES
       (zip-bomb defense; ratio > 100x also rejected upfront).
    3. Total uncompressed bytes across all entries capped at
       MAX_TOTAL_BYTES.
* **Allowlisted member names.** We iterate a fixed name set and pull
  each entry by name. `namelist()` is never enumerated, so an attacker
  can't inject `../../etc/passwd` or extra files.
* **Whitelisted column writes.** Each row maps a fixed subset of fields
  into the model. Fields like `rendered_html`, `metadata_`,
  `visibility`, `embedding_status` are computed by import logic, never
  trusted from the file.
* **Single synthetic machine** per import (label `Imported on …`). All
  exported machine_ids remap to this single row, sidestepping
  `uq_documents_machine_tool_path` collisions cleanly and giving the
  user a clean rollback path (delete that machine → all imported data
  cascades out — well, except for what isn't FK-cascaded; the import
  log records counts so a manual cleanup is at least scriptable).
* **Fresh project slugs.** Project.slug has a global unique constraint
  with no user scoping, so reusing an existing slug would silently
  attach the caller's imported docs to *another* user's project. We
  always mint `<orig_slug>-imp-<short_uuid>` instead.
* **tools.ensure_tool** for every distinct tool_id observed — the
  destination instance may be on an older build that's missing rows for
  tools the source had.
* **Inline content_tsv compute** during the document INSERT pass so FTS
  works immediately, not "whenever beat runs the backfill task that
  isn't actually scheduled".
* **target_user_id NULLed** on every imported share_link — directed
  shares degrade to anonymous public; the importer cannot create a
  share aimed at an arbitrary user on the destination.
* **share_links kind validated** against (timeline, daily, memory)
  — unknown kinds fatal.

What's intentionally NOT in v1:
* Idempotent re-import (by content_hash). Each restore creates new
  rows; the UI confirms this. Cleanup = delete the synthetic machine.
* Admin "restore into another user's account". Caller is always the
  target.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import secrets
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Iterator

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    AccessLog, ConversationMessage, DailySummary, Document, DocumentVersion,
    KnowledgeEntity, KnowledgeObservation, KnowledgeRelation, Machine,
    Project, ShareLink, Tool, User,
)

logger = logging.getLogger("memento.import")

# === Size caps ===
# These should be tuned to the operator's box; defaults are conservative.
MAX_ENTRY_BYTES = int(os.environ.get("MEMENTO_IMPORT_MAX_ENTRY_BYTES",
                                      str(512 * 1024 * 1024)))     # 512 MiB
MAX_TOTAL_BYTES = int(os.environ.get("MEMENTO_IMPORT_MAX_TOTAL_BYTES",
                                      str(2 * 1024 * 1024 * 1024)))  # 2 GiB
MAX_LINE_BYTES = 4 * 1024 * 1024                                      # 4 MiB per JSONL line
MAX_RATIO = 200                                                       # uncompressed/compressed cap

ALLOWED_MEMBERS = {
    "manifest.json",
    "machines.jsonl",
    "projects.jsonl",
    "documents.jsonl",
    "conversation_messages.jsonl",
    "document_versions.jsonl",
    "daily_summaries.jsonl",
    "knowledge_entities.jsonl",
    "knowledge_relations.jsonl",
    "knowledge_observations.jsonl",
    "share_links.jsonl",
    "access_logs.jsonl",
}


def _is_zip_noise(name: str) -> bool:
    """Members an OS/zip tool injects when a user re-zips an export.

    macOS Finder adds `__MACOSX/` and `.DS_Store`; some tools include
    bare directory entries. We treat these as benign and skip them
    rather than reject the whole upload, otherwise re-zipped backups
    fail every time and the user thinks the file is corrupt.
    """
    if name.endswith("/"):                       # bare directory entry
        return True
    if name.startswith("__MACOSX/"):
        return True
    if name.endswith("/.DS_Store") or name == ".DS_Store":
        return True
    if name.endswith("/Thumbs.db") or name == "Thumbs.db":
        return True
    return False

VALID_SHARE_KINDS = {"timeline", "daily", "memory"}

@dataclass
class ImportResult:
    machine_id: str
    counts: dict[str, int] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


class ImportError(Exception):
    pass


def _safe_name(name: str) -> bool:
    """Reject anything that smells like path traversal or a directory."""
    if not name or name != name.strip():
        return False
    if any(c in name for c in ("\\", "\x00")):
        return False
    if name.startswith("/") or ".." in name.split("/"):
        return False
    return True


def _read_member(zf: zipfile.ZipFile, name: str, total_left: list[int]) -> bytes:
    """Read one member with caps. `total_left` is a single-element list
    used as a mutable counter (Python closure quirk)."""
    if name not in zf.namelist():
        return b""
    zinfo = zf.getinfo(name)
    if not _safe_name(zinfo.filename):
        raise ImportError(f"unsafe member name: {zinfo.filename!r}")
    if zinfo.file_size > MAX_ENTRY_BYTES:
        raise ImportError(
            f"{name}: uncompressed size {zinfo.file_size} > entry cap {MAX_ENTRY_BYTES}"
        )
    if zinfo.compress_size > 0 and zinfo.file_size / zinfo.compress_size > MAX_RATIO:
        raise ImportError(
            f"{name}: compression ratio "
            f"{zinfo.file_size / zinfo.compress_size:.1f}x exceeds cap (zip-bomb defense)"
        )
    if zinfo.file_size > total_left[0]:
        raise ImportError(f"total uncompressed bytes would exceed {MAX_TOTAL_BYTES} cap")
    total_left[0] -= zinfo.file_size

    # Bound the actual read — don't trust zinfo.file_size, a crafted
    # local header can lie about size and let f.read() blow out memory.
    with zf.open(name) as f:
        data = f.read(MAX_ENTRY_BYTES + 1)
        if len(data) > MAX_ENTRY_BYTES:
            raise ImportError(
                f"{name}: actual uncompressed size exceeded entry cap {MAX_ENTRY_BYTES}"
            )
        return data


def _iter_jsonl(blob: bytes) -> Iterator[dict[str, Any]]:
    """Parse a JSONL blob defensively — per-line cap, skip blanks."""
    buf = io.BytesIO(blob)
    for line in buf:
        if not line.strip():
            continue
        if len(line) > MAX_LINE_BYTES:
            raise ImportError(f"json line too large ({len(line)} bytes, cap {MAX_LINE_BYTES})")
        try:
            yield json.loads(line)
        except json.JSONDecodeError as e:
            raise ImportError(f"malformed JSONL line: {e}") from e


def _parse_dt(v: Any) -> datetime | None:
    if not v:
        return None
    if isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def _parse_date(v: Any) -> date | None:
    if not v:
        return None
    if isinstance(v, date) and not isinstance(v, datetime):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


async def _ensure_tools(db: AsyncSession, tool_ids: set[str]) -> None:
    """Lazily INSERT-OR-NOTHING tool rows the destination doesn't have.
    Mirrors the ingest_service.ensure_tool pattern but bulk-style."""
    # Display name fallback table mirrors ingest_service.TOOL_DISPLAY_NAMES.
    DEFAULTS = {
        "claude_code": "Claude Code",
        "openclaw": "OpenClaw",
        "codex": "Codex",
        "antigravity": "Antigravity",
        "obsidian": "Obsidian",
        "cursor": "Cursor",
        "hermes": "Hermes",
    }
    if not tool_ids:
        return
    existing = (await db.execute(
        select(Tool.id).where(Tool.id.in_(tool_ids))
    )).scalars().all()
    missing = tool_ids - set(existing)
    for tid in missing:
        await db.execute(
            pg_insert(Tool)
            .values(id=tid, display_name=DEFAULTS.get(tid, tid.replace("_", " ").title()))
            .on_conflict_do_nothing(index_elements=[Tool.id])
        )


def _fresh_slug(orig: str | None) -> str:
    """Mint a per-import slug to avoid colliding with another user's
    project (Project.slug is globally unique with no user scope)."""
    short = uuid.uuid4().hex[:8]
    base = (orig or "imported")[:200]
    return f"{base}-imp-{short}"


async def run_import(
    db: AsyncSession,
    user: User,
    zip_source: Any,
) -> ImportResult:
    """Restore an export ZIP into the caller's account. Atomic per table:
    each table is one INSERT pass within an outer transaction. The
    caller (api/data_io.py) opens the session — we just orchestrate.

    `zip_source` is anything `zipfile.ZipFile()` accepts — a bytes
    object (wrapped in BytesIO), a path, or a seekable file-like. The
    HTTP layer hands us a `SpooledTemporaryFile` so a multi-hundred-MB
    upload doesn't sit fully in process memory.
    """

    # === 1. Open + sanity check the zip ===
    if isinstance(zip_source, (bytes, bytearray)):
        zip_source = io.BytesIO(zip_source)
    try:
        zf = zipfile.ZipFile(zip_source)
    except zipfile.BadZipFile as e:
        raise ImportError(f"not a valid zip: {e}") from e

    # Allowlist gate — never iterate namelist() during the actual load
    # phase; only here for the up-front "unexpected member" check.
    # Skip benign zip noise (Finder __MACOSX/, .DS_Store, etc.) so
    # re-zipped backups don't fatal-error.
    all_names = [n for n in zf.namelist() if not _is_zip_noise(n)]
    actual_names = set(all_names)
    extras = actual_names - ALLOWED_MEMBERS
    if extras:
        raise ImportError(f"unexpected zip members: {sorted(extras)[:5]}…")
    if "manifest.json" not in actual_names:
        raise ImportError("missing manifest.json")

    total_left = [MAX_TOTAL_BYTES]

    # Manifest first — used for version gate.
    manifest_blob = _read_member(zf, "manifest.json", total_left)
    try:
        manifest = json.loads(manifest_blob)
    except json.JSONDecodeError as e:
        raise ImportError(f"manifest.json malformed: {e}") from e
    fmt_version = str(manifest.get("format_version", ""))
    major = fmt_version.split(".")[0] if fmt_version else ""
    if major != "1":
        raise ImportError(
            f"unsupported format_version {fmt_version!r}; this server reads major 1.x"
        )

    counts: dict[str, int] = {}
    warnings: list[str] = []

    def _load(name: str) -> list[dict[str, Any]]:
        if name not in actual_names:
            return []
        data = _read_member(zf, name, total_left)
        return list(_iter_jsonl(data))

    # === 2. Synthetic machine (one per import) ===
    # Pluck the caller's id into a plain local up front so the hot
    # insert loops below don't repeatedly hit ORM attribute getters —
    # which can lazy-load an expired instance mid-await and raise
    # MissingGreenlet under asyncpg+greenlet contexts.
    caller_user_id: uuid.UUID = user.id

    # === 2. Machines — one fresh Machine row per source machine, all
    # owned by the caller. The initial design used a SINGLE synthetic
    # machine, but that collapses every source machine_id into one row;
    # if the source was a multi-device account, two docs with the same
    # relative_path (e.g. ~/notes.md on laptop + desktop) collide on
    # uq_documents_machine_tool_path. One-per-source preserves all
    # docs cleanly. The label carries the original machine name so a
    # user who restored once can still tell their devices apart.
    ts_long = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    ts_short = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")

    def _import_name(orig: str | None) -> str:
        """Build a clean import label that *doesn't* nest when you import
        an export of an import. Strips any earlier ``Imported:``/``Imported on``
        prefix from the source name and stamps THIS import's timestamp."""
        clean = (orig or "").strip()
        # Strip layers of nesting: "Imported: Imported: laptop" → "laptop"
        while True:
            if clean.startswith("Imported: "):
                clean = clean[len("Imported: "):].lstrip()
                continue
            if clean.startswith("Imported on "):
                # Old fallback-style label — drop the whole thing, no
                # original name to preserve.
                clean = ""
                break
            break
        clean = clean[:120]
        if clean:
            return f"Imported {ts_short}: {clean}"
        return f"Imported {ts_short}"

    mach_rows = _load("machines.jsonl")
    machine_id_map: dict[str, uuid.UUID] = {}
    # Fallback machine for documents that reference a machine_id not
    # in the export (shouldn't normally happen, but defensive).
    fallback_machine = Machine(
        name=_import_name(None),
        collector_token_hash=hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
        collector_version=None,
        user_id=caller_user_id,
    )
    db.add(fallback_machine)
    for r in mach_rows:
        old_id = r.get("id")
        if not old_id:
            continue
        m = Machine(
            name=_import_name(r.get("name")),
            collector_token_hash=hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
            collector_version=r.get("collector_version"),
            user_id=caller_user_id,
        )
        db.add(m)
        await db.flush()
        machine_id_map[old_id] = m.id
    await db.flush()
    fallback_machine_id: uuid.UUID = fallback_machine.id
    counts["machines"] = len(machine_id_map) + 1  # +1 for fallback
    # ts_long retained for any callers/logs that previously formatted it
    _ = ts_long

    # === 3. Tools (ensure-existence) ===
    docs_rows = _load("documents.jsonl")
    ds_rows = _load("daily_summaries.jsonl")
    distinct_tools = {r.get("tool_id") for r in docs_rows if r.get("tool_id")}
    distinct_tools |= {r.get("tool_id") for r in ds_rows if r.get("tool_id")}
    await _ensure_tools(db, distinct_tools)

    # === 4. Projects (fresh slugs, isolated to this import) ===
    proj_rows = _load("projects.jsonl")
    project_id_map: dict[str, uuid.UUID] = {}
    for r in proj_rows:
        old_id = r.get("id")
        if not old_id:
            continue
        new_proj = Project(
            slug=_fresh_slug(r.get("slug")),
            title=(r.get("title") or "")[:500] or "Imported project",
            tool_id=r.get("tool_id"),
            source_path=r.get("source_path"),
            # Force private — visibility is attacker-controllable.
            visibility="private",
        )
        db.add(new_proj)
        await db.flush()
        project_id_map[old_id] = new_proj.id
    counts["projects"] = len(project_id_map)

    # === 5. Documents — compute content_tsv inline so FTS works
    # immediately (the backfill task isn't in beat_schedule today).
    from .tokenize import tokenize_for_index

    document_id_map: dict[str, uuid.UUID] = {}
    inserted_docs = 0
    for r in docs_rows:
        old_id = r.get("id")
        if not old_id:
            continue
        tool_id = r.get("tool_id")
        if not tool_id:
            warnings.append(f"document {old_id} missing tool_id; skipped")
            continue
        new_id = uuid.uuid4()
        document_id_map[old_id] = new_id
        old_proj = r.get("project_id")
        proj_id = project_id_map.get(old_proj) if old_proj else None
        content = r.get("content") or ""
        tsv_input = tokenize_for_index((r.get("title") or "") + " " + content)
        await db.execute(
            pg_insert(Document).values(
                id=new_id,
                tool_id=tool_id,
                project_id=proj_id,
                machine_id=machine_id_map.get(r.get("machine_id") or "", fallback_machine_id),
                relative_path=r.get("relative_path") or f"imported/{new_id}",
                category=r.get("category") or "memory",
                content_type=r.get("content_type") or "text",
                title=r.get("title"),
                content=content,
                content_hash=(r.get("content_hash") or hashlib.sha256(content.encode()).hexdigest()),
                file_size_bytes=int(r.get("file_size_bytes") or len(content)),
                content_tsv=func.to_tsvector("simple", tsv_input) if tsv_input else None,
                # Whitelist what we trust; reset everything user-mutable.
                metadata_={},
                rendered_html=None,
                ai_summary=r.get("ai_summary"),
                ai_summary_generated_at=_parse_dt(r.get("ai_summary_generated_at")),
                visibility="private",
                needs_review=False,
                embedding_status="pending",
                embedding_attempts=0,
                source_modified_at=_parse_dt(r.get("source_modified_at")),
                synced_at=_parse_dt(r.get("synced_at")) or datetime.now(timezone.utc),
            )
        )
        inserted_docs += 1
    counts["documents"] = inserted_docs

    # === 6. Conversation messages — drop BigInt PK, let DB assign ===
    msg_rows = _load("conversation_messages.jsonl")
    inserted_msgs = 0
    batch: list[dict] = []
    BATCH = 1000
    for r in msg_rows:
        new_doc = document_id_map.get(r.get("document_id"))
        if not new_doc:
            continue
        batch.append({
            "document_id": new_doc,
            "line_number": int(r.get("line_number") or 0),
            "message_type": r.get("message_type"),
            "role": r.get("role"),
            "content": r.get("content") or "",
            "metadata_": {},
            "timestamp": _parse_dt(r.get("timestamp")),
        })
        if len(batch) >= BATCH:
            await db.execute(pg_insert(ConversationMessage).values(batch))
            inserted_msgs += len(batch)
            batch.clear()
    if batch:
        await db.execute(pg_insert(ConversationMessage).values(batch))
        inserted_msgs += len(batch)
    counts["conversation_messages"] = inserted_msgs

    # === 7. Document versions ===
    ver_rows = _load("document_versions.jsonl")
    inserted_vers = 0
    batch.clear()
    for r in ver_rows:
        new_doc = document_id_map.get(r.get("document_id"))
        if not new_doc:
            continue
        batch.append({
            "document_id": new_doc,
            "content_hash": r.get("content_hash") or "",
            "content_delta": r.get("content_delta"),
            "file_size_bytes": r.get("file_size_bytes"),
            "synced_at": _parse_dt(r.get("synced_at")) or datetime.now(timezone.utc),
        })
        if len(batch) >= BATCH:
            await db.execute(pg_insert(DocumentVersion).values(batch))
            inserted_vers += len(batch)
            batch.clear()
    if batch:
        await db.execute(pg_insert(DocumentVersion).values(batch))
        inserted_vers += len(batch)
    counts["document_versions"] = inserted_vers

    # === 8. Daily summaries — ON CONFLICT DO NOTHING to absorb same-day
    # re-imports gracefully.
    inserted_ds = 0
    for r in ds_rows:
        sdate = _parse_date(r.get("summary_date"))
        if not sdate:
            continue
        # Filter source_document_ids to ones we actually imported.
        sd_ids = [
            document_id_map[x]
            for x in (r.get("source_document_ids") or [])
            if isinstance(x, str) and x in document_id_map
        ]
        stmt = pg_insert(DailySummary).values(
            user_id=caller_user_id,
            summary_date=sdate,
            tool_id=r.get("tool_id"),
            title=(r.get("title") or "Daily summary")[:1000],
            summary=r.get("summary") or "",
            highlights=r.get("highlights") if isinstance(r.get("highlights"), dict) else None,
            source_document_ids=sd_ids,
        ).on_conflict_do_nothing(
            # The unique index was declared via Index(..., unique=True)
            # rather than UniqueConstraint, so it doesn't show up in
            # pg_constraint — ON CONFLICT ON CONSTRAINT fails. Bind by
            # column list instead, which works for both kinds of unique.
            index_elements=["user_id", "summary_date", "tool_id"],
        )
        await db.execute(stmt)
        inserted_ds += 1
    counts["daily_summaries"] = inserted_ds

    # === 9. Knowledge entities — upsert on (user_id, name, entity_type),
    # populate id_map with existing or new id either way.
    ent_rows = _load("knowledge_entities.jsonl")
    entity_id_map: dict[str, uuid.UUID] = {}
    for r in ent_rows:
        old_id = r.get("id")
        if not old_id or not r.get("name") or not r.get("entity_type"):
            continue
        # Try to insert; if conflicting, look up the existing row's id.
        stmt = (
            pg_insert(KnowledgeEntity)
            .values(
                user_id=caller_user_id,
                name=r["name"],
                entity_type=r["entity_type"],
                summary=r.get("summary"),
            )
            .on_conflict_do_nothing(constraint="uq_entity_user_name_type")
            .returning(KnowledgeEntity.id)
        )
        inserted = (await db.execute(stmt)).scalar_one_or_none()
        if inserted is None:
            existing = (await db.execute(
                select(KnowledgeEntity.id).where(
                    KnowledgeEntity.user_id == caller_user_id,
                    KnowledgeEntity.name == r["name"],
                    KnowledgeEntity.entity_type == r["entity_type"],
                )
            )).scalar_one_or_none()
            if existing is None:
                continue  # unreachable but defensive
            entity_id_map[old_id] = existing
        else:
            entity_id_map[old_id] = inserted
    counts["knowledge_entities"] = len(entity_id_map)

    # === 10. Relations — WHERE NOT EXISTS dedup against
    # (source_id, target_id, relation_type) — relations table has no
    # unique constraint, so we filter manually before bulk insert.
    rel_rows = _load("knowledge_relations.jsonl")
    inserted_rel = 0
    if rel_rows and entity_id_map:
        # Pre-fetch existing (source, target, type) tuples for these entities.
        ent_ids = list(entity_id_map.values())
        existing_pairs = set()
        if ent_ids:
            existing = (await db.execute(
                select(
                    KnowledgeRelation.source_id,
                    KnowledgeRelation.target_id,
                    KnowledgeRelation.relation_type,
                ).where(
                    KnowledgeRelation.source_id.in_(ent_ids),
                    KnowledgeRelation.target_id.in_(ent_ids),
                )
            )).all()
            existing_pairs = {(s, t, k) for s, t, k in existing}
        new_pairs = set()
        for r in rel_rows:
            s_new = entity_id_map.get(r.get("source_id"))
            t_new = entity_id_map.get(r.get("target_id"))
            kind = r.get("relation_type")
            if not s_new or not t_new or not kind:
                continue
            key = (s_new, t_new, kind)
            if key in existing_pairs or key in new_pairs:
                continue
            new_pairs.add(key)
            await db.execute(
                pg_insert(KnowledgeRelation).values(
                    source_id=s_new,
                    target_id=t_new,
                    relation_type=kind,
                    strength=float(r.get("strength") or 1.0),
                )
            )
            inserted_rel += 1
    counts["knowledge_relations"] = inserted_rel

    # === 11. Observations ===
    obs_rows = _load("knowledge_observations.jsonl")
    inserted_obs = 0
    batch.clear()
    for r in obs_rows:
        ent = entity_id_map.get(r.get("entity_id"))
        if not ent or not r.get("content"):
            continue
        src_doc = None
        old_doc = r.get("source_document_id")
        if old_doc and old_doc in document_id_map:
            src_doc = document_id_map[old_doc]
        batch.append({
            "entity_id": ent,
            "content": r["content"],
            "source_document_id": src_doc,
            "observed_at": _parse_dt(r.get("observed_at")) or datetime.now(timezone.utc),
        })
        if len(batch) >= BATCH:
            await db.execute(pg_insert(KnowledgeObservation).values(batch))
            inserted_obs += len(batch)
            batch.clear()
    if batch:
        await db.execute(pg_insert(KnowledgeObservation).values(batch))
        inserted_obs += len(batch)
    counts["knowledge_observations"] = inserted_obs

    # === 12. Share links — always mint fresh token, NULL target_user_id,
    # validate kind, rewrite target_id where applicable.
    sl_rows = _load("share_links.jsonl")
    inserted_sl = 0
    for r in sl_rows:
        kind = r.get("kind")
        if kind not in VALID_SHARE_KINDS:
            warnings.append(f"share_link kind {kind!r} unknown; skipped")
            continue
        target_id = r.get("target_id") or ""
        if kind == "timeline":
            mapped = project_id_map.get(target_id)
            if not mapped:
                warnings.append(f"timeline share for project {target_id} skipped (project not in import)")
                continue
            target_id = str(mapped)
        elif kind == "daily":
            if len(target_id) != 10:
                warnings.append(f"daily share target_id {target_id!r} invalid; skipped")
                continue
        elif kind == "memory":
            if target_id != "all":
                warnings.append(f"memory share target_id {target_id!r} unsupported; skipped")
                continue

        # New token; never reuse — old URLs can no longer enumerate.
        raw = secrets.token_bytes(24)
        import base64
        new_token = base64.b32encode(raw).decode("ascii").rstrip("=").lower()

        db.add(ShareLink(
            token=new_token,
            kind=kind,
            target_id=target_id,
            owner_user_id=caller_user_id,
            target_user_id=None,
            title=r.get("title"),
            expires_at=_parse_dt(r.get("expires_at")),
            revoked_at=_parse_dt(r.get("revoked_at")),
        ))
        inserted_sl += 1
    counts["share_links"] = inserted_sl

    # === 13. Access logs (preserve created_at, user_agent, action;
    # document_id remapped or NULLed).
    al_rows = _load("access_logs.jsonl")
    inserted_al = 0
    batch.clear()
    for r in al_rows:
        if not r.get("action"):
            continue
        new_doc = None
        old_doc = r.get("document_id")
        if old_doc and old_doc in document_id_map:
            new_doc = document_id_map[old_doc]
        meta = r.get("metadata") if isinstance(r.get("metadata"), dict) else {}
        if old_doc and not new_doc:
            # Preserve the trail by stashing the original doc UUID.
            meta = {**meta, "imported_from_doc": old_doc}
        batch.append({
            "user_id": caller_user_id,
            "document_id": new_doc,
            "action": r["action"],
            "ip_address": r.get("ip_address"),
            "user_agent": r.get("user_agent"),
            "metadata_": meta,
            "created_at": _parse_dt(r.get("created_at")) or datetime.now(timezone.utc),
        })
        if len(batch) >= BATCH:
            await db.execute(pg_insert(AccessLog).values(batch))
            inserted_al += len(batch)
            batch.clear()
    if batch:
        await db.execute(pg_insert(AccessLog).values(batch))
        inserted_al += len(batch)
    counts["access_logs"] = inserted_al

    return ImportResult(
        # `machine_id` in the result is the fallback machine — the
        # rollback hint is "delete every `Imported …` machine created
        # in this run", but for the UI we surface a single id as the
        # primary entry point.
        machine_id=str(fallback_machine_id),
        counts=counts,
        warnings=warnings,
    )
