import pytest
from server.services.ingest_service import _extract_workspace_from_content


def test_extract_from_antigravity_user_information():
    content = (
        "<user_information>\n"
        "The user has 1 active workspaces, each defined by a URI and a CorpusName.\n"
        "/Users/haixingdong/dev/memento -> ddong8/memento\n"
        "</user_information>\n"
        "Some random output mentioning d:/dev/2026/0104/yicaigou"
    )
    name, path = _extract_workspace_from_content(content)
    assert name == "memento"
    assert path == "/Users/haixingdong/dev/memento"


def test_extract_from_tool_call_cwd():
    content = (
        "{\"tool_calls\": [{\"name\": \"run_command\", \"args\": {\"CommandLine\": \"git status\", "
        "\"Cwd\": \"\\\"/Users/haixingdong/dev/memento\\\", \"WaitMsBeforeAsync\": 5000}}]}"
    )
    name, path = _extract_workspace_from_content(content)
    assert name == "memento"
    assert path == "/Users/haixingdong/dev/memento"


def test_rejects_numeric_and_dummy_project_names():
    # If content only mentions year / date / dummy dirs, it should not extract 2026 or ...
    content = "Some log line mentioning d:/dev/2026 and /Users/xxx/Desktop/dev/..."
    name, path = _extract_workspace_from_content(content)
    assert name != "2026"
    assert name != "..."
    assert name is None


def test_extract_nested_date_path():
    content = "Working on file in d:/dev/2026/0123/favorite_chat/src/index.ts"
    name, path = _extract_workspace_from_content(content)
    assert name == "favorite_chat"
    assert "favorite_chat" in path


def test_extract_mac_dev_path():
    content = "Examining /Users/haixingdong/dev/my_cool_app/main.py file structure"
    name, path = _extract_workspace_from_content(content)
    assert name == "my_cool_app"
    assert path == "/Users/haixingdong/dev/my_cool_app"


def test_clean_source_path():
    from server.services.ingest_service import _clean_source_path
    assert _clean_source_path("...") is None
    assert _clean_source_path("/Users/haixingdong/dev/memento") == "/Users/haixingdong/dev/memento"
    assert _clean_source_path("file:///Users/haixingdong/dev/memento") == "/Users/haixingdong/dev/memento"
    assert _clean_source_path("/Users/haixingdong/dev/memento\nother stuff") == "/Users/haixingdong/dev/memento"
    assert _clean_source_path("dev") is None


def test_prettify_and_hash_to_path_windows_claude_code():
    from server.services.ingest_service import _prettify_project_name, _hash_to_path, _is_invalid_project_name

    # Claude Code Windows dir hash with date folders
    raw_hash = "d-dev-2026-0707-pubchem"
    assert _prettify_project_name(raw_hash) == "pubchem"
    assert _hash_to_path(raw_hash) == "d:/dev/2026/0707/pubchem"

    # Single-letter drive letters should be invalid project names
    assert _is_invalid_project_name("d:") is True
    assert _is_invalid_project_name("d") is True
    assert _is_invalid_project_name("pubchem") is False


def test_extract_windows_json_cwd():
    import json, re
    from server.services.ingest_service import _is_invalid_project_name

    content = r'{"type":"user","cwd":"d:\\dev\\2026\\0707\\pubchem","sessionId":"123"}'
    cwd_match = re.search(r'"[Cc][Ww][Dd]"\s*:\s*"((?:\\.|[^"\\])+)"', content[:50000])
    assert cwd_match is not None
    raw_cwd = cwd_match.group(1)
    decoded = json.loads(f'"{raw_cwd}"')
    norm = decoded.replace("\\", "/").rstrip("/")
    proj = norm.split("/")[-1]
    assert proj == "pubchem"
    assert not _is_invalid_project_name(proj)


