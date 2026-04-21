"""Entry point for the MCP Memory Server.

Usage:
  # Remote mode (recommended — no DB needed, works anywhere):
  memento-memory --server https://mem.ihasy.com --token YOUR_JWT_TOKEN

  # Direct DB mode (local dev / self-hosted):
  memento-memory --db-url postgresql+asyncpg://user:pass@host:port/memento
"""

from __future__ import annotations

import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(
        description="Memento MCP Server — personal AI memory for all tools",
    )
    parser.add_argument("--server", help="Memento server URL (e.g. https://mem.ihasy.com)")
    parser.add_argument("--token", help="JWT token for authentication")
    parser.add_argument("--db-url", help="PostgreSQL connection URL (for direct DB mode)")
    args = parser.parse_args()

    server_url = args.server or os.environ.get("MEMENTO_SERVER_URL")
    token = args.token or os.environ.get("MEMENTO_SERVER_TOKEN")
    db_url = args.db_url or os.environ.get("MEMENTO_DATABASE_URL")

    from .server import mcp, init_server

    if server_url and token:
        init_server(server_url=server_url, token=token)
    elif db_url:
        init_server(db_url=db_url)
    else:
        print("Error: Either --server/--token or --db-url is required.", file=sys.stderr)
        print("\nRemote mode (recommended):", file=sys.stderr)
        print("  memento-memory --server https://mem.ihasy.com --token YOUR_TOKEN", file=sys.stderr)
        print("\nDirect DB mode:", file=sys.stderr)
        print("  memento-memory --db-url postgresql+asyncpg://...", file=sys.stderr)
        sys.exit(1)

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
