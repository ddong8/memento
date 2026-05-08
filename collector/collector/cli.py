"""Collector CLI — cross-platform install/setup/start/stop/status."""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from .config import CollectorConfig, SYSTEM, _default_data_dir

PLIST_NAME = "com.memento.collector"
SYSTEMD_UNIT = "memento-collector"
WIN_TASK_NAME = "MementoCollector"
# Legacy labels kept only for migration — uninstall touches both so upgrades
# don't end up with duplicate services running under the old branding.
_LEGACY_PLIST_NAME = "com.dailyreport.collector"
_LEGACY_SYSTEMD_UNIT = "daily-report-collector"
# Windows task name *before* rebrand. Keep this as the old string so
# install/uninstall flow tries to clean it up on upgrade.
_LEGACY_WIN_TASK_NAME = "DailyReportCollector"
_LEGACY_DATA_DIR = Path.home() / ".daily-report"


def _uninstall_legacy_pip_packages() -> None:
    """Quietly pip-uninstall the pre-rebrand daily-report-* packages if they
    are still installed. Leaves memento-brain-* alone. Without this, both the
    new and old modules can coexist in site-packages and `import collector`
    resolves to whichever comes first on sys.path — usually the old one, so
    setup ends up running pre-rebrand code even after upgrading.
    """
    for pkg in ("daily-report-collector", "daily-report-memory"):
        try:
            r = subprocess.run(
                [sys.executable, "-m", "pip", "show", pkg],
                capture_output=True, text=True,
            )
            if r.returncode != 0:
                continue
            print(f"Uninstalling legacy package: {pkg}")
            subprocess.run(
                [sys.executable, "-m", "pip", "uninstall", "-y", pkg],
                capture_output=True,
            )
        except Exception:
            pass  # best-effort; not worth aborting setup for


def _migrate_legacy_data_dir() -> None:
    """Pre-rebrand users had config + queue databases under ~/.daily-report.
    Copy anything still there into ~/.memento on first setup, so upgrading
    from the 0.0.1 PyPI wheel doesn't leave them with a silently-dead old
    config path (the one in their screenshot) while the new binary writes
    elsewhere.
    """
    if not _LEGACY_DATA_DIR.exists():
        return
    new_dir = _default_data_dir()
    new_dir.mkdir(parents=True, exist_ok=True)
    moved = []
    for item in _LEGACY_DATA_DIR.iterdir():
        target = new_dir / item.name
        if target.exists():
            continue  # don't clobber a freshly-written new-path file
        shutil.move(str(item), str(target))
        moved.append(item.name)
    if moved:
        print(f"Migrated {len(moved)} item(s) from {_LEGACY_DATA_DIR} → {new_dir}: {', '.join(moved)}")
    # Leave the (now-empty) old dir rather than rmdir-ing, in case the user
    # wants to check that nothing was lost.


# ---------------------------------------------------------------------------
# Setup wizard (interactive, cross-platform)
# ---------------------------------------------------------------------------

def setup() -> None:
    """Interactive setup: configure server URL, register device, install service.

    Honors env vars for non-interactive / scripted installs:
      MEMENTO_NONINTERACTIVE=1      skip all prompts, auto-answer yes
      MEMENTO_SERVER_URL=...        override server URL prompt
      MEMENTO_SERVER_TOKEN=...      override collector token prompt
      MEMENTO_OBSIDIAN_VAULT=...    skip vault discovery, use this path ('' to skip)
    """
    noninteractive = os.environ.get("MEMENTO_NONINTERACTIVE") == "1"
    _migrate_legacy_data_dir()  # ~/.daily-report → ~/.memento for upgraders
    _uninstall_legacy_pip_packages()  # purge pre-rebrand daily-report-* packages
    config = CollectorConfig()
    config.ensure_dirs()
    config_path = _default_data_dir() / "config.json"

    print("=== Memento Collector Setup ===\n")
    print(f"Platform: {SYSTEM}")
    print(f"Device:   {config.device_name}")
    print(f"ID:       {config.device_id}\n")

    def _ask(prompt: str, default: str = "") -> str:
        if noninteractive:
            return default
        return input(prompt).strip() or default

    # Server URL
    default_url = os.environ.get("MEMENTO_SERVER_URL") or config.server.url
    url = _ask(f"Server URL [{default_url}]: ", default_url)

    # Collector token
    default_token = os.environ.get("MEMENTO_SERVER_TOKEN") or config.server.token or "collector-dev-token"
    token = _ask(f"Collector token [{default_token}]: ", default_token)

    # Obsidian vault
    if "MEMENTO_OBSIDIAN_VAULT" in os.environ:
        vault = os.environ["MEMENTO_OBSIDIAN_VAULT"] or None
    else:
        vault = _discover_obsidian_vault()
        if vault:
            print(f"\nFound Obsidian vault: {vault}")
            use = "y" if noninteractive else input("Use this vault? [Y/n]: ").strip().lower()
            if use and use != "y":
                vault = _ask("Obsidian vault path (or empty to skip): ") or None
        elif not noninteractive:
            vault = input("Obsidian vault path (or empty to skip): ").strip() or None

    # Save config
    cfg = {
        "server_url": url,
        "server_token": token,
        "device_id": config.device_id,
        "device_name": config.device_name,
        "obsidian_vault_path": str(vault) if vault else None,
    }
    config_path.write_text(json.dumps(cfg, indent=2))
    print(f"\nConfig saved to {config_path}")

    # Register device with server
    print(f"\nRegistering device with {url}...")
    try:
        import httpx
        resp = httpx.post(
            f"{url}/api/ingest/heartbeat",
            headers={
                "X-Collector-Token": token,
                "X-Device-Id": config.device_id,
                "X-Device-Name": config.device_name,
                "X-Device-Platform": config.platform,
            },
            timeout=10,
        )
        if resp.status_code == 200:
            print("Device registered successfully!")
        else:
            print(f"Warning: server returned {resp.status_code} (collector may still work)")
    except Exception as e:
        print(f"Warning: could not reach server ({e}). You can start the collector later.")

    # === MCP Memory Server 配置 ===
    print("\n--- MCP Memory Server ---")
    if noninteractive:
        do_mcp = "y"
    else:
        do_mcp = input("Configure AI memory for Claude Code / Cursor? [Y/n]: ").strip().lower()
    if not do_mcp or do_mcp == "y":
        _setup_mcp(url, token)

    # Offer to install as service
    print()
    if noninteractive:
        do_install = "y"
    else:
        do_install = input("Install as system service (auto-start on boot)? [Y/n]: ").strip().lower()
    if not do_install or do_install == "y":
        install()

    print("\nSetup complete! Run 'memento-collector start' to begin collecting.")


def _discover_obsidian_vault() -> str | None:
    """Find Obsidian vault — first from obsidian.json config, then scan common paths."""
    # Method 1: Read Obsidian's own config (most reliable)
    from .config import _discover_obsidian_vault_from_config
    vault = _discover_obsidian_vault_from_config()
    if vault:
        return str(vault)

    # Method 2: Scan common directories
    home = Path.home()
    if SYSTEM == "Darwin":
        candidates = [home / "Documents" / "Obsidian"]
    elif SYSTEM == "Windows":
        candidates = [
            home / "Documents" / "Obsidian",
            home / "OneDrive" / "Documents" / "Obsidian",
            Path(os.environ.get("USERPROFILE", str(home))) / "Documents" / "Obsidian",
        ]
    else:
        candidates = [
            home / "Documents" / "Obsidian",
            home / "obsidian",
            home / "Obsidian",
            home / ".local" / "share" / "obsidian-vaults",
            home / "Dropbox" / "Obsidian",
            home / "snap" / "obsidian" / "common",
        ]

    for c in candidates:
        if c.exists() and c.is_dir():
            for item in c.iterdir():
                if item.is_dir() and (item / ".obsidian").exists():
                    return str(item)
            return str(c)
    return None


# ---------------------------------------------------------------------------
# MCP Memory Server auto-configuration
# ---------------------------------------------------------------------------

def _setup_mcp(server_url: str, token: str) -> None:
    """Install MCP server package and configure all AI IDEs."""
    # 1. Install memento-memory if not available
    try:
        __import__("mcp_server")
        print("  MCP server package: already installed")
    except ImportError:
        print("  Installing memento-memory...")
        pip_cmd = [sys.executable, "-m", "pip", "install", "memento-brain-memory", "--quiet"]
        if SYSTEM == "Windows":
            pip_cmd.insert(-1, "--user")  # Avoid permission issues on Windows
        result = subprocess.run(pip_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  Warning: install failed ({result.stderr[:100]}). You can install manually later.")
            print(f"    pip install memento-brain-memory")
            return
        print("  memento-memory installed")

    # Use forward slashes even on Windows (JSON/TOML compatibility)
    python_path = sys.executable.replace("\\", "/")
    mcp_entry = {
        "command": python_path,
        "args": ["-m", "mcp_server", "--server", server_url, "--token", token],
    }
    home = Path.home()

    # --- Claude Code (use `claude mcp add` command if available) ---
    claude_cmd = shutil.which("claude")
    if claude_cmd:
        result = subprocess.run(
            [claude_cmd, "mcp", "add", "memento-memory", "--",
             python_path, "-m", "mcp_server", "--server", server_url, "--token", token],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            print(f"  Claude Code: ✅ configured (via claude mcp add)")
        else:
            # Fallback: write to ~/.claude.json
            if _inject_mcp_json(home / ".claude.json", mcp_entry):
                print(f"  Claude Code: ✅ configured (via .claude.json)")
            else:
                print(f"  Claude Code: skipped")
    else:
        # Claude Code CLI not found, try .claude.json
        if _inject_mcp_json(home / ".claude.json", mcp_entry):
            print(f"  Claude Code: ✅ configured (via .claude.json)")
        else:
            print(f"  Claude Code: not installed")

    # --- Cursor (~/.cursor/mcp.json) ---
    cursor_dir = home / ".cursor"
    if cursor_dir.exists():
        if _inject_mcp_json(cursor_dir / "mcp.json", mcp_entry):
            print(f"  Cursor: ✅ configured")
        else:
            print(f"  Cursor: skipped")
    else:
        print("  Cursor: not installed")

    # --- Windsurf (~/.codeium/windsurf/mcp_config.json) ---
    windsurf_dir = home / ".codeium" / "windsurf"
    if windsurf_dir.exists():
        if _inject_mcp_json(windsurf_dir / "mcp_config.json", mcp_entry):
            print(f"  Windsurf: ✅ configured")
        else:
            print(f"  Windsurf: skipped")
    else:
        print("  Windsurf: not installed")

    # --- Antigravity (~/.gemini/antigravity/mcp_config.json) ---
    ag_dir = home / ".gemini" / "antigravity"
    if ag_dir.exists():
        if _inject_mcp_json(ag_dir / "mcp_config.json", mcp_entry):
            print(f"  Antigravity: ✅ configured")
        else:
            print(f"  Antigravity: skipped")
    else:
        print("  Antigravity: not installed")

    # --- Codex (~/.codex/config.toml) — TOML format ---
    codex_dir = home / ".codex"
    if codex_dir.exists():
        if _inject_codex_mcp(codex_dir / "config.toml", python_path, server_url, token):
            print(f"  Codex: ✅ configured")
        else:
            print(f"  Codex: skipped")
    else:
        print("  Codex: not installed")

    # --- OpenClaw (~/.openclaw/openclaw.json) ---
    # OpenClaw uses its own schema under `mcp.servers.<name>` and rejects a
    # top-level `mcpServers` key as "Unrecognized". Always use the official
    # `openclaw mcp set` CLI — it validates + writes to the right path. Also
    # strip any legacy top-level mcpServers we (or an even older version) may
    # have written in the past, which would brick `openclaw gateway start`.
    openclaw_json = home / ".openclaw" / "openclaw.json"
    if openclaw_json.parent.exists():
        # Defensive cleanup: prior versions of this setup wrote to the wrong key.
        if openclaw_json.exists():
            try:
                d = json.loads(openclaw_json.read_text(encoding="utf-8"))
                if "mcpServers" in d:
                    del d["mcpServers"]
                    openclaw_json.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
                    print("  OpenClaw: cleaned legacy mcpServers key")
            except Exception:
                pass

        openclaw_cmd = shutil.which("openclaw")
        if openclaw_cmd:
            entry_json = json.dumps(mcp_entry)
            r = subprocess.run(
                [openclaw_cmd, "mcp", "set", "memento-memory", entry_json],
                capture_output=True, text=True,
            )
            if r.returncode == 0:
                print("  OpenClaw: ✅ configured (via openclaw mcp set)")
            else:
                print(f"  OpenClaw: skipped ({r.stderr.strip()[:120]})")
        else:
            print("  OpenClaw: CLI not in PATH — install with `npm i -g openclaw` then rerun setup")
    else:
        print("  OpenClaw: not installed")

    print("\n  ✅ MCP Memory Server ready — restart your AI IDE to activate")


def _inject_mcp_json(config_path: Path, mcp_entry: dict) -> bool:
    """Inject memento-memory into a JSON config file under mcpServers key.

    Merges with existing content (does not overwrite other settings). Also
    purges pre-rebrand leftover entries (daily-report-memory, any entry whose
    command/args reference the old daily_report_memory Python module) so a
    fresh setup on an upgraded machine ends with exactly one memento-memory
    entry instead of two competing MCP servers.
    """
    try:
        existing = {}
        if config_path.exists():
            text = config_path.read_text(encoding="utf-8").strip()
            if text:
                existing = json.loads(text)

        if "mcpServers" not in existing:
            existing["mcpServers"] = {}

        # Purge legacy entries before writing the new one.
        servers = existing["mcpServers"]
        for key in list(servers.keys()):
            if key in ("daily-report-memory", "dr-memory"):
                del servers[key]
                continue
            entry = servers.get(key) or {}
            blob = json.dumps(entry)
            if "daily_report_memory" in blob or "daily-report-memory" in blob:
                del servers[key]

        servers["memento-memory"] = mcp_entry

        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
        return True
    except Exception:
        return False


def _inject_codex_mcp(config_path: Path, python_path: str, server_url: str, token: str) -> bool:
    """Inject memento-memory into Codex config.toml.

    Codex uses TOML format:
    [mcp_servers.memento-memory]
    command = "/path/to/python"
    args = ["-m", "mcp_server", "--server", "https://...", "--token", "xxx"]
    """
    try:
        content = ""
        if config_path.exists():
            content = config_path.read_text(encoding="utf-8")

        # Remove any memento-memory or legacy daily-report-memory block. We
        # always rewrite from scratch so setup is idempotent + stale pre-rebrand
        # entries don't linger alongside the new one.
        import re
        for legacy_key in ("memento-memory", "daily-report-memory", "dr-memory"):
            content = re.sub(
                r'\[mcp_servers\.' + re.escape(legacy_key) + r'\].*?(?=\n\[|\Z)',
                '', content, flags=re.DOTALL,
            )
        content = content.strip()

        # Append new entry
        args_toml = json.dumps(["-m", "mcp_server", "--server", server_url, "--token", token])
        entry = (
            f'\n\n[mcp_servers.memento-memory]\n'
            f'command = "{python_path}"\n'
            f'args = {args_toml}\n'
        )
        content = content.rstrip() + entry

        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(content, encoding="utf-8")
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Service installation (platform-specific)
# ---------------------------------------------------------------------------

def install() -> None:
    """Install as a system service (auto-start on boot)."""
    if SYSTEM == "Darwin":
        _install_launchd()
    elif SYSTEM == "Linux":
        _install_systemd()
    elif SYSTEM == "Windows":
        _install_windows_task()
    else:
        print(f"Unsupported platform: {SYSTEM}. Run manually with 'memento-collector run'")


def uninstall() -> None:
    """Remove the system service."""
    if SYSTEM == "Darwin":
        _uninstall_launchd()
    elif SYSTEM == "Linux":
        _uninstall_systemd()
    elif SYSTEM == "Windows":
        _uninstall_windows_task()


# --- macOS (launchd) ---

def _install_launchd() -> None:
    agents_dir = Path.home() / "Library" / "LaunchAgents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    # Migrate: unload + delete legacy com.dailyreport.collector plist if present.
    legacy = agents_dir / f"{_LEGACY_PLIST_NAME}.plist"
    if legacy.exists():
        subprocess.run(["launchctl", "unload", str(legacy)], capture_output=True)
        legacy.unlink()
        print(f"Migrated: removed legacy {legacy.name}")
    plist_path = agents_dir / f"{PLIST_NAME}.plist"

    exe = shutil.which("memento-collector") or sys.executable
    config = CollectorConfig()

    plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe}</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{config.log_dir / "launchd_stdout.log"}</string>
    <key>StandardErrorPath</key>
    <string>{config.log_dir / "launchd_stderr.log"}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>"""
    plist_path.write_text(plist_content)
    print(f"Installed: {plist_path}")


def _uninstall_launchd() -> None:
    stop()
    agents_dir = Path.home() / "Library" / "LaunchAgents"
    for name in (PLIST_NAME, _LEGACY_PLIST_NAME):
        plist_path = agents_dir / f"{name}.plist"
        if plist_path.exists():
            subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True)
            plist_path.unlink()
    print("Uninstalled.")


# --- Linux (systemd user service) ---

def _install_systemd() -> None:
    unit_dir = Path.home() / ".config" / "systemd" / "user"
    unit_dir.mkdir(parents=True, exist_ok=True)
    # Migrate: disable + remove legacy memento-collector unit if present.
    legacy = unit_dir / f"{_LEGACY_SYSTEMD_UNIT}.service"
    if legacy.exists():
        subprocess.run(["systemctl", "--user", "disable", "--now", _LEGACY_SYSTEMD_UNIT],
                       capture_output=True)
        legacy.unlink()
        print(f"Migrated: removed legacy {legacy.name}")
    unit_path = unit_dir / f"{SYSTEMD_UNIT}.service"

    exe = shutil.which("memento-collector") or sys.executable

    unit_content = f"""[Unit]
Description=Memento Collector
After=network.target

[Service]
Type=simple
ExecStart={exe} run
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=PATH={os.environ.get('PATH', '/usr/local/bin:/usr/bin')}

[Install]
WantedBy=default.target
"""
    unit_path.write_text(unit_content)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    subprocess.run(["systemctl", "--user", "enable", SYSTEMD_UNIT], check=False)
    print(f"Installed: {unit_path}")
    print("Run 'memento-collector start' to start.")


def _uninstall_systemd() -> None:
    stop()
    unit_dir = Path.home() / ".config" / "systemd" / "user"
    for name in (SYSTEMD_UNIT, _LEGACY_SYSTEMD_UNIT):
        unit_path = unit_dir / f"{name}.service"
        subprocess.run(["systemctl", "--user", "disable", "--now", name], capture_output=True)
        if unit_path.exists():
            unit_path.unlink()
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    print("Uninstalled.")


# --- Windows (Task Scheduler) ---

# XML task definition. The shorthand `schtasks /Create ... /SC ONLOGON` we
# used before inherits Task Scheduler's defaults, several of which kill
# long-running daemons:
#   - ExecutionTimeLimit = PT72H  → Windows force-stops the task after 3 days
#   - StopIfGoingOnBatteries = true / DisallowStartIfOnBatteries = true
#                                  → laptops on battery silently never run it
#   - No RestartOnFailure          → a single crash leaves it dead until reboot
# The XML form below mirrors the embedding-server task in scripts/templates/
# and explicitly disables those, plus sets RestartOnFailure so an unhandled
# exception (or the post-upgrade exit-1, see main.py) brings the daemon back
# within 1 minute. Encoded UTF-16 LE w/ BOM as Task Scheduler requires.
_WIN_TASK_XML = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Memento Collector — watches AI tool data dirs and syncs to server</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{pythonw}</Command>
      <Arguments>-m collector.main</Arguments>
    </Exec>
  </Actions>
</Task>
"""


def _install_windows_task() -> None:
    import tempfile

    task_name = WIN_TASK_NAME
    # Migrate: delete legacy DailyReportCollector task if present.
    subprocess.run(
        ["schtasks", "/Delete", "/TN", _LEGACY_WIN_TASK_NAME, "/F"],
        capture_output=True,
    )
    # Also delete any pre-XML version of MementoCollector so the new XML
    # definition cleanly takes over (otherwise /Create /XML can fail with
    # "task already exists" on some Windows builds even with /F).
    subprocess.run(
        ["schtasks", "/Delete", "/TN", task_name, "/F"],
        capture_output=True,
    )

    # Use pythonw.exe (no console window) to run the collector module directly.
    pythonw = Path(sys.executable).parent / "pythonw.exe"
    if not pythonw.exists():
        pythonw = Path(sys.executable).parent / "Scripts" / "pythonw.exe"
    if not pythonw.exists():
        pythonw = Path(sys.executable)
        print(f"Warning: pythonw.exe not found, using {pythonw} (may show console window)")

    xml_body = _WIN_TASK_XML.format(pythonw=str(pythonw))
    # schtasks /XML requires UTF-16 LE with BOM. Tempfile write + delete after.
    with tempfile.NamedTemporaryFile(
        mode="wb", suffix=".xml", delete=False,
    ) as f:
        f.write(b"\xff\xfe")  # UTF-16 LE BOM
        f.write(xml_body.encode("utf-16-le"))
        xml_path = f.name

    try:
        cmd = ["schtasks", "/Create", "/F", "/TN", task_name, "/XML", xml_path]
        result = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        try:
            os.unlink(xml_path)
        except OSError:
            pass

    if result.returncode == 0:
        print(f"Installed Windows scheduled task: {task_name}")
        print(f"  Command: {pythonw} -m collector.main")
        print(f"  Settings: no time limit, restart-on-failure (1m × 999),")
        print(f"            ignore battery state.")
    else:
        stderr = (result.stderr or "").strip()
        print(f"Failed to install: {stderr}")
        print()
        print("This usually means schtasks needs admin privileges (UAC).")
        print("Two ways forward:")
        print("  1. Run PowerShell as Administrator, then rerun: memento-collector setup")
        print(f"  2. Skip auto-start — run manually whenever you want to sync:")
        print(f"       memento-collector start")
        print(f"     Or directly:  \"{pythonw}\" -m collector.main")


def _uninstall_windows_task() -> None:
    stop()
    ok = False
    for name in (WIN_TASK_NAME, _LEGACY_WIN_TASK_NAME):
        r = subprocess.run(
            ["schtasks", "/Delete", "/TN", name, "/F"],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            ok = True
    print("Uninstalled." if ok else "Not installed.")


# ---------------------------------------------------------------------------
# Start / Stop / Status (cross-platform)
# ---------------------------------------------------------------------------

def start() -> None:
    """Start the collector service."""
    if SYSTEM == "Darwin":
        plist = Path.home() / "Library" / "LaunchAgents" / f"{PLIST_NAME}.plist"
        if not plist.exists():
            print("Not installed. Run 'memento-collector setup' first.")
            return
        r = subprocess.run(["launchctl", "load", str(plist)], capture_output=True, text=True)
        print("Started." if r.returncode == 0 else f"Failed: {r.stderr.strip()}")

    elif SYSTEM == "Linux":
        r = subprocess.run(["systemctl", "--user", "start", SYSTEMD_UNIT], capture_output=True, text=True)
        print("Started." if r.returncode == 0 else f"Failed: {r.stderr.strip()}")

    elif SYSTEM == "Windows":
        r = subprocess.run(
            ["schtasks", "/Run", "/TN", WIN_TASK_NAME],
            capture_output=True, text=True,
        )
        print("Started." if r.returncode == 0 else f"Failed: {r.stderr.strip()}")


def stop() -> None:
    """Stop the collector service."""
    if SYSTEM == "Darwin":
        plist = Path.home() / "Library" / "LaunchAgents" / f"{PLIST_NAME}.plist"
        subprocess.run(["launchctl", "unload", str(plist)], capture_output=True)
        print("Stopped.")

    elif SYSTEM == "Linux":
        subprocess.run(["systemctl", "--user", "stop", SYSTEMD_UNIT], capture_output=True)
        print("Stopped.")

    elif SYSTEM == "Windows":
        subprocess.run(
            ["schtasks", "/End", "/TN", WIN_TASK_NAME],
            capture_output=True,
        )
        print("Stopped.")


def status() -> None:
    """Check collector status."""
    config = CollectorConfig()
    print(f"Platform:  {SYSTEM}")
    print(f"Device:    {config.device_name}")
    print(f"Device ID: {config.device_id}")
    print(f"Server:    {config.server.url}")
    print()

    if SYSTEM == "Darwin":
        r = subprocess.run(["launchctl", "list"], capture_output=True, text=True)
        if PLIST_NAME in r.stdout:
            for line in r.stdout.splitlines():
                if PLIST_NAME in line:
                    parts = line.split()
                    pid = parts[0] if parts[0] != "-" else "not running"
                    print(f"Service: loaded (PID={pid})")
                    break
        else:
            print("Service: not loaded")

    elif SYSTEM == "Linux":
        r = subprocess.run(
            ["systemctl", "--user", "is-active", SYSTEMD_UNIT],
            capture_output=True, text=True,
        )
        print(f"Service: {r.stdout.strip()}")

    elif SYSTEM == "Windows":
        r = subprocess.run(
            ["schtasks", "/Query", "/TN", WIN_TASK_NAME, "/FO", "LIST"],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            for line in r.stdout.splitlines():
                if "Status" in line:
                    print(f"Service: {line.split(':')[-1].strip()}")
                    break
        else:
            print("Service: not installed")

    # Check connectivity
    print()
    try:
        import httpx
        resp = httpx.get(f"{config.server.url}/api/ingest/status", timeout=5)
        print(f"Server:  connected ({resp.status_code})")
    except Exception:
        print("Server:  unreachable")

    # Recent log
    log_file = config.log_dir / "collector.log"
    if log_file.exists():
        lines = log_file.read_text().splitlines()
        if lines:
            print(f"\nLast log: {lines[-1]}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def cli_main() -> None:
    """CLI entry point."""
    if len(sys.argv) < 2:
        # No args = run in foreground
        from .main import main
        main()
        return

    cmd = sys.argv[1]
    commands = {
        "setup": setup,
        "install": install,
        "uninstall": uninstall,
        "start": start,
        "stop": stop,
        "status": status,
        "run": lambda: __import__("collector.main", fromlist=["main"]).main(),
    }

    if cmd in commands:
        commands[cmd]()
    elif cmd in ("-h", "--help", "help"):
        print("Memento Collector\n")
        print("Usage: memento-collector [command]\n")
        print("Commands:")
        print("  setup      Interactive setup wizard (first time)")
        print("  install    Install as system service")
        print("  uninstall  Remove system service")
        print("  start      Start the service")
        print("  stop       Stop the service")
        print("  status     Show collector status")
        print("  run        Run in foreground (default)")
        print("  help       Show this help")
    else:
        print(f"Unknown command: {cmd}")
        print("Run 'memento-collector help' for usage.")
        sys.exit(1)
