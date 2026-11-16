"""A conversation continuing an agent session, kept in step with the session (issue #20).

The pure tests need nothing. The database test runs against a real PostgreSQL when
MEMENTO_TEST_DATABASE_URL points at a throwaway database (it creates and drops the schema).
"""

from __future__ import annotations

import os
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.session_timeline import (  # noqa: E402
    ORIGIN,
    Msg,
    drop_copies_of_run,
    merge_session,
    messages_to_turns,
    read_from,
    tool_detail,
)

DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")
SID = "caadc70f-fa92-493a-8182-05f0d0abc2cb"
T0 = datetime(2026, 11, 16, 0, 0, tzinfo=timezone.utc)


def at(minutes: float) -> datetime:
    return T0 + timedelta(minutes=minutes)


def iso(minutes: float) -> str:
    return at(minutes).isoformat()


def memento_run(question: str, asked: float, answered: float, answer: str = "答") -> list[dict]:
    """A run of Memento's as append_conversation_turns saves it."""
    return [
        {"role": "user", "content": question, "created_at": iso(asked)},
        {"role": "assistant", "content": answer, "created_at": iso(answered), "started_at": iso(asked), "execution_mode": "antigravity"},
    ]


def session(*exchanges: tuple[str, float, str], start_line: int = 0) -> list[Msg]:
    """A session's messages: each exchange a question, a tool call with its output, and the answer."""
    msgs: list[Msg] = []
    line = start_line
    for question, when, answer in exchanges:
        msgs += [
            Msg(line, "user", question, at(when)),
            Msg(line + 1, "assistant", "", at(when + 0.1), meta={"tool_name": "run_command", "tool_input": "{'CommandLine': '\"ls\"'}"}),
            Msg(line + 2, "tool", "Created At: x\nCommand exited with code 0.\nCommand output:\nfile.txt", at(when + 0.2)),
            Msg(line + 3, "assistant", answer, at(when + 0.5)),
        ]
        line += 4
    return msgs


class TurnsTests(unittest.TestCase):
    def test_what_claude_code_wrote_under_the_user_role_is_not_a_question(self) -> None:
        # Collected before the parser dropped them: /compact's summary and its echo, outside any run
        msgs = [
            Msg(0, "user", "This session is being continued from a previous conversation that ran out of context.", at(0)),
            Msg(1, "user", "<local-command-stdout>Compacted </local-command-stdout>", at(0.1)),
            *session(("在终端里问的", 5, "答了"), start_line=2),
        ]
        turns, _, changed = merge_session([], None, msgs, SID, "claude_code")
        self.assertTrue(changed)
        self.assertEqual([t["content"] for t in turns if t["role"] == "user"], ["在终端里问的"])

    def test_tool_calls_and_their_output_go_on_the_assistant_turn(self) -> None:
        turns = messages_to_turns(session(("看看目录", 0, "有一个文件")))
        self.assertEqual([t["role"] for t in turns], ["user", "assistant", "assistant"])
        call = turns[1]["toolCalls"][0]
        self.assertEqual(call["args"], {"command": "ls"})
        self.assertEqual(call["result"]["stdout"], "file.txt")
        self.assertEqual(call["result"]["exit_code"], 0)
        self.assertEqual(turns[2]["content"], "有一个文件")

    def test_an_answer_in_the_app_shows_as_one_answer_with_its_commands_as_steps_like_memento_s(self) -> None:
        # Antigravity writes an answer as many messages: a note, a command and its output, another
        # command, the conclusion. Each used to become a turn of its own (a card per command line).
        msgs = [
            Msg(0, "user", "看看集群", at(0)),
            Msg(1, "assistant", "先看节点。", at(0.1)),
            Msg(2, "assistant", "", at(0.2), meta={"tool_name": "run_command", "tool_input": "{'CommandLine': '\"kubectl get nodes\"'}"}),
            Msg(3, "tool", "Command exited with code 0.\nCommand output:\nnode1 Ready", at(0.3)),
            Msg(4, "assistant", "", at(0.4), meta={"tool_name": "run_command", "tool_input": "{'CommandLine': '\"kubectl get pods\"'}"}),
            Msg(5, "tool", "Command exited with code 1.\nCommand output:\nerror", at(0.5)),
            Msg(6, "assistant", "节点正常，有一个 pod 异常。", at(0.9), meta={"thinking": "想一想"}),
        ]
        out, _, changed = merge_session([], None, msgs, SID, "antigravity")
        self.assertTrue(changed)
        self.assertEqual([t["role"] for t in out], ["user", "assistant"])
        answer = out[1]
        self.assertEqual(answer["content"], "先看节点。\n\n节点正常，有一个 pod 异常。")
        self.assertEqual(answer["thinking"], "想一想")
        self.assertEqual((answer[ORIGIN], answer["execution_mode"], answer["started_at"]), ("antigravity", "antigravity", iso(0)))
        [card] = answer["toolCalls"]
        self.assertEqual((card["name"], card["action"], card["binary"], card["args"]["prompt"]), ("run_on_device", "agent", "agy", "看看集群"))
        self.assertEqual(card["result"]["status"], "succeeded")
        steps = card["result"]["events"]
        self.assertEqual([(e["kind"], e["detail"], e["status"]) for e in steps], [
            ("tool", "kubectl get nodes", "done"), ("tool", "kubectl get pods", "failed"),
        ])
        self.assertEqual(steps[0]["output"], "node1 Ready")
        # Read again with nothing new: the same turns, not merged twice
        again, _, changed2 = merge_session(out, None, msgs, SID, "antigravity")
        self.assertFalse(changed2)
        self.assertEqual(again, out)

    def test_antigravity_and_json_tool_inputs_name_what_they_work_on(self) -> None:
        self.assertEqual(tool_detail("{'CommandLine': '\"git status\"', 'Cwd': '\"/x\"'}"), "git status")
        self.assertEqual(tool_detail('{"file_path": "/a/b.py"}'), "/a/b.py")


class MergeTests(unittest.TestCase):
    def test_exchanges_in_the_app_go_in_between_mementos_runs_by_time(self) -> None:
        # Memento asked at 0 and 30; the app asked at 10 and 40 (the case of #20)
        turns = memento_run("第一问", 0, 1) + memento_run("第三问", 30, 31)
        msgs = session(("第一问", 0.05, "答一"), ("第二问", 10, "答二"), ("第三问", 30.05, "答三"), ("第四问", 40, "答四"))
        out, state, changed = merge_session(turns, None, msgs, SID, "antigravity")
        self.assertTrue(changed)
        users = [(t["content"], t.get(ORIGIN)) for t in out if t["role"] == "user"]
        self.assertEqual(users, [("第一问", None), ("第二问", "antigravity"), ("第三问", None), ("第四问", "antigravity")])
        # Memento's own runs are not copied again
        self.assertEqual(sum(1 for t in out if t["role"] == "user"), 4)
        merged = [t for t in out if t.get(ORIGIN) == "antigravity" and t["role"] == "assistant"]
        self.assertTrue(all(t["execution_mode"] == "antigravity" for t in merged))
        self.assertEqual(state["line"], msgs[-1].line)
        self.assertEqual(state["open"], 12)  # the latest exchange is the app's: read again from its question

    def test_a_device_clock_a_few_minutes_off_still_knows_memento_s_question(self) -> None:
        turns = memento_run("部署一下", 0, 1)
        out, _, changed = merge_session(turns, None, session(("部署一下", 4, "好了")), SID, "antigravity")
        self.assertFalse(changed)
        self.assertEqual(out, turns)

    def test_turns_copied_from_the_session_before_are_not_copied_again(self) -> None:
        # Made from the session document once (the old fallback): no origin, the messages' own times
        copied = messages_to_turns(session(("早先的问题", -60, "早先的回答")))
        out, _, changed = merge_session(copied, None, session(("早先的问题", -60, "早先的回答")), SID, "antigravity")
        self.assertFalse(changed)
        self.assertEqual(out, copied)

    def test_an_exchange_still_being_written_is_rebuilt_not_repeated(self) -> None:
        turns = memento_run("第一问", 0, 1)
        first = session(("第一问", 0.05, "答一"), ("第二问", 10, "答二"))
        out, state, _ = merge_session(turns, None, first[:6], SID, "antigravity")  # the answer not yet in
        self.assertEqual(read_from(state, SID), 4)
        out2, state2, changed = merge_session(out, state, [m for m in first if m.line >= 4], SID, "antigravity")
        self.assertTrue(changed)
        self.assertEqual([t["content"] for t in out2 if t["role"] == "user"], ["第一问", "第二问"])
        self.assertEqual(out2[-1]["content"], "答二")
        # Read again with nothing new: nothing changes
        _, _, again = merge_session(out2, state2, [m for m in first if m.line >= 4], SID, "antigravity")
        self.assertFalse(again)

    def test_the_rest_of_memento_s_exchange_is_not_taken_for_the_app_s(self) -> None:
        turns = memento_run("第一问", 0, 1)
        msgs = session(("第一问", 0.05, "答一"))
        _, state, _ = merge_session(turns, None, msgs[:2], SID, "antigravity")
        self.assertIsNone(state.get("open"))
        out, _, changed = merge_session(turns, state, msgs[2:], SID, "antigravity")
        self.assertFalse(changed)
        self.assertEqual(out, turns)

    def test_another_session_starts_over(self) -> None:
        state = {"sid": "old", "line": 99}
        self.assertIsNone(read_from(state, SID))
        _, new_state, _ = merge_session([], state, session(("问", 0, "答")), SID, "antigravity")
        self.assertEqual(new_state["sid"], SID)

    def test_a_run_saved_after_its_copy_was_merged_replaces_the_copy(self) -> None:
        merged, _, _ = merge_session([], None, session(("修一下", 5, "修好了")), SID, "antigravity")
        self.assertEqual(len(drop_copies_of_run(merged, "修一下", iso(5), iso(6))), 0)
        # Another question, or the same one long after, stays
        self.assertEqual(drop_copies_of_run(merged, "别的", iso(5), iso(6)), merged)
        self.assertEqual(drop_copies_of_run(merged, "修一下", iso(120), iso(121)), merged)


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class SyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import AskConversation, Base, ConversationMessage, Document, Machine, Tool, User

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.Session() as db:
            user = User(email="owner@example.com", role="owner", status="active")
            db.add_all([user, Tool(id="antigravity", display_name="Antigravity")])
            await db.flush()
            machine = Machine(name="tom-pc", collector_token_hash="dev-pc", user_id=user.id)
            db.add(machine)
            await db.flush()
            doc = Document(
                tool_id="antigravity", machine_id=machine.id, relative_path=f"antigravity/brain/{SID}/transcript.jsonl",
                category="conversation", content_type="jsonl", title="t", content="", content_hash="h",
                file_size_bytes=0, metadata_={"session_id": SID},
            )
            db.add(doc)
            await db.flush()
            for m in session(("第一问", 0.05, "答一"), ("第二问", 10, "答二")):
                db.add(ConversationMessage(document_id=doc.id, line_number=m.line, role=m.role, message_type=m.role,
                                           content=m.content, timestamp=m.ts, metadata_=m.meta))
            conv = AskConversation(
                id=uuid.uuid4(), user_id=user.id, title="t", turns=memento_run("第一问", 0, 1), message_count=2,
                config={"execution_mode": "antigravity", "session_id": SID},
            )
            db.add(conv)
            await db.commit()
            self.user_id, self.doc_id, self.conv_id = user.id, doc.id, conv.id
        self.factory = patch("server.db.session.async_session_factory", self.Session)
        self.factory.start()
        self.runs = patch("server.services.ask_runs.ask_runs.get", AsyncMock(return_value=None))
        self.runs.start()

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        self.factory.stop()
        self.runs.stop()
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def turns(self) -> list[dict]:
        from server.db.models import AskConversation

        async with self.Session() as db:
            return list((await db.get(AskConversation, self.conv_id)).turns)

    async def test_the_app_s_exchange_comes_in_once_and_not_while_a_run_goes(self) -> None:
        from server.services.session_timeline import sync_conversation

        running = AsyncMock(return_value=type("Run", (), {"done": False})())
        with patch("server.services.ask_runs.ask_runs.get", running):
            self.assertFalse(await sync_conversation(self.conv_id))
        self.assertTrue(await sync_conversation(self.conv_id, user_id=self.user_id))
        turns = await self.turns()
        self.assertEqual([t["content"] for t in turns if t["role"] == "user"], ["第一问", "第二问"])
        self.assertEqual(turns[2][ORIGIN], "antigravity")
        # Nothing new: nothing written
        self.assertFalse(await sync_conversation(self.conv_id))
        # Not the user's: left alone
        self.assertFalse(await sync_conversation(self.conv_id, user_id=uuid.uuid4()))
