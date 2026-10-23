import pytest
from unittest.mock import AsyncMock, patch
from server.api.notify import clear_live_activities
from server.db.models import User
import uuid

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
