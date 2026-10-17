import unittest
import uuid
from datetime import date, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import DreamJournal, User
from server.services.dreaming_service import (
    bootstrap_memories_from_knowledge_graph,
    compute_activity_windows,
    run_dreaming_backfill,
)
from server.tasks.dreaming_tasks import get_backfill_status, set_backfill_status


class TestDreamingBackfill(unittest.IsolatedAsyncioTestCase):
    async def test_compute_activity_windows_with_history(self):
        user = User(id=uuid.uuid4(), email="dev@example.com")
        today = date.today()
        history_start = today - timedelta(days=10)

        mock_db = AsyncMock()
        # Mocking 4 queries: DailySummary min, Document min, AskConversation min, KnowledgeEntity min
        mock_result1 = MagicMock()
        mock_result1.scalar.return_value = history_start

        mock_result2 = MagicMock()
        mock_result2.scalar.return_value = None

        mock_result3 = MagicMock()
        mock_result3.scalar.return_value = None

        mock_result4 = MagicMock()
        mock_result4.scalar.return_value = None

        mock_db.execute.side_effect = [mock_result1, mock_result2, mock_result3, mock_result4]

        windows = await compute_activity_windows(mock_db, user, chunk_days=3)

        self.assertTrue(len(windows) >= 3)
        self.assertEqual(windows[0][0], history_start)
        self.assertEqual(windows[-1][1], today)
        # Check chronological order
        for i in range(len(windows) - 1):
            self.assertTrue(windows[i][1] < windows[i + 1][0])

    async def test_compute_activity_windows_no_history(self):
        user = User(id=uuid.uuid4(), email="dev@example.com")

        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.scalar.return_value = None
        mock_db.execute.side_effect = [mock_res, mock_res, mock_res, mock_res]

        windows = await compute_activity_windows(mock_db, user, chunk_days=3)
        self.assertEqual(windows, [])

    @patch("server.services.dreaming_service.compute_activity_windows")
    @patch("server.services.dreaming_service.run_dreaming_pipeline")
    async def test_run_dreaming_backfill_workflow(self, mock_pipeline, mock_windows):
        user = User(id=uuid.uuid4(), email="dev@example.com")
        w1 = (date(2026, 8, 1), date(2026, 8, 3))
        w2 = (date(2026, 8, 4), date(2026, 8, 6))
        mock_windows.return_value = [w1, w2]

        journal = DreamJournal(
            id=uuid.uuid4(),
            user_id=user.id,
            dream_date=date(2026, 8, 3),
            stage_metrics={"promoted_count": 2},
            report_markdown="backfill report",
        )
        mock_pipeline.return_value = journal

        mock_db = AsyncMock()
        # For w1: has_daily=1, has_ask=0, has_msg=0, has_doc=0, has_ent=0 -> execute
        # For w2: has_daily=0, has_ask=0, has_msg=0, has_doc=0, has_ent=0 -> skip empty
        m_count1 = MagicMock()
        m_count1.scalar.return_value = 1
        m_count0 = MagicMock()
        m_count0.scalar.return_value = 0

        # w1 checks: has_daily=1, has_ask=0, has_msg=0, has_doc=0, has_ent=0 (5 checks)
        # w2 checks: has_daily=0, has_ask=0, has_msg=0, has_doc=0, has_ent=0 (5 checks)
        mock_db.execute.side_effect = [
            m_count1, m_count0, m_count0, m_count0, m_count0,  # w1
            m_count0, m_count0, m_count0, m_count0, m_count0,  # w2
        ]

        progress_events = []

        def on_progress(p):
            progress_events.append(p)

        res = await run_dreaming_backfill(
            mock_db,
            user,
            chunk_days=3,
            max_chunks=10,
            progress_callback=on_progress,
        )

        self.assertEqual(res["status"], "completed")
        self.assertEqual(res["total_windows"], 2)
        self.assertEqual(res["processed_windows"], 1)
        self.assertEqual(res["skipped_windows"], 1)
        self.assertEqual(res["total_promoted"], 2)
        self.assertEqual(len(progress_events), 2)
        self.assertEqual(progress_events[0]["status"], "processed")
        self.assertEqual(progress_events[1]["status"], "skipped_empty")

    @patch("server.services.dreaming_service.call_plain_chat")
    async def test_bootstrap_memories_with_llm(self, mock_llm):
        user = User(id=uuid.uuid4(), email="dev@example.com")
        mock_llm.return_value = """
        {
          "summary": "提炼了核心量化系统与架构规则",
          "memories": [
            {
              "category": "project",
              "tree_path": "/project/quant_future",
              "key": "quant_future",
              "content": "量化交易回测与实盘系统",
              "confidence": 0.96
            },
            {
              "category": "rule",
              "tree_path": "/rules/python/sys_path",
              "key": "sys_path_injection",
              "content": "使用 sys.path 动态导入核心模块",
              "confidence": 0.92
            }
          ]
        }
        """

        mock_db = AsyncMock()
        mock_db.add = MagicMock()
        # Mock doc_projects, ke_projects, techs, obs queries
        res_doc_projs = MagicMock()
        res_doc_projs.all.return_value = [("quant_future", "量化交易项目", 10)]
        res_ke_projs = MagicMock()
        res_ke_projs.all.return_value = []
        res_techs = MagicMock()
        res_techs.all.return_value = [("PostgreSQL", "technology", "数据库配置", 5)]
        res_obs = MagicMock()
        res_obs.all.return_value = [("项目使用 sys.path 注入方式加载模块",)]

        # Mock existing memory query (none existing)
        res_existing = MagicMock()
        res_existing.scalar_one_or_none.return_value = None

        # Mock existing project memories query (none existing)
        res_proj_mems = MagicMock()
        res_proj_mems.scalars.return_value.all.return_value = []

        mock_db.execute.side_effect = [res_doc_projs, res_ke_projs, res_techs, res_obs, res_proj_mems, res_existing, res_existing]

        res = await bootstrap_memories_from_knowledge_graph(mock_db, user)

        self.assertEqual(res["status"], "success")
        self.assertEqual(res["promoted_count"], 2)
        self.assertIn("量化", res["summary"])
        self.assertEqual(len(res["memories"]), 2)
        self.assertEqual(mock_db.add.call_count, 3)  # 2 memories + 1 DreamJournal

    def test_status_registry(self):
        user_id = str(uuid.uuid4())
        self.assertEqual(get_backfill_status(user_id)["status"], "idle")

        set_backfill_status(user_id, {"status": "running", "current": 2, "total": 5})
        status = get_backfill_status(user_id)
        self.assertEqual(status["status"], "running")
        self.assertEqual(status["current"], 2)


if __name__ == "__main__":
    unittest.main()
