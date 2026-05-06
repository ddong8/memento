FROM python:3.12-slim

WORKDIR /app

# Backup uses pure SQL COPY TO STDOUT (no pg_dump binary needed).
# Schema rebuild via _run_migrations on fresh deploy; backup only carries
# data. Avoids the bookworm libldap / pgdg client version mess.

# Install server
COPY server/pyproject.toml .
COPY server/server/ server/
RUN pip install --no-cache-dir .

# Install MCP server package (for remote /mcp endpoint)
COPY mcp_server/ /tmp/mcp_server/
RUN pip install --no-cache-dir /tmp/mcp_server && rm -rf /tmp/mcp_server

# Bootstrap installer assets served at /install.sh, /install.ps1, /install
COPY deploy/bootstrap/ /app/bootstrap/

# Note: BGE-M3 embedding model runs on host machine (not in container)
# Start with: python -m server.services.embedding_server --port 8002

EXPOSE 8000

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
