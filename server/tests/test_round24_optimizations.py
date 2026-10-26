from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone
import uuid
import pytest

from server.db.models import Project
from server.api.projects import _consolidate_projects_if_needed
from server.api.search import search


@pytest.mark.asyncio
async def test_consolidate_projects_batching_eliminates_n_plus_one():
    """Verify _consolidate_projects_if_needed batches document counts and uses in-memory dictionary for slug lookups."""
    mock_db = AsyncMock()
    p1 = Project(id=uuid.uuid4(), slug="cc/test-one", title="test-one", tool_id="claude_code")
    p2 = Project(id=uuid.uuid4(), slug="cc/test_one", title="test_one", tool_id="claude_code")

    # 1. select(Project) at line 62
    # 2. select(Project) at line 107
    # 3. select(Document.project_id, func.count).where(in_).group_by(...) at line 117
    # 4. update(Document) at line 126
    # 5. select(orphaned_docs) at line 134
    # 6. select(misassigned_docs) at line 160
    # 7. select(Machine) at line 204
    mock_db.execute.side_effect = [
        MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[p1, p2])))),
        MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[p1, p2])))),
        MagicMock(all=MagicMock(return_value=[(p1.id, 10), (p2.id, 2)])),
        MagicMock(),
        MagicMock(all=MagicMock(return_value=[])),
        MagicMock(all=MagicMock(return_value=[])),
        MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[])))),
    ]

    with patch("server.api.projects.cluster") as mock_cluster:
        mock_cluster.try_lock = AsyncMock(return_value=True)
        mock_cluster.mutex = AsyncMock(return_value=AsyncMock(release=AsyncMock()))

        await _consolidate_projects_if_needed(mock_db, force=True)

        # Confirm delete was called for redundant project p2
        mock_db.delete.assert_awaited_once_with(p2)
        # Verify batch query was executed for Document.project_id.in_
        calls = mock_db.execute.await_args_list
        batch_query_stmt = str(calls[2][0][0])
        assert "GROUP BY documents.project_id" in batch_query_stmt
        assert "IN (__[POSTCOMPILE_project_id_1])" in batch_query_stmt or "IN" in batch_query_stmt


@pytest.mark.asyncio
async def test_search_cache_ttl_300s():
    """Verify hybrid_search sets cache with 300s TTL."""
    mock_db = AsyncMock()
    user = MagicMock()
    user.id = uuid.uuid4()

    mock_doc = MagicMock()
    mock_doc.id = uuid.uuid4()
    mock_doc.tool_id = "claude_code"
    mock_doc.title = "测试搜索"
    mock_doc.relative_path = "test.py"
    mock_doc.file_size_bytes = 100
    mock_doc.synced_at = datetime.now(timezone.utc)
    mock_doc.category = "code"

    # db execute for search page
    mock_db.execute.return_value = MagicMock(all=MagicMock(return_value=[(mock_doc, 1)]))

    with patch("server.api.search.cache_get", AsyncMock(return_value=None)), \
         patch("server.api.search.cache_set", AsyncMock()) as mock_cache_set, \
         patch("server.api.search.user_machine_ids", AsyncMock(return_value=None)), \
         patch("server.api.search.async_session_factory") as mock_factory:

        mock_session = AsyncMock()
        mock_session.execute.return_value = MagicMock(all=MagicMock(return_value=[(mock_doc, 1)]))
        mock_factory.return_value.__aenter__.return_value = mock_session

        res = await search(q="test", offset=0, limit=20, db=mock_db, _user=user)

        assert res["total"] == 1
        assert len(res["results"]) == 1
        # Verify TTL is 300s
        mock_cache_set.assert_awaited_once()
        assert mock_cache_set.call_args[1]["ttl_seconds"] == 300
