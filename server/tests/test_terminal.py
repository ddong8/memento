"""Web terminals: opened on the user's device, owned by that user only, output relayed as task chunks."""

import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from server.api import terminal
from server.db.models import Machine, User


def _user():
    return User(id=uuid.uuid4(), email="u@example.com", role="owner")


def _machine():
    return Machine(id=uuid.uuid4(), name="mini", collector_token_hash="tok")


@pytest.fixture(autouse=True)
def single_replica():
    terminal._local_owners.clear()
    with patch.object(type(terminal.cluster), "redis", property(lambda self: None)):
        yield


def _open(user, *, feature=True, reply=None, **body):
    request = AsyncMock(return_value=reply or {"ok": True})
    with (
        patch.object(terminal, "_resolve_device", AsyncMock(return_value=(_machine(), ["dev-1"]))),
        patch.object(terminal.device_reports, "device_has_feature", lambda *a, **k: feature),
        patch.object(terminal.ws_manager, "request_device", request),
    ):
        out = asyncio.run(terminal.open_terminal(terminal.TermOpenRequest(device_id="mini", **body), db=AsyncMock(), user=user))
    return out, request


def test_open_starts_the_shell_on_the_device_in_the_project_folder():
    user = _user()
    out, request = _open(user, cwd=" /repo ", cols=120, rows=40)
    assert out["term_id"].startswith("term-")
    sent = request.await_args.args[1]
    assert sent == {"type": "term_open", "term_id": out["term_id"], "cwd": "/repo", "cols": 120, "rows": 40}


def test_an_old_daemon_or_a_device_error_says_why():
    with pytest.raises(HTTPException) as e:
        _open(_user(), feature=False)
    assert "1.0.161" in e.value.detail
    with pytest.raises(HTTPException) as e:
        _open(_user(), reply={"ok": False, "error": "同时最多开 6 个终端，先关掉一个"})
    assert "最多开 6 个" in e.value.detail


def test_only_its_owner_can_type_into_it():
    owner, stranger = _user(), _user()
    out, _ = _open(owner)
    tid = out["term_id"]
    sent = AsyncMock(return_value=True)
    with patch.object(terminal.ws_manager, "send_json", sent):
        asyncio.run(terminal.terminal_input(tid, terminal.TermInput(data="ls\r"), user=owner))
        with pytest.raises(HTTPException) as e:
            asyncio.run(terminal.terminal_input(tid, terminal.TermInput(data="rm -rf ~\r"), user=stranger))
        assert e.value.status_code == 404
    assert sent.await_count == 1
    assert sent.await_args.args == ("dev-1", {"type": "term_input", "term_id": tid, "data": "ls\r"})


def test_closed_terminals_are_gone_and_odd_ids_rejected():
    user = _user()
    out, _ = _open(user)
    with patch.object(terminal.ws_manager, "send_json", AsyncMock(return_value=True)):
        asyncio.run(terminal.terminal_close(out["term_id"], user=user))
        with pytest.raises(HTTPException):
            asyncio.run(terminal.terminal_resize(out["term_id"], terminal.TermResize(cols=80, rows=24), user=user))
    with pytest.raises(HTTPException) as e:
        asyncio.run(terminal.terminal_close("../../etc/passwd", user=user))
    assert e.value.status_code == 400
