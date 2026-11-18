"""Makes the request being served available to audit_service.record (client address, agent).

Pure ASGI, so streamed responses (SSE) pass through untouched.
"""

from __future__ import annotations

from starlette.requests import Request

from ..services import audit_service


class AuditRequestMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        token = audit_service.bind_request(Request(scope))
        try:
            await self.app(scope, receive, send)
        finally:
            audit_service.unbind_request(token)
