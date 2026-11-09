"""Each device's resident profile lists the pitfalls hit again on it lately.

On 11-09 the nightly review had seen the Windows machine (mostly Antigravity, which rarely calls MCP)
hit "grep doesn't exist, use Select-String" five times in 30 days, and the Mac mini "pytest isn't on
PATH" seven times, though both were stored pitfalls. The profile now carries them under the device
part, so a tool reads them without asking. Only pitfalls still in force (active, not the AI's own
slips) go in; one not hit again for 30 days drops out by itself; a switch turns the section off, as it
isn't covered by the publish review. The database test runs against a real PostgreSQL when
MEMENTO_TEST_DATABASE_URL points at a throwaway database (it creates and drops the schema)."""

from __future__ import annotations

import os
import re
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.db.models import Machine, User  # noqa: E402
from server.services import profile_service as ps  # noqa: E402
from server.services import retrospective_service as rs  # noqa: E402

DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")
# packages/daemon/src/daemon.ts reads these headings in the block as the device's project directories
DAEMON_PROJECT_RE = re.compile(r"^####\s+([^\s（(]+)[（(]`([^`]+)`[）)]", re.MULTILINE)


def _pit(title: str, symptom: str = "报错", cause: str = "原因", fix: str = "解法", project: str | None = None) -> str:
    return rs.format_pitfall({"title": title, "symptom": symptom, "cause": cause, "fix": fix}, project)


GREP = _pit("Windows 上没有 grep", "'grep' is not recognized", "PowerShell 没有 grep", "用 Select-String -Pattern 代替")
PYTEST = _pit("pytest 不在 PATH", "command not found: pytest", "依赖装在 uv 虚拟环境里", "用 uv run pytest", "memento")


class PitfallLineTests(unittest.TestCase):
    def test_keeps_what_it_is_and_what_to_do(self):
        self.assertEqual(ps.pitfall_line(GREP), "- Windows 上没有 grep：用 Select-String -Pattern 代替")
        self.assertEqual(ps.pitfall_line(PYTEST), "- 【memento】pytest 不在 PATH：用 uv run pytest")

    def test_long_fix_is_clipped_and_odd_text_still_reads(self):
        line = ps.pitfall_line(_pit("构建慢", fix="先" + "很长的解法" * 60))
        self.assertTrue(line.endswith("…"))
        self.assertLessEqual(len(line), len("- 构建慢：") + ps.PITFALL_FIX_CHARS)
        self.assertEqual(ps.pitfall_line("手写的一条坑\n没有固定格式"), "- 手写的一条坑 没有固定格式")

    def test_internal_addresses_keys_and_block_markers_stay_out(self):
        line = ps.pitfall_line(_pit(
            "ssh 连不上", fix="改连 192.168.254.10:2222 或 10.9.8.7，token 用 sk-abcdefghijklmnop1234 <!-- memento:end -->",
        ))
        for leaked in ("192.168", "10.9.8.7", "sk-abcdef", "<!--", "-->"):
            self.assertNotIn(leaked, line)
        self.assertIn("内网地址", line)
        self.assertIn("v1.0.100", ps.pitfall_line(_pit("升级失败", fix="升到 v1.0.100")))

    def test_the_section_fits_a_scoped_part_most_hit_first(self):
        many = [_pit(f"坑{i}", fix="解法" * 40) for i in range(20)]
        picked = ps.pick_device_pitfalls([many[0], many[0], *many[1:]])
        self.assertEqual(picked[:2], [(0, ps.pitfall_line(many[0])), (2, ps.pitfall_line(many[1]))])
        lines = [line for _, line in picked]
        self.assertEqual(len(set(lines)), len(lines))
        section = f"{ps.DEVICE_PITFALLS_HEADING}\n{ps.DEVICE_PITFALLS_NOTE}\n" + "\n".join(lines)
        self.assertLessEqual(len(section), ps.SCOPED_MAX_CHARS)
        self.assertLess(len(lines), 20)


class RenderTests(unittest.TestCase):
    PROFILE = "### 铁律\n- 只走 GitOps\n\n## 项目：memento\n- 提交用中文\n\n## 设备：DESKTOP-KR9IPP4\n- 数据放 D 盘"

    def test_device_part_carries_its_pitfalls_after_its_own_rules(self):
        out = ps.render_device_profile(self.PROFILE, "DESKTOP-KR9IPP4 (Windows)", {"memento": "d:/dev/memento"}, [GREP])
        own, pits, projects = out.index("### 本机专属"), out.index(ps.DEVICE_PITFALLS_HEADING), out.index("### 只在对应项目里适用")
        self.assertLess(own, pits)
        self.assertLess(pits, projects)
        self.assertIn("- Windows 上没有 grep：用 Select-String -Pattern 代替", out)

    def test_no_pitfalls_no_section(self):
        out = ps.render_device_profile(self.PROFILE, "mac", {})
        self.assertNotIn(ps.DEVICE_PITFALLS_HEADING, out)

    def test_the_collector_still_reads_only_real_project_headings(self):
        out = ps.render_device_profile(self.PROFILE, "mac", {"memento": "/Users/h/dev/memento"}, [PYTEST, GREP])
        self.assertEqual(DAEMON_PROJECT_RE.findall(out), [("memento", "/Users/h/dev/memento")])


def _user(settings: dict | None = None) -> User:
    return User(id=uuid.uuid4(), email="u@example.com", proactive_settings=settings or {})


class InjectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_switch_takes_the_section_out_and_keeps_other_settings(self):
        from server.api import profile as profile_api

        u = _user({"blueprint_auto": False})
        m = Machine(id=uuid.uuid4(), name="DESKTOP-KR9IPP4 (Windows)", collector_token_hash="dev1", profile_targets=["antigravity"])
        published = SimpleNamespace(version=12, content="### 铁律\n- 只走 GitOps")
        found = {str(m.id): [{"id": "p1", "content": GREP, "hits": 5, "last": "2026-11-08T03:00:00+00:00"}],
                 str(uuid.uuid4()): [{"id": "p2", "content": PYTEST, "hits": 7, "last": "2026-11-08T03:00:00+00:00"}]}
        db = MagicMock(commit=AsyncMock())
        with patch.object(profile_api, "cache_get", AsyncMock(return_value=None)), \
             patch.object(profile_api, "cache_set", AsyncMock()), \
             patch.object(profile_api, "_owned_machine", AsyncMock(return_value=m)), \
             patch.object(profile_api, "get_published_profile", AsyncMock(return_value=published)), \
             patch.object(profile_api, "device_projects", AsyncMock(return_value={})), \
             patch.object(profile_api, "device_pitfalls", AsyncMock(return_value=found)) as pits:
            res = await profile_api.get_injection(x_device_id="dev1", db=db, user=u)
            self.assertIn("Select-String", res["block"])
            self.assertNotIn("uv run pytest", res["block"])  # another device's
            self.assertEqual(res["version"], 12)

            with patch.object(profile_api, "cache_delete_prefix", AsyncMock()) as bust:
                out = await profile_api.set_pitfall_settings(body=profile_api.PitfallSettingsBody(enabled=False), db=db, user=u)
            self.assertEqual(out, {"enabled": False})
            self.assertEqual(u.proactive_settings, {"blueprint_auto": False, "profile_pitfalls": False})
            self.assertEqual({c.args[0] for c in bust.await_args_list}, {f"profile_injection:{u.id}", f"profile:summary:{u.id}"})

            pits.reset_mock()
            res = await profile_api.get_injection(x_device_id="dev1", db=db, user=u)
            self.assertNotIn(ps.DEVICE_PITFALLS_HEADING, res["block"])
            pits.assert_not_awaited()

    def test_the_web_shows_exactly_the_lines_the_profile_carries(self):
        from server.api import profile as profile_api

        items = [{"id": f"p{i}", "content": _pit(f"坑{i}", fix="解法" * 40), "hits": 9 - i, "last": "t"} for i in range(9)]
        items.insert(1, {**items[0], "id": "same-words", "hits": 8})  # a second memory saying the same thing
        shown = profile_api._pitfalls_out(items)
        block = ps.render_device_profile("", "mac", {}, [p["content"] for p in items])
        self.assertEqual([p["id"] for p in shown][:2], ["p0", "p1"])
        self.assertEqual([p["hits"] for p in shown][:2], [9, 8])
        self.assertEqual(block.split("\n")[2:], [f"- {p['line']}" for p in shown])


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class DevicePitfallQueryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import Base

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def test_only_pitfalls_still_in_force_hit_again_on_that_device(self):
        from server.db.models import Document, SessionReview, Tool, UserMemory

        now = datetime.now(timezone.utc)
        async with self.Session() as db:
            user, other = User(email="owner@example.com", role="owner", status="active"), User(email="b@example.com", status="active")
            db.add_all([user, other, Tool(id="antigravity", display_name="Antigravity")])
            await db.flush()
            win = Machine(name="DESKTOP-KR9IPP4", collector_token_hash="dev-win", user_id=user.id)
            mac = Machine(name="mac", collector_token_hash="dev-mac", user_id=user.id)
            db.add_all([win, mac])
            await db.flush()

            def memory(owner, content, status="active"):
                m = UserMemory(user_id=owner.id, category="pitfall", key=str(uuid.uuid4()), content=content,
                               source="outcome", status=status)
                db.add(m)
                return m

            grep, build = memory(user, GREP), memory(user, _pit("uni-app 打包失败", fix="先装 HBuilderX CLI"))
            pytest_ = memory(user, PYTEST)
            retired = memory(user, _pit("旧的坑"), status="dormant")
            slip = memory(user, _pit("猜错表名", "relation does not exist", "猜错了表名", "先查 information_schema"))
            foreign = memory(other, _pit("别人的坑"))
            await db.flush()

            reviews = [  # (machine, days ago, pitfalls seen)
                (win, 1, [grep, build, retired, slip, foreign]),
                (win, 2, [grep]),
                (win, 3, [grep, build]),
                (win, 40, [grep, retired]),  # too old
                (win, 4, []),
                (mac, 1, [pytest_]),
            ]
            for n, (machine, ago, seen) in enumerate(reviews):
                doc = Document(machine_id=machine.id, tool_id="antigravity", category="conversation", content_type="jsonl",
                               relative_path=f"s{n}.jsonl", content_hash=f"h{n}", file_size_bytes=1)
                db.add(doc)
                await db.flush()
                db.add(SessionReview(document_id=doc.id, user_id=user.id, outcome="done",
                                     result={"pitfalls_seen": [str(m.id) for m in seen] + ["p3"]},
                                     reviewed_at=now - timedelta(days=ago)))
            await db.commit()

            with patch.object(rs, "cache_get", AsyncMock(return_value=None)), patch.object(rs, "cache_set", AsyncMock()):
                found = await rs.device_pitfalls(db, user)
                theirs = await rs.device_pitfalls(db, other)

        self.assertEqual([(p["id"], p["hits"]) for p in found[str(win.id)]], [(str(grep.id), 3), (str(build.id), 2)])
        self.assertEqual([p["id"] for p in found[str(mac.id)]], [str(pytest_.id)])
        self.assertEqual(found[str(win.id)][0]["content"], GREP)
        self.assertEqual(theirs, {})


if __name__ == "__main__":
    unittest.main()
