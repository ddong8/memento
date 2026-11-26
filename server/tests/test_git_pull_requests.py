"""Pull requests through `gh` on the device: CI state from GitHub's mixed rollup, merges keep the history
linear by default, and the CI watcher pushes the outcome once nothing is pending."""

import asyncio
import json
import uuid
from unittest.mock import AsyncMock, patch

from server.api import git_review
from server.db.models import User


def test_check_state_from_runs_and_statuses():
    s = git_review.summarize_checks
    assert s([])["state"] == "none"
    assert s([{"status": "COMPLETED", "conclusion": "SUCCESS"}, {"state": "SUCCESS"}]) == {
        "state": "success", "passed": 2, "failed": 0, "pending": 0, "total": 2}
    assert s([{"status": "IN_PROGRESS", "conclusion": ""}, {"status": "COMPLETED", "conclusion": "SUCCESS"}])["state"] == "pending"
    assert s([{"status": "COMPLETED", "conclusion": "FAILURE"}, {"status": "QUEUED"}])["state"] == "failure"
    assert s([{"state": "PENDING"}])["state"] == "pending"
    assert s([{"status": "COMPLETED", "conclusion": "SKIPPED"}])["state"] == "success"


def _user():
    return User(id=uuid.uuid4(), email="u@example.com", role="owner")


def test_merge_defaults_to_rebase_and_rejects_odd_methods():
    ran: list[str] = []

    async def fake_gh(device, cwd, args, db, user, *, timeout=30.0):
        ran.append(args)
        return "merged"

    with patch.object(git_review, "_gh", fake_gh):
        asyncio.run(git_review.git_pr_merge(git_review.GitPrMergeRequest(device_id="d", cwd="/r", number=7), db=AsyncMock(), _user=_user()))
        asyncio.run(git_review.git_pr_merge(
            git_review.GitPrMergeRequest(device_id="d", cwd="/r", number=7, method="squash; rm -rf /", delete_branch=False),
            db=AsyncMock(), _user=_user()))
    assert ran == ["pr merge 7 --rebase --delete-branch", "pr merge 7 --rebase"]


def test_list_carries_ci_state_and_author_login():
    rows = [{"number": 3, "title": "t", "author": {"login": "ddong8"}, "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "FAILURE"}]}]

    async def fake_gh(device, cwd, args, db, user, *, timeout=30.0):
        assert args.startswith("pr list --state open --limit 40 --json ")
        return json.dumps(rows)

    with patch.object(git_review, "_gh", fake_gh):
        out = asyncio.run(git_review.git_pr_list(git_review.GitPrListRequest(device_id="d", cwd="/r", state="bogus"), db=AsyncMock(), _user=_user()))
    assert out["prs"][0]["author"] == "ddong8"
    assert out["prs"][0]["checks"]["state"] == "failure"


def test_the_ci_watcher_waits_out_pending_checks_then_pushes_once():
    answers = iter([
        [{"status": "IN_PROGRESS"}],
        [{"status": "COMPLETED", "conclusion": "SUCCESS"}, {"status": "COMPLETED", "conclusion": "SUCCESS"}],
    ])

    async def fake_gh(device, cwd, args, db, user, *, timeout=30.0):
        return json.dumps({"number": 9, "title": "加权限模式", "url": "https://github.com/x/y/pull/9", "statusCheckRollup": next(answers)})

    pushed = AsyncMock(return_value=True)

    class FakeSession:
        async def __aenter__(self):
            return AsyncMock()

        async def __aexit__(self, *a):
            return False

    with (
        patch.object(git_review, "_gh", fake_gh),
        patch("server.services.cluster.cluster.try_lock", AsyncMock(return_value="tok")),
        patch("server.db.session.async_session_factory", lambda: FakeSession()),
        patch("server.services.notify_service.notify_user", pushed),
    ):
        state = asyncio.run(git_review._watch_pr_checks(_user(), "d", "/r", 9, interval=0))
    assert state == "success"
    assert pushed.await_count == 1
    assert pushed.await_args.args[2] == "CI 通过"
    assert "PR #9 加权限模式" in pushed.await_args.args[3]


def test_repos_in_a_project_folder_cwd_first_node_modules_skipped():
    out = "./.git\n./web/.git\n./server/.git\n./web/.git\n"
    assert git_review.parse_repo_roots(out, "/w/proj/", False) == ["/w/proj", "/w/proj/server", "/w/proj/web"]
    assert git_review.parse_repo_roots("./api/.git\n", "/w/mono", False) == ["/w/mono/api"]
    cmd = git_review.repos_command("/w/my proj", False)
    assert "'/w/my proj'" in cmd and "node_modules -prune" in cmd and "-maxdepth 3" in cmd
    win = git_review.parse_repo_roots("C:\\code\\proj\nC:\\code\\proj\\web\n", "C:\\code\\proj", True)
    assert win == ["C:\\code\\proj", "C:\\code\\proj\\web"]
