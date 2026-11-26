"""AI-written commit messages: the diff the device returns is turned back into compact text for the model,
only the user's commit rules go in, and agent credit trailers never reach the commit."""

from server.api.git_review import commit_rules_from_guidance, diff_for_prompt, parse_suggestion, strip_agent_trailers

DIFF = {
    "branch": "main",
    "files": [
        {"path": "a.ts", "status": "M", "additions": 1, "deletions": 1, "binary": False, "hunks": [
            {"header": "@@ -1,2 +1,2 @@", "lines": [
                {"type": "context", "content": "const x = 1;"},
                {"type": "del", "content": "const y = 2;"},
                {"type": "add", "content": "const y = 3;"},
            ]},
        ]},
        {"path": "logo.png", "status": "A", "additions": 0, "deletions": 0, "binary": True, "hunks": []},
        {"path": "big.ts", "status": "M", "additions": 900, "deletions": 0, "binary": False, "hunks": [
            {"header": "@@ -0,0 +1,900 @@", "lines": [{"type": "add", "content": "x" * 100}] * 900},
        ]},
    ],
}


def test_the_diff_goes_back_to_unified_text_and_a_huge_file_is_only_named():
    text = diff_for_prompt(DIFF, limit=2_000)
    assert "--- M a.ts (+1 -1)" in text
    assert "-const y = 2;\n+const y = 3;" in text
    assert "logo.png" in text and "二进制" in text
    assert "其余改动（内容太长未列出）：big.ts (+900 -0)" in text
    assert len(text) < 2_500


def test_only_the_files_ticked_for_the_commit():
    text = diff_for_prompt(DIFF, files=["logo.png"])
    assert "logo.png" in text and "a.ts" not in text


def test_only_commit_rules_from_the_users_guidance():
    guidance = "- 提交用中文 Conventional Commits，不加 Claude 共同作者尾注\n- 界面避免渐变色\n- PR 描述写验证方式"
    rules = commit_rules_from_guidance(guidance)
    assert "Conventional Commits" in rules and "PR 描述" in rules
    assert "渐变色" not in rules


def test_the_models_json_or_plain_text_becomes_a_suggestion_without_credit_trailers():
    s = parse_suggestion('好的：\n{"message": "fix(web): 修复底栏\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>", "pr_title": "修复底栏", "pr_body": "- 改了 CSS"}')
    assert strip_agent_trailers(s["message"]) == "fix(web): 修复底栏"
    assert s["pr_title"] == "修复底栏"
    assert parse_suggestion("feat: 加权限模式")["message"] == "feat: 加权限模式"
    assert strip_agent_trailers("正文\n🤖 Generated with [Claude Code](https://claude.com/claude-code)") == "正文"
