"""Collector daemon — fully async, non-blocking on all platforms."""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading
import time

from .config import CollectorConfig, SYSTEM, _default_data_dir
from .queue import SyncQueue
from .sync_client import SyncClient
from .tools.antigravity import AntigravityTool
from .tools.claude_code import ClaudeCodeTool
from .tools.codex import CodexTool
from .tools.cursor import CursorTool
from .tools.hermes import HermesTool
from .tools.obsidian import ObsidianTool
from .tools.openclaw import OpenClawTool
from .watcher import FileWatcher

HEARTBEAT_INTERVAL = 30       # Log heartbeat every 30s
COMMAND_POLL_INTERVAL = 10    # Check server commands every 10s
AUTO_UPDATE_INTERVAL = 3600   # Check for updates every 1 hour
PACKAGE_NAME = "memento-brain-collector"
DISCOVERY_TIMEOUT = 10        # Discovery HTTP timeout


def _load_saved_config() -> CollectorConfig:
    config = CollectorConfig()
    saved_path = _default_data_dir() / "config.json"
    if saved_path.exists():
        try:
            saved = json.loads(saved_path.read_text())
            if saved.get("server_url"):
                os.environ.setdefault("MEMENTO_SERVER_URL", saved["server_url"])
            if saved.get("server_token"):
                os.environ.setdefault("MEMENTO_SERVER_TOKEN", saved["server_token"])
            if saved.get("obsidian_vault_path"):
                os.environ.setdefault("MEMENTO_OBSIDIAN_VAULT_PATH", saved["obsidian_vault_path"])
            config = CollectorConfig()
        except Exception:
            pass
    return config


def _setup_logging(config: CollectorConfig) -> None:
    config.log_dir.mkdir(parents=True, exist_ok=True)
    log_file = config.log_dir / "collector.log"
    # Force UTF-8 on the log file — default is locale.getpreferredencoding(),
    # which on Chinese Windows is cp936/GBK. The desktop log viewer reads the
    # file as UTF-8, so any non-ASCII char (Chinese titles, the `→` arrow in
    # update messages) shows up as replacement chars.
    handlers: list[logging.Handler] = [
        logging.FileHandler(log_file, encoding="utf-8")
    ]
    # Console: same problem on Windows — sys.stdout is mbcs unless we
    # explicitly reconfigure it. Best-effort; ignore if the stream doesn't
    # support reconfigure (e.g. it was replaced with a non-text wrapper).
    try:
        sys.stdout.write("")
        sys.stdout.flush()
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
        handlers.append(logging.StreamHandler(sys.stdout))
    except Exception:
        pass
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        handlers=handlers,
    )


def _send_discovery(config: CollectorConfig, logger: logging.Logger) -> None:
    """Send tool discovery to server (runs in background thread)."""
    try:
        from .discovery import discover_all_tools
        import httpx
        discovery = discover_all_tools()
        if discovery:
            logger.info("Discovered tools: %s", ", ".join(discovery.keys()))
            httpx.post(
                f"{config.server.url}/api/ingest/discovery",
                json={"device_id": config.device_id, "device_name": config.device_name,
                      "platform": config.platform, "tools": discovery},
                headers={"X-Collector-Token": config.server.token},
                timeout=DISCOVERY_TIMEOUT,
            )
    except Exception:
        pass


def _run_initial_scan(watcher: FileWatcher, logger: logging.Logger) -> None:
    """Run initial scan in background thread."""
    try:
        count = watcher.initial_scan()
        logger.info("Initial scan complete: %d files queued", count)
    except Exception:
        logger.exception("Initial scan failed")


def _poll_commands(config: CollectorConfig, queue: SyncQueue, watcher: FileWatcher,
                   logger: logging.Logger) -> None:
    """Poll server for pending commands (resync, etc.)."""
    try:
        import httpx
        try:
            from importlib.metadata import version
            _ver = version(PACKAGE_NAME)
        except Exception:
            _ver = "dev"
        resp = httpx.get(
            f"{config.server.url}/api/devices/commands",
            headers={
                "X-Collector-Token": config.server.token,
                "X-Device-Id": config.device_id,
                "X-Collector-Version": _ver,
            },
            timeout=10,
        )
        if resp.status_code != 200:
            return
        commands = resp.json()
        for cmd in commands:
            action = cmd.get("action")
            cmd_id = cmd.get("id")

            # Ack FIRST before executing (prevents restart loops)
            if cmd_id:
                try:
                    httpx.post(
                        f"{config.server.url}/api/devices/commands/{cmd_id}/ack",
                        headers={
                            "X-Collector-Token": config.server.token,
                            "X-Device-Id": config.device_id,
                        },
                        timeout=5,
                    )
                except Exception:
                    pass

            if action == "resync":
                logger.info("Received resync — clearing cache + full re-scan")
                queue.clear_all_state()
                try:
                    from .parsers import antigravity_export as _ag
                    _ag._last_hashes.clear()
                    _ag._title_map_cache = None  # Force re-read on next export
                except Exception:
                    pass
                threading.Thread(target=_run_initial_scan, args=(watcher, logger), daemon=True).start()
                logger.info("Resync triggered — cache cleared, re-scan started")
            elif action == "update":
                logger.info("Received update command from server")
                threading.Thread(target=_check_and_update, args=(logger,), daemon=True).start()
    except Exception:
        pass  # Server unreachable, skip


def _get_pypi_latest(package: str) -> str | None:
    """Query PyPI for latest version of a package."""
    try:
        import urllib.request, json as _json
        req = urllib.request.Request(
            f"https://pypi.org/pypi/{package}/json",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return _json.loads(resp.read())["info"]["version"]
    except Exception:
        return None


def _upgrade_package(package: str, version: str, logger: logging.Logger) -> bool:
    """Pip upgrade a single package to a specific version."""
    import subprocess
    pip_cmd = [sys.executable, "-m", "pip", "install", "--upgrade",
               f"{package}=={version}", "--quiet"]
    if SYSTEM == "Windows":
        pip_cmd.insert(-1, "--user")
    result = subprocess.run(pip_cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        logger.warning("Upgrade %s failed: %s", package, result.stderr[:300])
        return False
    return True


def _check_and_update(logger: logging.Logger) -> None:
    """Check PyPI for a newer version and auto-upgrade + restart if found.

    Upgrades both memento-collector and memento-memory (MCP server).
    """
    # Frozen desktop sidecar — `sys.executable` is the PyInstaller-built
    # sidecar binary, not a real Python interpreter, so `[sys.executable,
    # "-m", "pip", "install", ...]` ends up calling
    # `memento-sidecar -m pip install ...` which the entry.py wrapper
    # rejects ("only 'run' is supported"). Even if pip could run, the
    # collector code is bundled inside the .exe — pip can't replace it.
    # The user has to install a new desktop release to upgrade.
    if getattr(sys, "frozen", False) or hasattr(sys, "_MEIPASS"):
        logger.info(
            "Running as bundled desktop sidecar — auto-upgrade not applicable. "
            "Install a new desktop release to upgrade collector + MCP."
        )
        return

    try:
        from importlib.metadata import version as get_version, PackageNotFoundError

        # Log starting state up front so the user sees the check fired even
        # if nothing needs upgrading. Guard the mcp version lookup with
        # try/except so this initial log itself never crashes.
        current = get_version(PACKAGE_NAME)
        try:
            _mcp_current_for_log = get_version("memento-brain-memory")
        except PackageNotFoundError:
            _mcp_current_for_log = "not installed"
        logger.info(
            "Checking PyPI for updates (collector=%s, mcp=%s)",
            current, _mcp_current_for_log,
        )

        # Check collector update
        latest = _get_pypi_latest(PACKAGE_NAME)
        needs_restart = False
        any_upgrade = False

        if latest is None:
            logger.warning(
                "PyPI lookup failed for memento-brain-collector "
                "(network/proxy/timeout) — try again later"
            )
        elif latest == current:
            logger.info("Collector already up to date (%s)", current)
        elif latest != current:
            logger.info("Collector update available: %s → %s", current, latest)
            if _upgrade_package(PACKAGE_NAME, latest, logger):
                logger.info("Collector upgraded to %s", latest)
                needs_restart = True
                any_upgrade = True

        # Also check MCP server update (installed as dependency)
        try:
            mcp_current = get_version("memento-brain-memory")
            mcp_latest = _get_pypi_latest("memento-brain-memory")
            if mcp_latest is None:
                logger.warning("PyPI lookup failed for memento-brain-memory")
            elif mcp_latest == mcp_current:
                logger.info("MCP server already up to date (%s)", mcp_current)
            elif mcp_latest != mcp_current:
                logger.info("MCP server update available: %s → %s", mcp_current, mcp_latest)
                if _upgrade_package("memento-brain-memory", mcp_latest, logger):
                    logger.info("MCP server upgraded to %s (restart AI IDE to activate)", mcp_latest)
                    any_upgrade = True
        except PackageNotFoundError:
            logger.info("memento-brain-memory not installed, skipping MCP upgrade")

        if not any_upgrade:
            logger.info("Update check complete — no upgrades needed")

        # Restart collector if it was upgraded
        if needs_restart:
            if SYSTEM == "Windows":
                # `os.execv` on Windows is *not* a true exec — Python spawns a
                # new process and exits the original. Task Scheduler then sees
                # the original PID terminate and marks the task "completed",
                # detaching the new process from the schedule. The new process
                # keeps running for now, but the moment it dies (any reason)
                # nothing brings it back until the user logs off and on.
                # Instead: exit non-zero so Task Scheduler's RestartOnFailure
                # (configured in the XML task definition) brings us back fresh
                # within ~1 minute, with the schedule association intact.
                logger.info("Collector upgraded — exiting; Task Scheduler will restart in ~1m")
                sys.exit(1)
            logger.info("Restarting collector...")
            os.execv(sys.executable, [sys.executable, "-m", "collector.main"])

    except Exception as e:
        logger.debug("Auto-update check failed: %s", e)


_ag_export_lock = threading.Lock()


def _run_antigravity_export(queue: SyncQueue, logger: logging.Logger) -> None:
    """Run Antigravity export in background thread (non-blocking)."""
    # Prevent concurrent exports from overlapping
    if not _ag_export_lock.acquire(blocking=False):
        return
    try:
        from .parsers.antigravity_export import export_conversations
        convos = export_conversations()
        for conv in convos:
            content = conv["content"]
            meta: dict = {"source": "aghistory", "doc_type": "full_conversation"}
            if conv.get("title"):
                meta["title"] = conv["title"]
            if conv.get("cascade_id"):
                meta["session_id"] = conv["cascade_id"]
            if conv.get("project_name"):
                meta["project_hash"] = conv["project_name"]
            if conv.get("workspace"):
                meta["project_path"] = conv["workspace"]
            if conv.get("export_diagnostics"):
                meta["export_diagnostics"] = conv["export_diagnostics"]
            queue.enqueue(
                tool_name="antigravity",
                category="conversation",
                content_type="jsonl",
                relative_path=f"conversations/{conv['cascade_id']}.jsonl",
                content=content,
                content_hash=conv.get("content_hash", f"ag-{hash(content) & 0xFFFFFFFF:08x}"),
                file_size=len(content.encode("utf-8")),
                sync_strategy="full",
                metadata=meta,
            )
    except Exception:
        logger.exception("Antigravity export error")
    finally:
        _ag_export_lock.release()




_devnull_file = None  # Module-level ref to keep devnull fd alive


def _ensure_stdio() -> None:
    """Ensure stdout/stderr are writable (pythonw.exe on Windows sets them to None)."""
    global _devnull_file
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name)
        try:
            if stream is not None:
                stream.write("")
                stream.flush()
                continue
        except Exception:
            pass
        # Stream is None or broken — redirect to devnull
        if _devnull_file is None:
            _devnull_file = open(os.devnull, "w")
        setattr(sys, stream_name, _devnull_file)


def _check_windows_task_health(logger: logging.Logger) -> None:
    """Warn if the scheduled task is missing the hardening settings.

    Old installs (before XML-based registration) were created with the
    shorthand `schtasks /Create /SC ONLOGON ...` form, which inherits
    Windows defaults that kill long-running daemons (3-day time limit,
    stop-on-battery, no auto-restart). New installs ship a proper XML
    definition; this helper detects the old form and tells the user to
    re-run setup once.
    """
    if SYSTEM != "Windows":
        return
    try:
        import subprocess as _sp
        r = _sp.run(
            ["schtasks", "/Query", "/TN", "MementoCollector", "/XML"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return
        xml = r.stdout
        # Heuristic: hardened tasks declare RestartOnFailure + PT0S limit.
        if "<RestartOnFailure>" not in xml or "PT0S" not in xml:
            logger.warning(
                "Scheduled task is using legacy settings (no auto-restart, "
                "3-day execution limit, stops on battery). Re-run "
                "`memento-collector setup` once to apply the hardened XML "
                "definition — this is the most common cause of the collector "
                "appearing to stop on its own."
            )
    except Exception:
        pass  # best-effort, don't block startup


def main() -> None:
    _ensure_stdio()

    config = _load_saved_config()
    config.ensure_dirs()
    _setup_logging(config)

    logger = logging.getLogger("collector")
    logger.info(
        "Starting Memento Collector [%s] on %s (%s)",
        config.device_id[:8], config.device_name, config.platform,
    )
    _check_windows_task_health(logger)

    # Initialize tools
    tools = [
        ClaudeCodeTool(), OpenClawTool(), CodexTool(),
        AntigravityTool(), ObsidianTool(vault_path=config.obsidian_vault_path), CursorTool(),
        HermesTool(),
    ]
    available = [t for t in tools if t.is_available()]
    logger.info("Available tools (%d): %s", len(available),
                ", ".join(t.display_name for t in available))

    if not available:
        logger.warning("No AI tools found on this device!")

    # Initialize queue + sync client + watcher
    queue = SyncQueue(config.queue_db_path)
    sync_client = SyncClient(queue, config)
    watcher = FileWatcher(available, queue, config)

    # Graceful shutdown
    shutdown = False

    def _signal_handler(signum: int, frame: object) -> None:
        nonlocal shutdown
        logger.info("Received signal %s, shutting down...", signum)
        shutdown = True

    signal.signal(signal.SIGINT, _signal_handler)
    if SYSTEM != "Windows":
        signal.signal(signal.SIGTERM, _signal_handler)

    # --- All blocking operations run in background threads ---

    # 1. Discovery (non-blocking)
    threading.Thread(target=_send_discovery, args=(config, logger), daemon=True).start()

    # 2. Initial scan (non-blocking)
    threading.Thread(target=_run_initial_scan, args=(watcher, logger), daemon=True).start()

    # 3. Start file watcher + sync client
    watcher.start()
    sync_client.start()

    logger.info("Collector running. Watching for file changes...")

    # 4. Auto-update check on startup (non-blocking)
    threading.Thread(target=_check_and_update, args=(logger,), daemon=True).start()

    # 5. Antigravity export on startup (real-time updates handled by main FileWatcher)
    has_antigravity = any(t.name == "antigravity" for t in available)
    if has_antigravity:
        threading.Thread(
            target=_run_antigravity_export, args=(queue, logger), daemon=True,
        ).start()

    # --- Main loop: heartbeat + periodic tasks ---
    last_heartbeat = time.time()
    last_command_poll = time.time()
    last_update_check = time.time()

    try:
        while not shutdown:
            time.sleep(1)

            now = time.time()

            # Heartbeat log every 30s
            if now - last_heartbeat > HEARTBEAT_INTERVAL:
                last_heartbeat = now
                pending = queue.pending_count()
                if pending > 0:
                    logger.info("Heartbeat: %d items pending sync", pending)
                else:
                    logger.info("Heartbeat: idle, watching for changes")

            # Poll server commands every 30s
            if now - last_command_poll > COMMAND_POLL_INTERVAL:
                last_command_poll = now
                _poll_commands(config, queue, watcher, logger)

            # Auto-update check every hour
            if now - last_update_check > AUTO_UPDATE_INTERVAL:
                last_update_check = now
                threading.Thread(target=_check_and_update, args=(logger,), daemon=True).start()

    except KeyboardInterrupt:
        pass
    finally:
        logger.info("Shutting down...")
        watcher.stop()
        sync_client.stop()
        queue.close()
        logger.info("Collector stopped.")


if __name__ == "__main__":
    main()
