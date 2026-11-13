"""GET /api/ask/conversations/{id} when the stored row needs a write-back first.

The branch that commits an updated message_count / config left created_at_iso unset and
answered 500 (UnboundLocalError) on production; it must return the conversation."""
from __future__ import annotations

import asyncio
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from server.api import ask_conversations
from server.db.models import AskConversation, User, Project, Machine, Document
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import make_transient_to_detached


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


async def _get(conv, commit_side_effect=None, limit=0, page=None):
    db = AsyncMock()
    res = MagicMock()
    res.scalars.return_value.first.return_value = conv
    res.scalar.return_value = conv.turns if page is None else page  # the page sliced in SQL
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


class TestConversationDetailDocumentFallback(unittest.TestCase):
    def test_missing_conv_and_missing_doc_raises_404(self):
        db = AsyncMock()
        res = MagicMock()
        res.scalars.return_value.first.return_value = None
        db.execute.return_value = res
        request = MagicMock()
        request.headers.get.return_value = ""
        response = MagicMock()
        response.headers = {}
        user = MagicMock(spec=User)
        user.id = uuid.uuid4()
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                ask_conversations.get_conversation(
                    conv_id=str(uuid.uuid4()),
                    request=request,
                    response=response,
                    db=db,
                    _user=user,
                )
            )
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("Conversation not found", ctx.exception.detail)

    def test_missing_conv_materializes_from_document(self):
        doc_id = uuid.uuid4()
        doc = MagicMock(spec=Document)
        doc.id = doc_id
        doc.title = "Terminal Claude Session"
        doc.category = "conversation"
        doc.metadata_ = {"session_id": "sess-cli-123", "device_id": "memento-desktop"}
        doc.tool_id = "claude_code"
        doc.machine_id = None
        doc.project_id = None

        msg = MagicMock()
        msg.role = "user"
        msg.content = "git status check"
        msg.timestamp = datetime(2026, 10, 15, tzinfo=timezone.utc)

        async def mock_execute(stmt):
            s = str(stmt).lower()
            res = MagicMock()
            if "documents" in s:
                res.scalars.return_value.first.return_value = doc
            elif "conversation_messages" in s:
                res.all.return_value = [(msg.role, msg.content, msg.timestamp)]
            elif "ask_conversations" in s:
                res.scalars.return_value.first.return_value = None
                res.scalar.return_value = [{"role": "user", "content": "git status check"}]
            return res

        db = AsyncMock()
        db.add = MagicMock()
        db.execute.side_effect = mock_execute
        user = MagicMock(spec=User)
        user.id = uuid.uuid4()
        request = MagicMock()
        request.headers.get.return_value = ""
        response = MagicMock()
        response.headers = {}

        with patch.object(ask_conversations, "infer_conversation_config", return_value=({"execution_mode": "claude"}, {})), \
             patch.object(ask_conversations, "recover_orphaned_tasks_for_conv", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "resolve_concrete_device_for_conv", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "lookup_project_title", AsyncMock(return_value="")), \
             patch.object(ask_conversations, "sanitize_turns_for_response", side_effect=lambda t, **_: t):
            out = asyncio.run(
                ask_conversations.get_conversation(
                    conv_id=str(doc_id),
                    request=request,
                    response=response,
                    db=db,
                    _user=user,
                )
            )

        self.assertEqual(out["id"], str(doc_id))
        self.assertEqual(out["title"], "Terminal Claude Session")
        self.assertEqual(out["total_turns"], 1)
        self.assertEqual(out["device_name"], "desktop")
        db.add.assert_called_once()
        added_obj = db.add.call_args[0][0]
        self.assertIsInstance(added_obj, AskConversation)
        self.assertEqual(added_obj.id, doc_id)

    def test_detail_returns_device_name_for_existing_conv(self):
        conv = _conv(message_count=2)
        conv.device_id = "memento-desktop"
        out, response, db = asyncio.run(_get(conv))
        self.assertEqual(out["device_name"], "desktop")


class TestListConversations(unittest.TestCase):
    def test_list_conversations_pagination_and_cache(self):
        user = MagicMock(spec=User)
        user.id = uuid.uuid4()
        db = AsyncMock()

        # When cached, it returns immediately without executing query
        cached_result = [{"id": "cached-1", "title": "Cached conversation"}]
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=cached_result)) as mock_cache_get:
            res = asyncio.run(ask_conversations.list_conversations(device_id="all", limit=50, offset=10, db=db, _user=user))
            self.assertEqual(res, cached_result)
            mock_cache_get.assert_awaited_once_with(f"ask_conv_list:{user.id}:all:50:10")
            db.execute.assert_not_awaited()

    def test_list_conversations_project_metadata_mapping(self):
        user = MagicMock(spec=User)
        user.id = uuid.uuid4()

        proj1_id = uuid.uuid4()
        proj1 = Project(id=proj1_id, slug="memento", title="Memento Core", source_path="/Users/dev/memento")
        proj2_id = uuid.uuid4()
        proj2 = Project(id=proj2_id, slug="pubchem", title="PubChem Analyzer", source_path="d:/dev/pubchem")

        # Row 1: has config.project_id matching proj1.id
        row1 = MagicMock()
        row1.id = uuid.uuid4()
        row1.title = "Conv 1"
        row1.created_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        row1.updated_at = datetime(2026, 10, 5, tzinfo=timezone.utc)
        row1.device_id = None
        row1.cwd = None
        row1.config = {"project_id": str(proj1_id), "_meta_scanned": True}
        row1.message_count = 1

        # Row 2: has config.project_id matching proj2.slug
        row2 = MagicMock()
        row2.id = uuid.uuid4()
        row2.title = "Conv 2"
        row2.created_at = datetime(2026, 10, 2, tzinfo=timezone.utc)
        row2.updated_at = datetime(2026, 10, 4, tzinfo=timezone.utc)
        row2.device_id = None
        row2.cwd = None
        row2.config = {"project_id": "pubchem", "_meta_scanned": True}
        row2.message_count = 2

        # Row 3: no config.project_id, but cwd matches proj1.source_path prefix
        row3 = MagicMock()
        row3.id = uuid.uuid4()
        row3.title = "Conv 3"
        row3.created_at = datetime(2026, 10, 3, tzinfo=timezone.utc)
        row3.updated_at = datetime(2026, 10, 3, tzinfo=timezone.utc)
        row3.device_id = None
        row3.cwd = "/Users/dev/memento/server/tests"
        row3.config = {"_meta_scanned": True}
        row3.message_count = 3

        # Row 4: no matching project, but has valid folder in cwd
        row4 = MagicMock()
        row4.id = uuid.uuid4()
        row4.title = "Conv 4"
        row4.created_at = datetime(2026, 10, 4, tzinfo=timezone.utc)
        row4.updated_at = datetime(2026, 10, 2, tzinfo=timezone.utc)
        row4.device_id = None
        row4.cwd = "/home/dev/standalone-repo"
        row4.config = {"_meta_scanned": True}
        row4.message_count = 4

        # Row 5: no project_id and no cwd
        row5 = MagicMock()
        row5.id = uuid.uuid4()
        row5.title = "Conv 5"
        row5.created_at = datetime(2026, 10, 5, tzinfo=timezone.utc)
        row5.updated_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        row5.device_id = None
        row5.cwd = None
        row5.config = {"_meta_scanned": True}
        row5.message_count = 5

        async def mock_execute(stmt):
            s = str(stmt).lower()
            res = MagicMock()
            if "projects" in s:
                res.scalars.return_value.all.return_value = [proj1, proj2]
            elif "machines" in s:
                res.scalars.return_value.all.return_value = []
            elif "ask_conversations" in s:
                res.all.return_value = [row1, row2, row3, row4, row5]
                res.scalars.return_value.all.return_value = []
            return res

        db = AsyncMock()
        db.execute.side_effect = mock_execute

        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "cache_set", AsyncMock()):
            items = asyncio.run(ask_conversations.list_conversations(limit=200, offset=0, db=db, _user=user))

        self.assertEqual(len(items), 5)
        # Verify row 1
        item1 = next(x for x in items if x["id"] == str(row1.id))
        self.assertEqual(item1["project_id"], str(proj1_id))
        self.assertEqual(item1["project_title"], "Memento Core")

        # Verify row 2 (matched slug)
        item2 = next(x for x in items if x["id"] == str(row2.id))
        self.assertEqual(item2["project_id"], str(proj2_id))
        self.assertEqual(item2["project_title"], "PubChem Analyzer")

        # Verify row 3 (inferred from cwd prefix)
        item3 = next(x for x in items if x["id"] == str(row3.id))
        self.assertEqual(item3["project_id"], str(proj1_id))
        self.assertEqual(item3["project_title"], "Memento Core")

        # Verify row 4 (folder fallback)
        item4 = next(x for x in items if x["id"] == str(row4.id))
        self.assertIsNone(item4["project_id"])
        self.assertEqual(item4["project_title"], "standalone-repo")

        # Verify row 5 (empty)
        item5 = next(x for x in items if x["id"] == str(row5.id))
        self.assertIsNone(item5["project_id"])
        self.assertIsNone(item5["project_title"])

    def test_list_conversations_device_name_resolution(self):
        user = MagicMock(spec=User)
        user.id = uuid.uuid4()

        mach1_id = uuid.uuid4()
        mach1 = Machine(id=mach1_id, name="DESKTOP-KR9IPP4 (Windows)", collector_token_hash="tok-win-1")
        mach2_id = uuid.uuid4()
        mach2 = Machine(id=mach2_id, name="MacBook-Pro.local (Darwin)", collector_token_hash="tok-mac-1")

        row1 = MagicMock()
        row1.id = uuid.uuid4()
        row1.title = "Conv Windows"
        row1.created_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        row1.updated_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        row1.device_id = "tok-win-1"
        row1.cwd = None
        row1.config = {"_meta_scanned": True}
        row1.message_count = 1

        row2 = MagicMock()
        row2.id = uuid.uuid4()
        row2.title = "Conv Mac"
        row2.created_at = datetime(2026, 10, 2, tzinfo=timezone.utc)
        row2.updated_at = datetime(2026, 10, 2, tzinfo=timezone.utc)
        row2.device_id = "tok-mac-1"
        row2.cwd = None
        row2.config = {"_meta_scanned": True}
        row2.message_count = 2

        row3 = MagicMock()
        row3.id = uuid.uuid4()
        row3.title = "Conv Unmatched Memento"
        row3.created_at = datetime(2026, 10, 3, tzinfo=timezone.utc)
        row3.updated_at = datetime(2026, 10, 3, tzinfo=timezone.utc)
        row3.device_id = "memento-desktop"
        row3.cwd = None
        row3.config = {"_meta_scanned": True}
        row3.message_count = 3

        row4 = MagicMock()
        row4.id = uuid.uuid4()
        row4.title = "Conv Pure Memento Prefix"
        row4.created_at = datetime(2026, 10, 4, tzinfo=timezone.utc)
        row4.updated_at = datetime(2026, 10, 4, tzinfo=timezone.utc)
        row4.device_id = "memento-"
        row4.cwd = None
        row4.config = {"_meta_scanned": True}
        row4.message_count = 4

        async def mock_execute(stmt):
            s = str(stmt).lower()
            res = MagicMock()
            if "projects" in s:
                res.scalars.return_value.all.return_value = []
            elif "machines" in s:
                res.scalars.return_value.all.return_value = [mach1, mach2]
            elif "ask_conversations" in s:
                res.all.return_value = [row1, row2, row3, row4]
                res.scalars.return_value.all.return_value = []
            return res

        db = AsyncMock()
        db.execute.side_effect = mock_execute

        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "cache_set", AsyncMock()):
            items = asyncio.run(ask_conversations.list_conversations(limit=200, offset=0, db=db, _user=user))

        item1 = next(x for x in items if x["id"] == str(row1.id))
        self.assertEqual(item1["device_name"], "DESKTOP-KR9IPP4")

        item2 = next(x for x in items if x["id"] == str(row2.id))
        self.assertEqual(item2["device_name"], "MacBook-Pro")

        item3 = next(x for x in items if x["id"] == str(row3.id))
        self.assertEqual(item3["device_name"], "desktop")

        item4 = next(x for x in items if x["id"] == str(row4.id))
        self.assertIsNone(item4["device_name"])

    def test_list_conversations_pinned_sorting(self):
        user = MagicMock(spec=User)
        user.id = uuid.uuid4()

        row_old_pinned = MagicMock()
        row_old_pinned.id = uuid.uuid4()
        row_old_pinned.title = "Pinned Old"
        row_old_pinned.created_at = datetime(2026, 9, 1, tzinfo=timezone.utc)
        row_old_pinned.updated_at = datetime(2026, 9, 1, tzinfo=timezone.utc)
        row_old_pinned.device_id = None
        row_old_pinned.cwd = None
        row_old_pinned.config = {"pinned": True, "_meta_scanned": True}
        row_old_pinned.message_count = 1

        row_new_unpinned = MagicMock()
        row_new_unpinned.id = uuid.uuid4()
        row_new_unpinned.title = "New Unpinned"
        row_new_unpinned.created_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        row_new_unpinned.updated_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        row_new_unpinned.device_id = None
        row_new_unpinned.cwd = None
        row_new_unpinned.config = {"_meta_scanned": True}
        row_new_unpinned.message_count = 1

        async def mock_execute(stmt):
            s = str(stmt).lower()
            res = MagicMock()
            if "projects" in s:
                res.scalars.return_value.all.return_value = []
            elif "machines" in s:
                res.scalars.return_value.all.return_value = []
            elif "ask_conversations" in s:
                res.all.return_value = [row_new_unpinned, row_old_pinned]
                res.scalars.return_value.all.return_value = []
            return res

        db = AsyncMock()
        db.execute.side_effect = mock_execute

        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "cache_set", AsyncMock()):
            items = asyncio.run(ask_conversations.list_conversations(limit=200, offset=0, db=db, _user=user))

        self.assertEqual(items[0]["id"], str(row_old_pinned.id))
        self.assertEqual(items[1]["id"], str(row_new_unpinned.id))


def _row_with_deferred_turns():
    """A real AskConversation as get_conversation loads it: every column but the deferred `turns`.

    Reading `turns` on it would lazy-load (here DetachedInstanceError; in the async app
    MissingGreenlet), which is what answered 500 for conversations that have no turns yet."""
    values = {a.key: None for a in sa_inspect(AskConversation).column_attrs if a.key != "turns"}
    values.update(
        id=uuid.uuid4(), title="t", message_count=0, config={},
        created_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 10, 2, tzinfo=timezone.utc),
    )
    conv = AskConversation(**values)
    make_transient_to_detached(conv)  # columns never set (turns) become unloaded
    return conv


class TestConversationWithoutTurns(unittest.TestCase):
    def test_empty_conversation_does_not_lazy_load_turns(self):
        conv = _row_with_deferred_turns()
        self.assertIn("turns", sa_inspect(conv).unloaded)
        out, _response, _db = asyncio.run(_get(conv, limit=40, page=[]))
        self.assertEqual(out["total_turns"], 0)
        self.assertIn("turns", sa_inspect(conv).unloaded)  # never touched

    def test_whole_conversation_without_a_limit_loads_turns_explicitly(self):
        conv = _row_with_deferred_turns()
        turns = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]

        async def refresh(obj, attrs=None):
            # what db.refresh(conv, ["turns"]) does: the column is loaded, no lazy load on read
            obj.__dict__["turns"] = turns
            sa_inspect(obj).committed_state.pop("turns", None)

        db_refresh = AsyncMock(side_effect=refresh)
        out, _response, _db = asyncio.run(_get_with_refresh(conv, db_refresh))
        db_refresh.assert_awaited()
        self.assertEqual(out["total_turns"], 2)


async def _get_with_refresh(conv, refresh):
    db = AsyncMock()
    res = MagicMock()
    res.scalars.return_value.first.return_value = conv
    db.execute.return_value = res
    db.refresh = refresh
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
            conv_id=str(conv.id), request=request, response=response, limit=0, db=db, _user=user,
        )
    return out, response, db


if __name__ == "__main__":
    unittest.main()
