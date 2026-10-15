import asyncio
import unittest
from server.api.ask import sse_keepalive_generator


class SSEKeepaliveTests(unittest.IsolatedAsyncioTestCase):
    async def test_sse_keepalive_normal_flow(self):
        async def normal_gen():
            yield "data: 1\n\n"
            yield "data: 2\n\n"

        items = []
        async for item in sse_keepalive_generator(normal_gen(), interval=0.1):
            items.append(item)

        self.assertEqual(items, ["data: 1\n\n", "data: 2\n\n"])

    async def test_sse_keepalive_idle_yields_ping(self):
        async def slow_gen():
            yield "data: start\n\n"
            await asyncio.sleep(0.25)
            yield "data: finish\n\n"

        items = []
        async for item in sse_keepalive_generator(slow_gen(), interval=0.08):
            items.append(item)

        self.assertIn("data: start\n\n", items)
        self.assertIn(": keepalive\n\n", items)
        self.assertIn("data: finish\n\n", items)
        self.assertTrue(items.index("data: start\n\n") < items.index(": keepalive\n\n") < items.index("data: finish\n\n"))

    async def test_sse_keepalive_exception_propagation(self):
        async def failing_gen():
            yield "data: ok\n\n"
            raise ValueError("stream boom")

        items = []
        with self.assertRaises(ValueError) as ctx:
            async for item in sse_keepalive_generator(failing_gen(), interval=0.1):
                items.append(item)

        self.assertIn("stream boom", str(ctx.exception))
        self.assertEqual(items, ["data: ok\n\n"])
