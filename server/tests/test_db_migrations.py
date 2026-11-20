"""Tests for standalone versioned database migration runner."""

from __future__ import annotations

import sqlite3
import unittest
from unittest.mock import AsyncMock, MagicMock

from server.db import migrations


class TestDbMigrations(unittest.IsolatedAsyncioTestCase):
    def test_record_schema_version_is_idempotent(self):
        conn = sqlite3.connect(":memory:")
        try:
            class _SqlAlchemyLikeConn:
                def execute(self, stmt, params=None):
                    sql = str(stmt).replace(":v", "?").replace("TIMESTAMP WITH TIME ZONE", "TEXT")
                    return conn.execute(sql, (params["v"],) if params else ())

            wrapper = _SqlAlchemyLikeConn()
            migrations._record_schema_version(wrapper, "20261120_001_baseline")
            migrations._record_schema_version(wrapper, "20261120_001_baseline")
            rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
            self.assertEqual(rows, [("20261120_001_baseline",)])
        finally:
            conn.close()

    async def test_check_schema_ready_queries_machines(self):
        mock_conn = MagicMock(execute=AsyncMock())
        ctx = AsyncMock()
        ctx.__aenter__.return_value = mock_conn
        ctx.__aexit__.return_value = None
        mock_engine = MagicMock(connect=MagicMock(return_value=ctx))

        self.assertTrue(await migrations.check_schema_ready(mock_engine))
        mock_conn.execute.assert_awaited_once()

    def test_main_reexports_run_migrations_for_backward_compatibility(self):
        from server import main
        self.assertIs(main._run_migrations, migrations._run_migrations)
        self.assertEqual(main._MIGRATION_LOCK_ID, migrations.MIGRATION_LOCK_ID)


if __name__ == "__main__":
    unittest.main()
