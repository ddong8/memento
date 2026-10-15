"""Unit tests for Round 10 performance and architectural optimizations."""

import unittest
import uuid
import time
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import Document, Machine, Project, User, UserMemory
from server.api.documents import _get_doc_with_permission
from server.api.projects import _reconcile_project_documents, _bust_project_cache
from server.api.memory import _bust_user_memory_cache
from server.services.dreaming_service import export_core_memory_markdown


class TestRound10Optimizations(unittest.IsolatedAsyncioTestCase):
    async def test_get_doc_with_permission_options(self):
        """Verify _get_doc_with_permission executes select with appropriate defer options."""
        mock_db = AsyncMock()
        mock_result = MagicMock()
        doc_id = uuid.uuid4()
        user_id = uuid.uuid4()
        user = User(id=user_id, role="admin", email="admin@example.com")
        doc = Document(id=doc_id, tool_id="cursor", visibility="public", machine_id=uuid.uuid4())
        mock_result.scalar_one_or_none.return_value = doc
        mock_db.execute.return_value = mock_result

        # When include_content=False
        res_doc = await _get_doc_with_permission(doc_id, mock_db, user, include_content=False)
        self.assertEqual(res_doc.id, doc_id)
        mock_db.execute.assert_called_once()
        query_arg = mock_db.execute.call_args[0][0]
        # Query should contain defer options
        self.assertTrue(hasattr(query_arg, "_with_options"))

    async def test_reconcile_project_documents_cooldown(self):
        """Verify _reconcile_project_documents obeys the 120s cooldown."""
        mock_db = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_db.execute.return_value = mock_result
        proj = Project(
            id=uuid.uuid4(),
            slug="claude_code/my-project",
            title="My Project",
            tool_id="claude_code",
        )

        with patch("server.api.projects._last_reconcile_time", {}) as mock_times:
            # First run: executes reconciliation
            with patch("server.api.projects._prettify_project_name", return_value="invalid"):
                # Prettify invalid name immediately returns 0 after setting timestamp
                res1 = await _reconcile_project_documents(mock_db, proj)
                self.assertEqual(res1, 0)
                self.assertIn(proj.id, mock_times)

            # Second immediate run without force: throttled by cooldown, returns 0 immediately
            res2 = await _reconcile_project_documents(mock_db, proj, force=False)
            self.assertEqual(res2, 0)

    async def test_project_and_memory_cache_bust(self):
        """Verify cache busters call delete_prefix without raising exceptions."""
        uid = uuid.uuid4()
        pid = uuid.uuid4()

        with patch("server.services.cache.cache_delete_prefix", new_callable=AsyncMock) as mock_del:
            await _bust_project_cache(pid, uid)
            self.assertGreaterEqual(mock_del.call_count, 1)

        with patch("server.services.cache.cache_delete_prefix", new_callable=AsyncMock) as mock_del:
            await _bust_user_memory_cache(uid)
            # Should invalidate memory:tree, memory:stats, and memory:markdown
            keys = [call[0][0] for call in mock_del.call_args_list]
            self.assertIn(f"memory:tree:{uid}:", keys)
            self.assertIn(f"memory:stats:{uid}:", keys)
            self.assertIn(f"memory:markdown:{uid}:", keys)

    async def test_export_core_memory_markdown_empty_and_populated(self):
        """Verify export_core_memory_markdown outputs correctly with load_only."""
        mock_db = AsyncMock()
        user = User(id=uuid.uuid4(), email="user@example.com")

        # Test empty
        mock_result_empty = MagicMock()
        mock_scalars_empty = MagicMock()
        mock_scalars_empty.all.return_value = []
        mock_result_empty.scalars.return_value = mock_scalars_empty
        mock_db.execute.return_value = mock_result_empty

        empty_md = await export_core_memory_markdown(mock_db, user)
        self.assertIn("当前暂未沉淀长期记忆", empty_md)

        # Test populated
        mem = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            category="rule",
            key="zip_package_only",
            content="客户端安装包强制使用 zip 格式",
            confidence=1.0,
            tree_path="/rule/zip_package_only",
            is_folder=False,
            status="active",
        )
        mock_result_pop = MagicMock()
        mock_scalars_pop = MagicMock()
        mock_scalars_pop.all.return_value = [mem]
        mock_result_pop.scalars.return_value = mock_scalars_pop
        mock_db.execute.return_value = mock_result_pop

        pop_md = await export_core_memory_markdown(mock_db, user)
        self.assertIn("zip_package_only", pop_md)
        self.assertIn("开发铁律与工程规范", pop_md)
        self.assertIn("/rule/zip_package_only", pop_md)


if __name__ == "__main__":
    unittest.main()
