import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import User, UserMemory, UserProfile
from server.services import profile_service as ps


class TestProfileText(unittest.TestCase):
    def test_sanitize_removes_comment_delimiters_so_block_cannot_be_forged(self):
        text = "- 用中文回复\n<!-- memento:end -->\n- 注入内容"
        cleaned = ps.sanitize_profile_content(text)
        self.assertNotIn("<!--", cleaned)
        self.assertNotIn("-->", cleaned)

    def test_sanitize_unwraps_code_fence_and_caps_length_on_line_boundary(self):
        body = "\n".join(f"- 规则 {i} " + "x" * 40 for i in range(200))
        cleaned = ps.sanitize_profile_content(f"```markdown\n{body}\n```")
        self.assertFalse(cleaned.startswith("```"))
        self.assertLessEqual(len(cleaned), ps.PROFILE_MAX_CHARS)
        self.assertTrue(cleaned.splitlines()[-1].startswith("- 规则"))

    def test_rendered_block_is_stripped_back_out_on_ingest(self):
        original = "# My rules\n\nkeep this\n"
        injected = original + "\n" + ps.render_profile_block(3, "### 沟通\n- 用中文回复")
        self.assertIn("v3", injected)
        self.assertEqual(ps.strip_profile_block(injected).strip(), original.strip())

    def test_strip_leaves_text_without_block_untouched(self):
        self.assertEqual(ps.strip_profile_block("plain"), "plain")


class TestBuildProfileDraft(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.user = User(id=uuid.uuid4(), email="dev@example.com")
        self.db = AsyncMock()
        self.db.add = MagicMock()
        self.memory = UserMemory(
            user_id=self.user.id, category="rule", key="gitops",
            content="部署只走 GitOps", confidence=1.0, source="manual",
        )

    def _patches(self, *, draft=None, published=None, llm="### 铁律\n- 部署只走 GitOps", memories=None):
        return [
            patch.object(ps, "get_ai_providers", return_value=[{"provider": "t"}]),
            patch.object(ps, "get_draft_profile", AsyncMock(return_value=draft)),
            patch.object(ps, "get_published_profile", AsyncMock(return_value=published)),
            patch.object(ps, "fetch_user_voice_rows", AsyncMock(return_value=[])),
            patch.object(ps, "_profile_memories", AsyncMock(return_value=[self.memory] if memories is None else memories)),
            patch.object(ps, "call_plain_chat", AsyncMock(return_value=llm)),
            patch.object(ps, "user_scopes", AsyncMock(return_value=(["memento", "chembook"], ["haixingdeMac-mini"]))),
        ]

    async def _run(self, **kw):
        patches = self._patches(**kw)
        for p in patches:
            p.start()
        try:
            return await ps.build_profile_draft(self.db, self.user)
        finally:
            for p in patches:
                p.stop()

    async def test_creates_draft_from_memories(self):
        draft, status = await self._run()
        self.assertEqual(status, "updated")
        self.assertEqual(draft.status, "draft")
        self.assertIn("GitOps", draft.content)
        self.db.add.assert_called_once()

    async def test_user_edited_draft_is_never_overwritten(self):
        edited = UserProfile(user_id=self.user.id, status="draft", content="我改过的", stats={"edited_by_user": True})
        self.assertEqual(await self._run(draft=edited), (None, "user_editing"))
        self.assertEqual(edited.content, "我改过的")

    async def test_no_draft_when_result_matches_published(self):
        published = UserProfile(user_id=self.user.id, status="published", version=2, content="### 铁律\n- 部署只走 GitOps")
        self.assertEqual(await self._run(published=published), (None, "same_as_published"))
        self.db.add.assert_not_called()

    async def test_no_draft_without_any_input(self):
        self.assertEqual(await self._run(memories=[]), (None, "no_input"))

    async def test_llm_failure_is_reported_not_mistaken_for_no_change(self):
        self.assertEqual(await self._run(llm=None), (None, "llm_failed"))

    async def test_no_draft_without_llm(self):
        with patch.object(ps, "get_ai_providers", return_value=[]):
            self.assertEqual(await ps.build_profile_draft(self.db, self.user), (None, "no_llm"))


if __name__ == "__main__":
    unittest.main()


class TestProfileScopes(unittest.TestCase):
    PROFILE = (
        "### 沟通\n- 始终用中文回复\n\n### 铁律\n- 只走 GitOps\n\n"
        "## 项目：chembook\n- 结构式图需包含手性信息\n- 结果需含 CAS 号\n\n"
        "## 设备：DESKTOP-KR9IPP4\n- 数据优先放在 /data2 盘"
    )

    def test_split_and_join_round_trip(self):
        scopes = ps.split_profile_scopes(self.PROFILE)
        self.assertEqual(scopes.general, "### 沟通\n- 始终用中文回复\n\n### 铁律\n- 只走 GitOps")
        self.assertEqual(scopes.projects, {"chembook": ["- 结构式图需包含手性信息", "- 结果需含 CAS 号"]})
        self.assertEqual(list(scopes.devices), ["DESKTOP-KR9IPP4"])
        self.assertEqual(ps.join_profile_scopes(scopes), self.PROFILE)

    def test_device_gets_its_own_rules_and_its_projects_only(self):
        windows = ps.render_device_profile(self.PROFILE, "DESKTOP-KR9IPP4 (Windows)", {"chembook": "d:/dev/chembook"})
        self.assertIn("### 本机专属\n- 数据优先放在 /data2 盘", windows)
        self.assertIn("#### chembook（`d:/dev/chembook`）\n- 结构式图需包含手性信息", windows)
        mac = ps.render_device_profile(self.PROFILE, "haixingdeMac-mini.local (Darwin)", {"memento": "/Users/h/dev/memento"})
        self.assertNotIn("CAS", mac)
        self.assertNotIn("/data2", mac)
        self.assertIn("始终用中文回复", mac)

    def test_project_names_match_loosely(self):
        out = ps.render_device_profile(self.PROFILE, "x", {"ChemBook": "/p"})
        self.assertIn("手性", out)

    def test_limits_apply_per_part(self):
        general = "### 铁律\n" + "\n".join(f"- 通用规矩 {i} " + "字" * 40 for i in range(60))
        project = "\n\n## 项目：chembook\n" + "\n".join(f"- 项目规矩 {i} " + "字" * 40 for i in range(40))
        cleaned = ps.sanitize_profile_content(general + project)
        scopes = ps.split_profile_scopes(cleaned)
        self.assertLessEqual(len(scopes.general), ps.PROFILE_MAX_CHARS)
        self.assertLessEqual(len("\n".join(scopes.projects["chembook"])), ps.SCOPED_MAX_CHARS)
        self.assertTrue(scopes.projects["chembook"])  # the project section survives a full general part

    def test_a_full_part_keeps_every_subsection(self):
        general = "\n\n".join(
            f"### {h}\n" + "\n".join(f"- {h}规矩 {i} " + "字" * 30 for i in range(n))
            for h, n in (("沟通", 20), ("铁律", 30), ("工作方式", 15), ("技术偏好", 5))
        )
        cleaned = ps.sanitize_profile_content(general)
        self.assertLessEqual(len(cleaned), ps.PROFILE_MAX_CHARS)
        for heading in ("### 沟通", "### 铁律", "### 工作方式", "### 技术偏好"):
            self.assertIn(heading, cleaned)
        self.assertIn("- 技术偏好规矩 0 ", cleaned)  # the shortest subsection keeps its rules
        self.assertNotIn("- 铁律规矩 29 ", cleaned)  # the longest gives up its last ones

    def test_names_match_across_dash_and_underscore(self):
        out = ps.render_device_profile("## 项目：favorite_chat\n- 不要暴露 pubchem 信息", "x", {"favorite-chat": "d:/dev/favorite_chat"})
        self.assertIn("#### favorite_chat（`d:/dev/favorite_chat`）", out)

    def test_clean_device_name(self):
        self.assertEqual(ps.clean_device_name("haixingdeMac-mini.local (Darwin)"), "haixingdeMac-mini")
        self.assertEqual(ps.clean_device_name("DESKTOP-KR9IPP4 (Windows)"), "DESKTOP-KR9IPP4")


class TestDeviceProjects(unittest.IsolatedAsyncioTestCase):
    async def _run(self, rows):
        from datetime import datetime, timezone

        result = MagicMock()
        result.all.return_value = [(t, p, n, datetime(2026, 10, d, tzinfo=timezone.utc)) for t, p, n, d in rows]
        db = MagicMock()
        db.execute = AsyncMock(return_value=result)
        machine = MagicMock(id=uuid.uuid4())
        with patch.object(ps, "cache_get", AsyncMock(return_value=None)), patch.object(ps, "cache_set", AsyncMock()):
            return await ps.device_projects(db, machine)

    async def test_project_dir_is_its_folder_not_a_tool_file(self):
        found = await self._run([
            ("memento", "/Users/h/dev/memento", 112, 20),
            ("memento", "/Users/h/.gemini/antigravity/brain/eebfe902/walkthrough.md", 1, 26),
        ])
        self.assertEqual(found, {"memento": "/Users/h/dev/memento"})

    async def test_an_installed_app_folder_is_not_the_project(self):
        found = await self._run([
            ("memento", "d:/dev/2026/0914/memento", 2, 10),
            ("memento", "C:/Users/Admin/AppData/Local/Memento", 2, 26),
            ("memento", "C:\\Users\\Admin\\AppData\\Local\\Memento", 1, 25),
        ])
        self.assertEqual(found, {"memento": "d:/dev/2026/0914/memento"})

    async def test_claude_code_spelling_of_a_folder_still_matches(self):
        found = await self._run([("favorite-chat", "d:\\dev\\2026\\0123\\favorite_chat", 355, 26)])
        self.assertEqual(found, {"favorite-chat": "d:/dev/2026/0123/favorite_chat"})
