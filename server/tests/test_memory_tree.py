import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock

from server.api.memory import get_core_memory_tree
from server.db.models import User, UserMemory


class TestMemoryTree(unittest.IsolatedAsyncioTestCase):
    async def test_get_core_memory_tree_nesting(self):
        user = User(id=uuid.uuid4(), email="dev@example.com")

        # Root folder: Desktop
        folder_id = uuid.uuid4()
        folder_node = UserMemory(
            id=folder_id,
            user_id=user.id,
            category="rule",
            key="desktop",
            content="桌面端工程规范分支",
            is_folder=True,
            tree_path="/rules/desktop",
            parent_id=None,
        )

        # Child 1: windows_update_policy under folder
        child_id = uuid.uuid4()
        child_node = UserMemory(
            id=child_id,
            user_id=user.id,
            category="rule",
            key="windows_update_policy",
            content="Windows 桌面端必须使用 .zip 在位热替换",
            is_folder=False,
            tree_path="/rules/desktop/windows_update_policy",
            parent_id=folder_id,
        )

        # Root item: architecture_overview (no parent)
        arch_id = uuid.uuid4()
        arch_node = UserMemory(
            id=arch_id,
            user_id=user.id,
            category="architecture",
            key="three_tier",
            content="三层分层记忆模型",
            is_folder=False,
            tree_path="/architecture/three_tier",
            parent_id=None,
        )

        mock_db = AsyncMock()
        mock_result = MagicMock()
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = [folder_node, child_node, arch_node]
        mock_result.scalars.return_value = mock_scalars
        mock_db.execute.return_value = mock_result

        resp = await get_core_memory_tree(db=mock_db, _user=user)

        self.assertEqual(resp["total_count"], 3)
        roots = resp["tree"]
        # Root nodes are the top-level categories: /rules and /architecture
        self.assertEqual(len(roots), 2)

        rules_root = next(r for r in roots if r["tree_path"] == "/rules")
        self.assertTrue(rules_root["is_folder"])
        self.assertEqual(rules_root["title"], "开发铁律与避坑经验")
        # Under /rules, there is desktop folder
        desktop_folder = next(c for c in rules_root["children"] if c["tree_path"] == "/rules/desktop")
        self.assertTrue(desktop_folder["is_folder"])
        # Under /rules/desktop, there is windows_update_policy leaf
        self.assertEqual(len(desktop_folder["children"]), 1)
        leaf = desktop_folder["children"][0]
        self.assertEqual(leaf["id"], str(child_id))
        self.assertEqual(leaf["key"], "windows_update_policy")

        arch_root = next(r for r in roots if r["tree_path"] == "/architecture")
        self.assertTrue(arch_root["is_folder"])
        self.assertEqual(arch_root["title"], "架构设计与技术栈")
        self.assertEqual(len(arch_root["children"]), 1)
        self.assertEqual(arch_root["children"][0]["key"], "three_tier")



if __name__ == "__main__":
    unittest.main()


class CoreMarkdownExcludeTests(unittest.IsolatedAsyncioTestCase):
    async def test_excluded_categories_are_left_out_and_counted(self):
        import uuid as _uuid
        from unittest.mock import AsyncMock, MagicMock

        from server.db.models import User, UserMemory
        from server.services.dreaming_service import export_core_memory_markdown

        user = User(id=_uuid.uuid4(), email="u@example.com", role="owner")
        mems = [
            UserMemory(category="rule", key="reply_in_chinese", content="始终用中文回复", confidence=1.0, is_folder=False),
            UserMemory(category="pitfall", key="fleet_stalled", content="Fleet 卡住", confidence=1.0, is_folder=False),
            UserMemory(category="pitfall", key="configmap_patch", content="ConfigMap 覆盖代码", confidence=1.0, is_folder=False),
        ]
        res = MagicMock()
        res.scalars.return_value.all.return_value = mems
        db = AsyncMock()
        db.execute = AsyncMock(return_value=res)

        md = await export_core_memory_markdown(db, user, exclude=["pitfall"])
        self.assertIn("reply_in_chinese", md)
        self.assertNotIn("fleet_stalled", md)
        self.assertIn("未列出：pitfall 2 条", md)

        full = await export_core_memory_markdown(db, user)
        self.assertIn("fleet_stalled", full)
        self.assertNotIn("未列出", full)
