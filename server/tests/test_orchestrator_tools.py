"""Tests for full MCP memory, blueprint, graph, todo, plan-status, and web-fetch tools in AI 编排."""

from __future__ import annotations

import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.db.models import KnowledgeEntity, Project, Todo, User, UserMemory  # noqa: E402
from server.services import orchestrator, orchestrator_tools  # noqa: E402


class OrchestratorToolsTests(unittest.IsolatedAsyncioTestCase):
    def test_tool_registry_parity_and_security_isolation(self) -> None:
        all_names = {t["function"]["name"] for t in orchestrator.TOOLS}
        ask_only_names = {t["function"]["name"] for t in orchestrator.ASK_ONLY_TOOLS}

        expected_mcp_tools = {
            "mind_resonance",
            "search_memory",
            "memory_recall",
            "memory_open",
            "memory_conversation",
            "memory_context",
            "memory_blueprint",
            "memory_project_map",
            "memory_graph",
            "memory_core",
            "memory_store",
            "daily_summary",
            "check_rules",
            "use_skill",
            "remember_pitfall",
            "add_todo",
            "list_todos",
            "todo_update",
            "fetch_url",
        }
        self.assertTrue(expected_mcp_tools.issubset(all_names))
        self.assertEqual(ask_only_names, expected_mcp_tools)
        # Device / plan execution tools must NEVER appear in ask_only mode
        for forbidden in ("run_on_device", "list_devices", "plan_and_run", "plan_status"):
            self.assertNotIn(forbidden, ask_only_names)
            self.assertIn(forbidden, all_names)

        # run_on_device supports workbuddy + model + project_id
        run_schema = next(t for t in orchestrator.TOOLS if t["function"]["name"] == "run_on_device")
        props = run_schema["function"]["parameters"]["properties"]
        self.assertIn("workbuddy", props["binary"]["enum"])
        self.assertIn("model", props)
        self.assertIn("project_id", props)

    def test_blueprint_and_business_section_slicing(self) -> None:
        sample_bp = (
            "# Code Blueprint: demo\n"
            "## 0. 速览与章节索引\n"
            "- 规模: 3 模块\n"
            "## 1. 架构\n"
            "架构正文\n"
            "## 3. 数据模型\n"
            "模型正文\n"
        )
        summary = orchestrator_tools.blueprint_section(sample_bp, "summary")
        self.assertIn("规模: 3 模块", summary)
        self.assertNotIn("模型正文", summary)

        sec3 = orchestrator_tools.blueprint_section(sample_bp, "3")
        self.assertIn("模型正文", sec3)
        self.assertNotIn("架构正文", sec3)

        sample_biz = (
            "# Business Blueprint\n"
            "<!-- memento:business-index:start -->\n"
            "规则 2 条\n"
            "<!-- memento:business-index:end -->\n"
            "## 3. 业务规则\n"
            "规则明细\n"
        )
        biz_sum = orchestrator_tools.business_section(sample_biz, "business", uncovered=["未写规则A"])
        self.assertIn("规则 2 条", biz_sum)
        self.assertIn("未写规则A", biz_sum)
        self.assertNotIn("规则明细", biz_sum)

        biz_3 = orchestrator_tools.business_section(sample_biz, "business:3")
        self.assertIn("规则明细", biz_3)

    def test_html_to_clean_text(self) -> None:
        raw = "<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><h1>标题</h1><p>正文 &amp; 内容</p></body></html>"
        cleaned = orchestrator_tools._html_to_clean_text(raw)
        self.assertIn("标题", cleaned)
        self.assertIn("正文 & 内容", cleaned)
        self.assertNotIn("alert(1)", cleaned)
        self.assertNotIn("color:red", cleaned)

    async def test_search_memory_returns_doc_id_and_markdown(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        db = AsyncMock()
        fake_sources = [
            {
                "id": "doc-123",
                "title": "部署手册",
                "tool_id": "obsidian",
                "category": "note",
                "relative_path": "ops/deploy.md",
                "happened_at": "2026-11-25T10:00:00Z",
                "excerpt": "使用 k3s Fleet 自动部署",
            }
        ]
        with patch("server.services.ask_retrieval.retrieve", AsyncMock(return_value=fake_sources)):
            res = await orchestrator_tools.execute_memory_tool(db, user, "search_memory", {"query": "部署", "limit": 5})

        self.assertEqual(len(res["results"]), 1)
        self.assertEqual(res["results"][0]["doc_id"], "doc-123")
        self.assertIn("doc-123", res["markdown"])

    async def test_memory_store_creates_entity_and_observation(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        db = AsyncMock()
        db.add = MagicMock()
        existing = KnowledgeEntity(id=uuid.uuid4(), user_id=user.id, name="Memento", entity_type="project")
        with patch("server.services.entity_canon.find_entity", AsyncMock(return_value=existing)):
            res = await orchestrator_tools.execute_memory_tool(
                db, user, "memory_store", {"content": "AI 编排支持上下文压缩", "entity_name": "Memento", "entity_type": "project"},
            )
        self.assertTrue(res["saved"])
        self.assertEqual(res["entity_name"], "Memento")
        db.commit.assert_awaited_once()

    async def test_todo_update_by_prefix(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        tid = uuid.uuid4()
        todo = Todo(
            id=tid,
            user_id=user.id,
            title="补齐单测",
            fingerprint="补齐单测",
            status="open",
            created_at=datetime.now(timezone.utc),
        )
        db = AsyncMock()
        res_mock = MagicMock()
        res_mock.scalars.return_value.all.return_value = [todo]
        db.execute.return_value = res_mock

        res = await orchestrator_tools.execute_memory_tool(
            db, user, "todo_update", {"todo_id": str(tid)[:8], "status": "done"},
        )
        self.assertTrue(res["updated"])
        self.assertEqual(todo.status, "done")
        db.commit.assert_awaited_once()

    async def test_memory_core_filtered_by_category(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        mem = UserMemory(
            id=uuid.uuid4(),
            user_id=user.id,
            category="rule",
            key="cn_reply",
            content="始终用中文回复",
            confidence=1.0,
            status="active",
            is_folder=False,
        )
        db = AsyncMock()
        res_mock = MagicMock()
        res_mock.scalars.return_value.all.return_value = [mem]
        db.execute.return_value = res_mock

        res = await orchestrator_tools.execute_memory_tool(db, user, "memory_core", {"category": "rule"})
        self.assertEqual(res["category"], "rule")
        self.assertEqual(len(res["items"]), 1)
        self.assertIn("始终用中文回复", res["markdown"])

    async def test_memory_project_map_lists_projects(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        pid = uuid.uuid4()
        proj = Project(id=pid, title="memento", slug="memento", tool_id="claude_code", source_path="/Users/dev/memento")
        db = AsyncMock()
        r1 = MagicMock()
        r1.all.return_value = [(pid, 42)]
        r2 = MagicMock()
        r2.scalars.return_value.all.return_value = [proj]
        db.execute.side_effect = [r1, r2]

        with patch.object(orchestrator_tools, "user_machine_ids", AsyncMock(return_value=None)):
            res = await orchestrator_tools.execute_memory_tool(db, user, "memory_project_map", {})
        self.assertEqual(res["count"], 1)
        self.assertIn("memento", res["markdown"])
        self.assertIn("42 篇文档", res["markdown"])

    async def test_fetch_url_cleans_html(self) -> None:
        user = User(id=uuid.uuid4(), email="u@test.local")
        db = AsyncMock()
        with patch(
            "server.api.documents.proxy_fetch_document",
            AsyncMock(return_value={"url": "https://example.com/doc", "content": "<h1>Hello</h1><p>World</p>", "content_type": "text/html"}),
        ):
            res = await orchestrator_tools.execute_memory_tool(db, user, "fetch_url", {"url": "https://example.com/doc"})
        self.assertEqual(res["url"], "https://example.com/doc")
        self.assertIn("Hello", res["content"])
        self.assertIn("World", res["content"])
        self.assertNotIn("<h1>", res["content"])


if __name__ == "__main__":
    unittest.main()
