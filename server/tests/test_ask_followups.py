import asyncio
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from server.api import tasks as tasks_api
from server.services import ask_followups as af


class FakeRedis:
    """The few list commands the follow-up queue uses, with a transactional pipeline."""

    def __init__(self):
        self.lists: dict[str, list[str]] = {}

    async def lrange(self, key, start, end):
        items = self.lists.get(key, [])
        return list(items if end == -1 else items[start : end + 1])

    async def lrem(self, key, count, value):
        items = self.lists.get(key, [])
        if value in items:
            items.remove(value)
            return 1
        return 0

    def pipeline(self, transaction=True):
        redis = self

        class Pipe:
            def __init__(self):
                self.ops = []

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            def rpush(self, key, value):
                self.ops.append(("rpush", key, value))

            def expire(self, key, ttl):
                self.ops.append(("expire", key, ttl))

            def lrange(self, key, start, end):
                self.ops.append(("lrange", key, start, end))

            def delete(self, key):
                self.ops.append(("delete", key))

            async def execute(self):
                out = []
                for op in self.ops:
                    if op[0] == "rpush":
                        redis.lists.setdefault(op[1], []).append(op[2])
                        out.append(len(redis.lists[op[1]]))
                    elif op[0] == "lrange":
                        out.append(list(redis.lists.get(op[1], [])))
                    elif op[0] == "delete":
                        out.append(1 if redis.lists.pop(op[1], None) is not None else 0)
                    else:
                        out.append(True)
                return out

        return Pipe()


class QueueTests(unittest.TestCase):
    def setUp(self):
        af._local.clear()

    def run_both(self, fn):
        """The same behaviour with Redis (replicas) and without (one process)."""
        for redis in (None, FakeRedis()):
            af._local.clear()
            with patch.object(type(af.cluster), "redis", new_callable=lambda: property(lambda self: redis)):
                asyncio.run(fn())

    def test_add_pop_in_order_once(self):
        async def go():
            self.assertTrue(await af.add("u", "c", "先看日志", at=2))
            self.assertTrue(await af.add("u", "c", "  再跑测试 ", at=3))
            self.assertFalse(await af.add("u", "c", "先看日志"))  # the same text isn't queued twice
            self.assertFalse(await af.add("u", "c", "   "))
            self.assertEqual([i["text"] for i in await af.peek("u", "c")], ["先看日志", "再跑测试"])
            self.assertEqual([i["text"] for i in await af.pop("u", "c")], ["先看日志", "再跑测试"])
            self.assertEqual(await af.pop("u", "c"), [])  # handed out once
            self.assertEqual(await af.peek("u", "other"), [])

        self.run_both(go)

    def test_withdraw(self):
        async def go():
            await af.add("u", "c", "撤回这条")
            await af.add("u", "c", "留着")
            self.assertTrue(await af.remove("u", "c", "撤回这条"))
            self.assertFalse(await af.remove("u", "c", "没有这条"))
            self.assertEqual([i["text"] for i in await af.pop("u", "c")], ["留着"])

        self.run_both(go)

    def test_users_are_separate(self):
        async def go():
            await af.add("u1", "c", "我的")
            self.assertEqual(await af.pop("u2", "c"), [])
            self.assertEqual(len(await af.pop("u1", "c")), 1)

        self.run_both(go)


class SteerReportTests(unittest.TestCase):
    def setUp(self):
        af._local.clear()

    def test_late_and_unsupported_are_kept_for_the_conversation(self):
        async def go():
            with patch.object(af, "task_owner", AsyncMock(return_value=("u", "conv1"))), \
                 patch.object(type(af.cluster), "redis", new_callable=lambda: property(lambda self: None)):
                await af.note_steer("t1", {"kind": "steer", "status": "late", "text": "还有那个终端接力"})
                await af.note_steer("t1", {"kind": "steer", "status": "unsupported", "text": "顺便看 README"})
                await af.note_steer("t1", {"kind": "steer", "status": "sent", "text": "已送达的"})
                return [i["text"] for i in await af.pop("u", "conv1")]

        self.assertEqual(asyncio.run(go()), ["还有那个终端接力", "顺便看 README"])


class TaskInputTests(unittest.TestCase):
    """POST /api/tasks/{id}/input when the task can't take it any more: kept for the next message."""

    def setUp(self):
        af._local.clear()

    def call(self, status, sent=True):
        task = SimpleNamespace(
            id=uuid.uuid4(), user_id="u", device_id="dev", status=status, payload={"conversation_id": "conv9"}
        )
        result = SimpleNamespace(scalar_one_or_none=lambda: task)
        db = SimpleNamespace(execute=AsyncMock(return_value=result))
        user = SimpleNamespace(id="u", role="owner")
        body = SimpleNamespace(input="补一句", question_id=None)

        async def go():
            with patch.object(tasks_api.ws_manager, "send_input", AsyncMock(return_value=sent)), \
                 patch.object(type(af.cluster), "redis", new_callable=lambda: property(lambda self: None)):
                res = await tasks_api.send_task_input(str(task.id), body, db=db, _user=user)
                return res, [i["text"] for i in await af.pop("u", "conv9")]

        return asyncio.run(go())

    def test_finished_task_queues_it(self):
        res, kept = self.call("succeeded")
        self.assertEqual((res["ok"], res["queued"]), (False, True))
        self.assertEqual(kept, ["补一句"])

    def test_device_offline_queues_it(self):
        res, kept = self.call("running", sent=False)
        self.assertEqual(res, {"ok": False, "queued": True})
        self.assertEqual(kept, ["补一句"])

    def test_running_task_takes_it(self):
        res, kept = self.call("running")
        self.assertEqual(res, {"ok": True})
        self.assertEqual(kept, [])


if __name__ == "__main__":
    unittest.main()
