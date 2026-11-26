"""Permission modes: the user picks when the agent must ask before commands / edits; the choice reaches the
daemon with the task, is kept in the conversation's config, and a waiting approval is pushed to the phone."""

import asyncio
import json
import uuid
from unittest.mock import AsyncMock, patch

from server.db.models import User
from server.services import ask_stream, task_alerts
from server.services.ask_stream import normalize_permission_mode


def test_unknown_or_missing_mode_is_full_access_as_before():
    assert normalize_permission_mode("supervised") == "supervised"
    assert normalize_permission_mode(" AUTO_EDITS ") == "auto_edits"
    assert normalize_permission_mode("auto") == "auto"
    assert normalize_permission_mode("") == "full"
    assert normalize_permission_mode(None) == "full"
    assert normalize_permission_mode("yolo") == "full"


def _run(permission_mode: str):
    user = User(id=uuid.uuid4(), email="u@example.com", role="owner")
    sent: list[dict] = []
    saved = AsyncMock()

    async def fake_run(db, user, args):
        sent.append(args)
        yield {"type": "tool_result", "result": {"task_id": "t-1", "status": "succeeded", "stdout": "好了", "exit_code": 0}}

    async def run():
        gen = ask_stream.direct_agent_stream(
            db=AsyncMock(), user=user, conv_id=uuid.uuid4(), checkpoint={}, question="发布一下", conv_title="t",
            execution_mode="claude", device_id="mini", cwd="/w", permission_mode=permission_mode,
        )
        return [json.loads(f[6:]) for f in [f async for f in gen] if f.startswith("data: ")]

    with (
        patch("server.services.orchestrator._tool_run_on_device", fake_run),
        patch("server.services.orchestrator.stop_orphaned_agent_tasks", AsyncMock(return_value=[])),
        patch("server.services.user_filter.user_machine_ids", AsyncMock(return_value=["m1"])),
        patch.object(ask_stream, "append_conversation_turns", saved),
    ):
        asyncio.run(run())
    return sent[0], saved.await_args.kwargs["config"]


def test_a_mode_below_full_access_goes_to_the_daemon_and_into_the_conversation():
    args, config = _run("supervised")
    assert args["permission_mode"] == "supervised"
    assert config["permission_mode"] == "supervised"


def test_full_access_sends_nothing_so_older_daemons_behave_the_same():
    args, config = _run("full")
    assert "permission_mode" not in args
    assert config["permission_mode"] == "full"


def test_a_waiting_approval_is_pushed_to_the_phone_once_and_answered_ones_are_not():
    pushed = AsyncMock(return_value=True)
    uid = uuid.uuid4()
    with patch.object(task_alerts.notify_service, "notify_user", pushed):
        asyncio.run(task_alerts.handle_waiting_question(uid, "t-1", {
            "kind": "question", "id": "r1:approval", "approval": True, "question": "运行命令：npm publish", "status": "waiting",
        }))
        asyncio.run(task_alerts.handle_waiting_question(uid, "t-1", {
            "kind": "question", "id": "r1:approval", "status": "answered", "answer": "允许",
        }))
        asyncio.run(task_alerts.handle_waiting_question(uid, "t-1", {
            "kind": "question", "id": "r2:0", "question": "用哪个包管理器？", "status": "waiting",
        }))
    titles = [c.args[2] for c in pushed.await_args_list]
    assert titles == ["需要你批准", "智能体在等你回答"]
    assert pushed.await_args_list[0].args[3] == "运行命令：npm publish"
