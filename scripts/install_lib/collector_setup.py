"""Set up this machine's collector against the freshly-started server.

The collector is the Node daemon in packages/daemon (the same one the Memento
Desktop app runs). With Node 20+ available it is built from this checkout and
installed as a login service (launchd / systemd / Windows Run key); otherwise
the device is configured and the desktop app picks it up when installed.

Also provides `deep_uninstall()` for `./install.sh uninstall --all` and
`./install.sh uninstall-collector`: stops the daemon service, removes the retired
pip collector if present, takes back what the daemon wrote into the AI tools
(profile block, Stop hook, synced skills, `agy` wrapper, project blueprints and
their git hooks), then ~/.memento, logs,
and MCP server entries from ~/.claude.json, Cursor, Codex, etc.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from .platform_utils import (
    IS_LINUX, IS_MAC, IS_WINDOWS, REPO_ROOT, find_python, info, ok, warn, which,
)

DESKTOP_RELEASES = "https://github.com/ddong8/memento/releases/latest"
DAEMON_CLI = REPO_ROOT / "packages" / "daemon" / "dist" / "cli.js"


def write_device_config(token: str, server_url: str, web_url: str) -> Path:
    """Merge server, web URL and token into ~/.memento/collector.json (keeps the device id)."""
    path = Path.home() / ".memento" / "collector.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data: dict = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
    data.update({"server_url": server_url, "web_url": web_url, "token": token})
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def _node_major() -> int | None:
    node = which("node")
    if not node:
        return None
    r = subprocess.run([node, "--version"], capture_output=True, text=True)
    m = re.match(r"v(\d+)", r.stdout.strip())
    return int(m.group(1)) if m else None


def _npm(*args: str) -> None:
    npm = which("npm")
    if not npm:
        raise RuntimeError("npm not found")
    subprocess.run([npm, *args], check=True, cwd=str(REPO_ROOT), shell=IS_WINDOWS)


def build_daemon() -> None:
    """Install the daemon's dependencies and compile it (idempotent; used by update too)."""
    _npm("ci", "--workspace", "@memento/daemon", "--workspace", "@memento/core", "--include-workspace-root")
    _npm("run", "build", "-w", "@memento/daemon")


def install_collector(token: str, server_url: str = "http://localhost:8001",
                      web_url: str = "http://localhost:3001") -> None:
    """Configure this device and run the Node daemon as a login service when Node is available."""
    cfg = write_device_config(token, server_url, web_url)
    ok(f"Device configured → {server_url} ({cfg})")

    major = _node_major()
    if major is None or major < 20:
        warn("Node.js 20+ not found, so the collector wasn't installed as a service.")
        info(f"Install Memento ({DESKTOP_RELEASES}); it reads {cfg} and signs in on its own.")
        info("Or install Node.js 20+ and run `./install.sh update` to set up the headless collector.")
        return

    info("Building the collector daemon…")
    build_daemon()
    node = which("node") or "node"
    subprocess.run([node, str(DAEMON_CLI), "install-service"], check=True, cwd=str(REPO_ROOT))
    ok("Collector daemon installed as a background service.")
    info("If the Memento app is also running, only one of them collects (they share ~/.memento).")


def daemon_service_installed() -> bool:
    return DAEMON_CLI.exists()


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
        config_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))


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


# What the daemon writes outside ~/.memento (packages/daemon/src/profile-inject.ts,
# guard-inject.ts, skill-inject.ts, antigravity.ts). Each is taken back only where it
# is still exactly Memento's: text outside the markers, other hooks and skills the
# user edited stay. Ownership is read from the state files in ~/.memento, so this
# runs before that directory goes.
_PROFILE_BEGIN = "<!-- memento:begin"
_PROFILE_END = "<!-- memento:end -->"
_PROFILE_BLOCK = re.compile(r"<!-- memento:begin[^>]*-->[\s\S]*?<!-- memento:end -->\n?")


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _drop_backup(path: Path) -> None:
    """The copy of `path` the daemon made before its first write."""
    bak = path.with_name(path.name + ".memento.bak")
    if bak.exists():
        bak.unlink()


def _profile_files(home: Path) -> dict[str, Path]:
    codex = Path(os.environ.get("CODEX_HOME") or home / ".codex")
    gemini = home / ".gemini"
    appdata = os.environ.get("APPDATA")
    if IS_WINDOWS and appdata and (Path(appdata) / ".gemini").exists():
        gemini = Path(appdata) / ".gemini"
    return {
        "claude_code": home / ".claude" / "CLAUDE.md",
        "codex": codex / "AGENTS.md",
        "antigravity": gemini / "GEMINI.md",
        "workbuddy": home / ".workbuddy" / "MEMORY.md",
        "openclaw": home / ".openclaw" / "workspace" / "USER.md",
        "hermes": home / ".hermes" / "SOUL.md",
    }


def _remove_profile_blocks(home: Path) -> None:
    state = _load_json(home / ".memento" / "profile_inject.json") or {}
    for tool, path in _profile_files(home).items():
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        begins, ends = text.count(_PROFILE_BEGIN), text.count(_PROFILE_END)
        if begins == 0 and ends == 0:
            _drop_backup(path)
            continue
        if begins != 1 or ends != 1 or not _PROFILE_BLOCK.search(text):
            warn(f"The Memento block in {path} is damaged; remove it by hand (backup: {path.name}.memento.bak).")
            continue
        rest = _PROFILE_BLOCK.sub("", text, count=1)
        if not rest.strip() and (state.get(tool) or {}).get("created"):
            path.unlink()
        else:
            path.write_text(rest.rstrip("\n") + "\n" if rest.strip() else "", encoding="utf-8")
        _drop_backup(path)
        ok(f"Removed the Memento profile block from {path}")


def _without_stop_hook(settings: dict, script: str) -> dict | None:
    """`settings` without the Stop hooks that run `script`; None when there are none."""
    hooks = settings.get("hooks") if isinstance(settings.get("hooks"), dict) else {}
    groups = hooks.get("Stop") if isinstance(hooks.get("Stop"), list) else []

    def ours(h) -> bool:
        return isinstance(h, dict) and isinstance(h.get("command"), str) and script in h["command"]

    kept, found = [], False
    for g in groups:
        entries = g.get("hooks") if isinstance(g, dict) else None
        if not isinstance(entries, list) or not any(ours(h) for h in entries):
            kept.append(g)
            continue
        found = True
        rest = [h for h in entries if not ours(h)]
        if rest:
            kept.append({**g, "hooks": rest})
    if not found:
        return None
    next_hooks = {k: v for k, v in hooks.items() if k != "Stop"}
    if kept:
        next_hooks["Stop"] = kept
    out = {k: v for k, v in settings.items() if k != "hooks"}
    if next_hooks:
        out["hooks"] = next_hooks
    return out


def _remove_stop_hooks(home: Path) -> None:
    script = str(home / ".memento" / "hooks" / "stop-check.sh")
    created = (_load_json(home / ".memento" / "guard_inject.json") or {}).get("created") or []
    for path in (
        Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude") / "settings.json",
        Path(os.environ.get("CODEX_HOME") or home / ".codex") / "hooks.json",
    ):
        settings = _load_json(path) if path.exists() else None
        if not isinstance(settings, dict):
            continue
        cleaned = _without_stop_hook(settings, script)
        if cleaned is not None:
            if not cleaned and str(path) in created:
                path.unlink()
            else:
                path.write_text(json.dumps(cleaned, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            ok(f"Removed the Memento Stop hook from {path}")
        _drop_backup(path)


def _remove_synced_skills(home: Path) -> None:
    state = _load_json(home / ".memento" / "skill_inject.json") or {}
    dirs = {
        "claude": home / ".claude" / "skills",
        "agents": home / ".agents" / "skills",
        "workbuddy": home / ".workbuddy" / "skills",
    }
    for key, owned in state.items():
        if key not in dirs or not isinstance(owned, dict):
            continue
        for name, mine in owned.items():
            skill = dirs[key] / name / "SKILL.md"
            if not skill.exists() or not isinstance(mine, dict):
                continue
            if hashlib.sha256(skill.read_bytes()).hexdigest() != mine.get("hash"):
                info(f"Kept {skill}: edited after Memento wrote it.")
                continue
            skill.unlink()
            if not any(skill.parent.iterdir()):
                skill.parent.rmdir()
            ok(f"Removed synced skill {skill.parent}")


def _remove_agy_wrapper(home: Path) -> None:
    script = home / ".gemini" / "antigravity" / "bin" / "agy_cli.py"
    if IS_WINDOWS:
        wrapper = home / "AppData" / "Local" / "agy" / "bin" / "agy.cmd"
        ours = f'@echo off\r\npython "{script}" %*\r\n'
    else:
        wrapper = home / ".local" / "bin" / "agy"
        ours = f'#!/bin/sh\nexec python3 "{script}" "$@"\n'
    if wrapper.exists() and wrapper.read_bytes().decode("utf-8", "replace") == ours:
        wrapper.unlink()
        ok(f"Removed {wrapper}")
    for f in (script, script.with_name(script.name + ".tmp")):
        if f.exists():
            f.unlink()
            ok(f"Removed {f}")
    for d in (script.parent, wrapper.parent, wrapper.parent.parent) if IS_WINDOWS else (script.parent,):
        if d.exists() and not any(d.iterdir()):
            d.rmdir()


def _blueprint_script_version(path: Path) -> int:
    try:
        m = re.search(r"^(?:(?:export\s+)?(?:const|let|var)\s+)?BLUEPRINT_SCRIPT_VERSION\s*=\s*(\d+)", path.read_text(encoding="utf-8"), re.M)
    except OSError:
        return -1
    return int(m.group(1)) if m else 0


def _remove_blueprints(home: Path) -> None:
    """The git hooks, HEAD markers, exclude lines, anchors and untracked PROJECT_BLUEPRINT.md the
    daemon set up in local repos (recorded in ~/.memento/blueprint_repos): the generator's own
    --uninstall-all, from whichever copy is newer (the daemon may have an OTA one). The generator
    is a Node script; the daemon leaves a `runtime` wrapper next to it that runs Memento's own Node."""
    scripts = home / ".memento" / "scripts"
    candidates = [scripts / "project_blueprint.mjs", REPO_ROOT / "scripts" / "project_blueprint.mjs"]
    script = max((c for c in candidates if c.is_file()), key=_blueprint_script_version, default=None)
    if script is None:
        return
    node = which("node")
    if node:
        cmd = [node, str(script)]
    elif (scripts / "runtime").is_file() and which("sh"):
        cmd = ["sh", str(scripts / "runtime"), str(script)]
    else:
        warn("Project blueprints not removed: no Node.js to run the generator's --uninstall-all")
        return
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
    res = subprocess.run(
        [*cmd, "--uninstall-all"],
        env=env, cwd=str(home), capture_output=True, text=True, timeout=300, check=False,
    )
    for line in (res.stdout or "").splitlines():
        if line.strip():
            ok(line.strip())
    if res.returncode != 0:
        warn(f"Project blueprints not fully removed: {(res.stderr or '').strip()[-300:]}")


def remove_injected(home: Path | None = None) -> None:
    """Take back what the daemon wrote into the AI tools' own files and the local repos."""
    home = home or Path.home()
    for remove in (_remove_profile_blocks, _remove_stop_hooks, _remove_synced_skills, _remove_agy_wrapper, _remove_blueprints):
        try:
            remove(home)
        except (OSError, subprocess.SubprocessError) as e:  # one unreadable file must not stop the rest
            warn(f"{remove.__name__}: {e}")


def uninstall_daemon_service() -> None:
    """Remove the Node daemon's login service, if this checkout installed one."""
    node = which("node")
    if node and DAEMON_CLI.exists():
        info("Removing the collector daemon service…")
        subprocess.run([node, str(DAEMON_CLI), "uninstall-service"], check=False, cwd=str(REPO_ROOT))


def deep_uninstall() -> None:
    """Everything collector-side: services, retired pip packages, what the daemon wrote into AI
    tools, config, logs, MCP entries."""
    uninstall_daemon_service()
    # The retired Python collector, if an older install left it behind.
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

    # Before ~/.memento goes: its state files say which of these are ours.
    info("Removing what Memento wrote into AI tools and repos (profile blocks, Stop hooks, skills, blueprints)…")
    remove_injected()

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
    if IS_MAC:
        app_config = home / "Library" / "Application Support"
    elif IS_WINDOWS:
        app_config = Path(os.environ.get("APPDATA", str(home)))
    else:
        app_config = home / ".config"
    for p in [
        home / ".claude.json",
        home / ".cursor" / "mcp.json",
        home / ".codeium" / "windsurf" / "mcp_config.json",
        home / ".config" / "windsurf" / "mcp.json",  # older Windsurf
        # Antigravity has kept it in each of these, depending on the version
        home / ".gemini" / "antigravity" / "mcp_config.json",
        home / ".gemini" / "config" / "mcp_config.json",
        app_config / "antigravity" / "mcp.json",
        home / ".gemini" / "settings.json",  # Gemini CLI
    ]:
        _remove_mcp_entry(p)

    # Codex uses TOML
    _remove_codex_mcp(home / ".codex" / "config.toml")
