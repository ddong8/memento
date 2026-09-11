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
