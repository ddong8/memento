from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock
import uuid

from server.services.todo_service import clean_title, fingerprint, parse_due, todo_counts
from server.db.models import User


class TodoServiceUnitTests(unittest.IsolatedAsyncioTestCase):
    def test_clean_title(self) -> None:
        self.assertEqual(clean_title("  hello   world  "), "hello world")
        self.assertEqual(clean_title(None), "")
        self.assertEqual(clean_title("a" * 300), "a" * 200)

    def test_fingerprint(self) -> None:
        fp1 = fingerprint("Buy milk!")
        fp2 = fingerprint("buy milk")
        self.assertEqual(fp1, fp2)

    def test_parse_due(self) -> None:
        dt = parse_due("2026-10-20")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.year, 2026)
        self.assertEqual(dt.month, 10)
        self.assertEqual(dt.day, 20)
        self.assertIsNone(parse_due("invalid"))
        self.assertIsNone(parse_due(None))

    async def test_todo_counts_conditional_aggregation(self) -> None:
        mock_row = MagicMock()
        mock_row.open_n = 5
        mock_row.overdue = 2
        mock_row.done = 10
        mock_row.added = 8

        mock_result = MagicMock()
        mock_result.one.return_value = mock_row

        mock_db = AsyncMock()
        mock_db.execute.return_value = mock_result

        user = User(id=uuid.uuid4(), email="test@example.com")
        counts = await todo_counts(mock_db, user)

        self.assertEqual(counts["open"], 5)
        self.assertEqual(counts["overdue"], 2)
        self.assertEqual(counts["done_recent"], 10)
        self.assertEqual(counts["added_recent"], 8)
        mock_db.execute.assert_called_once()
