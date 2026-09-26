import asyncio
import json
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import User
from server.services import ask_runs as ar


def frame(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def types(frames: list[str]) -> list[str]:
    out = []
    for f in frames:
        line = next(l for l in f.split("\n") if l.startswith("data: "))
        out.append(json.loads(line[6:])["type"])
    return out


class RunRegistryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.user = User(id=uuid.uuid4(), email="u@example.com")
        session = AsyncMock()
        session.get.return_value = self.user
        factory = MagicMock()
        factory.return_value.__aenter__.return_value = session
        self.patches = [
            patch.object(ar, "async_session_factory", factory),
            patch.object(ar, "RETAIN_AFTER_DONE", 0.05),
            patch.object(ar.notify_service, "notify_user", AsyncMock(return_value=True)),
        ]
        for p in self.patches:
            p.start()
        self.notify = ar.notify_service.notify_user
        self.registry = ar.AskRunRegistry()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    async def _collect(self, agen, limit=None):
        out = []
        async for f in agen:
            if f.startswith(":"):
                continue
            out.append(f)
            if limit and len(out) >= limit:
                break
        return out

    async def test_run_keeps_going_after_reader_disconnects(self):
        release = asyncio.Event()
        saved = []

        async def gen(db, user):
            yield frame({"type": "conversation_id", "id": "c1"})
            await release.wait()
            yield frame({"type": "delta", "text": "hello"})
            saved.append(True)  # stands in for persisting the conversation
            yield frame({"type": "done"})

        run = self.registry.start("c1", self.user.id, "q", gen, request_id="r1")
        reader = run.stream(0)
        first = await self._collect(reader, limit=2)
        await reader.aclose()  # phone went to the background
        self.assertEqual(types(first), ["run_started", "conversation_id"])
        self.assertEqual(run.readers, 0)

        release.set()
        await run.task
        self.assertTrue(run.done)
        self.assertEqual(saved, [True])
        self.assertEqual(types(run.frames), ["run_started", "conversation_id", "delta", "done"])

    async def test_reattach_resumes_after_last_seen_id(self):
        async def gen(db, user):
            for i in range(3):
                yield frame({"type": "delta", "text": str(i)})

        run = self.registry.start("c2", self.user.id, "q", gen)
        await run.task
        resumed = await self._collect(run.stream(2))
        self.assertTrue(resumed[0].startswith("id: 3\n"))
        self.assertEqual(types(resumed), ["delta", "delta"])

    async def test_cancel_stops_the_generator(self):
        cleaned_up = asyncio.Event()

        async def gen(db, user):
            try:
                yield frame({"type": "tool_call"})
                await asyncio.sleep(3600)
            finally:
                cleaned_up.set()  # where the orchestrator tells the device to stop

        run = self.registry.start("c3", self.user.id, "q", gen)
        await asyncio.sleep(0.01)
        self.assertTrue(self.registry.cancel("c3", self.user.id))
        await asyncio.wait_for(run.task, 1)
        self.assertTrue(cleaned_up.is_set())
        self.assertEqual(types(run.frames)[-2:], ["error", "done"])
        self.assertFalse(self.registry.cancel("c3", self.user.id))

    async def test_one_run_per_conversation_and_retries_attach(self):
        release = asyncio.Event()

        async def gen(db, user):
            await release.wait()
            yield frame({"type": "done"})

        run = self.registry.start("c4", self.user.id, "q", gen, request_id="req-1")
        with self.assertRaises(ar.RunConflict):
            self.registry.start("c4", self.user.id, "again", gen)
        self.assertIs(self.registry.by_request("req-1", self.user.id), run)
        self.assertIsNone(self.registry.by_request("req-1", uuid.uuid4()))  # other users can't attach
        self.assertIsNone(self.registry.get("c4", uuid.uuid4()))
        release.set()
        await run.task

    async def test_finished_run_is_dropped_after_retention(self):
        async def gen(db, user):
            yield frame({"type": "done"})

        run = self.registry.start("c5", self.user.id, "q", gen)
        await run.task
        self.assertIs(self.registry.get("c5", self.user.id), run)
        await asyncio.sleep(0.1)
        self.assertIsNone(self.registry.get("c5", self.user.id))

    async def test_unwatched_long_run_pushes_when_done(self):
        async def gen(db, user):
            yield frame({"type": "done"})

        with patch.object(ar, "NOTIFY_MIN_SECONDS", 0):
            run = self.registry.start("c6", self.user.id, "修复登录 bug\n细节", gen)
            await run.task
            await asyncio.sleep(0)
        self.notify.assert_awaited_once()
        args = self.notify.await_args.args
        self.assertEqual(args[1:4], ("task_done", "✅ 任务完成", "修复登录 bug"))

    async def test_watched_or_short_runs_do_not_push(self):
        release = asyncio.Event()

        async def gen(db, user):
            await release.wait()
            yield frame({"type": "done"})

        with patch.object(ar, "NOTIFY_MIN_SECONDS", 0):
            run = self.registry.start("c7", self.user.id, "q", gen, request_id="r7")
            reader = run.stream(0)
            consume = asyncio.create_task(self._collect(reader))
            await asyncio.sleep(0.01)
            release.set()
            await run.task
            await consume
        self.notify.assert_not_awaited()

        async def quick(db, user):
            yield frame({"type": "done"})

        run = self.registry.start("c8", self.user.id, "q", quick)  # NOTIFY_MIN_SECONDS back to 15
        await run.task
        self.notify.assert_not_awaited()

    async def test_pings_are_not_buffered(self):
        async def gen(db, user):
            yield ": ping\n\n"
            yield frame({"type": "ping"})
            yield frame({"type": "done"})

        run = self.registry.start("c9", self.user.id, "q", gen)
        await run.task
        self.assertEqual(types(run.frames), ["run_started", "done"])

    async def test_legacy_clients_still_stop_by_disconnecting(self):
        stopped = asyncio.Event()

        async def gen(db, user):
            try:
                yield frame({"type": "tool_call"})
                await asyncio.sleep(3600)
            finally:
                stopped.set()

        run = self.registry.start("c10", self.user.id, "q", gen)  # no request id: old app
        reader = run.stream(0)
        await self._collect(reader, limit=2)  # generator is running
        await reader.aclose()
        await asyncio.wait(({run.task}), timeout=1)
        self.assertTrue(stopped.is_set())
        self.assertTrue(run.cancelled)
        self.assertTrue(run.done)

    async def test_cancel_before_the_run_starts_still_closes_it(self):
        async def gen(db, user):
            yield frame({"type": "tool_call"})

        run = self.registry.start("c11", self.user.id, "q", gen, request_id="r11")
        self.assertTrue(self.registry.cancel("c11", self.user.id))  # before the task's first step
        await asyncio.wait({run.task}, timeout=1)
        await asyncio.sleep(0)
        self.assertTrue(run.done)
        self.assertEqual(types(run.frames)[-2:], ["error", "done"])
        # the conversation isn't blocked afterwards
        run2 = self.registry.start("c11", self.user.id, "again", gen, request_id="r12")
        await run2.task
        self.assertTrue(run2.done)


if __name__ == "__main__":
    unittest.main()
