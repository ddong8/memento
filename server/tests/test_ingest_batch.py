"""POST /api/ingest/files takes several small files in one request.

On 2026-10-28 a Windows collector catching up sent 1,600 small files one request each, 440 a
minute. Each file in a batch is committed on its own, so one that fails leaves the others in."""
import asyncio
import types
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.api import ingest


def _req(n):
    return ingest.IngestFilesRequest(files=[
        ingest.IngestFileRequest(tool="claude_code", category="conversation", content_type="json",
                                 relative_path=f"projects/p/{i}.json", hash=f"h{i}", content="{}")
        for i in range(n)
    ])


def _run(req, ingest_side_effect):
    db = MagicMock(commit=AsyncMock(), rollback=AsyncMock())
    user = types.SimpleNamespace(id=uuid.uuid4())
    machine = types.SimpleNamespace(id=uuid.uuid4())
    calls = []

    async def fake_ingest(**kw):
        calls.append(kw)
        return ingest_side_effect(kw)

    with patch.object(ingest, "ensure_device", AsyncMock(return_value=machine)), \
         patch.object(ingest, "lock_slice", AsyncMock()), \
         patch.object(ingest, "ingest_file", fake_ingest):
        out = asyncio.run(ingest.ingest_files_endpoint(
            req, _collector_user=user, _throttle=None, db=db,
            x_device_id="d", x_device_name="n", x_device_platform="win32",
        ))
    return out, calls, db, user, machine


def test_each_file_is_ingested_in_order_for_the_device():
    out, calls, db, user, machine = _run(_req(3), lambda kw: types.SimpleNamespace(id=kw["relative_path"]))
    assert [r["ok"] for r in out["results"]] == [True, True, True]
    assert [r["document_id"] for r in out["results"]] == [f"projects/p/{i}.json" for i in range(3)]
    assert {c["machine_id"] for c in calls} == {str(machine.id)}
    assert {c["user_id"] for c in calls} == {str(user.id)}
    assert db.commit.await_count == 4  # the device, then each file


def test_one_failing_file_leaves_the_others_in():
    def side(kw):
        if kw["relative_path"].endswith("1.json"):
            raise RuntimeError("boom")
        return types.SimpleNamespace(id="ok")

    out, calls, db, *_ = _run(_req(3), side)
    assert [r["ok"] for r in out["results"]] == [True, False, True]
    assert "boom" in out["results"][1]["error"]
    assert len(calls) == 3
    db.rollback.assert_awaited_once()


def test_a_batch_is_bounded():
    import pydantic
    import pytest

    with pytest.raises(pydantic.ValidationError):
        _req(101)
    with pytest.raises(pydantic.ValidationError):
        ingest.IngestFilesRequest(files=[])
