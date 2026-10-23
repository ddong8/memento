"""Long streams must not keep the request's read transaction open.

An ask, an attached run or a device video streams for minutes; the transaction the sign-in
lookup began stayed open all that time until Postgres cut the connection after 60 s
(idle_in_transaction_session_timeout), and the request then failed committing on a closed one.
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server.db.models import User
from server.middleware.auth import create_access_token, get_current_user
from server.services import ask_stream


@pytest.mark.asyncio
async def test_sign_in_ends_its_read_transaction():
    user = User(id=uuid.uuid4(), email="a@example.com", role="user", status="active")
    result = MagicMock()
    result.scalar_one_or_none.return_value = user
    db = MagicMock(execute=AsyncMock(return_value=result), commit=AsyncMock())

    got = await get_current_user(f"Bearer {create_access_token(str(user.id), 'user')}", db)

    assert got is user
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_ask_releases_the_request_session_before_streaming():
    order: list[str] = []
    db = MagicMock(commit=AsyncMock(side_effect=lambda: order.append("commit")))

    async def start(*a, **k):
        order.append("start")
        return MagicMock(stream=lambda after: iter(()))

    with patch.object(ask_stream.ask_runs, "start", side_effect=start):
        await ask_stream.run_response("c", MagicMock(id=1), "q", None, lambda *_: None, request_db=db)

    assert order == ["commit", "start"]
