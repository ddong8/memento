"""Install the BGE-M3 embedding server as a host-side background service.

Runs on host (not in Docker) because:
- macOS Docker Desktop can't expose MPS GPU
- Linux with NVIDIA works fine on host too
- Windows: same story

Cross-platform service install: launchd on macOS, systemd user units on Linux,
a Scheduled Task on Windows.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from .platform_utils import (
    IS_LINUX, IS_MAC, IS_WINDOWS, REPO_ROOT, detect_accelerator, find_python,
    info, ok, warn,
)

VENV_DIR = REPO_ROOT / ".venv-embedding"
TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"


# ── venv + torch + sentence-transformers ──────────────────────
def _venv_python() -> Path:
    if IS_WINDOWS:
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def _venv_pythonw() -> Path:
    if IS_WINDOWS:
        return VENV_DIR / "Scripts" / "pythonw.exe"
    return _venv_python()


def create_venv() -> Path:
    if _venv_python().exists():
        ok(f"Embedding venv already present at {VENV_DIR}")
        return _venv_python()
    info(f"Creating venv at {VENV_DIR}…")
    base_py = find_python()
    subprocess.run([base_py, "-m", "venv", str(VENV_DIR)], check=True)
    # upgrade pip so wheel installs don't warn
    subprocess.run([str(_venv_python()), "-m", "pip", "install", "-U",
                    "pip", "wheel", "setuptools"], check=True)
    ok("Venv created.")
    return _venv_python()


def install_torch_and_transformers() -> None:
    py = _venv_python()
    accel = detect_accelerator()
    info(f"Detected accelerator: {accel}")

    # torch>=2.6 — transformers 5.x refuses to call torch.load on anything
    # older after CVE-2025-32434 (a deserialization gadget that bypasses
    # weights_only=True). BGE-M3's pytorch_model.bin only loads through
    # torch.load, so without this pin you can download 2.27 GB and then
    # eat a ValueError on the very last step.
    torch_spec = "torch>=2.6"

    if accel == "cuda":
        # Default PyPI ships CUDA-enabled torch wheels from 2.6 onwards
        # (CUDA libs come via nvidia-cuda-* sub-packages auto-resolved
        # as deps). The old cu121 download.pytorch.org index caps at
        # torch 2.5.1, which trips CVE-2025-32434's torch.load guard.
        info("Installing torch with CUDA support (default PyPI)…")
        subprocess.run(
            [str(py), "-m", "pip", "install", torch_spec],
            check=True,
        )
    elif accel == "mps":
        info("Installing torch (MPS is built into the standard wheel on arm64 macOS)…")
        subprocess.run([str(py), "-m", "pip", "install", torch_spec], check=True)
    else:
        warn("No GPU detected — embedding will run on CPU and will be slow.")
        subprocess.run([str(py), "-m", "pip", "install", torch_spec], check=True)

    info("Installing sentence-transformers + fastapi/uvicorn + modelscope…")
    subprocess.run(
        [str(py), "-m", "pip", "install",
         "sentence-transformers>=3.0", "fastapi", "uvicorn", "modelscope"],
        check=True,
    )
    ok("Python dependencies installed.")


def predownload_model(model: str = "BAAI/bge-m3") -> str:
    """Pre-fetch the embedding model. Returns the identifier the embedding
    server should load (either an absolute local path when ModelScope cached
    it, or the original HF id when the HF code path succeeded).

    Download source priority — picks the first one that works:
      1. ModelScope (best from inside China, no network shenanigans)
      2. HuggingFace direct
      3. hf-mirror.com (HK-based HF mirror)
    """
    py = _venv_python()
    info(f"Pre-downloading {model} (~1.3GB, may take minutes)…")

    # 1) ModelScope — returns absolute path on success.
    ms_code = (
        "from modelscope import snapshot_download;"
        f"p = snapshot_download({model!r});"
        "print(p, end='')"
    )
    try:
        r = subprocess.run(
            [str(py), "-c", ms_code],
            check=True, capture_output=True, text=True, timeout=1800,
        )
        local_path = r.stdout.strip()
        if local_path and Path(local_path).exists():
            # Smoke test: sentence-transformers must be able to load it.
            verify = (
                "from sentence_transformers import SentenceTransformer;"
                f"SentenceTransformer({local_path!r})"
            )
            subprocess.run([str(py), "-c", verify], check=True)
            ok(f"Model downloaded via ModelScope → {local_path}")
            return local_path
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "")[:300]
        warn(f"ModelScope download failed ({stderr.strip()}) — falling back to HuggingFace…")
    except subprocess.TimeoutExpired:
        warn("ModelScope download timed out — falling back to HuggingFace…")

    # 2) HuggingFace direct.
    hf_code = (
        "from sentence_transformers import SentenceTransformer;"
        f"SentenceTransformer({model!r})"
    )
    try:
        subprocess.run([str(py), "-c", hf_code], check=True)
        ok("Model downloaded via HuggingFace.")
        return model
    except subprocess.CalledProcessError:
        warn("HuggingFace direct download failed — retrying via hf-mirror.com…")

    # 3) hf-mirror.com.
    env = os.environ.copy()
    env["HF_ENDPOINT"] = "https://hf-mirror.com"
    subprocess.run([str(py), "-c", hf_code], env=env, check=True)
    ok("Model downloaded via hf-mirror.com.")
    return model


# ── platform-specific service install ─────────────────────────
def _render(template: str, **vars: str) -> str:
    # Simple {name} substitution; brace escapes not needed (no {{ in templates).
    return template.format(**vars)


def install_macos(model: str = "BAAI/bge-m3") -> None:
    agents = Path.home() / "Library" / "LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    # Migrate: unload + remove legacy com.dailyreport.embedding plist.
    uid = os.getuid()
    legacy = agents / "com.dailyreport.embedding.plist"
    if legacy.exists():
        subprocess.run(["launchctl", "bootout", f"gui/{uid}/com.dailyreport.embedding"],
                       capture_output=True)
        subprocess.run(["launchctl", "unload", str(legacy)], capture_output=True)
        legacy.unlink()
        info(f"Migrated: removed legacy {legacy.name}")

    plist_path = agents / "com.memento.embedding.plist"
    logdir = Path.home() / "Library" / "Logs" / "memento"
    logdir.mkdir(parents=True, exist_ok=True)

    body = _render(
        (TEMPLATE_DIR / "memento-embedding.plist.tmpl").read_text(),
        python=str(_venv_python()),
        repo=str(REPO_ROOT),
        logdir=str(logdir),
        path=os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        model=model,
    )
    plist_path.write_text(body)

    label = "com.memento.embedding"
    # Try `bootout` to cleanly unload if already present; ignore errors.
    subprocess.run(
        ["launchctl", "bootout", f"gui/{uid}/{label}"],
        capture_output=True,
    )
    # Bootstrap (newer), fall back to load (older macOS).
    r = subprocess.run(
        ["launchctl", "bootstrap", f"gui/{uid}", str(plist_path)],
        capture_output=True,
    )
    if r.returncode != 0:
        subprocess.run(["launchctl", "load", str(plist_path)], check=True)
    ok(f"launchd service installed: {plist_path.name}")


def install_linux(model: str = "BAAI/bge-m3") -> None:
    # Two install modes — picked by effective uid:
    #   - non-root → user-scope unit in ~/.config/systemd/user/.
    #     Standard for desktops / multi-user boxes.
    #   - root    → system-scope unit in /etc/systemd/system/.
    #     Standard for headless servers, where root typically has no user
    #     dbus session and `systemctl --user daemon-reload` fails with
    #     "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS … not defined".
    is_system = os.geteuid() == 0

    if is_system:
        unit_dir = Path("/etc/systemd/system")
        ctl = ["systemctl"]
        wanted_by = "multi-user.target"
        logdir = Path("/var/log/memento")
        scope_label = "system"
    else:
        unit_dir = Path.home() / ".config" / "systemd" / "user"
        ctl = ["systemctl", "--user"]
        wanted_by = "default.target"
        logdir = Path.home() / ".local" / "share" / "memento" / "logs"
        scope_label = "user"

    unit_dir.mkdir(parents=True, exist_ok=True)
    logdir.mkdir(parents=True, exist_ok=True)

    # Migrate: disable + remove legacy dr-embedding.service from BOTH
    # locations — installs may have switched scope across upgrades.
    for legacy_dir, legacy_ctl in (
        (Path.home() / ".config" / "systemd" / "user", ["systemctl", "--user"]),
        (Path("/etc/systemd/system"), ["systemctl"]),
    ):
        legacy = legacy_dir / "dr-embedding.service"
        if legacy.exists():
            subprocess.run(
                [*legacy_ctl, "disable", "--now", "dr-embedding"],
                capture_output=True,
            )
            try:
                legacy.unlink()
                info(f"Migrated: removed legacy {legacy}")
            except (PermissionError, OSError):
                pass

    unit_path = unit_dir / "memento-embedding.service"

    body = _render(
        (TEMPLATE_DIR / "memento-embedding.service.tmpl").read_text(),
        python=str(_venv_python()),
        repo=str(REPO_ROOT),
        logdir=str(logdir),
        path=os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        model=model,
        wanted_by=wanted_by,
    )
    unit_path.write_text(body)

    subprocess.run([*ctl, "daemon-reload"], check=True)
    subprocess.run([*ctl, "enable", "--now", "memento-embedding"], check=True)
    ok(f"systemd {scope_label} service installed: {unit_path}")

    if not is_system:
        # Lingering so service survives logout (headless server use case).
        # System-scope services don't need this — they start at boot.
        r = subprocess.run(
            ["loginctl", "show-user", os.environ.get("USER", ""), "--property=Linger"],
            capture_output=True, text=True,
        )
        if "Linger=no" in r.stdout:
            warn(
                "Service will stop when you log out. To keep it running headless, run:\n"
                f"    sudo loginctl enable-linger {os.environ.get('USER', '$USER')}"
            )


def install_windows(model: str = "BAAI/bge-m3") -> None:
    import tempfile
    # Migrate: delete legacy DailyReportEmbedding task.
    subprocess.run(
        ["schtasks", "/Delete", "/TN", "DailyReportEmbedding", "/F"],
        capture_output=True,
    )
    logdir = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "memento" / "logs"
    logdir.mkdir(parents=True, exist_ok=True)

    body = _render(
        (TEMPLATE_DIR / "memento-embedding-task.xml.tmpl").read_text(),
        pythonw=str(_venv_pythonw()),
        repo=str(REPO_ROOT),
        model=model,
    )
    # schtasks requires UTF-16 encoding on disk.
    tmp = Path(tempfile.gettempdir()) / "memento-embedding-task.xml"
    tmp.write_text(body, encoding="utf-16")

    # Remove any existing task, then create fresh.
    subprocess.run(
        ["schtasks", "/Delete", "/TN", "MementoEmbedding", "/F"],
        capture_output=True,
    )
    subprocess.run(
        ["schtasks", "/Create", "/TN", "MementoEmbedding",
         "/XML", str(tmp), "/F"],
        check=True,
    )
    subprocess.run(
        ["schtasks", "/Run", "/TN", "MementoEmbedding"],
        check=False,
    )
    ok("Task Scheduler task 'MementoEmbedding' installed and started.")


def install() -> None:
    """Full install flow: venv → deps → model → platform service."""
    create_venv()
    install_torch_and_transformers()
    model_id = predownload_model()
    if IS_MAC:
        install_macos(model=model_id)
    elif IS_LINUX:
        install_linux(model=model_id)
    elif IS_WINDOWS:
        install_windows(model=model_id)
    else:
        raise RuntimeError(f"Unsupported platform: {sys.platform}")
    print()
    ok("Embedding service running on http://localhost:8002")


# ── uninstall ────────────────────────────────────────────────
def uninstall(remove_model_cache: bool = False, remove_venv: bool = False) -> None:
    """Remove the platform service, optionally the venv and model cache."""
    if IS_MAC:
        uid = os.getuid()
        agents = Path.home() / "Library" / "LaunchAgents"
        for label in ("com.memento.embedding", "com.dailyreport.embedding"):
            subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"],
                           capture_output=True)
            plist = agents / f"{label}.plist"
            if plist.exists():
                plist.unlink()
                ok(f"Removed launchd plist: {plist.name}")
        # Clean launchd-managed logs from either legacy or new location
        for logdir_name in ("memento", "daily_report"):
            for name in ("embedding_stdout.log", "embedding_stderr.log"):
                p = Path.home() / "Library" / "Logs" / logdir_name / name
                if p.exists():
                    p.unlink()
    elif IS_LINUX:
        # Clean both scopes — across upgrades the install path may have
        # switched between user and system depending on whether the
        # installer was run as root.
        for unit_dir, ctl in (
            (Path.home() / ".config" / "systemd" / "user", ["systemctl", "--user"]),
            (Path("/etc/systemd/system"), ["systemctl"]),
        ):
            for name in ("memento-embedding", "dr-embedding"):
                subprocess.run([*ctl, "disable", "--now", name], capture_output=True)
                unit = unit_dir / f"{name}.service"
                if unit.exists():
                    try:
                        unit.unlink()
                        ok(f"Removed systemd unit: {unit}")
                    except (PermissionError, OSError) as e:
                        warn(f"Couldn't remove {unit}: {e}")
    elif IS_WINDOWS:
        for task in ("MementoEmbedding", "DailyReportEmbedding"):
            subprocess.run(
                ["schtasks", "/Delete", "/TN", task, "/F"],
                capture_output=True,
            )
        ok("Removed Scheduled Task.")

    if remove_venv and VENV_DIR.exists():
        import shutil
        shutil.rmtree(VENV_DIR, ignore_errors=True)
        ok(f"Removed embedding venv {VENV_DIR.name}/")

    if remove_model_cache:
        # BGE-M3 may live in either cache depending on which source the
        # installer fell through to.
        import shutil
        # HuggingFace cache layout
        for cache_root in (
            Path.home() / ".cache" / "huggingface" / "hub",
            Path(os.environ.get("HF_HOME", "")) / "hub" if os.environ.get("HF_HOME") else None,
        ):
            if not cache_root:
                continue
            model_dir = cache_root / "models--BAAI--bge-m3"
            if model_dir.exists():
                shutil.rmtree(model_dir, ignore_errors=True)
                ok(f"Removed model cache {model_dir}")
        # ModelScope cache layout
        ms_dir = Path.home() / ".cache" / "modelscope" / "hub" / "BAAI" / "bge-m3"
        if ms_dir.exists():
            shutil.rmtree(ms_dir, ignore_errors=True)
            ok(f"Removed model cache {ms_dir}")
