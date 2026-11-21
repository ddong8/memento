"""Tests for cross-agent subagent parent lineage detection and project grouping."""

import json
from server.services.ingest_service import _parent_session_id_from_content


def test_parent_session_id_claude_and_workbuddy_sidechain():
    parent_uuid = "11111111-2222-3333-4444-555555555555"
    content = json.dumps({"isSidechain": True, "sessionId": parent_uuid, "type": "user"})
    assert _parent_session_id_from_content(content) == parent_uuid


def test_parent_session_id_codex_session_meta_direct_and_thread_spawn():
    parent_uuid = "01a10725-80b0-7963-9b95-b0a70b832a76"
    child_uuid = "01a10726-386c-7290-b7c2-cbc9a00cdb78"

    direct_line = json.dumps({
        "type": "session_meta",
        "payload": {"id": child_uuid, "parent_thread_id": parent_uuid},
    })
    assert _parent_session_id_from_content(direct_line + "\n{}") == parent_uuid

    spawn_line = json.dumps({
        "type": "session_meta",
        "payload": {
            "id": child_uuid,
            "source": {"subagent": {"thread_spawn": {"parent_thread_id": parent_uuid}}},
        },
    })
    assert _parent_session_id_from_content(spawn_line) == parent_uuid

    # A parent session mentioning parent_thread_id in a later message must NOT self-link
    parent_only = (
        json.dumps({"type": "session_meta", "payload": {"id": parent_uuid}})
        + "\n"
        + json.dumps({"type": "response_item", "text": f'"parent_thread_id":"{parent_uuid}"'})
    )
    assert _parent_session_id_from_content(parent_only) is None


def test_parent_session_id_codex_guardian_and_antigravity_header():
    parent_uuid = "ead11d5b-428c-48b6-a7e8-232114fc98f5"
    guardian = f"Reviewed Codex session id: {parent_uuid}\nLooks good"
    assert _parent_session_id_from_content(guardian) == parent_uuid

    agy_header = json.dumps({"parent_conversation_id": parent_uuid, "step_index": 0})
    assert _parent_session_id_from_content(agy_header) == parent_uuid
