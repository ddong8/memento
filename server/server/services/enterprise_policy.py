"""Deployment-wide policy for enterprise installs (settings in config.py, see docs/enterprise.md).

- who sees whose content: `sees_all(user)`; admins and owners see everyone's only when
  MEMENTO_ADMIN_SCOPE=all (the default, how a personal deployment has always worked)
- which model endpoints users may configure: `model_endpoint_violation(...)`
"""

from __future__ import annotations

from urllib.parse import urlparse

from ..config import settings

ADMIN_ROLES = ("admin", "owner")


def is_admin(user) -> bool:
    """Manages the deployment: accounts, invites, permissions, audit log."""
    return getattr(user, "role", None) in ADMIN_ROLES


def sees_all(user) -> bool:
    """Sees (and acts on) every user's conversations, memory, devices and tasks."""
    return is_admin(user) and (settings.admin_scope or "all").strip().lower() != "own"


def _allowed_hosts() -> list[str]:
    return [h.strip().lower() for h in (settings.allowed_model_hosts or "").split(",") if h.strip()]


def host_allowed(url: str) -> bool:
    allowed = _allowed_hosts()
    if not allowed:
        return True
    host = (urlparse(url if "://" in url else f"//{url}").hostname or "").lower()
    if not host:
        return False
    for a in allowed:
        if a.startswith("*.") and (host == a[2:] or host.endswith(a[1:])):
            return True
        if host == a:
            return True
    return False


def model_endpoint_violation(data: dict) -> str | None:
    """A message when the settings name a model endpoint the deployment doesn't allow, else None."""
    for field in ("base_url", "fallback_base_url"):
        url = (data.get(field) or "").strip()
        if url and not host_allowed(url):
            host = urlparse(url if "://" in url else f"//{url}").hostname or url
            return f"管理员只允许使用指定的模型服务，{host} 不在允许范围内"
    return None
