from unittest.mock import AsyncMock, MagicMock, patch
import uuid
import pytest

from server.services.profile_service import device_projects
from server.api.profile import get_injection as get_profile_injection
from server.api.skills import get_injection as get_skills_injection
from server.api.search import _semantic_doc_ranks


@pytest.mark.asyncio
async def test_device_projects_hits_redis_cache():
    """Verify device_projects returns cached dictionary when present in Redis."""
    mock_db = AsyncMock()
    mock_machine = MagicMock()
    mock_machine.id = uuid.uuid4()

    cached_data = {"test_project": "/Users/test/project"}
    with patch("server.services.profile_service.cache_get", AsyncMock(return_value=cached_data)) as mock_get:
        res = await device_projects(mock_db, mock_machine)
        assert res == cached_data
        mock_get.assert_awaited_once_with(f"dev_projects:{mock_machine.id}:120")
        mock_db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_profile_injection_hits_cache():
    """Verify get_injection in profile.py uses profile_injection cache."""
    mock_db = AsyncMock()
    user = MagicMock()
    user.id = uuid.uuid4()
    device_id = "device-abc"

    cached_resp = {"version": 5, "block": "about me", "targets": ["claude"]}
    with patch("server.api.profile.cache_get", AsyncMock(return_value=cached_resp)) as mock_get:
        res = await get_profile_injection(x_device_id=device_id, db=mock_db, user=user)
        assert res == cached_resp
        mock_get.assert_awaited_once_with(f"profile_injection:{user.id}:{device_id}")
        mock_db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_skills_injection_hits_cache():
    """Verify get_injection in skills.py uses skills_injection cache."""
    mock_db = AsyncMock()
    user = MagicMock()
    user.id = uuid.uuid4()
    device_id = "device-abc"

    cached_resp = {"targets": ["~/.gemini/skills"], "skills": []}
    with patch("server.api.skills.cache_get", AsyncMock(return_value=cached_resp)) as mock_get:
        res = await get_skills_injection(x_device_id=device_id, db=mock_db, user=user)
        assert res == cached_resp
        mock_get.assert_awaited_once_with(f"skills_injection:{user.id}:{device_id}")
        mock_db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_semantic_search_sets_hnsw_ef_search():
    """Verify _semantic_doc_ranks sets hnsw.ef_search for pgvector."""
    mock_db = AsyncMock()
    mock_db.execute.side_effect = [
        MagicMock(),  # SET LOCAL
        MagicMock(all=MagicMock(return_value=[])),  # query
    ]

    with patch("server.services.embedding_service._call_embedding_server", AsyncMock(return_value=[[0.1] * 1024])):
        await _semantic_doc_ranks(
            db=mock_db,
            q="test",
            mids=[uuid.uuid4()],
            tool="claude",
            category="conversation",
            days=30,
            want=10,
        )
        assert mock_db.execute.await_count >= 1
        executed_stmts = [str(call[0][0]) for call in mock_db.execute.await_args_list]
        assert any("SET LOCAL hnsw.ef_search = 32" in stmt for stmt in executed_stmts)
