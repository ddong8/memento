"""A pitfall is something another AI would hit again in the user's environment, not the AI's own slip.

On 11-09 67 of 271 pitfalls were slips (a quote broken in an inline script, a guessed table name,
Antigravity's view_file failing on a big file), and the health page's "known pitfall hit again" (83 in
a week) was nearly all of them. The review now labels each pitfall env or slip and drops slips; the
count only takes pitfalls still in force. The database test runs against a real PostgreSQL when
MEMENTO_TEST_DATABASE_URL points at a throwaway database (it creates and drops the schema)."""

from __future__ import annotations

import json
import os
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services import retrospective_service as rs  # noqa: E402

DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")


def _pit(title: str, symptom: str = "", cause: str = "", fix: str = "", project: str | None = "memento") -> str:
    return rs.format_pitfall({"title": title, "symptom": symptom, "cause": cause, "fix": fix}, project)


class SlipFilterTests(unittest.TestCase):
    def test_the_model_label_decides_first(self):
        self.assertTrue(rs.is_harness_pitfall({"kind": "slip", "title": "测试库端口写错"}))
        self.assertTrue(rs.is_harness_pitfall({"kind": " Slip ", "title": "测试库端口写错"}))
        self.assertFalse(rs.is_harness_pitfall({"kind": "env", "title": "macOS 没有 timeout 命令", "fix": "用 gtimeout"}))

    def test_slips_labelled_env_are_still_caught(self):
        slips = [
            {"title": "view_file 读不出 2MB 的日志", "symptom": "view_file failed"},
            {"title": "replace_file_content 改不动", "symptom": "target content not found"},
            {"title": "编辑失败", "symptom": "目标文本不匹配，改动没写进去"},
            {"title": "去停后台命令报错", "symptom": "task is not running"},
            {"title": "命令太久被转入后台", "cause": "超过等待时间自动转入后台"},
            {"title": "git diff 看不全", "cause": "输出过长被截断"},
            {"title": "python -c 报 SyntaxError", "cause": "单引号被 shell 吞掉，内联脚本的引号破坏了"},
            {"title": "查询报 relation does not exist", "cause": "猜错了表名"},
            {"title": "写文件被拒", "symptom": "沙箱拒绝写 /etc"},
            # the old rules on Claude Code's own mechanics still hold, wherever they appear
            {"title": "cd 失败", "cause": "每次 Bash 是独立 shell，工作目录不保留"},
        ]
        for item in slips:
            with self.subTest(item=item["title"]):
                self.assertTrue(rs.is_harness_pitfall(item))

    def test_real_pitfalls_pass_even_when_the_fix_names_an_edit_tool(self):
        real = [
            {"title": "npm ci 报 ERESOLVE", "symptom": "ERESOLVE unable to resolve dependency tree",
             "cause": "react 19 与旧版 peer 依赖冲突", "fix": "用 replace_file_content 把 overrides 写进 package.json"},
            {"title": "PowerShell 不支持 &&", "symptom": "The token '&&' is not a valid statement separator",
             "cause": "Windows PowerShell 5.1", "fix": "改用 ; 或 -and"},
            {"title": "retry 不动", "symptom": "failed | 5 | 424", "cause": "attempts < 5 过滤"},
        ]
        for item in real:
            with self.subTest(item=item["title"]):
                self.assertFalse(rs.is_harness_pitfall(item))

    def test_stored_pitfalls_are_judged_on_what_failed(self):
        self.assertTrue(rs.is_slip_memory(_pit("脚本跑不起来", "SyntaxError", "内联脚本的引号被 shell 吞掉", "写成文件再跑")))
        self.assertFalse(rs.is_slip_memory(_pit("npm ci 报 ERESOLVE", "ERESOLVE", "peer 依赖冲突", "用 replace_file_content 加 overrides")))
        self.assertFalse(rs.is_slip_memory(None))

    def test_both_prompts_take_the_definition(self):
        for prompt in (rs._REVIEW_PROMPT, rs._TASK_PROMPT):
            self.assertIn("{kinds}", prompt)
            self.assertIn('"kind": "env"', prompt)
        self.assertIn("slip", rs.PITFALL_KINDS)


class ReviewDropsSlipsTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_slip_is_neither_saved_nor_counted_as_a_known_pitfall_hit_again(self):
        env_known = SimpleNamespace(id=uuid.uuid4(), content=_pit("macOS 没有 timeout", "command not found: timeout", "", "用 gtimeout"))
        slip_known = SimpleNamespace(id=uuid.uuid4(), content=_pit("猜错表名", "relation does not exist", "猜错了表名", "先查 information_schema"))
        known = rs.Known(pitfalls={"p1": env_known, "p2": slip_known})
        answer = {
            "outcome": "done", "summary": "修好了",
            "pitfalls": [
                {"kind": "env", "match": "p1", "title": "macOS 没有 timeout", "symptom": "command not found", "fix": "gtimeout"},
                {"kind": "slip", "match": "p2", "title": "又猜错表名", "symptom": "relation does not exist", "fix": "先查"},
                {"kind": "slip", "match": None, "title": "python -c 引号写坏", "symptom": "SyntaxError", "fix": "写成文件"},
                {"kind": "env", "match": None, "title": "uv sync 要先装 Python 3.12", "symptom": "No interpreter found", "fix": "uv python install 3.12"},
            ],
        }
        cand = rs.Candidate(uuid.uuid4(), "会话", "claude_code", "memento", "memento", 40, 20, datetime.now(timezone.utc))
        db = MagicMock(commit=AsyncMock(), get=AsyncMock(return_value=None))
        user = SimpleNamespace(id=uuid.uuid4())
        saved = SimpleNamespace(id=uuid.uuid4())
        save = AsyncMock(return_value=saved)
        with patch.object(rs, "load_transcript", AsyncMock(return_value="…")), \
                patch.object(rs, "load_known", AsyncMock(return_value=known)), \
                patch.object(rs, "call_plain_chat", AsyncMock(return_value=json.dumps(answer, ensure_ascii=False))) as chat, \
                patch.object(rs, "save_pitfall", save):
            result = await rs.review_session(db, user, cand)

        self.assertEqual(result["pitfalls_seen"], [str(env_known.id)])
        self.assertEqual(result["slips"], 2)
        self.assertEqual(result["pitfalls_new"], 1)
        self.assertEqual(result["pitfalls_added"], [str(saved.id)])
        self.assertEqual([c.args[2]["title"] for c in save.await_args_list], ["uv sync 要先装 Python 3.12"])
        self.assertIn("kind 只能是 env 或 slip", chat.await_args.kwargs["messages"][1]["content"])


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class PitfallRepeatCountTests(unittest.IsolatedAsyncioTestCase):
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

    async def test_only_pitfalls_still_in_force_count_as_hit_again(self):
        from server.db.models import Document, Machine, SessionReview, Tool, User, UserMemory

        async with self.Session() as db:
            user, other = User(email="owner@example.com", role="owner", status="active"), User(email="b@example.com", status="active")
            db.add_all([user, other, Tool(id="claude_code", display_name="Claude Code")])
            await db.flush()
            machine = Machine(name="mac", collector_token_hash="dev-mac", user_id=user.id)
            db.add(machine)
            await db.flush()

            def memory(owner, content, status="active"):
                m = UserMemory(user_id=owner.id, category="pitfall", key=str(uuid.uuid4()), content=content,
                               source="outcome", status=status)
                db.add(m)
                return m

            env = memory(user, _pit("macOS 没有 timeout", "command not found: timeout", "", "用 gtimeout"))
            retired = memory(user, _pit("旧的坑", "报错", "原因", "解法"), status="dormant")
            slip = memory(user, _pit("猜错表名", "relation does not exist", "猜错了表名", "先查 information_schema"))
            foreign = memory(other, _pit("别人的坑", "报错", "原因", "解法"))
            docs = [Document(machine_id=machine.id, tool_id="claude_code", category="conversation", content_type="jsonl",
                             relative_path=f"s{n}.jsonl", content_hash=f"h{n}", file_size_bytes=1) for n in range(2)]
            db.add_all(docs)
            await db.flush()
            seen = [str(env.id), str(retired.id), str(slip.id), str(foreign.id), "p3"]
            db.add_all([
                SessionReview(document_id=docs[0].id, user_id=user.id, outcome="done", result={"pitfalls_seen": seen}),
                SessionReview(document_id=docs[1].id, user_id=user.id, outcome="partial", result={"pitfalls_seen": [str(env.id)]}),
            ])
            await db.commit()

            stats = await rs.review_stats(db, user)

        self.assertEqual(stats["sessions"], 2)
        self.assertEqual(stats["pitfall_repeats"], 2)  # env, once in each review
        self.assertEqual(stats["pitfalls_total"], 2)  # env and slip are both still active


if __name__ == "__main__":
    unittest.main()
