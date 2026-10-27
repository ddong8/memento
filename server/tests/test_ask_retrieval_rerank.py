"""Tests for enhanced retrieval ranking and similarity weighting."""

import uuid
from unittest.mock import AsyncMock, patch
import pytest

from server.services.ask_retrieval import fuse_ranks, hybrid_rank
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
async def test_subagent_transcripts_do_not_leapfrog_by_path():
    """A path containing "agent" / "rule" is no reason to outrank a better match.

    The old 1.8x path boost matched every Claude Code subagent transcript (75% of all documents)
    and dropped the evaluation's MRR from 0.42 to 0.28."""
    user = User(id=uuid.uuid4(), email="test@example.com")
    doc_answer = Document(
        id=uuid.uuid4(),
        title="Fleet 卡住时强制重同步",
        relative_path="projects/memento/5f1c.jsonl",
        tool_id="claude_code",
    )
    doc_subagent = Document(
        id=uuid.uuid4(),
        title="Explore fleet rules",
        relative_path="projects/memento/5f1c/subagents/agent-a4893f4f37a1cd1c5.jsonl",
        tool_id="claude_code",
    )

    db = FakeDb([doc_subagent])

    with patch("server.services.ask_retrieval.user_machine_ids", new=AsyncMock(return_value=["m1"])), \
         patch("server.services.ask_retrieval.async_session_factory") as mock_factory, \
         patch("server.services.ask_retrieval._semantic_doc_ranks") as mock_sem:

        mock_factory.return_value.__aenter__.return_value = FakeDb([doc_answer, doc_subagent])
        mock_sem.return_value = (
            [doc_answer.id, doc_subagent.id],
            {doc_answer.id: "snippet1", doc_subagent.id: "snippet2"},
            {doc_answer.id: 0.85, doc_subagent.id: 0.84},
        )

        ranked, _, _, _ = await hybrid_rank(
            db, user, q="fleet 卡住怎么办", tool=None, days=None, k=2
        )

        assert [d.id for d in ranked] == [doc_answer.id, doc_subagent.id]


def _doc(title="", path="notes/x.md"):
    return Document(id=uuid.uuid4(), title=title, relative_path=path, tool_id="claude_code")


def test_fusion_is_rank_only():
    """Similarity values don't enter the score: a document second in both channels beats one
    that is first in semantic only, however close the cosine similarities are."""
    a, b, c = _doc("a"), _doc("b"), _doc("c")
    ranked = fuse_ranks([a, b, c], kw_ids=[a.id, b.id], sem_ids=[c.id, b.id], q="怎么配置")
    assert ranked[0] is b
    # Each channel's own winner still beats a document neither channel returned well
    assert fuse_ranks([c, a], kw_ids=[a.id], sem_ids=[], q="怎么配置") == [a, c]


def test_exact_tokens_favor_keyword():
    """A commit hash / CAS number / file name in the question tilts fusion toward keyword."""
    kw, sem = _doc("kw"), _doc("sem")
    assert fuse_ranks([sem, kw], kw_ids=[kw.id], sem_ids=[sem.id], q="4c40b6cd 改了什么")[0] is kw
    assert fuse_ranks([sem, kw], kw_ids=[kw.id], sem_ids=[sem.id], q="64-17-5 的沸点")[0] is kw
