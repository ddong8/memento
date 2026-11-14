"""Tasks cut off by a restart of the device's app end with the reason once its daemon reports what it runs."""
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.api import tasks


class _Session:
    def __init__(self, ids, seen):
        self.ids, self.seen = ids, seen

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def execute(self, stmt):
        self.seen.append(str(stmt.compile(compile_kwargs={"literal_binds": False})))
        res = MagicMock()
        res.scalars.return_value.all.return_value = self.ids
        return res


class SettleLostTasks(unittest.IsolatedAsyncioTestCase):
    async def _run(self, data, ids):
        seen: list[str] = []
        save = AsyncMock(return_value=True)
        push = MagicMock()
        with patch.object(tasks, "async_session_factory", lambda: _Session(ids, seen)), \
             patch.object(tasks, "_save_finished", save), \
             patch.object(tasks, "_recover_turn", AsyncMock()), \
             patch.object(tasks.ws_manager, "is_watched", AsyncMock(return_value=True)), \
             patch.object(tasks.ws_manager, "push_finished", push):
            ended = await tasks._settle_lost_tasks("dev-1", data)
        return ended, save, push, seen

    async def test_ends_only_tasks_the_daemon_no_longer_has(self):
        lost, alive = uuid.uuid4(), uuid.uuid4()
        ended, save, push, seen = await self._run({"task_ids": [str(alive)], "uptime_ms": 60_000}, [lost, alive])
        self.assertEqual(ended, [str(lost)])
        result = push.call_args.args[1]
        self.assertEqual(result["status"], "failed")
        self.assertIn("重启", result["error"])
        self.assertEqual(save.call_args.args[0], str(lost))
        # Only running tasks of this device sent before the daemon started
        self.assertIn("device_tasks.status", seen[0])
        self.assertIn("coalesce(device_tasks.dispatched_at, device_tasks.created_at) <", seen[0])

    async def test_ignores_a_report_without_a_usable_uptime(self):
        for data in ({"task_ids": []}, {"uptime_ms": "x"}, {"uptime_ms": -5}, {"uptime_ms": 10**15}):
            ended, save, push, _ = await self._run(data, [uuid.uuid4()])
            self.assertEqual(ended, [], data)
            push.assert_not_called()

    async def test_nothing_to_end(self):
        ended, _, push, _ = await self._run({"task_ids": [], "uptime_ms": 5_000}, [])
        self.assertEqual(ended, [])
        push.assert_not_called()


if __name__ == "__main__":
    unittest.main()
