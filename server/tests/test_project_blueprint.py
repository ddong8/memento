"""Tests for scripts/project_blueprint.py."""

import sys
import tempfile
import unittest
from pathlib import Path

# Add scripts directory to path
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import project_blueprint  # type: ignore


class TestProjectBlueprint(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self):
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
        git_dir = self.root / ".git" / "hooks"
        git_dir.mkdir(parents=True)

        installed = project_blueprint.install_git_hook(self.root)
        self.assertTrue(installed)
        for hname in ["pre-commit", "post-commit", "post-merge", "post-checkout", "post-rewrite"]:
            hook_path = git_dir / hname
            self.assertTrue(hook_path.exists())
            self.assertIn("project_blueprint.py", hook_path.read_text())

        uninstalled = project_blueprint.uninstall_git_hook(self.root)
        self.assertTrue(uninstalled)
        for hname in ["pre-commit", "post-commit", "post-merge", "post-checkout", "post-rewrite"]:
            hook_path = git_dir / hname
            self.assertNotIn("project_blueprint.py", hook_path.read_text())


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


class TestUserBlueprintService(unittest.IsolatedAsyncioTestCase):
    async def test_build_user_blueprint_synthesizes_disciplines_domains_and_projects(self):
        import uuid
        from unittest.mock import AsyncMock, MagicMock
        from server.db.models import User
        from server.services.user_blueprint_service import build_user_blueprint

        user = User(id=uuid.uuid4(), email="haixing@example.com", name="Haixing Dong", role="owner")
        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.scalars.return_value.all.return_value = []
        mock_res.scalar_one_or_none.return_value = None
        mock_db.execute.return_value = mock_res
        res = await build_user_blueprint(mock_db, user, force_refresh=True)

        self.assertEqual(res["user_name"], "Haixing Dong")
        self.assertTrue(len(res["disciplines"]) >= 2)
        self.assertTrue(len(res["business_domains"]) >= 2)
        self.assertTrue(len(res["projects"]) >= 1)
        self.assertIn("flowchart LR", res["mermaid_topology"])
        self.assertIn("# User Cognitive & Domain Blueprint: Haixing Dong", res["markdown"])
        self.assertIn("## 2. 学科交叉与专业领域", res["markdown"])
        self.assertIn("## 3. 核心业务版图与应用场景", res["markdown"])
        self.assertIn("## 4. 跨项目架构蓝图矩阵", res["markdown"])
        self.assertIn("## 5. 全域技术栈与基础设施雷达", res["markdown"])

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
