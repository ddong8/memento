"""Unit tests for Round 24 optimizations:
1. UserMemory vector embedding & Ebbinghaus time decay recall
2. Mind Resonance decoupled domain scenarios & dynamic self-evolution
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import math
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import User, UserMemory
from server.services.ask_retrieval import (
    compute_ebbinghaus_memory_score,
    _to_float_vector,
    _vector_cosine_similarity,
    retrieve_core_memories,
)
from server.services.mind_resonance_service import (
    DEFAULT_DOMAIN_SCENARIOS,
    detect_scenario,
    get_all_scenarios,
    load_dynamic_scenarios_from_db,
    register_scenario,
    reset_scenarios_to_default,
    unregister_scenario,
)


class TestRound24Optimizations(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        reset_scenarios_to_default()

    def tearDown(self):
        reset_scenarios_to_default()

    def test_ebbinghaus_decay_formula(self):
        """Verify Score = CosineSimilarity * exp(-lambda * delta_days) * log(2 + recall_count)."""
        now = datetime.now(timezone.utc)
        sim = 0.8
        lmb = 0.05

        # 0 days, recall_count=0
        score_day0 = compute_ebbinghaus_memory_score(
            cosine_sim=sim,
            last_recalled_at=now,
            recall_count=0,
            lambda_decay=lmb,
            now=now,
        )
        expected_day0 = sim * math.exp(0.0) * math.log(2.0)
        self.assertAlmostEqual(score_day0, expected_day0, places=5)

        # 14 days, recall_count=0: decayed
        score_day14 = compute_ebbinghaus_memory_score(
            cosine_sim=sim,
            last_recalled_at=now - timedelta(days=14),
            recall_count=0,
            lambda_decay=lmb,
            now=now,
        )
        self.assertLess(score_day14, score_day0)
        self.assertAlmostEqual(score_day14, sim * math.exp(-0.05 * 14) * math.log(2.0), places=5)

        # 14 days, recall_count=10: reinforced by spaced repetition
        score_day14_reinforced = compute_ebbinghaus_memory_score(
            cosine_sim=sim,
            last_recalled_at=now - timedelta(days=14),
            recall_count=10,
            lambda_decay=lmb,
            now=now,
        )
        self.assertGreater(score_day14_reinforced, score_day14)
        self.assertAlmostEqual(score_day14_reinforced, sim * math.exp(-0.05 * 14) * math.log(12.0), places=5)

    def test_vector_math_helpers(self):
        """Verify vector normalization and cosine similarity calculation."""
        v1 = [1.0, 0.0, 0.0]
        v2 = [1.0, 0.0, 0.0]
        self.assertAlmostEqual(_vector_cosine_similarity(v1, v2), 1.0)

        v3 = [0.0, 1.0, 0.0]
        self.assertAlmostEqual(_vector_cosine_similarity(v1, v3), 0.0)

        # Parsing vector formats
        self.assertEqual(_to_float_vector([1.0, 2.5]), [1.0, 2.5])
        self.assertEqual(_to_float_vector("[0.1, 0.9]"), [0.1, 0.9])
        self.assertIsNone(_to_float_vector(None))

    async def test_retrieve_core_memories_vector_semantic_scoring(self):
        """Verify retrieve_core_memories uses vector embedding and Ebbinghaus weighting."""
        user = User(id=uuid.uuid4(), email="tester@example.com")
        now = datetime.now(timezone.utc)

        # Memory 1: semantically high match, recently recalled
        mem1 = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            category="rule",
            key="rule_electron_updater",
            content="桌面端自动更新严格遵守版本元数据三位一体",
            embedding=[1.0, 0.0, 0.0],
            last_recalled_at=now,
            recall_count=5,
            confidence=1.0,
            status="active",
            is_folder=False,
        )

        # Memory 2: semantically orthogonal
        mem2 = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            category="rule",
            key="rule_chemistry_cas",
            content="化学研发逆合成统一使用CAS号表述",
            embedding=[0.0, 1.0, 0.0],
            last_recalled_at=now,
            recall_count=1,
            confidence=1.0,
            status="active",
            is_folder=False,
        )

        db = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mem2, mem1]
        mock_result.scalar_one_or_none.return_value = None
        db.execute.return_value = mock_result

        # Question vector matches mem1
        with patch("server.services.embedding_service._call_embedding_server", new_callable=AsyncMock) as mock_embed:
            mock_embed.return_value = [[1.0, 0.0, 0.0]]

            results = await retrieve_core_memories(
                db=db,
                user=user,
                question="怎么校验更新元数据",
                limit=10,
            )

            self.assertIn(mem1, results)
            # mem1 should be ranked before mem2 due to higher cosine similarity
            if mem2 in results:
                self.assertLess(results.index(mem1), results.index(mem2))

    def test_mind_resonance_dynamic_scenario_registration(self):
        """Verify dynamic registration, detection, and lifecycle of custom scenarios."""
        custom_scenario = {
            "id": "biotech_crispr",
            "name": "生物基因与CRISPR编辑",
            "keywords": ("crispr", "cas9", "基因编辑", "靶向序列", "质粒"),
            "mindset": "严格核对sgRNA靶向序列，严禁非特异性脱靶；质粒构建流程完整溯源。",
            "target_project": "crispr_pipeline",
            "anchors": ["sgRNA", "Cas9", "脱靶率", "质粒"],
            "search_query_extras": "sgRNA Cas9 靶向质粒",
            "defense_rules": ["1) 严禁非特异性脱靶，交付前复核靶向序列。"],
            "device_affinity": "linux",
        }

        # 1. Initially, custom keywords fallback to general
        scen_before = detect_scenario(["crispr", "cas9"], "crispr 质粒设计")
        self.assertEqual(scen_before["id"], "general_engineering")

        # 2. Register dynamic scenario
        register_scenario(custom_scenario)
        all_scens = get_all_scenarios()
        self.assertTrue(any(s["id"] == "biotech_crispr" for s in all_scens))

        # 3. Detect scenario matches the newly registered one
        scen_after = detect_scenario(["crispr", "cas9"], "crispr 质粒设计")
        self.assertEqual(scen_after["id"], "biotech_crispr")
        self.assertEqual(scen_after["target_project"], "crispr_pipeline")

        # 4. Unregister
        unreg_ok = unregister_scenario("biotech_crispr")
        self.assertTrue(unreg_ok)
        scen_reset = detect_scenario(["crispr", "cas9"], "crispr 质粒设计")
        self.assertEqual(scen_reset["id"], "general_engineering")

    async def test_load_dynamic_scenarios_from_db(self):
        """Verify loading distilled scenarios from UserMemory database records."""
        import json

        user = User(id=uuid.uuid4(), email="user@example.com")
        scenario_data = {
            "id": "quantum_computing",
            "name": "量子计算与线路仿真",
            "keywords": ("量子", "qubit", "qasm", "纠缠", "线路"),
            "mindset": "量子门保真度必须达到99.9%以上；线路深度严格约束。",
            "target_project": "quantum_sim",
            "anchors": ["Qubit", "QASM", "保真度"],
            "search_query_extras": "量子比特 QASM 仿真",
        }

        mem_scenario = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            category="resonance_scenario",
            key="scenario_quantum",
            content=json.dumps(scenario_data),
            status="active",
            is_folder=False,
        )

        db = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mem_scenario]
        db.execute.return_value = mock_result

        loaded = await load_dynamic_scenarios_from_db(db, user.id)
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0]["id"], "quantum_computing")

        scen = detect_scenario(["qubit", "qasm"], "量子纠缠线路设计")
        self.assertEqual(scen["id"], "quantum_computing")
        self.assertEqual(scen["target_project"], "quantum_sim")

    async def test_retrieve_core_memories_offline_fallback(self):
        """Verify fallback to keyword overlap + baseline when embedding server fails."""
        user = User(id=uuid.uuid4(), email="tester@example.com")
        now = datetime.now(timezone.utc)

        mem_kw = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            category="rule",
            key="rule_chinese_reply",
            content="始终使用中文回复用户，长会话不得切换英文",
            embedding=None,
            last_recalled_at=now,
            recall_count=3,
            confidence=1.0,
            status="active",
            is_folder=False,
        )

        db = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mem_kw]
        mock_result.scalar_one_or_none.return_value = None
        db.execute.return_value = mock_result

        with patch("server.services.embedding_service._call_embedding_server", side_effect=RuntimeError("Server offline")):
            results = await retrieve_core_memories(
                db=db,
                user=user,
                question="回复语言有什么规范？",
                limit=5,
            )
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0].key, "rule_chinese_reply")

    async def test_ebbinghaus_ranking_decay_and_reinforcement(self):
        """Verify that recent memory ranks above 30-day decayed memory, and high recall count beats zero recall."""
        user = User(id=uuid.uuid4(), email="tester@example.com")
        now = datetime.now(timezone.utc)

        # mem_recent: same similarity, recalled today, recall_count=1
        mem_recent = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            category="general",
            key="recent_note",
            content="技术偏好流式并发输出",
            embedding=[1.0, 0.0, 0.0],
            last_recalled_at=now,
            recall_count=1,
            confidence=1.0,
            status="active",
            is_folder=False,
        )

        # mem_decayed: same similarity, recalled 40 days ago, recall_count=1
        mem_decayed = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            category="general",
            key="decayed_note",
            content="技术偏好流式并发输出",
            embedding=[1.0, 0.0, 0.0],
            last_recalled_at=now - timedelta(days=40),
            recall_count=1,
            confidence=1.0,
            status="active",
            is_folder=False,
        )

        db = AsyncMock()
        mock_result = MagicMock()
        # Return decayed first to prove ranking reorders them
        mock_result.scalars.return_value.all.return_value = [mem_decayed, mem_recent]
        mock_result.scalar_one_or_none.return_value = None
        db.execute.return_value = mock_result

        with patch("server.services.embedding_service._call_embedding_server", new_callable=AsyncMock) as mock_embed:
            mock_embed.return_value = [[1.0, 0.0, 0.0]]
            results = await retrieve_core_memories(
                db=db,
                user=user,
                question="流式输出",
                limit=10,
            )
            self.assertEqual(results[0].key, "recent_note")
            self.assertEqual(results[1].key, "decayed_note")
