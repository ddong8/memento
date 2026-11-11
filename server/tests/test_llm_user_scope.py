"""Background jobs use the user's own model (个人中心, custom_enabled) when the server has no MEMENTO_AI_*.

Calls deep inside a per-user job (dreaming, profile, corrections, todos, daily digest, compaction…)
don't pass user=; the job's scope (llm_user / @uses_user_llm) supplies it, so they no longer skip
silently on a server that relies on each user's model (#5)."""
from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from server.services import ai_provider
from server.services.ai_provider import get_ai_providers, llm_user, uses_user_llm

NO_SYSTEM_AI = {"MEMENTO_AI_API_KEY": "", "MEMENTO_AI_FALLBACK_API_KEY": "", "MEMENTO_AI_PROVIDERS": ""}
OWN = {"custom_enabled": True, "base_url": "https://llm.example/v1", "model": "m", "api_key": "k", "background_model": "bg"}


def _user(settings):
    return SimpleNamespace(id="u1", llm_settings=settings)


@pytest.fixture(autouse=True)
def no_system_model():
    with patch.dict(os.environ, NO_SYSTEM_AI):
        yield


def test_scope_supplies_the_users_model():
    assert get_ai_providers() == []
    with llm_user(_user(OWN)):
        assert [p.name for p in get_ai_providers()] == ["user_custom"]
        assert [p.model for p in get_ai_providers(background=True)] == ["bg", "m"]
    assert get_ai_providers() == []


def test_disabled_or_missing_settings_add_nothing():
    with llm_user(_user({**OWN, "custom_enabled": False})):
        assert get_ai_providers() == []
    with llm_user(None):
        assert get_ai_providers() == []


def test_explicit_user_wins_over_the_scope():
    other = {**OWN, "model": "other"}
    with llm_user(_user(OWN)):
        assert [p.model for p in get_ai_providers(user=_user(other))] == ["other"]
        assert [p.model for p in get_ai_providers(custom_settings=other)] == ["other"]


def test_settings_are_read_once_up_front():
    # Later in a job the row may be expired by a commit; reading it then would lazy-load
    class Row:
        reads = 0

        @property
        def llm_settings(self):
            Row.reads += 1
            return OWN

    with llm_user(Row()):
        get_ai_providers()
        get_ai_providers()
    assert Row.reads == 1

    class Expired:
        @property
        def llm_settings(self):
            raise RuntimeError("MissingGreenlet")

    with llm_user(Expired()):
        assert get_ai_providers() == []


@pytest.mark.asyncio
async def test_decorated_job_and_tasks_it_spawns_use_the_users_model():
    seen: list[list[str]] = []

    async def deep_call():
        seen.append([p.name for p in get_ai_providers(background=True)])

    @uses_user_llm
    async def nightly(db, user, days_back=1):
        await deep_call()
        await asyncio.gather(asyncio.create_task(deep_call()))
        return days_back

    assert await nightly(None, _user(OWN), days_back=3) == 3
    assert await nightly(None, user=_user(OWN)) == 1
    assert seen == [["user_custom_background", "user_custom"]] * 4
    assert ai_provider._llm_user.get() is None
    await deep_call()
    assert seen[-1] == []
