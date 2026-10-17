"""Client auto-update distribution API.

Serves update metadata and client packages directly from the Memento server,
enabling intranet/self-hosted automatic client upgrades without external GitHub dependencies,
while dynamically synchronizing with GitHub Releases when available.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse, Response
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/system/update", tags=["system-update"])

# Storage candidates for update packages
_CANDIDATES = [
    Path(os.environ.get("MEMENTO_UPDATES_DIR", "")) if os.environ.get("MEMENTO_UPDATES_DIR") else None,
    Path("/app/data/updates"),
    Path(__file__).resolve().parents[3] / "data" / "updates",
]
_UPDATES_DIR = next((p for p in _CANDIDATES if p and p.exists()), _CANDIDATES[-1])

# GitHub release configuration
GITHUB_REPO = os.environ.get("MEMENTO_GITHUB_REPO", "ddong8/memento")
GITHUB_CACHE_TTL = int(os.environ.get("MEMENTO_UPDATE_CACHE_TTL", "300"))  # 5 minutes

# In-memory cache for latest GitHub release metadata: (cached_at_timestamp, release_dict)
_RELEASE_CACHE: dict[str, Any] = {"time": 0.0, "data": None}
_YAML_CACHE: dict[tuple[str, str], tuple[float, bytes]] = {}


class UpdateCheckResponse(BaseModel):
    has_update: bool
    latest_version: str = ""
    current_version: str = ""
    title: str = ""
    release_notes: str = ""
    published_at: str | None = None
    download_url: str | None = None
    upstream_url: str | None = None
    asset_name: str | None = None
    asset_size: int | None = None
    sha256: str | None = None


def _compare_semver(target: str, current: str) -> bool:
    """Return True if target > current."""
    if not target or not current:
        return False
    t_nums = [int(n) for n in re.findall(r"\d+", target)] or [0]
    c_nums = [int(n) for n in re.findall(r"\d+", current)] or [0]
    max_len = max(len(t_nums), len(c_nums))
    t_nums.extend([0] * (max_len - len(t_nums)))
    c_nums.extend([0] * (max_len - len(c_nums)))
    return t_nums > c_nums


def _find_platform_asset(updates_dir: Path, platform: str) -> Path | None:
    """Find a binary asset in updates_dir matching the target platform."""
    if not updates_dir.exists():
        return None

    plat = platform.lower()
    patterns = []
    if "win" in plat:
        patterns = ["*windows*.zip", "*win*.zip", "*win*.exe", "*.msi", "*.exe"]
    elif "mac" in plat or "darwin" in plat:
        patterns = ["*macos*.zip", "*mac*.zip", "*.dmg", "*.pkg"]
    elif "linux" in plat:
        patterns = ["*linux*.tar.gz", "*linux*.zip", "*.AppImage", "*.deb"]
    else:
        patterns = [f"*{plat}*"]

    for pat in patterns:
        for p in updates_dir.glob(pat):
            if p.is_file() and not p.name.endswith(".json") and not p.name.endswith(".part"):
                return p
    return None


def _match_github_asset(assets: list[dict[str, Any]], platform: str) -> dict[str, Any] | None:
    """Match the most appropriate release asset for the requested platform."""
    plat = platform.lower()

    if "win" in plat:
        # Prefer .zip for seamless in-place hot replacement (matching macOS and Linux); fallback to setup.exe
        for a in assets:
            name = a.get("name", "").lower()
            if ("win" in name or "windows" in name) and name.endswith(".zip"):
                return a
        for a in assets:
            name = a.get("name", "").lower()
            if ("win" in name or "windows" in name) and (name.endswith("setup.exe") or name.endswith(".exe") or name.endswith(".msi")):
                return a

    elif "mac" in plat or "darwin" in plat:
        # Prefer .zip for in-place app replacement; fallback to .dmg
        for a in assets:
            name = a.get("name", "").lower()
            if ("mac" in name or "darwin" in name) and name.endswith(".zip"):
                return a
        for a in assets:
            name = a.get("name", "").lower()
            if ("mac" in name or "darwin" in name) and name.endswith(".dmg"):
                return a

    elif "linux" in plat:
        # Prefer .tar.gz / .zip for portable update; fallback to .deb or .AppImage
        for a in assets:
            name = a.get("name", "").lower()
            if "linux" in name and (name.endswith(".tar.gz") or name.endswith(".zip")):
                return a
        for a in assets:
            name = a.get("name", "").lower()
            if "linux" in name and (name.endswith(".deb") or name.endswith(".appimage")):
                return a

    # Fallback to loose name match
    for a in assets:
        name = a.get("name", "").lower()
        if plat in name and not name.endswith(".txt") and not name.endswith(".sha256"):
            return a

    return None


async def _fetch_latest_github_release(force_refresh: bool = False) -> dict[str, Any] | None:
    """Fetch latest release info from GitHub, using memory cache and mirror fallbacks."""
    global _RELEASE_CACHE
    now = time.time()
    if not force_refresh and _RELEASE_CACHE["data"] and (now - _RELEASE_CACHE["time"] < GITHUB_CACHE_TTL):
        return _RELEASE_CACHE["data"]

    urls = [
        f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
        f"https://mirror.ghproxy.com/https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
    ]

    try:
        import httpx
    except ImportError:
        return None

    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Memento-Server-Updater/1.0",
    }
    github_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
        for url in urls:
            try:
                resp = await client.get(url, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, dict) and "tag_name" in data:
                        _RELEASE_CACHE["time"] = now
                        _RELEASE_CACHE["data"] = data
                        return data
            except Exception as e:
                logger.debug("Failed to fetch release from %s: %s", url, e)

    return _RELEASE_CACHE["data"]


@router.get("/check", response_model=UpdateCheckResponse)
async def check_update(
    platform: str = Query("windows", description="Target platform (windows/macos/linux)"),
    version: str = Query("1.0.0", description="Current client version"),
) -> UpdateCheckResponse:
    """Check if the server or upstream repository hosts a newer version of the client."""
    plat_lower = (platform or "").lower()
    if any(m in plat_lower for m in ("ios", "iphone", "ipad", "android", "mobile")):
        return UpdateCheckResponse(
            has_update=False,
            latest_version=version,
            current_version=version,
            title="Memento",
            release_notes="移动端请在 GitHub Release 发布页查看安装说明。",
        )

    updates_dir = _UPDATES_DIR
    version_file = updates_dir / "version.json"

    # 1. Read local static metadata if present
    local_meta: dict[str, Any] = {}
    if version_file.exists():
        try:
            with open(version_file, "r", encoding="utf-8") as f:
                local_meta = json.load(f)
        except Exception:
            local_meta = {}

    local_ver = str(local_meta.get("version", "")).strip().lstrip("vV")
    local_platform_asset = _find_platform_asset(updates_dir, platform)

    # 2. Query latest GitHub release (dynamic auto-discovery)
    gh_release = await _fetch_latest_github_release()

    gh_ver = ""
    gh_asset: dict[str, Any] | None = None
    if gh_release:
        raw_tag = str(gh_release.get("tag_name", "")).strip()
        gh_ver = raw_tag.lstrip("vV")
        assets = gh_release.get("assets", [])
        if isinstance(assets, list):
            gh_asset = _match_github_asset(assets, platform)

    # 3. Determine latest version: compare local vs GitHub
    use_github = False
    latest_ver = ""

    if gh_ver and local_ver:
        if _compare_semver(gh_ver, local_ver):
            latest_ver = gh_ver
            use_github = True
        else:
            latest_ver = local_ver
            use_github = False
    elif gh_ver:
        latest_ver = gh_ver
        use_github = True
    elif local_ver:
        latest_ver = local_ver
        use_github = False
    elif local_platform_asset:
        m = re.search(r"(\d+\.\d+\.\d+)", local_platform_asset.name)
        if m:
            latest_ver = m.group(1)

    if not latest_ver and not local_platform_asset:
        return UpdateCheckResponse(
            has_update=False,
            current_version=version,
            release_notes="服务端暂未托管更新包",
        )

    clean_current = version.strip().lstrip("vV")
    has_update = _compare_semver(latest_ver, clean_current) if latest_ver else (local_platform_asset is not None)

    title = f"Memento v{latest_ver}"
    release_notes = "修复已知问题并提升稳定性。"
    published_at = None
    asset_name = None
    asset_size = None
    sha256_val = None

    if use_github and gh_release:
        title = str(gh_release.get("name") or title)
        gh_body = str(gh_release.get("body") or "").strip()
        if gh_body and not gh_body.startswith("**Full Changelog**"):
            release_notes = gh_body
        elif local_meta.get("release_notes"):
            release_notes = local_meta.get("release_notes")
        else:
            release_notes = gh_body or release_notes
        published_at = gh_release.get("published_at")
        if gh_asset:
            asset_name = gh_asset.get("name")
            asset_size = gh_asset.get("size")
            raw_digest = str(gh_asset.get("digest") or "")
            if raw_digest.startswith("sha256:"):
                sha256_val = raw_digest.split("sha256:", 1)[1].strip()
        if not sha256_val and local_ver == latest_ver:
            plat_meta = local_meta.get("platforms", {}).get(platform.lower(), {})
            if plat_meta and isinstance(plat_meta, dict):
                sha256_val = plat_meta.get("sha256")
    else:
        title = local_meta.get("title", title)
        release_notes = local_meta.get("release_notes", release_notes)
        published_at = local_meta.get("published_at")
        plat_meta = local_meta.get("platforms", {}).get(platform.lower(), {})
        if plat_meta and isinstance(plat_meta, dict):
            asset_name = plat_meta.get("asset_name")
            asset_size = plat_meta.get("size")
            sha256_val = plat_meta.get("sha256")

        if local_platform_asset:
            asset_name = local_platform_asset.name
            asset_size = local_platform_asset.stat().st_size
        elif gh_release and gh_ver == latest_ver:
            assets = gh_release.get("assets", [])
            exact_gh_asset = next((a for a in assets if a.get("name") == asset_name), None) if asset_name and isinstance(assets, list) else None
            matched = exact_gh_asset or gh_asset
            if matched and matched.get("size"):
                asset_size = matched.get("size")
                if not asset_name:
                    asset_name = matched.get("name")
                gh_asset = matched

    download_url = None
    if asset_name:
        v_param = f"&version={latest_ver}" if latest_ver else ""
        download_url = f"/api/system/update/download?file={asset_name}{v_param}"

    github_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    upstream_url = None
    if github_token and download_url:
        upstream_url = download_url
    elif gh_asset and gh_ver == latest_ver:
        upstream_url = gh_asset.get("browser_download_url")
    elif latest_ver and asset_name:
        tag_prefix = latest_ver if latest_ver.startswith("v") else f"v{latest_ver}"
        upstream_url = f"https://github.com/{GITHUB_REPO}/releases/download/{tag_prefix}/{asset_name}"

    return UpdateCheckResponse(
        has_update=has_update,
        latest_version=latest_ver or version,
        current_version=version,
        title=title,
        release_notes=release_notes,
        published_at=published_at,
        download_url=download_url,
        upstream_url=upstream_url,
        asset_name=asset_name,
        asset_size=asset_size,
        sha256=sha256_val,
    )


def _synthesize_fallback_yaml(safe_name: str) -> bytes | None:
    """Synthesize electron-updater channel YAML from local version.json when GitHub API is unreachable."""
    version_file = _UPDATES_DIR / "version.json"
    if not version_file.exists():
        return None
    try:
        with open(version_file, "r", encoding="utf-8") as f:
            meta = json.load(f)
        ver = str(meta.get("version", "")).strip().lstrip("vV")
        if not ver:
            return None
        plat_key = "macos" if "mac" in safe_name.lower() else ("linux" if "linux" in safe_name.lower() else "windows")
        plat_meta = meta.get("platforms", {}).get(plat_key, {})
        asset_name = plat_meta.get("asset_name") or f"Memento-{ver}-win-x64.exe"
        size = plat_meta.get("size") or 0
        yaml_str = (
            f"version: {ver}\n"
            f"files:\n"
            f"  - url: {asset_name}\n"
            f"    size: {size}\n"
            f"path: {asset_name}\n"
            f"releaseDate: '{meta.get('published_at') or '2026-10-09T00:00:00.000Z'}'\n"
        )
        return yaml_str.encode("utf-8")
    except Exception:
        return None


@router.get("/download")
async def download_update(
    file: str = Query(..., description="Asset filename to download"),
    version: str | None = Query(None, description="Target release version"),
):
    """Download update asset file with directory traversal protection.
    
    If hosted locally on the server filesystem, serves it immediately via FileResponse.
    If not cached locally, resolves GitHub Release Asset API pre-signed URL (supporting private repos)
    or redirects to upstream GitHub Release URL.
    """
    # Sanitize filename: only allow safe alphanumeric, dots, dashes, underscores
    safe_name = os.path.basename(file)
    if not re.match(r"^[\w\.\-]+$", safe_name):
        raise HTTPException(status_code=400, detail="Invalid filename")

    file_path = _UPDATES_DIR / safe_name
    if file_path.exists() and file_path.is_file():
        media_type = "text/yaml; charset=utf-8" if safe_name.endswith(".yml") else "application/octet-stream"
        return FileResponse(
            file_path,
            filename=safe_name,
            media_type=media_type,
            headers={
                "Cache-Control": "no-cache" if safe_name.endswith(".yml") else "public, max-age=600",
                "Content-Disposition": f'attachment; filename="{safe_name}"',
            },
        )

    # Asset is not present in local filesystem: resolve tag and check GitHub Release assets
    tag = ""
    if version:
        tag = version.strip()

    gh_release = await _fetch_latest_github_release()
    if not tag:
        version_file = _UPDATES_DIR / "version.json"
        local_ver = ""
        if version_file.exists():
            try:
                with open(version_file, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                    local_ver = str(meta.get("version", "")).strip().lstrip("vV")
            except Exception:
                pass

        gh_ver = ""
        if gh_release and "tag_name" in gh_release:
            gh_ver = str(gh_release["tag_name"]).strip().lstrip("vV")

        if gh_ver and local_ver:
            tag = gh_ver if _compare_semver(gh_ver, local_ver) else local_ver
        elif gh_ver:
            tag = gh_ver
        elif local_ver:
            tag = local_ver

    if not tag:
        m = re.search(r"[vV]?(\d+\.\d+\.\d+)", safe_name)
        if m:
            tag = m.group(1)

    tag_name = tag if tag.startswith("v") else (f"v{tag}" if tag else "v1.0.66")

    # Check if we can serve/redirect via GitHub Release Asset API (required when repo is private)
    github_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    matched_asset: dict[str, Any] | None = None
    if gh_release and isinstance(gh_release.get("assets"), list):
        for a in gh_release["assets"]:
            if a.get("name") == safe_name:
                matched_asset = a
                break

    if safe_name.endswith(".yml"):
        now = time.time()
        cache_key = (tag_name, safe_name)
        cached = _YAML_CACHE.get(cache_key)
        if cached and (now - cached[0] < GITHUB_CACHE_TTL):
            return Response(
                content=cached[1],
                media_type="text/yaml; charset=utf-8",
                headers={"Cache-Control": "no-cache"},
            )
        if matched_asset and matched_asset.get("url"):
            try:
                import httpx
                headers = {
                    "Accept": "application/octet-stream",
                    "User-Agent": "Memento-Server-Updater/1.0",
                }
                if github_token:
                    headers["Authorization"] = f"Bearer {github_token}"
                async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as client:
                    resp = await client.get(matched_asset["url"], headers=headers)
                    if resp.status_code == 200 and resp.content:
                        _YAML_CACHE[cache_key] = (now, resp.content)
                        return Response(
                            content=resp.content,
                            media_type="text/yaml; charset=utf-8",
                            headers={"Cache-Control": "no-cache"},
                        )
            except Exception as e:
                logger.warning("Failed to fetch YAML asset %s from GitHub API: %s", safe_name, e)

        fallback_yaml = _synthesize_fallback_yaml(safe_name)
        if fallback_yaml:
            return Response(
                content=fallback_yaml,
                media_type="text/yaml; charset=utf-8",
                headers={"Cache-Control": "no-cache"},
            )

    if matched_asset and matched_asset.get("url") and github_token:
        try:
            import httpx
            headers = {
                "Accept": "application/octet-stream",
                "Authorization": f"Bearer {github_token}",
                "User-Agent": "Memento-Server-Updater/1.0",
            }
            async with httpx.AsyncClient(follow_redirects=False, timeout=8.0) as client:
                resp = await client.get(matched_asset["url"], headers=headers)
                if resp.status_code in (301, 302, 303, 307, 308):
                    presigned_url = resp.headers.get("location")
                    if presigned_url:
                        return RedirectResponse(url=presigned_url, status_code=302)
        except Exception as e:
            logger.warning("Failed to resolve pre-signed GitHub asset URL for %s: %s", safe_name, e)

    target_url = f"https://github.com/{GITHUB_REPO}/releases/download/{tag_name}/{safe_name}"
    logger.info("Local update asset '%s' not found on server disk, redirecting 302 to upstream: %s", safe_name, target_url)
    return RedirectResponse(url=target_url, status_code=302)


@router.get("/{filename}")
async def generic_updater_file(
    filename: str,
    version: str | None = Query(None, description="Optional target release version"),
):
    """Serve electron-updater generic provider requests (e.g. latest.yml, latest-mac.yml, latest-linux.yml, and binary/blockmap files)."""
    return await download_update(file=filename, version=version)



