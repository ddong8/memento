"""Unit tests for Round 14 performance and architectural optimizations."""

import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import DeviceTask, Project, User
from server.api.tasks import list_tasks, _serialize
from server.api.projects import (
    get_project_blueprint,
    export_project_markdown,
    _bust_project_cache,
)
from server.api.memory import _bust_user_memory_cache


class TestRound14Optimizations(unittest.IsolatedAsyncioTestCase):
    async def test_list_tasks_defer_events_and_serialize(self):
        """Verify list_tasks defers events column and serializes events as empty list in list view."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        mock_db = AsyncMock()

        task = DeviceTask(
            id=uuid.uuid4(),
            device_id="dev123",
            action="shell",
            payload={"command": "ls"},
            status="succeeded",
            events=[{"step": 1, "tool": "bash", "output": "file.txt"}],
        )

        mock_res = MagicMock()
        mock_res.scalars.return_value.all.return_value = [task]
        mock_db.execute.return_value = mock_res

        # Test list_tasks
        res = await list_tasks(limit=10, db=mock_db, _user=user)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["events"], [])  # list view omits bulky events

        # Inspect query options
        query = mock_db.execute.call_args[0][0]
        self.assertIn("DeviceTask.events", str(query._with_options[0].context[0].path))

        # Test _serialize with include_events=True
        full = _serialize(task, include_events=True)
        self.assertEqual(len(full["events"]), 1)
        self.assertEqual(full["events"][0]["tool"], "bash")

    async def test_get_project_blueprint_caching_and_defer(self):
        """Verify get_project_blueprint caches response and defers rendered_html."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        project_id = uuid.uuid4()
        project = Project(
            id=project_id,
            title="Memento",
            slug="memento",
            tool_id="claude_code",
            source_path="/path/to/memento",
        )

        mock_db = AsyncMock()
        mock_proj_res = MagicMock()
        mock_proj_res.scalar_one_or_none.return_value = project

        mock_curated_res = MagicMock()
        mock_curated_res.scalars.return_value.all.return_value = []

        mock_conv_res = MagicMock()
        mock_conv_res.scalars.return_value.all.return_value = []

        mock_ent_res = MagicMock()
        mock_ent_res.scalars.return_value.all.return_value = []

        mock_db.execute.side_effect = [
            mock_proj_res,
            mock_curated_res,
            mock_conv_res,
            mock_ent_res,
        ]

        with patch("server.api.projects.user_machine_ids", new_callable=AsyncMock, return_value=None), \
             patch("server.api.projects.cache_get", new_callable=AsyncMock, return_value=None), \
             patch("server.api.projects.cache_set", new_callable=AsyncMock) as mock_cache_set:

            res = await get_project_blueprint(project_id, recent_convs=5, db=mock_db, _user=user)
            self.assertEqual(res["project"]["title"], "Memento")
            mock_cache_set.assert_awaited_once()
            cache_key = mock_cache_set.call_args[0][0]
            self.assertEqual(cache_key, f"project:blueprint:{user.id}:{project_id}:5")
            self.assertEqual(mock_cache_set.call_args[1]["ttl_seconds"], 30)

        # Second call with cached data should hit cache immediately
        with patch("server.api.projects.cache_get", new_callable=AsyncMock, return_value=res) as mock_cache_get_hit:
            hit_res = await get_project_blueprint(project_id, recent_convs=5, db=mock_db, _user=user)
            self.assertEqual(hit_res, res)
            mock_cache_get_hit.assert_awaited_once_with(f"project:blueprint:{user.id}:{project_id}:5")

    async def test_export_project_markdown_filter_and_defer(self):
        """Verify export_project_markdown filters out conversation category when include_conversations=False."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        project_id = uuid.uuid4()
        project = Project(
            id=project_id,
            title="Memento",
            slug="memento",
            tool_id="claude_code",
            source_path="/path/to/memento",
        )

        mock_db = AsyncMock()
        mock_proj_res = MagicMock()
        mock_proj_res.scalar_one_or_none.return_value = project

        mock_docs_res = MagicMock()
        mock_docs_res.scalars.return_value.all.return_value = []

        mock_ent_res = MagicMock()
        mock_ent_res.scalars.return_value.all.return_value = []

        mock_db.execute.side_effect = [
            mock_proj_res,
            mock_docs_res,
            mock_ent_res,
        ]

        with patch("server.api.projects.user_machine_ids", new_callable=AsyncMock, return_value=None):
            resp = await export_project_markdown(
                project_id,
                include_conversations=False,
                db=mock_db,
                _user=user,
            )
            self.assertEqual(resp.status_code, 200)

            # Check that docs query filtered out conversations at SQL level
            docs_query = mock_db.execute.call_args_list[1][0][0]
            query_str = str(docs_query)
            self.assertIn("documents.category !=", query_str)
            # Check defer options
            options_repr = [str(opt.context[0].path) for opt in docs_query._with_options if opt.context]
            self.assertTrue(any("content_tsv" in repr_str for repr_str in options_repr))
            self.assertTrue(any("rendered_html" in repr_str for repr_str in options_repr))

    async def test_project_blueprint_cache_invalidation(self):
        """Verify _bust_project_cache and _bust_user_memory_cache clear project:blueprint caches."""
        user_id = uuid.uuid4()
        project_id = uuid.uuid4()

        with patch("server.services.cache.cache_delete_prefix", new_callable=AsyncMock) as mock_del:
            await _bust_project_cache(project_id=project_id, user_id=user_id)
            deleted = [call[0][0] for call in mock_del.call_args_list]
            self.assertIn(f"projects:list:{user_id}:", deleted)
            self.assertIn("project:blueprint:", deleted)

            mock_del.reset_mock()
            await _bust_user_memory_cache(user_id=user_id)
            mem_deleted = [call[0][0] for call in mock_del.call_args_list]
            self.assertIn(f"project:blueprint:{user_id}:", mem_deleted)


if __name__ == "__main__":
    unittest.main()
