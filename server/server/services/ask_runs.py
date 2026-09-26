"""Ask runs that outlive the HTTP request that started them.

An ask, and every device task it dispatches, runs as a background task that writes
its SSE frames into a per-conversation buffer. The HTTP response is only a reader
of that buffer: when a phone goes to the background and the connection drops, the
run keeps going, the conversation is still saved when it ends, and the client can
reattach and replay from the last frame it saw. Stopping is explicit (cancel).

Runs live in this process's memory (the API runs as a single replica). A restart
drops them; tasks already on devices still finish there and report as usual.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncGenerator, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import async_session_factory
from . import notify_service

logger = logging.getLogger("server.ask_runs")

RETAIN_AFTER_DONE = 600          # seconds a finished run stays attachable
MAX_BUFFER_BYTES = 8 * 1024 * 1024
KEEPALIVE_SECONDS = 8.0
NOTIFY_MIN_SECONDS = 15          # quick answers don't need a "finished" push

GeneratorFactory = Callable[[AsyncSession, User], AsyncGenerator[str, None]]


class RunConflict(Exception):
    """The conversation already has a run in progress."""


def _frame(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


class AskRun:
    def __init__(self, conversation_id: str, user_id: uuid.UUID, question: str, request_id: str | None):
        self.conversation_id = conversation_id
        self.user_id = user_id
        self.question = question
        self.request_id = request_id
        self.started_at = time.time()
        self.finished_at: float | None = None
        self.frames: list[str] = []
        self.readers = 0
        self.done = False
        self.cancelled = False
        self.failed = False
        self.task: asyncio.Task | None = None
        # Clients from before background runs stop a task by dropping the
        # connection, and they never send a request id. Keep that meaning for them.
        self.cancel_on_disconnect = request_id is None
        self._bytes = 0
        self._cond = asyncio.Condition()

    def summary(self) -> dict:
        return {
            "conversation_id": self.conversation_id,
            "question": self.question,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "done": self.done,
            "cancelled": self.cancelled,
            "events": len(self.frames),
        }

    async def append(self, frame: str) -> None:
        # Pings are the reader's job; storing them would only bloat replays.
        if not frame.startswith("data:") or '"type": "ping"' in frame:
            return
        if '"type": "error"' in frame:
            self.failed = True
        # Past the cap, drop streamed output; the final tool_result still carries it.
        if self._bytes > MAX_BUFFER_BYTES and '"type": "task_chunk"' in frame:
            return
        self._bytes += len(frame)
        async with self._cond:
            self.frames.append(frame)
            self._cond.notify_all()

    async def finish(self) -> None:
        async with self._cond:
            self.done = True
            self.finished_at = time.time()
            self._cond.notify_all()

    async def stream(self, after: int = 0) -> AsyncGenerator[str, None]:
        """SSE frames after index `after` (each tagged `id: N`), then live frames
        until the run ends. Disconnecting stops only this reader."""
        self.readers += 1
        try:
            idx = max(0, after)
            while True:
                async with self._cond:
                    if idx >= len(self.frames) and not self.done:
                        try:
                            await asyncio.wait_for(self._cond.wait(), timeout=KEEPALIVE_SECONDS)
                        except asyncio.TimeoutError:
                            pass
                    pending = self.frames[idx:]
                    done = self.done
                if not pending and not done:
                    yield ": keepalive\n\n"
                    continue
                for frame in pending:
                    idx += 1
                    yield f"id: {idx}\n{frame}"
                if done and idx >= len(self.frames):
                    return
        finally:
            self.readers -= 1
            if self.readers == 0 and self.cancel_on_disconnect and not self.done and self.task:
                self.cancelled = True
                self.task.cancel()


class AskRunRegistry:
    def __init__(self) -> None:
        self._runs: dict[str, AskRun] = {}

    def get(self, conversation_id: str, user_id: uuid.UUID) -> AskRun | None:
        run = self._runs.get(conversation_id)
        return run if run and run.user_id == user_id else None

    def by_request(self, request_id: str | None, user_id: uuid.UUID) -> AskRun | None:
        if not request_id:
            return None
        for run in self._runs.values():
            if run.request_id == request_id and run.user_id == user_id:
                return run
        return None

    def active_for_user(self, user_id: uuid.UUID) -> list[AskRun]:
        return [r for r in self._runs.values() if r.user_id == user_id and not r.done]

    def start(
        self,
        conversation_id: str,
        user_id: uuid.UUID,
        question: str,
        factory: GeneratorFactory,
        *,
        request_id: str | None = None,
    ) -> AskRun:
        existing = self._runs.get(conversation_id)
        if existing and not existing.done:
            raise RunConflict(conversation_id)
        run = AskRun(conversation_id, user_id, question, request_id)
        run.frames.append(_frame({
            "type": "run_started",
            "conversation_id": conversation_id,
            "question": question,
            "started_at": run.started_at,
        }))
        self._runs[conversation_id] = run
        run.task = asyncio.create_task(self._pump(run, factory))
        run.task.add_done_callback(lambda _: self._ensure_finished(run))
        return run

    def _ensure_finished(self, run: AskRun) -> None:
        """A task cancelled before its first step never enters _pump's try block,
        so its finally never runs. Close such a run here, or it would stay
        "running" forever and block its conversation."""
        if run.done:
            return
        run.cancelled = True
        run.frames.append(_frame({"type": "error", "message": "已停止"}))
        run.frames.append(_frame({"type": "done"}))
        run.done = True
        run.finished_at = time.time()
        loop = asyncio.get_running_loop()
        loop.create_task(self._wake(run))
        loop.call_later(RETAIN_AFTER_DONE, self._drop, run)

    @staticmethod
    async def _wake(run: AskRun) -> None:
        async with run._cond:
            run._cond.notify_all()

    def cancel(self, conversation_id: str, user_id: uuid.UUID) -> bool:
        run = self.get(conversation_id, user_id)
        if run is None or run.done or run.task is None:
            return False
        run.cancelled = True
        run.task.cancel()
        return True

    async def _pump(self, run: AskRun, factory: GeneratorFactory) -> None:
        try:
            # The run outlives the request, so it gets its own session and user row.
            async with async_session_factory() as db:
                user = await db.get(User, run.user_id)
                if user is None:
                    raise RuntimeError("user not found")
                agen = factory(db, user)
                try:
                    async for frame in agen:
                        await run.append(frame)
                finally:
                    await agen.aclose()
        except asyncio.CancelledError:
            pass  # reported below; some generators swallow the cancel themselves
        except Exception as e:
            logger.exception("Ask run %s failed", run.conversation_id)
            await run.append(_frame({"type": "error", "message": f"运行失败: {e}"}))
            await run.append(_frame({"type": "done"}))
        finally:
            if run.cancelled:
                await run.append(_frame({"type": "error", "message": "已停止"}))
                await run.append(_frame({"type": "done"}))
            await run.finish()
            asyncio.get_running_loop().call_later(RETAIN_AFTER_DONE, self._drop, run)
            if run.readers == 0 and not run.cancelled and run.finished_at - run.started_at >= NOTIFY_MIN_SECONDS:
                notify_service.spawn(self._notify_finished(run))

    def _drop(self, run: AskRun) -> None:
        if self._runs.get(run.conversation_id) is run:
            del self._runs[run.conversation_id]

    async def _notify_finished(self, run: AskRun) -> None:
        first = (run.question.strip().splitlines() or ["（无描述）"])[0]
        first = first if len(first) <= 60 else first[:59] + "…"
        base = (notify_service.settings.public_url or "").rstrip("/")
        await notify_service.notify_user(
            run.user_id,
            "task_done",
            "❌ 任务出错" if run.failed else "✅ 任务完成",
            first,
            url=f"{base}/ask?id={run.conversation_id}" if base else None,
        )


ask_runs = AskRunRegistry()
