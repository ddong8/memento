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

# Dependencies first, pinned with hashes (server/uv.lock, exported to requirements.lock),
# so builds are reproducible and code changes don't reinstall them.
# Placing this layer before GeoIP guarantees 100% cache hits across code-only commits.
COPY server/requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# Share-view visitor location: DB-IP city-lite (CC BY 4.0) at the path geoip.py reads.
# CI passes GEOIP_MONTH=YYYY-MM so this layer refreshes monthly; builds without it skip it.
ARG GEOIP_MONTH=""
COPY scripts/fetch_geoip.py /tmp/fetch_geoip.py
RUN if [ -n "$GEOIP_MONTH" ]; then python /tmp/fetch_geoip.py /data/geoip/GeoLite2-City.mmdb "$GEOIP_MONTH"; fi

# Install server
COPY server/pyproject.toml .
COPY server/server/ server/
RUN pip install --no-cache-dir --no-deps .

# Bootstrap installer assets served at /install.sh, /install.ps1, /install
COPY deploy/bootstrap/ /app/bootstrap/
COPY data/updates/ /app/data/updates/

# Embeddings come from an OpenAI-compatible API or the self-hosted BGE-M3
# service in embedding/ (MEMENTO_EMBEDDING_PROVIDER), not from this image.

# Last, so a new commit doesn't invalidate the cached layers above; /health reports it
ARG GIT_SHA=dev
ENV MEMENTO_BUILD_SHA=${GIT_SHA}

EXPOSE 8000

# SSE 长连接不会自己结束:停止时最多等 25s 就关掉,赶在 k8s 强杀(terminationGracePeriodSeconds 40)前干净退出
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-graceful-shutdown", "25"]
