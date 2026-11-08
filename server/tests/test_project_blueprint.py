"""Tests for scripts/project_blueprint.py."""

import sys
import tempfile
import unittest
from pathlib import Path

# Add scripts directory to path
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import project_blueprint  # type: ignore


def _git(root, *args, check=True):
    import subprocess

    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=check)


def _git_init(root):
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    _git(root, "config", "commit.gpgsign", "false")


class TestProjectBlueprint(unittest.TestCase):
    def setUp(self):
        import os
        from unittest.mock import patch

        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name).resolve() / "repo"
        self.root.mkdir()
        # State and the global copy of the script go to a throwaway home, not the real ~/.memento
        self._env = patch.dict(os.environ, {"HOME": str(Path(self.temp_dir.name).resolve())})
        self._env.start()

    def tearDown(self):
        self._env.stop()
        self.temp_dir.cleanup()

    def test_detect_tech_stack_monorepo_python_node(self):
        # Create package.json with workspaces
        p_json = self.root / "package.json"
        p_json.write_text('{"name": "test-repo", "workspaces": ["apps/*", "packages/*"], "dependencies": {"next": "14.0", "react": "18.0"}}')

        # Create server directory with pyproject.toml
        server_dir = self.root / "server"
        server_dir.mkdir()
        (server_dir / "pyproject.toml").write_text('[project]\nname = "server"\ndependencies = ["fastapi", "sqlalchemy"]')

        stack = project_blueprint.detect_tech_stack(self.root)
        self.assertTrue(stack["is_monorepo"])
        self.assertIn("Python", stack["languages"])
        self.assertIn("TypeScript/JavaScript", stack["languages"])
        self.assertIn("FastAPI", stack["frameworks"])
        self.assertIn("Next.js", stack["frameworks"])

    def test_scan_subsystems_monorepo(self):
        apps_dir = self.root / "apps" / "web"
        apps_dir.mkdir(parents=True)
        (apps_dir / "package.json").write_text('{"name": "@test/web", "description": "Web client app"}')

        pkgs_dir = self.root / "packages" / "daemon"
        pkgs_dir.mkdir(parents=True)
        (pkgs_dir / "package.json").write_text('{"name": "@test/daemon", "description": "Background daemon"}')

        server_dir = self.root / "server"
        server_dir.mkdir(parents=True)

        subsystems = project_blueprint.scan_subsystems(self.root)
        names = [s["name"] for s in subsystems]
        self.assertIn("apps/web", names)
        self.assertIn("packages/daemon", names)
        self.assertIn("server", names)

    def test_generate_mermaid_diagram_contains_expected_nodes(self):
        subsystems = [
            {"name": "apps/web", "type": "Application", "description": "Web"},
            {"name": "packages/daemon", "type": "Package", "description": "Daemon"},
            {"name": "server", "type": "Backend", "description": "Server"},
        ]
        stack = {"languages": ["Python", "TypeScript/JavaScript"], "frameworks": ["FastAPI", "React"]}
        diagram = project_blueprint.generate_mermaid_diagram(subsystems, stack)
        self.assertIn("flowchart TD", diagram)
        self.assertIn("WEB", diagram)
        self.assertIn("DAEMON", diagram)
        self.assertIn("API", diagram)
        self.assertIn("PG", diagram)
        self.assertIn("REDIS", diagram)

    def test_build_blueprint_content(self):
        # Create minimal structure
        (self.root / "package.json").write_text('{"name": "sample", "dependencies": {"react": "18"}}')
        content = project_blueprint.build_blueprint_content(self.root)

        self.assertIn("# Project Blueprint: ", content)
        self.assertIn("## 1. Project Overview & Tech Stack", content)
        self.assertIn("## 2. High-Level Architecture Topology", content)
        self.assertIn("## 3. Subsystem Breakdown & Responsibilities", content)
        self.assertIn("## 8. Development & Verification Commands", content)
        self.assertIn("## 9. Recent Architectural Evolutions", content)

    def test_git_hook_lifecycle(self):
        _git_init(self.root)
        git_dir = self.root / ".git" / "hooks"
        git_dir.mkdir(parents=True, exist_ok=True)

        installed = project_blueprint.install_git_hook(self.root)
        self.assertTrue(installed)
        for hname in ["pre-commit", "post-commit", "post-merge", "post-checkout", "post-rewrite"]:
            hook_path = git_dir / hname
            self.assertTrue(hook_path.exists())
            self.assertIn("project_blueprint.py", hook_path.read_text())

        uninstalled = project_blueprint.uninstall_git_hook(self.root)
        self.assertTrue(uninstalled)
        for hname in ["pre-commit", "post-commit", "post-merge", "post-checkout", "post-rewrite"]:
            # Hooks holding nothing but our block are removed outright
            self.assertFalse((git_dir / hname).exists())


    def test_detect_verification_commands_python_and_node(self):
        # Python project with pytest
        py_root = self.root / "sub_py"
        py_root.mkdir()
        (py_root / "pyproject.toml").write_text("[project]\nname='app'\n[tool.pytest]\n")
        (py_root / "pytest.ini").write_text("[pytest]\n")
        py_cmds = project_blueprint.detect_verification_commands(py_root)
        self.assertIn("pytest", py_cmds)

        # Node project with npm test
        node_root = self.root / "sub_node"
        node_root.mkdir()
        (node_root / "package.json").write_text('{"scripts": {"test": "jest", "lint": "eslint"}}')
        node_cmds = project_blueprint.detect_verification_commands(node_root)
        self.assertIn("npm test", node_cmds)
        self.assertIn("npm run lint", node_cmds)

    def test_include_router_prefix_and_er_singularization(self):
        api_dir = self.root / "app" / "api" / "v1"
        api_dir.mkdir(parents=True)
        (api_dir / "__init__.py").write_text(
            'from fastapi import APIRouter\n'
            'from .algo_trading import router as algo_trading_router\n'
            'api_router = APIRouter()\n'
            'api_router.include_router(algo_trading_router, prefix="/algo-trading")\n'
        )
        (api_dir / "algo_trading.py").write_text(
            'from fastapi import APIRouter\n'
            'router = APIRouter()\n'
            '@router.get("/status")\n'
            'def get_status(): pass\n'
        )
        routes = project_blueprint.scan_api_routes(self.root)
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["prefix"], "/algo-trading")
        self.assertIn("`GET /algo-trading/status`", routes[0]["endpoints"])

        er = project_blueprint.generate_er_diagram([
            "`Account.user_id` ➔ `users.id`",
            "`Transaction.account_id` ➔ `accounts.id`",
        ])
        self.assertIn('USER ||--o{ ACCOUNT : "user_id"', er)
        self.assertIn('ACCOUNT ||--o{ TRANSACTION : "account_id"', er)
        self.assertNotIn("ACCOUNTS", er)

    def test_subsystem_priority_sorting_and_tauri_electron_ipc_routes(self):
        (self.root / "docs").mkdir()
        (self.root / "scripts").mkdir()
        (self.root / "src").mkdir()
        (self.root / "app.py").write_text('"""\n@Time : 2024/08/06\nDo have a faith in what you\'re doing.\n"""\n')
        subs = project_blueprint.scan_subsystems(self.root)
        self.assertEqual(subs[0]["name"], "src")
        app_sub = next(s for s in subs if s["name"] == "app.py")
        self.assertTrue(app_sub["description"].startswith("Root-level "))

        tauri_dir = self.root / "src-tauri" / "src"
        tauri_dir.mkdir(parents=True)
        (tauri_dir / "lib.rs").write_text('#[tauri::command]\npub async fn launch_gateway() {}\n')
        routes = project_blueprint.scan_api_routes(self.root)
        self.assertTrue(any("`IPC tauri:launch_gateway`" in r["endpoints"] for r in routes))


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


class TestBlueprintHooksAndUninstall(unittest.TestCase):
    """Hooks, exclude and state live in a throwaway repo and a throwaway home."""

    def setUp(self):
        import os
        from unittest.mock import patch

        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name).resolve()
        self.home = base / "home"
        self.home.mkdir()
        self.root = base / "repo"
        self.root.mkdir()
        self._env = patch.dict(os.environ, {"HOME": str(self.home)})
        self._env.start()
        _git_init(self.root)
        (self.root / "app.py").write_text("print('hi')\n")
        _git(self.root, "add", "app.py")
        _git(self.root, "commit", "-qm", "init", "--no-verify")

    def tearDown(self):
        self._env.stop()
        self.tmp.cleanup()

    def _hook(self, name):
        return self.root / ".git" / "hooks" / name

    def _run_hook(self, name):
        import subprocess

        return subprocess.run(["sh", str(self._hook(name))], cwd=self.root, capture_output=True, text=True)

    def test_a_failing_pre_commit_still_stops_the_commit(self):
        self._hook("pre-commit").write_text("#!/bin/sh\necho lint failed >&2\nexit 3\n")
        self.assertTrue(project_blueprint.install_git_hook(self.root))
        text = self._hook("pre-commit").read_text()
        self.assertIn("echo lint failed", text)
        self.assertIn(project_blueprint.HOOK_MARKER_START, text)
        self.assertEqual(self._run_hook("pre-commit").returncode, 3)

        self._hook("pre-commit").write_text("#!/bin/sh\nexit 0\n")
        project_blueprint.install_git_hook(self.root)
        self.assertEqual(self._run_hook("pre-commit").returncode, 0)

    def test_hooks_of_other_languages_and_hook_managers_are_left_alone(self):
        py_hook = "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n"
        self._hook("pre-commit").write_text(py_hook)
        self.assertTrue(project_blueprint.install_git_hook(self.root))
        self.assertEqual(self._hook("pre-commit").read_text(), py_hook)
        self.assertIn(project_blueprint.HOOK_MARKER_START, self._hook("post-commit").read_text())

        project_blueprint.uninstall_git_hook(self.root)
        self.assertFalse(self._hook("post-commit").exists())  # nothing but our block was in it
        self.assertEqual(self._hook("pre-commit").read_text(), py_hook)

        _git(self.root, "config", "core.hooksPath", ".husky")
        self.assertTrue(project_blueprint.install_git_hook(self.root))
        self.assertFalse(self._hook("post-commit").exists())
        self.assertFalse((self.root / ".husky").exists())

    def test_untracked_blueprint_is_excluded_and_uninstall_leaves_nothing(self):
        project_blueprint.install_git_hook(self.root)
        bp, changed = project_blueprint.write_blueprint(self.root)
        self.assertTrue(changed)
        self.assertTrue(bp.read_text().startswith("# Project Blueprint:"))
        self.assertIn("## 0. 速览与章节索引", bp.read_text())
        # Kept out of `git status` without touching the repo's .gitignore
        self.assertNotIn("PROJECT_BLUEPRINT.md", _git(self.root, "status", "--porcelain").stdout)
        self.assertFalse((self.root / ".gitignore").exists())
        self.assertTrue((self.root / ".git" / project_blueprint.HEAD_MARKER).is_file())
        self.assertTrue(project_blueprint._state_file(self.root).is_file())
        # Rewriting identical content is not a change
        self.assertFalse(project_blueprint.write_blueprint(self.root)[1])

        self.assertTrue(project_blueprint.uninstall_repo(self.root))
        self.assertFalse(bp.exists())
        self.assertFalse((self.root / ".git" / project_blueprint.HEAD_MARKER).exists())
        self.assertNotIn(project_blueprint.EXCLUDE_MARK, (self.root / ".git" / "info" / "exclude").read_text())
        for name in project_blueprint.MANAGED_GIT_HOOKS:
            self.assertFalse(self._hook(name).exists())
        self.assertFalse((self.home / ".memento" / "blueprint_repos").exists())
        self.assertEqual(_git(self.root, "status", "--porcelain").stdout, "")

    def test_a_hand_written_blueprint_is_never_overwritten(self):
        own = "# Our architecture notes\n\nwritten by hand\n"
        (self.root / "PROJECT_BLUEPRINT.md").write_text(own)
        self.assertFalse(project_blueprint.write_blueprint(self.root)[1])
        project_blueprint.uninstall_repo(self.root)
        self.assertEqual((self.root / "PROJECT_BLUEPRINT.md").read_text(), own)

    def test_anchor_hint_is_opt_in_and_taken_back_exactly(self):
        original = "# Rules\n\n- be brief\n"
        (self.root / "CLAUDE.md").write_text(original)
        project_blueprint.write_blueprint(self.root)
        self.assertEqual((self.root / "CLAUDE.md").read_text(), original)  # not without --anchor
        self.assertEqual(project_blueprint.ensure_agent_guidance_anchor(self.root), ["CLAUDE.md"])
        self.assertIn("「0. 速览与章节索引」", (self.root / "CLAUDE.md").read_text())
        project_blueprint.uninstall_repo(self.root)
        self.assertEqual((self.root / "CLAUDE.md").read_text(), original)

    def test_installer_uninstall_takes_back_blueprints(self):
        from install_lib import collector_setup  # type: ignore

        self.assertTrue(project_blueprint.install_git_hook(self.root))
        project_blueprint.write_blueprint(self.root)
        self.assertTrue((self.home / ".memento" / "blueprint_repos").is_dir())
        collector_setup._remove_blueprints(self.home)
        self.assertFalse((self.root / project_blueprint.BLUEPRINT_FILE).exists())
        self.assertFalse(self._hook("post-commit").exists())
        self.assertFalse((self.root / ".git" / project_blueprint.HEAD_MARKER).exists())
        self.assertFalse((self.home / ".memento" / "blueprint_repos").exists())
        self.assertEqual(_git(self.root, "status", "--porcelain").stdout, "")

    def test_a_tracked_blueprint_survives_uninstall(self):
        project_blueprint.write_blueprint(self.root)
        _git(self.root, "add", "-f", "PROJECT_BLUEPRINT.md")
        _git(self.root, "commit", "-qm", "bp", "--no-verify")
        project_blueprint.install_git_hook(self.root)
        project_blueprint.uninstall_repo(self.root)
        self.assertTrue((self.root / "PROJECT_BLUEPRINT.md").is_file())


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
