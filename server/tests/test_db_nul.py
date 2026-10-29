"""U+0000 must not fail a write.

PostgreSQL rejects it in json/jsonb ("unsupported Unicode escape sequence") and in text. A Claude
Code run whose tool output carried one lost its finished result (device_tasks) and the turns of its
conversation (ask_conversations) on 2026-10-29.
"""

import json

from sqlalchemy import event
from sqlalchemy.dialects.postgresql import JSONB

from server.db.session import _strip_nul_params, engine, json_dumps, post_ingest_engine, without_nul


def test_json_drops_nul_but_keeps_escaped_backslashes():
    value = {"out": "a\x00b", "k\x00": ["\x00"], "literal": "\\u0000", "both": "\\\x00", "n": 1}

    out = json_dumps(value)

    assert "\\u0000" not in out.replace("\\\\u0000", "")
    assert json.loads(out) == {"out": "ab", "k": [""], "literal": "\\u0000", "both": "\\", "n": 1}
    assert json_dumps({"plain": "中文"}) == json.dumps({"plain": "中文"})


def test_params_drop_nul_in_any_shape():
    assert without_nul(("a\x00", 1, None, b"\x00", ["x\x00y"])) == ("a", 1, None, b"\x00", ["xy"])
    assert without_nul([("\x00",), ("ok",)]) == [("",), ("ok",)]
    assert without_nul({"a": "\x00z"}) == {"a": "z"}
    assert _strip_nul_params(None, None, "SQL", ("t\x00",), None, False) == ("SQL", ("t",))


def test_both_engines_guard_every_write():
    for eng in (engine, post_ingest_engine):
        assert event.contains(eng.sync_engine, "before_cursor_execute", _strip_nul_params)
        # the jsonb bind the task / turns UPDATE goes through
        bound = JSONB().bind_processor(eng.dialect)({"events": [{"text": "bin\x00ary"}]})
        assert json.loads(bound) == {"events": [{"text": "binary"}]}
