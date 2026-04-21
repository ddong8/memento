"""Cross-platform helpers: OS detection, GPU detection, port probes, shell formatting."""

from __future__ import annotations

import contextlib
import os
import platform
import shutil
import socket
import subprocess
import sys
from pathlib import Path

SYSTEM = platform.system()  # "Darwin" | "Linux" | "Windows"
IS_MAC = SYSTEM == "Darwin"
IS_LINUX = SYSTEM == "Linux"
IS_WINDOWS = SYSTEM == "Windows"


# ── stdout helpers ────────────────────────────────────────────
def _supports_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


C = {
    "reset": "\033[0m" if _supports_color() else "",
    "bold": "\033[1m" if _supports_color() else "",
    "dim": "\033[2m" if _supports_color() else "",
    "red": "\033[31m" if _supports_color() else "",
    "green": "\033[32m" if _supports_color() else "",
    "yellow": "\033[33m" if _supports_color() else "",
    "blue": "\033[34m" if _supports_color() else "",
    "cyan": "\033[36m" if _supports_color() else "",
}


def ok(msg: str) -> None:
    print(f"{C['green']}✓{C['reset']} {msg}")


def info(msg: str) -> None:
    print(f"{C['cyan']}·{C['reset']} {msg}")


def warn(msg: str) -> None:
    print(f"{C['yellow']}!{C['reset']} {msg}")


def fail(msg: str) -> None:
    print(f"{C['red']}✗{C['reset']} {msg}", file=sys.stderr)


def heading(msg: str) -> None:
    print()
    print(f"{C['bold']}{msg}{C['reset']}")
    print(C["dim"] + "─" * min(len(msg), 60) + C["reset"])


@contextlib.contextmanager
def step(name: str, hint: str | None = None):
    """Run a step; on failure print a hint and re-raise."""
    info(name + "…")
    try:
        yield
    except Exception as e:
        fail(f"{name} failed: {e}")
        if hint:
            print(f"  {C['dim']}hint:{C['reset']} {hint}")
        raise


# ── port + service probes ─────────────────────────────────────
def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            return s.connect_ex((host, port)) == 0
        except OSError:
            return False


def port_user_hint(port: int) -> str:
    if IS_WINDOWS:
        return f'netstat -ano | findstr ":{port}"'
    return f"lsof -iTCP:{port} -sTCP:LISTEN -n -P"


# ── executable detection ──────────────────────────────────────
def which(cmd: str) -> str | None:
    return shutil.which(cmd)


def docker_available() -> bool:
    if not which("docker"):
        return False
    try:
        subprocess.run(
            ["docker", "info"],
            capture_output=True,
            check=True,
            timeout=8,
        )
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return False


def docker_start_hint() -> str:
    if IS_MAC:
        return "Open Docker Desktop (Applications → Docker)."
    if IS_WINDOWS:
        return 'Open Docker Desktop from the Start Menu.'
    return "Run: sudo systemctl start docker"


def find_python() -> str:
    """Locate a usable Python 3.11+ for the embedding venv."""
    candidates = [
        os.environ.get("MEMENTO_EMBEDDING_PYTHON"),
        "python3.13", "python3.12", "python3.11",
        "/opt/homebrew/opt/python@3.11/bin/python3.11",
        "/usr/local/opt/python@3.11/bin/python3.11",
        "python3", "python",
    ]
    for c in candidates:
        if not c:
            continue
        exe = shutil.which(c) or (c if os.path.exists(c) else None)
        if not exe:
            continue
        try:
            out = subprocess.check_output(
                [exe, "-c", "import sys; print(sys.version_info[:2])"],
                text=True, timeout=5,
            )
            ver = eval(out.strip())
            if ver >= (3, 11):
                return exe
        except Exception:
            continue
    raise RuntimeError(
        "Python 3.11+ not found. Install it first:\n"
        "  macOS:   brew install python@3.11\n"
        "  Linux:   sudo apt install python3.11 python3.11-venv\n"
        "  Windows: winget install Python.Python.3.11"
    )


# ── GPU detection ─────────────────────────────────────────────
def detect_accelerator() -> str:
    """Return 'mps' | 'cuda' | 'cpu'."""
    if IS_MAC and platform.machine() == "arm64":
        return "mps"
    if which("nvidia-smi"):
        try:
            subprocess.check_output(["nvidia-smi"], timeout=5, stderr=subprocess.DEVNULL)
            return "cuda"
        except Exception:
            pass
    return "cpu"


# ── filesystem helpers ────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parents[2]
