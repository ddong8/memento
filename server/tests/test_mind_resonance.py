"""Unit tests for Mind Resonance Service (心领神会·默契前置激活层)."""

from __future__ import annotations

import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import KnowledgeEntity, User, UserMemory, UserProfile
from server.services.mind_resonance_service import (
    detect_scenario,
    render_mind_resonance_markdown,
    sense_resonance,
)
from server.services.ask_prompt import build_messages
from server.services.orchestrator import _tool_memory, agent_memory_prompt


class TestMindResonance(unittest.IsolatedAsyncioTestCase):
    def test_detect_scenario(self):
        """Verify intent and domain scenario deduction."""
        cases = [
            ("逆合成路线规划，化合物 CAS 提取", "chemistry_pubchem"),
            ("用 WorkBuddy 爬取化学数据源", "data_harvest"),
            ("前端 tab 切换零延迟渲染与卡顿优化", "ui_performance"),
            ("发布新版本，构建镜像并部署 k8s pod", "devops_release"),
            ("设备解绑保留数据归档与恢复", "data_safety"),
            ("Memento 自进化与记忆画像", "evolution_memory"),
            ("常规代码重构与函数调用", "general_engineering"),
        ]
        for query, expected_id in cases:
            scen = detect_scenario([w.lower() for w in query.split()], query)
            self.assertEqual(scen["id"], expected_id, f"Scenario deduction failed for '{query}'")

    async def test_sense_resonance_and_render(self):
        """Verify full sensing pipeline across user profile, graph, and pitfalls."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="owner")
        mock_db = AsyncMock()

        # Mock published profile
        mock_prof = UserProfile(
            id=uuid.uuid4(),
            user_id=user.id,
            content=(
                "## 关于我\n"
                "- 始终用中文回复，直接给结论和指令，不绕弯子、不废话。\n"
                "- 回复中不要用 ** 这类 Markdown 加粗符号；编号统一用 1),2),3)。\n\n"
                "### 只在对应项目里适用\n\n"
                "#### memento\n"
                "- 提交规范：中文 Conventional Commits 风格，历史保持线性。\n"
                "- 客户端界面需美化，追求高级精致，交互零延迟。\n"
            ),
            status="published",
        )

        # Mock Knowledge Entities
        ent = KnowledgeEntity(
            id=uuid.uuid4(),
            user_id=user.id,
            name="MementoDesktop",
            entity_type="project",
            summary="跨平台个人记忆助手桌面端",
        )
        mock_ent_res = MagicMock()
        mock_ent_res.scalars.return_value.all.return_value = [ent]

        # Mock observations (batch: entity_id, content)
        mock_obs_res = MagicMock()
        mock_obs_res.all.return_value = [(ent.id, "桌面端应用名称去掉desktop后缀")]

        # Mock relations (batch 1-hop: source_id, relation_type, target_id, target_name)
        target_id = uuid.uuid4()
        mock_rel_res = MagicMock()
        mock_rel_res.all.return_value = [(ent.id, "depends_on", target_id, "TauriCore")]

        # Mock relations (batch 2-hop)
        mock_rel2_res = MagicMock()
        mock_rel2_res.all.return_value = [(target_id, "submodule", "tauri-collector")]

        # Mock UserMemory (pitfalls)
        p_mem = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            key="release_version_mismatch",
            category="pitfall",
            content="发版 tag 必须等于 package.json 的 version，否则客户端提示更新错乱",
            status="active",
            is_folder=False,
        )
        mock_mem_res = MagicMock()
        mock_mem_res.scalars.return_value.all.return_value = [p_mem]

        async def fake_execute(statement, *args, **kwargs):
            sql = str(statement)
            if "knowledge_observations" in sql:
                return mock_obs_res
            if "knowledge_relations" in sql:
                if getattr(fake_execute, "rel1_done", False):
                    return mock_rel2_res
                fake_execute.rel1_done = True
                return mock_rel_res
            if "knowledge_entities" in sql:
                return mock_ent_res
            if "user_memories" in sql:
                return mock_mem_res
            return MagicMock()

        mock_db.execute.side_effect = fake_execute

        with patch("server.services.mind_resonance_service.get_published_profile", new_callable=AsyncMock, return_value=mock_prof):
            res = await sense_resonance(
                mock_db,
                user,
                query="memento 客户端发布更新",
                project="memento",
            )
            self.assertEqual(res["scenario"]["id"], "devops_release")
            self.assertTrue(len(res["scoped_rules"]) > 0)
            self.assertEqual(len(res["entities"]), 1)
            self.assertEqual(res["entities"][0]["name"], "MementoDesktop")
            self.assertEqual(len(res["pitfalls"]), 1)
            self.assertEqual(res["pitfalls"][0]["key"], "release_version_mismatch")

            md = render_mind_resonance_markdown(res)
            self.assertIn("【心领神会·默契前置激活层 (Mind Resonance)】", md)
            self.assertIn("发布交付与无故障上线", md)
            self.assertIn("MementoDesktop", md)
            self.assertIn("release_version_mismatch", md)
            self.assertIn("中文 Conventional Commits", md)

    async def test_get_resonance_api_endpoint(self):
        """Verify GET /api/memory/resonance route and caching."""
        from server.api.memory import get_resonance

        user = User(id=uuid.uuid4(), email="user@example.com", role="owner")
        mock_db = AsyncMock()

        dummy_payload = {
            "scenario": {"id": "devops_release", "name": "发布交付与无故障上线"},
            "mindset": "无故障上线",
            "scoped_rules": ["发版打tag"],
            "general_rules": ["说中文"],
            "entities": [],
            "pitfalls": [],
        }

        with patch("server.services.mind_resonance_service.sense_resonance", new_callable=AsyncMock, return_value=dummy_payload) as mock_sense, \
             patch("server.api.memory.cache_get", new_callable=AsyncMock, return_value=None), \
             patch("server.api.memory.cache_set", new_callable=AsyncMock) as mock_cache:

            # Test JSON format
            json_res = await get_resonance(query="发布", format="json", db=mock_db, _user=user)
            self.assertEqual(json_res["scenario"]["id"], "devops_release")
            mock_sense.assert_awaited_once()
            mock_cache.assert_awaited_once()

            # Test Markdown format
            md_res = await get_resonance(query="发布", format="markdown", db=mock_db, _user=user)
            self.assertIn("【心领神会·默契前置激活层 (Mind Resonance)】", md_res["markdown"])

    def test_build_messages_with_resonance(self):
        """Verify build_messages injects mind resonance as highest priority layer."""
        resonance_data = {
            "scenario": {"name": "前端交互极致性能与设计"},
            "mindset": "交互零延迟、0ms切换无损保活",
            "scoped_rules": ["客户端界面需美化，追求高级精致"],
            "entities": [],
            "pitfalls": [],
        }
        messages = build_messages(
            question="前端界面切换有些慢",
            sources=[],
            history=[],
            resonance_data=resonance_data,
        )
        self.assertTrue(len(messages) >= 2)
        sys_msg = messages[0]["content"]
        self.assertIn("【心领神会·默契前置激活层 (Mind Resonance)】", sys_msg)
        self.assertIn("前端交互极致性能与设计", sys_msg)
        self.assertIn("交互零延迟、0ms切换无损保活", sys_msg)

    async def test_orchestrator_integration(self):
        """Verify orchestrator agent_memory_prompt and _tool_memory integration."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="owner")
        mock_db = AsyncMock()

        dummy_res = {
            "scenario": {"name": "发布交付与无故障上线"},
            "mindset": "发版前必查历史经验避免重踩坑",
            "scoped_rules": [],
            "general_rules": [],
            "entities": [],
            "pitfalls": [],
        }

        mock_skills_res = MagicMock()
        mock_skills_res.scalars.return_value.all.return_value = []
        mock_db.execute.return_value = mock_skills_res

        with patch("server.services.mind_resonance_service.sense_resonance", new_callable=AsyncMock, return_value=dummy_res), \
             patch("server.services.profile_service.get_published_profile", new_callable=AsyncMock, return_value=None), \
             patch("server.services.guidance_service.guidance_for", new_callable=AsyncMock, return_value={}):

            # 1. Test agent_memory_prompt
            prompt = await agent_memory_prompt(mock_db, user, project="memento", query="部署")
            self.assertIn("【心领神会·默契前置激活层 (Mind Resonance)】", prompt)
            self.assertIn("发布交付与无故障上线", prompt)

            # 2. Test _tool_memory invocation of mind_resonance
            tool_res = await _tool_memory(mock_db, user, "mind_resonance", {"query": "发布"})
            self.assertIn("resonance", tool_res)
            self.assertIn("【心领神会·默契前置激活层 (Mind Resonance)】", tool_res["resonance"])

    async def test_target_project_affinity_weighting(self):
        """Verify graph entities are boosted when matching target_project."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="owner")
        mock_db = AsyncMock()

        ent_pubchem = KnowledgeEntity(
            id=uuid.uuid4(),
            user_id=user.id,
            name="PubchemService",
            entity_type="project",
            summary="PubChem 化合物与逆合成服务",
        )
        ent_memento = KnowledgeEntity(
            id=uuid.uuid4(),
            user_id=user.id,
            name="MementoDesktop",
            entity_type="project",
            summary="Memento 桌面端记忆助手",
        )

        mock_ent_res = MagicMock()
        mock_ent_res.scalars.return_value.all.return_value = [ent_pubchem, ent_memento]

        mock_obs_res = MagicMock()
        mock_obs_res.all.return_value = []
        mock_rel_res = MagicMock()
        mock_rel_res.all.return_value = []

        async def fake_execute(statement, *args, **kwargs):
            sql = str(statement)
            if "knowledge_observations" in sql:
                return mock_obs_res
            if "knowledge_relations" in sql:
                return mock_rel_res
            return mock_ent_res

        mock_db.execute = AsyncMock(side_effect=fake_execute)

        from server.services.mind_resonance_service import _fetch_graph_entities
        # When target_project is memento, MementoDesktop should be ranked first despite same term overlap
        res = await _fetch_graph_entities(mock_db, user, ["service", "desktop"], limit_entities=2, target_project="memento")
        self.assertEqual(len(res), 2)
        self.assertEqual(res[0]["name"], "MementoDesktop")

    async def test_extract_pitfall_hint_on_failure(self):
        """Verify failure reflex retrieves and formats matching pitfall hints."""
        from server.services.orchestrator import _extract_pitfall_hint
        user = User(id=uuid.uuid4(), email="user@example.com", role="owner")
        mock_db = AsyncMock()

        dummy_pitfall = {
            "title": "版本号未对齐导致升级死循环",
            "fix": "更新 apps/desktop/package.json 版本号并重新打 tag",
            "cause": "客户端报告版本与 version.json 不匹配",
        }

        with patch("server.services.guidance_service.guidance_for", new_callable=AsyncMock, return_value={"pitfalls": [dummy_pitfall]}):
            hint = await _extract_pitfall_hint(mock_db, user, "shell", "Error: release version mismatch between tag and package.json", "memento")
            self.assertIsNotNone(hint)
            self.assertIn("【心智避坑唤醒·历史上发生过类似错误】", hint)
            self.assertIn("版本号未对齐导致升级死循环", hint)
            self.assertIn("更新 apps/desktop/package.json 版本号", hint)

    async def test_live_correction_rules_and_cache(self):
        """Verify extraction, storage, and rendering of session live rules."""
        from server.services.mind_resonance_service import (
            extract_live_correction_rules,
            get_session_live_rules,
            render_mind_resonance_markdown,
            save_session_live_rules,
        )
        sample_prompt = (
            "请注意：\n"
            "回复中不要用 ** 这类 Markdown 加粗符号。\n"
            "发版必须确认所有 pod 状态。\n"
            "还有其他需要注意的吗？"
        )
        rules = extract_live_correction_rules(sample_prompt)
        self.assertTrue(any("不要用" in r for r in rules))
        self.assertTrue(any("必须确认" in r or "发版必须" in r for r in rules))

        user_id = uuid.uuid4()
        conv_id = "test-conv-123"
        saved = await save_session_live_rules(user_id, conv_id, rules)
        self.assertGreater(len(saved), 0)

        retrieved = await get_session_live_rules(user_id, conv_id)
        self.assertEqual(retrieved, saved)

        rendered = render_mind_resonance_markdown({"mindset": "测试心智"}, live_rules=retrieved)
        self.assertIn("【当前会话实时纠偏与行为守则（用户在本会话中特别强调，必须绝对遵守）】", rendered)

    def test_query_expansion_for_search(self):
        """Verify query expansion on short scenario keywords."""
        from server.services.mind_resonance_service import expand_query_for_search

        # 1. DevOps release scenario
        exp_rel = expand_query_for_search("发布新版")
        self.assertIn("version.json", exp_rel)
        self.assertIn("Fleet", exp_rel)

        # 2. Chemistry pubchem scenario
        exp_chem = expand_query_for_search("逆合成")
        self.assertIn("CAS", exp_chem)
        self.assertIn("SMILES", exp_chem)

        # 3. Long query should remain untouched
        long_q = "这是一段非常详细具体的指令超过三十个字符所以不需要自动扩展语义锚点"
        self.assertEqual(expand_query_for_search(long_q), long_q)

    def test_clean_guardrail_output(self):
        """Verify markdown bold asterisks are stripped outside code fences."""
        from server.services.mind_resonance_service import clean_guardrail_output

        dirty_text = "这里是**加粗标题**，下面是代码：\n```python\nx = 2 ** 3\nprint('**keep this**')\n```\n结论是**完全成功**。"
        cleaned = clean_guardrail_output(dirty_text)
        self.assertNotIn("**加粗标题**", cleaned)
        self.assertIn("这里是加粗标题", cleaned)
        self.assertIn("结论是完全成功", cleaned)
        # Verify inside code block is preserved
        self.assertIn("2 ** 3", cleaned)
        self.assertIn("'**keep this**'", cleaned)

    async def test_record_online_graph_observation(self):
        """Verify real-time online knowledge graph observation writeback and cache eviction."""
        from server.services.mind_resonance_service import record_online_graph_observation

        mock_db = AsyncMock()
        mock_db.add = MagicMock()
        user_id = uuid.uuid4()

        # When entity doesn't exist
        mock_res = MagicMock()
        mock_res.scalars.return_value.first.return_value = None
        mock_db.execute.return_value = mock_res

        with patch("server.services.cache.cache_delete_prefix", AsyncMock()) as mock_del:
            obs = await record_online_graph_observation(
                mock_db, user_id, "FastAPI", "异步路由改造成功", entity_type="technology"
            )
            self.assertIsNotNone(obs)
            self.assertEqual(obs.content, "异步路由改造成功")
            mock_db.add.assert_called()
            mock_del.assert_called_once_with(f"memory:resonance:{user_id}")

    async def test_select_affinity_machine(self):
        """Verify scenario, OS topology, and path affinity routing across multiple machines."""
        from server.db.models import Machine
        from server.services.orchestrator import _select_affinity_machine

        user = User(id=uuid.uuid4(), email="u@test.com")
        mock_db = AsyncMock()

        m_mac = Machine(
            id=uuid.uuid4(),
            name="haixingdong-macbook",
            collector_token_hash="tok_mac",
            is_archived=False,
        )
        m_linux = Machine(
            id=uuid.uuid4(),
            name="chemistry-gpu-server-linux",
            collector_token_hash="tok_linux",
            is_archived=False,
        )

        with patch("server.services.orchestrator.ws_manager.has_device", return_value=True):
            # Test 1: Chemistry / /data2 scenario prefers Linux
            chosen_chem = await _select_affinity_machine(
                mock_db, user, [m_mac, m_linux],
                {"command": "python parse_reaxys.py", "cwd": "/data2/pubchem"}
            )
            self.assertEqual(chosen_chem.name, "chemistry-gpu-server-linux")

            # Test 2: macOS specific command prefers Mac
            chosen_mac = await _select_affinity_machine(
                mock_db, user, [m_mac, m_linux],
                {"command": "osascript -e 'display dialog \"hello\"'", "cwd": "/Users/haixingdong/dev"}
            )
            self.assertEqual(chosen_mac.name, "haixingdong-macbook")

