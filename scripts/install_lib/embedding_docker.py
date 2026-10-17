"""Docker-based install path for the BGE-M3 embedding server.

Replaces the host venv install as the *default* — it eliminates the
three flakiest steps users hit on the old path:

  1. Host Python + pip dependency resolution (torch, sentence-transformers,
     modelscope, fastapi, uvicorn all have to land on a single working
     resolution; image pins them once at build time).
  2. 1.3 GB model download mid-install with no clean retry — the
     Dockerfile bakes the model in and tries 3 mirrors during build.
  3. Service manager registration (launchd / systemd / Task Scheduler)
     — Docker's `restart: unless-stopped` replaces that.

Activates the `embedding` compose profile so the service only runs when
the user opts in.
"""

from __future__ import annotations

import subprocess
import time

from .platform_utils import (
    REPO_ROOT, docker_available, docker_start_hint, info, ok, warn,
)


def _compose_cmd(*extra: str) -> list[str]:
    return ["docker", "compose", "--profile", "embedding", *extra]


def install() -> None:
    """Build + start the embedding container.

    First build takes 5–15 min (pip wheels + 1.3 GB model bake). The
    image is then cached, so subsequent runs start in seconds.
    """
    if not docker_available():
        raise RuntimeError("Docker is not running. " + docker_start_hint())

    info("Building embedding image (first time: 5–15 min for torch + model)…")
    subprocess.run(
        _compose_cmd("build", "embedding"),
        check=True, cwd=str(REPO_ROOT),
    )
    ok("Embedding image built.")

    info("Starting embedding container…")
    subprocess.run(
        _compose_cmd("up", "-d", "embedding"),
        check=True, cwd=str(REPO_ROOT),
    )

    # The api / celery containers were started with whatever
    # MEMENTO_EMBEDDING_SERVER_URL they had at launch time. If those
    # containers were already up before we added the embedding service,
    # they may be pointing at the old default (host.docker.internal:8002)
    # which isn't reachable from inside Linux Docker without a host
    # process listening. Recreate them so they pick up the compose
    # default (http://embedding:8002) and the new network alias.
    info("Recreating api + celery containers so they discover the embedding service…")
    subprocess.run(
        ["docker", "compose", "up", "-d", "--no-deps", "--force-recreate",
         "api", "celery-worker", "celery-beat"],
        check=True, cwd=str(REPO_ROOT),
    )

    _wait_healthy(timeout=300)
    ok("Embedding server is ready.")


def uninstall(*, remove_image: bool = False) -> None:
    """Stop the embedding container. With --remove-image, also delete the
    built image and its cached model layer (frees ~3 GB)."""
    if not docker_available():
        warn("Docker not running — nothing to stop.")
        return
    subprocess.run(
        _compose_cmd("rm", "-sf", "embedding"),
        check=False, cwd=str(REPO_ROOT),
    )
    if remove_image:
        subprocess.run(
            ["docker", "image", "rm", "memento-embedding"],
            check=False,
        )
    ok("Embedding container removed.")


def restart() -> None:
    if not docker_available():
        warn("Docker not running — cannot restart embedding.")
        return
    subprocess.run(
        _compose_cmd("restart", "embedding"),
        check=False, cwd=str(REPO_ROOT),
    )


def is_installed() -> bool:
    """True if the embedding container exists (running or stopped)."""
    if not docker_available():
        return False
    r = subprocess.run(
        ["docker", "compose", "ps", "-a", "--format", "{{.Name}}", "embedding"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    return bool(r.stdout.strip())


def _wait_healthy(timeout: int = 300) -> None:
    """Poll the embedding container's healthcheck via `docker inspect`.

    We probe the container directly rather than the host port because
    the default compose config doesn't publish 8002 to the host (the
    api container reaches it over the docker network).
    """
    info(f"Waiting for embedding to report healthy (up to {timeout}s)…")
    deadline = time.monotonic() + timeout
    last_status = ""
    while time.monotonic() < deadline:
        r = subprocess.run(
            ["docker", "inspect", "-f",
             "{{.State.Health.Status}}", "memento_embedding"],
            capture_output=True, text=True,
        )
        status = r.stdout.strip()
        if status == "healthy":
            return
        if status and status != last_status:
            info(f"  embedding status: {status}")
            last_status = status
        time.sleep(3)
    raise RuntimeError(
        f"Embedding did not become healthy within {timeout}s. "
        "Check `docker compose logs embedding`."
    )
