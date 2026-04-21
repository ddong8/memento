"""Cross-platform compatibility helpers."""

from __future__ import annotations

from pathlib import Path


def normalize_path(p: str) -> str:
    """Normalize path separators to forward slashes for consistent cross-platform comparison."""
    return p.replace("\\", "/")


def normalize_excluded(patterns: list[str]) -> list[str]:
    """Normalize excluded path patterns for cross-platform glob matching."""
    return [p.replace("\\", "/") for p in patterns]


def rel_str(path: Path, root: Path) -> str | None:
    """Get normalized relative path string, or None if not relative to root."""
    try:
        return normalize_path(str(path.relative_to(root)))
    except ValueError:
        return None


def path_starts_with(path_str: str, root_str: str) -> bool:
    """Cross-platform path prefix check using Path.relative_to."""
    try:
        Path(path_str).relative_to(Path(root_str))
        return True
    except ValueError:
        return False
