"""Device WebSocket Connection Manager.

Maintains persistent WebSocket connections to online collector devices,
enabling sub-second task dispatch, live chunked stdout/stderr streaming,
and real-time process cancellation.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any
import uuid

from fastapi import WebSocket

logger = logging.getLogger("server.ws_manager")


class DeviceConnectionManager:
    def __init__(self) -> None:
        # device_id (collector_token_hash) -> WebSocket
        self._connections: dict[str, WebSocket] = {}
        # task_id (str) -> asyncio.Queue
        self._task_queues: dict[str, asyncio.Queue] = {}
        # task_id (str) -> WebSocket (exact active connection running this task)
        self._task_connections: dict[str, WebSocket] = {}
        # req_id (str) -> asyncio.Future
        self._pending_file_requests: dict[str, asyncio.Future] = {}
        # device_id (str) -> {"ipv6": str, "port": int, "token": str, "updated_at": float}
        self._device_p2p_info: dict[str, dict[str, Any]] = {}

    def set_p2p_info(self, device_id: str, info: dict[str, Any]) -> None:
        """Cache current IPv6 P2P endpoint info reported by the collector device."""
        self._device_p2p_info[device_id] = info
        logger.info("Updated IPv6 P2P info for device %s: [%s]:%s", device_id, info.get("ipv6"), info.get("port"))

    def get_p2p_info(self, device_id: str) -> dict[str, Any] | None:
        """Retrieve latest IPv6 P2P endpoint info for device, if active."""
        return self._device_p2p_info.get(device_id)

    def register(self, device_id: str, ws: WebSocket) -> None:
        self._connections[device_id] = ws
        logger.info("Device connected via WebSocket: %s", device_id)

    def unregister(self, device_id: str, ws: WebSocket | None = None) -> None:
        target_ws = ws or self._connections.get(device_id)
        if target_ws:
            keys_to_remove = [k for k, v in self._connections.items() if v is target_ws]
            for k in keys_to_remove:
                self._connections.pop(k, None)
            task_keys_to_remove = [k for k, v in self._task_connections.items() if v is target_ws]
            for k in task_keys_to_remove:
                self._task_connections.pop(k, None)
        else:
            self._connections.pop(device_id, None)
        logger.info("Device disconnected from WebSocket: %s", device_id)

    def has_device(self, device_id: str) -> bool:
        return device_id in self._connections

    async def send_task(self, device_id: str, task: dict[str, Any]) -> bool:
        """Send a task directly to the device over WebSocket."""
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
            self.unregister(device_id, ws)
            return False

    async def send_cancel(self, device_id: str, task_id: str) -> bool:
        """Send cancellation frame to the device to kill the running subprocess."""
        tid = str(task_id)
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

    async def send_input(self, device_id: str, task_id: str, input_text: str) -> bool:
        """Send input frame to the device to forward stdin into the running subprocess."""
        tid = str(task_id)
        ws = self._task_connections.get(tid) or self._connections.get(device_id)
        if not ws:
            logger.warning("Cannot forward input to task %s: no WebSocket connection found for device %s or task", tid, device_id)
            return False
        try:
            await ws.send_json({
                "type": "task_input",
                "task_id": tid,
                "input": str(input_text),
            })
            logger.info("Sent task_input for %s via WebSocket: %s", tid, input_text)
            return True
        except Exception as e:
            logger.warning("Failed to send input for %s via WebSocket: %s", tid, e)
            return False

    def subscribe_task(self, task_id: str) -> asyncio.Queue:
        """Create a dedicated event queue for a running task's streaming output."""
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._task_queues[task_id] = q
        return q

    def unsubscribe_task(self, task_id: str) -> None:
        self._task_queues.pop(task_id, None)
        self._task_connections.pop(task_id, None)

    def push_chunk(self, task_id: str, stream: str, text: str) -> None:
        q = self._task_queues.get(task_id)
        if q:
            try:
                q.put_nowait({
                    "type": "task_chunk",
                    "task_id": task_id,
                    "stream": stream,
                    "text": text,
                })
            except asyncio.QueueFull:
                logger.warning("Task stream queue full for %s, dropping chunk", task_id)

    def has_subscriber(self, task_id: str) -> bool:
        """Someone (an open ask stream) is currently waiting on this task."""
        return task_id in self._task_queues

    def push_alert(self, task_id: str, alert: dict[str, Any]) -> None:
        q = self._task_queues.get(task_id)
        if q:
            try:
                q.put_nowait({"type": "task_alert", "task_id": task_id, "alert": alert})
            except asyncio.QueueFull:
                pass

    def push_progress(self, task_id: str, status: str) -> None:
        q = self._task_queues.get(task_id)
        if q:
            try:
                q.put_nowait({
                    "type": "task_progress",
                    "task_id": task_id,
                    "status": status,
                })
            except asyncio.QueueFull:
                pass

    def push_finished(self, task_id: str, result: dict[str, Any]) -> None:
        self._task_connections.pop(task_id, None)
        q = self._task_queues.get(task_id)
        if q:
            try:
                q.put_nowait({
                    "type": "task_finished",
                    "task_id": task_id,
                    "result": result,
                })
            except asyncio.QueueFull:
                pass

    async def request_file_stat(self, device_id: str, path: str, timeout: float = 8.0) -> dict[str, Any]:
        """Ask the remote collector device for file metadata (existence, total_size)."""
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
            res = await asyncio.wait_for(fut, timeout=timeout)
            if not isinstance(res, dict) or res.get("error"):
                return None
            b64 = res.get("data_b64")
            if b64:
                return base64.b64decode(b64)
            return b""
        except Exception as e:
            logger.warning("request_file_chunk error for %s on %s: %s", path, device_id, e)
            return None
        finally:
            self._pending_file_requests.pop(req_id, None)

    def handle_file_response(self, data: dict[str, Any]) -> None:
        """Dispatch incoming file_stat_resp or file_chunk_resp to awaiting futures."""
        req_id = data.get("req_id")
        if req_id and req_id in self._pending_file_requests:
            fut = self._pending_file_requests[req_id]
            if not fut.done():
                fut.set_result(data)


ws_manager = DeviceConnectionManager()
