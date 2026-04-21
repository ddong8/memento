import json
import struct
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "collector"))

from collector.parsers.antigravity_vscdb import extract_agent_manager_sessions_from_blob  # noqa: E402


def _encode_varint(value: int) -> bytes:
    out = bytearray()
    current = value
    while True:
        to_write = current & 0x7F
        current >>= 7
        if current:
            out.append(to_write | 0x80)
        else:
            out.append(to_write)
            return bytes(out)


def _field_varint(field_number: int, value: int) -> bytes:
    return _encode_varint((field_number << 3) | 0) + _encode_varint(value)


def _field_bytes(field_number: int, payload: bytes) -> bytes:
    return _encode_varint((field_number << 3) | 2) + _encode_varint(len(payload)) + payload


def _field_string(field_number: int, value: str) -> bytes:
    return _field_bytes(field_number, value.encode("utf-8"))


def _field_fixed32(field_number: int, value: int) -> bytes:
    return _encode_varint((field_number << 3) | 5) + struct.pack("<I", value)


def _timestamp(seconds: int, nanos: int = 0) -> bytes:
    return _field_varint(1, seconds) + _field_varint(2, nanos)


class AntigravityVscdbTests(unittest.TestCase):
    def test_extract_agent_manager_sessions_from_blob(self) -> None:
        notify_payload = json.dumps({
            "Message": "payload message",
            "ConfidenceJustification": "payload thinking",
        }, ensure_ascii=False)
        notify_meta = (
            _field_string(1, "evt-notify")
            + _field_string(2, "notify_user")
            + _field_string(3, notify_payload)
        )
        notify_display = (
            _field_string(2, "已恢复的助手回复")
            + _field_varint(3, 1)
            + _field_fixed32(4, 0x3F800000)
            + _field_string(5, "Recovered confidence text")
        )
        notify_main = (
            _field_varint(1, 82)
            + _field_varint(4, 3)
            + _field_bytes(5, _field_bytes(1, _timestamp(1700000050)) + _field_bytes(4, notify_meta))
            + _field_bytes(94, notify_display)
        )
        notify_slot = _field_bytes(1, notify_main) + _field_varint(2, 199)

        boundary_payload = json.dumps({
            "TaskName": "Implement parser",
            "TaskStatus": "Replaying offline session state",
            "TaskSummary": "Recovered task boundary content",
        }, ensure_ascii=False)
        boundary_meta = (
            _field_string(1, "evt-boundary")
            + _field_string(2, "task_boundary")
            + _field_string(3, boundary_payload)
        )
        boundary_display = (
            _field_string(1, "Implement parser")
            + _field_string(2, "Replaying offline session state")
            + _field_string(3, "Recovered task boundary content")
            + _field_string(4, "Rendered boundary content")
            + _field_varint(5, 2)
        )
        boundary_main = (
            _field_varint(1, 81)
            + _field_varint(4, 3)
            + _field_bytes(5, _field_bytes(1, _timestamp(1700000040)) + _field_bytes(4, boundary_meta))
            + _field_bytes(93, boundary_display)
        )
        boundary_slot = _field_bytes(1, boundary_main) + _field_varint(2, 198)

        workspace = (
            _field_string(1, "file:///Users/test/project")
            + _field_string(2, "file:///Users/test/project")
        )
        session_blob = (
            _field_string(1, "Recovered Session")
            + _field_bytes(7, _timestamp(1700000000))
            + _field_bytes(3, _timestamp(1700000060))
            + _field_bytes(9, workspace)
            + _field_bytes(12, notify_slot)
            + _field_bytes(14, boundary_slot)
        )
        session_entry = (
            _field_string(1, "session-123")
            + _field_bytes(2, session_blob)
        )
        root_blob = _field_bytes(1, _field_bytes(1, session_entry))

        sessions = extract_agent_manager_sessions_from_blob(root_blob)

        self.assertIn("session-123", sessions)
        session = sessions["session-123"]
        self.assertEqual(session["title"], "Recovered Session")
        self.assertEqual(session["workspace"], "file:///Users/test/project")
        self.assertEqual(session["project_name"], "project")
        self.assertEqual(session["createdTime"], "2023-11-14T22:13:20Z")
        self.assertEqual(session["lastModifiedTime"], "2023-11-14T22:14:20Z")

        self.assertEqual(len(session["messages"]), 2)
        self.assertEqual(session["messages"][0]["type"], "system")
        self.assertEqual(session["messages"][0]["message"]["content"], "Rendered boundary content")
        self.assertEqual(session["messages"][1]["type"], "assistant")
        self.assertEqual(
            session["messages"][1]["message"]["content"][0]["text"],
            "已恢复的助手回复",
        )
        self.assertEqual(session["messages"][1]["thinking_text"], "Recovered confidence text")
        self.assertEqual(session["messages"][1]["fallback_source"], "offline_vscdb")


if __name__ == "__main__":
    unittest.main()
