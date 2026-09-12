from collector.executor import build_agent_command


def test_build_agent_command_claude_with_system_prompt_append():
    cmd = build_agent_command(
        binary="claude",
        resolved="/usr/local/bin/claude",
        prompt="测试提示词",
        session_id="",
        system_prompt_append="【前序会话背景快照】任务目标是测试",
    )
    assert "/usr/local/bin/claude" in cmd
    assert "-p" in cmd
    assert "--append-system-prompt" in cmd
    idx = cmd.index("--append-system-prompt")
    assert cmd[idx + 1] == "【前序会话背景快照】任务目标是测试"
    assert "-r" not in cmd  # Clean session without bloated -r
    assert "测试提示词" in cmd


def test_build_agent_command_claude_normal_resume():
    cmd = build_agent_command(
        binary="claude",
        resolved="/usr/local/bin/claude",
        prompt="继续",
        session_id="session-12345",
    )
    assert "-r" in cmd
    idx = cmd.index("-r")
    assert cmd[idx + 1] == "session-12345"
    assert "--append-system-prompt" not in cmd
