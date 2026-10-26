from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
import uuid
import pytest
from sqlalchemy import Index

from server.db.models import ConversationMessage
from server.services.correction_service import fetch_new_corrections
from server.api.projects import _bust_project_cache
from server.api.devices import _invalidate_device_caches


def test_round23_model_index_defined():
    """Verify idx_conv_msg_doc_dialogue is defined on ConversationMessage."""
    conv_indexes = {idx.name: idx for idx in ConversationMessage.__table_args__ if isinstance(idx, Index)}
    assert "idx_conv_msg_doc_dialogue" in conv_indexes
    idx = conv_indexes["idx_conv_msg_doc_dialogue"]
    assert str(idx.dialect_options["postgresql"]["where"]) == "role IN ('user', 'assistant')"


def test_round23_main_migration_includes_index():
    """Verify server/server/main.py includes idx_conv_msg_doc_dialogue in migration statements."""
    with open("server/server/main.py", "r", encoding="utf-8") as f:
        content = f.read()
    assert "idx_conv_msg_doc_dialogue" in content
    assert "WHERE role IN ('user', 'assistant')" in content


@pytest.mark.asyncio
async def test_correction_service_ask_cursor_caching():
    """Verify fetch_new_corrections uses Redis cursor to query AskConversation and updates cursor."""
    user = MagicMock()
    user.id = uuid.uuid4()
    mock_db = AsyncMock()

    t1 = datetime(2026, 10, 26, 10, 0, 0, tzinfo=timezone.utc)
    t2 = datetime(2026, 10, 26, 11, 0, 0, tzinfo=timezone.utc)

    # Empty rows from conversation_messages
    rows_mock = MagicMock()
    rows_mock.all.return_value = []

    # Mock AskConversation row: id, config, updated_at, turns
    ask_row = (
        uuid.uuid4(),
        {"project_id": "test_proj"},
        t2,
        [
            {"role": "user", "content": "不对，不要用这个方法，改用另一个方案", "created_at": t2.isoformat()},
        ],
    )
    ask_mock = MagicMock()
    ask_mock.all.return_value = [ask_row]

    quotes_mock = MagicMock()
    quotes_mock.scalars.return_value.all.return_value = []

    mock_db.execute.side_effect = [
        rows_mock,
        ask_mock,
        quotes_mock,
    ]

    with patch("server.services.correction_service.ai_health") as mock_ai_health:
        mock_ai_health.get_json = AsyncMock(return_value=t1.isoformat())
        mock_ai_health.put_json = AsyncMock()

        found, after_id = await fetch_new_corrections(mock_db, user, after_id=0, now=t2)

        assert len(found) == 1
        assert "不对，不要用这个方法" in found[0].text
        assert found[0].said_at == t2

        # Verify cursor was fetched and updated to t2
        mock_ai_health.get_json.assert_awaited_once_with(f"corrections_ask_cursor:{user.id}")
        mock_ai_health.put_json.assert_awaited_once_with(
            f"corrections_ask_cursor:{user.id}",
            t2.isoformat(),
            ttl_seconds=90 * 24 * 3600,
        )


@pytest.mark.asyncio
async def test_bust_project_cache_invalidates_v2_and_v1():
    """Verify _bust_project_cache flushes both v1 and v2 prefixes for projects and conversations."""
    uid = uuid.uuid4()
    pid = uuid.uuid4()

    with patch("server.api.projects.cache") as mock_cache:
        mock_cache.cache_delete_prefix = AsyncMock()

        await _bust_project_cache(project_id=pid, user_id=uid)

        calls = [c.args[0] for c in mock_cache.cache_delete_prefix.await_args_list]
        assert f"projects:list:{uid}:" in calls
        assert f"projects:list:v2:{uid}:" in calls
        assert f"project:conv:{uid}:{pid}:" in calls
        assert f"project:conv:v2:{uid}:{pid}:" in calls
        assert f"project:timeline:{uid}:{pid}:" in calls
        assert "project:blueprint:" in calls


@pytest.mark.asyncio
async def test_invalidate_device_caches_includes_v2():
    """Verify _invalidate_device_caches invalidates both v1 and v2 for projects and conv."""
    uid = uuid.uuid4()

    with patch("server.api.devices.cache_delete_prefix", AsyncMock()) as mock_del:
        await _invalidate_device_caches(uid)

        calls = [c.args[0] for c in mock_del.await_args_list]
        assert f"projects:list:{uid}" in calls
        assert f"projects:list:v2:{uid}" in calls
        assert f"project:conv:{uid}:" in calls
        assert f"project:conv:v2:{uid}:" in calls
