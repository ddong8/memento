"""Collector configuration — cross-platform paths, server settings, device identity."""

from __future__ import annotations

import os
import platform
import socket
import uuid
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

HOME = Path.home()
SYSTEM = platform.system()  # "Darwin", "Linux", "Windows"


# ---------------------------------------------------------------------------
# Platform-aware default paths
# ---------------------------------------------------------------------------

def _default_data_dir() -> Path:
    """~/.memento on all platforms."""
    return HOME / ".memento"


def _default_log_dir() -> Path:
    if SYSTEM == "Darwin":
        return HOME / "Library" / "Logs" / "memento"
    elif SYSTEM == "Windows":
        return Path(os.environ.get("LOCALAPPDATA", str(HOME / "AppData" / "Local"))) / "memento" / "logs"
    else:  # Linux
        return HOME / ".local" / "share" / "memento" / "logs"


def _default_obsidian_path() -> Path:
    """Auto-detect Obsidian vault from obsidian.json, fallback to common paths."""
    vault = _discover_obsidian_vault_from_config()
    if vault:
        return vault
    if SYSTEM == "Darwin":
        return HOME / "Documents" / "Obsidian"
    elif SYSTEM == "Windows":
        return HOME / "Documents" / "Obsidian"
    else:
        return HOME / "Documents" / "Obsidian"


def _discover_obsidian_vault_from_config() -> Path | None:
    """Read Obsidian's own config to find vault paths — works on all platforms."""
    import json
    candidates = []
    if SYSTEM == "Darwin":
        candidates.append(HOME / "Library" / "Application Support" / "obsidian" / "obsidian.json")
    elif SYSTEM == "Windows":
        appdata = Path(os.environ.get("APPDATA", str(HOME / "AppData" / "Roaming")))
        candidates.append(appdata / "obsidian" / "obsidian.json")
        # Also check lowercase
        candidates.append(appdata / "Obsidian" / "obsidian.json")
    else:
        candidates.append(HOME / ".config" / "obsidian" / "obsidian.json")
        # Snap/Flatpak
        candidates.append(HOME / "snap" / "obsidian" / "current" / ".config" / "obsidian" / "obsidian.json")

    for config_path in candidates:
        if not config_path.exists():
            continue
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
            vaults = data.get("vaults", {})
            for vault_info in vaults.values():
                vault_path = vault_info.get("path")
                if vault_path and Path(vault_path).exists():
                    return Path(vault_path)
        except Exception:
            continue
    return None


def _tool_root_paths() -> dict[str, Path]:
    """Default tool paths per platform. All tools use ~/.toolname on Unix,
    and %APPDATA%/.toolname or %LOCALAPPDATA%/toolname on Windows."""
    if SYSTEM == "Windows":
        appdata = Path(os.environ.get("APPDATA", str(HOME / "AppData" / "Roaming")))
        localappdata = Path(os.environ.get("LOCALAPPDATA", str(HOME / "AppData" / "Local")))
        return {
            "claude_code": HOME / ".claude",          # Claude Code uses ~/.claude on all platforms
            "openclaw": HOME / ".openclaw",
            "codex": HOME / ".codex",
            "antigravity": HOME / ".antigravity",
            "cursor": HOME / ".cursor",
            "windsurf": HOME / ".windsurf",
            "vscode": HOME / ".vscode",
        }
    else:
        return {
            "claude_code": HOME / ".claude",
            "openclaw": HOME / ".openclaw",
            "codex": HOME / ".codex",
            "antigravity": HOME / ".antigravity",
            "cursor": HOME / ".cursor",
            "windsurf": HOME / ".windsurf",
            "vscode": HOME / ".vscode",
        }


# ---------------------------------------------------------------------------
# Device identity
# ---------------------------------------------------------------------------

def _get_device_id() -> str:
    """Persistent device ID. Generated once, stored in data dir."""
    data_dir = _default_data_dir()
    id_file = data_dir / "device_id"
    if id_file.exists():
        return id_file.read_text().strip()
    data_dir.mkdir(parents=True, exist_ok=True)
    device_id = str(uuid.uuid4())
    id_file.write_text(device_id)
    return device_id


def _get_device_name() -> str:
    """Human-readable device name: hostname + OS."""
    return f"{socket.gethostname()} ({SYSTEM})"


# ---------------------------------------------------------------------------
# Config classes
# ---------------------------------------------------------------------------

class ServerConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MEMENTO_SERVER_")

    url: str = "http://localhost:8001"
    token: str = ""
    timeout: int = 30
    max_retries: int = 5


class CollectorConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MEMENTO_")

    # Server
    server: ServerConfig = Field(default_factory=ServerConfig)

    # Device
    device_id: str = Field(default_factory=_get_device_id)
    device_name: str = Field(default_factory=_get_device_name)
    platform: str = SYSTEM

    # Local queue
    queue_db_path: Path = Field(default_factory=lambda: _default_data_dir() / "sync_queue.db")
    state_db_path: Path = Field(default_factory=lambda: _default_data_dir() / "collector_state.db")
    config_path: Path = Field(default_factory=lambda: _default_data_dir() / "config.json")
    log_dir: Path = Field(default_factory=_default_log_dir)

    # Watcher
    debounce_seconds: float = 0.3
    sqlite_poll_interval: int = 60  # seconds

    # Sync
    large_file_threshold: int = 1_048_576  # 1 MB
    batch_size: int = 20
    sync_interval: float = 0.5  # seconds between sync cycles when queue empty

    # Obsidian vault path (user-configurable, auto-discovered)
    obsidian_vault_path: Path = Field(default_factory=_default_obsidian_path)

    def ensure_dirs(self) -> None:
        self.queue_db_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_db_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)


TOOL_PATHS = _tool_root_paths()
