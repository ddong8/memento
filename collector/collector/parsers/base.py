"""Abstract parser interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class ParseResult:
    """Parsed file content ready for sync."""
    content: str                        # Main text content
    title: str = ""                     # Extracted title (if any)
    metadata: dict[str, Any] = field(default_factory=dict)
    line_count: int = 0
    is_partial: bool = False            # True for delta syncs
    offset: int = 0                     # Byte offset for delta syncs


class BaseParser(ABC):

    @abstractmethod
    def parse(self, path: Path, offset: int = 0) -> ParseResult:
        """Parse file content starting from byte offset.

        Args:
            path: Absolute path to the file.
            offset: Byte offset to start reading from (for delta sync).
                    0 means read the entire file.

        Returns:
            ParseResult with extracted content and metadata.
        """

    @abstractmethod
    def can_parse(self, path: Path) -> bool:
        """Check if this parser can handle the given file."""
