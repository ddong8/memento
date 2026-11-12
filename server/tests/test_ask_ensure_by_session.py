"""POST /api/ask/conversations/ensure-by-session reuses the conversation a session continues in.

It always made a new one, so a session whose conversation had let go of it (the resume banner's 「退出」
clears session_id) got another empty conversation of the same title on every pick (issue #17)."""
from __future__ import annotations

import asyncio
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from server.api import ask_conversations
from server.db.models import User


def _user():
    user = MagicMock(spec=User)
    user.id = uuid.uuid4()
    return user


def _lock_db():
    db = AsyncMock()
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=db)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm, db


def _detail_db(conv_id):
    conv = MagicMock()
    conv.id = conv_id
    conv.title = "t"
    conv.turns = []
    conv.device_id = None
    conv.cwd = None
    conv.created_at = conv.updated_at = datetime(2026, 11, 12, tzinfo=timezone.utc)
    db = AsyncMock()
    res = MagicMock()
    res.scalars.return_value.first.return_value = conv
    db.execute.return_value = res
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=db)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


async def _ensure(existing):
    conv_id = existing or uuid.uuid4()
    lock_cm, lock_db = _lock_db()
    goc = AsyncMock(return_value=(conv_id, "t", {}))
    find = AsyncMock(return_value=existing)
    body = ask_conversations.EnsureConversationBySessionRequest(session_id="sess-1", execution_mode="claude")
    with patch.object(ask_conversations, "async_session_factory", side_effect=[lock_cm, _detail_db(conv_id)]), \
         patch.object(ask_conversations, "_find_session_conversation", find), \
         patch.object(ask_conversations, "get_or_create_conversation", goc), \
         patch.object(ask_conversations, "infer_conversation_config", return_value=({}, {})), \
         patch.object(ask_conversations, "resolve_concrete_device_for_conv", AsyncMock(return_value=None)), \
         patch.object(ask_conversations, "lookup_project_title", AsyncMock(return_value="")), \
         patch.object(ask_conversations, "sanitize_turns_for_response", side_effect=lambda t, **_: t):
        out = await ask_conversations.ensure_conversation_by_session(body=body, _user=_user())
    return out, goc, lock_db


class TestEnsureBySession(unittest.TestCase):
    def test_reuses_the_conversation_found_for_the_session(self):
        existing = uuid.uuid4()
        out, goc, lock_db = asyncio.run(_ensure(existing))
        self.assertEqual(goc.await_args.kwargs["conv_id_str"], str(existing))
        self.assertEqual(out["id"], str(existing))
        lock_db.commit.assert_awaited()

    def test_makes_one_remembering_the_session_when_none_is_found(self):
        _out, goc, _lock_db = asyncio.run(_ensure(None))
        kwargs = goc.await_args.kwargs
        self.assertIsNone(kwargs["conv_id_str"])
        self.assertEqual(kwargs["config"]["session_id"], "sess-1")
        self.assertEqual(kwargs["config"]["origin_session_id"], "sess-1")

    def test_looks_up_and_creates_under_a_lock_per_user_and_session(self):
        _out, _goc, lock_db = asyncio.run(_ensure(None))
        sql = str(lock_db.execute.await_args_list[0].args[0])
        self.assertIn("pg_advisory_xact_lock", sql)
        self.assertIn(":sess-1", lock_db.execute.await_args_list[0].args[1]["k"])


class TestFindSessionConversation(unittest.TestCase):
    def _run(self, first, second):
        db = AsyncMock()
        r1, r2 = MagicMock(), MagicMock()
        r1.scalar_one_or_none.return_value = first
        r2.scalar_one_or_none.return_value = second
        db.execute.side_effect = [r1, r2]
        out = asyncio.run(ask_conversations._find_session_conversation(db, _user(), "sess-1"))
        return out, db

    def test_bound_conversation_first(self):
        bound = uuid.uuid4()
        out, db = self._run(bound, uuid.uuid4())
        self.assertEqual(out, bound)
        self.assertEqual(db.execute.await_count, 1)

    def test_empty_conversation_that_let_go_of_it_next(self):
        empty = uuid.uuid4()
        out, db = self._run(None, empty)
        self.assertEqual(out, empty)
        sql = str(db.execute.await_args_list[1].args[0].compile())
        self.assertIn("jsonb_array_length", sql)


if __name__ == "__main__":
    unittest.main()
