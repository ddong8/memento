"""/api/events/stream pushes runs starting and ending, and notifications, so clients stop polling.

The desktop and the web app read it with fetch and send the token in the Authorization header;
EventSource can only pass ?token=, which lands in the access log."""
from __future__ import annotations

import asyncio
import types
import unittest
import uuid
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from server.api import events
from server.services import ask_runs, sse_service


class EventStreamAuthTests(unittest.TestCase):
    def test_header_token(self):
        with patch.object(events, "decode_token", return_value={"sub": "u1"}) as dec:
            res = asyncio.run(events.event_stream(token=None, authorization="Bearer abc"))
        dec.assert_called_once_with("abc")
        self.assertIsInstance(res, StreamingResponse)

    def test_query_token_still_works(self):
        with patch.object(events, "decode_token", return_value={"sub": "u1"}) as dec:
            asyncio.run(events.event_stream(token="q", authorization=None))
        dec.assert_called_once_with("q")

    def test_no_token(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(events.event_stream(token=None, authorization=None))
        self.assertEqual(ctx.exception.status_code, 401)


class RunEventTests(unittest.TestCase):
    def test_run_start_and_end_reach_only_its_user(self):
        user = uuid.uuid4()
        run = types.SimpleNamespace(
            conversation_id="c1", user_id=user, done=False, failed=False, cancelled=False, title="",
            question="修一下登录", device_name="mac", execution_mode="claude", started_at=1.0, finished_at=None,
        )

        async def go():
            got: list[dict] = []
            agen = sse_service.subscribe(str(user))
            other = sse_service.subscribe(str(uuid.uuid4()))
            task = asyncio.ensure_future(_collect(agen, got))
            other_task = asyncio.ensure_future(_collect(other, got_other := []))
            await asyncio.sleep(0)
            ask_runs._publish_run(run)
            run.done, run.finished_at = True, 2.0
            ask_runs._publish_run(run)
            await asyncio.sleep(0.05)
            task.cancel()
            other_task.cancel()
            return [e for e in got if e["type"] == "ask_run"], [e for e in got_other if e["type"] == "ask_run"]

        with patch.object(sse_service.cluster, "publish", lambda *_a, **_k: None):
            sse_service._recent_events.clear()
            mine, others = asyncio.run(go())
        self.assertEqual([e["data"]["done"] for e in mine], [False, True])
        self.assertEqual(mine[0]["data"]["conversation_id"], "c1")
        self.assertEqual(mine[0]["data"]["title"], "修一下登录")
        self.assertEqual(others, [])

    def test_steps_are_pushed_so_the_monitor_need_not_poll(self):
        user = uuid.uuid4()
        run = ask_runs.AskRun(conversation_id="c2", user_id=user, question="跑测试", request_id=None)
        sent: list[tuple] = []

        async def go():
            await run.append('data: {"type": "tool_call", "name": "Bash", "args": {"command": "pytest"}}\n\n')
            await run.append('data: {"type": "tool_call", "name": "Read", "args": {}}\n\n')

        with patch.object(sse_service, "publish_event", lambda t, d, user_id=None: sent.append((t, d, user_id))), \
             patch("server.services.notify_service.spawn", lambda coro: coro.close()):
            asyncio.run(go())
        steps = [d for t, d, _ in sent if t == "ask_run_step"]
        self.assertEqual([d["current_step"] for d in steps], ["调用工具: Bash (pytest)", "调用工具: Read"])
        self.assertEqual([d["step_count"] for d in steps], [2, 3])
        self.assertEqual({u for t, _, u in sent}, {str(user)})


class SlowReaderTests(unittest.TestCase):
    def test_a_reader_that_falls_behind_is_disconnected(self):
        """Dropped from delivery but left on keepalives, its client would think it is live and stop polling."""
        uid = str(uuid.uuid4())

        async def go():
            agen = sse_service.subscribe(uid)
            first = asyncio.ensure_future(agen.__anext__())
            await asyncio.sleep(0)
            for i in range(101):  # one past the queue
                sse_service._deliver(uid, {"type": "ask_run", "data": {"i": i}, "timestamp": 0})
            got = [await first]
            async for e in agen:
                got.append(e)
            return got

        sse_service._recent_events.clear()
        got = asyncio.run(asyncio.wait_for(go(), timeout=5))
        self.assertLess(len(got), 101)  # the stream ended instead of waiting on keepalives


async def _collect(agen, out: list) -> None:
    async for e in agen:
        out.append(e)


if __name__ == "__main__":
    unittest.main()
