"""Antigravity tool definition — watches ~/.antigravity/ and ~/.gemini/antigravity/."""

from __future__ import annotations

from pathlib import Path

import os
import platform

from ..config import TOOL_PATHS, HOME
from .base import (
    BaseTool, Category, ContentType, FileClassification, SyncStrategy, WatchPath,
)

# Antigravity stores conversations and brain data in ~/.gemini/ (Unix) or %APPDATA%/.gemini (Windows)
if platform.system() == "Windows":
    _appdata = Path(os.environ.get("APPDATA", str(HOME / "AppData" / "Roaming")))
    GEMINI_ROOT = _appdata / ".gemini" if (_appdata / ".gemini").exists() else HOME / ".gemini"
else:
    GEMINI_ROOT = HOME / ".gemini"


class AntigravityTool(BaseTool):

    @property
    def name(self) -> str:
        return "antigravity"

    @property
    def display_name(self) -> str:
        return "Antigravity"

    @property
    def root_path(self) -> Path:
        return TOOL_PATHS["antigravity"]

    @property
    def _gemini_path(self) -> Path:
        return GEMINI_ROOT / "antigravity"

    def is_available(self) -> bool:
        return self.root_path.exists() or self._gemini_path.exists()

    def get_watch_paths(self) -> list[WatchPath]:
        root = self.root_path
        gemini = self._gemini_path
        paths = [
            # VS Code config
            WatchPath(
                path=root,
                pattern="argv.json",
                category=Category.CONFIG,
                content_type=ContentType.JSON,
                description="VS Code argv configuration",
            ),
            WatchPath(
                path=root / "extensions",
                pattern="extensions.json",
                category=Category.EXTENSION,
                content_type=ContentType.JSON,
                description="Installed extension registry",
            ),
        ]

        # GEMINI.md (user rules) — skip brain plans (too noisy, duplicated)
        if gemini.exists():
            paths.append(
                WatchPath(
                    path=GEMINI_ROOT,
                    pattern="GEMINI.md",
                    category=Category.IDENTITY,
                    content_type=ContentType.MARKDOWN,
                    description="Gemini user rules file",
                ),
            )
            # Encrypted conversation .pb files — real-time updates via watchdog
            paths.append(
                WatchPath(
                    path=gemini / "conversations",
                    pattern="*.pb",
                    category=Category.CONVERSATION,
                    content_type=ContentType.JSONL,
                    description="Encrypted Antigravity conversation trajectories",
                ),
            )

        return paths

    def classify_file(self, abs_path: Path) -> FileClassification | None:
        # Try ~/.antigravity/ first
        try:
            rel = abs_path.relative_to(self.root_path)
            rel_str = str(rel).replace("\\", "/")

            if rel_str == "argv.json":
                return FileClassification(
                    tool_name=self.name, category=Category.CONFIG,
                    content_type=ContentType.JSON, sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                )
            if rel_str == "extensions/extensions.json":
                return FileClassification(
                    tool_name=self.name, category=Category.EXTENSION,
                    content_type=ContentType.JSON, sync_strategy=SyncStrategy.FULL,
                    relative_path=rel_str,
                )
            return None
        except ValueError:
            pass

        # Try ~/.gemini/
        try:
            rel = abs_path.relative_to(GEMINI_ROOT)
            rel_str = str(rel).replace("\\", "/")
            parts = rel.parts
        except ValueError:
            return None

        # GEMINI.md
        if rel_str == "GEMINI.md":
            return FileClassification(
                tool_name=self.name, category=Category.IDENTITY,
                content_type=ContentType.MARKDOWN, sync_strategy=SyncStrategy.FULL,
                relative_path=f"gemini/{rel_str}",
            )

        # Encrypted conversation .pb files — decrypted and decoded by
        # antigravity_export.export_conversations() at the watcher level.
        # Return a special classification that the watcher recognizes.
        if (
            len(parts) >= 3
            and parts[0] == "antigravity"
            and parts[1] == "conversations"
            and abs_path.suffix == ".pb"
        ):
            cascade_id = abs_path.stem
            return FileClassification(
                tool_name=self.name,
                category=Category.CONVERSATION,
                content_type=ContentType.JSONL,
                sync_strategy=SyncStrategy.FULL,
                relative_path=f"conversations/{cascade_id}.jsonl",
                metadata={"__antigravity_pb__": True, "session_id": cascade_id},
            )

        return None

    @property
    def excluded_paths(self) -> list[str]:
        root = str(self.root_path)
        gemini = str(GEMINI_ROOT)
        return [
            f"{root}/extensions/*/dist/**",
            f"{root}/extensions/*/bundled/**",
            f"{root}/extensions/*/node_modules/**",
            # Skip everything under antigravity/ EXCEPT conversations/*.pb (handled above)
            f"{gemini}/antigravity/implicit/**",
            f"{gemini}/antigravity/code_tracker/**",
            f"{gemini}/antigravity/brain/**",
            f"{gemini}/antigravity/browser_recordings/**",
            f"{gemini}/antigravity-browser-profile/**",
        ]
