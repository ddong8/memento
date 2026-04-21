#!/usr/bin/env python3
"""One-time migration from the old "daily_report" branding to "memento".

Handles (in order):
  1. Rewrite `.env` and `.env.local` — rename DR_* keys to MEMENTO_*
  2. Rename Postgres database   daily_report → memento
  3. Rename MinIO bucket        daily-report → memento  (copy + delete)
  4. Drain Celery queues stored under the old app name
  5. Move collector data dir    ~/.daily-report → ~/.memento
  6. Move collector logs        ~/Library/Logs/daily_report or equivalent → …/memento
  7. Clean legacy MCP entries named "daily-report-memory" from AI tool configs
  8. Advise on re-installing PyPI packages

Usage:
    python scripts/migrate_rebrand.py           # dry-run (default — shows what would change)
    python scripts/migrate_rebrand.py --apply   # actually perform changes
    python scripts/migrate_rebrand.py --apply --skip-docker   # only client-side steps

Prereqs for the server-side steps:
  - Docker stack reachable via the existing docker-compose.yml
  - Stack MUST be stopped before running migration (the script will verify)
  - `mc` (MinIO client) available on PATH for the bucket rename, OR the script
    falls back to boto3 copy+delete.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Env key rename map (only the DR_ prefix — POSTGRES_PASSWORD / MINIO_ROOT_* stay)
_ENV_RENAMES = {
    "DR_SECRET_KEY": "MEMENTO_SECRET_KEY",
    "DR_COLLECTOR_TOKEN": "MEMENTO_COLLECTOR_TOKEN",
    "DR_AI_API_KEY": "MEMENTO_AI_API_KEY",
    "DR_AI_BASE_URL": "MEMENTO_AI_BASE_URL",
    "DR_AI_MODEL": "MEMENTO_AI_MODEL",
    "DR_OWNER_EMAIL": "MEMENTO_OWNER_EMAIL",
    "DR_DATABASE_URL": "MEMENTO_DATABASE_URL",
    "DR_REDIS_URL": "MEMENTO_REDIS_URL",
    "DR_SERVER_URL": "MEMENTO_SERVER_URL",
    "DR_SERVER_TOKEN": "MEMENTO_SERVER_TOKEN",
    "DR_S3_ENDPOINT": "MEMENTO_S3_ENDPOINT",
    "DR_S3_ACCESS_KEY": "MEMENTO_S3_ACCESS_KEY",
    "DR_S3_SECRET_KEY": "MEMENTO_S3_SECRET_KEY",
    "DR_EMBEDDING_SERVER_URL": "MEMENTO_EMBEDDING_SERVER_URL",
    "DR_EMBEDDING_DIM": "MEMENTO_EMBEDDING_DIM",
    "DR_EMBEDDING_API_KEY": "MEMENTO_EMBEDDING_API_KEY",
    "DR_EMBEDDING_BASE_URL": "MEMENTO_EMBEDDING_BASE_URL",
    "DR_EMBEDDING_MODEL": "MEMENTO_EMBEDDING_MODEL",
    "DR_EMBEDDING_PORT": "MEMENTO_EMBEDDING_PORT",
    "DR_EMBEDDING_MODEL_NAME": "MEMENTO_EMBEDDING_MODEL_NAME",
    "DR_COMPACTION_AGE_DAYS": "MEMENTO_COMPACTION_AGE_DAYS",
    "DR_ANTHROPIC_API_KEY": "MEMENTO_ANTHROPIC_API_KEY",
    "DR_DEBUG": "MEMENTO_DEBUG",
    "DR_PORT": "MEMENTO_PORT",
    # S.Variable: collector setup helpers (non-file, but listed for consistency)
    "DR_NONINTERACTIVE": "MEMENTO_NONINTERACTIVE",
    "DR_OBSIDIAN_VAULT": "MEMENTO_OBSIDIAN_VAULT",
    "DR_OBSIDIAN_VAULT_PATH": "MEMENTO_OBSIDIAN_VAULT_PATH",
    "DR_INSTALL_PYTHON": "MEMENTO_INSTALL_PYTHON",
    "DR_INSTALL_DIR": "MEMENTO_INSTALL_DIR",
    "DR_VERSION": "MEMENTO_VERSION",
    "DR_REPO_URL": "MEMENTO_REPO_URL",
    "DR_MIRROR_URL": "MEMENTO_MIRROR_URL",
    "DR_EMBEDDING_PYTHON": "MEMENTO_EMBEDDING_PYTHON",
}


def say(msg: str) -> None:
    print(f"  → {msg}")


def ok(msg: str) -> None:
    print(f"\033[32m✓\033[0m {msg}")


def warn(msg: str) -> None:
    print(f"\033[33m!\033[0m {msg}")


def err(msg: str) -> None:
    print(f"\033[31m✗\033[0m {msg}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────
# Step 1: .env files
# ─────────────────────────────────────────────────────────────

def _migrate_env_file(path: Path, apply: bool) -> int:
    if not path.exists():
        return 0
    lines = path.read_text().splitlines()
    new_lines = []
    changed = 0
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            new_lines.append(line)
            continue
        if "=" not in line:
            new_lines.append(line)
            continue
        key, _, value = line.partition("=")
        k = key.strip()
        if k in _ENV_RENAMES:
            new_key = _ENV_RENAMES[k]
            new_lines.append(f"{new_key}={value}")
            changed += 1
            say(f"{path.name}: {k} → {new_key}")
        else:
            new_lines.append(line)
    if changed and apply:
        backup = path.with_suffix(path.suffix + ".pre-memento")
        if not backup.exists():
            shutil.copy2(path, backup)
        path.write_text("\n".join(new_lines) + "\n")
    return changed


def step_env_files(apply: bool) -> None:
    print("\n[1/7] Rewrite .env files")
    total = 0
    for name in (".env", ".env.local"):
        total += _migrate_env_file(REPO_ROOT / name, apply)
    if total == 0:
        ok("no DR_* keys found in .env files")
    elif apply:
        ok(f"{total} env key(s) renamed (backups saved as *.pre-memento)")
    else:
        warn(f"{total} env key(s) would be renamed (dry-run)")


# ─────────────────────────────────────────────────────────────
# Step 2: Postgres DB rename
# ─────────────────────────────────────────────────────────────

def _check_compose_down() -> bool:
    """Return True if the compose stack is fully stopped."""
    try:
        r = subprocess.run(
            ["docker", "ps", "--filter", "name=memento_", "--format", "{{.Names}}"],
            capture_output=True, text=True, check=False,
        )
        running = [n for n in r.stdout.splitlines() if n.strip()]
        if running:
            err(f"these containers are still running: {', '.join(running)}")
            err("run `docker compose down` before migrating")
            return False
        return True
    except FileNotFoundError:
        err("docker not found on PATH")
        return False


def step_postgres(apply: bool) -> None:
    print("\n[2/7] Rename Postgres database daily_report → memento")
    if not _check_compose_down():
        return
    # Start only postgres temporarily
    env_path = REPO_ROOT / ".env"
    pg_password = None
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("POSTGRES_PASSWORD="):
                pg_password = line.split("=", 1)[1].strip()
                break
    if not pg_password:
        warn("POSTGRES_PASSWORD not in .env — skipping DB rename")
        return

    if not apply:
        warn("would: docker compose up -d postgres; ALTER DATABASE daily_report RENAME TO memento; down")
        return

    subprocess.run(["docker", "compose", "up", "-d", "postgres"], check=True, cwd=str(REPO_ROOT))
    try:
        # Wait for postgres to be ready
        for _ in range(30):
            r = subprocess.run(
                ["docker", "exec", "memento_postgres", "pg_isready", "-U", "postgres"],
                capture_output=True,
            )
            if r.returncode == 0:
                break
            import time as _t
            _t.sleep(1)
        else:
            err("postgres did not become ready in 30s")
            return
        # Does old DB exist?
        r = subprocess.run(
            ["docker", "exec", "memento_postgres", "psql", "-U", "postgres", "-tAc",
             "SELECT 1 FROM pg_database WHERE datname='daily_report'"],
            capture_output=True, text=True,
        )
        if r.stdout.strip() != "1":
            ok("daily_report database does not exist — nothing to rename")
            return
        # Does new DB already exist?
        r = subprocess.run(
            ["docker", "exec", "memento_postgres", "psql", "-U", "postgres", "-tAc",
             "SELECT 1 FROM pg_database WHERE datname='memento'"],
            capture_output=True, text=True,
        )
        if r.stdout.strip() == "1":
            err("memento database already exists — manual resolution required (rename or drop one)")
            return
        r = subprocess.run(
            ["docker", "exec", "memento_postgres", "psql", "-U", "postgres", "-c",
             "ALTER DATABASE daily_report RENAME TO memento"],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            err(f"rename failed: {r.stderr}")
        else:
            ok("database renamed: daily_report → memento")
    finally:
        subprocess.run(["docker", "compose", "down"], check=False, cwd=str(REPO_ROOT))


# ─────────────────────────────────────────────────────────────
# Step 3: MinIO bucket rename
# ─────────────────────────────────────────────────────────────

def step_minio(apply: bool) -> None:
    print("\n[3/7] Rename MinIO bucket daily-report → memento")
    print("  (no built-in rename — copies objects then deletes old bucket)")
    if not apply:
        warn("would: start minio, copy objects daily-report/* → memento/*, delete old bucket")
        return

    env_path = REPO_ROOT / ".env"
    user, password = None, None
    for line in env_path.read_text().splitlines() if env_path.exists() else []:
        if line.startswith("MINIO_ROOT_USER="):
            user = line.split("=", 1)[1].strip()
        if line.startswith("MINIO_ROOT_PASSWORD="):
            password = line.split("=", 1)[1].strip()
    if not user or not password:
        warn("MINIO_ROOT_USER/PASSWORD not in .env — skipping bucket rename")
        return

    if not _check_compose_down():
        return
    subprocess.run(["docker", "compose", "up", "-d", "minio"], check=True, cwd=str(REPO_ROOT))
    try:
        import time as _t
        _t.sleep(5)  # give minio a moment
        # Use boto3 to avoid depending on mc being installed
        try:
            import boto3
            from botocore.exceptions import ClientError
        except ImportError:
            err("boto3 not installed. `pip install boto3` then re-run.")
            return
        s3 = boto3.client(
            "s3",
            endpoint_url="http://localhost:9000",
            aws_access_key_id=user,
            aws_secret_access_key=password,
        )
        buckets = {b["Name"] for b in s3.list_buckets().get("Buckets", [])}
        if "daily-report" not in buckets:
            ok("daily-report bucket does not exist — nothing to rename")
            return
        if "memento" not in buckets:
            s3.create_bucket(Bucket="memento")
            ok("created memento bucket")
        # Copy objects
        paginator = s3.get_paginator("list_objects_v2")
        copied = 0
        for page in paginator.paginate(Bucket="daily-report"):
            for obj in page.get("Contents", []):
                s3.copy_object(
                    Bucket="memento",
                    Key=obj["Key"],
                    CopySource={"Bucket": "daily-report", "Key": obj["Key"]},
                )
                copied += 1
        ok(f"copied {copied} object(s) to memento bucket")
        # Delete old bucket contents + bucket
        for page in paginator.paginate(Bucket="daily-report"):
            objs = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objs:
                s3.delete_objects(Bucket="daily-report", Delete={"Objects": objs})
        s3.delete_bucket(Bucket="daily-report")
        ok("old daily-report bucket deleted")
    finally:
        subprocess.run(["docker", "compose", "down"], check=False, cwd=str(REPO_ROOT))


# ─────────────────────────────────────────────────────────────
# Step 4: drain Celery queues under old app name
# ─────────────────────────────────────────────────────────────

def step_celery_queues(apply: bool) -> None:
    print("\n[4/7] Drain stale Celery queues from Redis")
    if not apply:
        warn("would: FLUSHDB on the Celery broker DB (default redis DB 0)")
        warn("       safe because Celery queues are ephemeral by design")
        return
    if not _check_compose_down():
        return
    subprocess.run(["docker", "compose", "up", "-d", "redis"], check=True, cwd=str(REPO_ROOT))
    try:
        import time as _t
        _t.sleep(2)
        r = subprocess.run(
            ["docker", "exec", "memento_redis", "redis-cli", "FLUSHDB"],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            ok("Redis DB 0 flushed — Celery will recreate queues under the new app name on first start")
        else:
            err(f"FLUSHDB failed: {r.stderr}")
    finally:
        subprocess.run(["docker", "compose", "down"], check=False, cwd=str(REPO_ROOT))


# ─────────────────────────────────────────────────────────────
# Step 5: collector data dir
# ─────────────────────────────────────────────────────────────

def step_collector_dirs(apply: bool) -> None:
    print("\n[5/7] Move collector data + log directories")
    home = Path.home()
    moves = [
        (home / ".daily-report", home / ".memento"),
        (home / "Library" / "Logs" / "daily_report",
         home / "Library" / "Logs" / "memento"),
        (home / ".local" / "share" / "daily_report" / "logs",
         home / ".local" / "share" / "memento" / "logs"),
    ]
    # Windows
    localappdata = os.environ.get("LOCALAPPDATA")
    if localappdata:
        moves.append((Path(localappdata) / "daily_report" / "logs",
                      Path(localappdata) / "memento" / "logs"))

    for src, dst in moves:
        if not src.exists():
            continue
        if dst.exists():
            warn(f"{dst} already exists — skipping (merge manually if needed)")
            continue
        if not apply:
            say(f"would move {src} → {dst}")
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        ok(f"moved {src} → {dst}")


# ─────────────────────────────────────────────────────────────
# Step 6: clean legacy MCP entries (they are stale once old pkg uninstalled)
# ─────────────────────────────────────────────────────────────

def _strip_legacy_mcp_entry(path: Path, apply: bool) -> bool:
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text())
    except Exception:
        return False
    if not isinstance(data, dict) or not isinstance(data.get("mcpServers"), dict):
        return False
    if "daily-report-memory" not in data["mcpServers"]:
        return False
    if not apply:
        say(f"would strip 'daily-report-memory' from {path}")
        return True
    del data["mcpServers"]["daily-report-memory"]
    path.write_text(json.dumps(data, indent=2))
    ok(f"stripped 'daily-report-memory' from {path}")
    return True


def step_mcp_entries(apply: bool) -> None:
    print("\n[6/7] Strip legacy MCP entries")
    home = Path.home()
    found = False
    for p in [
        home / ".claude.json",
        home / ".cursor" / "mcp.json",
        home / ".config" / "windsurf" / "mcp.json",
        home / "Library" / "Application Support" / "antigravity" / "mcp.json",
    ]:
        if _strip_legacy_mcp_entry(p, apply):
            found = True
    if not found:
        ok("no legacy MCP entries found")


# ─────────────────────────────────────────────────────────────
# Step 7: advise PyPI package migration
# ─────────────────────────────────────────────────────────────

def step_pypi_advice(apply: bool) -> None:
    print("\n[7/7] PyPI packages (manual step)")
    print("  PyPI package names changed:")
    print("    daily-report-collector → memento-collector")
    print("    daily-report-memory    → memento-memory")
    print()
    print("  To migrate client-side, run:")
    print("    pip uninstall -y daily-report-collector daily-report-memory")
    print("    pip install    memento-collector memento-memory")
    print("    memento-collector setup   # re-register MCP entries under new name")


# ─────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true", help="Actually perform changes (default: dry-run)")
    ap.add_argument("--skip-docker", action="store_true",
                    help="Skip Postgres/MinIO/Redis steps (client-side only)")
    args = ap.parse_args()

    print("Memento rebrand migration" + ("" if args.apply else "  [DRY-RUN — use --apply to commit]"))

    step_env_files(args.apply)
    if not args.skip_docker:
        step_postgres(args.apply)
        step_minio(args.apply)
        step_celery_queues(args.apply)
    step_collector_dirs(args.apply)
    step_mcp_entries(args.apply)
    step_pypi_advice(args.apply)

    print()
    if args.apply:
        ok("Migration complete. Start the stack with `./install.sh` or `docker compose up -d`.")
    else:
        warn("Dry-run only. Re-run with --apply to commit the changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
