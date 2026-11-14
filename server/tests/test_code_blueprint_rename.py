"""PROJECT_BLUEPRINT.md became CODE_BLUEPRINT.md (2026-11-15): readers take both names, clients before 1.0.134 keep
the generator that writes the old one, and the user blueprint reads the projects' business blueprints too."""

from datetime import datetime, timezone
import unittest

from sqlalchemy.dialects import postgresql

from tests.test_user_blueprint import MEMENTO_BP, _sources


def _sql(cond) -> str:
    return str(cond.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


class TestNames(unittest.TestCase):
    def test_both_names_by_the_whole_file_name(self):
        from server.db.models import Document
        from server.services.blueprint_pick import code_blueprint_path, code_blueprint_title, is_code_blueprint_path

        sql = _sql(code_blueprint_path(Document.relative_path))
        self.assertIn("LIKE '%%/CODE_BLUEPRINT.md'", sql)
        self.assertIn("LIKE '%%/PROJECT_BLUEPRINT.md'", sql)
        self.assertNotIn("ILIKE", sql)
        leaf = _sql(code_blueprint_path(Document.relative_path, "memento"))
        self.assertIn("'memento/CODE_BLUEPRINT.md'", leaf)
        self.assertIn("'memento/PROJECT_BLUEPRINT.md'", leaf)
        self.assertTrue(is_code_blueprint_path("memento/CODE_BLUEPRINT.md"))
        self.assertTrue(is_code_blueprint_path("memento/PROJECT_BLUEPRINT.md"))
        # An agent's memory note is not a blueprint
        self.assertFalse(is_code_blueprint_path("memory/project_code_blueprint.md"))
        self.assertEqual(code_blueprint_title("# Code Blueprint: memento\n"), "memento")
        self.assertEqual(code_blueprint_title("# Project Blueprint: old\n"), "old")
        self.assertIsNone(code_blueprint_title("# Notes\n"))


class TestGeneratorForOldClients(unittest.TestCase):
    def test_clients_before_1_0_134_keep_the_generator_that_writes_the_old_name(self):
        from server.api.profile import _get_blueprint_generator_bundle, _wants_legacy_generator

        for old in ("1.0.133", "1.0.117", None, "", "node-0.1.0", "dart-0.1.0"):
            self.assertTrue(_wants_legacy_generator(old), old)
        for new in ("1.0.134", "1.1.0", "v1.0.140"):
            self.assertFalse(_wants_legacy_generator(new), new)
        legacy = _get_blueprint_generator_bundle(legacy=True)
        current = _get_blueprint_generator_bundle()
        self.assertEqual(legacy["version"], 20261123)
        self.assertGreater(current["version"], legacy["version"])
        self.assertIn('BLUEPRINT_FILE = "PROJECT_BLUEPRINT.md"', legacy["content"])
        self.assertIn('BLUEPRINT_FILE = "CODE_BLUEPRINT.md"', current["content"])


BUSINESS = """# Business Blueprint: memento

## 1. 业务对象与术语

### T-DEVICE 设备
- 定义: 一台装了 memento 客户端的电脑

### T-RESUME 续接
- 定义: 从历史会话里挑一个接着聊

## 2. 关键流程

### F-ASK 提问到收尾
1. 网页发出提问 — `apps/web/src/app/ask/page.tsx#sendWithText`

## 3. 业务规则

### R-A 规则 A
- 来源: 用户

<!-- memento:business-check:start (自动生成，勿手改) -->
- 汇总：规则 1（✅ 1 · ⚠️ 0 · ❌ 0）· 流程 1 · 术语 2 · 状态 0
<!-- memento:business-check:end -->
"""


class TestUserBlueprintReadsBusinessBlueprints(unittest.TestCase):
    def test_per_project_business_lines_and_the_new_code_blueprint_name(self):
        from server.services.user_blueprint_service import synthesize_user_blueprint

        now = datetime.now(timezone.utc)
        src = _sources(
            blueprint_docs=[("p1", "memento/CODE_BLUEPRINT.md", MEMENTO_BP.replace("# Project Blueprint:", "# Code Blueprint:", 1), now)],
            business_docs=[("p1", "memento/BUSINESS_BLUEPRINT.md", BUSINESS, now)],
            profile_text="### 铁律\n- 仔细\n\n## 项目：pubchem\n- 逆合成路线重排\n- 实验条件用英文\n",
        )
        res = synthesize_user_blueprint("U", src)
        md = res["markdown"]
        by_name = {p["name"]: p for p in res["projects"]}
        self.assertTrue(by_name["memento"]["has_blueprint"])  # the new name counts as a code blueprint
        self.assertEqual(by_name["memento"]["business"]["terms"], ["设备", "续接"])
        self.assertIn("## 4. 跨项目代码蓝图矩阵 (Code Blueprint Portfolio)", md)
        self.assertIn("### 各项目业务蓝图 (Per-project Business Blueprints)", md)
        self.assertIn("**`memento`**：规则 1（✅ 1 · ⚠️ 0 · ❌ 0）；术语：设备、续接；流程：提问到收尾", md)
        self.assertIn("`pubchem`：画像里有 2 条项目规则，还没有业务蓝图", md)
