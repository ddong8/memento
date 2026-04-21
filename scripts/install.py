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

from install_lib import bootstrap_user, collector_setup, docker_up, embedding_host, env_gen
from install_lib.platform_utils import C, REPO_ROOT, fail, heading, info, ok, step


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
    with step("Install + configure memento-collector"):
        collector_setup.install_collector(token, dev=args.dev)

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
    heading("Embedding host service")
    with step("Install embedding (venv + torch + sentence-transformers + model)"):
        embedding_host.install()
    return 0


def _cmd_doctor(_args: argparse.Namespace) -> int:
    heading("Service status")
    rows = docker_up.doctor()
    docker_up.print_doctor(rows)
    return 0 if all(r[1] for r in rows[:2]) else 1  # docker + api are hard requirements


def _cmd_update(args: argparse.Namespace) -> int:
    import subprocess
    heading("Update")
    info("Pulling latest code…")
    subprocess.run(["git", "pull"], check=False, cwd=str(REPO_ROOT))
    info("Rebuilding containers…")
    subprocess.run(
        ["docker", "compose", "up", "-d", "--build"],
        check=True, cwd=str(REPO_ROOT),
    )
    info("Upgrading collector via pip…")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-U", "--user", "memento-brain-collector"],
        check=False,
    )
    # embedding (if installed) — restart via its service manager
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
            "  • collector pip packages (memento-collector, memento-memory)\n"
            "  • collector config + sync queue (~/.memento)\n"
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
        info("Deep-uninstalling collector (pip + config + logs + MCP entries)…")
        from install_lib import collector_setup as cs
        cs.deep_uninstall()
    else:
        info("Stopping collector service…")
        subprocess.run(["memento-collector", "uninstall"], check=False)

    # 2. Embedding
    info("Removing embedding service…")
    embedding_host.uninstall(remove_model_cache=deep, remove_venv=deep)

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
    p_install.add_argument("--dev", action="store_true",
                           help="Use local editable collector via `pip install -e ./collector`")
    p_install.set_defaults(func=_cmd_install)

    p_emb = sub.add_parser("embedding", help="Install embedding host service")
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
