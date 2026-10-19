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

        # Mock observations
        mock_obs_res = MagicMock()
        mock_obs_res.all.return_value = [("桌面端应用名称去掉desktop后缀",)]

        # Mock relations
        mock_rel_res = MagicMock()
        mock_rel_res.all.return_value = [("depends_on", "TauriCore")]

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

        mock_db.execute.side_effect = [
            mock_ent_res,
            mock_obs_res,
            mock_rel_res,
            mock_mem_res,
        ]

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
