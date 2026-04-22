"""Remote HTTP client — calls Memento server REST API instead of direct DB access.

This lets the MCP server run on any machine without needing PostgreSQL connection.
Only needs: server URL + user's collector token (JWT or collector_token).
"""

from __future__ import annotations

import logging
from datetime import date

import httpx

logger = logging.getLogger("mcp_memory.remote")


class RemoteClient:
    """HTTP client for Memento server API."""

    def __init__(self, server_url: str, token: str):
        self.base_url = server_url.rstrip("/")
        self.token = token
        self._jwt: str | None = None
        self._jwt_time: float = 0  # When JWT was obtained

    async def _ensure_jwt(self) -> str:
        """Get JWT token with auto-renewal (re-exchange after 20 hours)."""
        import time
        # Renew if JWT older than 20 hours (tokens expire at 24h)
        if self._jwt and (time.time() - self._jwt_time) < 72000:
            return self._jwt
        self._jwt = None  # Force re-exchange
        async with httpx.AsyncClient(timeout=10) as client:
            # Try as JWT directly
            resp = await client.get(
                f"{self.base_url}/api/auth/me",
                headers={"Authorization": f"Bearer {self.token}"},
            )
            if resp.status_code == 200:
                self._jwt = self.token
                self._jwt_time = time.time()
                return self._jwt

            # Try token-exchange (collector_token → JWT)
            resp = await client.post(
                f"{self.base_url}/api/auth/token-exchange",
                headers={"X-Collector-Token": self.token},
            )
            if resp.status_code == 200:
                data = resp.json()
                self._jwt = data["access_token"]
                self._jwt_time = time.time()
                logger.info("JWT obtained via token-exchange")
                return self._jwt

        raise RuntimeError(
            f"Invalid token. Get a valid token from {self.base_url}"
        )

    async def _get(self, path: str, params: dict | None = None) -> dict | list:
        jwt = await self._ensure_jwt()
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{self.base_url}{path}",
                params=params,
                headers={"Authorization": f"Bearer {jwt}"},
            )
            # Auto-retry on 401 (JWT expired)
            if resp.status_code == 401:
                self._jwt = None
                jwt = await self._ensure_jwt()
                resp = await client.get(
                    f"{self.base_url}{path}",
                    params=params,
                    headers={"Authorization": f"Bearer {jwt}"},
                )
            resp.raise_for_status()
            return resp.json()

    async def _post(self, path: str, json_data: dict | None = None) -> dict:
        jwt = await self._ensure_jwt()
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self.base_url}{path}",
                json=json_data,
                headers={"Authorization": f"Bearer {jwt}"},
            )
            if resp.status_code == 401:
                self._jwt = None
                jwt = await self._ensure_jwt()
                resp = await client.post(
                    f"{self.base_url}{path}",
                    json=json_data,
                    headers={"Authorization": f"Bearer {jwt}"},
                )
            resp.raise_for_status()
            return resp.json()

    # --- Memory search ---
    async def search(self, query: str, limit: int = 5, tool_filter: str | None = None) -> list[dict]:
        """Semantic (vector) search first; if the embedding server is down or
        returns nothing, fall back to trigram title/path match so callers still
        get *some* result for direct keyword lookups."""
        sem_params: dict = {"q": query, "limit": limit}
        if tool_filter:
            sem_params["tool_filter"] = tool_filter
        sem = await self._get("/api/memory/semantic", sem_params)
        if isinstance(sem, dict) and sem.get("results"):
            return sem["results"]

        params = {"q": query, "limit": limit}
        if tool_filter:
            params["tool"] = tool_filter
        result = await self._get("/api/search", params)
        return result.get("results", []) if isinstance(result, dict) else []

    # --- Memory store ---
    async def store_observation(
        self, content: str, entity_name: str | None, entity_type: str,
    ) -> dict:
        return await self._post("/api/memory/observations", {
            "content": content,
            "entity_name": entity_name,
            "entity_type": entity_type,
        })

    # --- Projects ---
    async def list_projects(self) -> list[dict]:
        return await self._get("/api/projects")

    async def get_project(self, project_id: str) -> dict:
        return await self._get(f"/api/projects/{project_id}")

    # --- Documents ---
    async def get_document(self, doc_id: str) -> dict:
        return await self._get(f"/api/documents/{doc_id}")

    # --- Conversations ---
    async def get_conversation_messages(self, doc_id: str, limit: int = 50) -> dict:
        return await self._get(f"/api/conversations/{doc_id}/messages", {"limit": limit})

    # --- Daily ---
    async def get_daily(self, date_str: str) -> dict:
        from datetime import datetime, timezone, timedelta
        tz = int(datetime.now(timezone.utc).astimezone().utcoffset().total_seconds() // 60)
        return await self._get(f"/api/daily/{date_str}", {"tz_offset": -tz})

    async def get_daily_dates(self, days: int = 30) -> list[dict]:
        return await self._get("/api/daily", {"days": days})

    # --- Dashboard ---
    async def get_dashboard(self) -> dict:
        return await self._get("/api/dashboard")

    # --- Tools ---
    async def get_tools(self) -> list[dict]:
        return await self._get("/api/tools")

    async def get_tool_files(self, tool_id: str, category: str | None = None) -> list[dict]:
        params = {}
        if category:
            params["category"] = category
        return await self._get(f"/api/tools/{tool_id}/files", params)
