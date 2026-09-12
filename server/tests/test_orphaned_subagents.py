from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.db.models import Document, Project
from server.api.projects import _reconcile_project_documents


class OrphanedSubagentTests(unittest.IsolatedAsyncioTestCase):
    async def test_auto_materialize_missing_parent_for_subagents(self) -> None:
        db = AsyncMock()
        proj_id = uuid.uuid4()
        mach_id = uuid.uuid4()

        project = Project(
            id=proj_id,
            slug="claude_code/pubchem",
            title="pubchem",
            tool_id="claude_code",
        )

        subagent_doc = Document(
            id=uuid.uuid4(),
            project_id=proj_id,
            machine_id=mach_id,
            tool_id="claude_code",
            category="conversation",
            content_type="jsonl",
            content_hash="subagent-hash",
            file_size_bytes=100,
            relative_path="projects/d--dev-2026-0707-pubchem/580b35af-40ce-4ccf-a139-c6bd9b0deebf/subagents/workflows/wf_123/agent-1.jsonl",
            title="agent-1",
        )

        # Mocks:
        # 1. frag_q
        mock_frag = MagicMock()
        mock_frag.scalars.return_value.all.return_value = []
        # 2. match_docs_q
        mock_match = MagicMock()
        mock_match.scalars.return_value.all.return_value = []
        # 3. subagent_q
        mock_subs = MagicMock()
        mock_subs.scalars.return_value.all.return_value = [subagent_doc]
        # 4. p_exist_q (parent does not exist)
        mock_p_exist = MagicMock()
        mock_p_exist.scalar_one_or_none.return_value = None
        # 5. mem_q (memory check)
        mock_mem = MagicMock()
        mem_doc = Document(
            id=uuid.uuid4(),
            project_id=proj_id,
            category="memory",
            title="retro-planner-roadmap",
            content="originSessionId: 580b35af-40ce-4ccf-a139-c6bd9b0deebf",
            content_hash="mem-hash",
            file_size_bytes=50,
            relative_path="memory/retro-planner-roadmap.md",
            tool_id="claude_code",
            content_type="markdown",
        )
        mock_mem.scalar_one_or_none.return_value = mem_doc

        db.execute.side_effect = [mock_frag, mock_match, mock_subs, mock_p_exist, mock_mem]

        adopted = await _reconcile_project_documents(db, project)
        self.assertEqual(adopted, 1)

        # Check that db.add was called with new parent Document
        db.add.assert_called_once()
        added_parent = db.add.call_args[0][0]
        self.assertIsInstance(added_parent, Document)
        self.assertEqual(
            added_parent.relative_path,
            "projects/d--dev-2026-0707-pubchem/580b35af-40ce-4ccf-a139-c6bd9b0deebf.jsonl",
        )
        self.assertEqual(added_parent.project_id, proj_id)
        self.assertEqual(added_parent.title, "retro planner roadmap")
        self.assertEqual(added_parent.metadata_["session_id"], "580b35af-40ce-4ccf-a139-c6bd9b0deebf")
