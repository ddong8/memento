"""Claude Code tool definition — watches ~/.claude/ for all data types."""

from __future__ import annotations

import json
from pathlib import Path

from ..config import TOOL_PATHS
from .base import (
    BaseTool, Category, ContentType, FileClassification, SyncStrategy, WatchPath,
)


def _extract_cwd_from_jsonl(project_dir: Path) -> str | None:
    """Extract the real working directory from the first JSONL with a cwd field."""
    try:
        for jsonl in project_dir.glob("*.jsonl"):
            with open(jsonl, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line or '"cwd"' not in line:
                        continue
                    obj = json.loads(line)
                    cwd = obj.get("cwd")
                    if cwd:
                        return cwd
            break  # only need one file
    except Exception:
        pass
    return None


class ClaudeCodeTool(BaseTool):

    _project_path_cache: dict[str, str | None] = {}

    def _resolve_project_path(self, project_hash: str) -> str | None:
        """Resolve project_hash directory name to real filesystem path via cwd in JSONL."""
        if project_hash not in self._project_path_cache:
            project_dir = self.root_path / "projects" / project_hash
            result = _extract_cwd_from_jsonl(project_dir)
            if not result:
                from .cursor import _resolve_hash_to_path
                result = _resolve_hash_to_path(project_hash)
            self._project_path_cache[project_hash] = result
        return self._project_path_cache[project_hash]

    @property
    def name(self) -> str:
        return "claude_code"

    @property
    def display_name(self) -> str:
        return "Claude Code"

    @property
    def root_path(self) -> Path:
        return TOOL_PATHS["claude_code"]

    def get_watch_paths(self) -> list[WatchPath]:
        root = self.root_path
        return [
            # Global config
            WatchPath(
                path=root,
                pattern="settings.json",
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                description="Global model/env settings",
            ),
            # Plans
            WatchPath(
                path=root / "plans",
                pattern="*.md",
                category=Category.PLAN,
                content_type=ContentType.MARKDOWN,
                description="AI-assisted project plans",
            ),
            # Conversations (per-project JSONL files)
            WatchPath(
                path=root / "projects",
                pattern="**/*.jsonl",
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.DELTA,
                recursive=True,
                description="Session conversation transcripts",
            ),
            # Sub-agent metadata
            WatchPath(
                path=root / "projects",
                pattern="**/*.meta.json",
                category=Category.CONVERSATION,
                content_type=ContentType.JSON,
                recursive=True,
                description="Sub-agent metadata (type, description)",
            ),
            # Project memory
            WatchPath(
                path=root / "projects",
                pattern="**/memory/*.md",
                category=Category.MEMORY,
                content_type=ContentType.MARKDOWN,
                recursive=True,
                description="Per-project long-term memory files",
            ),
            # Command history
            WatchPath(
                path=root,
                pattern="history.jsonl",
                category=Category.HISTORY,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.DELTA,
                description="Command/query history",
            ),
        ]

    def classify_file(self, abs_path: Path) -> FileClassification | None:
        try:
            rel = abs_path.relative_to(self.root_path)
        except ValueError:
            return None

        rel_str = str(rel).replace("\\", "/")
        parts = rel.parts

        # Exclude telemetry, backups, cache, IDE locks, paste-cache, sessions, debug
        skip_dirs = {"telemetry", "backups", "cache", "ide", "paste-cache",
                     "sessions", "session-env", "shell-snapshots", "downloads",
                     "plugins", "file-history", "debug"}
        if parts and parts[0] in skip_dirs:
            return None

        # settings.json
        if rel_str == "settings.json":
            return FileClassification(
                tool_name=self.name,
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
            )

        # Plans
        if parts[0] == "plans" and abs_path.suffix == ".md":
            return FileClassification(
                tool_name=self.name,
                category=Category.PLAN,
                content_type=ContentType.MARKDOWN,
                sync_strategy=SyncStrategy.FULL,
                relative_path=rel_str,
                metadata={"plan_name": abs_path.stem},
            )

        # history.jsonl
        if rel_str == "history.jsonl":
            return FileClassification(
                tool_name=self.name,
                category=Category.HISTORY,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.DELTA,
                relative_path=rel_str,
            )

        # Projects directory
        if parts[0] == "projects" and len(parts) >= 2:
            dir_hash = parts[1]
            # Resolve to real project path/name
            real_path = self._resolve_project_path(dir_hash)
            if real_path:
                project_name = real_path.replace("\\", "/").rstrip("/").split("/")[-1]
            else:
                project_name = dir_hash
            project_meta = {"project_hash": project_name}
            if real_path:
                project_meta["project_path"] = real_path

            # Memory files
            if "memory" in parts and abs_path.suffix == ".md":
                return FileClassification(
                    tool_name=self.name,
                    category=Category.MEMORY,
                    content_type=ContentType.MARKDOWN,
                    sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                    metadata=project_meta,
                )

            # Sub-agent metadata
            if abs_path.suffix == ".json" and abs_path.stem.endswith(".meta"):
                return FileClassification(
                    tool_name=self.name,
                    category=Category.CONVERSATION,
                    content_type=ContentType.JSON,
                    sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                    metadata={**project_meta, "is_subagent_meta": True},
                )

            # Conversation JSONL
            if abs_path.suffix == ".jsonl":
                is_subagent = "subagents" in parts
                return FileClassification(
                    tool_name=self.name,
                    category=Category.CONVERSATION,
                    content_type=ContentType.JSONL,
                    sync_strategy=SyncStrategy.DELTA,
                    relative_path=rel_str,
                    metadata={
                        **project_meta,
                        "session_id": abs_path.stem,
                        "is_subagent": is_subagent,
                    },
                )

            # tool-results directory — skip (large, transient)
            if "tool-results" in parts:
                return None

        return None

    @property
    def excluded_paths(self) -> list[str]:
        root = str(self.root_path)
        return [
            f"{root}/telemetry/**",
            f"{root}/backups/**",
            f"{root}/cache/**",
            f"{root}/ide/**",
            f"{root}/paste-cache/**",
            f"{root}/sessions/**",
            f"{root}/session-env/**",
            f"{root}/shell-snapshots/**",
            f"{root}/downloads/**",
            f"{root}/plugins/**",
            f"{root}/file-history/**",
            f"{root}/debug/**",
        ]
