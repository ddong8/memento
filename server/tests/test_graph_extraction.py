"""Knowledge extraction must not hold a transaction open across the LLM call.

It used to delete a document's observations, then wait minutes on the LLM with the row locks held:
concurrent syncs of the same conversation queued behind each other until the database cut them off.
"""

import time
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server.db.models import Document
from server.services import graph_service


def _doc(**meta) -> Document:
    return Document(
        id=uuid.uuid4(),
        category="memory",
        content="部署流水线等待 CI 的上限改成 40 分钟。" * 20,
        metadata_=dict(meta),
        knowledge_attempts=0,
        knowledge_status="pending",
    )


def _db(calls: list[str]) -> MagicMock:
    db = MagicMock()

    async def execute(stmt, *a, **k):
        calls.append("delete" if str(stmt).lstrip().upper().startswith("DELETE") else "select")
        res = MagicMock()
        res.scalar_one_or_none.return_value = None
        return res

    async def commit():
        calls.append("commit")

    db.execute = AsyncMock(side_effect=execute)
    db.commit = AsyncMock(side_effect=commit)
    db.refresh = AsyncMock()
    db.flush = AsyncMock()
    return db


@pytest.mark.asyncio
async def test_llm_runs_outside_a_transaction_and_old_observations_go_after_it():
    calls: list[str] = []
    db = _db(calls)

    async def llm(prompt, user=None):
        calls.append("llm")
        return {"entities": [], "relations": [], "observations": []}

    doc = _doc()
    with patch.object(graph_service, "_call_llm", side_effect=llm):
        await graph_service.extract_knowledge_from_document(db, doc, user_id=uuid.uuid4())

    assert calls.index("commit") < calls.index("llm") < calls.index("delete")
    assert doc.knowledge_status == "ok"
    assert doc.knowledge_attempts == 0
    assert isinstance(doc.metadata_.get("_graph_at"), float)


@pytest.mark.asyncio
async def test_failed_llm_leaves_observations_alone():
    calls: list[str] = []
    doc = _doc()
    with patch.object(graph_service, "_call_llm", AsyncMock(return_value=None)):
        await graph_service.extract_knowledge_from_document(_db(calls), doc, user_id=uuid.uuid4())

    assert "delete" not in calls
    assert doc.knowledge_status == "failed"
    assert doc.knowledge_attempts == 1


@pytest.mark.asyncio
async def test_skips_a_document_another_replica_is_extracting():
    from server.services.cluster import cluster

    llm = AsyncMock()
    with patch.object(cluster, "mutex", AsyncMock(return_value=None)), patch.object(graph_service, "_call_llm", llm):
        assert await graph_service.extract_knowledge_from_document(_db([]), _doc(), user_id=uuid.uuid4()) == 0
    llm.assert_not_called()


def test_recent_extraction_defers_the_next_one():
    assert graph_service.extracted_recently(_doc(_graph_at=time.time() - 60))
    assert not graph_service.extracted_recently(_doc(_graph_at=time.time() - graph_service.GRAPH_MIN_INTERVAL - 1))
    assert not graph_service.extracted_recently(_doc())
