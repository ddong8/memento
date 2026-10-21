"""Tests for enhanced retrieval ranking and similarity weighting."""

import uuid
from unittest.mock import AsyncMock, patch
import pytest

from server.services.ask_retrieval import hybrid_rank
from server.db.models import Document, User


class FakeScalarResult:
    def __init__(self, items):
        self._items = items

    def all(self):
        return self._items

    def scalars(self):
        return self


class FakeDb:
    def __init__(self, docs):
        self._docs = docs

    async def execute(self, stmt):
        return FakeScalarResult(self._docs)


@pytest.mark.asyncio
async def test_hybrid_rank_synergy_boost():
    """Verify that a document matching both keyword and semantic ranks receives synergy boost."""
    user = User(id=uuid.uuid4(), email="test@example.com")
    doc_both = Document(
        id=uuid.uuid4(),
        title="Redis cluster configuration guide",
        relative_path="deploy/k8s/redis.yaml",
        tool_id="antigravity",
    )
    doc_kw_only = Document(
        id=uuid.uuid4(),
        title="Redis notes",
        relative_path="notes/redis.txt",
        tool_id="antigravity",
    )
    doc_sem_only = Document(
        id=uuid.uuid4(),
        title="Cluster state overview",
        relative_path="docs/cluster.md",
        tool_id="antigravity",
    )

    db = FakeDb([doc_both, doc_kw_only, doc_sem_only])

    with patch("server.services.ask_retrieval.user_machine_ids", new=AsyncMock(return_value=["m1"])), \
         patch("server.services.ask_retrieval.async_session_factory") as mock_factory, \
         patch("server.services.ask_retrieval._semantic_doc_ranks") as mock_sem:

        mock_factory.return_value.__aenter__.return_value = FakeDb([doc_both, doc_kw_only])
        mock_sem.return_value = (
            [doc_both.id, doc_sem_only.id],
            {doc_both.id: "snippet", doc_sem_only.id: "snippet2"},
            {doc_both.id: 0.95, doc_sem_only.id: 0.90},
        )

        ranked, kw_order, sem_order, snippets = await hybrid_rank(
            db, user, q="redis cluster", tool=None, days=None, k=3
        )

        assert len(ranked) >= 2
        # doc_both should rank first because of dual-channel hit + title match bonus
        assert ranked[0].id == doc_both.id
        assert doc_both.id in kw_order
        assert doc_both.id in sem_order


@pytest.mark.asyncio
async def test_hybrid_rank_rule_priority_boost():
    """Verify that architecture guidelines and iron rules receive dynamic priority boost."""
    user = User(id=uuid.uuid4(), email="test@example.com")
    doc_rule = Document(
        id=uuid.uuid4(),
        title="AGENTS.md 工程铁律与发布规范",
        relative_path="docs/AGENTS.md",
        tool_id="antigravity",
    )
    doc_regular = Document(
        id=uuid.uuid4(),
        title="日常部署笔记",
        relative_path="notes/deploy.txt",
        tool_id="antigravity",
    )

    db = FakeDb([doc_regular, doc_rule])

    with patch("server.services.ask_retrieval.user_machine_ids", new=AsyncMock(return_value=["m1"])), \
         patch("server.services.ask_retrieval.async_session_factory") as mock_factory, \
         patch("server.services.ask_retrieval._semantic_doc_ranks") as mock_sem:

        mock_factory.return_value.__aenter__.return_value = FakeDb([doc_regular, doc_rule])
        # Even if regular doc has slightly earlier semantic rank, doc_rule gets 1.8x boost
        mock_sem.return_value = (
            [doc_regular.id, doc_rule.id],
            {doc_regular.id: "snippet1", doc_rule.id: "snippet2"},
            {doc_regular.id: 0.85, doc_rule.id: 0.84},
        )

        ranked, _, _, _ = await hybrid_rank(
            db, user, q="deploy rules", tool=None, days=None, k=2
        )

        assert len(ranked) == 2
        # doc_rule should leapfrog to rank #0 due to 1.8x rule priority boost
        assert ranked[0].id == doc_rule.id
