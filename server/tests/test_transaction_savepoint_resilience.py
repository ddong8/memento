"""Unit tests for transaction savepoint resilience and migration robustness.

Verifies that:
1. _run_migrations executes ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS embedding vector(1024).
2. mind_resonance_service functions (_fetch_pitfalls, _fetch_graph_entities, _project_name, record_online_graph_observation)
   isolate queries and flushes with savepoints so that database exceptions roll back locally and do not leave outer transactions aborted.
3. ask_retrieval.retrieve_core_memories wraps vector ANN search in a savepoint, safely degrading to fallback candidates if vector queries fail.
"""

from __future__ import annotations

import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.exc import DBAPIError

from server.db.models import User, UserMemory
from server.main import _run_migrations
from server.services.ask_retrieval import retrieve_core_memories
from server.services.mind_resonance_service import (
    _fetch_graph_entities,
    _fetch_pitfalls,
    _project_name,
    _safe_begin_nested,
    load_dynamic_scenarios_from_db,
    record_online_graph_observation,
)


class MockSavepoint:
    """Mock savepoint tracking context entry and exit (rollback on exception)."""

    def __init__(self):
        self.entered = False
        self.exited = False
        self.exc_type = None

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self.exited = True
        self.exc_type = exc_type
        # Do not suppress the exception so begin_nested() behaves like SQLAlchemy:
        # rollback savepoint, then let exception propagate to caller's try/except block.
        return False


class TestTransactionSavepointResilience(unittest.IsolatedAsyncioTestCase):
    async def test_migration_adds_user_memories_embedding_column(self):
        """Verify _run_migrations executes the ALTER TABLE for user_memories.embedding."""
        mock_conn = MagicMock()
        mock_insp = MagicMock()
        mock_insp.get_table_names.return_value = ["machines", "users", "user_memories", "documents"]
        mock_insp.get_columns.return_value = [{"name": "id"}]

        with patch("sqlalchemy.inspect", return_value=mock_insp):
            _run_migrations(mock_conn)

        # Inspect all statements executed on mock_conn
        executed_sqls = [str(call.args[0]) for call in mock_conn.execute.call_args_list if call.args]
        embedding_ddl_present = any(
            "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS embedding vector(1024)" in sql
            for sql in executed_sqls
        )
        self.assertTrue(
            embedding_ddl_present,
            "Expected ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS embedding vector(1024) in migrations",
        )

    async def test_fetch_pitfalls_savepoint_rollback_on_db_error(self):
        """Verify _fetch_pitfalls wraps query in savepoint and handles DB error gracefully."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="owner")
        mock_db = MagicMock()
        sp = MockSavepoint()
        mock_db.begin_nested = MagicMock(return_value=sp)

        # Simulate Postgres error: current transaction is aborted
        db_err = DBAPIError("SELECT ...", {}, Exception("current transaction is aborted"))
        mock_db.execute = AsyncMock(side_effect=db_err)

        pitfalls = await _fetch_pitfalls(mock_db, user, ["memento", "release"], limit_pitfalls=4)

        self.assertTrue(sp.entered, "Savepoint must be entered")
        self.assertTrue(sp.exited, "Savepoint must be exited")
        self.assertEqual(sp.exc_type, DBAPIError, "Savepoint must record the exception during rollback")
        self.assertEqual(pitfalls, [], "Should gracefully degrade to empty pitfalls list without raising")

    async def test_fetch_graph_entities_savepoint_rollback_on_db_error(self):
        """Verify _fetch_graph_entities wraps queries in savepoint and handles DB error gracefully."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="owner")
        mock_db = MagicMock()
        sp = MockSavepoint()
        mock_db.begin_nested = MagicMock(return_value=sp)

        db_err = DBAPIError("SELECT ...", {}, Exception("syntax error or aborted transaction"))
        mock_db.execute = AsyncMock(side_effect=db_err)

        entities = await _fetch_graph_entities(mock_db, user, ["memento", "desktop"], limit_entities=4)

        self.assertTrue(sp.entered, "Savepoint must be entered")
        self.assertTrue(sp.exited, "Savepoint must be exited")
        self.assertEqual(sp.exc_type, DBAPIError)
        self.assertEqual(entities, [], "Should gracefully degrade to empty entities list without raising")

    async def test_project_name_savepoint_rollback_on_db_error(self):
        """Verify _project_name wraps lookup in savepoint and safely returns None on error."""
        pid = str(uuid.uuid4())
        mock_db = MagicMock()
        sp = MockSavepoint()
        mock_db.begin_nested = MagicMock(return_value=sp)

        db_err = DBAPIError("SELECT ...", {}, Exception("lock timeout"))
        mock_db.execute = AsyncMock(side_effect=db_err)

        result = await _project_name(mock_db, pid)

        self.assertTrue(sp.entered)
        self.assertTrue(sp.exited)
        self.assertEqual(sp.exc_type, DBAPIError)
        self.assertIsNone(result, "Should return None on DB error without aborting outer transaction")

    async def test_record_online_graph_observation_savepoint_rollback_on_flush_error(self):
        """Verify record_online_graph_observation rolls back savepoint if db.flush() fails."""
        uid = uuid.uuid4()
        mock_db = MagicMock()
        sp = MockSavepoint()
        mock_db.begin_nested = MagicMock(return_value=sp)

        # find_entity succeeds or returns None
        with patch("server.services.entity_canon.find_entity", new_callable=AsyncMock, return_value=None):
            # Simulate db.flush() failure (e.g. constraint violation or lock conflict)
            mock_db.flush = AsyncMock(side_effect=DBAPIError("INSERT ...", {}, Exception("unique violation")))
            obs = await record_online_graph_observation(mock_db, uid, "TestEntity", "Obs Content")

            self.assertTrue(sp.entered)
            self.assertTrue(sp.exited)
            self.assertEqual(sp.exc_type, DBAPIError)
            self.assertIsNone(obs, "Should return None on flush failure without aborting outer transaction")

    async def test_retrieve_core_memories_vector_ann_savepoint_and_fallback(self):
        """Verify retrieve_core_memories wraps vector search in savepoint and falls back to text candidate query."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="owner")
        mock_db = MagicMock()
        savepoints: list[MockSavepoint] = []
        def make_sp():
            s = MockSavepoint()
            savepoints.append(s)
            return s
        mock_db.begin_nested = MagicMock(side_effect=make_sp)

        fallback_mem = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            key="iron_rule_test",
            category="iron_rule",
            content="铁律：交付前本地类型检查与自测确认通过",
            status="active",
            is_folder=False,
            recall_count=0,
            confidence=1.0,
        )

        mock_fallback_result = MagicMock()
        mock_fallback_result.scalars.return_value.all.return_value = [fallback_mem]

        async def fake_execute(statement, *args, **kwargs):
            sql = str(statement)
            if "<=>" in sql or "embedding IS NOT NULL" in sql:
                # Vector search fails (e.g. vector type/extension missing or column missing)
                raise DBAPIError(sql, {}, Exception("column user_memories.embedding does not exist"))
            # Fallback cand_q query succeeds
            return mock_fallback_result

        mock_db.execute = AsyncMock(side_effect=fake_execute)

        with patch("server.services.embedding_service._call_embedding_server", new_callable=AsyncMock, return_value=[[0.1] * 1024]):
            mems = await retrieve_core_memories(
                mock_db,
                user,
                question="测试规则检索",
            )

            self.assertGreaterEqual(len(savepoints), 1, "At least one savepoint must be created")
            vec_sp = savepoints[0]
            self.assertTrue(vec_sp.entered, "Vector ANN search must enter savepoint")
            self.assertTrue(vec_sp.exited, "Vector ANN search must exit savepoint")
            self.assertEqual(vec_sp.exc_type, DBAPIError, "Savepoint must roll back vector query exception")
            self.assertEqual(len(mems), 1, "Fallback candidate query must succeed and return memory")
            self.assertEqual(mems[0].key, "iron_rule_test")

    async def test_migration_vector_extension_failure_rolls_back_savepoint(self):
        """Verify CREATE EXTENSION IF NOT EXISTS vector runs in a savepoint and rolls back without aborting tx."""
        mock_conn = MagicMock()
        mock_insp = MagicMock()
        mock_insp.get_table_names.return_value = ["machines", "users", "user_memories", "documents"]
        mock_insp.get_columns.return_value = [{"name": "id"}]

        sp_mock = MagicMock()
        mock_conn.begin_nested.return_value = sp_mock

        def fake_conn_execute(statement, *args, **kwargs):
            sql = str(statement)
            if "CREATE EXTENSION IF NOT EXISTS vector" in sql:
                raise DBAPIError(sql, {}, Exception("extension vector is not available"))
            return MagicMock()

        mock_conn.execute.side_effect = fake_conn_execute

        with patch("sqlalchemy.inspect", return_value=mock_insp):
            # Must not raise an exception even if vector extension creation fails
            _run_migrations(mock_conn)

        # Confirm that begin_nested was called and rollback was executed for the failed extension
        self.assertTrue(sp_mock.rollback.called, "sp.rollback() must be called on extension creation failure")

    async def test_load_dynamic_scenarios_savepoint_rollback_on_db_error(self):
        """Verify load_dynamic_scenarios_from_db isolates query in savepoint and rolls back on DB error."""
        mock_db = MagicMock()
        sp = MockSavepoint()
        mock_db.begin_nested = MagicMock(return_value=sp)

        db_err = DBAPIError("SELECT ...", {}, Exception("relation user_memories does not exist"))
        mock_db.execute = AsyncMock(side_effect=db_err)

        scenarios = await load_dynamic_scenarios_from_db(mock_db, uuid.uuid4())

        self.assertTrue(sp.entered, "Savepoint must be entered in load_dynamic_scenarios_from_db")
        self.assertTrue(sp.exited, "Savepoint must be exited in load_dynamic_scenarios_from_db")
        self.assertEqual(sp.exc_type, DBAPIError)
        self.assertEqual(scenarios, [], "Must gracefully return empty scenarios list on DB failure")

    async def test_retrieve_core_memories_cand_q_savepoint_rollback(self):
        """Verify retrieve_core_memories isolates candidate query in savepoint if cand_q fails."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="owner")
        mock_db = MagicMock()
        sp = MockSavepoint()
        mock_db.begin_nested = MagicMock(return_value=sp)

        # Simulate both vector and cand_q failing
        db_err = DBAPIError("SELECT ...", {}, Exception("aborted transaction or table lock"))
        mock_db.execute = AsyncMock(side_effect=db_err)

        with patch("server.services.embedding_service._call_embedding_server", new_callable=AsyncMock, return_value=[[0.1] * 1024]):
            mems = await retrieve_core_memories(
                mock_db,
                user,
                question="测试候选查询异常隔离",
            )
            self.assertEqual(mems, [], "Should safely degrade to empty list without raising")

    async def test_safe_begin_nested_handles_begin_nested_exception(self):
        """Verify _safe_begin_nested handles immediate begin_nested() exception (e.g. transaction already aborted)."""
        mock_db = MagicMock()
        mock_db.begin_nested.side_effect = DBAPIError("...", {}, Exception("current transaction is aborted"))

        entered = False
        async with _safe_begin_nested(mock_db):
            entered = True

        self.assertTrue(entered, "Context block must be entered safely without raising during begin_nested()")
