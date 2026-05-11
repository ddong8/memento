"""Freeze the collector into a single binary that Tauri can bundle.

Workflow:
  cd tauri-collector/sidecar
  pip install -e ../../collector pyinstaller
  python build_sidecar.py

Output:
  ../src-tauri/binaries/memento-collector-sidecar-<triple>{.exe?}

The `<triple>` suffix is Tauri's requirement — it matches the running
host triple at install time so the right binary lands in the bundle.
We let `rustc -vV` tell us the triple; rustup ships with both rustc and
this script's prerequisite (`cargo tauri`), so the user already has it.
"""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from pathlib import Path

# Windows defaults stdout/stderr to cp1252 (a.k.a. "charmap"). The `→` and
# `✓` we print below blow up with UnicodeEncodeError on Windows runners
# (cp1252 has no codepoint for U+2192). Force utf-8 if we can — local
# Windows users hit this the same way the GitHub Actions runner does.
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = Path(__file__).resolve().parent
BIN_DIR = HERE.parent / "src-tauri" / "binaries"


def host_triple() -> str:
    """Ask rustc for the host triple — single source of truth."""
    try:
        out = subprocess.check_output(["rustc", "-vV"], text=True)
        for line in out.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    except FileNotFoundError:
        pass
    # Last-resort heuristic if rustc isn't installed yet — gets the
    # common cases right but you really should install rustc, since
    # the Tauri build itself needs it.
    arch = platform.machine().lower()
    if arch in ("amd64", "x86_64"):
        arch_t = "x86_64"
    elif arch in ("arm64", "aarch64"):
        arch_t = "aarch64"
    else:
        arch_t = arch
    system = platform.system()
    if system == "Windows":
        return f"{arch_t}-pc-windows-msvc"
    if system == "Darwin":
        return f"{arch_t}-apple-darwin"
    return f"{arch_t}-unknown-linux-gnu"


def main() -> int:
    triple = host_triple()
    print(f"Building sidecar for triple: {triple}")

    # Sanity: PyInstaller installed?
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print(
            "PyInstaller not installed. Run: pip install pyinstaller",
            file=sys.stderr,
        )
        return 1
    # Sanity: collector importable?
    try:
        import collector  # noqa: F401
    except ImportError:
        print(
            "collector package not importable. Run: pip install -e ../../collector",
            file=sys.stderr,
        )
        return 1

    BIN_DIR.mkdir(parents=True, exist_ok=True)

    spec = HERE / "collector.spec"
    work = HERE / "build"
    dist = HERE / "dist"

    # Clean previous output — PyInstaller will refuse otherwise.
    for d in (work, dist):
        if d.exists():
            shutil.rmtree(d)

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--clean",
        "--workpath", str(work),
        "--distpath", str(dist),
        str(spec),
    ]
    print("→", " ".join(cmd))
    subprocess.run(cmd, check=True)

    # PyInstaller writes to dist/<exe-name>{.exe}; rename + move into
    # the binaries/ folder under Tauri's required name.
    exe_suffix = ".exe" if platform.system() == "Windows" else ""
    src = dist / f"memento-collector-sidecar{exe_suffix}"
    if not src.exists():
        print(f"PyInstaller did not produce expected output at {src}", file=sys.stderr)
        return 1
    target = BIN_DIR / f"memento-collector-sidecar-{triple}{exe_suffix}"
    shutil.move(str(src), str(target))
    # Match Unix executable bit explicitly — shutil.move preserves it
    # on POSIX, but be defensive for archives that strip it.
    if exe_suffix == "":
        target.chmod(0o755)

    # Tidy up the spec working dirs once we've extracted the binary —
    # the .msi / .dmg shouldn't include them.
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(dist, ignore_errors=True)

    print(f"\n✓ Sidecar written to {target}")
    print("Now run `cargo tauri build` from tauri-collector/.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
