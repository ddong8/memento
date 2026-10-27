"""Pure-function tests for the learning loop: memory lifecycle, skills, todos, reviews, evals, guidance."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from server.services import eval_service as es
from server.services import guidance_service as gs
from server.services import memory_lifecycle as ml
from server.services import retrospective_service as rs
from server.services import skill_service as ss
from server.services import todo_service as ts
from server.services.tokenize import query_terms, tokenize_for_query, tokenize_for_query_any

T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)


def mem(category="rule", source="dreaming", tree_path=None, days=0, content="x"):
    return SimpleNamespace(
        id=uuid.uuid4(), category=category, source=source, tree_path=tree_path, content=content,
        updated_at=T0 + timedelta(days=days), created_at=T0, status="active",
        superseded_by=None, status_reason=None,
    )


# ---- memory lifecycle ----

def test_group_key_puts_rules_and_preferences_together_and_splits_projects():
    assert ml.group_key(mem("rule")) == ml.group_key(mem("preference")) == "rules"
    assert ml.group_key(mem("project", tree_path="/project/memento/overview")) == "project:memento"
    assert ml.group_key(mem("pitfall", tree_path="/pitfall/memento/pitfall_x")) == "pitfall:memento"
    assert ml.group_key(mem("architecture")) == "architecture"


def test_settle_never_lets_a_machine_guess_replace_the_users_words():
    manual, guess = mem(source="manual"), mem(source="dreaming", days=5)
    assert ml.settle("conflict", guess, manual) == (manual, guess)
    assert ml.settle("duplicate", guess, manual) == (manual, guess)
    assert ml.settle("conflict", manual, guess) == (manual, guess)


def test_settle_newer_user_word_wins_a_conflict():
    old, new = mem(source="manual", days=0), mem(source="manual", days=3)
    assert ml.settle("conflict", old, new) == (new, old)
    assert ml.settle("duplicate", old, new) == (old, new)


def test_replace_profile_line():
    profile = "### 沟通\n- 用英文回复\n- 简洁\n"
    assert ml.replace_profile_line(profile, "用英文回复", "始终用中文回复") == "### 沟通\n- 始终用中文回复\n- 简洁\n"
    assert ml.replace_profile_line(profile, "用英文回复", None) == "### 沟通\n- 简洁\n"
    assert ml.replace_profile_line(profile, "用英文回复", "简洁") == "### 沟通\n- 简洁\n"
    assert ml.replace_profile_line(profile, "不存在", "x") == profile


# ---- skills ----

def test_slugs_follow_the_agent_skills_rules():
    assert ss.slugify("Memento GitOps Deploy!") == "memento-gitops-deploy"
    assert ss.slugify("部署") .startswith("skill-")
    assert ss.is_valid_slug("memento-deploy")
    for bad in ("Memento", "a--b", "-a", "a-", "a" * 65, "../x"):
        assert not ss.is_valid_slug(bad)
    assert len(ss.slugify("x" * 200)) <= 64


def test_skill_md_frontmatter_is_valid_and_escaped():
    skill = SimpleNamespace(
        id=uuid.uuid4(), slug="deploy", version=3, title="部署",
        description='在 "memento" 里\n部署时用', body="## 步骤\n1. push",
    )
    md = ss.render_skill_md(skill)
    lines = md.split("\n")
    assert lines[0] == "---" and lines[1] == "name: deploy"
    assert lines[2] == 'description: "在 \\"memento\\" 里 部署时用"'
    assert "memento-version: 3" in md and md.count("---\n") == 2
    assert md.rstrip().endswith("1. push")


def test_mined_skill_merge_rules():
    user = SimpleNamespace(id=uuid.uuid4())
    cand = {"title": "部署", "description": "部署 memento 时用", "body": "1. a", "changes": ""}
    now = T0
    skill, event = ss.upsert_mined(user, cand, None, {"doc_id": "d1"}, "deploy", now)
    assert event == "new" and skill.status == "draft" and skill.evidence == [{"doc_id": "d1"}]

    skill.status, skill.edited_by_user = "published", False
    _, event = ss.upsert_mined(user, {**cand, "body": "1. b"}, skill, {"doc_id": "d2"}, "deploy", now)
    assert event == "seen" and skill.body == "1. a"  # published: no silent rewrite
    _, event = ss.upsert_mined(user, {**cand, "body": "1. b", "changes": "多了一步验证"}, skill, {"doc_id": "d3"}, "deploy", now)
    assert event == "update_pending" and skill.pending_update["body"] == "1. b" and skill.body == "1. a"
    assert skill.times_seen == 3

    skill.status = "dismissed"
    _, event = ss.upsert_mined(user, cand, skill, {"doc_id": "d4"}, "deploy", now)
    assert event == "seen"


def test_apply_pending_update_publishes_a_new_version():
    skill = SimpleNamespace(
        status="published", version=2, published_at=None, description="old", body="old",
        pending_update={"description": "new", "body": "new body"},
    )
    ss.apply_pending_update(skill)
    assert (skill.description, skill.body, skill.version, skill.pending_update) == ("new", "new body", 3, None)


# ---- todos ----

def test_todo_prefilters():
    assert ts.looks_like_later("这个先放着，明天再弄")
    assert ts.looks_like_later("记一下：备份改成每周")
    assert not ts.looks_like_later("帮我把超时改成 30 秒")
    assert ts.looks_like_close("那个已经搞定了")


def test_todo_fingerprint_ignores_spacing_and_punctuation():
    assert ts.fingerprint("给导出接口 加分页。") == ts.fingerprint("给导出接口加分页")


def test_due_dates_are_local_days():
    due = ts.parse_due("2026-10-07")
    assert due.utcoffset() == timedelta(hours=8) and (due.hour, due.day) == (0, 7)
    assert ts.parse_due("next week") is None and ts.parse_due(None) is None
    start, end = ts.local_day_bounds(datetime(2026, 9, 27, 17, 0, tzinfo=timezone.utc))  # 01:00 on the 28th local
    assert start.day == 28 and end - start == timedelta(days=1)


def test_reminder_text():
    t = lambda title: SimpleNamespace(title=title)  # noqa: E731
    assert ts.reminder_text({"overdue": [], "today": []}) is None
    title, body = ts.reminder_text({"overdue": [t("a")], "today": [t("b"), t("c")]})
    assert "今天到期 2 条" in title and "逾期 1 条" in title and body == "a；b；c"


# ---- session reviews ----

def test_condense_keeps_user_words_actions_and_errors_only():
    text = rs.condense([
        ("user", "帮我部署 memento"),
        ("assistant", 'Let me check.\n[Tool: Bash]\n{"command": "kubectl get pods"}'),
        ("user", "[Result]\nNAME READY\napi 1/1"),
        ("assistant", '[Tool: Bash]\n{"command": "kubectl apply -f x"}'),
        ("user", "[Result]\nError from server: forbidden"),
        ("user", "<system-reminder>ignore</system-reminder>"),
    ])
    assert "【用户】帮我部署 memento" in text
    assert "⚙ Bash: kubectl get pods" in text and "⚙ Bash: kubectl apply -f x" in text
    assert "api 1/1" not in text  # successful output dropped
    assert "↳ 出错: Error from server: forbidden" in text
    assert "ignore" not in text


def test_condense_reads_tool_rows():
    text = rs.condense([
        ("user", "帮我部署 memento", "user", None, None),
        ("tool", "[Bash]", "tool_call", "Bash", "kubectl get pods"),
        ("tool", "NAME READY\napi 1/1", "tool_output", None, None),
        ("assistant", "改一下配置。", "assistant", "Edit", "/srv/app.yaml"),
        ("tool", "[exec]", "tool_call", None, None),
        ("tool", "Error from server: forbidden", "tool_result", "exec", None),
    ])
    assert "【用户】帮我部署 memento" in text
    assert "⚙ Bash: kubectl get pods" in text and "⚙ Edit: /srv/app.yaml" in text and "⚙ exec" in text
    assert "api 1/1" not in text
    assert "↳ 出错: Error from server: forbidden" in text


def test_tool_summary_reads_antigravity_inputs():
    # as stored: a Python dict whose values are JSON strings
    raw = r"""{'CommandLine': '"Get-ChildItem -Path . -Depth 2"', 'Cwd': '"d:\\\\dev"', 'IsDaemon': 'false'}"""
    assert rs._tool_summary("run_command", raw) == "run_command: Get-ChildItem -Path . -Depth 2"
    raw = r"""{'AbsolutePath': '"d:\\\\dev\\\\app.vue"', 'StartLine': '1'}"""
    assert rs._tool_summary("view_file", raw) == r"view_file: d:\dev\app.vue"
    assert rs._tool_summary("Read", '{"file_path": "/a.py"}') == "Read: /a.py"
    assert rs._tool_summary("Bash", "ls -la") == "Bash: ls -la"


def test_user_voice_drops_the_continuation_snapshot():
    from server.services.dreaming_service import clean_user_voice

    snapshot = (
        "【前序会话核心记忆快照（原会话 ID: aa549791...）】\n### 核心记忆快照\n- 用户要求：必须先自测再交付\n"
        "[10-27 07:29] 助手: 已部署\n\n【执行规则】\n你已完整继承以上前序会话的全部背景。\n\n当前用户指令：\n"
    )
    assert clean_user_voice(snapshot + "把评测也跑一遍") == "把评测也跑一遍"
    assert clean_user_voice(snapshot + "继续") is None
    assert clean_user_voice("【前序会话核心记忆快照】\n只有快照，没有指令") is None
    assert clean_user_voice("【前文对话历史】\n用户: 旧问题\n\n【当前用户指令】\n新问题怎么办") == "新问题怎么办"


def test_harness_pitfalls_are_rejected():
    assert rs.is_harness_pitfall({"title": "Write 前必须先 Read", "symptom": "File has not been read yet"})
    assert rs.is_harness_pitfall({"title": "cd 失败", "cause": "每次 Bash 是独立 shell，工作目录不保留"})
    assert not rs.is_harness_pitfall({"title": "retry 不动", "symptom": "failed | 5 | 424", "cause": "attempts < 5 过滤"})


def test_pitfall_formatting_and_project_folder():
    text = rs.format_pitfall({"title": "换模型后 retry 不动", "symptom": "计数不变", "cause": "attempts 满 5", "fix": "重置 attempts"}, "memento")
    assert text == "【memento】换模型后 retry 不动。现象：计数不变；原因：attempts 满 5；解决：重置 attempts"
    assert rs.project_key("claude_code/Memento") == "memento"
    assert rs.project_key(None) == "general"


# ---- evaluation ----

def test_scores():
    s = es.score_ranks([1, 3, None, 7])
    assert s == {"hit1": 0.25, "hit5": 0.5, "hit10": 0.75, "mrr": round((1 + 1 / 3 + 1 / 7) / 4, 4)}
    assert es.rank_of("b", ["a", "b"]) == 2 and es.rank_of("z", ["a"]) is None


def test_regression_only_compares_runs_on_the_same_set():
    run = lambda v, h: SimpleNamespace(set_version=v, metrics={"hybrid": {"hit5": h}})  # noqa: E731
    assert es.regression([run(1, 0.5), run(1, 0.66)]) == {"metric": "hit5", "now": 0.5, "was": 0.66, "set_version": 1}
    assert es.regression([run(1, 0.62), run(1, 0.66)]) is None
    assert es.regression([run(2, 0.3), run(1, 0.66)]) is None
    assert es.regression([run(1, 0.5)]) is None


def test_regression_compares_with_the_best_run_and_watches_mrr():
    run = lambda h, m: SimpleNamespace(set_version=1, metrics={"hybrid": {"hit5": h, "mrr": m}})  # noqa: E731
    # The real slide, newest first: each weekly step is under the threshold, the total is not
    history = [run(0.4151, 0.2816), run(0.434, 0.3575), run(0.566, 0.4332), run(0.5849, 0.4731)]
    assert es.regression(history[1:]) == {"metric": "hit5", "now": 0.434, "was": 0.5849, "set_version": 1}
    assert es.regression(history)["was"] == 0.5849
    # hit@5 holds while the answer slides from first to fifth place: MRR catches it
    assert es.regression([run(0.58, 0.30), run(0.58, 0.47)]) == {"metric": "mrr", "now": 0.30, "was": 0.47, "set_version": 1}
    # After the fix: a little under the best on both is not a regression
    assert es.regression([run(0.547, 0.4245), *history]) is None


# ---- guidance & query tokens ----

def test_action_synonyms_reach_chinese_notes():
    terms = gs.terms_for("deploy")
    assert "部署" in terms and "上线" in terms
    assert gs.score("部署前先备份数据库", terms) >= 1


def test_render_guidance_sections():
    g = {"action": "deploy", "project": "memento",
         "rules": [{"content": "只走 GitOps"}], "pitfalls": [], "skills": [{"slug": "d", "title": "部署", "description": "x"}]}
    out = gs.render_guidance(g)
    assert "只走 GitOps" in out and "`d` 部署" in out and "踩过的坑" not in out


def test_query_terms_drop_punctuation_and_question_words():
    q = "回滚生产环境具体怎么操作？改哪个文件的镜像 tag？"
    terms = query_terms(q)
    assert "？" not in terms and "怎么" not in terms and "的" not in terms
    assert {"回滚", "镜像", "tag"} <= set(terms)
    assert tokenize_for_query_any(q) == " | ".join(terms)
    assert tokenize_for_query(q) == " & ".join(terms)
