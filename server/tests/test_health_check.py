"""Server health alerts: who gets them, and the low-balance warning."""

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

from server.tasks import health_check


@pytest.mark.asyncio
async def test_balance_warning_only_for_deepseek_and_below_the_threshold():
    env = {"MEMENTO_AI_BASE_URL": "https://api.deepseek.com", "MEMENTO_AI_API_KEY": "k", "MEMENTO_AI_BALANCE_ALERT": "20"}
    notify = AsyncMock(return_value=1)
    with patch.dict(os.environ, env, clear=True), \
         patch.object(health_check, "deepseek_balance", AsyncMock(return_value=(99.85, "CNY"))), \
         patch.object(health_check, "_notify_admins", notify):
        assert await health_check._check_balance() == 0
    notify.assert_not_called()

    with patch.dict(os.environ, env, clear=True), \
         patch.object(health_check, "deepseek_balance", AsyncMock(return_value=(8.5, "CNY"))), \
         patch.object(health_check.ai_health, "claim_alert", AsyncMock(return_value=True)), \
         patch.object(health_check, "_notify_admins", notify):
        assert await health_check._check_balance() == 1
    assert "8.50 CNY" in notify.call_args.args[2]


@pytest.mark.asyncio
async def test_balance_is_not_read_for_other_providers():
    with patch.dict(os.environ, {"MEMENTO_AI_BASE_URL": "https://ark.cn-beijing.volces.com/api/coding/v3", "MEMENTO_AI_API_KEY": "k"}, clear=True):
        assert await health_check.deepseek_balance() is None


@pytest.mark.asyncio
async def test_alerts_go_to_owner_and_admins_only():
    admin = uuid.uuid4()
    sent = AsyncMock(return_value=True)
    with patch.object(health_check, "_admins", AsyncMock(return_value=[admin])), \
         patch.object(health_check, "notify_user", sent):
        assert await health_check._notify_admins("health", "t", "b", "/x") == 1
    assert sent.call_args.args[0] == admin


def test_balance_threshold_falls_back_on_a_bad_value():
    with patch.dict(os.environ, {"MEMENTO_AI_BALANCE_ALERT": "abc"}):
        assert health_check.balance_alert_threshold() == 10.0
