"""Mount MCP Memory Server as a Streamable HTTP endpoint on the FastAPI app.

This enables remote MCP access at /mcp for ChatGPT, Claude, Gemini, etc.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("mcp_mount")


def mount_mcp(app):
    """Mount MCP server on the FastAPI app at /mcp path. Best-effort — skips if deps missing."""
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError:
        logger.info("MCP SDK not installed, skipping MCP mount")
        return

    db_url = os.environ.get(
        "MEMENTO_DATABASE_URL",
        "postgresql+asyncpg://postgres:postgres@postgres:5432/memento",
    )

    # Create a dedicated MCP server instance for remote access
    mcp = FastMCP(
        "Memento",
        instructions="Personal AI coding memory — search conversations, recall knowledge, explore project context.",
        streamable_http_path="/mcp",
    )

    # Import and register tools/resources from the mcp_server package
    try:
        from mcp_server.server import (
            memory_search, memory_recall, memory_context, memory_store, daily_summary,
            list_projects, get_project, get_identity, get_daily,
            init_server,
        )
        init_server(db_url)

        # Re-register tools on this instance
        mcp.tool()(memory_search)
        mcp.tool()(memory_recall)
        mcp.tool()(memory_context)
        mcp.tool()(memory_store)
        mcp.tool()(daily_summary)
        mcp.resource("memory://projects")(list_projects)
        mcp.resource("memory://projects/{name}")(get_project)
        mcp.resource("memory://identity/{tool}")(get_identity)
        mcp.resource("memory://daily/{date_str}")(get_daily)

        # Mount as ASGI sub-application
        mcp_app = mcp.streamable_http_app()
        app.mount("/mcp", mcp_app)
        logger.info("MCP Memory Server mounted at /mcp")
    except Exception as e:
        logger.warning("Failed to mount MCP server: %s", e)
