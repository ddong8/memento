"""Coordination between api replicas: two Cluster instances share one fake Redis."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

import fakeredis

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.cluster import PREFIX, Cluster, ClusterUnavailable  # noqa: E402


def pair() -> tuple[Cluster, Cluster, fakeredis.FakeServer]:
    server = fakeredis.FakeServer()
    make = lambda: fakeredis.FakeAsyncRedis(server=server, decode_responses=True)  # noqa: E731
    return Cluster(make, pod_id="pod-a"), Cluster(make, pod_id="pod-b"), server


class ClusterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.a, self.b, self.server = pair()
        self.seen: list[tuple[str, dict]] = []
        self.b.on(f"{PREFIX}test", lambda ch, m: self.seen.append((ch, m)))
        self.b.on_pattern(f"{PREFIX}task:*", lambda ch, m: self.seen.append((ch, m)))

        async def double(p: dict) -> int:
            return p["n"] * 2

        async def boom(p: dict) -> None:
            raise ValueError("nope")

        self.b.op("double", double)
        self.b.op("boom", boom)
        await self.a.start()
        await self.b.start()

    async def asyncTearDown(self) -> None:
        await self.a.stop()
        await self.b.stop()

    async def test_call_runs_on_the_target_replica(self) -> None:
        self.assertEqual(await self.a.call("pod-b", "double", {"n": 21}, timeout=2), 42)
        with self.assertRaises(RuntimeError):
            await self.a.call("pod-b", "boom", {}, timeout=2)
        with self.assertRaises(ClusterUnavailable):  # nobody listening: fails at once
            await self.a.call("pod-gone", "double", {"n": 1}, timeout=5)
        self.assertTrue(await self.a.alive("pod-b"))
        self.assertFalse(await self.a.alive("pod-gone"))

    async def test_messages_arrive_in_order_on_exact_and_pattern_channels(self) -> None:
        for i in range(30):
            self.a.publish(f"{PREFIX}task:t1", {"i": i})
        self.a.publish(f"{PREFIX}test", {"hello": 1})
        for _ in range(50):
            if len(self.seen) >= 31:
                break
            await asyncio.sleep(0.02)
        task_msgs = [m["i"] for ch, m in self.seen if ch == f"{PREFIX}task:t1"]
        self.assertEqual(task_msgs, list(range(30)))
        self.assertIn((f"{PREFIX}test", {"hello": 1, "origin": "pod-a"}), self.seen)

    async def test_ownership(self) -> None:
        await self.a.own("device:mini")
        self.assertEqual(await self.b.owner("device:mini"), "pod-a")
        self.assertFalse(await self.b.claim("device:mini"))
        self.assertEqual(await self.b.owners("device:"), {"device:mini": "pod-a"})
        await self.b.disown("device:mini")  # not b's: no effect
        self.assertEqual(await self.b.owner("device:mini"), "pod-a")
        await self.a.disown("device:mini")
        self.assertIsNone(await self.b.owner("device:mini"))
        self.assertTrue(await self.b.claim("device:mini"))

    async def test_locks_and_leases(self) -> None:
        token = await self.a.try_lock("merge", 5)
        self.assertTrue(token)
        self.assertIsNone(await self.b.try_lock("merge", 5))
        await self.a.unlock("merge", token)
        self.assertTrue(await self.b.try_lock("merge", 5))

        m = await self.a.mutex("export:u1", ttl=0.3)
        self.assertIsNotNone(m)
        await asyncio.sleep(0.5)  # renewed in the background, still held
        self.assertIsNone(await self.b.mutex("export:u1", ttl=0.3))
        await m.release()
        m2 = await self.b.mutex("export:u1", ttl=0.3)
        self.assertIsNotNone(m2)
        await m2.release()

        self.assertTrue(await self.a.hold_lease("pulse", 0.3))
        self.assertFalse(await self.b.hold_lease("pulse", 0.3))
        self.assertTrue(await self.a.hold_lease("pulse", 0.3))  # renewal by the holder
        await asyncio.sleep(0.4)  # holder stops renewing (e.g. it died)
        self.assertTrue(await self.b.hold_lease("pulse", 0.3))

    async def test_leased_block_runs_on_one_replica_and_keeps_its_lease(self) -> None:
        async with self.a.leased("job", ttl=0.3) as mine:
            self.assertTrue(mine)
            await asyncio.sleep(0.5)  # longer than the ttl: renewed while running
            async with self.b.leased("job", ttl=0.3) as theirs:
                self.assertFalse(theirs)

    async def test_claims_tell_holders_on_one_replica_apart(self) -> None:
        self.assertTrue(await self.a.claim("askrun:c", value="pod-a/run1"))
        self.assertFalse(await self.a.claim("askrun:c", value="pod-a/run2"))
        self.assertFalse(await self.b.claim("askrun:c", value="pod-b/run3"))
        await self.a.disown("askrun:c", "pod-a/run2")  # not the holder: no effect
        self.assertEqual(await self.b.owner("askrun:c"), "pod-a/run1")
        await self.a.disown("askrun:c", "pod-a/run1")
        self.assertTrue(await self.b.claim("askrun:c", value="pod-b/run3"))

    async def test_writes_and_messages_keep_their_order(self) -> None:
        for i in range(50):
            self.a.write(lambda r, i=i: r.rpush("memento:cl:order", i))
        await self.a.flush()
        self.assertEqual(await self.a.redis.lrange("memento:cl:order", 0, -1), [str(i) for i in range(50)])


class SingleReplicaTests(unittest.IsolatedAsyncioTestCase):
    async def test_without_redis_everything_is_local(self) -> None:
        def broken():
            raise ConnectionError("no redis")

        c = Cluster(broken, pod_id="solo")

        async def echo(p: dict) -> dict:
            return p

        c.op("echo", echo)
        await c.start()
        self.assertFalse(c.available)
        self.assertEqual(await c.call("solo", "echo", {"x": 1}), {"x": 1})
        with self.assertRaises(ClusterUnavailable):
            await c.call("other", "echo", {})
        token = await c.try_lock("anything", 1)
        self.assertTrue(token)
        self.assertIsNone(await c.try_lock("anything", 1))  # still exclusive within the process
        self.assertTrue(await c.locked("anything"))
        await c.unlock("anything", token)
        self.assertFalse(await c.locked("anything"))
        m = await c.mutex("export:u1", ttl=0.3)
        await asyncio.sleep(0.5)  # renewed while held
        self.assertIsNone(await c.mutex("export:u1", ttl=0.3))
        await m.release()
        self.assertTrue(await c.hold_lease("pulse", 1))
        self.assertTrue(await c.claim("askrun:x", value="solo/run1"))
        self.assertFalse(await c.claim("askrun:x", value="solo/run2"))
        c.publish("x", {"a": 1})  # no-op
        await c.stop()


if __name__ == "__main__":
    unittest.main()
