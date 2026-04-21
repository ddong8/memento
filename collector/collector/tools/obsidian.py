"""Obsidian vault tool definition — watches the user's vault for markdown notes."""

from __future__ import annotations

from pathlib import Path

from ..config import CollectorConfig
from .base import (
    BaseTool, Category, ContentType, FileClassification, SyncStrategy, WatchPath,
)


class ObsidianTool(BaseTool):

    def __init__(self, vault_path: Path | None = None) -> None:
        self._vault_path = vault_path or CollectorConfig().obsidian_vault_path

    @property
    def name(self) -> str:
        return "obsidian"

    @property
    def display_name(self) -> str:
        return "Obsidian"

    @property
    def root_path(self) -> Path:
        return self._vault_path

    def get_watch_paths(self) -> list[WatchPath]:
        return [
            WatchPath(
                path=self.root_path,
                pattern="**/*.md",
                category=Category.NOTE,
                content_type=ContentType.MARKDOWN,
                recursive=True,
                description="All markdown notes in the vault",
            ),
        ]

    def classify_file(self, abs_path: Path) -> FileClassification | None:
        try:
            rel = abs_path.relative_to(self.root_path)
        except ValueError:
            return None

        # Skip .obsidian config directory and .trash
        parts = rel.parts
        if parts and parts[0] in (".obsidian", ".trash"):
            return None

        # Only markdown files
        if abs_path.suffix != ".md":
            return None

        rel_str = str(rel).replace("\\", "/")

        # Infer category from folder structure
        metadata: dict = {"vault_name": self.root_path.name}
        if len(parts) >= 2:
            metadata["folder"] = parts[0]

        return FileClassification(
            tool_name=self.name,
            category=Category.NOTE,
            content_type=ContentType.MARKDOWN,
            sync_strategy=SyncStrategy.FULL,
            relative_path=rel_str,
            metadata=metadata,
        )

    @property
    def excluded_paths(self) -> list[str]:
        root = str(self.root_path)
        return [
            f"{root}/.obsidian/**",
            f"{root}/.trash/**",
        ]
