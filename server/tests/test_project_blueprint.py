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
        self.assertIn("## 5. Development & Verification Commands", content)
        self.assertIn("## 6. Recent Architectural Evolutions", content)

    def test_git_hook_lifecycle(self):
        git_dir = self.root / ".git" / "hooks"
        git_dir.mkdir(parents=True)

        installed = project_blueprint.install_git_hook(self.root)
        self.assertTrue(installed)
        hook_path = git_dir / "post-commit"
        self.assertTrue(hook_path.exists())
        self.assertIn("project_blueprint.py", hook_path.read_text())

        uninstalled = project_blueprint.uninstall_git_hook(self.root)
        self.assertTrue(uninstalled)
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


if __name__ == "__main__":
    unittest.main()
