"""Cursor tool definition — watches ~/.cursor/ for conversations, skills, config."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import unquote

from ..config import TOOL_PATHS, HOME
from .claude_code import _extract_cwd_from_jsonl


def _load_workspace_storage_map() -> dict[str, str]:
    """Load project_hash → real_path mapping from Cursor's workspaceStorage.

    Cursor (VS Code fork) stores workspace info in:
      ~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/workspace.json
      {"folder": "file:///Users/.../project_name"}

    The <hash> is NOT the same as the project directory hash in ~/.cursor/projects/,
    but the folder URI maps to the same real path.
    """
    import platform
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        ws_root = home / "Library" / "Application Support" / "Cursor" / "User" / "workspaceStorage"
    elif system == "Windows":
        import os
        appdata = Path(os.environ.get("APPDATA", str(home / "AppData" / "Roaming")))
        ws_root = appdata / "Cursor" / "User" / "workspaceStorage"
    else:
        ws_root = home / ".config" / "Cursor" / "User" / "workspaceStorage"

    if not ws_root.exists():
        return {}

    # Build mapping: for each workspace.json, extract folder URI → real path
    # Then match against project hashes by comparing normalized path endings
    uri_to_path: dict[str, str] = {}
    for ws_dir in ws_root.iterdir():
        wj = ws_dir / "workspace.json"
        if not wj.exists():
            continue
        try:
            data = json.loads(wj.read_text(encoding="utf-8"))
            folder = data.get("folder", "")
            if folder.startswith("file:///"):
                decoded = unquote(folder[7:] if system != "Windows" else folder[8:])
                uri_to_path[decoded] = decoded
        except Exception:
            continue

    return uri_to_path


def _match_hash_to_workspace(project_hash: str, workspaces: dict[str, str]) -> str | None:
    """Match a Cursor project hash to a real workspace path.

    Hash: 'Users-haixingdong-Desktop-dev-ft-userdata'
    Path: '/Users/haixingdong/Desktop/dev/ft_userdata'

    Strategy: normalize both to lowercase with separators removed, compare.
    """
    # Normalize hash: strip leading -, replace - with empty for comparison
    hash_norm = project_hash.strip("-").lower().replace("-", "")

    for real_path in workspaces:
        # Normalize path: strip leading /, replace / and _ and - with empty
        path_norm = real_path.strip("/").lower().replace("/", "").replace("_", "").replace("-", "").replace("\\", "")
        if hash_norm == path_norm:
            return real_path

    return None
from .base import (
    BaseTool, Category, ContentType, FileClassification, SyncStrategy, WatchPath,
)


class CursorTool(BaseTool):

    _project_path_cache: dict[str, str | None] = {}
    _workspace_map: dict[str, str] | None = None

    def _get_workspace_map(self) -> dict[str, str]:
        if self._workspace_map is None:
            self._workspace_map = _load_workspace_storage_map()
        return self._workspace_map

    def _resolve_project_path(self, project_hash: str) -> str | None:
        """Resolve hash to real path via Cursor's workspaceStorage."""
        if project_hash not in self._project_path_cache:
            # Primary: match against workspaceStorage workspace.json mappings
            result = _match_hash_to_workspace(project_hash, self._get_workspace_map())
            if not result:
                # Fallback: try cwd from JSONL
                result = _extract_cwd_from_jsonl(self.root_path / "projects" / project_hash)
            self._project_path_cache[project_hash] = result
        return self._project_path_cache[project_hash]

    @property
    def name(self) -> str:
        return "cursor"

    @property
    def display_name(self) -> str:
        return "Cursor"

    @property
    def root_path(self) -> Path:
        return TOOL_PATHS["cursor"]

    def get_watch_paths(self) -> list[WatchPath]:
        if not self.is_available():
            return []
        root = self.root_path
        return [
            # Config
            WatchPath(
                path=root,
                pattern="argv.json",
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                description="Cursor argv configuration",
            ),
            # Extensions
            WatchPath(
                path=root / "extensions",
                pattern="extensions.json",
                category=Category.EXTENSION,
                content_type=ContentType.JSON,
                description="Installed extensions",
            ),
            # Agent transcripts (conversations) — same format as Claude Code
            WatchPath(
                path=root / "projects",
                pattern="**/*.jsonl",
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.DELTA,
                recursive=True,
                description="Agent conversation transcripts",
            ),
            # Project MCP instructions
            WatchPath(
                path=root / "projects",
                pattern="**/*.md",
                category=Category.MEMORY,
                content_type=ContentType.MARKDOWN,
                recursive=True,
                description="MCP instructions and project rules",
            ),
            # Project metadata
            WatchPath(
                path=root / "projects",
                pattern="**/*.json",
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                recursive=True,
                description="Project and MCP metadata",
            ),
            # skills-cursor/ = built-in skill templates (like Codex vendor_imports), skip
            # AI tracking database
            WatchPath(
                path=root / "ai-tracking",
                pattern="*.db",
                category=Category.STATE,
                content_type=ContentType.SQLITE,
                sync_strategy=SyncStrategy.POLL,
                description="AI code tracking database",
            ),
        ]

    def classify_file(self, abs_path: Path) -> FileClassification | None:
        if not self.is_available():
            return None
        try:
            rel = abs_path.relative_to(self.root_path)
        except ValueError:
            return None

        rel_str = str(rel).replace("\\", "/")
        parts = rel.parts

        # Skip cache, crashpad, etc.
        skip = {".gitignore"}
        if abs_path.name in skip:
            return None

        # argv.json
        if rel_str == "argv.json":
            return FileClassification(
                tool_name=self.name, category=Category.CONFIG,
                content_type=ContentType.JSON, sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
            )

        # extensions
        if rel_str == "extensions/extensions.json":
            return FileClassification(
                tool_name=self.name, category=Category.EXTENSION,
                content_type=ContentType.JSON, sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
            )

        # projects/ — agent transcripts
        if parts and parts[0] == "projects":
            if abs_path.suffix == ".jsonl":
                dir_hash = parts[1] if len(parts) >= 2 else ""
                real_path = self._resolve_project_path(dir_hash) if dir_hash else None
                project_name = real_path.replace("\\", "/").rstrip("/").split("/")[-1] if real_path else dir_hash
                is_subagent = "subagents" in parts
                meta: dict = {
                    "project_hash": project_name,
                    "session_id": abs_path.stem,
                    "is_subagent": is_subagent,
                }
                if real_path:
                    meta["project_path"] = real_path
                return FileClassification(
                    tool_name=self.name, category=Category.CONVERSATION,
                    content_type=ContentType.JSONL, sync_strategy=SyncStrategy.DELTA,
                    relative_path=rel_str,
                    metadata=meta,
                )
            if abs_path.suffix == ".md":
                return FileClassification(
                    tool_name=self.name, category=Category.MEMORY,
                    content_type=ContentType.MARKDOWN, sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                )
            if abs_path.suffix == ".json":
                return FileClassification(
                    tool_name=self.name, category=Category.CONFIG,
                    content_type=ContentType.JSON, sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                )

        # skills-cursor/ = built-in templates, skip
        if parts and parts[0] == "skills-cursor":
            return None

        # ai-tracking
        if parts and parts[0] == "ai-tracking" and abs_path.suffix == ".db":
            return FileClassification(
                tool_name=self.name, category=Category.STATE,
                content_type=ContentType.SQLITE, sync_strategy=SyncStrategy.POLL,
                relative_path=rel_str,
            )

        return None
