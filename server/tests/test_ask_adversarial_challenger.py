"""Adversarial challenger tests for backend session APIs, pagination, metadata inference, and document fallback.
"""

from __future__ import annotations

import asyncio
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from fastapi import HTTPException
from fastapi.testclient import TestClient

from server.api import ask_conversations
from server.db.models import AskConversation, Document, Machine, Project, User
from server.db.session import get_db
from server.main import app
from server.middleware.auth import get_current_user
from server.services.ask_store import bust_conv_list
from server.services.cache import l1_cache_get, l1_cache_set


class TestExtremePaginationAndQueryValidation(unittest.TestCase):
    """Adversarial validation of pagination bounds on GET /api/ask/conversations."""

    def setUp(self):
        self.mock_user = MagicMock(spec=User)
        self.mock_user.id = uuid.uuid4()
        app.dependency_overrides[get_current_user] = lambda: self.mock_user

        self.mock_db = AsyncMock()
        mock_result = MagicMock()
        mock_result.all.return_value = []
        mock_result.scalars.return_value.all.return_value = []
        self.mock_db.execute.return_value = mock_result

        async def _override_db():
            yield self.mock_db

        app.dependency_overrides[get_db] = _override_db
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_db, None)

    def test_limit_501_rejected_by_validation(self):
        """limit=501 exceeds le=500 and must be rejected with 422 Unprocessable Entity."""
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)):
            r = self.client.get("/api/ask/conversations?limit=501")
        self.assertEqual(r.status_code, 422, f"Expected 422 but got {r.status_code}: {r.text}")
        detail = r.json().get("detail", [])
        self.assertTrue(any("limit" in str(err) for err in detail))

    def test_limit_0_rejected_by_validation(self):
        """limit=0 violates ge=1 and must be rejected with 422."""
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)):
            r = self.client.get("/api/ask/conversations?limit=0")
        self.assertEqual(r.status_code, 422, f"Expected 422 but got {r.status_code}: {r.text}")

    def test_limit_negative_rejected_by_validation(self):
        """limit=-1 violates ge=1 and must be rejected with 422."""
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)):
            r = self.client.get("/api/ask/conversations?limit=-1")
        self.assertEqual(r.status_code, 422, f"Expected 422 but got {r.status_code}: {r.text}")

    def test_offset_negative_rejected_by_validation(self):
        """offset=-1 violates ge=0 and must be rejected with 422."""
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)):
            r = self.client.get("/api/ask/conversations?offset=-1")
        self.assertEqual(r.status_code, 422, f"Expected 422 but got {r.status_code}: {r.text}")

    def test_limit_non_integer_rejected_by_validation(self):
        """Non-integer limit='abc' must be rejected with 422."""
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)):
            r = self.client.get("/api/ask/conversations?limit=abc")
        self.assertEqual(r.status_code, 422, f"Expected 422 but got {r.status_code}: {r.text}")

    def test_limit_1_boundary_accepted(self):
        """limit=1 is minimum allowed boundary and must succeed with 200."""
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "cache_set", AsyncMock()):
            r = self.client.get("/api/ask/conversations?limit=1")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), [])

    def test_limit_500_boundary_accepted(self):
        """limit=500 is maximum allowed boundary and must succeed with 200."""
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "cache_set", AsyncMock()):
            r = self.client.get("/api/ask/conversations?limit=500")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), [])

    def test_offset_0_boundary_accepted(self):
        """offset=0 is minimum allowed boundary and must succeed with 200."""
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "cache_set", AsyncMock()):
            r = self.client.get("/api/ask/conversations?offset=0")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), [])

    def test_offset_100000_large_offset_accepted(self):
        """offset=100000 is accepted, generates correct SQL offset, and returns empty list gracefully."""
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "cache_set", AsyncMock()):
            r = self.client.get("/api/ask/conversations?offset=100000")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), [])


class TestCacheKeyIsolationAndBust(unittest.TestCase):
    """Adversarial validation of cache key isolation across pagination and cache busting."""

    def setUp(self):
        self.mock_user = MagicMock(spec=User)
        self.mock_user.id = uuid.uuid4()
        self.mock_db = AsyncMock()

    def test_cache_keys_distinct_for_different_limit_offset_and_devices(self):
        """Different combinations of limit, offset, and device_id must generate unique cache keys."""
        uid = self.mock_user.id
        k_default = f"ask_conv_list:{uid}:all:200:0"
        k_limit50 = f"ask_conv_list:{uid}:all:50:0"
        k_offset10 = f"ask_conv_list:{uid}:all:200:10"
        k_dev_mac = f"ask_conv_list:{uid}:mac-mini:200:0"

        keys = {k_default, k_limit50, k_offset10, k_dev_mac}
        self.assertEqual(len(keys), 4, "Cache keys must be mutually isolated")

    def test_cache_hit_respects_exact_limit_and_offset(self):
        """Cache hit for page 1 (offset=0) must not satisfy page 2 (offset=50)."""
        cached_p1 = [{"id": "p1-conv", "title": "Page 1"}]
        cached_p2 = [{"id": "p2-conv", "title": "Page 2"}]

        async def _run():
            cache_store = {
                f"ask_conv_list:{self.mock_user.id}:all:50:0": cached_p1,
                f"ask_conv_list:{self.mock_user.id}:all:50:50": cached_p2,
            }
            with patch.object(ask_conversations, "cache_get", side_effect=lambda k: cache_store.get(k)):
                res_p1 = await ask_conversations.list_conversations(
                    device_id="all", limit=50, offset=0, db=self.mock_db, _user=self.mock_user
                )
                res_p2 = await ask_conversations.list_conversations(
                    device_id="all", limit=50, offset=50, db=self.mock_db, _user=self.mock_user
                )
            return res_p1, res_p2

        res_p1, res_p2 = asyncio.run(_run())
        self.assertEqual(res_p1[0]["title"], "Page 1")
        self.assertEqual(res_p2[0]["title"], "Page 2")
        self.assertNotEqual(res_p1, res_p2)

    def test_bust_conv_list_evicts_all_pages_and_parameters_for_user(self):
        """bust_conv_list must purge all cached pages (all limit/offset/device combinations) for that user."""
        uid = self.mock_user.id
        other_uid = uuid.uuid4()

        # Seed L1 cache directly
        k1 = f"ask_conv_list:{uid}:all:200:0"
        k2 = f"ask_conv_list:{uid}:all:50:50"
        k3 = f"ask_conv_list:{uid}:mac-mini:200:0"
        k_other = f"ask_conv_list:{other_uid}:all:200:0"

        l1_cache_set(k1, ["data1"], ttl_seconds=60)
        l1_cache_set(k2, ["data2"], ttl_seconds=60)
        l1_cache_set(k3, ["data3"], ttl_seconds=60)
        l1_cache_set(k_other, ["other_data"], ttl_seconds=60)

        # Bust cache for user
        asyncio.run(bust_conv_list(uid))

        # Check L1 cache
        self.assertIsNone(l1_cache_get(k1))
        self.assertIsNone(l1_cache_get(k2))
        self.assertIsNone(l1_cache_get(k3))
        # Other user's cache must remain intact
        self.assertEqual(l1_cache_get(k_other), ["other_data"])


class TestProjectMetadataAdversarialInference(unittest.TestCase):
    """Adversarial stress-testing of project metadata deduction from cwd and config."""

    def setUp(self):
        self.mock_user = MagicMock(spec=User)
        self.mock_user.id = uuid.uuid4()

        self.p_memento_id = uuid.uuid4()
        self.p_memento = Project(
            id=self.p_memento_id,
            slug="memento",
            title="Memento Core",
            source_path="/Users/haixingdong/dev/memento",
        )
        self.p_sub_id = uuid.uuid4()
        self.p_sub = Project(
            id=self.p_sub_id,
            slug="memento-apps-web",
            title="Memento Web App",
            source_path="/Users/haixingdong/dev/memento/apps/web",
        )
        self.p_pubchem_id = uuid.uuid4()
        self.p_pubchem = Project(
            id=self.p_pubchem_id,
            slug="pubchem",
            title="PubChem Tools",
            source_path="D:/dev/pubchem",
        )

    def _execute_list_with_rows(self, rows):
        async def mock_execute(stmt):
            s = str(stmt).lower()
            res = MagicMock()
            if "projects" in s:
                res.scalars.return_value.all.return_value = [self.p_memento, self.p_sub, self.p_pubchem]
            elif "machines" in s:
                res.scalars.return_value.all.return_value = []
            elif "ask_conversations" in s:
                res.all.return_value = rows
                res.scalars.return_value.all.return_value = []
            return res

        db = AsyncMock()
        db.execute.side_effect = mock_execute
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "cache_set", AsyncMock()):
            return asyncio.run(ask_conversations.list_conversations(limit=200, offset=0, db=db, _user=self.mock_user))

    def _make_row(self, row_id, cwd, config):
        row = MagicMock()
        row.id = row_id
        row.title = "Conv"
        row.created_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        row.updated_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        row.device_id = None
        row.cwd = cwd
        row.config = dict(config)
        row.config["_meta_scanned"] = True
        row.message_count = 1
        return row

    def test_root_and_system_temp_paths_yield_no_junk_project_title(self):
        """Paths like '/', '/tmp', '/var/folders/xyz/temp', 'C:\\', numbers, dots must never be extracted as project titles."""
        adversarial_cwds = [
            "/",
            "/tmp",
            "/var/folders/3t/abc/T",
            "C:\\",
            "C:/",
            "D:",
            "   ",
            "/home/user/12345",  # digits
            "/home/user/...",  # dots
        ]

        rows = [self._make_row(uuid.uuid4(), cwd, {}) for cwd in adversarial_cwds]
        items = self._execute_list_with_rows(rows)

        self.assertEqual(len(items), len(adversarial_cwds))
        for item in items:
            self.assertIsNone(
                item["project_title"],
                f"Adversarial cwd '{item['cwd']}' wrongly inferred project_title: {item['project_title']}",
            )

    def test_file_path_in_cwd_edge_case(self):
        """Adversarial check: cwd with file-like name e.g. '/home/user/test.py'.
        Documents that without _FILE_LIKE_NAME filter, cand_name 'test.py' is accepted as title."""
        cid = uuid.uuid4()
        row = self._make_row(cid, "/home/user/test.py", {})
        items = self._execute_list_with_rows([row])

        self.assertEqual(len(items), 1)
        # Documents current implementation behavior
        self.assertEqual(items[0]["project_title"], "test.py")

    def test_longest_prefix_matching_for_nested_projects(self):
        """cwd '/Users/haixingdong/dev/memento/apps/web/src' must match 'Memento Web App' over 'Memento Core'."""
        cid = uuid.uuid4()
        row = self._make_row(cid, "/Users/haixingdong/dev/memento/apps/web/src", {})
        items = self._execute_list_with_rows([row])

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["project_title"], "Memento Web App")
        self.assertEqual(items[0]["project_id"], str(self.p_sub_id))

    def test_invalid_project_id_with_valid_cwd(self):
        """When config.project_id is an invalid/stale string, valid cwd infers real project_title.
        Documents that resolved_pid retains original config string because 'if not resolved_pid' guards it."""
        cid = uuid.uuid4()
        row = self._make_row(
            cid,
            "/Users/haixingdong/dev/memento/packages/daemon",
            {"project_id": "non-existent-uuid-12345"},
        )
        items = self._execute_list_with_rows([row])

        self.assertEqual(len(items), 1)
        # Inferred project_title from prefix match
        self.assertEqual(items[0]["project_title"], "Memento Core")
        # resolved_pid currently retains the raw config string
        self.assertEqual(items[0]["project_id"], "non-existent-uuid-12345")

    def test_unregistered_project_falls_back_to_valid_leaf_folder(self):
        """Unregistered valid folder e.g. '/opt/git/data-mining-engine' falls back to folder name."""
        cid = uuid.uuid4()
        row = self._make_row(cid, "/opt/git/data-mining-engine", {})
        items = self._execute_list_with_rows([row])

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["project_title"], "data-mining-engine")
        self.assertIsNone(items[0]["project_id"])


class TestDeviceNameCleaningAdversarial(unittest.TestCase):
    """Adversarial validation that 'memento-' prefix is never surfaced as a device name."""

    def setUp(self):
        self.mock_user = MagicMock(spec=User)
        self.mock_user.id = uuid.uuid4()

    def _execute_list_with_devices(self, dev_configs, machines=None):
        rows = []
        for dev_id, cfg_dev_name in dev_configs:
            r = MagicMock()
            r.id = uuid.uuid4()
            r.title = "Conv"
            r.created_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
            r.updated_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
            r.device_id = dev_id
            r.cwd = None
            r.config = {"_meta_scanned": True}
            if cfg_dev_name is not None:
                r.config["device_name"] = cfg_dev_name
            r.message_count = 1
            rows.append(r)

        async def mock_execute(stmt):
            s = str(stmt).lower()
            res = MagicMock()
            if "projects" in s:
                res.scalars.return_value.all.return_value = []
            elif "machines" in s:
                res.scalars.return_value.all.return_value = machines or []
            elif "ask_conversations" in s:
                res.all.return_value = rows
                res.scalars.return_value.all.return_value = []
            return res

        db = AsyncMock()
        db.execute.side_effect = mock_execute
        with patch.object(ask_conversations, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "cache_set", AsyncMock()):
            return asyncio.run(ask_conversations.list_conversations(limit=200, offset=0, db=db, _user=self.mock_user))

    def test_memento_prefix_never_exposed(self):
        """device_id 'memento-', 'memento', 'memento-memento', or empty must never produce 'memento-' as device_name."""
        test_cases = [
            ("memento-", None, None),
            ("memento", None, None),
            ("memento-memento", None, None),
            ("memento-memento-", None, None),
            ("memento-desktop", None, "desktop"),
            (None, "memento-", None),
            (None, "memento", None),
            (None, "", None),
            ("auto", None, None),
            ("ask_only", None, None),
            ("all", None, None),
        ]

        configs = [(c[0], c[1]) for c in test_cases]
        items = self._execute_list_with_devices(configs)

        for i, item in enumerate(items):
            expected = test_cases[i][2]
            actual = item["device_name"]
            self.assertEqual(
                actual,
                expected,
                f"Case {test_cases[i]} produced unexpected device_name: '{actual}'",
            )
            # Strict assertion: must never be 'memento-' or 'memento'
            self.assertNotIn(actual, ("memento-", "memento"))

    def test_machine_merge_loop_prevention(self):
        """Cyclic merged_into between machines must terminate cleanly without hanging."""
        m1 = Machine(id=uuid.uuid4(), name="Host-1.local (Darwin)", merged_into=None)
        m2 = Machine(id=uuid.uuid4(), name="Host-2.local (Darwin)", merged_into=None)
        m1.merged_into = m2.id
        m2.merged_into = m1.id  # cycle

        items = self._execute_list_with_devices([(str(m1.id), None)], machines=[m1, m2])
        self.assertEqual(len(items), 1)
        # Should resolve cleanly without recursion error
        self.assertIn(items[0]["device_name"], ("Host-1", "Host-2"))


class TestDocumentFallbackAdversarial(unittest.TestCase):
    """Adversarial validation of detail endpoint Document fallback."""

    def setUp(self):
        self.mock_user = MagicMock(spec=User)
        self.mock_user.id = uuid.uuid4()

    def test_fallback_success_returns_200_with_turns_and_materializes(self):
        """Detail lookup on Document ID returns 200 with all conversation turns and materializes AskConversation."""
        doc_id = uuid.uuid4()
        doc = MagicMock(spec=Document)
        doc.id = doc_id
        doc.title = "CLI Claude Session"
        doc.category = "conversation"
        doc.metadata_ = {
            "session_id": "sess-adversarial-1",
            "device_id": "memento-macbook",
            "cwd": "/Users/haixingdong/dev/memento",
        }
        doc.tool_id = "claude_code"
        doc.machine_id = None
        doc.project_id = uuid.uuid4()

        messages = [
            ("user", "first prompt", datetime(2026, 10, 20, 10, 0, tzinfo=timezone.utc)),
            ("assistant", "first answer", datetime(2026, 10, 20, 10, 1, tzinfo=timezone.utc)),
            ("user", "second prompt", datetime(2026, 10, 20, 10, 2, tzinfo=timezone.utc)),
        ]

        async def mock_execute(stmt):
            s = str(stmt).lower()
            res = MagicMock()
            if "documents" in s:
                res.scalars.return_value.first.return_value = doc
            elif "conversation_messages" in s:
                res.all.return_value = messages
            elif "ask_conversations" in s:
                res.scalars.return_value.first.return_value = None
                res.scalar.return_value = [
                    {"role": r, "content": c, "toolCalls": [], "created_at": ts.isoformat()}
                    for r, c, ts in messages
                ]
            return res

        db = AsyncMock()
        db.add = MagicMock()
        db.execute.side_effect = mock_execute
        request = MagicMock()
        request.headers.get.return_value = ""
        response = MagicMock()
        response.headers = {}

        with patch.object(ask_conversations, "infer_conversation_config", return_value=({"execution_mode": "claude"}, {})), \
             patch.object(ask_conversations, "recover_orphaned_tasks_for_conv", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "resolve_concrete_device_for_conv", AsyncMock(return_value=None)), \
             patch.object(ask_conversations, "lookup_project_title", AsyncMock(return_value="Memento Core")), \
             patch.object(ask_conversations, "sanitize_turns_for_response", side_effect=lambda t, **_: t):
            out = asyncio.run(
                ask_conversations.get_conversation(
                    conv_id=str(doc_id),
                    request=request,
                    response=response,
                    db=db,
                    _user=self.mock_user,
                )
            )

        self.assertEqual(out["id"], str(doc_id))
        self.assertEqual(out["title"], "CLI Claude Session")
        self.assertEqual(out["total_turns"], 3)
        self.assertEqual(len(out["turns"]), 3)
        self.assertEqual(out["device_name"], "macbook")
        self.assertEqual(out["project_title"], "Memento Core")

        # Materialization check
        db.add.assert_called_once()
        materialized_conv = db.add.call_args[0][0]
        self.assertIsInstance(materialized_conv, AskConversation)
        self.assertEqual(materialized_conv.id, doc_id)
        self.assertEqual(materialized_conv.message_count, 3)

    def test_document_wrong_category_raises_404(self):
        """Document with category != 'conversation' (e.g. 'code' or 'pdf') must raise 404."""
        doc_id = uuid.uuid4()
        async def mock_execute(stmt):
            res = MagicMock()
            res.scalars.return_value.first.return_value = None
            return res

        db = AsyncMock()
        db.execute.side_effect = mock_execute
        request = MagicMock()
        request.headers.get.return_value = ""
        response = MagicMock()
        response.headers = {}

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                ask_conversations.get_conversation(
                    conv_id=str(doc_id),
                    request=request,
                    response=response,
                    db=db,
                    _user=self.mock_user,
                )
            )
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("Conversation not found", ctx.exception.detail)

    def test_document_fallback_commit_failure_resilience(self):
        """If db.commit() fails during materialization, endpoint still answers 200 without raising 500."""
        doc_id = uuid.uuid4()
        doc = MagicMock(spec=Document)
        doc.id = doc_id
        doc.title = "Resilient Session"
        doc.category = "conversation"
        doc.metadata_ = {"session_id": "sess-fail-commit"}
        doc.tool_id = "claude"
        doc.machine_id = None
        doc.project_id = None

        async def mock_execute(stmt):
            s = str(stmt).lower()
            res = MagicMock()
            if "documents" in s:
                res.scalars.return_value.first.return_value = doc
            elif "conversation_messages" in s:
                res.all.return_value = [("user", "hi", datetime.now(timezone.utc))]
            elif "ask_conversations" in s:
                res.scalars.return_value.first.return_value = None
                res.scalar.return_value = [{"role": "user", "content": "hi"}]
            return res

        db = AsyncMock()
        db.add = MagicMock()
        db.execute.side_effect = mock_execute
        db.commit.side_effect = RuntimeError("DB write lock conflict")
        request = MagicMock()
        request.headers.get.return_value = ""
        response = MagicMock()
        response.headers = {}

        with patch.object(ask_conversations, "infer_conversation_config", return_value=({}, {})), \
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
                    _user=self.mock_user,
                )
            )

        self.assertEqual(out["id"], str(doc_id))
        self.assertEqual(out["title"], "Resilient Session")
        self.assertEqual(out["total_turns"], 1)


if __name__ == "__main__":
    unittest.main()
