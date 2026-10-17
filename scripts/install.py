#!/usr/bin/env python3
"""Memento — one-click installer for macOS / Linux / Windows.

Usage:
  python scripts/install.py              # full install (no embedding)
  python scripts/install.py embedding    # install embedding host service
  python scripts/install.py doctor       # status check
  python scripts/install.py update       # git pull + rebuild + upgrade
  python scripts/install.py uninstall [--purge]

Typically invoked via the top-level `./install.sh` or `.\\install.ps1` launcher.
"""

from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

# Make install_lib importable regardless of CWD.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from install_lib import (
    bootstrap_user, collector_setup, docker_up, embedding_docker, embedding_host,
    env_gen,
)
from install_lib.platform_utils import C, REPO_ROOT, fail, heading, info, ok, step, which


def _cmd_install(args: argparse.Namespace) -> int:
    heading("1. Environment file")
    with step(".env generate/merge"):
        env_gen.ensure_env(interactive=not args.non_interactive)

    heading("2. Docker stack")
    with step("Docker preflight", hint="Start Docker Desktop or `sudo systemctl start docker`"):
        docker_up.preflight()
    with step("docker compose up -d --build"):
        docker_up.compose_up()
    with step("Wait for API /health"):
        docker_up.wait_for_api(timeout=180)

    heading("3. First user")
    token = bootstrap_user.ensure_first_user(interactive=not args.non_interactive)

    heading("4. Local collector")
    with step("Configure this device + install the collector daemon"):
        collector_setup.install_collector(token)

    heading("Done")
    print(f"  {C['green']}▸{C['reset']} Web UI:  http://localhost:3001")
    print(f"  {C['green']}▸{C['reset']} API:     http://localhost:8001")
    print(f"  {C['green']}▸{C['reset']} MinIO:   http://localhost:9001  (user/pass in .env)")
    print()
    print(f"  Semantic search & MCP memory?  {C['cyan']}./install.sh embedding{C['reset']}")
    print(f"  Status check:                  {C['cyan']}./install.sh doctor{C['reset']}")
    print()
    return 0


def _cmd_embedding(args: argparse.Namespace) -> int:
    """`./install.sh embedding` — default is Docker; `--native` reverts to
    the old host-venv install (needed for NVIDIA CUDA / Apple MPS GPU)."""
    if args.native:
        heading("Embedding (native host install — GPU mode)")
        with step("Install embedding (venv + torch + sentence-transformers + model)"):
            embedding_host.install()
        info(
            "Native install uses host.docker.internal:8002. If api/celery were\n"
            "started before with a different URL, restart them so the daemon\n"
            "picks up MEMENTO_EMBEDDING_SERVER_URL: "
            "`docker compose up -d --force-recreate api celery-worker celery-beat`."
        )
        return 0

    heading("Embedding (Docker — recommended)")
    with step("Build + start `embedding` compose profile (~5–15 min first time)"):
        embedding_docker.install()
    info("Semantic search & MCP memory_search are now wired up.")
    return 0


def _cmd_doctor(_args: argparse.Namespace) -> int:
    heading("Service status")
    rows = docker_up.doctor()
    docker_up.print_doctor(rows)
    return 0 if all(r[1] for r in rows[:2]) else 1  # docker + api are hard requirements


def _cmd_update(args: argparse.Namespace) -> int:
    import subprocess
    heading("Update")
    # Self-heal: if .env is missing or incomplete (e.g. the previous install
    # crashed mid-docker-build before env_gen ran, leaving a half-installed
    # dir), generate it before docker compose. Without this the API container
    # boots with the dev-default MEMENTO_SECRET_KEY / COLLECTOR_TOKEN /
    # MINIO creds and validate_production() refuses to start.
    info("Ensuring .env is present…")
    env_gen.ensure_env(interactive=False)
    info("Pulling latest code…")
    subprocess.run(["git", "pull"], check=False, cwd=str(REPO_ROOT))
    info("Rebuilding containers…")
    subprocess.run(
        ["docker", "compose", "up", "-d", "--build"],
        check=True, cwd=str(REPO_ROOT),
    )
    # The collector daemon runs from this checkout: rebuild it and restart its
    # service so it picks up the new code.
    if collector_setup.daemon_service_installed() and which("node"):
        info("Rebuilding the collector daemon…")
        collector_setup.build_daemon()
        subprocess.run(
            [which("node"), str(collector_setup.DAEMON_CLI), "install-service"],
            check=False, cwd=str(REPO_ROOT),
        )
    # Embedding (if installed) restarts via its own service manager
    # (launchd / systemd / Docker restart policy) — nothing to do here.
    ok("Update complete. Run `./install.sh doctor` to verify.")
    return 0


def _cmd_uninstall(args: argparse.Namespace) -> int:
    import shutil
    import subprocess

    deep = args.all  # `--all` implies `--purge` + deeper cleanup
    purge = args.purge or deep

    if deep and sys.stdin.isatty() and not args.yes:
        print(
            f"{C['yellow']}WARNING{C['reset']} `--all` will remove:\n"
            "  • collector daemon service + old pip packages (memento-collector, memento-memory)\n"
            "  • collector config + sync state (~/.memento)\n"
            "  • collector + embedding logs\n"
            "  • embedding venv + HuggingFace model cache (~1.3GB)\n"
            "  • Docker images (memento-*)\n"
            "  • docker volumes (all your synced data will be lost)\n"
            "  • .env and .env.local\n"
            "  • MCP entries in Claude / Cursor / Codex / Windsurf configs"
        )
        confirm = input("Type 'yes' to continue: ").strip().lower()
        if confirm != "yes":
            info("Aborted.")
            return 1

    heading("Uninstall")

    # 1. Collector
    if deep:
        info("Deep-uninstalling collector (service + config + logs + MCP entries)…")
        collector_setup.deep_uninstall()
    else:
        collector_setup.uninstall_daemon_service()
        if which("memento-collector"):  # the retired Python collector, from older installs
            subprocess.run(["memento-collector", "uninstall"], check=False)

    # 2. Embedding — both install paths idempotently torn down so users
    # who switched modes don't get orphaned containers / launch agents.
    info("Removing embedding service…")
    embedding_host.uninstall(remove_model_cache=deep, remove_venv=deep)
    embedding_docker.uninstall(remove_image=deep)

    # 3. Docker
    info("Stopping Docker stack…")
    docker_up.compose_down(purge=purge)

    if deep:
        info("Removing Docker images…")
        for img in ("memento-api", "memento-web", "memento-celery-worker",
                    "memento-celery-beat"):
            subprocess.run(["docker", "rmi", "-f", img], capture_output=True)
        ok("Images removed (non-fatal if already gone).")

    # 4. Repo-local files
    if purge:
        info("Purging .env and .env.local…")
        for p in (REPO_ROOT / ".env", REPO_ROOT / ".env.local"):
            if p.exists():
                p.unlink()
        venv = REPO_ROOT / ".venv-embedding"
        if venv.exists():
            shutil.rmtree(venv, ignore_errors=True)
        log = REPO_ROOT / "install.log"
        if log.exists():
            log.unlink()

    # Final summary
    print()
    if deep:
        ok("Deep uninstall complete. Nothing belonging to Memento remains.")
        info(f"If you installed via curl, the repo clone at {REPO_ROOT} is safe to delete.")
    elif purge:
        ok("Uninstalled. Data volumes + .env purged.")
    else:
        ok("Uninstalled. Data volumes preserved (use --purge to remove them).")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="install", description=__doc__)
    sub = p.add_subparsers(dest="cmd")

    p_install = sub.add_parser("install", help="Full install (default)")
    p_install.add_argument("--non-interactive", action="store_true",
                           help="Skip all prompts (fail if input required)")
    p_install.set_defaults(func=_cmd_install)

    p_emb = sub.add_parser(
        "embedding",
        help="Install embedding server (Docker default; pass --native for GPU)",
    )
    p_emb.add_argument(
        "--native", action="store_true",
        help="Use host venv install instead of Docker (needed for CUDA / MPS GPU).",
    )
    p_emb.set_defaults(func=_cmd_embedding)

    p_doc = sub.add_parser("doctor", help="Print service status")
    p_doc.set_defaults(func=_cmd_doctor)

    p_up = sub.add_parser("update", help="Pull latest + rebuild")
    p_up.set_defaults(func=_cmd_update)

    p_rm = sub.add_parser("uninstall", help="Reverse the install")
    p_rm.add_argument("--purge", action="store_true",
                      help="Also delete data volumes + .env files")
    p_rm.add_argument("--all", action="store_true",
                      help="Everything: pip, config, logs, model cache, images, MCP entries")
    p_rm.add_argument("-y", "--yes", action="store_true",
                      help="Skip confirmation prompt for --all")
    p_rm.set_defaults(func=_cmd_uninstall)

    args = p.parse_args(argv)
    if not args.cmd:
        # Default to `install`
        args = p.parse_args(["install", *(argv or [])])

    try:
        return args.func(args)
    except KeyboardInterrupt:
        fail("\nInterrupted.")
        return 130
    except Exception as e:
        fail(str(e))
        log_path = REPO_ROOT / "install.log"
        log_path.write_text(traceback.format_exc())
        fail(f"Full traceback saved to {log_path}")
        fail("Try `./install.sh doctor` to diagnose.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
