"""High-performance ASGI ETag middleware for conditional GET requests (HTTP 304)."""

from __future__ import annotations

import hashlib
from starlette.types import ASGIApp, Receive, Scope, Send


class ETagMiddleware:
    """Calculates strong ETags for non-streaming 200 GET/HEAD responses and returns 304 Not Modified."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in ("GET", "HEAD"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        # Bypass events and streaming paths to avoid any buffering
        if "/events" in path or "/stream" in path or "/ask" in path:
            await self.app(scope, receive, send)
            return

        # Extract If-None-Match header from client
        if_none_match = None
        for name, value in scope.get("headers", []):
            if name.lower() == b"if-none-match":
                if_none_match = value.decode("latin1")
                break

        status_code = 200
        response_headers: list[tuple[bytes, bytes]] = []

        async def send_wrapper(message: dict) -> None:
            nonlocal status_code, response_headers
            if message["type"] == "http.response.start":
                status_code = message.get("status", 200)
                response_headers = list(message.get("headers", []))
            elif message["type"] == "http.response.body":
                body = message.get("body", b"")
                more_body = message.get("more_body", False)

                # Process single-chunk 200 OK responses with body
                if status_code == 200 and not more_body and body:
                    etag = f'"{hashlib.md5(body).hexdigest()}"'

                    # Check client conditional matching
                    if if_none_match:
                        client_tags = [
                            t.strip().lstrip("W/").strip('"') for t in if_none_match.split(",")
                        ]
                        curr = etag.strip('"')
                        if "*" in client_tags or curr in client_tags:
                            # 304 Not Modified
                            headers_304 = [
                                (b"etag", etag.encode("latin1")),
                                (b"content-length", b"0"),
                            ]
                            for h_name, h_val in response_headers:
                                if h_name.lower() in (
                                    b"cache-control",
                                    b"access-control-allow-origin",
                                    b"access-control-allow-credentials",
                                    b"vary",
                                ):
                                    headers_304.append((h_name, h_val))
                            await send({
                                "type": "http.response.start",
                                "status": 304,
                                "headers": headers_304,
                            })
                            await send({
                                "type": "http.response.body",
                                "body": b"",
                                "more_body": False,
                            })
                            return

                    # Append ETag header if not already present
                    has_etag = any(h[0].lower() == b"etag" for h in response_headers)
                    if not has_etag:
                        response_headers.append((b"etag", etag.encode("latin1")))

                    await send({
                        "type": "http.response.start",
                        "status": status_code,
                        "headers": response_headers,
                    })
                    await send(message)
                else:
                    if status_code and response_headers:
                        await send({
                            "type": "http.response.start",
                            "status": status_code,
                            "headers": response_headers,
                        })
                        response_headers = []
                    await send(message)

        await self.app(scope, receive, send_wrapper)
