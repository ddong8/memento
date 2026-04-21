"""Abstract base for AI tool definitions."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path


class ContentType(str, Enum):
    MARKDOWN = "markdown"
    JSONL = "jsonl"
    JSON = "json"
    TOML = "toml"
    SQLITE = "sqlite"
    TEXT = "text"
    BINARY = "binary"


class Category(str, Enum):
    CONFIG = "config"
    CONVERSATION = "conversation"
    MEMORY = "memory"
    HISTORY = "history"
    PLAN = "plan"
    SKILL = "skill"
    IDENTITY = "identity"
    LEARNING = "learning"
    DEBUG = "debug"
    EXTENSION = "extension"
    NOTE = "note"
    FILE_HISTORY = "file_history"
    STATE = "state"


class SyncStrategy(str, Enum):
    FULL = "full"           # Re-upload entire file on change
    DELTA = "delta"         # Send only new appended lines (for JSONL)
    POLL = "poll"           # Poll periodically (for SQLite)
    IGNORE = "ignore"       # Track but don't sync content


@dataclass
class WatchPath:
    """A path pattern to watch within a tool's root directory."""
    path: Path                          # Absolute path or glob base
    pattern: str                        # Glob pattern relative to path (e.g. "*.md", "**/*.jsonl")
    category: Category
    content_type: ContentType
    sync_strategy: SyncStrategy = SyncStrategy.FULL
    recursive: bool = False
    description: str = ""


@dataclass
class FileClassification:
    """Result of classifying a changed file."""
    tool_name: str
    category: Category
    content_type: ContentType
    sync_strategy: SyncStrategy
    relative_path: str                  # Path relative to tool root
    metadata: dict = field(default_factory=dict)  # Tool-specific metadata


class BaseTool(ABC):
    """Abstract base class for an AI tool data source."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Machine-readable tool identifier (e.g. 'claude_code')."""

    @property
    @abstractmethod
    def display_name(self) -> str:
        """Human-readable tool name (e.g. 'Claude Code')."""

    @property
    @abstractmethod
    def root_path(self) -> Path:
        """Root directory for this tool's data."""

    @abstractmethod
    def get_watch_paths(self) -> list[WatchPath]:
        """Return all paths to watch for this tool."""

    @abstractmethod
    def classify_file(self, abs_path: Path) -> FileClassification | None:
        """Classify a changed file. Returns None if file should be ignored."""

    def is_available(self) -> bool:
        """Check if the tool is installed / has data on this machine."""
        return self.root_path.exists()

    @property
    def excluded_paths(self) -> list[str]:
        """Glob patterns for paths to completely exclude (e.g. credentials)."""
        return []

    @property
    def sensitive_json_keys(self) -> list[str]:
        """JSON keys to strip from config files before syncing."""
        return []
