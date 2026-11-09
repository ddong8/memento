"""Vectors for long-term memories.

Ask ranks memories by how close they are to the question (ask_retrieval.retrieve_core_memories), and
the nightly reconcile compares each new memory with the ones closest to it. Until 11-09 only dreaming
wrote vectors, for what it touched that night within 10 seconds, and the hand-written path gave the
provider 3: 119 of 596 active memories had one, none of the 205 pitfalls and none written by hand, by
the session review, by MCP or at bootstrap. The writers stay as they are; a pass every 10 minutes
embeds whatever has no vector, and a changed text drops its old one (db/models.py) so the pass embeds
the new text.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Collection, Sequence
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from ..db.models import UserMemory
from .embedding_service import _call_embedding_server

logger = logging.getLogger("server.memory_vectors")

EMBED_CHARS = 800  # what dreaming has always embedded
EMBED_BATCH = 32
BACKFILL_LIMIT = 400
# Reconcile shows the model the memories closest to each new one. On 11-09 reworded duplicate pitfalls
# scored 0.83-0.98 against each other, and so did related but different ones: the model decides.
NEIGHBOR_MIN_SIM = 0.80
NEIGHBORS = 5


def memory_text(mem: UserMemory) -> str:
    return (mem.content or "")[:EMBED_CHARS]


async def embed_memories(db: AsyncSession, memories: Sequence[UserMemory], timeout: float = 60.0) -> int:
    """Give each memory without a vector one; returns how many got one. Stops quietly while the
    provider is down (the next pass retries). Doesn't commit.

    Written with a plain UPDATE that keeps updated_at: a vector isn't an edit, and reconcile and the
    session review read updated_at as "changed lately"."""
    todo = [m for m in memories if m.embedding is None and (m.content or "").strip()]
    done = 0
    for start in range(0, len(todo), EMBED_BATCH):
        part = todo[start:start + EMBED_BATCH]
        vectors = await _call_embedding_server([memory_text(m) for m in part], timeout=timeout)
        if not vectors or len(vectors) != len(part):
            break
        for mem, vec in zip(part, vectors):
            if not vec:
                continue
            result = await db.execute(
                update(UserMemory)
                .where(UserMemory.id == mem.id, UserMemory.content == mem.content)  # not if it was edited meanwhile
                .values(embedding=vec, updated_at=UserMemory.updated_at)
                .execution_options(synchronize_session=False)
            )
            if result.rowcount:
                set_committed_value(mem, "embedding", vec)
                done += 1
    return done


async def backfill_memory_vectors(db: AsyncSession, limit: int = BACKFILL_LIMIT) -> dict[str, Any]:
    """Embed active memories that have no vector, newest first. Commits."""
    missing = list((await db.execute(
        select(UserMemory).where(
            UserMemory.status == "active", UserMemory.is_folder.is_(False), UserMemory.embedding.is_(None),
        ).order_by(UserMemory.updated_at.desc()).limit(limit)
    )).scalars().all())
    embedded = await embed_memories(db, missing) if missing else 0
    await db.commit()
    return {"missing": len(missing), "embedded": embedded}


async def nearest_memories(
    db: AsyncSession,
    user_id: uuid.UUID,
    vector: Sequence[float],
    *,
    categories: Collection[str] | None = None,
    exclude: Collection[uuid.UUID] = (),
    limit: int = NEIGHBORS,
    min_sim: float = NEIGHBOR_MIN_SIM,
) -> list[UserMemory]:
    """The user's active memories closest to `vector` (cosine similarity at least `min_sim`), closest first."""
    distance = UserMemory.embedding.cosine_distance(list(vector))
    query = select(UserMemory).where(
        UserMemory.user_id == user_id,
        UserMemory.status == "active",
        UserMemory.is_folder.is_(False),
        UserMemory.embedding.is_not(None),
        distance <= 1 - min_sim,
    )
    if categories:
        query = query.where(UserMemory.category.in_(list(categories)))
    if exclude:
        query = query.where(UserMemory.id.not_in(list(exclude)))
    return list((await db.execute(query.order_by(distance).limit(limit))).scalars().all())
