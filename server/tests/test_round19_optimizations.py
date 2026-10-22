import pytest
from unittest.mock import AsyncMock, patch
from server.services.cache import get_hot_query_cache, set_hot_query_cache
from server.api.notify import clear_live_activities
from server.db.models import User
import uuid

@pytest.mark.asyncio
async def test_hot_query_cache():
    fake_storage = {}
    async def fake_get(k):
        return fake_storage.get(k)
    async def fake_set(k, v, ex=None):
        fake_storage[k] = v

    mock_client = AsyncMock()
    mock_client.get = fake_get
    mock_client.set = fake_set

    with patch("server.services.cache.redis_client", return_value=mock_client):
        # Cache miss
        res = await get_hot_query_cache("test prompt for optimization", "claude-3-7-sonnet")
        assert res is None

        # Set cache
        await set_hot_query_cache("test prompt for optimization", "claude-3-7-sonnet", "Thinking steps...", "Content result")
        
        # Cache hit
        res2 = await get_hot_query_cache("test prompt for optimization", "claude-3-7-sonnet")
        assert res2 is not None
        assert res2["content"] == "Content result"
        assert res2["thinking"] == "Thinking steps..."


@pytest.mark.asyncio
async def test_clear_live_activities_endpoint():
    user = User(
        id=uuid.uuid4(),
        email="test@example.com",
        notify_settings={"live_activity_tokens": {"conv-123": "token-abc", "conv-456": "token-def"}},
    )
    fake_db = AsyncMock()
    with patch("server.api.notify.send_apns_live_activity", new_callable=AsyncMock) as mock_send:
        mock_send.return_value = True
        res = await clear_live_activities(db=fake_db, user=user)
        assert res["status"] == "ok"
        assert res["cleared"] == 2
        assert user.notify_settings["live_activity_tokens"] == {}
        assert mock_send.call_count == 2
