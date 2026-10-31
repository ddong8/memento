import asyncio
import time
import pytest

from server.api.devices import _matches_etag
from server.services.ask_stream import _clean_stderr_noise, _coalesced_device_stream
from server.services.cache import (
    l1_cache_delete,
    l1_cache_delete_prefix,
    l1_cache_get,
    l1_cache_set,
)


def test_clean_stderr_noise():
    raw = (
        "npm WARN deprecated inflight@1.0.6: This module is not supported\n"
        "(node:1234) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n"
        "/app/site-packages/urllib3:12: UserWarning: Unverified HTTPS request\n"
        "FATAL: Database connection failed on port 5432\n"
        "Switched to branch 'feature/fix'\n"
        "Error: Invalid configuration option\n"
    )
    cleaned = _clean_stderr_noise(raw)
    assert "FATAL: Database connection failed on port 5432" in cleaned
    assert "Error: Invalid configuration option" in cleaned
    assert "npm WARN" not in cleaned
    assert "punycode" not in cleaned
    assert "UserWarning" not in cleaned
    assert "Switched to branch" not in cleaned


def test_clean_stderr_noise_all_noise():
    raw = (
        "npm notice created a lockfile\n"
        "npm WARN audit check failed\n"
        "(node:999) ExperimentalWarning: VM Modules is an experimental feature\n"
    )
    cleaned = _clean_stderr_noise(raw)
    assert cleaned == ""


def test_matches_etag():
    etag = '"3a8bf012"'
    assert _matches_etag('"3a8bf012"', etag) is True
    assert _matches_etag("3a8bf012", etag) is True
    assert _matches_etag('*', etag) is True
    assert _matches_etag('W/"3a8bf012"', etag) is True
    assert _matches_etag('"other", "3a8bf012"', etag) is True
    assert _matches_etag('"nonexistent"', etag) is False
    assert _matches_etag(None, etag) is False
    assert _matches_etag("", etag) is False


def test_l1_cache_operations():
    l1_cache_delete_prefix("test:")

    # 1. Store with short TTL
    l1_cache_set("test:short", {"data": 123}, ttl_seconds=0.05)
    assert l1_cache_get("test:short") == {"data": 123}

    # Wait for expiration
    time.sleep(0.06)
    assert l1_cache_get("test:short") is None

    # 2. Store with ttl=0 (no expiration)
    l1_cache_set("test:zero_ttl", {"persist": True}, ttl_seconds=0)
    assert l1_cache_get("test:zero_ttl") == {"persist": True}

    # 3. Explicit delete
    l1_cache_delete("test:zero_ttl")
    assert l1_cache_get("test:zero_ttl") is None

    # 4. Prefix delete
    l1_cache_set("test:p1", 1, ttl_seconds=10)
    l1_cache_set("test:p2", 2, ttl_seconds=10)
    deleted = l1_cache_delete_prefix("test:p")
    assert deleted == 2
    assert l1_cache_get("test:p1") is None
    assert l1_cache_get("test:p2") is None


@pytest.mark.asyncio
async def test_coalesced_device_stream():
    # Mock generator for _tool_run_on_device
    async def mock_events():
        # High frequency micro chunks with sequence numbers
        yield {"type": "task_chunk", "task_id": "t1", "stream": "stdout", "device_name": "mac", "text": "Hel", "seq": 1}
        yield {"type": "task_chunk", "task_id": "t1", "stream": "stdout", "device_name": "mac", "text": "lo ", "seq": 2}
        yield {"type": "task_chunk", "task_id": "t1", "stream": "stdout", "device_name": "mac", "text": "World", "seq": 3}
        # Different event type triggers immediate flush
        yield {"type": "task_progress", "task_id": "t1", "status": "running"}
        # New chunk
        yield {"type": "task_chunk", "task_id": "t1", "stream": "stdout", "device_name": "mac", "text": "!", "seq": 4}

    from unittest.mock import patch

    with patch("server.services.orchestrator._tool_run_on_device", return_value=mock_events()):
        results = []
        async for evt in _coalesced_device_stream(None, None, {}, delay=0.020):
            results.append(evt)

        # 3 micro chunks coalesced into 1 with latest seq = 3
        assert results[0] == {
            "type": "task_chunk",
            "task_id": "t1",
            "stream": "stdout",
            "device_name": "mac",
            "text": "Hello World",
            "seq": 3,
        }
        assert results[1] == {"type": "task_progress", "task_id": "t1", "status": "running"}
        assert results[2] == {
            "type": "task_chunk",
            "task_id": "t1",
            "stream": "stdout",
            "device_name": "mac",
            "text": "!",
            "seq": 4,
        }


def test_ws_manager_push_chunk_with_seq():
    from server.services.ws_manager import ws_manager

    task_id = "test_task_seq_1"
    q = asyncio.Queue()
    ws_manager._task_queues[task_id] = q

    try:
        ws_manager.push_chunk(task_id, "stdout", "hello", seq=42)
        evt = q.get_nowait()
        assert evt["type"] == "task_chunk"
        assert evt["task_id"] == task_id
        assert evt["stream"] == "stdout"
        assert evt["text"] == "hello"
        assert evt["seq"] == 42
    finally:
        ws_manager._task_queues.pop(task_id, None)


def test_user_memory_hnsw_index_declaration():
    from sqlalchemy.dialects import postgresql
    from sqlalchemy.schema import CreateIndex
    from server.db.models import UserMemory

    hnsw_index = next((idx for idx in UserMemory.__table__.indexes if idx.name == "idx_user_memories_embedding_hnsw"), None)
    assert hnsw_index is not None
    assert hnsw_index.dialect_options["postgresql"]["using"] == "hnsw"
    assert hnsw_index.dialect_options["postgresql"]["ops"] == {"embedding": "vector_cosine_ops"}

    sql = str(CreateIndex(hnsw_index).compile(dialect=postgresql.dialect()))
    assert "CREATE INDEX idx_user_memories_embedding_hnsw ON user_memories USING hnsw (embedding vector_cosine_ops)" in sql


def test_register_domain_scenario():
    from server.services.mind_resonance_service import (
        detect_scenario,
        get_all_scenarios,
        register_domain_scenario,
        reset_scenarios_to_default,
        unregister_scenario,
    )

    reset_scenarios_to_default()
    scen = {
        "id": "deep_reinforcement_learning",
        "name": "强化学习与策略微调",
        "keywords": ["ppo", "grpo", "rlhf", "reward model"],
        "mindset": "奖励函数设计需具备鲁棒性，严禁奖励作弊与过拟合。",
        "target_project": "rl_trainer",
        "anchors": ["PPO", "RLHF", "Reward"],
        "defense_rules": ["1) 策略更新前必须检查梯度裁剪与 KL 散度约束。"],
    }
    registered = register_domain_scenario(scen)
    assert registered["id"] == "deep_reinforcement_learning"
    assert "ppo" in registered["keywords"]

    # Verify scenario is discoverable in pool
    all_scens = {s["id"]: s for s in get_all_scenarios()}
    assert "deep_reinforcement_learning" in all_scens

    # Verify detect_scenario recognizes it
    detected = detect_scenario(["ppo", "rlhf"], "正在训练 PPO 奖励模型")
    assert detected["id"] == "deep_reinforcement_learning"

    unregister_scenario("deep_reinforcement_learning")
    reset_scenarios_to_default()


@pytest.mark.asyncio
async def test_load_dynamic_scenarios_from_db():
    import json
    import uuid
    from unittest.mock import AsyncMock, MagicMock
    from server.db.models import UserMemory
    from server.services.mind_resonance_service import (
        detect_scenario,
        load_dynamic_scenarios_from_db,
        reset_scenarios_to_default,
    )

    reset_scenarios_to_default()
    user_id = uuid.uuid4()
    scen_payload = {
        "id": "synthetic_biology",
        "name": "合成生物学",
        "keywords": ["dna", "crispr", "plasmid", "质粒"],
        "mindset": "质粒构建必须经过退火温度与引物二聚体检查。",
        "target_project": "bio_synth",
        "anchors": ["DNA", "CRISPR", "质粒"],
        "defense_rules": ["1) 严禁在未经密码子优化的宿主中表达异源序列。"],
    }
    mem = UserMemory(
        id=uuid.uuid4(),
        user_id=user_id,
        category="resonance_scenario",
        key="scenario_synthetic_biology",
        content=json.dumps(scen_payload),
        status="active",
        is_folder=False,
    )

    mock_db = AsyncMock()
    mock_res = MagicMock()
    mock_res.scalars.return_value.all.return_value = [mem]
    mock_db.execute.return_value = mock_res

    loaded = await load_dynamic_scenarios_from_db(mock_db, user_id=user_id)
    assert len(loaded) == 1
    assert loaded[0]["id"] == "synthetic_biology"

    matched = detect_scenario(["crispr", "dna"], "请帮我设计质粒退火引物")
    assert matched["id"] == "synthetic_biology"
    assert matched["target_project"] == "bio_synth"
    reset_scenarios_to_default()


@pytest.mark.asyncio
async def test_ask_retrieval_with_qvec_hnsw_fallback():
    import uuid
    from unittest.mock import AsyncMock, MagicMock
    from server.db.models import User, UserMemory
    from server.services.ask_retrieval import retrieve_core_memories

    user = User(id=uuid.uuid4(), email="tester@example.com")
    mem1 = UserMemory(
        id=uuid.uuid4(),
        user_id=user.id,
        category="rule",
        key="rule_1",
        content="发布前必须跑一遍测试",
        confidence=1.0,
        status="active",
        is_folder=False,
    )
    mock_db = AsyncMock()
    mock_res = MagicMock()
    mock_res.scalars.return_value.all.return_value = [mem1]
    mock_db.execute.return_value = mock_res

    # Retrieve with question and mock embedding vector
    results = await retrieve_core_memories(
        mock_db,
        user,
        question="如何发版",
        project_id="memento",
        limit=5,
    )
    assert len(results) >= 1
    assert results[0].key == "rule_1"

