"""Install + configure the local collector against the freshly-started server.

Also provides `deep_uninstall()` for `./install.sh uninstall --all`:
stops service, pip-uninstalls packages, removes ~/.memento config,
logs, and cleans MCP server entries from ~/.claude.json, Cursor, Codex, etc.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from .platform_utils import (
    IS_LINUX, IS_MAC, IS_WINDOWS, REPO_ROOT, find_python, info, ok, warn, which,
)


def install_collector(token: str, server_url: str = "http://localhost:8001",
                      dev: bool = False) -> None:
    """pip install memento-brain-collector, then run non-interactive setup."""
    py = find_python()

    # Check if already installed
    if which("memento-collector") is None:
        info("Installing memento-collector via pip…")
        cmd = [py, "-m", "pip", "install", "--user"]
        if dev:
            cmd += ["-e", str(REPO_ROOT / "collector")]
        else:
            cmd.append("memento-brain-collector")
        subprocess.run(cmd, check=True)
    else:
        ok("memento-collector already installed.")

    # Non-interactive setup — honored by the cli via MEMENTO_NONINTERACTIVE=1
    env = os.environ.copy()
    env["MEMENTO_SERVER_URL"] = server_url
    env["MEMENTO_SERVER_TOKEN"] = token
    env["MEMENTO_NONINTERACTIVE"] = "1"
    info(f"Configuring collector → {server_url}…")
    subprocess.run(
        ["memento-collector", "setup"],
        env=env, check=True,
    )
    ok("Collector set up and installed as a background service.")


# ─────────────────────────────────────────────────────────────
# Deep uninstall
# ─────────────────────────────────────────────────────────────

# Old MCP key (pre-rebrand) + new one — clean both on uninstall
_MCP_KEYS = ("memento-memory", "daily-report-memory")


def _remove_mcp_entry(config_path: Path) -> None:
    """Strip memento-memory / daily-report-memory entries from a JSON MCP config."""
    if not config_path.exists():
        return
    try:
        data = json.loads(config_path.read_text())
    except Exception:
        return
    changed = False
    if isinstance(data, dict) and isinstance(data.get("mcpServers"), dict):
        for key in _MCP_KEYS:
            if key in data["mcpServers"]:
                del data["mcpServers"][key]
                changed = True
                ok(f"Removed '{key}' from {config_path.name}")
    if changed:
        config_path.write_text(json.dumps(data, indent=2))


def _remove_codex_mcp(config_path: Path) -> None:
    """Strip [mcp_servers.memento-memory] / [mcp_servers.daily-report-memory] from Codex TOML."""
    if not config_path.exists():
        return
    text = config_path.read_text()
    for key in _MCP_KEYS:
        header = f"[mcp_servers.{key}]"
        if header not in text:
            continue
        # Remove the header line through the next blank line or next [section]
        lines = text.splitlines(keepends=True)
        out: list[str] = []
        skipping = False
        for line in lines:
            stripped = line.strip()
            if stripped == header:
                skipping = True
                continue
            if skipping:
                if stripped.startswith("[") and stripped.endswith("]"):
                    skipping = False
                    out.append(line)
                elif stripped == "":
                    skipping = False
            else:
                out.append(line)
        text = "".join(out)
        ok(f"Removed codex mcp entry '{key}' from {config_path.name}")
    config_path.write_text(text)


def _pip_uninstall(package: str) -> None:
    try:
        py = find_python()
    except Exception:
        return
    r = subprocess.run(
        [py, "-m", "pip", "show", package],
        capture_output=True,
    )
    if r.returncode != 0:
        return  # not installed
    subprocess.run(
        [py, "-m", "pip", "uninstall", "-y", package],
        check=False,
    )
    ok(f"pip uninstalled {package}")


def deep_uninstall() -> None:
    """Everything collector-side: service, pip packages, config, logs, MCP entries."""
    # Stop the collector service first (ignore errors if absent). Try new name, then legacy.
    for cmd in ("memento-collector", "daily-report-collector"):
        if which(cmd):
            info(f"Stopping collector service ({cmd})…")
            subprocess.run([cmd, "uninstall"], check=False)

    # pip uninstall all name variants (new brand + transitional + legacy)
    info("Uninstalling pip packages…")
    for pkg in ("memento-brain-collector", "memento-brain-memory", "memento-brain",
                "memento-collector", "memento-memory",
                "daily-report-collector", "daily-report-memory"):
        _pip_uninstall(pkg)

    # Remove data dirs (new + legacy)
    for d in (Path.home() / ".memento", Path.home() / ".daily-report"):
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            ok(f"Removed {d}/")

    # Remove collector logs (new + legacy paths)
    log_candidates: list[Path] = []
    if IS_MAC:
        log_candidates += [
            Path.home() / "Library" / "Logs" / "memento",
            Path.home() / "Library" / "Logs" / "daily_report",
        ]
    elif IS_LINUX:
        log_candidates += [
            Path.home() / ".local" / "share" / "memento" / "logs",
            Path.home() / ".local" / "share" / "daily_report" / "logs",
        ]
    elif IS_WINDOWS:
        local = Path(os.environ.get("LOCALAPPDATA", str(Path.home())))
        log_candidates += [
            local / "memento" / "logs",
            local / "daily_report" / "logs",
        ]
    for logs in log_candidates:
        if logs.exists():
            shutil.rmtree(logs, ignore_errors=True)
            ok(f"Removed logs {logs}/")

    # Strip MCP server entries from AI tool configs
    info("Cleaning MCP configs in AI tool configs…")
    home = Path.home()
    for p in [
        home / ".claude.json",
        home / ".cursor" / "mcp.json",
        home / ".config" / "windsurf" / "mcp.json",
        home / "Library" / "Application Support" / "antigravity" / "mcp.json",
    ]:
        _remove_mcp_entry(p)

    # Codex uses TOML
    _remove_codex_mcp(home / ".codex" / "config.toml")
