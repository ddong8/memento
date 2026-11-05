"""Tests for standalone DDL migration runner and skip_ddl environment configuration."""
import unittest
from unittest.mock import AsyncMock, patch
from server.migrate import run_migrations


class TestMigrateStandalone(unittest.IsolatedAsyncioTestCase):
    async def test_standalone_migrate_runs_ddl_and_create_all(self):
        from unittest.mock import MagicMock
        mock_conn = AsyncMock()
        mock_engine = MagicMock()
        cm = MagicMock()
        cm.__aenter__ = AsyncMock(return_value=mock_conn)
        cm.__aexit__ = AsyncMock(return_value=None)
        mock_engine.begin.return_value = cm

        with patch("server.migrate.engine", mock_engine), \
             patch("server.migrate._run_migrations") as mock_run_mig, \
             patch("server.migrate.Base.metadata.create_all") as mock_create_all:

            await run_migrations()
            self.assertEqual(mock_conn.run_sync.call_count, 2)
            mock_conn.run_sync.assert_any_call(mock_run_mig)
            mock_conn.run_sync.assert_any_call(mock_create_all)
