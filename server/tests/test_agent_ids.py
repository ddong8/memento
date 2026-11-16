"""Device OS and agent session ids, as the server checks them before acting on them.

2026-11-16: "darwin" contains "win", so every Mac was taken for Windows and its Antigravity tasks' folders
were swapped for a conversation's walkthrough.md (the home folder, in effect); and `session_id: ""` in a
file Antigravity read became the session `\\"\\"`, so every turn after it failed with "Timed out waiting
for Antigravity response log"."""

import asyncio
import json
import uuid
from unittest.mock import AsyncMock, patch

from server.db.models import AskConversation, User
from server.services import ask_stream
from server.services.agent_ids import clean_session_id, device_os, reported_session_id
from server.services.ask_store import infer_conversation_config

REAL = "4c1e7a52-9d0b-4f3e-8a61-2b7d9e0c5f13"
BROKEN = '\\"\\"'


def test_device_os_comes_from_the_name_the_collector_gives():
    assert device_os("studio-mini.local (Darwin)") == "macos"
    assert device_os("someones-MacBook-Pro.local (Darwin)") == "macos"
    assert device_os("DESKTOP-A1B2C3D (Windows)") == "windows"
    assert device_os("vps3 (Linux)") == "linux"
    # A name that doesn't say: unknown, not guessed from a substring
    assert device_os("darwin-builder") is None
    assert device_os("") is None and device_os(None) is None


def test_session_ids_agents_make_go_through_text_taken_for_one_doesnt():
    assert clean_session_id(f" {REAL} ") == REAL
    assert clean_session_id("s-1") == "s-1"
    assert clean_session_id("wb-session-999", "workbuddy") == "wb-session-999"
    for bad in (BROKEN, '""', "`、`conversation", "", " ", "a b", "../x", "会话", None, 42):
        assert clean_session_id(bad) is None, bad
    # Antigravity's conversations are UUIDs, the app's and Google's CLI's alike
    assert clean_session_id(REAL, "agy") == REAL
    assert clean_session_id("conv-1", "agy") is None
    assert clean_session_id("conv-1", "antigravity") is None


def test_the_session_is_the_runners_own_line_on_stderr_the_last_run_counting():
    err = f'session id: {BROKEN}\nsession id: 6f3d1184-787b-4878-a8f5-2f5ade4fb738\n⏳ ...\nsession id: {REAL}\n'
    assert reported_session_id(err, "agy") == REAL
    assert reported_session_id("  quoted: session id: " + REAL) is None  # not a line of its own
    assert reported_session_id(None) is None


def _conv(turns, config=None):
    return AskConversation(id=uuid.uuid4(), title="t", turns=turns, config=config or {}, device_id="mini", cwd="/w")


def test_a_conversation_never_goes_on_in_text_taken_for_its_session():
    # As saved by a daemon before the fix: the result says `\"\"`, its runner's stderr the real one
    call = {"name": "run_on_device", "args": {"binary": "agy", "action": "agent", "session_id": BROKEN},
            "result": {"status": "failed", "session_id": BROKEN, "stderr": f"session id: {BROKEN}\nTimed out"}}
    first = {"name": "run_on_device", "args": {"binary": "agy", "action": "agent"},
             "result": {"status": "succeeded", "session_id": BROKEN, "stderr": f"session id: {REAL}\n"}}
    turns = [{"role": "assistant", "toolCalls": [first]}, {"role": "assistant", "toolCalls": [call]}]
    cfg, _ = infer_conversation_config(_conv(turns, {"execution_mode": "antigravity"}))
    assert cfg.get("session_id") == REAL


def test_a_turn_asked_with_a_broken_session_starts_a_new_one():
    user = User(id=uuid.uuid4(), email="u@example.com", role="owner")
    sent: list[dict] = []
    saved = AsyncMock()

    async def fake_run(db, user, args):
        sent.append(args)
        yield {"type": "tool_result", "result": {"task_id": "t-1", "status": "succeeded", "stdout": "好了",
                                                 "exit_code": 0, "session_id": REAL}}

    async def run():
        gen = ask_stream.direct_agent_stream(
            db=AsyncMock(), user=user, conv_id=uuid.uuid4(), checkpoint={}, question="全部实施吧", conv_title="t",
            execution_mode="antigravity", device_id="mini", cwd="/w", session_id=BROKEN,
        )
        return [json.loads(f[6:]) for f in [f async for f in gen] if f.startswith("data: ")]

    with (
        patch("server.services.orchestrator._tool_run_on_device", fake_run),
        patch("server.services.orchestrator.stop_orphaned_agent_tasks", AsyncMock(return_value=[])),
        patch("server.services.user_filter.user_machine_ids", AsyncMock(return_value=["m1"])),
        patch.object(ask_stream, "append_conversation_turns", saved),
    ):
        asyncio.run(run())
    assert "session_id" not in sent[0]
    assert saved.await_args.kwargs["config"]["session_id"] == REAL


def _machine(name):
    from server.db.models import Machine

    return Machine(id=uuid.uuid4(), name=name, collector_token_hash="tok")


def test_a_macs_folder_is_kept_as_asked():
    from server.services import orchestrator as orch

    db = AsyncMock()
    got = asyncio.run(orch._device_cwd(db, _machine("studio-mini.local (Darwin)"), "/Users/me/dev/memento", str(uuid.uuid4()), False))
    assert got == "/Users/me/dev/memento"
    db.execute.assert_not_awaited()  # nothing guessed from the project's documents


def test_another_platforms_folder_becomes_the_one_most_of_the_projects_documents_name():
    from unittest.mock import MagicMock

    from server.services import orchestrator as orch

    res = MagicMock()
    res.scalar.return_value = "D:/dev/memento"
    db = AsyncMock()
    db.execute.return_value = res
    got = asyncio.run(orch._device_cwd(db, _machine("DESKTOP-A1B2C3D (Windows)"), "/Users/me/dev/memento", str(uuid.uuid4()), False))
    assert got == "D:/dev/memento"
    sql = str(db.execute.await_args.args[0])
    assert "count(*) DESC" in sql and "max(" not in sql.lower()
