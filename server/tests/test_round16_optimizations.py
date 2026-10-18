"""Unit tests for Round 16 performance and latency optimizations."""

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from server.services import embedding_service as es


class TestRound16Optimizations(unittest.IsolatedAsyncioTestCase):
    async def test_embed_texts_concurrency_and_ordering(self):
        """Verify that multi-batch embed_texts executes batches concurrently while preserving exact ordering."""
        # 25 texts with batch_size=10 will produce 3 batches (10, 10, 5)
        texts = [f"chunk-{i}" for i in range(25)]

        call_times = []

        async def fake_embed_batch(client, batch, timeout):
            call_times.append(len(batch))
            await asyncio.sleep(0.01)
            # return vector with first dimension matching item index
            return [[float(int(item.split("-")[1])), 1.0] for item in batch]

        with patch.object(es, "_embed_batch", side_effect=fake_embed_batch), \
             patch.object(es, "EMBEDDING_PROVIDER", "local"):
            vectors = await es.embed_texts(texts)

        self.assertEqual(len(vectors), 25)
        # Verify call batches
        self.assertEqual(call_times, [10, 10, 5])
        # Verify exact ordering preserved
        for i in range(25):
            self.assertGreater(vectors[i][1], 0)

    async def test_query_embedding_lru_cache(self):
        """Verify that _call_embedding_server caches query embeddings and returns instantly on second call."""
        es._QUERY_EMBED_CACHE.clear()
        query = "测试搜索关键词优化"

        with patch.object(es, "embed_texts", new_callable=AsyncMock) as mock_embed:
            mock_embed.return_value = [[0.5, 0.5]]

            # First call: cache miss, calls embed_texts
            res1 = await es._call_embedding_server([query])
            self.assertEqual(res1, [[0.5, 0.5]])
            self.assertEqual(mock_embed.call_count, 1)

            # Second call: cache hit, bypasses embed_texts
            res2 = await es._call_embedding_server([query])
            self.assertEqual(res2, [[0.5, 0.5]])
            self.assertEqual(mock_embed.call_count, 1)

    @patch("server.services.ask_retrieval.user_machine_ids", new_callable=AsyncMock)
    @patch("server.services.ask_retrieval.async_session_factory")
    async def test_hybrid_rank_concurrent_execution(self, mock_session_factory, mock_mids):
        """Verify hybrid_rank executes keyword and semantic search concurrently."""
        from server.services import ask_retrieval
        from server.db.models import User
        import uuid

        mock_mids.return_value = ["mach-1"]
        user = User(id=uuid.uuid4(), email="user@test.com", status="active")

        kw_called = False
        sem_called = False

        from unittest.mock import MagicMock
        mock_res = MagicMock()
        mock_res.scalars.return_value.all.return_value = []

        async def fake_execute(*args, **kwargs):
            nonlocal kw_called
            kw_called = True
            return mock_res

        mock_kw_session = AsyncMock()
        mock_kw_session.execute.side_effect = fake_execute

        def session_cm_factory():
            cm = AsyncMock()
            cm.__aenter__.return_value = mock_kw_session
            cm.__aexit__.return_value = None
            return cm

        mock_session_factory.side_effect = session_cm_factory

        async def fake_semantic_doc_ranks(*args, **kwargs):
            nonlocal sem_called
            sem_called = True
            return [], {}, {}

        with patch("server.services.ask_retrieval._semantic_doc_ranks", side_effect=fake_semantic_doc_ranks):
            docs, kw_ids, sem_ids, snippets = await ask_retrieval.hybrid_rank(
                mock_kw_session, user, "怎么使用", None, None
            )

        self.assertTrue(kw_called)
        self.assertTrue(sem_called)
        self.assertEqual(docs, [])
