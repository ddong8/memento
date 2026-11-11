"""Today / the last N days mean when a document's content happened, not when it was uploaded (#7).

A collector's first sync uploads months of history at once; filtered by synced_at, "summarize what I
did today" answered with weeks-old conversations."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.dialects import postgresql

from server.db.models import Document, User, document_happened_at
from server.services.conversation_parser import StoredMessage
from server.services.ingest_service import _latest_time, _set_source_time

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
AUG = datetime(2026, 8, 8, 10, 0, tzinfo=timezone.utc)
OCT = datetime(2026, 10, 1, 10, 0, tzinfo=timezone.utc)


def _doc(category="conversation", when=None):
    return SimpleNamespace(category=category, source_modified_at=when)


def test_first_sync_of_old_history_keeps_its_own_time():
    # Created this sync without the collector's time: the sync-time placeholder gives way
    d = _doc(when=NOW)
    _set_source_time(d, None, AUG, NOW, created=True)
    assert d.source_modified_at == AUG
    # With the collector's mtime: the later of the two
    d = _doc(when=OCT)
    _set_source_time(d, OCT.timestamp(), AUG, NOW, created=True)
    assert d.source_modified_at == OCT


def test_a_slice_only_moves_it_forward():
    # A log sent again from the start comes in slices, each older than the last line
    d = _doc(when=OCT)
    _set_source_time(d, None, AUG, NOW, created=False)
    assert d.source_modified_at == OCT
    _set_source_time(d, None, NOW - timedelta(minutes=5), NOW, created=False)
    assert d.source_modified_at == NOW - timedelta(minutes=5)


def test_never_in_the_future():
    d = _doc(when=None)
    _set_source_time(d, (NOW + timedelta(days=3)).timestamp(), None, NOW, created=False)
    assert d.source_modified_at == NOW


def test_without_any_time():
    # An older collector updating a conversation: kept until a message says otherwise
    d = _doc(when=OCT)
    _set_source_time(d, None, None, NOW, created=False)
    assert d.source_modified_at == OCT
    # Any other document it sends changed now
    d = _doc("memory", when=OCT)
    _set_source_time(d, None, None, NOW, created=False)
    assert d.source_modified_at == NOW


def test_latest_time_of_a_slice():
    def m(ts):
        return StoredMessage("user", "user", "x", {}, ts, "k")

    assert _latest_time([]) is None
    assert _latest_time([m(None)]) is None
    naive = AUG.replace(tzinfo=None)
    assert _latest_time([m(OCT), m(None), m(naive)]) == OCT


def test_happened_at_falls_back_to_the_sync_time():
    d = Document(synced_at=NOW, source_modified_at=AUG)
    assert document_happened_at(d) == AUG.isoformat()
    d = Document(synced_at=NOW, source_modified_at=None)
    assert document_happened_at(d) == NOW.isoformat()


@pytest.mark.asyncio
async def test_retrieval_filters_and_orders_by_when_it_happened():
    from server.services import ask_retrieval

    seen: list[str] = []
    res = MagicMock()
    res.scalars.return_value.all.return_value = []

    async def execute(stmt, *a, **k):
        seen.append(str(stmt.compile(dialect=postgresql.dialect())))
        return res

    session = AsyncMock()
    session.execute.side_effect = execute

    def factory():
        cm = AsyncMock()
        cm.__aenter__.return_value = session
        return cm

    user = User(id=uuid.uuid4(), email="u@test.com", status="active")
    with patch.object(ask_retrieval, "async_session_factory", side_effect=factory), \
         patch.object(ask_retrieval, "user_machine_ids", new=AsyncMock(return_value=["m"])), \
         patch.object(ask_retrieval, "_semantic_doc_ranks", new=AsyncMock(return_value=([], {}, {}))), \
         patch("server.services.fulltext._doc_freq", new=AsyncMock(return_value=(0, {}))), \
         patch("server.services.cache.cache_get", new=AsyncMock(return_value=None)), \
         patch("server.services.cache.cache_set", new=AsyncMock()):
        await ask_retrieval.hybrid_rank(session, user, "今天的主要工作", None, 1)

    sql = next(s for s in seen if "FROM documents" in s)
    where, _, order = sql.partition("ORDER BY")
    happened = "coalesce(documents.source_modified_at, documents.synced_at)"
    assert f"{happened} >=" in where
    assert "documents.synced_at >=" not in where
    assert happened in order

