"""Unit tests for Round 17: Antigravity 503 failover and retry status optimizations."""

import asyncio
import json
import unittest
import uuid
from unittest.mock import AsyncMock, patch

from server.services.ask_runs import AskRun


class TestRound17Optimizations(unittest.IsolatedAsyncioTestCase):
    async def test_askrun_step_capture_on_retry_and_capacity_chunk(self):
        """Verify that AskRun captures retry and capacity notices into current_step for Live Activity."""
        user_id = uuid.uuid4()
        run = AskRun(
            conversation_id="conv-test-round17",
            user_id=user_id,
            question="测试任务",
            request_id="req-123",
            execution_mode="antigravity",
            model="gemini-3.8-flash",
        )

        async def fake_push(*args, **kwargs):
            return True

        with patch("server.services.notify_service.spawn", side_effect=lambda coro: asyncio.create_task(coro)), \
             patch("server.services.notify_service.push_live_activity_event", side_effect=fake_push):
            # 1. Simulate retry attempt chunk
            chunk_payload = {
                "type": "task_chunk",
                "stream": "stderr",
                "chunk": "\n⏳ [远端模型服务容量紧张/排队中，Antigravity 正在自动退避重试（第 2 次重试），请稍候...]\n\n",
            }
            await run.append(f"data: {json.dumps(chunk_payload)}\n\n")
            self.assertEqual(run.step_type, "executing")
            self.assertIn("远端模型服务容量紧张/排队中", run.current_step)

            # 2. Simulate model failover notice
            failover_chunk = {
                "type": "task_chunk",
                "stream": "stderr",
                "chunk": "\n⚡ [模型容灾降级] 检测到当前模型容量不足 (503 No capacity)，已自动切换至 PRO 档位全新会话无缝重试...\n\n",
            }
            await run.append(f"data: {json.dumps(failover_chunk)}\n\n")
            self.assertEqual(run.step_type, "executing")
            self.assertIn("模型容灾降级", run.current_step)
