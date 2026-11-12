"""Collaborative tasks: planning output made safe, who gets each step, the order steps run in, retries
on another agent or device, stopping and retrying by hand."""

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from server.services import plan_service as ps


_LATER = "2099-01-01T00:00:00Z"


def _snapshot():
    r = ps.model_roster
    return {
        "devices": [
            {"device_id": "mac", "name": "MacBook", "platform": "darwin", "workspace": True, "running": 0,
             "agents": {"claude": r("claude", ["opus"], {"remaining_percent": 60}),
                        "codex": r("codex", ["gpt"], {})}},
            {"device_id": "vps3", "name": "vps3", "platform": "linux", "workspace": True, "running": 0,
             "agents": {"claude": r("claude", [], {}),
                        "codex": r("codex", [], {}),
                        "antigravity": r("antigravity", ["g4", "g3"], {"limited_models": [{"family": "g4", "model": "g4", "until": _LATER}]}, default="g4")}},
            {"device_id": "win", "name": "Windows", "platform": "win32", "workspace": False, "running": 2,
             "agents": {"codex": r("codex", ["gpt"], {"limited_models": [{"family": "gpt", "model": "gpt", "until": _LATER}]})}},
        ],
        "stats": {},
    }


class FakePlan(SimpleNamespace):
    pass


def _plan(steps, status="running", **kw):
    return FakePlan(id=uuid.uuid4(), user_id=uuid.uuid4(), goal="做个大功能", title="大功能", status=status,
                    steps=steps, cwd=kw.get("cwd"), source_device_id=kw.get("source"), project_id=None,
                    options={}, auto_start=True, finished_at=None, started_at=None, error=None, summary=None,
                    plan_note=None)


def _mutate_on(plan):
    """_mutate against an in-memory plan: the step changes land on it like on the row."""
    import copy

    async def fake(_pid, fn):
        steps = copy.deepcopy(plan.steps)
        if fn(plan, steps) is False:
            return plan
        plan.steps = steps
        return plan

    return fake


def test_parse_plan_json_from_fence_and_prose():
    text = '好的，计划如下：\n```json\n{"title": "t", "steps": [{"id": "a", "prompt": "x"}]}\n```\n'
    assert ps.parse_plan_json(text)["steps"][0]["id"] == "a"
    assert ps.parse_plan_json('前言 {"steps": []} 后记') == {"steps": []}
    assert ps.parse_plan_json("不是 JSON") is None
    assert ps.parse_plan_json('{"title": "no steps"}') is None


def test_normalize_steps_fixes_ids_deps_cycles_and_adds_review():
    raw = [
        {"id": "a", "title": "A", "prompt": "做 A", "depends_on": ["b"], "agent": "codex", "device": "vps3"},
        {"id": "b", "title": "B", "prompt": "做 B", "depends_on": ["a", "zzz"], "agent": "agy", "device": "MacBook"},
        {"id": "a", "title": "A2", "prompt": "做 A2", "agent": "gpt"},
        {"id": "c", "title": "空", "prompt": ""},
    ]
    steps = ps.normalize_steps(raw, _snapshot(), source_device_id="mac", code=True)
    ids = [s["id"] for s in steps]
    assert ids == ["a", "b", "ax", "review"]
    a, b, ax, review = steps
    # Cycle broken: a step only waits on earlier ones
    assert a["depends_on"] == [] and b["depends_on"] == ["a"]
    assert a["agent"] == "codex" and a["device_id"] == "vps3"
    # Antigravity is not on the Mac: planned up front on the device that has it, with a model that has quota
    assert b["agent"] == "antigravity" and b["device_id"] == "vps3" and b["model"] == "g3"
    # No agent asked for: one picked up front too, never one without quota
    assert ax["agent"] and ax["device_id"] and (ax["device_id"], ax["agent"]) != ("win", "codex")
    assert review["agent"] == "claude" and review["device_id"]
    assert review["kind"] == "review" and review["depends_on"] == ["a", "b", "ax"]
    assert all(s["status"] == "pending" and s["attempts"] == 0 for s in steps)


def test_normalize_single_step_has_no_review_and_respects_max(monkeypatch):
    monkeypatch.setattr(ps, "MAX_STEPS", 2)
    one = ps.normalize_steps([{"prompt": "x"}], _snapshot(), source_device_id=None, code=False)
    assert [s["id"] for s in one] == ["s1"]
    many = ps.normalize_steps([{"prompt": str(i)} for i in range(5)], _snapshot(), source_device_id=None, code=False)
    assert [s["id"] for s in many] == ["s1", "s2", "review"]


def test_normalize_drops_limited_or_unknown_model():
    steps = ps.normalize_steps(
        [{"prompt": "x", "agent": "antigravity", "device": "vps3", "model": "g4"},
         {"prompt": "y", "agent": "antigravity", "device": "vps3", "model": "g3"}],
        _snapshot(), source_device_id=None, code=False, review=False,
    )
    # The spent model is swapped for one with quota, not left to the agent's (spent) default
    assert steps[0]["model"] == "g3" and steps[1]["model"] == "g3"


def test_agent_usable_when_every_model_is_spent():
    r = ps.model_roster
    assert ps.agent_usable(r("antigravity", ["g4", "g3"], {"limited_models": [{"family": "g4", "until": _LATER}]}))
    assert not ps.agent_usable(r("codex", ["gpt"], {"limited_models": [{"family": "gpt", "until": _LATER}]}))
    assert not ps.agent_usable(None)
    # A limit that's over counts no more
    assert r("codex", ["gpt"], {"limited_models": [{"family": "gpt", "until": "2000-01-01T00:00:00Z"}]})["usable"]


def test_model_roster_reads_antigravity_quotas_like_the_devices_report_them():
    # 11-12 live report: Argon's remaining fraction left out (0 in proto3 JSON), Flash at 98%
    models = ["gemini-4-argon-medium", "gemini-4-argon-high", "gemini-3.8-flash-high", "gemini-3.8-flash-medium",
              "claude-opus-5-5-medium", "gemini-4-carbon-disabled"]
    quota = {"remaining_percent": 98, "models": [
        {"model_id": "gemini-4-argon-medium", "remaining_percent": None},
        {"model_id": "gemini-4-argon-high", "remaining_percent": None},
        {"model_id": "gemini-3.8-flash-high", "remaining_percent": 98},
        {"model_id": "gemini-3.8-flash-medium", "remaining_percent": 98},
        {"model_id": "claude-opus-5-5-medium", "remaining_percent": 5},
    ]}
    info = ps.model_roster("antigravity", models, quota, default="gemini-4-argon-medium")
    assert set(info["out"]) == {"gemini-4-argon-medium", "gemini-4-argon-high", "claude-opus-5-5-medium"}
    assert "5%" in info["out"]["claude-opus-5-5-medium"]
    # Same effort as the spent default; the disabled model never offered
    assert info["model"] == "gemini-3.8-flash-medium" and info["usable"]
    assert "gemini-4-carbon-disabled" not in info["models"]
    # A model the device reported spent (with a reset time) says when it's back
    info = ps.model_roster("antigravity", ["g4", "g3"], {"limited_models": [{"family": "g4", "until": _LATER}]}, default="g4")
    assert info["out"]["g4"].startswith("额度用完") and info["model"] == "g3"


def test_model_roster_claude_account_quota_and_codex_unsupported():
    low = ps.model_roster("claude", ["opus", "sonnet"], {"remaining_percent": 4})
    assert not low["usable"] and not ps.agent_usable(low)
    ok = ps.model_roster("claude", ["opus", "sonnet"], {"remaining_percent": 71}, default="claude-opus-5-5")
    assert ok["usable"] and ok["model"] == "claude-opus-5-5" and not ok["out"]
    unsupported = ps.model_roster("codex", ["gpt-reserve", "gpt-6-luna"], {"limited_models": [
        {"family": "gpt-6-astra", "model": "gpt-6-astra", "until": _LATER, "message": "The 'gpt-6-astra' model is not supported"}]},
        default="gpt-6-astra")
    assert unsupported["out"]["gpt-6-astra"] == "账号不支持" and unsupported["model"] == "gpt-reserve"
    # Nothing known about the default: left to the agent
    assert ps.model_roster("codex", [], {})["model"] == ""


def test_plan_lists_who_takes_part_and_what_was_left_out():
    snap = _snapshot()
    steps = ps.normalize_steps(
        [{"id": "a", "prompt": "x", "agent": "antigravity", "device": "vps3"},
         {"id": "b", "prompt": "y", "agent": "codex", "device": "MacBook"}],
        snap, source_device_id=None, code=False,
    )
    roster = ps.plan_roster(steps)
    assert {"device_id": "vps3", "device_name": "vps3", "agent": "antigravity", "model": "g3", "steps": ["a"]} in roster
    assert any(r["agent"] == "claude" and r["steps"] == ["review"] for r in roster)
    out = {(e["agent"], e["model"]): e for e in ps.excluded_models(snap)}
    assert out[("antigravity", "g4")]["devices"] == ["vps3"] and ("codex", "gpt") in out


def test_choose_assignment_prefers_asked_agent_and_skips_tried_and_spent():
    snap = _snapshot()
    assert ps.choose_assignment(snap, prefer_agent="antigravity") == ("vps3", "antigravity")
    # Codex on Windows has no model left; Mac Codex tried: vps3 Codex
    assert ps.choose_assignment(snap, prefer_agent="codex", exclude=[["mac", "codex"]]) == ("vps3", "codex")
    # Code on the Mac: Windows can't take a copy of it
    picks = set()
    exclude = []
    while (p := ps.choose_assignment(snap, exclude=exclude, source_device_id="mac", code=True)):
        picks.add(p)
        exclude.append(list(p))
    assert ("win", "codex") not in picks and len(picks) == 5


def test_choose_assignment_spreads_load():
    snap = _snapshot()
    first = ps.choose_assignment(snap, prefer_agent="codex")
    second = ps.choose_assignment(snap, prefer_agent="codex", load={first[0]: 1})
    assert first[0] != second[0]


def test_retry_moves_off_an_agent_that_timed_out_in_the_plan():
    # 11-11 overnight: Antigravity hung two hours on every device; the retry kept picking it elsewhere
    snap = _snapshot()
    steps = [
        {"id": "s1", "history": [{"agent": "antigravity", "status": "timeout", "error_type": None}]},
        {"id": "s2", "history": [{"agent": "codex", "status": "failed", "error_type": "usage_limit"}]},
    ]
    penalty = ps.agent_penalty(steps)
    assert penalty == {"antigravity": 2}
    pick = ps.choose_assignment(snap, exclude=[["vps3", "antigravity"]], penalty=penalty)
    assert pick and pick[1] != "antigravity"
    # Even when the planner (or the step left from before a retry) still names it
    pick = ps.choose_assignment(snap, prefer_agent="antigravity", penalty=penalty)
    assert pick and pick[1] != "antigravity"


def test_plan_progress_ready_blocked_over():
    steps = [
        {"id": "a", "status": "succeeded", "depends_on": []},
        {"id": "b", "status": "failed", "depends_on": []},
        {"id": "c", "status": "pending", "depends_on": ["a"]},
        {"id": "d", "status": "pending", "depends_on": ["a", "b"]},
    ]
    p = ps.plan_progress(steps)
    assert p["ready"] == ["c"] and p["blocked"] == ["d"] and not p["over"]
    steps[2]["status"] = "succeeded"
    steps[3]["status"] = "skipped"
    assert ps.plan_progress(steps)["over"]


def test_step_prompt_carries_scope_dependencies_and_last_failure():
    steps = ps.normalize_steps(
        [{"id": "api", "title": "接口", "prompt": "写接口", "acceptance": "测试通过"},
         {"id": "ui", "title": "界面", "prompt": "写界面", "depends_on": ["api"]}],
        _snapshot(), source_device_id=None, code=False,
    )
    steps[0]["result"] = "接口在 api/plans.py"
    steps[1]["history"] = [{"agent": "codex", "error": "额度用完"}]
    plan = _plan(steps)
    text = ps.build_step_prompt(plan, steps[1], steps)
    assert "写界面" in text and "接口在 api/plans.py" in text and "额度用完" in text and "不要 git commit" in text
    assert "- 接口" in text
    review = ps.build_step_prompt(plan, steps[2], steps)
    assert "复查" in review and "测试通过" in review and "接口在 api/plans.py" in review


def test_result_of_reads_workspace_and_failures():
    ok, kept = ps._result_of({"status": "succeeded", "exit_code": 0, "stdout": "done", "events": [
        {"kind": "workspace", "status": "synced"},
        {"kind": "workspace", "status": "conflict", "branch": "memento/abc", "files": [{"path": "a"}]},
    ]})
    assert ok and kept["workspace"] == {"status": "conflict", "branch": "memento/abc", "patch_path": None, "files": 1, "error": None}
    ok, kept = ps._result_of({"error": "设备离线"})
    assert not ok and kept["error"] == "设备离线"
    ok, _ = ps._result_of({"status": "succeeded", "exit_code": 1})
    assert not ok


@pytest.mark.asyncio
async def test_failed_step_goes_back_to_pending_without_its_agent_then_fails_for_good(monkeypatch):
    step = ps._new_step("s1", "t", "p", agent="codex", device_id="mac")
    step.update(status="running", attempts=1, task_id="t1")
    plan = _plan([step])
    monkeypatch.setattr(ps, "_mutate", _mutate_on(plan))

    await ps._finish_step(plan.id, "s1", 1, {"status": "failed", "error": "usage limit", "error_type": "usage_limit"})
    s = plan.steps[0]
    assert s["status"] == "pending" and s["tried"] == [["mac", "codex"]] and s["agent"] == "" and s["task_id"] is None
    assert s["history"][0]["error_type"] == "usage_limit"

    # A stale result (another attempt by now) changes nothing
    await ps._finish_step(plan.id, "s1", 1, {"status": "succeeded"})
    assert plan.steps[0]["status"] == "pending"

    plan.steps[0].update(status="running", attempts=ps.MAX_ATTEMPTS, device_id="vps3", agent="claude")
    await ps._finish_step(plan.id, "s1", ps.MAX_ATTEMPTS, {"status": "timeout", "error": "超时"})
    assert plan.steps[0]["status"] == "failed"


@pytest.mark.asyncio
async def test_cancelled_result_and_success(monkeypatch):
    a = ps._new_step("a", "A", "p", agent="codex", device_id="mac")
    b = ps._new_step("b", "B", "p", agent="codex", device_id="mac")
    a.update(status="running", attempts=1)
    b.update(status="running", attempts=1)
    plan = _plan([a, b])
    monkeypatch.setattr(ps, "_mutate", _mutate_on(plan))
    await ps._finish_step(plan.id, "a", 1, {"status": "cancelled"})
    await ps._finish_step(plan.id, "b", 1, {"status": "succeeded", "stdout": "ok"})
    assert plan.steps[0]["status"] == "cancelled"
    assert plan.steps[1]["status"] == "succeeded" and plan.steps[1]["result"] == "ok"


@pytest.mark.asyncio
async def test_cancel_plan_stops_running_device_tasks(monkeypatch):
    a = ps._new_step("a", "A", "p")
    b = ps._new_step("b", "B", "p")
    c = ps._new_step("c", "C", "p")
    a.update(status="running", task_id="t-a")
    c.update(status="succeeded")
    plan = _plan([a, b, c])
    monkeypatch.setattr(ps, "_mutate", _mutate_on(plan))
    stopped = AsyncMock()
    monkeypatch.setattr(ps, "_cancel_device_task", stopped)
    await ps.cancel_plan(plan.id)
    assert plan.status == "cancelled"
    assert [s["status"] for s in plan.steps] == ["cancelled", "cancelled", "succeeded"]
    stopped.assert_awaited_once_with("t-a")


@pytest.mark.asyncio
async def test_retry_step_reopens_it_its_skipped_dependents_and_the_review(monkeypatch):
    steps = ps.normalize_steps(
        [{"id": "a", "prompt": "a"}, {"id": "b", "prompt": "b", "depends_on": ["a"]}, {"id": "c", "prompt": "c"}],
        _snapshot(), source_device_id=None, code=False,
    )
    for s, st in zip(steps, ["failed", "skipped", "succeeded", "skipped"]):
        s["status"] = st
    steps[0]["attempts"] = 3
    steps[0]["tried"] = [["mac", "codex"]]
    plan = _plan(steps, status="failed")
    monkeypatch.setattr(ps, "_mutate", _mutate_on(plan))
    await ps.retry_step(plan.id, "a")
    assert [s["status"] for s in plan.steps] == ["pending", "pending", "succeeded", "pending"]
    assert plan.steps[0]["attempts"] == 0 and plan.steps[0]["tried"] == []
    assert plan.status == "running"


@pytest.mark.asyncio
async def test_run_step_records_task_id_then_result(monkeypatch):
    step = ps._new_step("s1", "t", "p", agent="codex", device_id="mac")
    step.update(status="running", attempts=1)
    plan = _plan([step])
    monkeypatch.setattr(ps, "_mutate", _mutate_on(plan))

    seen = []

    async def fake_run(_db, _user, args):
        seen.append(args)
        yield {"type": "task_progress", "task_id": "T1", "device_name": "MacBook (Darwin)"}
        assert plan.steps[0]["task_id"] == "T1"
        yield {"type": "task_chunk", "text": "..."}
        yield {"type": "tool_result", "result": {"status": "succeeded", "stdout": "完成", "exit_code": 0}}

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, model, _id):
            return plan if model is ps.AgentPlan else SimpleNamespace(id=plan.user_id)

    monkeypatch.setattr(ps, "async_session_factory", Session)
    with patch("server.services.orchestrator._tool_run_on_device", fake_run), \
            patch.object(ps, "_step_args", AsyncMock(return_value={"action": "agent", "binary": "codex"})):
        await ps._run_step(plan.id, "s1", 1)
    assert seen[0]["binary"] == "codex"
    s = plan.steps[0]
    assert s["status"] == "succeeded" and s["result"] == "完成" and s["device_name"] == "MacBook"


@pytest.mark.asyncio
async def test_advance_reassigns_a_retried_step_whose_agent_timed_out(monkeypatch):
    # Retry by hand keeps the step's last agent; it timed out before, so the scheduler picks again
    step = ps._new_step("s2", "测试", "写测试", agent="antigravity", device_id="vps3")
    step["history"] = [{"attempt": 3, "agent": "antigravity", "device_id": "vps3", "status": "timeout", "error_type": None}]
    plan = _plan([step])
    monkeypatch.setattr(ps, "_mutate", _mutate_on(plan))
    monkeypatch.setattr(ps, "capability_snapshot", AsyncMock(return_value=_snapshot()))
    spawned = []
    monkeypatch.setattr(ps, "_spawn", lambda key, coro: (spawned.append(key), coro.close()))

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, model, _id):
            return plan if model is ps.AgentPlan else SimpleNamespace(id=plan.user_id)

    monkeypatch.setattr(ps, "async_session_factory", Session)
    await ps._advance(plan.id)
    s = plan.steps[0]
    assert s["status"] == "running" and s["agent"] != "antigravity" and spawned == [f"{plan.id}/s2"]


@pytest.mark.asyncio
async def test_advance_swaps_a_planned_model_whose_quota_ran_out_since(monkeypatch):
    # Planned with g3; by the time it starts g3 is spent too and only g2 has quota left
    step = ps._new_step("s1", "界面", "写界面", agent="antigravity", device_id="vps3", model="g3")
    plan = _plan([step])
    snap = _snapshot()
    snap["devices"][1]["agents"]["antigravity"] = ps.model_roster(
        "antigravity", ["g4", "g3", "g2"], {"limited_models": [{"family": f, "until": _LATER} for f in ("g4", "g3")]}, default="g4")
    monkeypatch.setattr(ps, "_mutate", _mutate_on(plan))
    monkeypatch.setattr(ps, "capability_snapshot", AsyncMock(return_value=snap))
    monkeypatch.setattr(ps, "_spawn", lambda key, coro: coro.close())

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, model, _id):
            return plan if model is ps.AgentPlan else SimpleNamespace(id=plan.user_id)

    monkeypatch.setattr(ps, "async_session_factory", Session)
    await ps._advance(plan.id)
    s = plan.steps[0]
    assert (s["status"], s["device_id"], s["agent"], s["model"]) == ("running", "vps3", "antigravity", "g2")


@pytest.mark.asyncio
async def test_stop_runner_leaves_the_device_task_going(monkeypatch):
    import asyncio

    from server.services.ask_runs import ask_runs

    monkeypatch.setattr(ask_runs, "shutting_down", False)
    seen = {}

    async def following():
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            seen["keeps"] = ask_runs.keeps_device_tasks("T1")
            raise

    task = asyncio.create_task(following())
    await asyncio.sleep(0)
    monkeypatch.setitem(ps._local, "p/s1", task)
    await ps.stop_plan_runner()
    assert seen["keeps"] is True and task.cancelled()
