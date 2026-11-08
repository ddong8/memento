"""The keyword channel picks candidates by a question's rare terms and ranks them by every term's idf."""

from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.dialects import postgresql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.services import ask_retrieval, fulltext  # noqa: E402


def _params(expr) -> list:
    return list(expr.compile(dialect=postgresql.dialect()).params.values())


class KeywordMatchTests(unittest.IsolatedAsyncioTestCase):
    async def match(self, n: int, df: dict[str, int], terms: list[str]):
        with patch.object(fulltext, "_doc_freq", AsyncMock(return_value=(n, df))):
            return await fulltext.keyword_match(None, terms)

    async def test_rare_terms_pick_the_candidates_and_every_term_ranks_them(self) -> None:
        # The eval question "k8s 仓库里 k8tz 是干什么用的": 仓库/k8s fill long conversations, k8tz is in one note
        tsquery, rank = await self.match(6545, {"k8s": 900, "仓库": 1200, "k8tz": 3, "干什么": 0},
                                         ["k8s", "仓库", "k8tz", "干什么"])
        self.assertEqual(tsquery, "k8tz")
        params = _params(rank)
        self.assertEqual([p for p in params if isinstance(p, str) and p != "simple"], ["k8s", "仓库", "k8tz"])
        weights = sorted(p for p in params if isinstance(p, float))
        self.assertEqual(len(weights), 3)
        self.assertGreater(weights[-1], 7)  # k8tz
        self.assertLess(weights[0], 2.5)  # 仓库

    async def test_a_question_of_common_words_keeps_plain_ts_rank_over_all_of_them(self) -> None:
        tsquery, rank = await self.match(6545, {"项目": 4000, "接口": 2500}, ["项目", "接口"])
        self.assertEqual(tsquery, "项目 | 接口")
        self.assertIn("项目 | 接口", _params(rank))
        self.assertFalse(any(isinstance(p, float) for p in _params(rank)))

    async def test_terms_no_document_has_match_nothing(self) -> None:
        tsquery, _ = await self.match(10, {"氪星石": 0}, ["氪星石"])
        self.assertEqual(tsquery, "氪星石")

    def test_idf_falls_with_document_frequency(self) -> None:
        self.assertGreater(fulltext._idf(6545, 1), 8)
        self.assertAlmostEqual(fulltext._idf(6545, 6545 // 2), 0.69, places=1)
        self.assertGreater(fulltext._idf(6545, 3), fulltext._idf(6545, 300))


class DocFreqCacheTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        fulltext._df_cache.clear()
        fulltext._n_cache = None

    tearDown = setUp

    async def test_counts_are_reused_except_zeros(self) -> None:
        db = AsyncMock()
        db.execute.return_value = SimpleNamespace(one=lambda: (100, 7, 0))
        self.assertEqual(await fulltext._doc_freq(db, ["部署", "新词"]), (100, {"部署": 7, "新词": 0}))
        db.execute.return_value = SimpleNamespace(one=lambda: (101, 2))
        # 部署 from the cache; 新词 had no document yet, so it is counted again
        self.assertEqual(await fulltext._doc_freq(db, ["部署", "新词"]), (101, {"部署": 7, "新词": 2}))
        calls = db.execute.await_count
        self.assertEqual(await fulltext._doc_freq(db, ["部署", "新词"]), (101, {"部署": 7, "新词": 2}))
        self.assertEqual(db.execute.await_count, calls)


class HybridRankUsesTheIndexTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_keyword_query_runs_with_seqscan_off_and_the_rare_terms(self) -> None:
        user = SimpleNamespace(id=uuid.uuid4())
        statements: list = []
        result = MagicMock()
        result.scalars.return_value.all.return_value = []

        async def execute(stmt, *a, **kw):
            statements.append(stmt)
            return result

        session = AsyncMock()
        session.execute.side_effect = execute
        factory = MagicMock()
        factory.return_value.__aenter__.return_value = session
        match = AsyncMock(return_value=("k8tz", fulltext.func.ts_rank(fulltext.DocumentSearch.content_tsv, "x")))
        with patch.object(ask_retrieval, "user_machine_ids", AsyncMock(return_value=["m1"])), \
                patch.object(ask_retrieval, "async_session_factory", factory), \
                patch.object(ask_retrieval, "keyword_match", match), \
                patch.object(ask_retrieval, "_semantic_doc_ranks", AsyncMock(return_value=([], {}, {}))), \
                patch("server.services.cache.cache_get", AsyncMock(return_value=None)), \
                patch("server.services.cache.cache_set", AsyncMock()):
            await ask_retrieval.hybrid_rank(session, user, "k8s 仓库里 k8tz 是干什么用的？", None, None, k=10)
        self.assertEqual(str(statements[0]), "SET LOCAL enable_seqscan = off")
        self.assertEqual(match.await_args.args[1], ["k8s", "仓库", "k8tz", "干什么"])
        self.assertIn("k8tz", _params(statements[-1]))


if __name__ == "__main__":
    unittest.main()
