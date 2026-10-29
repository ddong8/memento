"""Checking that conversation_messages holds each message of a conversation's text, and once.

What went wrong before it: tool calls of one tool in one second were taken for copies and dropped
(10-29: 33 from three days of one Mac's sessions), slices replayed from the collector's offline buffer
were appended twice (10-27, 10-28), and a collector before v1.0.85 cut lines over 128 KB into head and
tail, so the message on them (a 630k-character prompt) was never stored. Ingestion is fixed; this finds
and repairs what it left behind, and whatever slips past it later.

A conversation is checked once its text has been quiet for QUIET_MINUTES with nothing staged for it
(content_staging.py), and again whenever the text changes. The text is parsed as ingestion parses it
(messages_to_store) and laid against the rows (message_store.plan_alignment, "interleave"):
- a row that is another copy of a message the text holds goes, kept in conversation_messages_removed;
- a message no row holds is inserted;
- a row the text doesn't hold (stored by an older parser) stays where it is, and one with the role
  and second of a missing message stands for it rather than having the message stored twice;
- line numbers follow the text. Rows keep their ids: the learning scans read by id (message_store.py).

settings.message_audit_mode: "observe" writes what it would do to message_audit and changes nothing,
"repair" does it, "off" stops. In "repair", a text with a line the old collector cut, or rows outside
the text that are copies of each other (a big log whose stored text lost its middle: replayed slices
or the log's own repeats, only the file tells), asks its device, once, to send the file again
(command "resync_files"; store_slice then lines the rows up with it); only a device whose collector knows the
command, which one before v1.0.95 acknowledges and drops. Those that know it report their upload
state in the heartbeat (machines.collect_status): a device that doesn't yet is asked once it updates.
A text too big to check here (its stored copy keeps only its head and tail) is asked for the same way:
the upload lines the rows up with the file slice by slice (10-30: two such logs of one Mac lacked 6 tool
calls the old dedup key dropped, and nothing else could put them back).
"""

from __future__ import annotations

import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import MessageAudit
from . import message_store
from .content_staging import MAX_CONTENT_CHARS
from .conversation_parser import messages_to_store
from .ingest_service import slice_lock_key

logger = logging.getLogger("message_audit")

QUIET_MINUTES = 10
# A text this close to MAX_CONTENT_CHARS may have lost its middle (content_staging.cap_content): the
# rows hold more than it does, nothing to check them against
TOO_BIG_CHARS = MAX_CONTENT_CHARS - 200_000
# Tools whose conversations aren't JSONL logs from a collector: memento's are written by the server
# (ask_store.py), Hermes keeps one JSON document (_extract_messages aligns it on each upload)
SKIP_TOOLS = ("memento", "hermes")
TRUNCATED_MARK = "[TRUNCATED: line exceeded"
RETRY_ERRORS_AFTER = "1 day"
# Raised when the check looks for something it didn't: texts checked by an older one are checked again
# (2: copies outside the text, "unvouched")
AUDIT_VERSION = 2
_AUDIT_LOCK = 0x6D656D61756469  # "memaudi"

MODES = ("off", "observe", "repair")


def _candidates_sql(repair: bool) -> str:
    redo = " OR a.outcome = 'needs_repair'" if repair else ""
    return f"""
        SELECT d.id FROM documents d
        LEFT JOIN message_audit a ON a.document_id = d.id
        WHERE d.category = 'conversation' AND d.content_type = 'jsonl'
          AND d.tool_id NOT IN ('memento', 'hermes')
          AND d.content IS NOT NULL
          AND d.synced_at < now() - interval '{QUIET_MINUTES} minutes'
          AND NOT EXISTS (SELECT 1 FROM document_pending_deltas p WHERE p.document_id = d.id)
          AND (a.document_id IS NULL OR a.content_hash IS DISTINCT FROM d.content_hash{redo}
               OR coalesce((a.detail->>'v')::int, 1) < {AUDIT_VERSION}
               OR (a.outcome = 'error' AND a.checked_at < now() - interval '{RETRY_ERRORS_AFTER}'))
        ORDER BY a.checked_at NULLS FIRST, d.synced_at DESC
        LIMIT :n
    """


# Texts with lines the old collector cut, rows only the file can vouch for or too big to check, on
# devices that can send them again, not asked yet. A too big one only with rows: a log nothing was ever
# read from (an OpenClaw trajectory) gives none the second time either.
_RESYNC_DUE_SQL = """
    SELECT a.document_id, d.machine_id, d.tool_id, d.relative_path FROM message_audit a
    JOIN documents d ON d.id = a.document_id
    JOIN machines m ON m.id = d.machine_id
    WHERE (a.detail->>'truncated' IS NOT NULL OR a.detail->>'unvouched' IS NOT NULL
           OR (a.outcome = 'too_big' AND EXISTS (SELECT 1 FROM conversation_messages cm WHERE cm.document_id = a.document_id)))
      AND a.detail->>'resync_requested_at' IS NULL
      AND m.collect_status->>'reported_at' IS NOT NULL
    ORDER BY a.checked_at
    LIMIT :n
"""


async def _record(db: AsyncSession, doc_id: uuid.UUID, content_hash: str | None, outcome: str, **counts) -> None:
    detail = {**(counts.pop("detail", {}) or {}), "v": AUDIT_VERSION}
    values = {
        "document_id": doc_id,
        "content_hash": content_hash,
        "checked_at": datetime.now(timezone.utc),
        "outcome": outcome,
        "expected": counts.get("expected", 0),
        "stored": counts.get("stored", 0),
        "missing": counts.get("missing", 0),
        "duplicates": counts.get("duplicates", 0),
        "unknown": counts.get("unknown", 0),
        "detail": detail,
    }
    stmt = pg_insert(MessageAudit).values(**values)
    await db.execute(stmt.on_conflict_do_update(
        index_elements=[MessageAudit.document_id],
        set_={k: stmt.excluded[k] for k in values if k != "document_id"},
    ))


async def audit_document(db: AsyncSession, doc_id: uuid.UUID, repair: bool) -> dict | None:
    """Check one conversation (and repair it with `repair`); what was found, or None when it's busy
    (being stored right now) or gone. The caller commits."""
    doc = (await db.execute(
        text(
            "SELECT tool_id, relative_path, machine_id, content, content_hash FROM documents "
            "WHERE id = :d FOR UPDATE SKIP LOCKED"
        ),
        {"d": doc_id},
    )).first()
    if doc is None:
        return None
    tool_id, relative_path, machine_id, content, content_hash = doc
    # The lock ingestion stores this file under (ingest_service.lock_slice): a slice arriving now waits
    if machine_id is not None and not await db.scalar(
        text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"),
        {"k": slice_lock_key(machine_id, tool_id, relative_path)},
    ):
        return None
    prev_row = (await db.execute(
        text("SELECT detail, outcome, checked_at FROM message_audit WHERE document_id = :d"), {"d": doc_id},
    )).first()
    prev = (prev_row[0] if prev_row else None) or {}
    detail: dict = {k: prev[k] for k in ("resync_requested_at", "repaired_at") if k in prev}
    if prev_row and prev_row[1] == "repaired" and "repaired_at" not in detail:
        detail["repaired_at"] = prev_row[2].isoformat()
    content = content or ""
    if len(content) >= TOO_BIG_CHARS:
        await _record(db, doc_id, content_hash, "too_big", detail=detail)
        return {"outcome": "too_big"}

    truncated = content.count(TRUNCATED_MARK)
    if truncated:
        detail["truncated"] = truncated
    expected = messages_to_store(content, tool_id)
    stored = await message_store.stored_rows(db, doc_id)
    plan = message_store.plan_alignment(stored, expected, 1, "interleave")
    counts = {
        "expected": len(expected),
        "stored": len(stored),
        "missing": len(plan.insert),
        "duplicates": plan.duplicates,
        "unknown": plan.unknown,
    }
    if plan.stand_ins:
        detail["stand_ins"] = plan.stand_ins
    if plan.move:
        detail["moved"] = len(plan.move)
    if plan.parked:
        detail["parked"] = plan.parked
    if plan.unvouched:
        detail["unvouched"] = plan.unvouched
    if not plan.changes:
        outcome = "ok"
    elif repair:
        await message_store.apply_alignment(db, doc_id, plan, archive_reason="audit")
        outcome = "repaired"
        detail["repaired_at"] = datetime.now(timezone.utc).isoformat()
    else:
        outcome = "needs_repair"
    await _record(db, doc_id, content_hash, outcome, detail=detail, **counts)
    return {
        "outcome": outcome,
        **counts,
        "truncated": truncated,
    }


async def _request_resyncs(db: AsyncSession, redis, limit: int = 500) -> int:
    """Ask each device for the files with cut lines again, one command per device; marks them asked."""
    from . import device_commands

    wanted: dict[uuid.UUID, list[tuple[uuid.UUID, str, str]]] = defaultdict(list)
    for doc_id, machine_id, tool_id, relative_path in (await db.execute(text(_RESYNC_DUE_SQL), {"n": limit})).all():
        wanted[machine_id].append((doc_id, tool_id, relative_path))
    await db.rollback()
    asked = 0
    for machine_id, files in wanted.items():
        device = await db.scalar(text("SELECT collector_token_hash FROM machines WHERE id = :m"), {"m": machine_id})
        if not device:
            continue
        try:
            await device_commands.push(
                redis, device, "resync_files",
                {"files": [{"tool": tool, "relative_path": path} for _, tool, path in files]},
            )
        except Exception as e:
            logger.warning("asking %s to send %d files again failed: %s", machine_id, len(files), e)
            continue
        now = datetime.now(timezone.utc).isoformat()
        for doc_id, _, _ in files:
            await db.execute(
                text(
                    "UPDATE message_audit SET detail = detail || jsonb_build_object('resync_requested_at', CAST(:t AS text)) "
                    "WHERE document_id = :d"
                ),
                {"t": now, "d": doc_id},
            )
        asked += len(files)
    await db.commit()
    return asked


async def audit_due(session_factory, engine, mode: str, redis=None, budget_seconds: float = 120.0, limit: int = 200) -> dict:
    """Check the conversations due, until the budget runs out. One run at a time across workers."""
    if mode not in MODES or mode == "off":
        return {"mode": mode}
    repair = mode == "repair"
    deadline = time.monotonic() + budget_seconds
    stats: dict = defaultdict(int)
    stats["mode"] = mode
    async with engine.connect() as lock_conn:
        if not await lock_conn.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": _AUDIT_LOCK}):
            return {"mode": mode, "busy": True}
        try:
            async with session_factory() as db:
                due = (await db.execute(text(_candidates_sql(repair)), {"n": limit})).scalars().all()
                await db.rollback()
                for doc_id in due:
                    if time.monotonic() >= deadline:
                        break
                    try:
                        found = await audit_document(db, doc_id, repair)
                        await db.commit()
                    except Exception as e:
                        await db.rollback()
                        logger.warning("Auditing the messages of %s failed: %s", doc_id, e)
                        try:
                            content_hash = await db.scalar(text("SELECT content_hash FROM documents WHERE id = :d"), {"d": doc_id})
                            await _record(db, doc_id, content_hash, "error", detail={"error": str(e)[:300]})
                            await db.commit()
                        except Exception:
                            await db.rollback()
                        stats["error"] += 1
                        continue
                    if found is None:
                        stats["busy"] += 1
                        continue
                    stats[found["outcome"]] += 1
                    for k in ("missing", "duplicates", "unknown"):
                        stats[k] += found.get(k, 0)
                # Sending a log again rewrites its rows: not while only observing
                if repair and redis is not None:
                    try:
                        asked = await _request_resyncs(db, redis)
                    except Exception as e:
                        await db.rollback()
                        logger.warning("Asking devices to send cut logs again failed: %s", e)
                        asked = 0
                    if asked:
                        stats["resync_requested"] = asked
        finally:
            await lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _AUDIT_LOCK})
    return dict(stats)


async def summary(db: AsyncSession) -> dict:
    """Totals of the audit so far, for the device page and for deciding to switch to "repair"."""
    rows = (await db.execute(text(
        "SELECT outcome, count(*), coalesce(sum(missing), 0), coalesce(sum(duplicates), 0), coalesce(sum(unknown), 0) "
        "FROM message_audit GROUP BY outcome"
    ))).all()
    return {
        outcome: {"documents": n, "missing": int(m), "duplicates": int(d), "unknown": int(u)}
        for outcome, n, m, d, u in rows
    }
