"""GET /api/ask/conversations/{id} when the stored row needs a write-back first.

The branch that commits an updated message_count / config left created_at_iso unset and
answered 500 (UnboundLocalError) on production; it must return the conversation."""
from __future__ import annotations

import asyncio
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from server.api import ask_conversations
from server.db.models import AskConversation, User


def _conv(message_count: int):
    conv = MagicMock(spec=AskConversation)
    conv.id = uuid.uuid4()
    conv.title = "t"
    conv.turns = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    conv.message_count = message_count
    conv.created_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    conv.updated_at = datetime(2026, 10, 2, tzinfo=timezone.utc)
    conv.config = {}
    conv.device_id = None
    conv.cwd = None
    return conv


async def _get(conv, commit_side_effect=None, limit=0):
    db = AsyncMock()
    res = MagicMock()
    res.scalars.return_value.first.return_value = conv
    res.scalar.return_value = conv.turns  # the page sliced in SQL
    db.execute.return_value = res
    if commit_side_effect is not None:
        db.commit.side_effect = commit_side_effect
    request = MagicMock()
    request.headers.get.return_value = ""
    response = MagicMock()
    response.headers = {}
    user = MagicMock(spec=User)
    user.id = uuid.uuid4()
    with patch.object(ask_conversations, "infer_conversation_config", return_value=({}, {})), \
         patch.object(ask_conversations, "recover_orphaned_tasks_for_conv", AsyncMock(return_value=None)), \
         patch.object(ask_conversations, "resolve_concrete_device_for_conv", AsyncMock(return_value=None)), \
         patch.object(ask_conversations, "lookup_project_title", AsyncMock(return_value="")), \
         patch.object(ask_conversations, "sanitize_turns_for_response", side_effect=lambda t, **_: t):
        out = await ask_conversations.get_conversation(
            conv_id=str(conv.id), request=request, response=response, limit=limit, db=db, _user=user,
        )
    return out, response, db


class TestConversationDetailWriteBack(unittest.TestCase):
    def test_stale_count_from_a_page_is_written_back(self):
        conv = _conv(message_count=0)
        out, _response, db = asyncio.run(_get(conv, limit=40))
        db.commit.assert_awaited()  # the page is shorter than the limit: it is the whole conversation
        self.assertEqual(out["total_turns"], 2)
        self.assertEqual(conv.message_count, 2)

    def test_write_back_branch_returns_conversation(self):
        conv = _conv(message_count=0)  # stale count -> need_commit
        out, response, db = asyncio.run(_get(conv))
        db.commit.assert_awaited()
        self.assertEqual(out["total_turns"], 2)
        self.assertEqual(out["created_at"], "2026-10-01T00:00:00+00:00")
        self.assertNotEqual(out["updated_at"], "2026-10-02T00:00:00+00:00")
        self.assertIn("ETag", response.headers)

    def test_failed_write_back_still_answers(self):
        conv = _conv(message_count=0)
        out, response, _db = asyncio.run(_get(conv, commit_side_effect=RuntimeError("db down")))
        self.assertEqual(out["updated_at"], "2026-10-02T00:00:00+00:00")
        self.assertIn("ETag", response.headers)

    def test_no_write_back(self):
        conv = _conv(message_count=2)
        out, response, db = asyncio.run(_get(conv, limit=40))
        db.commit.assert_not_awaited()
        self.assertEqual(out["updated_at"], "2026-10-02T00:00:00+00:00")
        self.assertIn("ETag", response.headers)


if __name__ == "__main__":
    unittest.main()
