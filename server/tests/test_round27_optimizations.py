from unittest.mock import AsyncMock, MagicMock
import uuid
import pytest
from starlette.datastructures import Headers

from server.api.ask_conversations import get_conversation
from server.services.mind_resonance_service import _fetch_graph_entities


@pytest.mark.asyncio
async def test_get_conversation_cursor_pagination_before():
    """Verify get_conversation with before parameter performs cursor slice."""
    mock_db = AsyncMock()
    mock_user = MagicMock()
    mock_user.id = uuid.uuid4()
    conv_id = str(uuid.uuid4())

    mock_conv = MagicMock()
    mock_conv.id = uuid.UUID(conv_id)
    mock_conv.user_id = mock_user.id
    mock_conv.title = "长会话测试"
    mock_conv.message_count = 100
    mock_conv.config = {"execution_mode": "claude"}
    mock_conv.device_id = "mac"
    mock_conv.cwd = "/app"
    mock_conv.created_at = None
    mock_conv.updated_at = None

    # First query loads metadata without turns
    mock_meta_result = MagicMock()
    mock_meta_result.scalars.return_value.first.return_value = mock_conv

    # Sliced query returns 40 turns
    sliced_turns = [{"role": "user", "content": f"msg {i}"} for i in range(40)]
    mock_slice_result = MagicMock()
    mock_slice_result.scalar.return_value = sliced_turns

    mock_db.execute.side_effect = [
        mock_meta_result,
        mock_slice_result,
    ]

    mock_request = MagicMock()
    mock_request.headers = Headers({})
    mock_response = MagicMock()
    mock_response.headers = {}

    res = await get_conversation(
        conv_id=conv_id,
        request=mock_request,
        response=mock_response,
        limit=40,
        before=80,
        db=mock_db,
        _user=mock_user,
    )

    assert res["id"] == conv_id
    assert res["total_turns"] == 100
    assert len(res["turns"]) == 40
    # before=80, limit=40 => end=79, start=max(0, 79-40+1)=40, offset=40
    assert res["offset"] == 40
    assert res["has_more"] is True
    assert res["turns"][0]["index"] == 40
    assert res["turns"][-1]["index"] == 79


@pytest.mark.asyncio
async def test_get_conversation_cursor_pagination_before_zero():
    """Verify get_conversation with before=0 returns empty list with has_more=False."""
    mock_db = AsyncMock()
    mock_user = MagicMock()
    mock_user.id = uuid.uuid4()
    conv_id = str(uuid.uuid4())

    mock_conv = MagicMock()
    mock_conv.id = uuid.UUID(conv_id)
    mock_conv.user_id = mock_user.id
    mock_conv.title = "已到顶部测试"
    mock_conv.message_count = 100
    mock_conv.config = {}
    mock_conv.device_id = "mac"
    mock_conv.cwd = "/app"
    mock_conv.created_at = None
    mock_conv.updated_at = None

    mock_meta_result = MagicMock()
    mock_meta_result.scalars.return_value.first.return_value = mock_conv
    mock_db.execute.side_effect = [mock_meta_result]

    mock_request = MagicMock()
    mock_request.headers = Headers({})
    mock_response = MagicMock()
    mock_response.headers = {}

    res = await get_conversation(
        conv_id=conv_id,
        request=mock_request,
        response=mock_response,
        limit=40,
        before=0,
        db=mock_db,
        _user=mock_user,
    )

    assert res["id"] == conv_id
    assert res["turns"] == []
    assert res["has_more"] is False
    assert res["offset"] == 0


@pytest.mark.asyncio
async def test_mind_resonance_uses_combined_regex_query():
    """Verify domain_and_entity_resonance executes single combined GIN regex query."""
    mock_db = AsyncMock()
    mock_user = MagicMock()
    mock_user.id = uuid.uuid4()

    mock_query_result = MagicMock()
    mock_query_result.scalars.return_value.all.return_value = []
    mock_db.execute.return_value = mock_query_result

    entities = await _fetch_graph_entities(
        db=mock_db,
        user=mock_user,
        terms=["fastapi", "docker", "redis"],
        limit_entities=10,
        rank_terms=None,
        target_project=None,
    )

    assert isinstance(entities, list)
    assert mock_db.execute.await_count >= 1

    # Check executed query contains op '~*'
    executed_stmt = str(mock_db.execute.await_args_list[0][0][0])
    assert "~*" in executed_stmt
    # Written as idx_knowledge_entities_search_trgm is defined, constants inline, or the index can't serve it
    assert "(knowledge_entities.name || ' ' || coalesce(knowledge_entities.summary, ''))" in executed_stmt
    # Entities named by a term rank first in the candidate set
    assert "CASE WHEN (knowledge_entities.name ~*" in executed_stmt
