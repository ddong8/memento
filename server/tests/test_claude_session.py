"""Reading what resuming a Claude Code session costs from its transcript."""

import json
from datetime import datetime, timezone

from server.services.claude_session import resume_cost, session_activity

NOW = datetime(2026, 10, 24, 4, 0, tzinfo=timezone.utc)


def _line(**entry) -> str:
    return json.dumps(entry)


def _assistant(ts: str, client: str, input_tokens: int, written: int, read: int, model: str = "claude-opus-5-5") -> str:
    usage = {"input_tokens": input_tokens, "cache_creation_input_tokens": written, "cache_read_input_tokens": read, "output_tokens": 800}
    return _line(type="assistant", timestamp=ts, entrypoint=client, message={"model": model, "usage": usage})


TRANSCRIPT = "\n".join([
    _line(type="user", timestamp="2026-10-24T03:00:00Z", entrypoint="sdk-cli", message={"content": "完成了吗"}),
    _assistant("2026-10-24T03:00:30Z", "sdk-cli", 10, 1_000, 380_000),
    _line(type="user", timestamp="2026-10-24T03:40:00Z", entrypoint="claude-vscode", message={"content": "继续"}),
    _assistant("2026-10-24T03:40:20Z", "claude-vscode", 6, 2_000, 509_000),
    # a subagent's step inside the main transcript and a synthetic error reply don't describe the session's context
    _line(type="assistant", timestamp="2026-10-24T03:41:00Z", entrypoint="claude-vscode", isSidechain=True,
          message={"model": "claude-opus-5-5", "usage": {"input_tokens": 30_000}}),
    _assistant("2026-10-24T03:42:00Z", "claude-vscode", 0, 0, 0, model="<synthetic>"),
])


def test_latest_real_request_gives_the_context():
    found = session_activity(TRANSCRIPT)
    assert found["context_tokens"] == 511_006
    assert found["context_at"] == "2026-10-24T03:40:20Z"
    assert found["last_client"] == "claude-vscode"
    assert found["last_client_at"] == "2026-10-24T03:42:00Z"


def test_piece_without_requests_reports_nothing():
    assert session_activity('{"type":"summary","summary":"x"}\nnot json') == {}


def test_right_after_vscode_the_next_memento_step_recaches_everything():
    cost = resume_cost(session_activity(TRANSCRIPT), NOW)
    assert cost["heavy"] and cost["last_client"] == "VS Code"
    assert cost["minutes_since_activity"] == 18
    assert cost["other_client_recent"] and not cost["cache_cold"]


def test_after_an_hour_the_cache_has_expired_whoever_used_it():
    meta = {"context_tokens": 40_000, "last_client": "sdk-cli", "last_client_at": "2026-10-24T02:30:00Z"}
    cost = resume_cost(meta, NOW)
    assert not cost["heavy"] and cost["cache_cold"] and not cost["other_client_recent"]


def test_memento_continuing_its_own_recent_session_stays_warm():
    meta = {"context_tokens": 40_000, "last_client": "sdk-cli", "last_client_at": "2026-10-24T03:50:00Z"}
    cost = resume_cost(meta, NOW)
    assert not cost["cache_cold"] and not cost["other_client_recent"]


def test_unknown_context_gives_no_hints():
    assert resume_cost({}, NOW) == {}
