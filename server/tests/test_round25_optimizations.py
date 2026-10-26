from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone
import uuid
import pytest

from server.api.ask_conversations import get_conversation
from server.services.ask_store import infer_conversation_config


@pytest.mark.asyncio
async def test_get_conversation_slices_turns_at_db_level():
    """Verify get_conversation with limit > 0 uses jsonb_path_query_array and defers full turns."""
    mock_db = AsyncMock()
    user = MagicMock()
    user.id = uuid.uuid4()
    cid = uuid.uuid4()

    mock_conv = MagicMock()
    mock_conv.id = cid
    mock_conv.user_id = user.id
    mock_conv.title = "测试会话"
    mock_conv.device_id = "device-1"
    mock_conv.cwd = "/test"
    mock_conv.created_at = datetime.now(timezone.utc)
    mock_conv.updated_at = datetime.now(timezone.utc)
    mock_conv.message_count = 100
    mock_conv.config = {"session_id": "sess-1", "execution_mode": "antigravity"}

    # 1. select(AskConversation).options(defer(AskConversation.turns))
    # 2. select(jsonb_path_query_array)
    sample_sliced_turns = [{"role": "user", "content": "hello"}]
    mock_db.execute.side_effect = [
        MagicMock(scalars=MagicMock(return_value=MagicMock(first=MagicMock(return_value=mock_conv)))),
        MagicMock(scalar=MagicMock(return_value=sample_sliced_turns)),
    ]

    mock_request = MagicMock()
    mock_request.headers = {}
    mock_response = MagicMock()
    mock_response.headers = {}

    with patch("server.api.ask_conversations.recover_orphaned_tasks_for_conv", AsyncMock(return_value=None)), \
         patch("server.api.ask_conversations.lookup_project_title", AsyncMock(return_value="")):

        res = await get_conversation(
            conv_id=str(cid),
            request=mock_request,
            response=mock_response,
            limit=40,
            db=mock_db,
            _user=user,
        )

        assert res["id"] == str(cid)
        assert res["has_more"] is True
        assert res["total_turns"] == 100
        assert len(res["turns"]) == 1

        # Check DB call queries
        calls = mock_db.execute.await_args_list
        second_stmt = str(calls[1][0][0])
        assert "jsonb_path_query_array" in second_stmt
        assert any("$[last - 39 to last]" in str(v) for v in calls[1][0][0].compile().params.values())


def test_infer_conversation_config_fast_exit():
    """Verify infer_conversation_config exits immediately when config is already complete."""
    conv = MagicMock()
    conv.config = {
        "execution_mode": "antigravity",
        "session_id": "sess-123",
        "device_id": "dev-1",
        "cwd": "/app",
    }
    conv.device_id = "dev-1"
    conv.cwd = "/app"
    # turns should never be accessed
    type(conv).turns = property(lambda self: (_ for _ in ()).throw(RuntimeError("turns should not be accessed")))

    cfg, inferred = infer_conversation_config(conv)
    assert cfg["execution_mode"] == "antigravity"
    assert cfg["session_id"] == "sess-123"
    assert inferred == {}
