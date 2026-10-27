"""The task list carries what a list line shows; the injected context stays for GET /api/tasks/{id}."""

import uuid

from server.api.tasks import _LIST_PAYLOAD_CHARS, _serialize
from server.db.models import DeviceTask


def _task() -> DeviceTask:
    return DeviceTask(
        id=uuid.uuid4(), device_id="d1", action="agent", status="done",
        payload={"prompt": "p" * 5000, "system_prompt_append": "s" * 20000, "cwd": "/repo", "auto_compact_window": 200000},
    )


def test_list_drops_the_injected_context_and_shortens_the_prompt():
    payload = _serialize(_task(), truncate_output=True, include_events=False)["payload"]
    assert "system_prompt_append" not in payload
    assert payload["prompt"].startswith("p" * _LIST_PAYLOAD_CHARS) and len(payload["prompt"]) == _LIST_PAYLOAD_CHARS + 1
    assert payload["cwd"] == "/repo" and payload["auto_compact_window"] == 200000


def test_detail_keeps_the_whole_payload():
    t = _task()
    assert _serialize(t)["payload"] == t.payload
