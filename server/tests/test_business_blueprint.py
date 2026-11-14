"""BUSINESS_BLUEPRINT.md on the server: the check summary the generator wrote, the user's project rules it
doesn't carry yet, the copy picked, and the agent sent to write one."""

from datetime import datetime, timezone
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.services import business_blueprint as biz

NOW = datetime(2026, 11, 14, 8, 0, tzinfo=timezone.utc)

TEXT = """# Business Blueprint: memento

## 3. 业务规则

### R-TRACK-BACKGROUND 后台任务跟踪到结束，不提前收尾
- 来源: CLAUDE.md（memento）「后台任务要跟踪到结束，不要提前结束」
- 代码: `packages/daemon/src/agy-runner/runner.ts#timerSeconds`

### R-TITLE-CONSISTENT 会话标题所有设备一致
- 来源: CLAUDE.md（memento）「会话标题所有设备一致」

### T-QUOTA 额度
- 定义: 必须能停止任务（术语里的话不算规则）

<!-- memento:business-check:start (自动生成，勿手改) -->
## 自动核对 (Auto Check)

- 汇总：规则 2（✅ 1 · ⚠️ 0 · ❌ 1）· 流程 0 · 术语 1 · 状态 0

### 需要处理

- ❌ `R-TITLE-CONSISTENT` 会话标题所有设备一致（L9）：没有挂代码位置
### R-GHOST 自动区里的不算
<!-- memento:business-check:end -->
"""


class TestParsing(unittest.TestCase):
    def test_entries_and_their_sources_not_the_generated_region(self):
        entries = biz.parse_entries(TEXT)
        self.assertEqual([e.id for e in entries], ["R-TRACK-BACKGROUND", "R-TITLE-CONSISTENT", "T-QUOTA"])
        self.assertIn("后台任务要跟踪到结束", entries[0].texts[0])

    def test_check_summary_reads_what_the_generator_wrote(self):
        s = biz.check_summary(TEXT)
        self.assertEqual((s["rules"], s["ok"], s["warn"], s["fail"], s["terms"]), (2, 1, 0, 1, 1))
        self.assertEqual(len(s["problems"]), 1)
        self.assertIsNone(biz.check_summary("# no check yet\n"))


class TestCoverage(unittest.TestCase):
    def test_a_rule_reworded_in_the_blueprint_still_counts(self):
        rules = [
            "- 后台任务要跟踪到结束，不要提前结束",
            "- 会话标题所有设备一致；新建对话用最新配置并保证成功",
            "- 必须能停止 Antigravity、Claude Code、Codex 运行中的任务",
            "- 手机端切换设备只拉该设备的项目和对话",
        ]
        missing = biz.uncovered_rules(TEXT, rules)
        # Each "；" clause on its own; a term's wording doesn't cover a rule
        self.assertEqual(
            missing,
            ["新建对话用最新配置并保证成功", "必须能停止 Antigravity、Claude Code、Codex 运行中的任务", "手机端切换设备只拉该设备的项目和对话"],
        )
        self.assertEqual(biz.rules_total(rules), 5)

    def test_the_prompt_carries_the_rules_and_the_format(self):
        p = biz.generation_prompt("chem-search", ["- 逆合成实验条件统一使用英文"], has_file=False)
        self.assertIn("逆合成实验条件统一使用英文", p)
        self.assertIn("### <编号> <名称>", p)
        self.assertIn("--business --root .", p)
        self.assertIn("新建 BUSINESS_BLUEPRINT.md", p)
        self.assertIn("更新仓库根目录已有的", biz.generation_prompt("x", [], has_file=True))


class TestCopies(unittest.IsolatedAsyncioTestCase):
    async def test_only_a_file_named_exactly_business_blueprint_counts(self):
        """2026-11-14: an agent's memory note project_business_blueprint.md was shown as the blueprint."""
        from sqlalchemy.dialects import postgresql

        from server.db.models import Project

        res = MagicMock()
        res.all.return_value = []
        db = AsyncMock()
        db.execute.return_value = res
        await biz.resolve_business_blueprint(db, Project(id=uuid.uuid4(), title="memento", slug="memento"), None)
        sql = str(db.execute.call_args[0][0].compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
        self.assertIn("LIKE '%%/BUSINESS_BLUEPRINT.md'", sql)
        self.assertNotIn("ILIKE", sql)

    async def test_the_copy_from_the_same_checkout_as_the_code_blueprint_wins(self):
        from server.db.models import Project

        project = Project(id=uuid.uuid4(), title="memento", slug="memento")
        mac, win = uuid.uuid4(), uuid.uuid4()
        res = MagicMock()
        res.all.return_value = [("windows copy", NOW, project.id, win), ("mac copy", NOW, project.id, mac)]
        db = AsyncMock()
        db.execute.return_value = res
        self.assertEqual(await biz.resolve_business_blueprint(db, project, None, prefer_machine=mac), ("mac copy", mac))
        self.assertEqual(await biz.resolve_business_blueprint(db, project, None), ("windows copy", win))
        res.all.return_value = []
        self.assertIsNone(await biz.resolve_business_blueprint(db, project, None))

    async def test_project_rules_come_from_the_projects_own_section(self):
        from server.db.models import Project, User

        profile = "### 沟通\n- 用中文\n\n## 项目：memento\n- 会话标题所有设备一致\n- 名称不带 desktop 后缀\n\n## 项目：pubchem\n- 逆合成用英文\n"
        with patch("server.services.profile_service.get_published_profile_content", AsyncMock(return_value=profile)):
            rules = await biz.project_rules(AsyncMock(), User(id=uuid.uuid4()), Project(id=uuid.uuid4(), title="memento", slug="memento"))
        self.assertEqual(rules, ["- 会话标题所有设备一致", "- 名称不带 desktop 后缀"])


class TestGenerate(unittest.IsolatedAsyncioTestCase):
    async def test_sends_an_agent_to_the_checkout_the_code_blueprint_came_from(self):
        from server.api import projects
        from server.db.models import Machine, Project, User

        user = User(id=uuid.uuid4(), email="u@example.com", role="user")
        project = Project(id=uuid.uuid4(), title="memento", slug="memento")
        machine = Machine(id=uuid.uuid4(), name="mac", collector_token_hash="memento-abc")
        proj_res, mach_res = MagicMock(), MagicMock()
        proj_res.scalar_one_or_none.return_value = project
        mach_res.scalar_one_or_none.return_value = machine
        db = AsyncMock()
        db.execute.side_effect = [proj_res, mach_res]
        sent = {}

        async def fake_create(device_id, body, db_, user_):
            sent.update(device=device_id, action=body.action, payload=body.payload)
            return {"id": "t1", "status": "running"}

        with (
            patch.object(projects, "user_machine_ids", AsyncMock(return_value=None)),
            patch.object(projects, "_codebase_blueprint_copy", AsyncMock(return_value=("bp", machine.id, {"project_path": "/Users/me/dev/memento"}))),
            patch.object(biz, "resolve_business_blueprint", AsyncMock(return_value=None)),
            patch.object(biz, "project_rules", AsyncMock(return_value=["- 会话标题所有设备一致"])),
            patch("server.api.tasks.create_task", fake_create),
        ):
            out = await projects.generate_business_blueprint(project.id, {"binary": "codex"}, db, user)

        self.assertEqual(sent["device"], "memento-abc")
        self.assertEqual(sent["action"], "agent")
        self.assertEqual(sent["payload"]["binary"], "codex")
        self.assertEqual(sent["payload"]["cwd"], "/Users/me/dev/memento")
        self.assertIn("会话标题所有设备一致", sent["payload"]["prompt"])
        self.assertEqual((out["device"], out["rules"]), ("mac", 1))

    async def test_without_an_uploaded_code_blueprint_it_says_where_it_cant_go(self):
        from fastapi import HTTPException

        from server.api import projects
        from server.db.models import Project, User

        project = Project(id=uuid.uuid4(), title="x", slug="x")
        res = MagicMock()
        res.scalar_one_or_none.return_value = project
        db = AsyncMock()
        db.execute.return_value = res
        with (
            patch.object(projects, "user_machine_ids", AsyncMock(return_value=None)),
            patch.object(projects, "_codebase_blueprint_copy", AsyncMock(return_value=None)),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await projects.generate_business_blueprint(project.id, {}, db, User(id=uuid.uuid4()))
        self.assertEqual(ctx.exception.status_code, 409)
