"""Of several devices' PROJECT_BLUEPRINT.md copies, every reader takes the one describing the newest code
(2026-11-09: a laptop's 10-17 checkout synced last and was shown instead of the 11-09 one)."""

from datetime import datetime, timedelta, timezone
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

NOW = datetime(2026, 11, 9, 2, 0, tzinfo=timezone.utc)


def bp(name: str, commit: str, day: str, history: list[tuple[str, str]], branch: str = "main") -> str:
    latest = history[0] if history else (commit, day)
    evo = "\n".join(f"- `{h}` ({d}): change {h}" for h, d in history)
    return (
        f"# Project Blueprint: {name}\n\n"
        "> [!NOTE]\n"
        f"> **Living Blueprint Auto-Generated** · Branch: `{branch}` · Commit: `{commit}` · Updated: `{day}`\n\n"
        "## 0. 速览与章节索引 (Quick Summary & Section Index)\n\n"
        f"- 类型 (Type): Monorepo\n- 最近改动 (Latest): `{latest[0]}` ({latest[1]}): change {latest[0]}\n\n"
        "## 1. Project Overview & Tech Stack\n- **Core Languages**: `TypeScript/JavaScript`\n\n"
        f"## 9. Recent Architectural Evolutions\n\n{evo}\n"
    )


LAPTOP = bp("memento", "3bc178f99", "2026-10-17", [("3bc178f99", "2026-10-17"), ("1a2b3c4d5", "2026-10-16")])
MINI = bp("memento", "31ea7d9d", "2026-11-09", [("31ea7d9d", "2026-11-09"), ("42e2eb50", "2026-11-09")])
WINDOWS = bp("memento", "33985afb", "2026-11-03", [("33985afb", "2026-11-03")])


class TestPickFreshest(unittest.TestCase):
    def pick(self, rows):
        from server.services.blueprint_pick import pick_freshest

        return pick_freshest(rows, lambda r: r[0], lambda r: r[1])

    def test_newest_code_wins_over_last_synced(self):
        rows = [(LAPTOP, NOW), (WINDOWS, NOW - timedelta(hours=1)), (MINI, NOW - timedelta(hours=2))]
        self.assertIs(self.pick(rows)[0], MINI)

    def test_same_day_descendant_wins(self):
        # Both committed the same day: the copy whose history holds the other's commit is ahead
        ahead = bp("x", "bbbbbbbb", "2026-11-09", [("bbbbbbbb", "2026-11-09"), ("aaaaaaaa", "2026-11-09")])
        behind = bp("x", "aaaaaaaa", "2026-11-09", [("aaaaaaaa", "2026-11-09")])
        self.assertIs(self.pick([(behind, NOW), (ahead, NOW - timedelta(hours=3))])[0], ahead)
        # Short hashes grow a digit as a repo grows: the same commit as 8 and 9 digits
        ahead9 = bp("x", "bbbbbbbbb", "2026-11-09", [("bbbbbbbbb", "2026-11-09"), ("aaaaaaaaa", "2026-11-09")])
        self.assertIs(self.pick([(behind, NOW), (ahead9, NOW - timedelta(hours=3))])[0], ahead9)

    def test_same_commit_or_no_git_falls_back_to_last_synced(self):
        later = MINI.replace("Monorepo", "Monorepo (Workspaces)")
        self.assertIs(self.pick([(MINI, NOW - timedelta(hours=1)), (later, NOW)])[0], later)
        plain_old = "# Project Blueprint: x\n\n> Branch: `detached-HEAD` · Commit: `unknown` · Updated: `recent`\n"
        plain_new = plain_old + "\n## 1. more\n"
        self.assertIs(self.pick([(plain_old, NOW - timedelta(hours=1)), (plain_new, NOW)])[0], plain_new)
        self.assertIsNone(self.pick([(None, NOW), ("", NOW)]))


class TestReaders(unittest.IsolatedAsyncioTestCase):
    async def test_project_api_takes_the_newest_of_its_own_copies(self):
        from server.api.projects import _resolve_codebase_blueprint
        from server.db.models import Project

        project = Project(id=uuid.uuid4(), title="memento", slug="memento")
        other = uuid.uuid4()
        res = MagicMock()
        # Newest synced first, as the query orders them; a same-named project's copy is newer still
        newest_elsewhere = bp("memento", "ffffffff", "2026-11-10", [("ffffffff", "2026-11-10")])
        res.all.return_value = [
            (LAPTOP, NOW, project.id),
            (newest_elsewhere, NOW, other),
            (MINI, NOW - timedelta(hours=2), project.id),
        ]
        db = AsyncMock()
        db.execute.return_value = res
        self.assertIs(await _resolve_codebase_blueprint(db, project, None), MINI)
        # Only same-named copies: the newest of them
        res.all.return_value = [(LAPTOP, NOW, other), (newest_elsewhere, NOW - timedelta(hours=5), other)]
        self.assertIs(await _resolve_codebase_blueprint(db, project, None), newest_elsewhere)

    async def test_mind_resonance_snapshot_is_the_newest_checkout(self):
        from server.db.models import User
        from server.services.mind_resonance_service import _fetch_project_blueprint_summary

        res = MagicMock()
        res.all.return_value = [(LAPTOP, NOW), (MINI, NOW - timedelta(hours=2))]
        db = AsyncMock()
        db.execute.return_value = res
        out = await _fetch_project_blueprint_summary(db, User(id=uuid.uuid4()), "memento")
        self.assertIn("31ea7d9d", out)
        self.assertNotIn("3bc178f99", out)

    async def test_project_blueprint_api_leaves_device_copies_out_of_curated_docs(self):
        from server.api.projects import get_project_blueprint
        from server.db.models import Project, User

        user = User(id=uuid.uuid4(), email="u@example.com", role="user")
        project = Project(id=uuid.uuid4(), title="memento", slug="memento", tool_id="claude_code")
        statements: list[str] = []

        async def fake_execute(stmt, *a, **kw):
            statements.append(str(stmt))
            res = MagicMock()
            res.scalar_one_or_none.return_value = project
            res.scalars.return_value.all.return_value = []
            res.all.return_value = [(LAPTOP, NOW, project.id), (MINI, NOW - timedelta(hours=2), project.id)]
            return res

        db = AsyncMock()
        db.execute.side_effect = fake_execute
        with patch("server.api.projects.user_machine_ids", new_callable=AsyncMock, return_value=None), \
             patch("server.api.projects.cache_get", new_callable=AsyncMock, return_value=None), \
             patch("server.api.projects.cache_set", new_callable=AsyncMock):
            out = await get_project_blueprint(project.id, recent_convs=0, db=db, _user=user)
        self.assertIs(out["codebase_blueprint"], MINI)
        curated_sql = next(s for s in statements if "documents.category IN" in s)
        self.assertIn("relative_path) NOT LIKE", curated_sql)


class TestUserBlueprintProjects(unittest.TestCase):
    def sources(self, **kw):
        from server.services.user_blueprint_service import BlueprintSources

        base = dict(
            devices=[{"name": "mac (Darwin)", "platform": "macOS", "online": True}],
            project_rows=[("p1", "memento", "/Users/u/dev/memento", 40, NOW)],
        )
        base.update(kw)
        return BlueprintSources(**base)

    def test_newest_checkout_and_no_stale_clones(self):
        from server.services.user_blueprint_service import _collect_projects

        laptop = LAPTOP.replace("Branch: `main`", "Branch: `old-laptop`")
        clone = bp("gpt4free", "1b32d4f8", "2023-05-03", [("1b32d4f8", "2023-05-03")])
        fresh_clone = bp("login", "ac24991", "2026-11-06", [("ac24991", "2026-11-06")], branch="dev")
        src = self.sources(blueprint_docs=[
            ("p1", "memento/PROJECT_BLUEPRINT.md", laptop, NOW),
            ("p9", "gpt4free/PROJECT_BLUEPRINT.md", clone, NOW),
            ("p8", "login/PROJECT_BLUEPRINT.md", fresh_clone, NOW - timedelta(minutes=30)),
            ("p7", "_repo2/PROJECT_BLUEPRINT.md",
             "# Project Blueprint: _repo2\n\n> Branch: `detached-HEAD` · Commit: `unknown` · Updated: `recent`\n", NOW),
            ("p1", "memento/PROJECT_BLUEPRINT.md", MINI, NOW - timedelta(hours=2)),
        ])
        by_name = {p["name"]: p for p in _collect_projects(src, NOW)}
        self.assertEqual(by_name["memento"]["branch"], "main")
        # A clone kept only for its blueprint, last committed in 2023, is not part of the user's work
        self.assertNotIn("gpt4free", by_name)
        # One whose code moved this week is, even without AI conversations about it
        self.assertIn("login", by_name)
        self.assertTrue(by_name["login"]["has_blueprint"])
        # A folder without commits (an agent's task folder) says nothing about how recent it is
        self.assertNotIn("_repo2", by_name)


if __name__ == "__main__":
    unittest.main()
