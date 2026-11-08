"""Which of several devices' copies of a project's PROJECT_BLUEPRINT.md describes the newest code.

Each device uploads the blueprint of its own checkout, and synced_at moves on every sync, so the copy
synced last can be a checkout weeks behind (2026-11-09: a laptop still at a 10-17 commit kept winning
over the 11-09 one). The generator's header names the checkout's commit and that commit's date, and
the summary and section 9 list recent commits as `hash` (date), which tells an ancestor apart.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
import re
from typing import TypeVar

T = TypeVar("T")

_COMMIT = re.compile(r"Commit: `([0-9a-f]{7,40})`")
_UPDATED = re.compile(r"Updated: `(\d{4}-\d{2}-\d{2})`")
_HISTORY = re.compile(r"`([0-9a-f]{7,40})` \((\d{4}-\d{2}-\d{2})\)")
# The header sits in the first lines
_HEAD_CHARS = 2000


@dataclass(frozen=True)
class BlueprintCopy:
    commit: str
    date: str
    history: frozenset[str]
    synced: datetime | None


def blueprint_copy(content: str | None, synced: datetime | None) -> BlueprintCopy:
    text = content if isinstance(content, str) else ""
    head = text[:_HEAD_CHARS]
    commit = m.group(1) if (m := _COMMIT.search(head)) else ""
    history = _HISTORY.findall(text)
    date = m.group(1) if (m := _UPDATED.search(head)) else max((d for _, d in history), default="")
    return BlueprintCopy(commit, date, frozenset(h for h, _ in history), synced)


def _same(a: str, b: str) -> bool:
    # Short hashes grow a digit once a repo has more objects: the same commit can be 8 or 9 digits
    return bool(a and b) and (a.startswith(b) or b.startswith(a))


def is_fresher(a: BlueprintCopy, b: BlueprintCopy) -> bool:
    """Whether copy a describes newer code than copy b."""
    if _same(a.commit, b.commit):
        return _later(a.synced, b.synced)
    if b.commit and any(_same(h, b.commit) for h in a.history):
        return True
    if a.commit and any(_same(h, a.commit) for h in b.history):
        return False
    if a.date and b.date and a.date != b.date:
        return a.date > b.date
    return _later(a.synced, b.synced)


def _later(a: datetime | None, b: datetime | None) -> bool:
    if a is None or b is None:
        return a is not None
    return a > b


def pick_freshest(
    items: Iterable[T],
    content: Callable[[T], str | None],
    synced: Callable[[T], datetime | None],
) -> T | None:
    """The item whose blueprint content describes the newest code; items without content are skipped."""
    best: T | None = None
    best_copy: BlueprintCopy | None = None
    for item in items:
        text = content(item)
        if not isinstance(text, str) or not text:
            continue
        copy = blueprint_copy(text, synced(item))
        if best_copy is None or is_fresher(copy, best_copy):
            best, best_copy = item, copy
    return best
