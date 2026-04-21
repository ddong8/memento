"""Bring up the Docker Compose stack, verify health."""

from __future__ import annotations

import subprocess
import time
import urllib.error
import urllib.request
from typing import Iterable

from .platform_utils import (
    REPO_ROOT, docker_available, docker_start_hint, fail, info, ok,
    port_in_use, port_user_hint, warn,
)

# host_port → container_service (for error messages)
CHECK_PORTS: dict[int, str] = {
    8001: "api",
    5433: "postgres",
    6380: "redis",
    9000: "minio",
    9001: "minio-console",
    3001: "web",
}


def preflight() -> None:
    """Check Docker daemon + port availability. Raise on hard failures."""
    if not docker_available():
        raise RuntimeError("Docker is not running. " + docker_start_hint())
    ok("Docker daemon reachable.")

    # Warn about port usage — but only fail if something NOT ours is listening.
    # Easiest check: if our containers are already up, connections will succeed
    # (that's fine). We just surface the port list so user can debug.
    busy = [p for p in CHECK_PORTS if port_in_use(p)]
    if busy:
        # This is informational — `docker compose up -d` will reuse containers.
        info(
            "Ports in use (expected if stack is already running): "
            + ", ".join(str(p) for p in busy)
        )


def compose_up(services: Iterable[str] | None = None, build: bool = True) -> None:
    cmd = ["docker", "compose", "up", "-d"]
    if build:
        cmd.append("--build")
    if services:
        cmd.extend(services)
    info("Starting containers: " + " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=str(REPO_ROOT))


def _http_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return 200 <= r.status < 400
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def wait_for_api(timeout: int = 120) -> None:
    info(f"Waiting for API to become healthy (up to {timeout}s)…")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _http_ok("http://localhost:8001/health"):
            ok("API is healthy (http://localhost:8001/health → 200).")
            return
        time.sleep(2)
    raise RuntimeError(
        "API did not become healthy within "
        f"{timeout}s. Check `docker compose logs api`."
    )


def compose_down(purge: bool = False) -> None:
    cmd = ["docker", "compose", "down"]
    if purge:
        cmd.append("-v")
    info(" ".join(cmd))
    subprocess.run(cmd, check=False, cwd=str(REPO_ROOT))


def doctor() -> list[tuple[str, bool, str]]:
    """Return list of (service, ok, details) tuples for status printing."""
    rows: list[tuple[str, bool, str]] = []
    rows.append(("docker daemon", docker_available(), docker_start_hint()))
    rows.append(("api:8001", _http_ok("http://localhost:8001/health"),
                 "docker compose logs api"))
    rows.append(("web:3001", port_in_use(3001),
                 "docker compose logs web"))
    rows.append(("postgres:5433", port_in_use(5433),
                 "docker compose logs postgres"))
    rows.append(("redis:6380", port_in_use(6380),
                 "docker compose logs redis"))
    rows.append(("embedding:8002", _http_ok("http://localhost:8002/health"),
                 "./install.sh embedding to install"))
    return rows


def print_doctor(rows: list[tuple[str, bool, str]]) -> None:
    print()
    print("  Service             Status")
    print("  ─────────────────── ──────")
    for name, ok_, hint in rows:
        mark = "✓ up  " if ok_ else "✗ down"
        print(f"  {name:<19} {mark}  {hint if not ok_ else ''}")
    print()
