"""Request bodies sent gzip-compressed (Content-Encoding: gzip), inflated before the app reads them.

The collectors compress what they upload: a slice of a conversation log is JSON that gzip takes to
about a sixth, and the uplink through the public entry carried about 400 KB/s (10-30: a Windows
collector sending a 150 MB log again took hours).
"""

from __future__ import annotations

import zlib

from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Past what the public entry lets through uncompressed (50 MB)
MAX_INFLATED_BYTES = 64 << 20


class GzipRequestMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int = MAX_INFLATED_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = scope.get("headers", [])
        encoding = next((v for k, v in headers if k == b"content-encoding"), None)
        if encoding is None or encoding.strip().lower() != b"gzip":
            await self.app(scope, receive, send)
            return

        compressed = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            compressed += message.get("body", b"")
            if not message.get("more_body", False):
                break
        inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            body = inflater.decompress(bytes(compressed), self.max_bytes + 1)
        except zlib.error:
            await _reply(send, 400, b"Request body is not valid gzip")
            return
        if len(body) > self.max_bytes or inflater.unconsumed_tail:
            await _reply(send, 413, b"Request body too large once inflated")
            return
        if not inflater.eof:
            await _reply(send, 400, b"Request body's gzip stream is cut short")
            return

        scope = {
            **scope,
            "headers": [(k, v) for k, v in headers if k not in (b"content-encoding", b"content-length")]
            + [(b"content-length", str(len(body)).encode())],
        }
        sent = False

        async def inflated() -> Message:
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, inflated, send)


async def _reply(send: Send, status: int, text: bytes) -> None:
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"text/plain; charset=utf-8"), (b"content-length", str(len(text)).encode())],
    })
    await send({"type": "http.response.body", "body": text})
