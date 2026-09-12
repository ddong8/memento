import pytest
from server.services.session_compactor import (
    calculate_session_stats,
    estimate_tokens,
    format_injected_context,
    generate_checkpoint_summary,
    prune_message_payloads,
    split_sliding_window,
)


def test_estimate_tokens():
    en_text = "Hello world this is a test of token estimation."
    zh_text = "你好世界，这是一个关于会话记忆压缩的测试。"
    assert estimate_tokens(en_text) > 0
    assert estimate_tokens(zh_text) > 0
    assert estimate_tokens(zh_text) >= len(zh_text)


def test_prune_message_payloads_base64_and_long_tool():
    dummy_base64 = "data:image/png;base64," + "A" * 300
    messages = [
        {"role": "user", "content": f"Please look at this screenshot: {dummy_base64}"},
        {"role": "tool", "raw_type": "tool_output", "content": "Line of output\n" * 200},
        {"role": "assistant", "content": "I see the file.", "thinking": "T" * 2000},
    ]

    pruned = prune_message_payloads(messages, max_tool_output_chars=200)

    assert "data:image/png;base64" not in pruned[0]["content"]
    assert "[图片附件" in pruned[0]["content"]

    assert len(pruned[1]["content"]) < 400
    assert "长输出截断" in pruned[1]["content"]

    assert len(pruned[2]["thinking"]) <= 1100
    assert "思考链已精简" in pruned[2]["thinking"]


def test_split_sliding_window():
    messages = [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"}
        for i in range(20)
    ]
    older, recent = split_sliding_window(messages, recent_turns=4)

    # 4 turns = 8 messages
    assert len(recent) == 8
    assert len(older) == 12
    assert recent[-1]["content"] == "msg 19"
    assert older[0]["content"] == "msg 0"


@pytest.mark.asyncio
async def test_generate_checkpoint_summary_heuristic():
    older = [
        {"role": "user", "content": "请帮我修改 server/server/api/ask.py 和 web/src/app/ask/page.tsx 中的会话接续逻辑"},
        {"role": "assistant", "content": "好的，我已经定位到相关代码并完成了初始调研。"},
        {"role": "user", "content": "继续，我们需要加上智能记忆压缩功能。"},
    ]

    summary = await generate_checkpoint_summary(older, session_title="会话压缩研发", tool_id="claude_code")
    assert "核心记忆快照" in summary
    assert "任务核心目标" in summary
    assert "文件" in summary
    assert "ask.py" in summary or "page.tsx" in summary


def test_format_injected_context():
    summary = "### 核心记忆快照\n- 任务核心目标：修复报错\n- 涉及核心文件：main.py"
    recent = [
        {"role": "user", "content": "现在状态如何？"},
        {"role": "assistant", "content": "当前正在执行测试。"},
    ]
    injected = format_injected_context(summary, recent, original_session_id="01a07ef6-1234")
    assert "前序会话核心记忆快照" in injected
    assert "01a07ef6" in injected
    assert "用户: 现在状态如何？" in injected
    assert "执行规则" in injected
