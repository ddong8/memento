"""POST /api/ask pre-checks that a model is configured before it starts a run.

It used to call get_ai_providers() without the user, so on a server with no MEMENTO_AI_* that
relies on each user's own model (个人中心, custom_enabled), every AI ask answered 503
"AI provider not configured" although the run itself is generated with the user's settings."""
from __future__ import annotations

import os
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from server.api import ask

NO_SYSTEM_AI = {"MEMENTO_AI_API_KEY": "", "MEMENTO_AI_FALLBACK_API_KEY": "", "MEMENTO_AI_PROVIDERS": ""}


class _PastPrecheck(Exception):
    """Raised by the first step after the pre-check, so the test stops there."""


def _user(llm_settings: dict) -> MagicMock:
    user = MagicMock(id=uuid.uuid4())
    user.llm_settings = llm_settings
    return user


async def _ask(user: MagicMock) -> None:
    with patch.dict(os.environ, NO_SYSTEM_AI), \
         patch.object(ask.ask_runs, "by_request", AsyncMock(return_value=None)), \
         patch.object(ask, "get_or_create_conversation", AsyncMock(return_value=(uuid.uuid4(), "t", {}))), \
         patch.object(ask, "classify_continuation", side_effect=_PastPrecheck):
        await ask.ask(ask.AskRequest(question="今天做了什么"), db=AsyncMock(), _user=user)


class AskProviderPrecheckTests(unittest.IsolatedAsyncioTestCase):
    async def test_users_own_model_passes_the_precheck(self) -> None:
        user = _user({"custom_enabled": True, "base_url": "https://llm.example/v1", "model": "m", "api_key": "k"})
        with self.assertRaises(_PastPrecheck):
            await _ask(user)

    async def test_no_model_anywhere_is_still_503(self) -> None:
        with self.assertRaises(HTTPException) as cm:
            await _ask(_user({}))
        self.assertEqual(cm.exception.status_code, 503)

    async def test_saved_but_disabled_user_model_is_still_503(self) -> None:
        user = _user({"custom_enabled": False, "base_url": "https://llm.example/v1", "model": "m", "api_key": "k"})
        with self.assertRaises(HTTPException) as cm:
            await _ask(user)
        self.assertEqual(cm.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
