import json
import re
import unittest

from server.services.ingest_service import (
    _clean_source_path,
    _extract_workspace_from_content,
    _hash_to_path,
    _is_invalid_project_name,
    _prettify_project_name,
)


class WorkspaceExtractionTests(unittest.TestCase):
    def test_extract_from_antigravity_user_information(self):
        content = (
            "<user_information>\n"
            "The user has 1 active workspaces, each defined by a URI and a CorpusName.\n"
            "/Users/haixingdong/dev/memento -> ddong8/memento\n"
            "</user_information>\n"
            "Some random output mentioning d:/dev/2026/0104/yicaigou"
        )
        name, path = _extract_workspace_from_content(content)
        self.assertEqual(name, "memento")
        self.assertEqual(path, "/Users/haixingdong/dev/memento")

    def test_extract_from_antigravity_active_workspaces(self):
        content = (
            "<user_information>\n"
            "The USER's OS version is mac.\n"
            "Active Workspaces:\n"
            "- /Users/donghaixing/Desktop/dev/memento\n"
            "Command Working Directory: /Users/donghaixing/Desktop/dev/memento\n"
            "</user_information>"
        )
        name, path = _extract_workspace_from_content(content)
        self.assertEqual(name, "memento")
        self.assertEqual(path, "/Users/donghaixing/Desktop/dev/memento")

    def test_extract_from_tool_call_cwd(self):
        content = (
            "{\"tool_calls\": [{\"name\": \"run_command\", \"args\": {\"CommandLine\": \"git status\", "
            "\"Cwd\": \"\\\"/Users/haixingdong/dev/memento\\\", \"WaitMsBeforeAsync\": 5000}}]}"
        )
        name, path = _extract_workspace_from_content(content)
        self.assertEqual(name, "memento")
        self.assertEqual(path, "/Users/haixingdong/dev/memento")

    def test_rejects_numeric_and_dummy_project_names(self):
        content = "Some log line mentioning d:/dev/2026 and /Users/xxx/Desktop/dev/..."
        name, path = _extract_workspace_from_content(content)
        self.assertNotEqual(name, "2026")
        self.assertNotEqual(name, "...")
        self.assertIsNone(name)

    def test_extract_nested_date_path(self):
        content = "Working on file in d:/dev/2026/0123/favorite_chat/src/index.ts"
        name, path = _extract_workspace_from_content(content)
        self.assertEqual(name, "favorite_chat")
        self.assertIn("favorite_chat", path)

    def test_extract_mac_dev_path(self):
        content = "Examining /Users/haixingdong/dev/my_cool_app/main.py file structure"
        name, path = _extract_workspace_from_content(content)
        self.assertEqual(name, "my_cool_app")
        self.assertEqual(path, "/Users/haixingdong/dev/my_cool_app")

    def test_clean_source_path(self):
        self.assertIsNone(_clean_source_path("..."))
        self.assertEqual(_clean_source_path("/Users/haixingdong/dev/memento"), "/Users/haixingdong/dev/memento")
        self.assertEqual(_clean_source_path("file:///Users/haixingdong/dev/memento"), "/Users/haixingdong/dev/memento")
        self.assertEqual(_clean_source_path("/Users/haixingdong/dev/memento\nother stuff"), "/Users/haixingdong/dev/memento")
        self.assertIsNone(_clean_source_path("dev"))

    def test_prettify_and_hash_to_path_windows_claude_code(self):
        raw_hash = "d-dev-2026-0707-pubchem"
        self.assertEqual(_prettify_project_name(raw_hash), "pubchem")
        self.assertEqual(_hash_to_path(raw_hash), "d:/dev/2026/0707/pubchem")

        self.assertTrue(_is_invalid_project_name("d:"))
        self.assertTrue(_is_invalid_project_name("d"))
        self.assertFalse(_is_invalid_project_name("pubchem"))

    def test_extract_windows_json_cwd(self):
        content = r'{"type":"user","cwd":"d:\\dev\\2026\\0707\\pubchem","sessionId":"123"}'
        cwd_match = re.search(r'"[Cc][Ww][Dd]"\s*:\s*"((?:\\.|[^"\\])+)"', content[:50000])
        self.assertIsNotNone(cwd_match)
        raw_cwd = cwd_match.group(1)
        decoded = json.loads(f'"{raw_cwd}"')
        norm = decoded.replace("\\", "/").rstrip("/")
        proj = norm.split("/")[-1]
        self.assertEqual(proj, "pubchem")
        self.assertFalse(_is_invalid_project_name(proj))

    def test_strips_quotes_from_project_name_and_path(self):
        self.assertEqual(_prettify_project_name('dataset-platform"'), "dataset-platform")
        self.assertEqual(_prettify_project_name('"aiphacas-portal"'), "aiphacas-portal")
        self.assertEqual(_prettify_project_name('\'aiphacas-portal\''), "aiphacas-portal")

        self.assertEqual(_clean_source_path('"D:/dev/dataset-platform"'), "D:/dev/dataset-platform")
        self.assertEqual(_clean_source_path('file:///D:/dev/dataset-platform"'), "D:/dev/dataset-platform")

    def test_rejects_hyphen_and_empty_project_names(self):
        self.assertTrue(_is_invalid_project_name("-"))
        self.assertTrue(_is_invalid_project_name("--"))
        self.assertTrue(_is_invalid_project_name("---"))
        self.assertTrue(_is_invalid_project_name("..."))
        self.assertTrue(_is_invalid_project_name("   -  "))
        self.assertTrue(_is_invalid_project_name("none"))
        self.assertTrue(_is_invalid_project_name("null"))
        self.assertFalse(_is_invalid_project_name("memento"))
