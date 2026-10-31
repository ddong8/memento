import json
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import User, UserMemory
from server.services.dreaming_service import (
    USER_VOICE_BATCH_CHARS,
    USER_VOICE_MAX_BATCHES,
    _is_suspicious_non_project,
    clean_user_voice,
    export_core_memory_markdown,
    plan_user_voice_batches,
    render_user_voice,
    extract_canonical_projects,
    resolve_canonical_slug,
    run_dreaming_pipeline,
    sanitize_transient_text,
)


class TestDreamingService(unittest.IsolatedAsyncioTestCase):
    def test_sanitize_transient_text(self):
        raw = (
            "Here is an image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMkll"
            "And some huge code: " + ("abcdef1234567890" * 300)
        )
        cleaned = sanitize_transient_text(raw)
        self.assertIn("[image_base64_omitted]", cleaned)
        self.assertLess(len(cleaned), len(raw))

    async def test_export_core_memory_markdown(self):
        user = User(id=uuid.uuid4(), email="test@example.com")
        mem1 = UserMemory(
            user_id=user.id,
            category="rule",
            key="windows_update_policy",
            content="Windows 桌面端自更新必须使用 .zip 格式在位热替换，严禁下发 setup.exe。",
            confidence=0.95,
            source="dreaming",
        )
        mem2 = UserMemory(
            user_id=user.id,
            category="architecture",
            key="three_tier_memory",
            content="记忆采用三层金字塔：L1 工作会话，L2 每日研报，L3 长期核心准则。",
            confidence=0.98,
            source="manual",
        )

        mock_db = AsyncMock()
        mock_result = MagicMock()
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = [mem1, mem2]
        mock_result.scalars.return_value = mock_scalars
        mock_db.execute.return_value = mock_result

        md = await export_core_memory_markdown(mock_db, user)
        self.assertIn("# MEMORY.md", md)
        self.assertIn("windows_update_policy", md)
        self.assertIn("three_tier_memory", md)
        self.assertIn("开发铁律与工程规范", md)
        self.assertIn("核心架构决策与设计模式", md)

    async def test_run_dreaming_pipeline_with_llm_reflection(self):
        user = User(id=uuid.uuid4(), email="dev@example.com")

        mock_db = AsyncMock()
        mock_db.add = MagicMock()

        def make_mock_result(scalar_items=None, all_items=None, one_item=None):
            m = MagicMock()
            sc = MagicMock()
            sc.all.return_value = scalar_items or []
            m.scalars.return_value = sc
            m.all.return_value = all_items or []
            m.scalar_one_or_none.return_value = one_item
            return m

        mock_llm_json = {
            "light_sleep_notes": "清洗了会话与工具日志",
            "rem_reflections": "发现用户致力于构建高性能桌面端记忆伴侣，重点优化了更新提权与后台长连接。",
            "deep_consolidations": "正式固化两项开发规范与架构决策",
            "promoted_memories": [
                {
                    "category": "rule",
                    "key": "windows_update_policy",
                    "content": "Windows 更新必须使用 .zip 在位热替换",
                    "confidence": 0.95,
                }
            ],
            "discovered_relations": [
                {
                    "source": "Windows更新",
                    "target": "PowerShell",
                    "relation": "uses",
                }
            ],
        }

        with patch("server.services.dreaming_service.get_ai_providers", return_value=[{"provider": "test"}]), \
             patch("server.services.dreaming_service.call_plain_chat", AsyncMock(return_value=json.dumps(mock_llm_json))):

            mock_ds = MagicMock()
            mock_ds.summary_date = date.today()
            mock_ds.title = "今日工作小结"
            mock_ds.summary = "完成了 Windows 自动更新修复"

            mock_db.execute.side_effect = [
                make_mock_result(all_items=[]),           # doc_projects (extract_canonical_projects)
                make_mock_result(all_items=[]),           # ke_projects (extract_canonical_projects)
                make_mock_result(scalar_items=[mock_ds]), # daily_summaries
                make_mock_result(scalar_items=[]),        # ask_convs
                make_mock_result(all_items=[]),           # recent_msgs
                make_mock_result(all_items=[]),           # window_docs
                make_mock_result(all_items=[]),           # window_ents
                make_mock_result(scalar_items=[]),        # existing_mems
                make_mock_result(one_item=None),          # check existing for promoted memory
                make_mock_result(one_item=None),          # check source entity
                make_mock_result(one_item=None),          # check target entity
            ]

            journal = await run_dreaming_pipeline(mock_db, user, days_back=1)

            self.assertEqual(journal.user_id, user.id)
            self.assertEqual(journal.stage_metrics["promoted_count"], 1)
            self.assertIn("清洗了会话与工具日志", journal.light_sleep_notes)
            self.assertIn("Windows 更新必须使用 .zip 在位热替换", journal.report_markdown)
            self.assertTrue(mock_db.commit.called)

    def test_is_suspicious_non_project(self):
        # Chemical compounds and IUPAC
        self.assertTrue(_is_suspicious_non_project("3_甲基_3,9_二氮杂螺[5,5]十一烷", "3-甲基-3,9-二氮杂螺[5.5]十一烷"))
        self.assertTrue(_is_suspicious_non_project("s_4_4_二苯并", "(S)-[4,4'-二苯并-1,3-二氧杂环戊-5,5'-二基]双(二苯基膦)"))
        self.assertTrue(_is_suspicious_non_project("smiles_c1234", "SMILES: CC(C)C1=CC=C..."))

        # IP addresses and nodes
        self.assertTrue(_is_suspicious_non_project("192_0_2_10", "192.0.2.10"))
        self.assertTrue(_is_suspicious_non_project("198_51", "198.51"))
        self.assertTrue(_is_suspicious_non_project("node_144", "node-144"))

        # Models & hardware specs
        self.assertTrue(_is_suspicious_non_project("80b模型", "80b模型探讨"))
        self.assertTrue(_is_suspicious_non_project("16gb_apple_silicon", "16gb_apple_silicon_mac小llm选型"))

        # Valid projects should NOT be flagged
        self.assertFalse(_is_suspicious_non_project("quant_future", "quant_future"))
        self.assertFalse(_is_suspicious_non_project("binance_quant_bot", "binance_quant_bot"))
        self.assertFalse(_is_suspicious_non_project("scifinder_retro_svc", "scifinder_retro_svc"))
        self.assertFalse(_is_suspicious_non_project("yicaigou", "易采购"))

    def test_resolve_canonical_slug(self):
        self.assertEqual(resolve_canonical_slug("claude_code/quant-future"), "quant_future")
        self.assertEqual(resolve_canonical_slug("antigravity/binance-quant-bot"), "binance_quant_bot")
        self.assertEqual(resolve_canonical_slug("易采购b2b商城"), "yicaigou")
        self.assertEqual(resolve_canonical_slug("qbacktest"), "quant_backtest")
        self.assertEqual(resolve_canonical_slug("scifinder"), "scifinder_retro_svc")

    async def test_extract_canonical_projects_filters_noise(self):
        user = User(id=uuid.uuid4(), email="test@example.com")
        mock_db = AsyncMock()

        # Document projects: includes legitimate projects and some noisy ones
        doc_rows = [
            ("quant_future", "quant_future", 20),
            ("3_甲基_3,9_二氮杂螺", "化学化合物", 10),  # Suspicious non-project -> filtered
            ("192_0_2_10", "服务器节点", 8),        # IP -> filtered
            ("scratch_tool", "临时脚本", 2),            # cnt < 5 and uncurated -> filtered
        ]
        # Knowledge entities: zero-doc noise entities marked as 'project'
        ke_rows = [
            ("quant_future", "量化期货系统总结", 15),
            ("塞来昔布中间体", "化学物质总结", 5),       # Uncurated KE with 0 docs -> ignored
            ("2周反转策略", "交易策略细节", 3),           # Uncurated KE with 0 docs -> ignored
        ]

        res_doc = MagicMock()
        res_doc.all.return_value = doc_rows
        res_ke = MagicMock()
        res_ke.all.return_value = ke_rows
        mock_db.execute.side_effect = [res_doc, res_ke]

        projects = await extract_canonical_projects(mock_db, user)
        slugs = [p["slug"] for p in projects]

        self.assertIn("quant_future", slugs)
        self.assertNotIn("3_甲基_3,9_二氮杂螺", slugs)
        self.assertNotIn("192_0_2_10", slugs)
        self.assertNotIn("scratch_tool", slugs)
        self.assertNotIn("塞来昔布中间体", slugs)
        self.assertNotIn("2周反转策略", slugs)


class TestUserVoice(unittest.IsolatedAsyncioTestCase):
    def test_source_tags_ride_along_with_the_text(self):
        ts = datetime(2026, 9, 27, 14, 2, tzinfo=timezone.utc)
        batches, stats = plan_user_voice_batches([
            ("结构式要带手性", ts, "chembook @ DESKTOP-KR9IPP4"),
            ("中文回复我", ts, None),
            ("结构式要带手性", ts, "chembook @ DESKTOP-KR9IPP4"),
        ])
        self.assertEqual(stats["kept"], 2)
        self.assertIn("[09-27 14:02] [chembook @ DESKTOP-KR9IPP4] 结构式要带手性", batches[0])
        self.assertIn("[09-27 14:02] 中文回复我", batches[0])

    def test_clean_user_voice_drops_text_the_user_did_not_type(self):
        for content in [
            "[Result] total 48 drwxr-xr-x",
            "<command-name>/model</command-name>",
            "This session is being continued from a previous conversation",
            "[Request interrupted by user]",
            "<environment_context>cwd=/tmp</environment_context>",
            "Continue",
            "继续",
            "2",
            "",
            None,
        ]:
            self.assertIsNone(clean_user_voice(content), content)

    def test_clean_user_voice_drops_prompts_a_script_sent_to_a_model(self):
        template = ("你是资深有机合成/逆合成专家。给你一个化合物的自动逆合成路线及其结构化信号(每步的可行性罚分、"
                    "前向回验通过/存疑、起始物是否可购/真实、文献先例、成本)。请用中文写一段简洁、专业、面向化学博士的结论，"
                    "必须基于逐分子评估与核验结果，不要客套。")
        self.assertIsNone(clean_user_voice(template))
        self.assertIsNone(clean_user_voice("你是逆合成平台技术负责人。下面是 8 个真实分子上，化学家对升级前后单步排序的独立比对，" * 3))
        self.assertIsNone(clean_user_voice("You are an expert code reviewer. Review the following diff and list every bug. " * 3))
        # Short, or not a role assignment: the user talking to the AI
        self.assertEqual(clean_user_voice("你是专家，怎么还犯这种错"), "你是专家，怎么还犯这种错")
        asked = "你是不是又把专家模式关了？" + "我之前说过要一直开着，" * 12
        self.assertTrue(clean_user_voice(asked).startswith("你是不是又把专家模式关了"))

    def test_clean_user_voice_keeps_typed_text_and_strips_injected_context(self):
        self.assertEqual(
            clean_user_voice("以后都用中文回复我 <system-reminder>ignore me</system-reminder>"),
            "以后都用中文回复我",
        )
        pasted = "build 报错了 " + "x" * 5000
        cleaned = clean_user_voice(pasted)
        self.assertTrue(cleaned.startswith("build 报错了"))
        self.assertLessEqual(len(cleaned), 301)

    def test_batches_dedupe_and_read_oldest_first(self):
        t0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
        rows = [  # newest first, as the query returns them
            ("第二句话", t0 + timedelta(minutes=2)),
            ("第一句话", t0 + timedelta(minutes=1)),
            ("第一句话", t0),
        ]
        batches, stats = plan_user_voice_batches(rows)
        self.assertEqual(stats["kept"], 2)
        self.assertEqual(len(batches), 1)
        self.assertIn("第一句话", batches[0][0])
        self.assertIn("第二句话", batches[0][1])

    def test_corrections_survive_when_window_overflows(self):
        t0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
        chatter = [(f"普通任务 {i} " + "y" * 250, t0 + timedelta(seconds=i)) for i in range(2000)]
        correction = ("不对，以后部署都走 GitOps，别手动 kubectl", t0 - timedelta(days=1))  # oldest row
        batches, stats = plan_user_voice_batches(chatter + [correction])

        self.assertEqual(stats["batches"], USER_VOICE_MAX_BATCHES)
        self.assertLess(stats["used"], stats["kept"])
        self.assertTrue(any("GitOps" in line for line in batches[0]))
        for batch in batches:
            self.assertLessEqual(sum(len(line) for line in batch), USER_VOICE_BATCH_CHARS)

    async def test_single_batch_is_passed_verbatim(self):
        with patch("server.services.dreaming_service.call_plain_chat", AsyncMock()) as llm:
            out = await render_user_voice([["[09-01 10:00] 用中文回复"]])
        self.assertEqual(out, "[09-01 10:00] 用中文回复")
        llm.assert_not_called()

    async def test_multiple_batches_are_condensed_to_signals(self):
        reply = json.dumps({"signals": [
            {"kind": "preference", "statement": "始终用中文回复", "evidence": "任何内容都用中文回复我"},
        ]})
        with patch("server.services.dreaming_service.get_ai_providers", return_value=[{"provider": "t"}]), \
             patch("server.services.dreaming_service.call_plain_chat", AsyncMock(return_value=reply)) as llm:
            out = await render_user_voice([["a"], ["b"], ["c"]])
        self.assertEqual(llm.await_count, 3)
        self.assertEqual(out.count("始终用中文回复"), 1)  # deduped across batches
        self.assertIn("[preference]", out)


class TestManualMemoryProtection(unittest.IsolatedAsyncioTestCase):
    async def test_dreaming_does_not_overwrite_manual_memory(self):
        user = User(id=uuid.uuid4(), email="dev@example.com")
        manual = UserMemory(
            user_id=user.id, category="rule", key="deploy_policy",
            content="只走 GitOps", confidence=1.0, source="manual", tree_path="/rules/deploy",
        )
        llm_json = {
            "promoted_memories": [
                {"category": "rule", "key": "deploy_policy", "content": "可以手动 kubectl apply", "confidence": 0.95},
            ],
        }

        def result(scalar_items=None, all_items=None, one_item=None):
            m = MagicMock()
            m.scalars.return_value.all.return_value = scalar_items or []
            m.all.return_value = all_items or []
            m.scalar_one_or_none.return_value = one_item
            return m

        mock_db = AsyncMock()
        mock_db.add = MagicMock()
        mock_db.execute.side_effect = [
            result(), result(),                      # extract_canonical_projects
            result(), result(), result(),            # daily, ask, user voice
            result(), result(all_items=[("t", "session", "s")]),  # docs, entities
            result(scalar_items=[manual]),           # existing core memories
            result(one_item=manual),                 # lookup for promoted memory
        ]
        with patch("server.services.dreaming_service.get_ai_providers", return_value=[{"provider": "t"}]), \
             patch("server.services.dreaming_service.call_plain_chat", AsyncMock(return_value=json.dumps(llm_json))):
            journal = await run_dreaming_pipeline(mock_db, user, days_back=1)

        self.assertEqual(manual.content, "只走 GitOps")
        self.assertEqual(manual.source, "manual")
        self.assertEqual(journal.stage_metrics["promoted_count"], 0)
        self.assertIn("保留手写", journal.report_markdown)

    async def test_dreaming_discovers_and_registers_domain_scenario(self):
        from server.services.mind_resonance_service import get_all_scenarios, reset_scenarios_to_default

        reset_scenarios_to_default()
        user = User(id=uuid.uuid4(), email="scientist@example.com")
        llm_json = {
            "light_sleep_notes": "清洗量子计算与分子动力学对话记录",
            "rem_reflections": "提炼出高频量子化学模拟特征与收敛性约定",
            "deep_consolidations": "生成新兴领域场景并固化至 L3 Core Memory",
            "promoted_memories": [],
            "discovered_relations": [],
            "discovered_scenarios": [
                {
                    "id": "quantum_chem",
                    "name": "量子化学模拟与DFT计算",
                    "keywords": ["dft", "gaussian", "orca", "基组"],
                    "mindset": "收敛精度第一，严禁盲目加大基组；基准测试先行。",
                    "target_project": "quantum_orca",
                    "anchors": ["DFT", "ORCA", "Gaussian"],
                    "defense_rules": [
                        "1) 计算前必须先进行小基组预优化，严禁直接上大基组耗尽资源。",
                    ],
                    "device_affinity": "linux",
                }
            ],
        }

        def result(scalar_items=None, all_items=None, one_item=None):
            m = MagicMock()
            m.scalars.return_value.all.return_value = scalar_items or []
            m.all.return_value = all_items or []
            m.scalar_one_or_none.return_value = one_item
            return m

        mock_db = AsyncMock()
        mock_db.add = MagicMock()
        mock_db.execute.side_effect = [
            result(), result(),                      # extract_canonical_projects
            result(), result(), result(),            # daily, ask, user voice
            result(), result(all_items=[("t", "session", "s")]),  # docs, entities
            result(),                                # existing core memories
            result(one_item=None),                   # lookup for existing scenario in UserMemory
        ]
        with patch("server.services.dreaming_service.get_ai_providers", return_value=[{"provider": "t"}]), \
             patch("server.services.dreaming_service.call_plain_chat", AsyncMock(return_value=json.dumps(llm_json))):
            journal = await run_dreaming_pipeline(mock_db, user, days_back=1)

        self.assertEqual(journal.stage_metrics.get("discovered_scenarios"), 1)
        self.assertIn("量子化学模拟与DFT计算", journal.report_markdown)

        # Verify mind resonance service now recognizes the registered scenario
        all_scens = {s["id"]: s for s in get_all_scenarios()}
        self.assertIn("quantum_chem", all_scens)
        self.assertEqual(all_scens["quantum_chem"]["target_project"], "quantum_orca")

        # Verify it was added to UserMemory
        added_objs = [call[0][0] for call in mock_db.add.call_args_list if len(call[0]) > 0]
        scen_mem = next((obj for obj in added_objs if isinstance(obj, UserMemory) and obj.category == "resonance_scenario"), None)
        self.assertIsNotNone(scen_mem)
        self.assertEqual(scen_mem.key, "scenario_quantum_chem")

        reset_scenarios_to_default()


if __name__ == "__main__":
    unittest.main()
