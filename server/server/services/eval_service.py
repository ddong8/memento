"""Retrieval evaluation: does Memento still find the right document?

A question set is generated once from the user's own documents (a question
someone would ask weeks later, answered by that document) and frozen under a
version number; rebuilding makes a new version rather than changing an old one,
so scores stay comparable. Each question comes with the sentence that answers
it, quoted from the document and checked against it: set v1 had none, and of
its 10 misses 5 asked about another document of the batch and 5 about the
session header or system prompt every conversation shares. Each run asks every question through the exact
ranking Ask uses and scores whether the source document comes back, for the
fused result and for the keyword and semantic channels separately (so a drop
can be traced to one of them).
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import String, cast, exists, func, select
from sqlalchemy import case as sql_case
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from ..db.models import CHAT_MESSAGE, ConversationMessage, Document, EvalCase, EvalRun, Machine, User
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
EXCERPT_CHARS = 3000
MIN_EVIDENCE = 8  # characters, whitespace aside
STALE_REBUILD = 0.2  # share of cases whose answer left the document that makes the scheduled run write a new set
# Listings the collector writes (tool discovery, shell history, configs): nobody asks their resources about these
GENERATED_CATEGORIES = ("discovery", "history", "config", "extension")


class NoMaterial(RuntimeError):
    """The user has no documents to ask about yet (a new account): nothing to evaluate, not a failure."""


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


_QUESTION_PROMPT = """下面是一位开发者资料库里的几篇文档（和 AI 的对话、笔记、计划、记忆）。请为每篇写一个他几周后可能会问自己资料库的问题，这个问题的答案就在这篇文档的原文里。

要求：
- 像真人随手问的一样自然，中文，15-40 字。
- 问的是文档里具体的事（某个决定、某个问题怎么解决的、某个配置/命令/数值、某个结论），问题里带上能认出这件事的具体名词（项目、功能、工具、报错）。
- 不要问换一篇文档也成立的泛泛问题，比如用的什么模型、CLI 版本、权限或沙箱设置、系统提示词、"那次会话做了什么"。
- 不要照抄标题，不要出现文件名、路径、会话 ID。
- e 填这篇文档原文里能回答这个问题的那句话，逐字摘抄 10-80 字，不要改写、不要拼接。
- 如果文档内容太杂或没有值得问的，q 填 null。

{docs}

只输出 JSON：{{"questions": [{{"n": 1, "q": "...", "e": "..."}}]}}"""


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
            Document.category.notin_(GENERATED_CATEGORIES),
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
    # A conversation's content can be millions of characters; its passages come from its messages
    return list((await db.execute(
        select(Document).options(defer(Document.content)).where(Document.id.in_(ids))
    )).scalars().all())


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text).lower()


async def _passages(db: AsyncSession, doc: Document) -> list[str]:
    """What the question writer sees of a document. A conversation's content is the raw log, whose
    first 2500 characters are the session header and system prompt: use its dialogue instead."""
    if doc.category != "conversation":
        head = (await db.execute(select(func.left(Document.content, EXCERPT_CHARS)).where(Document.id == doc.id))).scalar()
        return [head or ""]
    rows = (await db.execute(
        select(ConversationMessage.role, ConversationMessage.content)
        .where(ConversationMessage.document_id == doc.id, CHAT_MESSAGE)
        .order_by(ConversationMessage.line_number)
        .limit(80)
    )).all()
    out: list[str] = []
    used = 0
    for role, content in rows:
        text = (content or "").strip()
        if not text or text.startswith("[AI 思考"):
            continue
        text = f"{'用户' if role == 'user' else 'AI'}：{text[:EXCERPT_CHARS - used]}"
        out.append(text)
        used += len(text)
        if used >= EXCERPT_CHARS:
            break
    return out


def _grounded(evidence: str, passages: list[str]) -> bool:
    e = _norm(evidence)
    return len(e) >= MIN_EVIDENCE and any(e in _norm(p) for p in passages)


async def _questions_for(docs: list[Document], passages: list[list[str]]) -> dict[int, tuple[str, str]]:
    """{doc number: (question, evidence)} for the questions whose quote is in a document's text, under
    the document that holds it (the writer sometimes numbers a question after the wrong one)."""
    blocks = []
    for n, (d, parts) in enumerate(zip(docs, passages), 1):
        summary = f"摘要：{d.ai_summary.strip()}\n" if d.ai_summary else ""
        body = "\n".join(parts)
        blocks.append(f"### 文档 {n}：{d.title or ''}\n{summary}原文：\n{body.strip()}")
    raw = await call_plain_chat(
        messages=[
            {"role": "system", "content": "You write evaluation questions for a retrieval system. Respond only with valid JSON."},
            {"role": "user", "content": _QUESTION_PROMPT.format(docs="\n\n".join(blocks))},
        ],
        max_tokens=2000,
    )
    if raw is None:
        raise RuntimeError("eval question generation got no answer from any AI provider")
    out: dict[int, tuple[str, str]] = {}
    for item in _safe_json_loads(raw).get("questions") or []:
        if not isinstance(item, dict):
            continue
        q = str(item.get("q") or "").strip()
        e = str(item.get("e") or "").strip()
        if not 6 <= len(q) <= 120 or q.lower() == "null":
            continue
        holders = [n for n, parts in enumerate(passages, 1) if _grounded(e, parts)]
        if len(holders) == 1 and holders[0] not in out:
            out[holders[0]] = (q, e)
    return out


async def answer_still_there(db: AsyncSession, doc_id: Any, category: str | None, content: str | None, evidence: str) -> bool:
    """content: the document's text, None for a conversation (searched in its messages)."""
    e = _norm(evidence)
    if category != "conversation":
        return e in _norm(content or "")
    return bool((await db.execute(select(exists().where(
        ConversationMessage.document_id == doc_id,
        CHAT_MESSAGE,
        func.strpos(func.lower(func.regexp_replace(ConversationMessage.content, r"\s+", "", "g")), e) > 0,
    )))).scalar())


async def current_version(db: AsyncSession, user: User) -> int | None:
    return (await db.execute(
        select(func.max(EvalCase.set_version)).where(EvalCase.user_id == user.id)
    )).scalar()


async def build_set(db: AsyncSession, user: User, size: int = SET_SIZE) -> dict[str, Any]:
    """Generate a new frozen question set under the next version number."""
    version = (await current_version(db, user) or 0) + 1
    docs = await _sample_documents(db, user, size)
    if not docs:
        raise NoMaterial("还没有可出题的资料")
    passages = [await _passages(db, d) for d in docs]
    # A conversation whose messages are all tool output has nothing to ask about
    keep = [i for i, parts in enumerate(passages) if sum(len(p) for p in parts) >= 300]
    docs, passages = [docs[i] for i in keep], [passages[i] for i in keep]
    await db.commit()
    created = 0
    for start in range(0, len(docs), DOCS_PER_CALL):
        chunk = docs[start:start + DOCS_PER_CALL]
        try:
            questions = await _questions_for(chunk, passages[start:start + DOCS_PER_CALL])
        except Exception as e:
            logger.warning("eval question batch failed: %s", e)
            continue
        for n, (q, e) in questions.items():
            db.add(EvalCase(user_id=user.id, set_version=version, query=q, expected_doc_id=chunk[n - 1].id, evidence=e))
            created += 1
        await db.commit()
    logger.info("eval set v%d for user %s: %d questions from %d documents", version, user.id, created, len(docs))
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
    all_cases = (await db.execute(
        select(EvalCase).where(EvalCase.user_id == user.id, EvalCase.set_version == version).order_by(EvalCase.id)
    )).scalars().all()
    quoted = {c.expected_doc_id for c in all_cases if c.evidence}
    texts = {row.id: row for row in (await db.execute(
        select(Document.id, Document.category,
               sql_case((Document.category == "conversation", None), else_=Document.content).label("content"))
        .where(Document.id.in_(quoted))
    )).all()} if quoted else {}
    cases = []
    stale = 0
    for c in all_cases:
        # A rewritten note or a pruned conversation may no longer answer its question: that's not a miss
        doc = texts.get(c.expected_doc_id)
        if c.evidence and (doc is None or not await answer_still_there(db, doc.id, doc.category, doc.content, c.evidence)):
            stale += 1
            continue
        cases.append(c)

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
            misses.append({"query": case.query, "expected_doc_id": str(case.expected_doc_id), "evidence": case.evidence})

    metrics = {
        "hybrid": score_ranks(fused),
        "keyword": score_ranks(keyword),
        "semantic": score_ranks(semantic),
        "semantic_unavailable": semantic_empty,
        "stale": stale,
        "grounded": any(c.evidence for c in all_cases),
        "misses": misses,
    }
    run = EvalRun(
        user_id=user.id, set_version=version, cases=len(cases), metrics=metrics, config=_config(), trigger=trigger,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    return run


def needs_new_set(run: EvalRun) -> bool:
    """After a scheduled run: write a new set when this one predates the quoted answers, or too many of
    its answers have left their documents for the score to mean much."""
    m = run.metrics or {}
    if not m.get("grounded"):
        return True
    total = run.cases + int(m.get("stale") or 0)
    return total > 0 and (m.get("stale") or 0) / total >= STALE_REBUILD


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
