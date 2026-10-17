"""The weekly backup covers every table, parents before children.

The ordering test needs nothing. The dump test runs against a real
PostgreSQL when MEMENTO_TEST_DATABASE_URL points at a throwaway database
(it creates and drops the schema).
"""

from __future__ import annotations

import gzip
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.tasks import db_backup  # noqa: E402


class LoadOrderTests(unittest.TestCase):
    def test_parents_come_first_and_nothing_is_dropped(self) -> None:
        tables = ["documents", "users", "machines", "tools", "todos", "document_embeddings"]
        deps = [("machines", "users"), ("documents", "machines"), ("documents", "tools"),
                ("document_embeddings", "documents"), ("todos", "users"), ("users", "users")]
        order = db_backup.load_order(tables, deps)
        self.assertEqual(sorted(order), sorted(tables))
        for child, parent in deps:
            if child != parent:
                self.assertLess(order.index(parent), order.index(child), (parent, child))

    def test_a_cycle_still_includes_every_table(self) -> None:
        order = db_backup.load_order(["a", "b", "c"], [("a", "b"), ("b", "a")])
        self.assertEqual(sorted(order), ["a", "b", "c"])


DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class DumpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import Base, User

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(self.engine)() as db:
            db.add(User(email="a@example.com", role="owner", status="active"))
            await db.commit()

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def test_every_model_table_is_dumped_in_load_order(self) -> None:
        from server.db.models import Base

        with tempfile.TemporaryFile() as f:
            counts = await db_backup._dump_async(f, dsn=DB_URL.replace("postgresql+asyncpg://", "postgresql://", 1))
            f.seek(0)
            body = gzip.decompress(f.read()).decode()

        dumped = re.findall(r"^-- TABLE: (\w+) \((\d+) rows\)$", body, flags=re.M)
        names = [n for n, _ in dumped]
        self.assertFalse(set(Base.metadata.tables) - set(names), "tables missing from the dump")
        self.assertEqual(counts["users"], 1)
        for table in Base.metadata.sorted_tables:  # SQLAlchemy's own FK order
            for fk in table.foreign_keys:
                parent = fk.column.table.name
                if parent != table.name:
                    self.assertLess(names.index(parent), names.index(table.name), (parent, table.name))


if __name__ == "__main__":
    unittest.main()
