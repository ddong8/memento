"""Retrieval evaluation: does Memento still find the right document?

A question set is generated once from the user's own documents (a question
someone would ask weeks later, answered by that document) and frozen under a
version number; rebuilding makes a new version rather than changing an old one,
so scores stay comparable. Each run asks every question through the exact
ranking Ask uses and scores whether the source document comes back, for the
fused result and for the keyword and semantic channels separately (so a drop
can be traced to one of them).
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import String, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, EvalCase, EvalRun, Machine, User
from .ai_provider import call_plain_chat
from .dreaming_service import SUBAGENT_PATH_REGEX, _safe_json_loads

logger = logging.getLogger("server.eval")

SET_SIZE = 60
PER_PROJECT = 3
DOCS_PER_CALL = 6
K = 10
REGRESSION = 0.08  # hit@5 drop below the best earlier run on the same set that is worth a warning
MRR_REGRESSION = 0.15  # same, as a share of the best MRR: catches answers sliding down inside the top 5
MIN_CHARS = 800


def score_ranks(ranks: list[int | None]) -> dict[str, float]:
    """ranks: 1-based rank of the expected document per question, None if not in the top K."""
    n = len(ranks) or 1

    def hit(k: int) -> float:
        return round(sum(1 for r in ranks if r is not None and r <= k) / n, 4)

    return {
        "hit1": hit(1),
        "hit5": hit(5),
        "hit10": hit(10),
        "mrr": round(sum(1.0 / r for r in ranks if r) / n, 4),
    }


def rank_of(expected: Any, ordered: list[Any]) -> int | None:
    for i, doc_id in enumerate(ordered[:K], 1):
        if doc_id == expected:
            return i
    return None


_QUESTION_PROMPT = """下面是一位开发者资料库里的几篇文档（对话记录、笔记、计划）。请为每篇写一个他几周后可能会问自己资料库的问题，这个问题的答案就在这篇文档里。

要求：
- 像真人随手问的一样自然，中文，15-40 字。
- 问的是文档里具体的事（某个决定、某个问题怎么解决的、某个配置/命令、某个结论），而不是"这篇文档讲了什么"。
- 不要照抄标题，不要出现文件名、路径、会话 ID。
- 如果文档内容太杂或没有值得问的，填 null。

{docs}

只输出 JSON：{{"questions": [{{"n": 1, "q": "..."}}]}}"""


async def _sample_documents(db: AsyncSession, user: User, size: int) -> list[Document]:
    machines = select(Machine.id).where(Machine.user_id == user.id)
    ranked = (
        select(
            Document.id,
            func.row_number().over(
                partition_by=func.coalesce(cast(Document.project_id, String), Document.tool_id),
                order_by=func.random(),
            ).label("rn"),
        )
        .where(
            Document.machine_id.in_(machines),
            Document.embedding_status == "ok",
            func.length(Document.content) >= MIN_CHARS,
            ~Document.relative_path.op("~")(SUBAGENT_PATH_REGEX),
            ~func.coalesce(Document.metadata_.has_key("parent_session_id"), False),
        )
        .subquery()
    )
    ids = (await db.execute(
        select(ranked.c.id).where(ranked.c.rn <= PER_PROJECT).order_by(func.random()).limit(size)
    )).scalars().all()
    if not ids:
        return []
    return list((await db.execute(select(Document).where(Document.id.in_(ids)))).scalars().all())


async def _questions_for(docs: list[Document]) -> dict[int, str]:
    blocks = []
    for n, d in enumerate(docs, 1):
        text = (d.ai_summary or "") + "\n" + (d.content or "")[:2500]
        blocks.append(f"### 文档 {n}：{d.title or ''}\n{text.strip()}")
    raw = await call_plain_chat(
        messages=[
            {"role": "system", "content": "You write evaluation questions for a retrieval system. Respond only with valid JSON."},
            {"role": "user", "content": _QUESTION_PROMPT.format(docs="\n\n".join(blocks))},
        ],
        max_tokens=1500,
    )
    if raw is None:
        raise RuntimeError("eval question generation got no answer from any AI provider")
    out: dict[int, str] = {}
    for item in _safe_json_loads(raw).get("questions") or []:
        try:
            n = int(item.get("n"))
        except (TypeError, ValueError, AttributeError):
            continue
        q = str(item.get("q") or "").strip()
        if 1 <= n <= len(docs) and 6 <= len(q) <= 120:
            out[n] = q
    return out


async def current_version(db: AsyncSession, user: User) -> int | None:
    return (await db.execute(
        select(func.max(EvalCase.set_version)).where(EvalCase.user_id == user.id)
    )).scalar()


async def build_set(db: AsyncSession, user: User, size: int = SET_SIZE) -> dict[str, Any]:
    """Generate a new frozen question set under the next version number."""
    version = (await current_version(db, user) or 0) + 1
    docs = await _sample_documents(db, user, size)
    await db.commit()
    created = 0
    for start in range(0, len(docs), DOCS_PER_CALL):
        chunk = docs[start:start + DOCS_PER_CALL]
        try:
            questions = await _questions_for(chunk)
        except Exception as e:
            logger.warning("eval question batch failed: %s", e)
            continue
        for n, q in questions.items():
            db.add(EvalCase(user_id=user.id, set_version=version, query=q, expected_doc_id=chunk[n - 1].id))
            created += 1
        await db.commit()
    if created == 0:
        raise RuntimeError("没有生成任何评测问题（资料太少，或 AI 调用失败）")
    return {"set_version": version, "cases": created}


def _config() -> dict[str, Any]:
    from .ask_retrieval import TOP_K
    from .embedding_service import CHUNK_COUNT_PENALTY, POOL_MIN, POOL_PER_DOC
    from ..api.search import RRF_K

    return {
        "rrf_k": RRF_K,
        "top_k": TOP_K,
        "k": K,
        "semantic_pool": {"min": POOL_MIN, "per_doc": POOL_PER_DOC},
        "chunk_count_penalty": CHUNK_COUNT_PENALTY,
        "embedding": os.environ.get("MEMENTO_EMBEDDING_MODEL", "bge-m3"),
        "build": os.environ.get("MEMENTO_BUILD_SHA", "")[:12],
    }


async def run_eval(db: AsyncSession, user: User, trigger: str = "scheduled", set_version: int | None = None) -> EvalRun:
    """Score the current (or given) set. Builds the first set if there is none."""
    from .ask_retrieval import hybrid_rank

    version = set_version or await current_version(db, user)
    if version is None:
        version = (await build_set(db, user))["set_version"]
    cases = (await db.execute(
        select(EvalCase).where(EvalCase.user_id == user.id, EvalCase.set_version == version).order_by(EvalCase.id)
    )).scalars().all()

    fused: list[int | None] = []
    keyword: list[int | None] = []
    semantic: list[int | None] = []
    semantic_empty = 0
    misses: list[dict[str, Any]] = []
    for case in cases:
        docs, kw_ids, sem_ids, _ = await hybrid_rank(db, user, case.query, None, None, k=K)
        order = [d.id for d in docs]
        r = rank_of(case.expected_doc_id, order)
        fused.append(r)
        keyword.append(rank_of(case.expected_doc_id, kw_ids))
        semantic.append(rank_of(case.expected_doc_id, sem_ids))
        semantic_empty += int(not sem_ids)
        if r is None and len(misses) < 10:
            misses.append({"query": case.query, "expected_doc_id": str(case.expected_doc_id)})

    metrics = {
        "hybrid": score_ranks(fused),
        "keyword": score_ranks(keyword),
        "semantic": score_ranks(semantic),
        "semantic_unavailable": semantic_empty,
        "misses": misses,
    }
    run = EvalRun(
        user_id=user.id, set_version=version, cases=len(cases), metrics=metrics, config=_config(), trigger=trigger,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    return run


def run_out(run: EvalRun) -> dict[str, Any]:
    return {
        "id": str(run.id),
        "set_version": run.set_version,
        "cases": run.cases,
        "metrics": run.metrics or {},
        "config": run.config or {},
        "trigger": run.trigger,
        "created_at": run.created_at.isoformat() if run.created_at else None,
    }


async def recent_runs(db: AsyncSession, user: User, limit: int = 12) -> list[EvalRun]:
    return list((await db.execute(
        select(EvalRun).where(EvalRun.user_id == user.id).order_by(EvalRun.created_at.desc()).limit(limit)
    )).scalars().all())


def regression(runs: list[EvalRun]) -> dict[str, Any] | None:
    """The latest run against the best earlier run on the same set (newest first in `runs`), if hit@5
    fell by REGRESSION or MRR by MRR_REGRESSION of its best.

    Against the best, not the previous run: on 2026-10-25 MRR was 0.28 against a best of 0.47 three
    weeks earlier, each weekly step too small to warn about, and hit@5 had barely moved."""
    if not runs:
        return None
    latest = runs[0]
    earlier = [r for r in runs[1:] if r.set_version == latest.set_version]

    def metric(run: EvalRun, key: str) -> float | None:
        value = ((run.metrics or {}).get("hybrid") or {}).get(key)
        return value if isinstance(value, (int, float)) else None

    for key, fell in (("hit5", lambda was, now: was - now >= REGRESSION),
                      ("mrr", lambda was, now: was > 0 and (was - now) / was >= MRR_REGRESSION)):
        now = metric(latest, key)
        was = max((v for v in (metric(r, key) for r in earlier) if v is not None), default=None)
        if now is not None and was is not None and fell(was, now):
            return {"metric": key, "now": now, "was": was, "set_version": latest.set_version}
    return None


async def eval_summary(db: AsyncSession, user: User) -> dict[str, Any]:
    runs = await recent_runs(db, user)
    stale_after = timedelta(days=10)
    latest = runs[0] if runs else None
    return {
        "set_version": await current_version(db, user),
        "latest": run_out(latest) if latest else None,
        "stale": bool(latest and latest.created_at and datetime.now(timezone.utc) - latest.created_at > stale_after),
        "trend": [
            {"at": r.created_at.isoformat() if r.created_at else None, "set_version": r.set_version,
             "hit5": ((r.metrics or {}).get("hybrid") or {}).get("hit5"),
             "mrr": ((r.metrics or {}).get("hybrid") or {}).get("mrr")}
            for r in reversed(runs)
        ],
        "regression": regression(runs),
    }
