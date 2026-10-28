"""Two api replicas sharing one (fake) Redis: devices, task output, ask runs and
shared caches work whichever replica a request or a device lands on."""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import fakeredis

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.db.models import User  # noqa: E402
from server.services import ask_runs as ar  # noqa: E402
from server.services.cluster import Cluster, SharedDict  # noqa: E402
from server.services.ws_manager import DeviceConnectionManager  # noqa: E402


def frame(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def types(frames: list[str]) -> list[str]:
    out = []
    for f in frames:
        line = next(line for line in f.split("\n") if line.startswith("data: "))
        out.append(json.loads(line[6:])["type"])
    return out


async def eventually(check, timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


class TwoReplicas(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.server = fakeredis.FakeServer()
        make = lambda: fakeredis.FakeAsyncRedis(server=self.server, decode_responses=True)  # noqa: E731
        self.a, self.b = Cluster(make, pod_id="pod-a"), Cluster(make, pod_id="pod-b")
        self.build()
        await self.a.start()
        await self.b.start()

    def build(self) -> None:
        """Create the per-replica objects (before start, like module imports)."""

    async def asyncTearDown(self) -> None:
        await self.a.stop()
        await self.b.stop()


class DeviceAcrossReplicas(TwoReplicas):
    def build(self) -> None:
        self.wa, self.wb = DeviceConnectionManager(self.a), DeviceConnectionManager(self.b)

    async def connect(self) -> AsyncMock:
        ws = AsyncMock()
        await self.wa.register("dev-hash", ws, "MacMini", "machine-1")
        await eventually(lambda: self.wb.has_device("MacMini"))
        return ws

    async def test_presence_dispatch_output_and_cancel(self) -> None:
        ws = await self.connect()
        self.assertTrue(self.wb.has_device("dev-hash"))
        self.assertTrue(self.wb.has_online_devices())

        # The ask waiting on the task lives on B; the device is on A
        q = await self.wb.subscribe_task("t1")
        self.assertTrue(await self.wb.send_task("MacMini", {"id": "t1", "action": "shell"}))
        sent = ws.send_json.await_args.args[0]
        self.assertEqual((sent["type"], sent["task"]["id"]), ("task_dispatch", "t1"))
        self.assertTrue(await self.wa.is_watched("t1"))  # so A won't treat the result as orphaned

        for i in range(20):
            self.wa.push_chunk("t1", "stdout", f"line {i}\n")
        self.wa.push_finished("t1", {"status": "succeeded"})
        got = [await asyncio.wait_for(q.get(), 2) for _ in range(21)]
        self.assertEqual([e["text"] for e in got[:20]], [f"line {i}\n" for i in range(20)])
        self.assertEqual(got[-1]["type"], "task_finished")

        self.assertTrue(await self.wb.send_cancel("dev-hash", "t1"))
        self.assertEqual(ws.send_json.await_args.args[0], {"type": "task_cancel", "task_id": "t1"})
        self.assertTrue(await self.wb.send_input("dev-hash", "t1", "y"))
        self.assertEqual(ws.send_json.await_args.args[0], {"type": "task_input", "task_id": "t1", "input": "y"})
        # An answer to the agent's question carries the question's id across replicas
        self.assertTrue(await self.wb.send_input("dev-hash", "t1", "蓝", "r1:0"))
        self.assertEqual(ws.send_json.await_args.args[0], {"type": "task_input", "task_id": "t1", "input": "蓝", "question_id": "r1:0"})

        await self.wb.unsubscribe_task("t1")
        self.assertFalse(await self.wa.is_watched("t1"))

    async def test_a_cancel_for_a_device_away_is_sent_when_it_is_back(self) -> None:
        # Asleep: its agent goes on and would run beside the next question's once it wakes
        self.assertFalse(await self.wb.cancel_when_back("MacMini", "t-old"))
        ws = AsyncMock()
        await self.wa.register("dev-hash", ws, "MacMini", "machine-1")
        await self.wa.send_kept_cancels("dev-hash", "MacMini", "machine-1")
        self.assertEqual(ws.send_json.await_args_list[-1].args[0], {"type": "task_cancel", "task_id": "t-old"})
        # Sent once
        await self.wa.send_kept_cancels("dev-hash", "MacMini", "machine-1")
        self.assertEqual(ws.send_json.await_count, 1)
        # Connected: sent right away, nothing kept
        await eventually(lambda: self.wb.has_device("MacMini"))
        self.assertTrue(await self.wb.cancel_when_back("MacMini", "t-2"))
        self.assertEqual(ws.send_json.await_args.args[0], {"type": "task_cancel", "task_id": "t-2"})

    async def test_file_reads_are_relayed(self) -> None:
        ws = await self.connect()

        async def device_answers() -> None:
            await eventually(lambda: ws.send_json.await_count > 0)
            req = ws.send_json.await_args.args[0]
            self.assertEqual(req["type"], "file_chunk_req")
            self.wa.handle_file_response({"req_id": req["req_id"], "data_b64": base64.b64encode(b"video bytes").decode()})

        answer = asyncio.create_task(device_answers())
        chunk = await self.wb.request_file_chunk("dev-hash", "/v.mp4", 0, 11, timeout=2)
        await answer
        self.assertEqual(chunk, b"video bytes")

    async def test_broadcast_reaches_each_device_once(self) -> None:
        ws = await self.connect()
        await self.wb.broadcast({"type": "get_agent_quotas"})
        await eventually(lambda: ws.send_json.await_count == 1)
        await asyncio.sleep(0.05)
        self.assertEqual(ws.send_json.await_count, 1)  # three aliases, one socket

    async def test_disconnect_and_reconnect_elsewhere(self) -> None:
        old = await self.connect()
        # The device reconnects to B before A notices its old socket is dead
        new = AsyncMock()
        await self.wb.register("dev-hash", new, "MacMini", "machine-1")
        await eventually(lambda: not self.wa._connections)
        self.assertTrue(self.wa.has_device("MacMini"))  # now through B
        self.assertTrue(await self.wa.send_json("MacMini", {"type": "ping"}))
        new.send_json.assert_awaited_with({"type": "ping"})
        old.send_json.assert_not_awaited()
        # A's late goodbye for the old socket must not take the device offline
        await self.wa.unregister("dev-hash", old)
        await asyncio.sleep(0.05)
        self.assertTrue(self.wa.has_device("MacMini"))
        self.assertEqual(await self.b.owner("device:MacMini"), "pod-b")

        await self.wb.unregister("dev-hash", new)
        await eventually(lambda: not self.wa.has_device("MacMini"))

    async def test_replica_that_died_is_forgotten(self) -> None:
        await self.connect()
        await self.a.stop()  # crashes: no goodbye to B, keys left until they expire
        self.assertFalse(await self.wb.send_json("MacMini", {"type": "ping"}))
        self.assertFalse(self.wb.has_device("MacMini"))


class SharedCachesAcrossReplicas(TwoReplicas):
    def build(self) -> None:
        self.qa, self.qb = SharedDict(self.a, "quotas"), SharedDict(self.b, "quotas")

    async def test_report_reaches_other_and_later_replicas(self) -> None:
        self.qa.set(("dev-hash", "MacMini", None), {"tools": {"codex": 40}})
        await eventually(lambda: "MacMini" in self.qb.data)
        self.assertEqual(self.qb.data["dev-hash"], {"tools": {"codex": 40}})
        await self.a.flush()
        c = Cluster(lambda: fakeredis.FakeAsyncRedis(server=self.server, decode_responses=True), pod_id="pod-c")
        qc = SharedDict(c, "quotas")
        await c.start()
        try:
            self.assertEqual(qc.data.get("MacMini"), {"tools": {"codex": 40}})
        finally:
            await c.stop()


class AskRunsAcrossReplicas(TwoReplicas):
    def build(self) -> None:
        self.ra, self.rb = ar.AskRunRegistry(self.a), ar.AskRunRegistry(self.b)

    async def asyncSetUp(self) -> None:
        self.user = User(id=uuid.uuid4(), email="u@example.com")
        session = AsyncMock()
        session.get.return_value = self.user
        factory = MagicMock()
        factory.return_value.__aenter__.return_value = session
        self.patches = [
            patch.object(ar, "async_session_factory", factory),
            patch.object(ar.notify_service, "notify_user", AsyncMock(return_value=True)),
            patch.object(ar.notify_service, "push_live_activity_event", AsyncMock(return_value=True)),
        ]
        for p in self.patches:
            p.start()
        await super().asyncSetUp()

    async def asyncTearDown(self) -> None:
        await super().asyncTearDown()
        for p in self.patches:
            p.stop()

    async def collect(self, agen, limit: int | None = None) -> list[str]:
        out = []
        async for f in agen:
            if f.startswith(":"):
                continue
            out.append(f)
            if limit and len(out) >= limit:
                break
        return out

    def gated(self, release: asyncio.Event, cleaned: asyncio.Event | None = None):
        async def gen(db, user):
            try:
                yield frame({"type": "conversation_id", "id": "c1"})
                await release.wait()
                for i in range(3):
                    yield frame({"type": "delta", "text": str(i)})
                yield frame({"type": "done"})
            finally:
                if cleaned:
                    cleaned.set()
        return gen

    async def test_follow_a_run_from_the_other_replica(self) -> None:
        release = asyncio.Event()
        run = await self.ra.start("c1", self.user.id, "q", self.gated(release), request_id="req-1")

        remote = await self.rb.get("c1", self.user.id)
        self.assertIsInstance(remote, ar.RemoteRun)
        self.assertFalse(remote.done)
        self.assertIsNone(await self.rb.get("c1", uuid.uuid4()))  # other users see nothing
        self.assertEqual((await self.rb.by_request("req-1", self.user.id)).run_id, run.run_id)
        self.assertEqual([r.conversation_id for r in await self.rb.active_for_user(self.user.id)], ["c1"])

        reader = asyncio.create_task(self.collect(remote.stream(0)))
        await asyncio.sleep(0.05)
        release.set()
        frames = await asyncio.wait_for(reader, 3)
        self.assertEqual(types(frames), ["run_started", "conversation_id", "delta", "delta", "delta", "done"])
        self.assertEqual([f.split("\n")[0] for f in frames], [f"id: {i}" for i in range(1, 7)])

        # Reattaching after the last seen id replays only the rest, like on the run's own replica
        resumed = await self.collect((await self.rb.get("c1", self.user.id)).stream(4))
        self.assertEqual(types(resumed), ["delta", "done"])
        self.assertTrue((await self.rb.get("c1", self.user.id)).summary()["done"])

    async def test_one_run_per_conversation_across_replicas(self) -> None:
        release = asyncio.Event()
        run = await self.ra.start("c2", self.user.id, "q", self.gated(release))
        with self.assertRaises(ar.RunConflict):
            await self.rb.start("c2", self.user.id, "again", self.gated(release))
        release.set()
        await run.task
        follow_up = await self.rb.start("c2", self.user.id, "next", self.gated(release))
        await follow_up.task
        self.assertEqual((await self.ra.get("c2", self.user.id)).run_id, follow_up.run_id)

    async def test_stop_from_the_other_replica(self) -> None:
        release, cleaned = asyncio.Event(), asyncio.Event()
        run = await self.ra.start("c3", self.user.id, "q", self.gated(release, cleaned))
        await asyncio.sleep(0.05)
        self.assertFalse(await self.rb.cancel("c3", uuid.uuid4()))
        self.assertTrue(await self.rb.cancel("c3", self.user.id))
        await asyncio.wait_for(run.task, 2)
        self.assertTrue(cleaned.is_set())
        self.assertTrue(run.cancelled)
        # and the conversation is free again right away
        again = await self.rb.start("c3", self.user.id, "again", self.gated(asyncio.Event()))
        self.assertTrue(await self.rb.cancel("c3", self.user.id))  # before its first step
        await asyncio.wait({again.task}, timeout=2)
        self.assertTrue(again.done)

    async def test_run_on_a_dead_replica_shows_as_ended(self) -> None:
        release = asyncio.Event()
        await self.ra.start("c4", self.user.id, "q", self.gated(release))
        await asyncio.sleep(0.05)
        await self.a.stop()  # the replica goes away mid-run
        remote = await self.rb.get("c4", self.user.id)
        self.assertTrue(remote.done)
        self.assertEqual(remote.summary()["current_step"], ar.LOST)
        frames = await asyncio.wait_for(self.collect(remote.stream(0)), 3)
        self.assertEqual(types(frames)[-2:], ["error", "done"])
        release.set()

    async def test_shutdown_drains_then_interrupts(self) -> None:
        release = asyncio.Event()
        finished = await self.ra.start("c5", self.user.id, "q", self.gated(release))
        asyncio.get_running_loop().call_later(0.2, release.set)
        await self.ra.drain(timeout=5)  # waits for the run instead of killing it
        self.assertTrue(finished.done)
        self.assertFalse(finished.cancelled)
        self.assertFalse(self.ra.shutting_down)

        stuck = await self.ra.start("c6", self.user.id, "q", self.gated(asyncio.Event()))
        await self.ra.drain(timeout=0.2)
        self.assertTrue(self.ra.shutting_down)  # device tasks are left running, not killed
        self.assertTrue(stuck.cancelled)
        self.assertEqual(stuck.current_step, ar.INTERRUPTED)
        # Readers on the other replica learn about it too
        await self.a.flush()
        remote = await self.rb.get("c6", self.user.id)
        frames = await asyncio.wait_for(self.collect(remote.stream(0)), 3)
        self.assertEqual(types(frames)[-2:], ["error", "done"])


    def resumable(self, ckpt: dict, seen: dict):
        """A run waiting on its device task (ckpt["task_id"]), as direct_agent_stream does."""
        registry = self.ra

        async def gen(db, user):
            try:
                yield frame({"type": "conversation_id", "id": "c7"})
                ckpt["task_id"] = "dev-task-1"
                yield frame({"type": "task_progress", "task_id": "dev-task-1", "status": "running"})
                await asyncio.Event().wait()  # the device works on it
            except (asyncio.CancelledError, GeneratorExit):
                # what orchestrator / ask_stream check before cancelling the device task and saving
                seen["kept"] = registry.keeps_device_tasks("dev-task-1")
                seen["moving"] = bool(ckpt.get("moving"))
                raise
        return gen

    def resumer(self, seen: dict):
        def resume(kwargs: dict, ckpt: dict):
            async def gen(db, user):
                seen["resumed"] = (kwargs, dict(ckpt))
                yield frame({"type": "task_chunk", "text": "rest of the output"})
                yield frame({"type": "tool_result", "result": {"status": "succeeded"}})
                yield frame({"type": "done"})
            return gen
        return resume

    async def test_shutdown_hands_a_device_run_to_the_other_replica(self) -> None:
        seen: dict = {}
        self.ra.resumers["fake"] = self.rb.resumers["fake"] = self.resumer(seen)
        ckpt: dict = {}
        run = await self.ra.start("c7", self.user.id, "q", self.resumable(ckpt, seen), request_id="req-7",
                                  resume={"kind": "fake", "kwargs": {"x": 1}, "checkpoint": ckpt})
        reader = asyncio.create_task(self.collect(run.stream(0)))
        await eventually(lambda: ckpt.get("task_id") and len(run.frames) >= 3)

        await asyncio.wait_for(self.ra.drain(timeout=5), 3)  # doesn't wait out the task
        self.assertTrue(seen["kept"])  # the device task is left going, not cancelled
        self.assertTrue(seen["moving"])  # and the generator saves nothing
        self.assertFalse(self.ra.shutting_down)
        before = await asyncio.wait_for(reader, 2)  # the reader here ends, to reconnect
        self.assertEqual(types(before), ["run_started", "conversation_id", "task_progress"])

        # The other replica took it over: same run, same frame ids, following the same task
        taken = None

        def took_over():
            nonlocal taken
            taken = self.rb._runs.get("c7")
            return taken is not None and taken.done

        await eventually(took_over, 3)
        self.assertEqual(taken.run_id, run.run_id)
        self.assertEqual(seen["resumed"][0], {"x": 1})
        self.assertEqual(seen["resumed"][1]["task_id"], "dev-task-1")
        self.assertFalse(taken.failed)
        # The client reconnects from the last id it saw and gets just the rest
        again = await self.rb.get("c7", self.user.id)
        rest = await asyncio.wait_for(self.collect(again.stream(3)), 2)
        self.assertEqual([f.split("\n")[0] for f in rest], ["id: 4", "id: 5", "id: 6"])
        self.assertEqual(types(rest), ["task_chunk", "tool_result", "done"])
        self.assertEqual((await self.ra.by_request("req-7", self.user.id)).run_id, run.run_id)
        # Over: the conversation is free again, from either replica
        await eventually(lambda: self.a.redis is not None, 1)
        follow_up = await self.ra.start("c7", self.user.id, "next", self.gated(asyncio.Event()))
        self.assertTrue(await self.ra.cancel("c7", self.user.id))
        await asyncio.wait({follow_up.task}, timeout=2)

    async def test_a_handed_over_run_nobody_can_continue_ends_for_its_readers(self) -> None:
        seen: dict = {}
        self.ra.resumers["fake"] = self.resumer(seen)  # B can't continue this kind
        ckpt: dict = {}
        run = await self.ra.start("c8", self.user.id, "q", self.resumable(ckpt, seen),
                                  resume={"kind": "fake", "kwargs": {}, "checkpoint": ckpt})
        await eventually(lambda: ckpt.get("task_id") and len(run.frames) >= 3)
        await asyncio.wait_for(self.ra.drain(timeout=5), 3)

        async def ended() -> bool:
            remote = await self.rb.get("c8", self.user.id)
            return remote is not None and remote.done

        deadline = asyncio.get_running_loop().time() + 3
        while not await ended():
            self.assertLess(asyncio.get_running_loop().time(), deadline)
            await asyncio.sleep(0.02)
        remote = await self.rb.get("c8", self.user.id)
        self.assertEqual(remote.summary()["current_step"], ar.LOST)
        frames = await asyncio.wait_for(self.collect(remote.stream(0)), 2)
        self.assertEqual(types(frames)[-2:], ["error", "done"])
        self.assertNotIn("resumed", seen)
        self.assertIsNone(await self.b.owner(ar.CLAIM + "c8"))  # the conversation is free

    async def test_handed_over_while_no_replica_listened_is_taken_on_start(self) -> None:
        seen: dict = {}
        self.ra.resumers["fake"] = self.rb.resumers["fake"] = self.resumer(seen)
        await self.b.stop()  # B is restarting
        ckpt: dict = {}
        run = await self.ra.start("c9", self.user.id, "q", self.resumable(ckpt, seen),
                                  resume={"kind": "fake", "kwargs": {}, "checkpoint": ckpt})
        await eventually(lambda: ckpt.get("task_id") and len(run.frames) >= 3)
        await asyncio.wait_for(self.ra.drain(timeout=5), 3)
        self.assertNotIn("resumed", seen)
        # A newly started replica picks up what's waiting
        make = lambda: fakeredis.FakeAsyncRedis(server=self.server, decode_responses=True)  # noqa: E731
        c = Cluster(make, pod_id="pod-c")
        rc = ar.AskRunRegistry(c)
        rc.resumers["fake"] = self.resumer(seen)
        await c.start()
        try:
            await eventually(lambda: "c9" in rc._runs and rc._runs["c9"].done, 3)
            self.assertEqual(rc._runs["c9"].run_id, run.run_id)
            self.assertEqual(seen["resumed"][1]["task_id"], "dev-task-1")
        finally:
            await c.stop()

    async def test_stopping_a_run_between_two_replicas_ends_it(self) -> None:
        seen: dict = {}
        self.ra.resumers["fake"] = self.rb.resumers["fake"] = self.resumer(seen)
        await self.b.stop()  # nobody there to take it yet
        ckpt: dict = {}
        run = await self.ra.start("c10", self.user.id, "q", self.resumable(ckpt, seen),
                                  resume={"kind": "fake", "kwargs": {}, "checkpoint": ckpt})
        await eventually(lambda: ckpt.get("task_id") and len(run.frames) >= 3)
        await asyncio.wait_for(self.ra.drain(timeout=5), 3)
        self.assertEqual((await self.ra.get("c10", self.user.id)).pod, ar.HANDOVER)

        with patch.object(ar.AskRunRegistry, "_cancel_associated_device_tasks", AsyncMock()) as cancel_tasks:
            self.assertTrue(await self.ra.cancel("c10", self.user.id))
        cancel_tasks.assert_awaited_once()  # the task on the device is stopped too
        remote = await self.ra.get("c10", self.user.id)
        self.assertTrue(remote.done)
        self.assertEqual(remote.summary()["current_step"], "已停止")
        self.assertTrue(remote.summary()["cancelled"])
        frames = await asyncio.wait_for(self.collect(remote.stream(0)), 2)
        self.assertEqual(types(frames)[-2:], ["error", "done"])
        self.assertIsNone(await self.a.owner(ar.CLAIM + "c10"))  # the conversation is free
        self.assertFalse(await self.a.redis.sismember(ar.HANDOVERS_KEY, run.run_id))

        # A replica starting afterwards doesn't bring it back
        make = lambda: fakeredis.FakeAsyncRedis(server=self.server, decode_responses=True)  # noqa: E731
        c = Cluster(make, pod_id="pod-c")
        rc = ar.AskRunRegistry(c)
        rc.resumers["fake"] = self.resumer(seen)
        await c.start()
        try:
            await asyncio.sleep(0.1)
            self.assertNotIn("c10", rc._runs)
            self.assertNotIn("resumed", seen)
        finally:
            await c.stop()

    async def test_a_taken_over_run_knows_its_device_task(self) -> None:
        seen: dict = {}
        self.ra.resumers["fake"] = self.rb.resumers["fake"] = self.resumer(seen)
        release = asyncio.Event()

        def resume(kwargs: dict, ckpt: dict):
            async def gen(db, user):
                await release.wait()
                yield frame({"type": "done"})
            return gen

        self.rb.resumers["fake"] = resume
        ckpt: dict = {}
        run = await self.ra.start("c11", self.user.id, "q", self.resumable(ckpt, seen),
                                  resume={"kind": "fake", "kwargs": {}, "checkpoint": ckpt})
        await eventually(lambda: ckpt.get("task_id") and len(run.frames) >= 3)
        await asyncio.wait_for(self.ra.drain(timeout=5), 3)
        await eventually(lambda: "c11" in self.rb._runs, 3)
        taken = self.rb._runs["c11"]
        self.assertEqual(taken.active_device_task_id, "dev-task-1")  # stopping it there cancels this task
        release.set()
        await asyncio.wait({taken.task}, timeout=2)


if __name__ == "__main__":
    unittest.main()
