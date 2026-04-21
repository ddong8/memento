"""Install bootstrap — serves the one-line installer at /install.sh + /install.ps1.

Usage (from the user's shell):
    curl -fsSL https://mem.ihasy.com/install.sh | sh
    iwr  https://mem.ihasy.com/install.ps1 -useb | iex

The scripts live under deploy/bootstrap/ in the repo. We read them from disk
so a simple `docker compose up -d` (with the bootstrap dir mounted or copied
into the image) picks up edits without rebuilds.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response

router = APIRouter(tags=["install"])

# When running in the Docker image, deploy/bootstrap/ is copied to /app/bootstrap/.
# During local dev outside docker, fall back to the repo path.
_CANDIDATES = [
    Path("/app/bootstrap"),
    Path(__file__).resolve().parents[3] / "deploy" / "bootstrap",
]
_BOOTSTRAP_DIR = next((p for p in _CANDIDATES if p.exists()), _CANDIDATES[-1])

# GitHub repo used for the fallback tarball redirect.
_GITHUB_BASE = "https://github.com/ddong8/memento"


def _serve_script(name: str, media_type: str) -> Response:
    path = _BOOTSTRAP_DIR / name
    if not path.exists():
        return Response(
            status_code=503,
            content=f"Bootstrap asset missing on server: {name}",
            media_type="text/plain",
        )
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            # curl | sh should see full file; no aggressive caching, but allow
            # a short proxy cache so nginx can shield the API a bit.
            "Cache-Control": "public, max-age=300",
        },
    )


@router.get("/install.sh", include_in_schema=False)
async def install_sh() -> Response:
    return _serve_script("install.sh", "text/x-shellscript; charset=utf-8")


@router.get("/install.ps1", include_in_schema=False)
async def install_ps1() -> Response:
    return _serve_script("install.ps1", "text/plain; charset=utf-8")


@router.get("/install", include_in_schema=False)
@router.get("/install/", include_in_schema=False)
async def install_landing() -> Response:
    path = _BOOTSTRAP_DIR / "index.html"
    if not path.exists():
        return HTMLResponse(
            "<h1>Memento</h1>"
            "<p>Install: <code>curl -fsSL /install.sh | sh</code></p>",
            status_code=200,
        )
    return FileResponse(path, media_type="text/html; charset=utf-8")


@router.get("/install/latest.tar.gz", include_in_schema=False)
async def install_tarball() -> RedirectResponse:
    """Redirect to GitHub archive. In production this could be replaced with a
    locally-cached tarball if GitHub latency is a problem."""
    return RedirectResponse(
        f"{_GITHUB_BASE}/archive/refs/heads/main.tar.gz",
        status_code=302,
    )
