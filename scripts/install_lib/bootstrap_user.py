"""First-user registration: prompt email/password, POST /api/auth/register.

First registrant is auto-promoted to 'owner' by the server and receives a
`collector_token`. We save the token to .env.local so re-runs skip the prompt.
"""

from __future__ import annotations

import getpass
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from .platform_utils import REPO_ROOT, info, ok, warn

ENV_LOCAL = REPO_ROOT / ".env.local"
API_BASE = "http://localhost:8001"


def _parse_env_local() -> dict[str, str]:
    if not ENV_LOCAL.exists():
        return {}
    result: dict[str, str] = {}
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        result[k.strip()] = v.strip()
    return result


def _write_env_local(values: dict[str, str]) -> None:
    lines = ["# Local-only values written by ./install.sh (never commit)"]
    for k, v in values.items():
        lines.append(f"{k}={v}")
    ENV_LOCAL.write_text("\n".join(lines) + "\n")
    try:
        ENV_LOCAL.chmod(0o600)
    except OSError:
        pass


def _valid_email(s: str) -> bool:
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", s))


def _post_json(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from None


def _prompt_credentials(interactive: bool) -> tuple[str, str, str | None]:
    if not interactive or not sys.stdin.isatty():
        raise RuntimeError(
            "No TTY and no pre-seeded credentials. "
            "Re-run ./install.sh in an interactive terminal, "
            "or register manually at http://localhost:3001/auth/register."
        )
    print()
    print("Create the first user (auto-promoted to owner):")
    while True:
        email = input("  Email: ").strip()
        if _valid_email(email):
            break
        warn("Invalid email, try again.")
    name = input("  Display name [optional]: ").strip() or None
    while True:
        pw1 = getpass.getpass("  Password (≥8 chars): ")
        if len(pw1) < 8:
            warn("Too short. Try again.")
            continue
        pw2 = getpass.getpass("  Confirm password: ")
        if pw1 != pw2:
            warn("Did not match. Try again.")
            continue
        break
    return email, pw1, name


def ensure_first_user(interactive: bool = True) -> str:
    """Return collector_token for the owner user.

    If .env.local already has MEMENTO_COLLECTOR_TOKEN, return it as-is.
    Otherwise prompt for email/password, POST register, save token.
    """
    existing = _parse_env_local()
    token = existing.get("MEMENTO_COLLECTOR_TOKEN")
    if token:
        ok(f"Owner user already registered (token in .env.local).")
        return token

    email, password, name = _prompt_credentials(interactive)
    info(f"Registering {email} with the API…")
    payload: dict = {"email": email, "password": password}
    if name:
        payload["name"] = name
    data = _post_json(f"{API_BASE}/api/auth/register", payload)

    token = data.get("collector_token")
    role = data.get("role")
    if not token:
        raise RuntimeError(
            "Server did not return a collector_token. "
            "You may not be the first user. "
            "Register at http://localhost:3001/auth/register "
            "and copy the token from your profile page."
        )

    _write_env_local({
        "MEMENTO_OWNER_EMAIL": email,
        "MEMENTO_COLLECTOR_TOKEN": token,
    })
    ok(f"Registered {email} (role={role}). Token saved to .env.local.")
    return token


def print_token_banner(token: str, email: str | None = None) -> None:
    line = "─" * 64
    who = email or "owner"
    print()
    print(line)
    print(f"  Collector token for {who}:")
    print(f"  {token}")
    print(line)
    print()
