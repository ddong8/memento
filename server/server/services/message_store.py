"""Bringing a conversation's stored messages in line with its text, without renumbering what's there.

A full upload (and the audit, message_audit.py) used to delete a conversation's messages and insert
them again. The learning scans read messages by id from a cursor (correction_service, todo_service):
messages inserted again get new ids past it, and a month of the user's pushback would be read as new.
Here a message already stored keeps its row and its id; only what's missing is inserted, copies of one
message beyond what the text holds are deleted, and line numbers are set to the order of the text.

A log the collector sends again from the start comes in slices (512 KB each): the first can't tell
what the rest holds. Its rows that the first slice doesn't take are parked (line numbers from PARKED
up, in their order) for the later slices to take; whatever is still parked once a slice reaches the
end of the file isn't in the text and goes, kept in conversation_messages_removed (reason "upload").
"""

from __future__ import annotations

import uuid
from bisect import bisect_left
from collections import defaultdict, deque
from dataclasses import dataclass, field

from sqlalchemy import BigInteger, Integer, bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage
from .conversation_parser import StoredMessage, dialogue_key

# conversation_parser.row_key, computed by the database (the texts never leave it)
ROW_KEY_SQL = (
    "md5(coalesce(role, '') || ':' || coalesce(floor(extract(epoch from \"timestamp\"))::bigint::text, '') "
    "|| ':' || content || chr(31) || coalesce(metadata->>'tool_input', ''))"
)
# StoredMessage.loose
LOOSE_KEY_SQL = (
    "CASE WHEN \"timestamp\" IS NULL THEN NULL "
    "ELSE coalesce(role, '') || ':' || floor(extract(epoch from \"timestamp\"))::bigint::text END"
)

# Line numbers from here up: rows set aside while a log comes again in slices
PARKED = 1_000_000_000
# conversation_messages_removed.reason of rows a log sent again from the start no longer holds
UPLOAD_REMOVED = "upload"
# While rows are renumbered they pass through -(line) - _TRANSIT, below everything a conversation
# holds (Codex's history rows go down to -1000): the unique index on (document_id, line_number)
# would otherwise trip over a row that hasn't moved yet
_TRANSIT = 1_000_000_000


@dataclass
class Alignment:
    move: list[tuple[int, int]] = field(default_factory=list)  # (row id, line number) of rows that move
    insert: list[tuple[int, StoredMessage]] = field(default_factory=list)
    delete: list[int] = field(default_factory=list)
    unchanged: int = 0
    parked: int = 0  # rows no message took, set aside for later slices (deleted by "interleave")
    duplicates: int = 0  # rows deleted that are another copy of a message the text holds
    unknown: int = 0  # rows whose message the text doesn't hold (deleted, or kept by "interleave")
    stand_ins: int = 0  # rows an older parser stored for a message, kept for it ("interleave")
    # Rows kept by "interleave" that are another copy of a kept row: the text can't say whether the
    # log holds the message that often (a replayed slice) or not, only the file sent again can
    unvouched: int = 0

    @property
    def changes(self) -> bool:
        return bool(self.move or self.insert or self.delete)


Row = tuple  # (id, line number, row key[, loose key]) of a stored message


def plan_alignment(
    stored: list[Row],
    expected: list[StoredMessage],
    start_line: int = 1,
    rest: str = "delete",
) -> Alignment:
    """What turns `stored` (in line order) into `expected`, numbered from start_line. Each expected
    message takes the first stored row with its key that is still free.

    `rest` is what becomes of the rows no message takes:
    - "delete": the text is all there, they go;
    - "park": more of the text is coming, they go to PARKED and up, in their order;
    - "keep": left where they are (parked already);
    - "interleave" (the audit): copies of a message the text holds go; a row the text doesn't hold
      is kept where it stood among the others. One with the role and second of a message no row
      took is that message as an older parser stored it ("[Bash]" before tool inputs were kept): it
      stands for it, so the message isn't stored a second time."""
    free: dict[str, deque] = defaultdict(deque)
    for row in stored:
        free[row[2]].append(row)
    taken: list[Row | None] = []
    for msg in expected:
        rows = free.get(msg.key)
        taken.append(rows.popleft() if rows else None)
    left = sorted((row for rows in free.values() for row in rows), key=lambda r: (r[1], r[0]))
    wanted = {m.key for m in expected}
    plan = Alignment()

    if rest == "interleave":
        kept = [r for r in left if r[2] not in wanted]
        for r in left:
            if r[2] in wanted:
                plan.delete.append(r[0])
                plan.duplicates += 1
        by_loose: dict[str, deque] = defaultdict(deque)
        for r in kept:
            if len(r) > 3 and r[3]:
                by_loose[r[3]].append(r)
        standing: set[int] = set()
        for i, msg in enumerate(expected):
            if taken[i] is None and msg.loose and by_loose.get(msg.loose):
                r = by_loose[msg.loose].popleft()
                taken[i] = r
                standing.add(r[0])
        plan.stand_ins = len(standing)
        kept = [r for r in kept if r[0] not in standing]
        # Still parked once the whole text is there: set aside by a full upload from a collector that
        # didn't say where its slices end, and no later slice took it (store_slice)
        for r in kept:
            if r[1] >= PARKED:
                plan.delete.append(r[0])
                plan.parked += 1
        kept = [r for r in kept if r[1] < PARKED]
        plan.unknown = len(kept)
        plan.unvouched = len(kept) - len({r[2] for r in kept})
        # Each kept row goes after the message whose row stood last before it
        anchors = sorted((r[1], r[0], i) for i, r in enumerate(taken) if r is not None)
        after: dict[int, list[Row]] = defaultdict(list)
        for r in kept:
            j = bisect_left(anchors, (r[1], r[0])) - 1
            after[anchors[j][2] if j >= 0 else -1].append(r)
        order: list[Row | StoredMessage] = list(after.get(-1, []))
        for i, msg in enumerate(expected):
            order.append(taken[i] if taken[i] is not None else msg)
            order.extend(after.get(i, []))
        for k, item in enumerate(order):
            line = start_line + k
            if isinstance(item, StoredMessage):
                plan.insert.append((line, item))
            elif item[1] == line:
                plan.unchanged += 1
            else:
                plan.move.append((item[0], line))
        return plan

    for i, msg in enumerate(expected):
        line = start_line + i
        row = taken[i]
        if row is None:
            plan.insert.append((line, msg))
        elif row[1] == line:
            plan.unchanged += 1
        else:
            plan.move.append((row[0], line))
    if rest == "park":
        for i, row in enumerate(left):
            plan.parked += 1
            if row[1] != PARKED + i:
                plan.move.append((row[0], PARKED + i))
    elif rest == "keep":
        plan.parked = len(left)
    else:
        for row in left:
            plan.delete.append(row[0])
            if row[2] in wanted:
                plan.duplicates += 1
            else:
                plan.unknown += 1
    return plan


async def stored_rows(
    db: AsyncSession, doc_id: uuid.UUID, start_line: int = 1, end_line: int | None = None,
) -> list[Row]:
    """(id, line number, row key, loose key) of a conversation's messages from start_line (to before
    end_line), in order. Rows numbered below 1 aren't the text's: Codex's history and first prompt
    (_extract_messages)."""
    sql = (
        f"SELECT id, line_number, {ROW_KEY_SQL}, {LOOSE_KEY_SQL} FROM conversation_messages "
        "WHERE document_id = :d AND line_number >= :s"
    )
    params: dict = {"d": doc_id, "s": start_line}
    if end_line is not None:
        sql += " AND line_number < :e"
        params["e"] = end_line
    rows = await db.execute(text(sql + " ORDER BY line_number, id"), params)
    return [tuple(r) for r in rows.all()]


def _row(doc_id: uuid.UUID, line: int, msg: StoredMessage) -> ConversationMessage:
    return ConversationMessage(
        document_id=doc_id,
        line_number=line,
        message_type=msg.message_type,
        role=msg.role,
        content=msg.content,
        metadata_=msg.metadata,
        timestamp=msg.timestamp,
    )


async def insert_messages(db: AsyncSession, doc_id: uuid.UUID, rows: list[tuple[int, StoredMessage]]) -> None:
    for i in range(0, len(rows), 100):
        db.add_all([_row(doc_id, line, msg) for line, msg in rows[i:i + 100]])
        await db.flush()


async def apply_alignment(db: AsyncSession, doc_id: uuid.UUID, plan: Alignment, archive_reason: str | None = None) -> None:
    """Carry out a plan. With archive_reason the deleted rows are kept in conversation_messages_removed
    first: the audit's repairs, and what a log sent again from the start no longer holds (a resync can
    take tens of thousands of a big log's rows, message_audit.py)."""
    if plan.delete:
        ids = bindparam("ids", type_=ARRAY(BigInteger))
        if archive_reason:
            await db.execute(
                text(
                    "INSERT INTO conversation_messages_removed "
                    "(id, document_id, line_number, message_type, role, content, metadata, \"timestamp\", created_at, reason) "
                    "SELECT id, document_id, line_number, message_type, role, content, metadata, \"timestamp\", created_at, :reason "
                    "FROM conversation_messages WHERE id = ANY(:ids) ON CONFLICT (id) DO NOTHING"
                ).bindparams(ids),
                {"ids": plan.delete, "reason": archive_reason},
            )
        await db.execute(text("DELETE FROM conversation_messages WHERE id = ANY(:ids)").bindparams(ids), {"ids": plan.delete})
    if plan.move:
        moving = [row_id for row_id, _ in plan.move]
        await db.execute(
            text("UPDATE conversation_messages SET line_number = -line_number - :t WHERE id = ANY(:ids)")
            .bindparams(bindparam("ids", type_=ARRAY(BigInteger))),
            {"ids": moving, "t": _TRANSIT},
        )
        await db.execute(
            text(
                "UPDATE conversation_messages AS c SET line_number = v.line FROM "
                "(SELECT unnest(CAST(:ids AS bigint[])) AS id, unnest(CAST(:lines AS integer[])) AS line) AS v WHERE c.id = v.id"
            ).bindparams(bindparam("ids", type_=ARRAY(BigInteger)), bindparam("lines", type_=ARRAY(Integer))),
            {"ids": moving, "lines": [line for _, line in plan.move]},
        )
    if plan.insert:
        await insert_messages(db, doc_id, plan.insert)


async def recent_dialogue_keys(db: AsyncSession, doc_id: uuid.UUID, limit: int = 50) -> set[str]:
    """dialogue_key of a conversation's latest user and assistant messages: a delta starting with the
    second copy of a Codex message (its first went up with the previous delta) doesn't store it again."""
    rows = await db.execute(
        text(
            "SELECT role, \"timestamp\", content FROM conversation_messages "
            "WHERE document_id = :d AND role IN ('user', 'assistant') AND line_number < :p "
            "ORDER BY line_number DESC LIMIT :n"
        ),
        {"d": doc_id, "p": PARKED, "n": limit},
    )
    return {dialogue_key(role, None, content, ts) for role, ts, content in rows.all()}


async def store_slice(
    db: AsyncSession, doc_id: uuid.UUID, msgs_of, full: bool, complete: bool,
) -> list[StoredMessage]:
    """Store the messages of one slice of a log. `msgs_of(seen)` parses the slice (seen: dialogue keys
    of the messages before it). `full`: the slice starts the file; `complete`: it reaches the end.

    A delta to a conversation with nothing parked is a plain append, as every delta was before."""
    if full:
        msgs = msgs_of(set())
        plan = plan_alignment(await stored_rows(db, doc_id), msgs, 1, "delete" if complete else "park")
        await apply_alignment(db, doc_id, plan, archive_reason=UPLOAD_REMOVED)
        return msgs
    top = await db.scalar(
        text("SELECT line_number FROM conversation_messages WHERE document_id = :d ORDER BY line_number DESC LIMIT 1"),
        {"d": doc_id},
    )
    seen = await recent_dialogue_keys(db, doc_id)
    msgs = msgs_of(seen)
    if top is None or top < PARKED:
        await insert_messages(db, doc_id, list(enumerate(msgs, start=max(top or 0, 0) + 1)))
        return msgs
    last = await db.scalar(
        text(
            "SELECT line_number FROM conversation_messages WHERE document_id = :d AND line_number < :p "
            "ORDER BY line_number DESC LIMIT 1"
        ),
        {"d": doc_id, "p": PARKED},
    )
    parked = await stored_rows(db, doc_id, start_line=PARKED)
    plan = plan_alignment(parked, msgs, max(last or 0, 0) + 1, "delete" if complete else "keep")
    await apply_alignment(db, doc_id, plan, archive_reason=UPLOAD_REMOVED)
    return msgs
