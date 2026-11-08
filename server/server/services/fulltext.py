"""Keyword matching over document_search: through its GIN index, with query terms weighted by rarity."""

from __future__ import annotations

import math
import time
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import DocumentSearch

# A term in more than this share of the indexed documents doesn't pick candidates, it only ranks them
COMMON_TERM_SHARE = 0.05
_DF_TTL = 600.0
_DF_MAX = 5000
_df_cache: dict[str, tuple[float, int]] = {}
_n_cache: tuple[float, int] | None = None


async def use_fulltext_index(db: AsyncSession) -> None:
    """Make `@@` on document_search use its GIN index for the rest of this transaction.

    The planner seq-scans it anyway: the table is small (6.5k rows on 2026-11-09) but every tsvector
    is TOASTed (the index alone is 155 MB), and the match operator's cost is underestimated while
    detoasting isn't costed at all, so each question read ~36k buffers. Measured on prod: Ask's
    keyword query p50 181 -> 99 ms over 80 real questions, the search page 134 -> 23 ms."""
    await db.execute(text("SET LOCAL enable_seqscan = off"))


async def _doc_freq(db: AsyncSession, terms: list[str]) -> tuple[int, dict[str, int]]:
    """(indexed documents, {term: documents containing it}); counts kept 10 minutes, only nonzero ones
    (a term nobody wrote yet may turn up in the next sync)."""
    global _n_cache
    now = time.monotonic()
    df = {t: hit[1] for t in terms if (hit := _df_cache.get(t)) and hit[0] > now}
    todo = [t for t in terms if t not in df]
    if not todo and _n_cache and _n_cache[0] > now:
        return _n_cache[1], df
    row = (await db.execute(select(
        select(func.count()).select_from(DocumentSearch).scalar_subquery(),
        *(select(func.count()).select_from(DocumentSearch)
          .where(DocumentSearch.content_tsv.op("@@")(func.to_tsquery("simple", t))).scalar_subquery()
          for t in todo),
    ))).one()
    n = int(row[0] or 0)
    _n_cache = (now + _DF_TTL, n)
    if len(_df_cache) > _DF_MAX:
        _df_cache.clear()
    for t, c in zip(todo, row[1:]):
        df[t] = int(c or 0)
        if df[t]:
            _df_cache[t] = (now + _DF_TTL, df[t])
    return n, df


def _idf(n: int, df: int) -> float:
    """BM25's idf: a term in half the documents counts ~0.7, one in a single document of 6.5k ~8.4."""
    return math.log(1 + (n - df + 0.5) / (df + 0.5))


async def keyword_match(db: AsyncSession, terms: list[str]) -> tuple[str, Any]:
    """The tsquery that picks a question's candidates and the score that ranks them.

    ts_rank alone has no idf: a long conversation full of 项目/接口/提交 outranked the one note holding
    k8tz or f3b7a7d. So the candidates are the documents with one of the question's rare terms, ranked
    by every term's ts_rank weighted with its idf; a question of common words only keeps plain ts_rank
    over all of them. Replayed on eval set v2 (48 questions): keyword MRR 0.425 -> 0.543, fused hit@5
    0.688 -> 0.771 and MRR 0.505 -> 0.627; on 80 real Ask questions p50 83 ms, p95 177 ms (was 181/308)."""
    n, df = await _doc_freq(db, terms)
    rare = [t for t in terms if 0 < df.get(t, 0) <= n * COMMON_TERM_SHARE]
    if not rare:
        everything = " | ".join(terms)
        return everything, func.ts_rank(DocumentSearch.content_tsv, func.to_tsquery("simple", everything), 1)
    rank = sum(
        _idf(n, df[t]) * func.ts_rank(DocumentSearch.content_tsv, func.to_tsquery("simple", t), 1)
        for t in terms if df.get(t)
    )
    return " | ".join(rare), rank
