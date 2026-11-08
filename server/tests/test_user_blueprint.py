"""Tests for the user (cross-project) blueprint the server synthesizes. The project blueprint
generator is TypeScript now: packages/daemon/test/blueprint-generator.test.ts."""

import unittest

MEMENTO_BP = (
    "# Project Blueprint: memento\n\n"
    "## 0. 速览与章节索引 (Quick Summary & Section Index)\n\n"
    "- 类型 (Type): Monorepo (Workspaces)\n"
    "- 技术栈 (Stack): TypeScript/JavaScript, Python · React, Electron, FastAPI\n"
    "- 自测命令 (Verify): `cd server && uv run pytest`\n\n"
    "| 章节 (Section) | 行号 (Lines) |\n| :--- | :--- |\n| 1. Project Overview & Tech Stack | L20-L24 |\n\n"
    "## 1. Project Overview & Tech Stack\n"
    "- **Core Languages**: `TypeScript/JavaScript`, `Python`\n"
    "- **Key Frameworks**: `FastAPI`, `React`, `Electron`, `Next.js`\n"
    "- **Infrastructure & Middleware**: `PostgreSQL`, `Redis`, `Docker`, `Kubernetes`\n"
    "## 3. Subsystem Breakdown & Responsibilities\n"
    "| Subsystem / Path | Category | Role & Purpose |\n"
    "| :--- | :--- | :--- |\n"
    "| [`server`](server) | Backend | FastAPI + MCP multi-agent memory server |\n"
)


def _sources(**overrides):
    from datetime import datetime, timezone
    from server.services.user_blueprint_service import BlueprintSources

    now = datetime.now(timezone.utc)
    src = BlueprintSources(
        devices=[{"name": "mac (Darwin)", "platform": "macOS", "online": True}],
        project_rows=[
            ("p1", "memento", "/Users/u/dev/memento", 40, now),
            ("p2", "pubchem", "/Users/u/dev/pubchem", 30, now),
            ("p3", "quant_future", "/Users/u/dev/quant_future", 12, now),
            # collector artifacts and nested folders are not projects
            ("p4", "tmp", "/private/tmp", 50, now),
            ("p5", "499fe778-1ba4-4e64-aea5-40249671183b", "/Users/u/dev/x", 9, now),
            ("p6", "web", "/Users/u/dev/memento/apps/web", 20, now),
            ("p7", "u", "/Users/u", 80, now),
        ],
        blueprint_docs=[("p1", "memento/PROJECT_BLUEPRINT.md", MEMENTO_BP, now)],
        memories=["偏好容器化 + k8s 部署"],
        entities=[("RDKit", "library", 9), ("Bash", "tool", 50), ("memento", "technology", 5)],
        project_entities={
            "pubchem": ("位于 /Users/u/dev/pubchem 的项目，逆合成路线规划与 CAS / SMILES 化合物检索，当前在 main 分支", ["RDKit", "FastAPI"]),
            "quant-future": ("期货 quant 策略回测与 tqsdk 行情接入，有未跟踪文件", ["pandas"]),
        },
        profile_text=(
            "### 铁律\n- 仔细深入调查问题\n### 技术偏好\n- 偏好容器化 + k8s 部署\n"
            "### 只在对应项目里适用\n#### pubchem（`/Users/u/dev/pubchem`）\n- 逆合成路线重排与 CAS 号检索\n"
        ),
    )
    for k, v in overrides.items():
        setattr(src, k, v)
    return src


class TestUserBlueprintService(unittest.IsolatedAsyncioTestCase):
    def test_synthesize_classifies_projects_and_renders_quick_summary(self):
        from server.services.user_blueprint_service import synthesize_user_blueprint

        res = synthesize_user_blueprint("Haixing Dong", _sources())
        names = [p["name"] for p in res["projects"]]
        self.assertEqual(set(names), {"memento", "pubchem", "quant_future"})
        by_name = {p["name"]: p for p in res["projects"]}
        self.assertEqual(by_name["pubchem"]["primary_field"], "chemistry")
        self.assertEqual(by_name["quant_future"]["primary_field"], "finance")
        self.assertTrue(by_name["memento"]["has_blueprint"])
        self.assertFalse(by_name["pubchem"]["has_blueprint"])
        self.assertEqual(by_name["memento"]["tech_stack"][:2], ["TypeScript/JavaScript", "Python"])

        # Summaries keep what the project is, not where it lives or the checkout's state
        self.assertEqual(by_name["pubchem"]["summary"], "逆合成路线规划与 CAS / SMILES 化合物检索")
        self.assertEqual(by_name["quant_future"]["summary"], "期货 quant 策略回测与 tqsdk 行情接入")

        md = res["markdown"]
        self.assertTrue(md.splitlines()[0].startswith("# User Cognitive & Domain Blueprint: Haixing Dong"))
        self.assertIn("## 0. 速览 (Quick Summary)", md)
        for heading in ("## 2. 学科交叉与专业领域", "## 3. 核心业务版图与应用场景", "## 4. 跨项目架构蓝图矩阵", "## 5. 全域技术栈与基础设施雷达"):
            self.assertIn(heading, md)
        self.assertIn("flowchart LR", res["mermaid_topology"])
        # A project without a blueprint has no known size, not "0 模块"
        pub_row = next(line for line in md.splitlines() if line.startswith("| **`pubchem`**"))
        self.assertIn("| — |", pub_row)
        self.assertIn("1 模块", next(line for line in md.splitlines() if line.startswith("| **`memento`**")))
        # No user paths, ids or agent tools leak into the document
        self.assertNotIn("/Users/u", md)
        self.assertNotIn("499fe778", md)
        self.assertNotIn("`Bash`", md.split("## 5.")[1].split("## 6.")[0].split("知识图谱")[-1])
        self.assertIn("RDKit", md)
        self.assertIn("偏好容器化 + k8s 部署", md)
        self.assertEqual({d["platform"] for d in res["devices"]}, {"macOS"})

    def test_working_rules_do_not_decide_what_a_project_is(self):
        from server.services.user_blueprint_service import synthesize_user_blueprint

        src = _sources(
            blueprint_docs=[],
            project_entities={"memento": ("多端 AI 记忆/知识管理项目，采用 Monorepo 架构", ["K3s", "Electron", "Redis", "FastMCP"])},
            profile_text=(
                "### 只在对应项目里适用\n#### memento（`/Users/u/dev/memento`）\n"
                "- 工作台文本支持多次编辑润色，确认无误后再推送到公众号草稿；文章带上官网链接\n"
            ),
        )
        by_name = {p["name"]: p for p in synthesize_user_blueprint("u", src)["projects"]}
        self.assertEqual(by_name["memento"]["primary_field"], "ai_ml")

    def test_project_description_comes_from_its_own_readme_first(self):
        from server.services.user_blueprint_service import (
            _blueprint_about,
            _blueprint_quick_summary,
            synthesize_user_blueprint,
        )

        bp = MEMENTO_BP.replace(
            "- 类型 (Type)", "- 简介 (About): 本平台提供高性能的本地化化合物检索服务，支持结构搜索\n- 类型 (Type)", 1
        ).replace("# Project Blueprint: memento", "# Project Blueprint: pubchem", 1)
        self.assertEqual(_blueprint_about(bp), "本平台提供高性能的本地化化合物检索服务，支持结构搜索")
        self.assertFalse(any(q.startswith("简介") for q in _blueprint_quick_summary(bp)))
        self.assertEqual(_blueprint_about("## 1. Project Overview\n- **About**: Order desk\n"), "Order desk")
        self.assertEqual(_blueprint_about(MEMENTO_BP), "")

        src = _sources(
            blueprint_docs=[("p2", "pubchem/PROJECT_BLUEPRINT.md", bp, None)],
            # What the knowledge graph made of conversations: the public database, not the project
            project_entities={"pubchem": ("美国国立卫生研究院维护的公开化学数据库", ["RDKit"])},
        )
        by_name = {p["name"]: p for p in synthesize_user_blueprint("u", src)["projects"]}
        self.assertTrue(by_name["pubchem"]["summary"].startswith("本平台提供高性能的本地化化合物检索服务"))
        # No About line (generator before 20261111): the knowledge graph's summary as before
        src = _sources()
        by_name = {p["name"]: p for p in synthesize_user_blueprint("u", src)["projects"]}
        self.assertIn("逆合成路线规划", by_name["pubchem"]["summary"])

    def test_rules_and_noise_are_not_project_summaries(self):
        from server.services.user_blueprint_service import _is_noise_project, _sanitize_summary

        self.assertEqual(_sanitize_summary("处理数据时先备份原表"), "")
        self.assertEqual(_sanitize_summary("避坑指南：不要回滚"), "")
        self.assertEqual(_sanitize_summary("Git 仓库项目，远程仓库托管于内网"), "")
        self.assertEqual(_sanitize_summary("从名称推断是基于 TQSDK 的做市商程序"), "基于 TQSDK 的做市商程序")
        self.assertEqual(_sanitize_summary("Mac mini 上的 VPS 相关仓库"), "VPS 相关仓库")
        self.assertEqual(
            _sanitize_summary("网格交易机器人，支持 paper/testnet/live 三种模式（ddong8/bot），代码在 /Users/u/dev/bot"),
            "网格交易机器人，支持 paper/testnet/live 三种模式",
        )
        self.assertTrue(_is_noise_project("499fe778-1ba4-4e64-aea5-40249671183b", "/users/u/dev/x"))
        self.assertTrue(_is_noise_project("tmp", "/private/tmp/x"))
        self.assertTrue(_is_noise_project("main", "main"))
        self.assertFalse(_is_noise_project("pubchem", "/users/u/dev/pubchem"))

    async def test_build_uses_only_the_users_own_devices_and_caches(self):
        import uuid
        from unittest.mock import AsyncMock, MagicMock, patch
        from server.db.models import User
        from server.services import user_blueprint_service as ubs

        user = User(id=uuid.uuid4(), email="haixing@example.com", name="Haixing Dong", role="owner")
        statements: list[str] = []

        async def fake_execute(stmt, *a, **kw):
            statements.append(str(stmt))
            res = MagicMock()
            res.all.return_value = []
            res.scalars.return_value.all.return_value = []
            return res

        db = AsyncMock()
        db.execute.side_effect = fake_execute
        with patch.object(ubs, "cache_get", AsyncMock(return_value=None)), \
             patch.object(ubs, "cache_set", AsyncMock()) as cache_set, \
             patch.object(ubs, "get_published_profile", AsyncMock(return_value=None)):
            res = await ubs.build_user_blueprint(db, user)

        self.assertEqual(res["user_name"], "Haixing Dong")
        cache_set.assert_awaited_once()
        self.assertEqual(cache_set.await_args.args[0], f"user:blueprint:v3:{user.id}")
        # Even an owner gets their own devices only: the machines query is filtered by user id
        self.assertIn("machines.user_id", statements[0])

        cached = {"markdown": "# User Cognitive & Domain Blueprint: x"}
        db.execute.reset_mock()
        with patch.object(ubs, "cache_get", AsyncMock(return_value=cached)):
            self.assertIs(await ubs.build_user_blueprint(db, user), cached)
        db.execute.assert_not_called()

    def test_clean_truncation_word_boundaries_and_noise_filtering(self):
        from server.services.mind_resonance_service import _summarize_user_blueprint_markdown
        from server.services.user_blueprint_service import (
            _kw_matches_text,
            _parse_project_blueprint_markdown,
            _truncate_clean,
        )

        # Short ASCII token must respect word boundaries (no false match of "cas" in "broadcast" or "ai" in "tailwind")
        self.assertFalse(_kw_matches_text("cas", "websocket broadcast service"))
        self.assertTrue(_kw_matches_text("cas", "cas number lookup and smiles"))
        self.assertFalse(_kw_matches_text("ai", "tailwindcss and main container"))
        self.assertTrue(_kw_matches_text("ai", "multi-agent ai platform"))

        # Clean word-boundary truncation removes trailing stopwords and never slices words in half
        truncated = _truncate_clean("Memento: the web app in a window, with the local daemon", max_len=42)
        self.assertFalse(truncated.endswith("with"))
        self.assertFalse(truncated.endswith("the"))
        self.assertIn("window", truncated)

        # Noise tech stack tokens are filtered out and models/routes are accurately counted
        sample_bp = (
            "# Project Blueprint: iptv\n"
            "- **Languages**: `Generic`\n"
            "- **Frameworks & Libraries**: `None detected`\n"
            "- **Infrastructure & Tooling**: `Standard local runtime`\n"
            "## 4. Key Entry Points & API Endpoints\n"
            "### Registered API Routers & Endpoints\n"
            "#### `/api/admin` (admin.py)\n"
            "- `GET /api/admin/users`\n"
            "- _... (9 more endpoints)_\n"
            "### Core Database Models (`models.py`)\n"
            "`Base`, `User`, `Project`, `Document`\n"
            "## 5. Core Domain Services & Background Schedules\n"
            "| `svc1` | path | desc |\n"
        )
        parsed = _parse_project_blueprint_markdown(sample_bp)
        self.assertEqual(parsed["tech_stack"], [])
        self.assertEqual(parsed["models_count"], 3)
        self.assertEqual(parsed["routes_count"], 10)

        # Mind resonance user blueprint summary extraction
        sample_ubp = (
            "# User Cognitive & Domain Blueprint: Haixing Dong\n"
            "## 2. 学科交叉与专业领域\n"
            "| 学科 | 方向 | 项目 | 特征 |\n"
            "| :--- | :--- | :--- | :--- |\n"
            "| **计算机科学与分布式系统**<br/>*CS* | 全栈系统工程 | `memento` | `fastapi` |\n"
        )
        ubp_digest = _summarize_user_blueprint_markdown(sample_ubp)
        self.assertIn("[DISC] 计算机科学与分布式系统: 全栈系统工程 (`memento`)", ubp_digest)


if __name__ == "__main__":
    unittest.main()
