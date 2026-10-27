"""Ask runs that outlive the HTTP request that started them.

An ask, and every device task it dispatches, runs as a background task that writes
its SSE frames into a per-conversation buffer. The HTTP response is only a reader
of that buffer: when a phone goes to the background and the connection drops, the
run keeps going, the conversation is still saved when it ends, and the client can
reattach and replay from the last frame it saw. Stopping is explicit (cancel).

A run executes on the api replica that started it. Its frames and status are
mirrored to Redis (a stream per run, see services/cluster.py), so a client that
reconnects through another replica replays, follows and stops the same run
there. A replica shutting down for a deploy first lets its runs finish (drain);
their readers reattach through the replica that replaced it. Without Redis runs
stay in this process: a restart drops them, and tasks already on devices still
finish there and report as usual.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncGenerator, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import async_session_factory
from . import notify_service
from .cluster import PREFIX, Cluster, cluster

logger = logging.getLogger("server.ask_runs")

RETAIN_AFTER_DONE = 600          # seconds a finished run stays attachable
RUN_TTL = 6 * 3600               # mirror lifetime while a run is going (refreshed as it writes)
MAX_BUFFER_BYTES = 8 * 1024 * 1024
KEEPALIVE_SECONDS = 8.0
NOTIFY_MIN_SECONDS = 0.5         # notify on any task taking >= 0.5s

CLAIM = "askrun:"                # cluster claim: conversation -> the run (replica/run id) going on it
INTERRUPTED = "服务更新中断了这次回答；设备上已在执行的任务会继续，完成后结果自动保存到对话"
LOST = "运行这次回答的服务实例已退出，回答中断；设备上的任务完成后结果会自动保存到对话"

GeneratorFactory = Callable[[AsyncSession, User], AsyncGenerator[str, None]]


def _cur_key(conversation_id: str) -> str:
    return f"{PREFIX}askrun-cur:{conversation_id}"


def _meta_key(run_id: str) -> str:
    return f"{PREFIX}askrun-meta:{run_id}"


def _frames_key(run_id: str) -> str:
    return f"{PREFIX}askrun-frames:{run_id}"


def _user_key(user_id: uuid.UUID | str) -> str:
    return f"{PREFIX}askrun-user:{user_id}"


def _req_key(user_id: uuid.UUID | str, request_id: str) -> str:
    return f"{PREFIX}askrun-req:{user_id}:{request_id}"


class RunConflict(Exception):
    """The conversation already has a run in progress."""


def _frame(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _publish_run(run) -> None:
    """Tell the user's open clients a run started or ended (/api/events/stream, event "ask_run"):
    the running-tasks monitor and the history drawer refresh on it instead of polling every 2 s."""
    try:
        from .sse_service import publish_event
        publish_event("ask_run", {
            "conversation_id": run.conversation_id,
            "done": run.done,
            "failed": run.failed,
            "cancelled": run.cancelled,
            "title": run.title or (run.question[:40] if run.question else ""),
            "device_name": run.device_name,
            "execution_mode": run.execution_mode,
            "started_at": run.started_at,
            "finished_at": run.finished_at,
        }, user_id=str(run.user_id))
    except Exception as e:
        logger.debug("ask_run event not published: %s", e)


def _publish_step(run) -> None:
    """Tell the user's open clients a running run moved on (event "ask_run_step"): the running-tasks
    monitor shows the new step from it, instead of fetching the run list every 2 s to find it."""
    try:
        from .sse_service import publish_event
        publish_event("ask_run_step", {
            "conversation_id": run.conversation_id,
            "current_step": run.current_step,
            "step_type": run.step_type,
            "tool_name": run.tool_name,
            "step_count": run.step_count,
        }, user_id=str(run.user_id))
    except Exception as e:
        logger.debug("ask_run_step event not published: %s", e)


class AskRun:
    def __init__(
        self,
        conversation_id: str,
        user_id: uuid.UUID,
        question: str,
        request_id: str | None,
        *,
        execution_mode: str | None = None,
        model: str | None = None,
        device_name: str | None = None,
        title: str | None = None,
        images: list[str] | None = None,
    ):
        self.conversation_id = conversation_id
        self.user_id = user_id
        self.question = question
        self.images = images or []
        self.request_id = request_id
        self.execution_mode = execution_mode
        self.model = model
        self.device_name = device_name
        self.title = title or ""
        self.started_at = time.time()
        self.finished_at: float | None = None
        self.last_active_at = time.time()
        self.frames: list[str] = []
        self.readers = 0
        self.done = False
        self.cancelled = False
        self.failed = False
        self.current_step = "正在启动任务..."
        self.step_type = "init"
        self.tool_name: str | None = None
        self.step_count = 1
        self._last_la_push_at = 0.0
        self._last_la_step = ""
        self.task: asyncio.Task | None = None
        self.active_device_task_id: str | None = None
        self.active_device_id: str | None = None
        # Clients from before background runs stop a task by dropping the
        # connection, and they never send a request id. Keep that meaning for them.
        self.cancel_on_disconnect = request_id is None
        self._bytes = 0
        self._cond = asyncio.Condition()
        self.run_id = uuid.uuid4().hex
        self.claim_value = ""
        # Mirror to Redis: called with (run, frame index, frame) until the end is written
        self.on_frame: Callable[["AskRun", int, str], None] | None = None
        self.mirror_closed = False

    def add(self, frame: str) -> None:
        self.frames.append(frame)
        if self.on_frame is not None and not self.mirror_closed:
            self.on_frame(self, len(self.frames), frame)

    def engine_label(self) -> str:
        m = (self.execution_mode or "").lower()
        if "claude" in m:
            return "Claude"
        if "antigravity" in m or "agy" in m:
            return "AGY"
        if "codex" in m:
            return "Codex"
        if "workbuddy" in m:
            return "WorkBuddy"
        if "shell" in m:
            return "Shell"
        return "AI"

    def summary(self) -> dict:
        elapsed = round((self.finished_at or time.time()) - self.started_at, 1)
        return {
            "conversation_id": self.conversation_id,
            "title": self.title or (self.question[:40] if self.question else ""),
            "question": self.question,
            "images": self.images,
            "execution_mode": self.execution_mode,
            "model": self.model,
            "device_name": self.device_name,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_seconds": elapsed,
            "done": self.done,
            "cancelled": self.cancelled,
            "failed": self.failed,
            "current_step": self.current_step,
            "step_type": self.step_type,
            "tool_name": self.tool_name,
            "step_count": self.step_count,
            "events": len(self.frames),
        }

    async def append(self, frame: str) -> None:
        # Pings are the reader's job; storing them would only bloat replays.
        if not frame.startswith("data:") or '"type": "ping"' in frame:
            return

        should_push_la = False
        try:
            payload = json.loads(frame[5:].strip())
            evt_type = payload.get("type")
            self.last_active_at = time.time()
            if evt_type == "conversation_id":
                t = payload.get("title")
                if t:
                    self.title = t
            elif evt_type == "tool_call":
                self.step_type = "tool"
                self.step_count += 1
                name = payload.get("name") or "tool"
                self.tool_name = name
                args = payload.get("args") or {}
                if isinstance(args, dict):
                    cmd = args.get("command") or args.get("prompt") or args.get("code") or ""
                    if cmd:
                        cmd_str = str(cmd).replace("\n", " ").strip()
                        if len(cmd_str) > 40:
                            cmd_str = cmd_str[:37] + "..."
                        self.current_step = f"调用工具: {name} ({cmd_str})"
                    else:
                        self.current_step = f"调用工具: {name}"
                else:
                    self.current_step = f"调用工具: {name}"
                should_push_la = True
            elif evt_type == "task_progress":
                self.step_type = "executing"
                tid = payload.get("task_id")
                dev_id = payload.get("device_id")
                if tid:
                    self.active_device_task_id = str(tid)
                if dev_id:
                    self.active_device_id = str(dev_id)
                status = payload.get("status") or ""
                if status:
                    self.current_step = f"执行进度: {status}"
                    should_push_la = True
            elif evt_type == "task_chunk":
                self.step_type = "executing"
                chunk_text = payload.get("chunk") or payload.get("text") or ""
                if any(kw in chunk_text for kw in ("自动退避重试", "容量紧张", "模型容灾", "自动降级")):
                    m_tip = re.search(r"\[(.*?)(?:，|\])", chunk_text)
                    self.current_step = m_tip.group(1)[:40] if m_tip else chunk_text.strip()[:40]
                    should_push_la = True
                elif not self.current_step.startswith("正在执行"):
                    self.current_step = f"正在执行工具任务 ({self.tool_name or 'device'})..."
                    should_push_la = True
            elif evt_type == "tool_result":
                self.step_type = "tool_result"
                self.current_step = f"工具 {self.tool_name or ''} 执行完毕，整理输出..."
                should_push_la = True
            elif evt_type == "thinking":
                if self.step_type != "thinking":
                    self.step_type = "thinking"
                    self.current_step = "正在深度思考与推演..."
                    should_push_la = True
            elif evt_type == "delta":
                if self.step_type != "generating":
                    self.step_type = "generating"
                    self.current_step = "正在生成回复..."
                    should_push_la = True
            elif evt_type == "error":
                self.step_type = "error"
                self.failed = True
                msg = payload.get("message") or "出错了"
                self.current_step = f"发生错误: {msg[:40]}"
                should_push_la = True
            elif evt_type == "done":
                self.step_type = "done"
                self.current_step = "任务完成"
                self.done = True
                if not self.finished_at:
                    self.finished_at = time.time()
        except Exception:
            pass

        if should_push_la and not self.done and self.current_step != self._last_la_step:
            now_ts = time.time()
            if (now_ts - self._last_la_push_at >= 1.8) or self.step_type in ("tool", "error"):
                self._last_la_push_at = now_ts
                self._last_la_step = self.current_step
                _publish_step(self)
                notify_service.spawn(
                    notify_service.push_live_activity_event(
                        self.user_id,
                        self.conversation_id,
                        "update",
                        status=self.step_type,
                        current_step=self.current_step,
                        step_count=self.step_count,
                        tool_name=self.tool_name,
                        elapsed_seconds=int(now_ts - self.started_at),
                        title=self.title or (self.question[:40] if self.question else "后台任务"),
                        engine=self.engine_label(),
                    )
                )

        if '"type": "error"' in frame:
            self.failed = True
        # Past the cap, drop streamed output; the final tool_result still carries it.
        if self._bytes > MAX_BUFFER_BYTES and '"type": "task_chunk"' in frame:
            return
        self._bytes += len(frame)
        async with self._cond:
            self.add(frame)
            self._cond.notify_all()

    async def finish(self) -> None:
        async with self._cond:
            self.done = True
            self.finished_at = time.time()
            if not self.failed and not self.cancelled:
                self.current_step = "任务完成"
                self.step_type = "done"
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


class RemoteRun:
    """A run going on another replica, read and stopped through its Redis mirror."""

    def __init__(self, registry: "AskRunRegistry", run_id: str, meta: dict):
        self._registry = registry
        self.run_id = run_id
        self._summary: dict = json.loads(meta["summary"])
        self.conversation_id = meta.get("conv") or self._summary.get("conversation_id")
        self.user_id = uuid.UUID(meta["user_id"])
        self.request_id = meta.get("request_id") or None
        self.pod = meta.get("pod") or ""
        self.active_at = float(meta.get("active_at") or self._summary.get("started_at") or 0)
        self.lost = False

    @property
    def started_at(self) -> float:
        return float(self._summary.get("started_at") or 0)

    @property
    def finished_at(self) -> float | None:
        return self._summary.get("finished_at")

    @property
    def done(self) -> bool:
        return bool(self._summary.get("done"))

    def mark_lost(self) -> None:
        """Its replica died mid-run: show it as ended."""
        self.lost = True
        self._summary.update(done=True, failed=True, current_step=LOST, step_type="error",
                             finished_at=self._summary.get("finished_at") or self.active_at)

    def summary(self) -> dict:
        out = dict(self._summary)
        out["elapsed_seconds"] = round((out.get("finished_at") or time.time()) - self.started_at, 1)
        return out

    async def stream(self, after: int = 0) -> AsyncGenerator[str, None]:
        """Same frames, ids and keepalives as AskRun.stream, read from the mirror."""
        last = max(0, after)
        key = _frames_key(self.run_id)
        while True:
            r = self._registry._cluster.redis
            if r is None:
                return  # Redis went away: the client reconnects
            try:
                # Known to be over: replay what's there without waiting for more
                block = None if self.lost else int(KEEPALIVE_SECONDS * 1000)
                res = await r.xread({key: f"0-{last}"}, count=500, block=block)
            except Exception as e:
                logger.warning("reading run %s from Redis failed: %s", self.run_id, e)
                return
            if not res:
                state = "lost" if self.lost else await self._registry._remote_state(self)
                if state == "running":
                    yield ": keepalive\n\n"
                    continue
                if state == "lost":
                    yield _frame({"type": "error", "message": LOST})
                    yield _frame({"type": "done"})
                return
            for _key, entries in res:
                for entry_id, fields in entries:
                    if "end" in fields:
                        return
                    last = int(str(entry_id).split("-")[1])
                    yield f"id: {last}\n{fields.get('f', '')}"


Run = AskRun | RemoteRun


class AskRunRegistry:
    def __init__(self, cl: Cluster = cluster) -> None:
        self._cluster = cl
        self._runs: dict[str, AskRun] = {}
        self._pending: list[tuple[AskRun, int, str | None]] = []
        self._flush_queued = False
        # Set when shutdown stops runs that didn't finish in time: their device
        # tasks are left running (they report back and get saved) instead of killed.
        self.shutting_down = False
        cl.op("askrun.cancel", self._op_cancel)

    # ── lookups (this replica first, then the mirror) ─────────────────────
    async def get(self, conversation_id: str, user_id: uuid.UUID) -> Run | None:
        run = self._runs.get(conversation_id)
        if run is None or run.done:
            # A newer run of this conversation may be going on another replica
            remote = await self._remote(conversation_id=conversation_id)
            if remote is not None and (run is None or remote.run_id != run.run_id):
                run = remote
        return run if run and run.user_id == user_id else None

    async def by_request(self, request_id: str | None, user_id: uuid.UUID) -> Run | None:
        if not request_id:
            return None
        for run in self._runs.values():
            if run.request_id == request_id and run.user_id == user_id:
                return run
        r = self._cluster.redis
        if r is None:
            return None
        try:
            run_id = await r.get(_req_key(user_id, request_id))
        except Exception as e:
            logger.warning("looking up ask request %s failed: %s", request_id, e)
            return None
        remote = await self._remote(run_id=run_id) if run_id else None
        return remote if remote and remote.user_id == user_id else None

    async def active_for_user(self, user_id: uuid.UUID, include_recent_seconds: float = 0) -> list[Run]:
        now = time.time()
        runs: dict[str, Run] = {}
        for r in list(self._runs.values()):
            if r.user_id != user_id:
                continue
            # If the underlying background task has completed, ensure done is marked
            if r.task and r.task.done() and not r.done:
                r.done = True
                if not r.finished_at:
                    r.finished_at = now
                notify_service.spawn(
                    notify_service.push_live_activity_event(
                        r.user_id,
                        r.conversation_id,
                        "end",
                        status="error" if r.failed else ("cancelled" if r.cancelled else "done"),
                        current_step=r.current_step,
                        step_count=r.step_count,
                        tool_name=r.tool_name,
                        elapsed_seconds=int(now - r.started_at),
                        title=r.title or (r.question[:40] if r.question else "后台任务"),
                        engine=r.engine_label(),
                    )
                )
            # Safety timeout: if a run has had no frames or activity for > 15 minutes, mark as finished
            if not r.done and (now - r.last_active_at > 900):
                r.done = True
                r.failed = True
                r.finished_at = now
                r.current_step = "任务超时已终止"
                notify_service.spawn(
                    notify_service.push_live_activity_event(
                        r.user_id,
                        r.conversation_id,
                        "end",
                        status="error",
                        current_step=r.current_step,
                        step_count=r.step_count,
                        tool_name=r.tool_name,
                        elapsed_seconds=int(now - r.started_at),
                        title=r.title or (r.question[:40] if r.question else "后台任务"),
                        engine=r.engine_label(),
                    )
                )
            runs[r.run_id] = r
        for remote in await self._remote_for_user(user_id):
            runs.setdefault(remote.run_id, remote)
        newest: dict[str, Run] = {}  # one per conversation
        for r in runs.values():
            cur = newest.get(r.conversation_id)
            if cur is None or r.started_at > cur.started_at:
                newest[r.conversation_id] = r
        res = []
        for r in newest.values():
            if not r.done:
                res.append(r)
            elif include_recent_seconds > 0 and r.finished_at and (now - r.finished_at <= include_recent_seconds):
                res.append(r)
        return sorted(res, key=lambda r: r.started_at)

    # ── starting and stopping ─────────────────────────────────────────────
    async def start(
        self,
        conversation_id: str,
        user_id: uuid.UUID,
        question: str,
        factory: GeneratorFactory,
        *,
        request_id: str | None = None,
        execution_mode: str | None = None,
        model: str | None = None,
        device_name: str | None = None,
        title: str | None = None,
        images: list[str] | None = None,
    ) -> AskRun:
        existing = self._runs.get(conversation_id)
        if existing and not existing.done:
            raise RunConflict(conversation_id)
        run = AskRun(
            conversation_id,
            user_id,
            question,
            request_id,
            execution_mode=execution_mode,
            model=model,
            device_name=device_name,
            title=title,
            images=images,
        )
        run.claim_value = f"{self._cluster.pod_id}/{run.run_id}"
        if not await self._claim(run):
            raise RunConflict(conversation_id)
        existing = self._runs.get(conversation_id)
        if existing and not existing.done:  # started on this replica while we waited
            await self._cluster.disown(CLAIM + conversation_id, run.claim_value)
            raise RunConflict(conversation_id)
        self._runs[conversation_id] = run
        if self._cluster.available:
            await self._announce(run)
            run.on_frame = self._mirror_frame
        run.add(_frame({
            "type": "run_started",
            "conversation_id": conversation_id,
            "question": question,
            "started_at": run.started_at,
            "execution_mode": execution_mode,
            "model": model,
        }))
        run.task = asyncio.create_task(self._pump(run, factory))
        run.task.add_done_callback(lambda _: self._ensure_finished(run))
        notify_service.spawn(self._notify_live_activity_start(run))
        _publish_run(run)
        return run

    async def _claim(self, run: AskRun) -> bool:
        """One run per conversation across replicas."""
        key = CLAIM + run.conversation_id
        if await self._cluster.claim(key, value=run.claim_value):
            return True
        holder = await self._cluster.owner(key) or ""
        pod, _, held_run = holder.partition("/")
        if pod != self._cluster.pod_id:
            return False
        if any(r.run_id == held_run and not r.done for r in self._runs.values()):
            return False
        # Our own claim, left by a run that already ended (its release is still on the way)
        await self._cluster.own(key, value=run.claim_value)
        return True

    async def cancel(self, conversation_id: str, user_id: uuid.UUID) -> bool:
        run = self._runs.get(conversation_id)
        if run is not None and not run.done:
            if run.user_id != user_id:
                return False
            active_tid = run.active_device_task_id
            active_did = run.active_device_id
            self._stop(run, "已停止")
            await self._cluster.disown(CLAIM + run.conversation_id, run.claim_value)
            # 立即通知设备终止正在执行的 Agent 进程树（Antigravity, Claude Code, Codex 等）
            await self._cancel_associated_device_tasks(user_id, conversation_id, active_did, active_tid)
            return True
        remote = await self._remote(conversation_id=conversation_id)
        if remote is None or remote.done or remote.user_id != user_id:
            await self._cancel_associated_device_tasks(user_id, conversation_id, None, None)
            return False
        try:
            res = bool(await self._cluster.call(
                remote.pod, "askrun.cancel", {"conv": conversation_id, "user_id": str(user_id)}, timeout=5))
            await self._cancel_associated_device_tasks(user_id, conversation_id, None, None)
            return res
        except Exception as e:
            logger.warning("stopping run %s on %s failed: %s", remote.run_id, remote.pod, e)
            await self._cancel_associated_device_tasks(user_id, conversation_id, None, None)
            return False

    async def _cancel_associated_device_tasks(
        self,
        user_id: uuid.UUID,
        conversation_id: str,
        active_did: str | None,
        active_tid: str | None,
    ) -> None:
        """Propagate cancellation to all associated DeviceTasks running on physical machines."""
        try:
            from .ws_manager import ws_manager
            from ..db.session import async_session_factory
            from ..db.models import DeviceTask
            from sqlalchemy import select
            from datetime import datetime, timezone

            cancelled_task_ids = set()
            if active_did and active_tid:
                cancelled_task_ids.add(str(active_tid))
                await ws_manager.send_cancel(active_did, str(active_tid))

            async with async_session_factory() as db:
                stmt = select(DeviceTask).where(
                    DeviceTask.user_id == user_id,
                    DeviceTask.status.in_(("queued", "running", "still_running")),
                ).order_by(DeviceTask.created_at.desc()).limit(10)
                tasks = (await db.execute(stmt)).scalars().all()

                for t in tasks:
                    t_id_str = str(t.id)
                    conv_match = False
                    if t.payload and isinstance(t.payload, dict):
                        payload_conv = str(t.payload.get("conversation_id") or "")
                        if payload_conv == conversation_id:
                            conv_match = True
                    if conv_match or t_id_str == active_tid:
                        t.status = "cancelled"
                        t.finished_at = datetime.now(timezone.utc)
                        if t_id_str not in cancelled_task_ids:
                            cancelled_task_ids.add(t_id_str)
                            await ws_manager.send_cancel(t.device_id, t_id_str)
                await db.commit()

            if cancelled_task_ids:
                logger.info("Successfully cancelled associated device tasks for conv %s: %s", conversation_id, cancelled_task_ids)
        except Exception as e:
            logger.warning("Failed to cancel associated device tasks: %s", e)

    async def _op_cancel(self, p: dict) -> bool:
        run = self._runs.get(p.get("conv") or "")
        if run is None or run.done or str(run.user_id) != p.get("user_id"):
            return False
        return await self.cancel(run.conversation_id, run.user_id)

    def _stop(self, run: AskRun, message: str) -> None:
        run.cancelled = True
        run.done = True
        run.finished_at = time.time()
        run.current_step = message
        run.step_type = "cancelled"
        run.add(_frame({"type": "error", "message": message}))
        run.add(_frame({"type": "done"}))
        self._mirror_end(run)
        _publish_run(run)
        if run.task:
            run.task.cancel()
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._wake(run))
            loop.call_later(RETAIN_AFTER_DONE, self._drop, run)
        except RuntimeError:
            pass

    async def drain(self, timeout: float) -> None:
        """Shutdown: let runs in progress finish — their readers reattach through
        another replica and keep following them there — then stop the rest."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        active = [r for r in self._runs.values() if not r.done]
        if active:
            logger.info("waiting up to %.0fs for %d ask run(s) to finish", timeout, len(active))
        while active and loop.time() < deadline:
            await asyncio.sleep(min(1.0, max(deadline - loop.time(), 0.01)))
            active = [r for r in self._runs.values() if not r.done]
        if not active:
            return
        self.shutting_down = True
        logger.warning("stopping %d ask run(s) still going at shutdown", len(active))
        for run in active:
            self._stop(run, INTERRUPTED)
        tasks = [r.task for r in active if r.task]
        if tasks:
            await asyncio.wait(tasks, timeout=5)

    async def _notify_live_activity_start(self, run: AskRun) -> None:
        # Wait 1.0s so if the mobile WebView started the Live Activity locally and registered its
        # per-conversation activity token, we update it instead of push-to-starting a duplicate.
        await asyncio.sleep(1.0)
        if run.done:
            return
        from .task_alerts import display_device_name
        dev_label = display_device_name(run.device_name) if run.device_name else "云端"
        title_str = run.title or (run.question.strip().splitlines() or ["后台任务"])[0][:45]
        await notify_service.push_live_activity_event(
            run.user_id,
            run.conversation_id,
            "start",
            status=run.step_type if run.step_type != "init" else "running",
            current_step=run.current_step,
            step_count=run.step_count,
            tool_name=run.tool_name,
            elapsed_seconds=int(time.time() - run.started_at),
            title=title_str,
            engine=run.engine_label(),
            device_name=dev_label,
            started_at_epoch=run.started_at,
        )

    def _ensure_finished(self, run: AskRun) -> None:
        """A task cancelled before its first step never enters _pump's try block,
        so its finally never runs. Close such a run here, or it would stay
        "running" forever and block its conversation."""
        if run.done:
            return
        run.cancelled = True
        run.current_step = "已停止"
        run.step_type = "cancelled"
        run.add(_frame({"type": "error", "message": "已停止"}))
        run.add(_frame({"type": "done"}))
        run.done = True
        run.finished_at = time.time()
        self._mirror_end(run)
        _publish_run(run)
        self._cluster.spawn(self._cluster.disown(CLAIM + run.conversation_id, run.claim_value))
        notify_service.spawn(
            notify_service.push_live_activity_event(
                run.user_id,
                run.conversation_id,
                "end",
                status="cancelled",
                current_step=run.current_step,
                step_count=run.step_count,
                tool_name=run.tool_name,
                elapsed_seconds=int((run.finished_at or time.time()) - run.started_at),
                title=run.title or (run.question[:40] if run.question else "后台任务"),
                engine=run.engine_label(),
            )
        )
        loop = asyncio.get_running_loop()
        loop.create_task(self._wake(run))
        loop.call_later(RETAIN_AFTER_DONE, self._drop, run)

    @staticmethod
    async def _wake(run: AskRun) -> None:
        async with run._cond:
            run._cond.notify_all()

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
            run.failed = True
            run.current_step = f"运行失败: {e}"
            run.step_type = "error"
            await run.append(_frame({"type": "error", "message": f"运行失败: {e}"}))
            await run.append(_frame({"type": "done"}))
        finally:
            # cancel() has already closed the run; a reader dropping (old clients) hasn't
            if run.cancelled and not run.done:
                run.current_step = "已停止"
                run.step_type = "cancelled"
                await run.append(_frame({"type": "error", "message": "已停止"}))
                await run.append(_frame({"type": "done"}))
            await run.finish()
            self._mirror_end(run)
            _publish_run(run)
            await self._cluster.disown(CLAIM + run.conversation_id, run.claim_value)
            asyncio.get_running_loop().call_later(RETAIN_AFTER_DONE, self._drop, run)
            notify_service.spawn(
                notify_service.push_live_activity_event(
                    run.user_id,
                    run.conversation_id,
                    "end",
                    status="error" if run.failed else ("cancelled" if run.cancelled else "done"),
                    current_step=run.current_step,
                    step_count=run.step_count,
                    tool_name=run.tool_name,
                    elapsed_seconds=int((run.finished_at or time.time()) - run.started_at),
                    title=run.title or (run.question[:40] if run.question else "后台任务"),
                    engine=run.engine_label(),
                )
            )
            if not run.cancelled and (run.finished_at - run.started_at >= NOTIFY_MIN_SECONDS):
                notify_service.spawn(self._notify_finished(run))

    def _drop(self, run: AskRun) -> None:
        if self._runs.get(run.conversation_id) is run:
            del self._runs[run.conversation_id]

    async def _notify_finished(self, run: AskRun) -> None:
        from .task_alerts import display_device_name
        first = (run.question.strip().splitlines() or ["（无描述）"])[0]
        first = first if len(first) <= 60 else first[:59] + "…"
        body = f"{display_device_name(run.device_name)}：{first}" if run.device_name else first
        base = (notify_service.settings.public_url or "").rstrip("/")
        conv_url = f"{base}/ask?id={run.conversation_id}&scroll=bottom" if base else f"/ask?id={run.conversation_id}&scroll=bottom"
        await notify_service.notify_user(
            run.user_id,
            "task_done",
            "❌ 任务出错" if run.failed else "✅ 任务完成",
            body,
            url=conv_url,
        )

    # ── the Redis mirror ──────────────────────────────────────────────────
    async def _announce(self, run: AskRun) -> None:
        """Make the run findable from every replica before its first frame."""
        try:
            pipe = self._cluster.redis.pipeline(transaction=False)
            pipe.set(_cur_key(run.conversation_id), run.run_id, ex=RUN_TTL)
            pipe.hset(_meta_key(run.run_id), mapping={
                "conv": run.conversation_id,
                "user_id": str(run.user_id),
                "pod": self._cluster.pod_id,
                "request_id": run.request_id or "",
                "active_at": run.last_active_at,
                "summary": json.dumps(run.summary(), ensure_ascii=False),
            })
            pipe.expire(_meta_key(run.run_id), RUN_TTL)
            pipe.zadd(_user_key(run.user_id), {run.run_id: run.started_at})
            pipe.expire(_user_key(run.user_id), RUN_TTL)
            if run.request_id:
                pipe.set(_req_key(run.user_id, run.request_id), run.run_id, ex=RUN_TTL)
            await pipe.execute()
        except Exception as e:
            logger.warning("announcing run %s failed: %s", run.run_id, e)

    def _mirror_frame(self, run: AskRun, idx: int, frame: str) -> None:
        self._queue(run, idx, frame)

    def _mirror_end(self, run: AskRun) -> None:
        if run.on_frame is None or run.mirror_closed:
            return
        run.mirror_closed = True
        self._queue(run, len(run.frames) + 1, None)

    def _queue(self, run: AskRun, idx: int, frame: str | None) -> None:
        # Frames written in order, many per round trip: one flush is queued at a time
        # and takes whatever has piled up by the time it runs.
        self._pending.append((run, idx, frame))
        if not self._flush_queued:
            self._flush_queued = True
            self._cluster.write(self._flush)

    async def _flush(self, r) -> None:
        self._flush_queued = False
        batch, self._pending = self._pending, []
        if not batch:
            return
        pipe = r.pipeline(transaction=False)
        touched: dict[str, AskRun] = {}
        for run, idx, frame in batch:
            fields = {"f": frame} if frame is not None else {"end": "1"}
            pipe.xadd(_frames_key(run.run_id), fields, id=f"0-{idx}")
            touched[run.run_id] = run
        for run in touched.values():
            ttl = RETAIN_AFTER_DONE if run.mirror_closed else RUN_TTL
            pipe.hset(_meta_key(run.run_id), mapping={
                "summary": json.dumps(run.summary(), ensure_ascii=False),
                "active_at": run.last_active_at,
            })
            pipe.expire(_meta_key(run.run_id), ttl)
            pipe.expire(_frames_key(run.run_id), ttl)
            if not run.done and self._runs.get(run.conversation_id) is run:
                pipe.expire(_cur_key(run.conversation_id), RUN_TTL)
        await pipe.execute()

    async def _remote(self, conversation_id: str | None = None, run_id: str | None = None) -> RemoteRun | None:
        r = self._cluster.redis
        if r is None:
            return None
        try:
            if run_id is None:
                run_id = await r.get(_cur_key(conversation_id))
                if not run_id:
                    return None
            meta = await r.hgetall(_meta_key(run_id))
        except Exception as e:
            logger.warning("reading run %s from Redis failed: %s", run_id or conversation_id, e)
            return None
        if not meta.get("summary") or not meta.get("user_id"):
            return None
        run = RemoteRun(self, run_id, meta)
        if not run.done and not await self._replica_alive(run):
            run.mark_lost()
        return run

    async def _remote_for_user(self, user_id: uuid.UUID) -> list[RemoteRun]:
        r = self._cluster.redis
        if r is None:
            return []
        try:
            run_ids = await r.zrange(_user_key(user_id), 0, -1)
            if not run_ids:
                return []
            pipe = r.pipeline(transaction=False)
            for run_id in run_ids:
                pipe.hgetall(_meta_key(run_id))
            metas = await pipe.execute()
        except Exception as e:
            logger.warning("listing runs of %s from Redis failed: %s", user_id, e)
            return []
        out, expired = [], []
        for run_id, meta in zip(run_ids, metas):
            if not meta or not meta.get("summary"):
                expired.append(run_id)
                continue
            run = RemoteRun(self, run_id, meta)
            if not run.done and not await self._replica_alive(run):
                run.mark_lost()
            out.append(run)
        if expired:
            try:
                await r.zrem(_user_key(user_id), *expired)
            except Exception:
                pass
        return out

    async def _replica_alive(self, run: RemoteRun) -> bool:
        """Whether the replica running it is still there (the run holds its claim)."""
        if run.pod == self._cluster.pod_id:
            local = self._runs.get(run.conversation_id)
            return local is not None and local.run_id == run.run_id
        holder = await self._cluster.owner(CLAIM + run.conversation_id)
        if holder == f"{run.pod}/{run.run_id}":
            return True
        # The claim goes as the run ends, a moment before its last frames land
        return await self._cluster.alive(run.pod)

    async def _remote_state(self, run: RemoteRun) -> str:
        """"running", "done" or "lost", rechecked while a remote reader waits."""
        fresh = await self._remote(run_id=run.run_id)
        if fresh is None:
            return "done"  # expired
        if fresh.lost:
            return "lost"
        return "done" if fresh.done else "running"


ask_runs = AskRunRegistry()
