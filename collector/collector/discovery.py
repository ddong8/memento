"""Auto-discovery of AI tool installations and their project paths across platforms."""

from __future__ import annotations

import json
import os
import platform
from pathlib import Path
from urllib.parse import unquote

SYSTEM = platform.system()
HOME = Path.home()


def _appdata() -> Path:
    """Windows %APPDATA% path."""
    return Path(os.environ.get("APPDATA", str(HOME / "AppData" / "Roaming")))


def _app_support() -> Path:
    """macOS ~/Library/Application Support."""
    return HOME / "Library" / "Application Support"


def _linux_config() -> Path:
    """Linux ~/.config."""
    return HOME / ".config"


def _clean_path(path: str) -> str:
    """Strip Windows extended path prefix \\\\?\\ and URL-decode."""
    if path.startswith("\\\\?\\"):
        path = path[4:]
    path = unquote(path)
    return path


# ---------------------------------------------------------------------------
# Per-tool discovery
# ---------------------------------------------------------------------------

def discover_claude_code() -> dict | None:
    """Discover Claude Code installation and project paths."""
    root = HOME / ".claude"
    if not root.exists():
        return None

    info: dict = {"root": str(root), "projects": []}

    # Extract projects from directory names
    projects_dir = root / "projects"
    if projects_dir.exists():
        for d in projects_dir.iterdir():
            if d.is_dir() and d.name.startswith("-"):
                # Decode path: -Users-haixingdong-dev-foo -> /Users/haixingdong/dev/foo
                decoded = "/" + d.name.lstrip("-").replace("-", "/")
                info["projects"].append({"path": _clean_path(decoded), "hash": d.name})

    # Config
    config_file = HOME / ".claude.json"
    if config_file.exists():
        try:
            data = json.loads(config_file.read_text(encoding="utf-8"))
            info["install_method"] = data.get("installMethod", "unknown")
        except Exception:
            pass

    return info


def discover_codex() -> dict | None:
    """Discover Codex installation and workspace roots."""
    root = HOME / ".codex"
    if not root.exists():
        return None

    info: dict = {"root": str(root), "projects": []}

    # Global state has workspace roots
    state_file = root / ".codex-global-state.json"
    if state_file.exists():
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            for path in data.get("electron-saved-workspace-roots", []):
                info["projects"].append({"path": _clean_path(path)})
            for path in data.get("active-workspace-roots", []):
                if not any(p["path"] == path for p in info["projects"]):
                    info["projects"].append({"path": _clean_path(path)})
        except Exception:
            pass

    # config.toml has trusted projects
    config_file = root / "config.toml"
    if config_file.exists():
        try:
            import tomli
            data = tomli.loads(config_file.read_text(encoding="utf-8"))
            info["model"] = data.get("model", "")
            for path in data.get("projects", {}):
                if not any(p["path"] == path for p in info["projects"]):
                    info["projects"].append({"path": _clean_path(path), "trusted": True})
        except Exception:
            pass

    return info


def discover_cursor() -> dict | None:
    """Discover Cursor installation and workspace folders."""
    root = HOME / ".cursor"
    if not root.exists():
        return None

    info: dict = {"root": str(root), "projects": []}

    # storage.json has workspace folders
    if SYSTEM == "Darwin":
        storage = _app_support() / "Cursor" / "User" / "globalStorage" / "storage.json"
    elif SYSTEM == "Windows":
        storage = _appdata() / "Cursor" / "User" / "globalStorage" / "storage.json"
    else:
        storage = _linux_config() / "Cursor" / "User" / "globalStorage" / "storage.json"

    if storage.exists():
        try:
            data = json.loads(storage.read_text(encoding="utf-8"))
            folders = data.get("backupWorkspaces", {}).get("folders", [])
            for f in folders:
                uri = f.get("folderUri", "")
                if uri.startswith("file:///"):
                    path = uri[7:] if SYSTEM != "Windows" else uri[8:]
                    info["projects"].append({"path": _clean_path(path)})
        except Exception:
            pass

    return info


def discover_antigravity() -> dict | None:
    """Discover Antigravity installation and workspace folders."""
    # Check both ~/.antigravity and ~/.gemini
    ag_root = HOME / ".antigravity"
    gemini_root = HOME / ".gemini" / "antigravity"
    if not ag_root.exists() and not gemini_root.exists():
        return None

    info: dict = {
        "root": str(ag_root),
        "gemini_root": str(gemini_root) if gemini_root.exists() else None,
        "projects": [],
    }

    # storage.json has workspace folders
    if SYSTEM == "Darwin":
        storage = _app_support() / "Antigravity" / "User" / "globalStorage" / "storage.json"
    elif SYSTEM == "Windows":
        storage = _appdata() / "Antigravity" / "User" / "globalStorage" / "storage.json"
    else:
        storage = _linux_config() / "Antigravity" / "User" / "globalStorage" / "storage.json"

    if storage.exists():
        try:
            data = json.loads(storage.read_text(encoding="utf-8"))
            folders = data.get("backupWorkspaces", {}).get("folders", [])
            for f in folders:
                uri = f.get("folderUri", "")
                if uri.startswith("file:///"):
                    path = uri[7:] if SYSTEM != "Windows" else uri[8:]
                    info["projects"].append({"path": _clean_path(path)})
        except Exception:
            pass

    # Brain sessions
    brain = gemini_root / "brain" if gemini_root.exists() else None
    if brain and brain.exists():
        info["brain_sessions"] = len([d for d in brain.iterdir() if d.is_dir()])

    return info


def discover_openclaw() -> dict | None:
    """Discover OpenClaw installation and workspace path."""
    root = HOME / ".openclaw"
    if not root.exists():
        return None

    info: dict = {"root": str(root), "projects": []}

    config_file = root / "openclaw.json"
    if config_file.exists():
        try:
            data = json.loads(config_file.read_text(encoding="utf-8"))
            workspace = data.get("agents", {}).get("defaults", {}).get("workspace", "")
            if workspace:
                info["workspace"] = workspace
                info["projects"].append({"path": workspace})
            info["model"] = data.get("agents", {}).get("defaults", {}).get("model", "")
        except Exception:
            pass

    return info


def discover_obsidian() -> dict | None:
    """Discover Obsidian vaults from obsidian.json."""
    from .config import _discover_obsidian_vault_from_config

    vault = _discover_obsidian_vault_from_config()
    if not vault:
        return None

    # Get all vaults
    info: dict = {"root": str(vault), "projects": []}

    candidates = []
    if SYSTEM == "Darwin":
        candidates.append(_app_support() / "obsidian" / "obsidian.json")
    elif SYSTEM == "Windows":
        candidates.append(_appdata() / "obsidian" / "obsidian.json")
        candidates.append(_appdata() / "Obsidian" / "obsidian.json")
    else:
        candidates.append(_linux_config() / "obsidian" / "obsidian.json")

    for config_path in candidates:
        if config_path.exists():
            try:
                data = json.loads(config_path.read_text(encoding="utf-8"))
                for vault_info in data.get("vaults", {}).values():
                    path = vault_info.get("path", "")
                    if path and Path(path).exists():
                        info["projects"].append({"path": _clean_path(path)})
            except Exception:
                pass
            break

    return info


# ---------------------------------------------------------------------------
# Aggregate discovery
# ---------------------------------------------------------------------------

def discover_all_tools() -> dict[str, dict]:
    """Discover all AI tools and their paths. Returns {tool_name: info}."""
    result = {}
    discoverers = {
        "claude_code": discover_claude_code,
        "codex": discover_codex,
        "cursor": discover_cursor,
        "antigravity": discover_antigravity,
        "openclaw": discover_openclaw,
        "obsidian": discover_obsidian,
    }

    for name, func in discoverers.items():
        try:
            info = func()
            if info:
                result[name] = info
        except Exception:
            pass

    return result
