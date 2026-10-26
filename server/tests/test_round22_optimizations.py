from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch
import uuid
import pytest
from sqlalchemy import Index

from server.db.models import Document, DocumentVersion, Machine
from server.api.daily import get_daily_summary
from server.api.memory import get_memory_stats


def test_round22_model_indexes_defined():
    """Verify Round 22 indexes are defined on SQLAlchemy models."""
    # Machine table args
    machine_indexes = {idx.name: idx for idx in Machine.__table_args__ if isinstance(idx, Index)}
    assert "idx_machines_collector_token_hash" in machine_indexes
    assert "idx_machines_user_id" in machine_indexes

    # Document table args
    doc_indexes = {idx.name: idx for idx in Document.__table_args__ if isinstance(idx, Index)}
    assert "idx_documents_metadata_session_id" in doc_indexes
    assert "idx_documents_metadata_cascade_id" in doc_indexes

    # DocumentVersion table args
    doc_version_indexes = {idx.name: idx for idx in DocumentVersion.__table_args__ if isinstance(idx, Index)}
    assert "idx_doc_versions_doc_synced" in doc_version_indexes


@pytest.mark.asyncio
async def test_get_daily_summary_optimized_query():
    """Verify get_daily_summary queries single newest timestamp with order_by desc limit 1."""
    mock_db = AsyncMock()
    user = MagicMock()
    user.role = "owner"
    user.id = uuid.uuid4()

    mock_summary = MagicMock()
    mock_summary.title = "每日摘要"
    mock_summary.summary = "工作进展总结"
    mock_summary.highlights = ["完成深度优化"]
    mock_summary.created_at = datetime.now(timezone.utc) - timedelta(hours=2)

    now = datetime.now(timezone.utc)

    # First call: summary query; Second call: newest message query
    mock_db.execute.side_effect = [
        MagicMock(scalar_one_or_none=MagicMock(return_value=mock_summary)),
        MagicMock(scalar=MagicMock(return_value=now)),
    ]

    with patch("server.api.daily.user_machine_ids", AsyncMock(return_value=None)):
        res = await get_daily_summary(
            date_str="2026-10-25",
            db=mock_db,
            _user=user,
        )

    assert res["date"] == "2026-10-25"
    assert res["title"] == "每日摘要"
    assert res["stale"] is True
    assert res["newest_message_at"] == now.isoformat()
    assert mock_db.execute.call_count == 2


@pytest.mark.asyncio
async def test_get_memory_stats_optimized():
    """Verify get_memory_stats derives entities from entity_types without extra count query and caches 300s."""
    mock_db = AsyncMock()
    user = MagicMock()
    user.role = "owner"
    user.id = uuid.uuid4()

    # 1st call: type_q; 2nd: rel_q; 3rd: obs_q; 4th: emb_q
    mock_db.execute.side_effect = [
        MagicMock(all=MagicMock(return_value=[("concept", 15), ("person", 5)])),
        MagicMock(scalar=MagicMock(return_value=42)),
        MagicMock(scalar=MagicMock(return_value=88)),
        MagicMock(scalar=MagicMock(return_value=120)),
    ]

    with patch("server.api.memory.cache_get", AsyncMock(return_value=None)), \
         patch("server.api.memory.cache_set", AsyncMock()) as mock_cache_set:
        res = await get_memory_stats(db=mock_db, _user=user)

    assert res["entities"] == 20
    assert res["entity_types"] == {"concept": 15, "person": 5}
    assert res["relations"] == 42
    assert res["observations"] == 88
    assert res["embeddings"] == 120
    assert mock_db.execute.call_count == 4
    mock_cache_set.assert_awaited_once_with(
        f"memory:stats:{user.id}:True",
        res,
        ttl_seconds=300,
    )
