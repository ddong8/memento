"""Storing a conversation's messages once each, in the order of its text, keeping their ids.

10-29: 33 tool calls were missing from three days of one Mac's sessions (parallel calls of one tool
in one second taken for copies) and five messages were there twice (slices replayed from the
collector's offline buffer). Ingestion stores each slice once (ingest_service.claim_slice) and lays a
full upload against what's stored (message_store); the audit (message_audit.py) repairs what was left.
Rows keep their ids throughout: the learning scans read messages by id from a cursor.

The database tests run against a real PostgreSQL when MEMENTO_TEST_DATABASE_URL points at a
throwaway database (they create and drop the schema)."""

from __future__ import annotations

import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.conversation_parser import StoredMessage, messages_to_store, row_key  # noqa: E402
from server.services.message_store import PARKED, plan_alignment  # noqa: E402

DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")
T0 = datetime(2026, 10, 29, 8, 0, 0, tzinfo=timezone.utc)


def _msg(role: str, text: str, sec: int = 0, tool_input: str = "") -> StoredMessage:
    ts = T0 + timedelta(seconds=sec)
    meta = {"tool_input": tool_input} if tool_input else {}
    return StoredMessage(role, role, text, meta, ts, row_key(role, ts, text, tool_input))


def _row(row_id: int, line: int, m: StoredMessage) -> tuple:
    return (row_id, line, m.key, m.loose)


def _user(text: str, sec: int) -> str:
    ts = (T0 + timedelta(seconds=sec)).isoformat().replace("+00:00", "Z")
    return json.dumps({"type": "user", "timestamp": ts, "message": {"role": "user", "content": text}}, ensure_ascii=False)


def _bash(command: str, sec: int, call_id: str) -> str:
    ts = (T0 + timedelta(seconds=sec)).isoformat().replace("+00:00", "Z")
    return json.dumps({
        "type": "assistant",
        "timestamp": ts,
        "message": {"role": "assistant", "content": [{"type": "tool_use", "id": call_id, "name": "Bash", "input": {"command": command}}]},
    })


class MessagesToStoreTests(unittest.TestCase):
    def test_parallel_calls_of_one_tool_in_one_second_are_all_kept(self):
        text = "\n".join([_bash("git status", 5, "a"), _bash("git log", 5, "b"), _bash("git diff", 5, "c")])
        msgs = messages_to_store(text, "claude_code")
        self.assertEqual([m.metadata.get("tool_input") for m in msgs], ["git status", "git log", "git diff"])
        self.assertEqual(len({m.key for m in msgs}), 3)

    def test_a_line_there_twice_counts_once(self):
        a, b = _user("第一条", 1), _bash("ls", 2, "x")
        msgs = messages_to_store("\n".join([a, b, a, b]), "claude_code")
        self.assertEqual([m.content for m in msgs], ["第一条", "[Bash]"])

    def test_loose_key_is_role_and_second(self):
        m = _msg("tool", "[Bash]", 7, "ls")
        self.assertEqual(m.loose, f"tool:{int((T0 + timedelta(seconds=7)).timestamp())}")
        self.assertIsNone(StoredMessage("user", "user", "x", {}, None, "k").loose)


class PlanAlignmentTests(unittest.TestCase):
    def setUp(self):
        self.a, self.b, self.c = _msg("user", "一", 1), _msg("assistant", "二", 2), _msg("user", "三", 3)

    def test_nothing_to_do_when_rows_match(self):
        stored = [_row(10, 1, self.a), _row(11, 2, self.b)]
        plan = plan_alignment(stored, [self.a, self.b])
        self.assertFalse(plan.changes)
        self.assertEqual(plan.unchanged, 2)

    def test_rows_keep_their_ids_and_only_the_missing_one_is_inserted(self):
        stored = [_row(10, 1, self.a), _row(11, 2, self.c)]
        plan = plan_alignment(stored, [self.a, self.b, self.c])
        self.assertEqual(plan.move, [(11, 3)])
        self.assertEqual([(line, m.content) for line, m in plan.insert], [(2, "二")])
        self.assertEqual(plan.delete, [])

    def test_delete_drops_copies_and_rows_the_text_doesnt_hold(self):
        old = _msg("user", "旧解析器的", 9)
        stored = [_row(10, 1, self.a), _row(11, 2, self.a), _row(12, 3, old)]
        plan = plan_alignment(stored, [self.a])
        self.assertEqual(sorted(plan.delete), [11, 12])
        self.assertEqual((plan.duplicates, plan.unknown), (1, 1))

    def test_park_sets_aside_what_the_first_slice_doesnt_take(self):
        stored = [_row(10, 1, self.a), _row(11, 2, self.b), _row(12, 3, self.c)]
        plan = plan_alignment(stored, [self.a], 1, "park")
        self.assertEqual(plan.move, [(11, PARKED), (12, PARKED + 1)])
        self.assertEqual(plan.parked, 2)
        self.assertEqual(plan.delete, [])

    def test_keep_leaves_parked_rows_for_the_next_slice(self):
        parked = [_row(11, PARKED, self.b), _row(12, PARKED + 1, self.c)]
        plan = plan_alignment(parked, [self.b], 2, "keep")
        self.assertEqual(plan.move, [(11, 2)])
        self.assertEqual((plan.parked, plan.delete), (1, []))

    def test_interleave_keeps_unknown_rows_where_they_stood(self):
        old = _msg("system", "旧格式的摘要", 50)
        stored = [_row(10, 1, self.a), _row(11, 2, old), _row(12, 3, self.c)]
        plan = plan_alignment(stored, [self.a, self.b, self.c], 1, "interleave")
        # a, old (after a, where it stood), b inserted, c
        self.assertEqual([(line, m.content) for line, m in plan.insert], [(3, "二")])
        self.assertEqual(plan.move, [(12, 4)])
        self.assertEqual((plan.unknown, plan.delete), (1, []))

    def test_interleave_deletes_copies_and_leftover_parked_rows(self):
        stale = _msg("user", "停车场里没人认领的", 60)
        stored = [_row(10, 1, self.a), _row(11, 2, self.a), _row(12, 3, self.b), _row(13, PARKED, stale)]
        plan = plan_alignment(stored, [self.a, self.b], 1, "interleave")
        self.assertEqual(sorted(plan.delete), [11, 13])
        self.assertEqual((plan.duplicates, plan.parked, plan.unknown), (1, 1, 0))
        self.assertEqual(plan.move, [(12, 2)])

    def test_interleave_a_row_an_older_parser_stored_stands_for_its_message(self):
        # Stored as "[Bash]" without its input, before tool inputs were kept: same role and second
        call = _msg("tool", "[Bash]", 4, "git status")
        older = (20, 2, row_key("tool", call.timestamp, "[Bash]", ""), call.loose)
        plan = plan_alignment([_row(10, 1, self.a), older], [self.a, call], 1, "interleave")
        self.assertFalse(plan.changes)
        self.assertEqual((plan.stand_ins, plan.unknown), (1, 0))

    def test_interleave_counts_copies_only_the_file_can_judge(self):
        # 10-30: a 2 GB log whose stored text kept 7.6M characters, 45,908 rows outside it copies of others
        lost = _msg("assistant", "文本里丢掉的中间段", 40)
        stored = [_row(10, 1, self.a), _row(11, 2, lost), _row(12, 3, lost), _row(13, 4, lost), _row(14, 5, self.a)]
        plan = plan_alignment(stored, [self.a], 1, "interleave")
        self.assertEqual(plan.delete, [14])  # a copy of what the text holds goes
        self.assertEqual((plan.duplicates, plan.unknown, plan.unvouched), (1, 3, 2))
        # the text holding a message twice vouches for both rows
        twice = plan_alignment([_row(10, 1, self.a), _row(11, 2, self.a)], [self.a, self.a], 1, "interleave")
        self.assertEqual((twice.changes, twice.unvouched), (False, 0))

    def test_interleave_inserts_what_no_row_holds(self):
        x, y = _msg("tool", "[Bash]", 5, "git log"), _msg("tool", "[Bash]", 5, "git diff")
        stored = [_row(10, 1, self.a), _row(11, 2, x)]
        plan = plan_alignment(stored, [self.a, x, y], 1, "interleave")
        self.assertEqual([(line, m.metadata["tool_input"]) for line, m in plan.insert], [(3, "git diff")])
        self.assertEqual(plan.stand_ins, 0)


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class MessageStoreDatabaseTests(unittest.IsolatedAsyncioTestCase):
    REL = "projects/-w-app/s.jsonl"

    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import Base, Machine, Tool, User

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.Session() as db:
            user = User(email="owner@example.com", role="owner", status="active")
            db.add_all([user, Tool(id="claude_code", display_name="Claude Code")])
            await db.flush()
            machine = Machine(name="mac (Darwin)", collector_token_hash="dev-mac", user_id=user.id)
            db.add(machine)
            await db.commit()
            self.user_id, self.machine_id = str(user.id), str(machine.id)
        self.post = patch("server.services.ingest_service._run_post_ingest", AsyncMock())
        self.post.start()

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        self.post.stop()
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def _store(self, content: str, mode: str, offset: int, end: int | None, size: int) -> None:
        from server.services.ingest_service import ingest_file

        async with self.Session() as db:
            await ingest_file(
                db, "claude_code", "conversation", "jsonl", self.REL, content, f"h{offset}-{end}-{len(content)}", size,
                mode, offset, {"session_id": "s"}, machine_id=self.machine_id, user_id=self.user_id, end_offset=end,
            )
            await db.commit()

    async def _rows(self) -> list[tuple]:
        from sqlalchemy import text

        async with self.Session() as db:
            return [tuple(r) for r in (await db.execute(text(
                "SELECT m.id, m.line_number, m.content, m.metadata->>'tool_input' FROM conversation_messages m "
                "JOIN documents d ON d.id = m.document_id WHERE d.relative_path = :p ORDER BY m.line_number"
            ), {"p": self.REL})).all()]

    async def _doc_id(self):
        from sqlalchemy import text

        async with self.Session() as db:
            return await db.scalar(text("SELECT id FROM documents WHERE relative_path = :p"), {"p": self.REL})

    async def test_row_keys_in_the_database_match_the_parser(self):
        from sqlalchemy import text

        from server.services.message_store import LOOSE_KEY_SQL, ROW_KEY_SQL

        lines = [_user("你好", 1), _bash("git status", 2, "a"), _bash("git log", 2, "b")]
        content = "\n".join(lines)
        await self._store(content, "full", 0, len(content.encode()), len(content.encode()))
        expected = messages_to_store(content, "claude_code")
        async with self.Session() as db:
            got = (await db.execute(text(
                f"SELECT {ROW_KEY_SQL}, {LOOSE_KEY_SQL} FROM conversation_messages ORDER BY line_number"
            ))).all()
        self.assertEqual([tuple(r) for r in got], [(m.key, m.loose) for m in expected])

    async def test_a_full_upload_in_slices_keeps_the_ids(self):
        lines = [_user(f"消息{i}", i) for i in range(6)]
        content = "\n".join(lines) + "\n"
        size = len(content.encode())
        await self._store(content.rstrip("\n"), "full", 0, size, size)
        before = await self._rows()
        self.assertEqual([r[2] for r in before], [f"消息{i}" for i in range(6)])

        # The collector sends it again from the start, in two slices: the first can't tell what the rest holds
        first = "\n".join(lines[:3]) + "\n"
        await self._store(first.rstrip("\n"), "full", 0, len(first.encode()), size)
        mid = await self._rows()
        self.assertEqual([r[1] for r in mid][-3:], [PARKED, PARKED + 1, PARKED + 2])
        rest = "\n".join(lines[3:]) + "\n"
        await self._store(rest.rstrip("\n"), "delta", len(first.encode()), size, size)
        after = await self._rows()
        self.assertEqual(after, before)  # same rows, same ids, same lines

    async def test_a_retried_slice_is_stored_once_and_a_gap_says_where_to_start(self):
        from server.services.ingest_service import OffsetMismatch, claim_slice

        a, b = _user("一", 1) + "\n", _user("二", 2) + "\n"
        size_a, size_ab = len(a.encode()), len((a + b).encode())
        await self._store(a.rstrip("\n"), "full", 0, size_a, size_a)
        await self._store(b.rstrip("\n"), "delta", size_a, size_ab, size_ab)
        async with self.Session() as db:
            # The same slice again (its first upload went in, the answer was lost): stored already
            claimed = await claim_slice(db, "claude_code", self.REL, self.machine_id, "delta", size_a, size_ab)
            self.assertEqual(claimed, (await self._doc_id(), size_ab))
            # A slice past the end of the copy: from where it ends
            with self.assertRaises(OffsetMismatch) as e:
                await claim_slice(db, "claude_code", self.REL, self.machine_id, "delta", size_ab + 10, size_ab + 20)
            self.assertEqual(e.exception.expected, size_ab)
            # The next one fits
            self.assertIsNone(await claim_slice(db, "claude_code", self.REL, self.machine_id, "delta", size_ab, size_ab + 5))
            await db.rollback()
        self.assertEqual([r[2] for r in await self._rows()], ["一", "二"])

    async def test_the_audit_observes_then_repairs_and_keeps_what_it_deleted(self):
        from sqlalchemy import text

        from server.services import message_audit

        lines = [_user("一", 1), _bash("git status", 2, "a"), _bash("git log", 2, "b"), _user("二", 3)]
        content = "\n".join(lines)
        size = len(content.encode())
        await self._store(content, "full", 0, size, size)
        doc_id = await self._doc_id()
        rows = await self._rows()
        async with self.Session() as db:
            # What the old ingestion left: the second call dropped, the last message there twice
            await db.execute(text("DELETE FROM conversation_messages WHERE id = :i"), {"i": rows[2][0]})
            await db.execute(text(
                "INSERT INTO conversation_messages (document_id, line_number, message_type, role, content, metadata, \"timestamp\") "
                "SELECT document_id, 9, message_type, role, content, metadata, \"timestamp\" FROM conversation_messages WHERE id = :i"
            ), {"i": rows[3][0]})
            await db.execute(text("UPDATE documents SET synced_at = now() - interval '1 hour' WHERE id = :d"), {"d": doc_id})
            await db.commit()

        async with self.Session() as db:
            found = await message_audit.audit_document(db, doc_id, repair=False)
            await db.commit()
        self.assertEqual((found["outcome"], found["missing"], found["duplicates"]), ("needs_repair", 1, 1))
        self.assertEqual(len(await self._rows()), 4)  # observe changes nothing

        async with self.Session() as db:
            found = await message_audit.audit_document(db, doc_id, repair=True)
            await db.commit()
        self.assertEqual(found["outcome"], "repaired")
        after = await self._rows()
        self.assertEqual([(r[1], r[2], r[3]) for r in after], [
            (1, "一", None), (2, "[Bash]", "git status"), (3, "[Bash]", "git log"), (4, "二", None),
        ])
        self.assertEqual([after[i][0] for i in (0, 1, 3)], [rows[0][0], rows[1][0], rows[3][0]])  # ids kept
        async with self.Session() as db:
            removed = (await db.execute(text("SELECT content, reason FROM conversation_messages_removed"))).all()
            outcome = await db.scalar(text("SELECT outcome FROM message_audit WHERE document_id = :d"), {"d": doc_id})
        self.assertEqual([tuple(r) for r in removed], [("二", "audit")])
        self.assertEqual(outcome, "repaired")

        async with self.Session() as db:
            again = await message_audit.audit_document(db, doc_id, repair=True)
            await db.commit()
        self.assertEqual(again["outcome"], "ok")

    async def test_audit_due_picks_quiet_conversations_once(self):
        from sqlalchemy import text

        from server.services import message_audit

        content = _user("一", 1)
        size = len(content.encode())
        await self._store(content, "full", 0, size, size)
        async with self.Session() as db:
            await db.execute(text("UPDATE documents SET synced_at = now() - interval '1 hour'"))
            await db.commit()
        first = await message_audit.audit_due(self.Session, self.engine, "observe")
        self.assertEqual(first.get("ok"), 1)
        second = await message_audit.audit_due(self.Session, self.engine, "observe")
        self.assertNotIn("ok", second)  # unchanged since: not checked again
        self.assertEqual(await message_audit.audit_due(self.Session, self.engine, "off"), {"mode": "off"})

    async def test_a_cut_log_is_asked_for_again_once_its_device_can_send_it(self):
        import uuid

        import fakeredis
        from sqlalchemy import text

        from server.db.models import Machine
        from server.services import device_commands, message_audit

        cut = "{\"type\": \"user\", \"message\": {\"content\": \"x\n...[TRUNCATED: line exceeded 128KB limit]...\n\"}}\n"
        content = _user("一", 1) + cut
        size = len(content.encode())
        await self._store(content, "full", 0, size, size)
        async with self.Session() as db:
            await db.execute(text("UPDATE documents SET synced_at = now() - interval '1 hour'"))
            await db.commit()
        redis = fakeredis.FakeAsyncRedis(server=fakeredis.FakeServer(), decode_responses=True)

        # observing: found, nobody asked
        await message_audit.audit_due(self.Session, self.engine, "observe", redis=redis)
        self.assertEqual(await device_commands.pending(redis, "dev-mac"), [])
        # a collector before v1.0.95 would drop the command: not asked yet
        first = await message_audit.audit_due(self.Session, self.engine, "repair", redis=redis)
        self.assertNotIn("resync_requested", first)
        self.assertEqual(await device_commands.pending(redis, "dev-mac"), [])

        async with self.Session() as db:
            machine = await db.get(Machine, uuid.UUID(self.machine_id))
            machine.collect_status = {"queued": 0, "reported_at": "2026-10-30T00:00:00+00:00"}
            await db.commit()
        second = await message_audit.audit_due(self.Session, self.engine, "repair", redis=redis)
        self.assertEqual(second.get("resync_requested"), 1)
        [cmd] = await device_commands.pending(redis, "dev-mac")
        self.assertEqual(cmd["action"], "resync_files")
        self.assertEqual(cmd["payload"]["files"], [{"tool": "claude_code", "relative_path": self.REL}])
        # once only
        third = await message_audit.audit_due(self.Session, self.engine, "repair", redis=redis)
        self.assertNotIn("resync_requested", third)
        self.assertEqual(len(await device_commands.pending(redis, "dev-mac")), 1)

    async def test_copies_outside_the_text_ask_for_the_file_and_an_older_check_is_done_again(self):
        import uuid

        import fakeredis
        from sqlalchemy import text

        from server.db.models import Machine
        from server.services import device_commands, message_audit

        content = _user("一", 1)
        size = len(content.encode())
        await self._store(content, "full", 0, size, size)
        doc_id = await self._doc_id()
        async with self.Session() as db:
            # Two rows of a message the stored text no longer holds, right after it
            for line in (2, 3):
                await db.execute(text(
                    "INSERT INTO conversation_messages (document_id, line_number, message_type, role, content, metadata, \"timestamp\") "
                    "VALUES (:d, :l, 'message', 'assistant', '中间丢的', '{}', :t)"
                ), {"d": doc_id, "l": line, "t": T0})
            await db.execute(text("UPDATE documents SET synced_at = now() - interval '1 hour'"))
            # Repaired by the check before it looked for these, the text unchanged since
            await db.execute(text(
                "INSERT INTO message_audit (document_id, content_hash, checked_at, outcome, expected, stored, missing, duplicates, unknown, detail) "
                "SELECT id, content_hash, '2026-10-29T17:48:00+00:00', 'repaired', 1, 1, 0, 0, 0, '{}' FROM documents"
            ))
            machine = await db.get(Machine, uuid.UUID(self.machine_id))
            machine.collect_status = {"queued": 0, "reported_at": "2026-10-30T00:00:00+00:00"}
            await db.commit()
        redis = fakeredis.FakeAsyncRedis(server=fakeredis.FakeServer(), decode_responses=True)

        first = await message_audit.audit_due(self.Session, self.engine, "repair", redis=redis)
        self.assertEqual((first.get("ok"), first.get("resync_requested")), (1, 1))
        self.assertEqual(len(await self._rows()), 3)  # kept: only the file can tell
        [cmd] = await device_commands.pending(redis, "dev-mac")
        self.assertEqual(cmd["payload"]["files"], [{"tool": "claude_code", "relative_path": self.REL}])
        async with self.Session() as db:
            detail = await db.scalar(text("SELECT detail FROM message_audit WHERE document_id = :d"), {"d": doc_id})
        self.assertEqual((detail["v"], detail["unvouched"]), (message_audit.AUDIT_VERSION, 1))
        self.assertTrue(detail["repaired_at"].startswith("2026-10-29T17:48"))
        self.assertIn("resync_requested_at", detail)

        second = await message_audit.audit_due(self.Session, self.engine, "repair", redis=redis)
        self.assertNotIn("ok", second)  # checked by this version: not again
        self.assertEqual(len(await device_commands.pending(redis, "dev-mac")), 1)

    async def test_reconcile_lists_logs_whose_copy_ends_elsewhere(self):
        import types
        import uuid

        from server.api import ingest
        from server.db.models import User

        content = _user("一", 1)
        size = len(content.encode())
        await self._store(content, "full", 0, size, size)
        async with self.Session() as db:
            user = await db.get(User, uuid.UUID(self.user_id))
            machine = types.SimpleNamespace(id=uuid.UUID(self.machine_id))
            with patch.object(ingest, "ensure_device", AsyncMock(return_value=machine)):
                out = await ingest.reconcile_offsets(
                    ingest.ReconcileRequest(files=[
                        ingest.ReconcileFile(tool="claude_code", relative_path=self.REL, offset=0),
                        ingest.ReconcileFile(tool="claude_code", relative_path="projects/-w-app/new.jsonl", offset=0),
                    ]),
                    _collector_user=user, _throttle=None, db=db,
                    x_device_id="d", x_device_name="n", x_device_platform="darwin",
                )
        self.assertEqual(out["files"], [{"tool": "claude_code", "relative_path": self.REL, "expected_offset": size}])


if __name__ == "__main__":
    unittest.main()
