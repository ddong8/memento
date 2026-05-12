FROM python:3.12-slim

WORKDIR /app

# Backup uses pure SQL COPY TO STDOUT (no pg_dump binary needed).
# Schema rebuild via _run_migrations on fresh deploy; backup only carries
# data. Avoids the bookworm libldap / pgdg client version mess.

# Optional pip mirror — set PIP_INDEX_URL via docker-compose build args
# when on flaky / slow networks (e.g. .env with
# PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple in China).
# Empty default keeps the standard pypi.org behavior for everyone else.
ARG PIP_INDEX_URL=""
ENV PIP_INDEX_URL=${PIP_INDEX_URL}
ENV PIP_DEFAULT_TIMEOUT=300

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
