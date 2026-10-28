"""Device WebSocket connections, across api replicas.

Each device keeps one WebSocket to whichever replica it reached, enabling
sub-second task dispatch, live chunked stdout/stderr streaming and real-time
cancellation. That replica records itself as the device's owner in Redis
(services/cluster.py); the other replicas route sends, cancels, stdin and file
reads to it, and the device's task output is published back to the replica
whose ask is waiting on the task. With one replica (or no Redis) everything
stays in this process.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any
import uuid

from fastapi import WebSocket

from .cluster import OWN_TTL, PREFIX, Cluster, cluster

logger = logging.getLogger("server.ws_manager")

DEVICE = "device:"  # device alias -> replica holding its WebSocket
TASK_WAITER = "taskwait:"  # task id -> replica streaming its output to an ask
CANCEL_LATER = PREFIX + "cancel-later:"  # device alias -> tasks to cancel once it is connected again
CANCEL_LATER_TTL = 86400
PRESENCE = f"{PREFIX}presence"
BROADCAST = f"{PREFIX}broadcast"
TASK_CHANNEL = f"{PREFIX}task:"
REFRESH_SECONDS = 15


class DeviceConnectionManager:
    def __init__(self, cl: Cluster = cluster) -> None:
        self._cluster = cl
        # device_id (collector_token_hash) -> WebSocket
        self._connections: dict[str, WebSocket] = {}
        # task_id (str) -> asyncio.Queue
        self._task_queues: dict[str, asyncio.Queue] = {}
        # task_id (str) -> WebSocket (exact active connection running this task)
        self._task_connections: dict[str, WebSocket] = {}
        # req_id (str) -> asyncio.Future
        self._pending_file_requests: dict[str, asyncio.Future] = {}
        # Devices held by other replicas: alias -> replica (presence messages + periodic refresh)
        self._remote: dict[str, str] = {}
        # task_id -> replica whose device runs it, for cancel / stdin
        self._remote_tasks: dict[str, str] = {}
        # cancel_when_back without Redis (single replica): device alias -> task ids
        self._cancel_later: dict[str, set[str]] = {}
        # aliases whose presence changed during a resync scan
        self._touched: set[str] | None = None
        self._refresher: asyncio.Task | None = None
        cl.on(PRESENCE, self._on_presence)
        cl.on(BROADCAST, self._on_broadcast)
        cl.on_pattern(f"{TASK_CHANNEL}*", self._on_task_message)
        cl.op("ws.send_json", self._op_send_json)
        cl.op("ws.send_task", self._op_send_task)
        cl.op("ws.send_cancel", self._op_send_cancel)
        cl.op("ws.send_input", self._op_send_input)
        cl.op("ws.file_stat", self._op_file_stat)
        cl.op("ws.file_chunk", self._op_file_chunk)
        cl.op("ws.p2p_offer", self._op_p2p_offer)
        cl.on_start(self._start)
        cl.on_stop(self._stop)

    # ── who is connected where ────────────────────────────────────────────
    async def _start(self) -> None:
        await self._refresh_remote()
        self._refresher = asyncio.create_task(self._refresh_loop())

    async def _stop(self) -> None:
        if self._refresher:
            self._refresher.cancel()
            self._refresher = None

    async def _refresh_loop(self) -> None:
        while True:
            await asyncio.sleep(REFRESH_SECONDS)
            try:
                await self._refresh_remote()
            except Exception as e:  # keep the last snapshot; presence messages still flow
                logger.warning("device presence resync failed: %s", e)

    async def _refresh_remote(self) -> None:
        """Resync with Redis (catches replicas that died without saying goodbye)."""
        me = self._cluster.pod_id
        self._touched = set()
        try:
            owners = await self._cluster.owners(DEVICE)
            fresh = {key[len(DEVICE):]: pod for key, pod in owners.items() if pod != me}
            for alias in self._touched:  # presence news that arrived mid-scan wins
                if alias in self._remote:
                    fresh[alias] = self._remote[alias]
                else:
                    fresh.pop(alias, None)
            self._remote = fresh
        finally:
            self._touched = None

    def _on_presence(self, _channel: str, msg: dict) -> None:
        pod = msg.get("origin")
        if not pod or pod == self._cluster.pod_id:
            return
        for alias in msg.get("aliases") or []:
            if self._touched is not None:
                self._touched.add(alias)
            if msg.get("up"):
                self._remote[alias] = pod
                if self._connections.pop(alias, None) is not None:
                    # The device reconnected to another replica before this one
                    # noticed the old socket was gone: the newest connection wins.
                    self._cluster.forget(DEVICE + alias)
            elif self._remote.get(alias) == pod:
                self._remote.pop(alias, None)

    async def register(self, device_id: str, ws: WebSocket, *aliases: str | None) -> None:
        """device_id plus every other name the device may be addressed by."""
        names = [n for n in dict.fromkeys((device_id, *aliases)) if n]
        for name in names:
            self._connections[name] = ws
            self._remote.pop(name, None)
            if self._touched is not None:
                self._touched.add(name)
        logger.info("Device connected via WebSocket: %s", device_id)
        for name in names:
            await self._cluster.own(DEVICE + name)
        self._cluster.publish(PRESENCE, {"up": True, "aliases": names})

    async def unregister(self, device_id: str, ws: WebSocket | None = None) -> None:
        target_ws = ws or self._connections.get(device_id)
        removed: list[str] = []
        if target_ws:
            removed = [k for k, v in self._connections.items() if v is target_ws]
            for k in removed:
                self._connections.pop(k, None)
            task_keys_to_remove = [k for k, v in self._task_connections.items() if v is target_ws]
            for k in task_keys_to_remove:
                self._task_connections.pop(k, None)
        elif self._connections.pop(device_id, None) is not None:
            removed = [device_id]
        for alias in removed:
            await self._cluster.disown(DEVICE + alias)
        if removed:
            self._cluster.publish(PRESENCE, {"up": False, "aliases": removed})
        logger.info("Device disconnected from WebSocket: %s", device_id)

    def has_device(self, device_id: str) -> bool:
        """Connected to this replica or to another one."""
        return device_id in self._connections or device_id in self._remote

    def is_online(self, device_id: str) -> bool:
        return self.has_device(device_id)

    def has_online_devices(self) -> bool:
        return bool(self._connections or self._remote)

    def connected_ids(self) -> list[str]:
        """Every alias of every connected device, on any replica."""
        return list({*self._connections, *self._remote})

    async def _owner(self, device_id: str) -> str | None:
        """The other replica holding device_id, if any."""
        pod = self._remote.get(device_id) or await self._cluster.owner(DEVICE + device_id)
        return pod if pod and pod != self._cluster.pod_id else None

    async def _remote_call(self, pod: str | None, op: str, payload: dict, timeout: float, default: Any) -> Any:
        if not pod:
            return default
        try:
            return await self._cluster.call(pod, op, payload, timeout=timeout)
        except Exception as e:
            logger.warning("%s via replica %s failed: %s", op, pod, e or type(e).__name__)
            if not await self._cluster.alive(pod):  # it died: forget its devices until the next resync
                self._remote = {a: p for a, p in self._remote.items() if p != pod}
            return default

    # ── sending to a device ───────────────────────────────────────────────
    async def send_json(self, device_id: str, payload: dict[str, Any]) -> bool:
        """Send an arbitrary JSON payload to a connected device."""
        if device_id in self._connections:
            return await self._send_json_local(device_id, payload)
        return await self._remote_call(await self._owner(device_id), "ws.send_json",
                                       {"device_id": device_id, "payload": payload}, 5.0, False)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        """Send payload once to every connected device, on every replica."""
        self._cluster.publish(BROADCAST, {"payload": payload})
        await self._broadcast_local(payload)

    async def _broadcast_local(self, payload: dict[str, Any]) -> None:
        seen: set[int] = set()
        for name, ws in list(self._connections.items()):
            if id(ws) not in seen:
                seen.add(id(ws))
                await self._send_json_local(name, payload)

    def _on_broadcast(self, _channel: str, msg: dict) -> Any:
        if msg.get("origin") != self._cluster.pod_id and isinstance(msg.get("payload"), dict):
            return self._broadcast_local(msg["payload"])
        return None

    async def _send_json_local(self, device_id: str, payload: dict[str, Any]) -> bool:
        ws = self._connections.get(device_id)
        if not ws:
            return False
        try:
            await ws.send_json(payload)
            return True
        except Exception as e:
            logger.warning("Failed to send json to %s via WebSocket: %s", device_id, e)
            await self.unregister(device_id, ws)
            return False

    async def send_task(self, device_id: str, task: dict[str, Any]) -> bool:
        """Send a task directly to the device over WebSocket."""
        if device_id in self._connections:
            return await self._send_task_local(device_id, task)
        pod = await self._owner(device_id)
        ok = await self._remote_call(pod, "ws.send_task", {"device_id": device_id, "task": task}, 5.0, False)
        tid = str(task.get("id") or "")
        if ok and tid and pod:
            self._remote_tasks[tid] = pod
        return ok

    async def _send_task_local(self, device_id: str, task: dict[str, Any]) -> bool:
        ws = self._connections.get(device_id)
        if not ws:
            return False
        try:
            await ws.send_json({
                "type": "task_dispatch",
                "task": task,
            })
            tid = str(task.get("id") or "")
            if tid:
                self._task_connections[tid] = ws
            logger.info("Dispatched task %s to %s via WebSocket", tid, device_id)
            return True
        except Exception as e:
            logger.warning("Failed to dispatch task to %s via WebSocket: %s", device_id, e)
            await self.unregister(device_id, ws)
            return False

    async def send_cancel(self, device_id: str, task_id: str) -> bool:
        """Send cancellation frame to the device to kill the running subprocess."""
        tid = str(task_id)
        if tid in self._task_connections or device_id in self._connections:
            return await self._send_cancel_local(device_id, tid)
        pod = self._remote_tasks.get(tid) or await self._owner(device_id)
        if not pod:
            logger.warning("Cannot cancel task %s: no WebSocket connection found for device %s or task", tid, device_id)
        return await self._remote_call(pod, "ws.send_cancel", {"device_id": device_id, "task_id": tid}, 5.0, False)

    async def cancel_when_back(self, device_id: str, task_id: str) -> bool:
        """Cancel now or, with the device away (asleep, offline), once it connects again: its agent goes
        on meanwhile and would otherwise run beside the next one in the same session. True if sent now."""
        if await self.send_cancel(device_id, task_id):
            return True
        r = self._cluster.redis
        if r is None:
            self._cancel_later.setdefault(device_id, set()).add(str(task_id))
            return False
        try:
            await r.sadd(CANCEL_LATER + device_id, str(task_id))
            await r.expire(CANCEL_LATER + device_id, CANCEL_LATER_TTL)
        except Exception as e:
            logger.warning("Could not keep the cancel of %s for device %s: %s", task_id, device_id, e)
        return False

    async def send_kept_cancels(self, *aliases: str | None) -> None:
        """The cancels cancel_when_back kept for a device, sent now it is connected here."""
        r = self._cluster.redis
        for alias in dict.fromkeys(a for a in aliases if a):
            if r is None:
                tids = self._cancel_later.pop(alias, set())
            else:
                try:
                    tids = await r.spop(CANCEL_LATER + alias, 1000) or []
                except Exception as e:
                    logger.warning("Could not read the kept cancels of device %s: %s", alias, e)
                    continue
            for tid in tids:
                await self._send_cancel_local(alias, tid)

    async def _send_cancel_local(self, device_id: str, tid: str) -> bool:
        ws = self._task_connections.get(tid) or self._connections.get(device_id)
        if not ws:
            logger.warning("Cannot cancel task %s: no WebSocket connection found for device %s or task", tid, device_id)
            return False
        try:
            await ws.send_json({
                "type": "task_cancel",
                "task_id": tid,
            })
            logger.info("Sent task_cancel for %s to device via WebSocket", tid)
            return True
        except Exception as e:
            logger.warning("Failed to send cancel for %s via WebSocket: %s", tid, e)
            return False

    async def send_input(self, device_id: str, task_id: str, input_text: str, question_id: str | None = None) -> bool:
        """Send input frame to the device: an answer to the agent's question (question_id), else a steer."""
        tid = str(task_id)
        if tid in self._task_connections or device_id in self._connections:
            return await self._send_input_local(device_id, tid, input_text, question_id)
        pod = self._remote_tasks.get(tid) or await self._owner(device_id)
        return await self._remote_call(pod, "ws.send_input",
                                       {"device_id": device_id, "task_id": tid, "input": str(input_text), "question_id": question_id}, 5.0, False)

    async def _send_input_local(self, device_id: str, tid: str, input_text: str, question_id: str | None = None) -> bool:
        ws = self._task_connections.get(tid) or self._connections.get(device_id)
        if not ws:
            logger.warning("Cannot forward input to task %s: no WebSocket connection found for device %s or task", tid, device_id)
            return False
        try:
            await ws.send_json({
                "type": "task_input",
                "task_id": tid,
                "input": str(input_text),
                **({"question_id": question_id} if question_id else {}),
            })
            logger.info("Sent task_input for %s via WebSocket: %s", tid, input_text)
            return True
        except Exception as e:
            logger.warning("Failed to send input for %s via WebSocket: %s", tid, e)
            return False

    # ── task output, delivered to whichever replica waits on the task ────
    async def subscribe_task(self, task_id: str) -> asyncio.Queue:
        """Create a dedicated event queue for a running task's streaming output."""
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._task_queues[task_id] = q
        await self._cluster.own(TASK_WAITER + task_id, ttl=OWN_TTL)
        return q

    async def unsubscribe_task(self, task_id: str) -> None:
        self._task_queues.pop(task_id, None)
        self._task_connections.pop(task_id, None)
        self._remote_tasks.pop(task_id, None)
        await self._cluster.disown(TASK_WAITER + task_id)

    async def is_watched(self, task_id: str) -> bool:
        """Someone (an open ask stream, on any replica) is currently waiting on this task."""
        return task_id in self._task_queues or await self._cluster.owner(TASK_WAITER + task_id) is not None

    def _push(self, task_id: str, event: dict[str, Any]) -> None:
        q = self._task_queues.get(task_id)
        if q is None:
            self._cluster.publish(TASK_CHANNEL + task_id, {"event": event})
            return
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning("Task stream queue full for %s, dropping %s", task_id, event.get("type"))

    def _on_task_message(self, channel: str, msg: dict) -> None:
        if msg.get("origin") == self._cluster.pod_id or not isinstance(msg.get("event"), dict):
            return
        q = self._task_queues.get(channel[len(TASK_CHANNEL):])
        if q is not None:
            try:
                q.put_nowait(msg["event"])
            except asyncio.QueueFull:
                pass

    def push_chunk(self, task_id: str, stream: str, text: str) -> None:
        self._push(task_id, {"type": "task_chunk", "task_id": task_id, "stream": stream, "text": text})

    def push_alert(self, task_id: str, alert: dict[str, Any]) -> None:
        self._push(task_id, {"type": "task_alert", "task_id": task_id, "alert": alert})

    def push_event(self, task_id: str, event: dict[str, Any]) -> None:
        """One step of a structured agent run (tool call, file change, usage, steer)."""
        self._push(task_id, {"type": "task_event", "task_id": task_id, "event": event})

    def push_progress(self, task_id: str, status: str) -> None:
        self._push(task_id, {"type": "task_progress", "task_id": task_id, "status": status})

    def push_finished(self, task_id: str, result: dict[str, Any]) -> None:
        self._task_connections.pop(task_id, None)
        self._push(task_id, {"type": "task_finished", "task_id": task_id, "result": result})

    # ── file reads relayed from a device ──────────────────────────────────
    async def request_file_stat(self, device_id: str, path: str, timeout: float = 8.0) -> dict[str, Any]:
        """Ask the remote collector device for file metadata (existence, total_size)."""
        if device_id in self._connections:
            return await self._file_stat_local(device_id, path, timeout)
        res = await self._remote_call(await self._owner(device_id), "ws.file_stat",
                                      {"device_id": device_id, "path": path, "timeout": timeout}, timeout + 3, None)
        return res if isinstance(res, dict) else {"exists": False, "error": f"device {device_id} not connected"}

    async def _file_stat_local(self, device_id: str, path: str, timeout: float) -> dict[str, Any]:
        ws = self._connections.get(device_id)
        if not ws:
            return {"exists": False, "error": f"device {device_id} not connected"}
        req_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._pending_file_requests[req_id] = fut
        try:
            await ws.send_json({
                "type": "file_stat_req",
                "req_id": req_id,
                "path": path,
            })
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            return {"exists": False, "error": "device stat request timed out"}
        except Exception as e:
            return {"exists": False, "error": str(e)}
        finally:
            self._pending_file_requests.pop(req_id, None)

    async def request_file_chunk(
        self,
        device_id: str,
        path: str,
        offset: int,
        length: int,
        timeout: float = 15.0,
    ) -> bytes | None:
        """Ask the remote collector device for a chunk of file bytes (Range stream)."""
        if device_id in self._connections:
            res = await self._file_chunk_local(device_id, path, offset, length, timeout)
        else:
            res = await self._remote_call(await self._owner(device_id), "ws.file_chunk",
                                          {"device_id": device_id, "path": path, "offset": offset,
                                           "length": length, "timeout": timeout}, timeout + 3, None)
        if not isinstance(res, dict) or res.get("error"):
            return None
        b64 = res.get("data_b64")
        return base64.b64decode(b64) if b64 else b""

    async def _file_chunk_local(self, device_id: str, path: str, offset: int, length: int, timeout: float) -> dict | None:
        ws = self._connections.get(device_id)
        if not ws:
            return None
        req_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._pending_file_requests[req_id] = fut
        try:
            await ws.send_json({
                "type": "file_chunk_req",
                "req_id": req_id,
                "path": path,
                "offset": offset,
                "length": length,
            })
            return await asyncio.wait_for(fut, timeout=timeout)
        except Exception as e:
            logger.warning("request_file_chunk error for %s on %s: %s", path, device_id, e)
            return None
        finally:
            self._pending_file_requests.pop(req_id, None)

    async def request_p2p_answer(self, device_id: str, sdp: str, ice_servers: list[str], timeout: float = 12.0) -> dict[str, Any]:
        """Hand the device a browser's WebRTC offer for a direct file channel; {"sdp": answer} or {"error"}."""
        if device_id in self._connections:
            return await self._p2p_offer_local(device_id, sdp, ice_servers, timeout)
        res = await self._remote_call(await self._owner(device_id), "ws.p2p_offer",
                                      {"device_id": device_id, "sdp": sdp, "ice_servers": ice_servers, "timeout": timeout},
                                      timeout + 3, None)
        return res if isinstance(res, dict) else {"error": f"device {device_id} not connected"}

    async def _p2p_offer_local(self, device_id: str, sdp: str, ice_servers: list[str], timeout: float) -> dict[str, Any]:
        ws = self._connections.get(device_id)
        if not ws:
            return {"error": f"device {device_id} not connected"}
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_file_requests[req_id] = fut
        try:
            await ws.send_json({"type": "p2p_offer", "req_id": req_id, "sdp": sdp, "ice_servers": ice_servers})
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            return {"error": "device did not answer the offer in time"}
        except Exception as e:
            return {"error": str(e)}
        finally:
            self._pending_file_requests.pop(req_id, None)

    def handle_file_response(self, data: dict[str, Any]) -> None:
        """Dispatch incoming file_stat_resp or file_chunk_resp to awaiting futures."""
        req_id = data.get("req_id")
        if req_id and req_id in self._pending_file_requests:
            fut = self._pending_file_requests[req_id]
            if not fut.done():
                fut.set_result(data)

    # ── calls from other replicas: act on this replica's connections only ─
    async def _op_send_json(self, p: dict) -> bool:
        return await self._send_json_local(p["device_id"], p["payload"])

    async def _op_send_task(self, p: dict) -> bool:
        return await self._send_task_local(p["device_id"], p["task"])

    async def _op_send_cancel(self, p: dict) -> bool:
        return await self._send_cancel_local(p["device_id"], p["task_id"])

    async def _op_send_input(self, p: dict) -> bool:
        return await self._send_input_local(p["device_id"], p["task_id"], p["input"], p.get("question_id"))

    async def _op_file_stat(self, p: dict) -> dict:
        return await self._file_stat_local(p["device_id"], p["path"], float(p.get("timeout") or 8.0))

    async def _op_p2p_offer(self, p: dict) -> dict:
        return await self._p2p_offer_local(p["device_id"], p["sdp"], list(p.get("ice_servers") or []), float(p.get("timeout") or 12.0))

    async def _op_file_chunk(self, p: dict) -> dict | None:
        return await self._file_chunk_local(p["device_id"], p["path"], int(p["offset"]), int(p["length"]),
                                            float(p.get("timeout") or 15.0))


ws_manager = DeviceConnectionManager()
