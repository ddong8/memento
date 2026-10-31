"""Mind Resonance Service — 前置心领神会与默契共鸣引擎.

让 AI 在生成任何回复或执行任何操作之前，先主动与用户完成「心智同频」：
1. 意图与领域场景智能推断（Intent & Domain Deduction）
2. 知识图谱核心实体与前序决策主动激活（Knowledge Graph Entity Resonance）
3. 历史踩坑与防御性避雷前置预警（Defensive Pitfalls & Failure Patterns）
4. 深度契合用户底层心智模型与隐式偏好（User Mental Model & Iron Rules）
"""

from __future__ import annotations

from datetime import datetime, timezone
import logging
import math
import re
import uuid
from typing import Any

from sqlalchemy import case, literal_column, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import KnowledgeEntity, KnowledgeObservation, KnowledgeRelation, Project, User, UserMemory
from .guidance_service import score, terms_for
from .profile_service import get_published_profile, split_profile_scopes

from contextlib import asynccontextmanager
import inspect
import json
logger = logging.getLogger("server.mind_resonance")


@asynccontextmanager
async def _safe_begin_nested(db: AsyncSession):
    """Savepoint context manager supporting both SQLAlchemy AsyncSession and unit test AsyncMocks."""
    if not hasattr(db, "begin_nested"):
        yield
        return
    nested = db.begin_nested()
    if inspect.iscoroutine(nested):
        nested = await nested
    if hasattr(nested, "__aenter__"):
        async with nested:
            yield
    elif hasattr(nested, "__enter__"):
        with nested:
            yield
    else:
        yield


# Built-in baseline domain patterns with fully decoupled metadata and guardrails
DEFAULT_DOMAIN_SCENARIOS: list[dict[str, Any]] = [
    {
        "id": "evolution_memory",
        "name": "AI 记忆与自进化底座",
        "keywords": ("自进化", "心领神会", "懂我", "记忆", "画像", "dreaming", "memento", "mcp", "profile", "agentic"),
        "mindset": "希望工具能越用越了解用户，具备自进化能力；打破工具孤岛，沉淀终身资产；一次做到位，不绕弯子。",
        "target_project": "memento",
        "anchors": ["心领神会", "常驻画像", "自进化", "避坑"],
        "search_query_extras": "心领神会 常驻画像 自进化",
        "defense_rules": [
            "1) 仔细深入调查问题，从根子上彻底解决，避免重复出现；一次做到位，交付前本地类型检查与自测确认通过。",
            "2) 直接给结论和指令，不绕弯子、不废话、不反问用户。",
        ],
        "device_affinity": "mac",
    },
    {
        "id": "chemistry_pubchem",
        "name": "化学研发与逆合成规划",
        "keywords": ("逆合成", "pubchem", "cas", "smiles", "化合物", "路线", "试剂", "化学", "分子"),
        "mindset": "CAS号精准表述不猜测名称；路线条数可控且AI重排；严禁不稳定格式试剂；一键接入oneapi模型。",
        "target_project": "pubchem",
        "anchors": ["CAS", "SMILES", "逆合成", "格式试剂", "路线重排"],
        "search_query_extras": "CAS SMILES 逆合成",
        "defense_rules": [
            "1) 遇到原文中是 CAS 号的化合物，直接使用 CAS 号表述，严禁猜测化合物名称。",
            "2) 逆合成结果必须经过 AI 重排，步数多的路线不能排在前面；避免生成不稳定的格式试剂。",
        ],
        "device_affinity": "linux",
    },
    {
        "id": "data_harvest",
        "name": "化学数据抓取与资产沉淀",
        "keywords": ("workbuddy", "抓取", "爬虫", "爬取", "数据源", "数据清洗", "资产登记"),
        "mindset": "优先中文网站且必抓中文名；CAS和SMILES为必须字段；先整库dump本地再处理；提供可溯源登记。",
        "target_project": "workbuddy",
        "anchors": ["CAS", "SMILES", "中文名称", "数据抓取", "资产登记"],
        "search_query_extras": "数据抓取 中文名称 dump",
        "defense_rules": [
            "1) 抓取化学数据源优先中文网站，且必须抓取中文名称；CAS 与 SMILES 为必须字段。",
            "2) 先整库 dump 到本地再处理数据；修改数据前先备份原表数据，倾向打标记而非硬删除。",
        ],
        "device_affinity": "linux",
    },
    {
        "id": "ui_performance",
        "name": "前端交互极致性能与设计",
        "keywords": ("前端", "tab", "切换", "卡顿", "渲染", "ui", "aurora", "延迟", "流畅", "动画", "保活"),
        "mindset": "交互零延迟、0ms切换无损保活；界面精致高级；绝不阻塞主线程；桌面端应用名称去掉desktop后缀。",
        "target_project": "memento",
        "anchors": ["交互零延迟", "全屏铺满", "缓存", "流式输出"],
        "search_query_extras": "零延迟 保活 页面流畅",
        "defense_rules": [
            "1) 交互零延迟、避免卡顿与页面卡死，重视前端性能与流畅体验。",
            "2) 界面精致高级，符合 Aurora 设计规范。",
        ],
        "device_affinity": "mac",
    },
    {
        "id": "devops_release",
        "name": "发布交付与无故障上线",
        "keywords": ("发布", "部署", "k8s", "pod", "release", "tag", "更新", "发版", "构建", "docker", "fleet", "gitops", "kubectl", "流水线", "上线", "镜像"),
        "mindset": "发版前必查历史经验避免重踩坑；代码发版打tag并确认所有pod状态；CI/CD零停机更新；帮用户做完勿让用户手动敲命令。",
        "target_project": "memento",
        "anchors": ["version.json", "kustomization", "Fleet", "package.json", "tag", "部署"],
        "search_query_extras": "发布 三位一体 version.json tag",
        "defense_rules": [
            "1) 发版前必查历史经验避免重踩坑，确认代码发版打 tag，且所有 pod 确认已部署更新。",
            "2) 桌面端发布严格遵守元数据三位一体校验（version.json、GitHub Release 与 updates.py 强一致）。",
            "3) 代码提交规范：中文 Conventional Commits 风格，严禁添加 Claude 共同作者信息，保持线性 Git 历史。",
            "4) 发布、部署全流程直接帮用户闭环做完，严禁让用户手动敲命令。",
        ],
        "device_affinity": "linux",
    },
    {
        "id": "data_safety",
        "name": "数据资产安全与审计",
        "keywords": ("删除", "解绑", "设备", "machine", "归档", "purge", "清理数据", "备份"),
        "mindset": "修改前先备份原表数据；倾向打标记归档而非物理硬删除便于审计；删除设备允许保留数据。",
        "target_project": None,
        "anchors": ["归档", "备份", "保留标记", "审计"],
        "search_query_extras": "数据安全 备份 归档 审计",
        "defense_rules": [
            "1) 修改数据前先备份原表数据；数据操作倾向打标记而非硬删除，便于审计追踪。",
            "2) 设备解绑或数据清理操作确保可溯源与可恢复。",
        ],
        "device_affinity": None,
    },
]

# Dynamic registry supporting custom & self-evolved scenarios from Dreaming sweeps
_DYNAMIC_SCENARIOS: dict[str, dict[str, Any]] = {}
_ACTIVE_SCENARIOS: list[dict[str, Any]] = [dict(s) for s in DEFAULT_DOMAIN_SCENARIOS]
DOMAIN_SCENARIOS = _ACTIVE_SCENARIOS


def _refresh_active_scenarios() -> None:
    merged: list[dict[str, Any]] = []
    seen = set()
    for s in DEFAULT_DOMAIN_SCENARIOS:
        sid = s["id"]
        if sid in _DYNAMIC_SCENARIOS:
            merged.append(dict(_DYNAMIC_SCENARIOS[sid]))
        else:
            merged.append(dict(s))
        seen.add(sid)
    for sid, s in _DYNAMIC_SCENARIOS.items():
        if sid not in seen:
            merged.append(dict(s))
            seen.add(sid)
    _ACTIVE_SCENARIOS.clear()
    _ACTIVE_SCENARIOS.extend(merged)


def register_domain_scenario(scenario: dict[str, Any]) -> dict[str, Any]:
    """Register or update a dynamic domain scenario for mind resonance and autonomous self-evolution."""
    sid = scenario.get("id")
    if not sid:
        raise ValueError("Scenario must contain an 'id' field")
    normalized = {
        "id": str(sid).strip(),
        "name": str(scenario.get("name") or sid).strip(),
        "keywords": tuple(str(k).strip() for k in (scenario.get("keywords") or ())),
        "mindset": str(scenario.get("mindset") or "").strip(),
        "target_project": str(scenario.get("target_project") or "").strip(),
        "anchors": [str(a).strip() for a in (scenario.get("anchors") or [])],
        "search_query_extras": str(scenario.get("search_query_extras") or " ".join(list(scenario.get("anchors") or [])[:3])).strip(),
        "defense_rules": [str(r).strip() for r in (scenario.get("defense_rules") or [])],
        "device_affinity": scenario.get("device_affinity"),
    }
    _DYNAMIC_SCENARIOS[normalized["id"]] = normalized
    _refresh_active_scenarios()
    logger.info("Registered dynamic domain scenario: %s (%s)", normalized["name"], normalized["id"])
    return normalized


def register_scenario(scenario: dict[str, Any]) -> None:
    """Register or update a dynamic domain scenario for mind resonance."""
    register_domain_scenario(scenario)


def unregister_scenario(scenario_id: str) -> bool:
    """Unregister a dynamic domain scenario."""
    if scenario_id in _DYNAMIC_SCENARIOS:
        del _DYNAMIC_SCENARIOS[scenario_id]
        _refresh_active_scenarios()
        return True
    return False


def reset_scenarios_to_default() -> None:
    """Reset active scenarios to built-in defaults."""
    _DYNAMIC_SCENARIOS.clear()
    _refresh_active_scenarios()


def get_all_scenarios() -> list[dict[str, Any]]:
    """Return all active domain scenarios (defaults + dynamic overrides)."""
    return [dict(s) for s in _ACTIVE_SCENARIOS]


async def load_dynamic_scenarios_from_db(db: AsyncSession, user_id: uuid.UUID | None = None) -> list[dict[str, Any]]:
    """Dynamically load and register domain scenarios distilled by dreaming_service into active resonance."""
    loaded: list[dict[str, Any]] = []
    try:
        q = select(UserMemory).where(
            UserMemory.category.in_(["resonance_scenario", "scenario", "custom_scenario"]),
            UserMemory.status == "active",
            UserMemory.is_folder.is_(False),
        )
        if user_id:
            q = q.where(UserMemory.user_id == user_id)
        mems = (await db.execute(q)).scalars().all()
        for m in mems:
            try:
                data = json.loads(m.content)
                if isinstance(data, dict) and data.get("id"):
                    register_scenario(data)
                    loaded.append(data)
            except Exception:
                pass
    except Exception as e:
        logger.debug("load_dynamic_scenarios_from_db skipped or failed: %s", e)
    return loaded


def detect_scenario(
    terms: list[str],
    raw_text: str = "",
    extra_scenarios: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Infer the primary scenario and user mindset from query terms and text."""
    low_text = raw_text.lower()
    best_match = None
    best_score = 0
    scenarios_pool = list(_ACTIVE_SCENARIOS)
    if extra_scenarios:
        scenarios_pool.extend(extra_scenarios)

    for scen in scenarios_pool:
        kws = scen.get("keywords") or ()
        sc = sum(2 for k in kws if k in low_text) + sum(1 for k in kws if k in terms)
        if sc > best_score:
            best_score = sc
            best_match = scen

    if best_match and best_score >= 2:
        return best_match
    return {
        "id": "general_engineering",
        "name": "工程研发与深度协同",
        "keywords": (),
        "mindset": "直接给结论和指令，不绕弯子、不废话、不反问；仔细深入调查从根子上彻底解决；一次做到位，交付前自测确认。",
        "target_project": None,
        "anchors": [],
        "search_query_extras": "",
        "defense_rules": [
            "1) 仔细深入调查问题，从根子上彻底解决；一次做到位，交付前本地类型检查与自测确认通过。",
            "2) 直接给结论和指令，不绕弯子、不废话、不反问用户。",
        ],
        "device_affinity": None,
    }


async def _fetch_scoped_and_general_rules(
    db: AsyncSession,
    user: User,
    terms: list[str],
    scenario: dict[str, Any],
    project: str | None,
) -> tuple[list[str], list[str]]:
    """Fetch and score scoped and general rules from published resident profile."""
    scoped_rules: list[str] = []
    general_rules: list[str] = []
    try:
        async with _safe_begin_nested(db):
            prof = await get_published_profile(db, user)
        if prof and prof.content:
            prof_content = prof.content
            scopes = split_profile_scopes(prof_content)
            target_proj = (project or "").strip().lower()
            if not target_proj:
                # Decoupled: read target_project directly from scenario schema
                target_proj = (scenario.get("target_project") or "").strip().lower()

            if target_proj:
                for p_name, lines in scopes.projects.items():
                    if target_proj in p_name.lower() or p_name.lower() in target_proj:
                        scoped_rules.extend(lines)

                # Fallback: scan markdown headings (e.g. #### memento or ### pubchem)
                if not scoped_rules:
                    in_target = False
                    for line in prof_content.splitlines():
                        h_match = re.match(r"^#{2,4}\s+([a-zA-Z0-9_\-\u4e00-\u9fa5]+)", line.strip())
                        if h_match:
                            h_name = h_match.group(1).lower()
                            in_target = target_proj in h_name or h_name in target_proj
                            continue
                        if in_target:
                            stripped = line.strip()
                            if stripped.startswith("-"):
                                scoped_rules.append(stripped.lstrip("- * \t"))
                            elif stripped.startswith("#"):
                                in_target = False

            # Most relevant to the request first (stable for ties), so the top five aren't just the first lines
            scoped_rules = [line for _, line in sorted(
                enumerate(scoped_rules), key=lambda il: (-score(il[1], terms), il[0])
            )]

            # Pick general rules with top resonance to query
            gen_lines = [line.strip("- * \t") for line in scopes.general.splitlines() if line.strip().startswith("-")]
            scored_gen = sorted(gen_lines, key=lambda l: score(l, terms), reverse=True)
            general_rules = [l for l in scored_gen if l][:4]
    except Exception as e:
        logger.warning("Error fetching resident profile in mind resonance: %s", e)
    return scoped_rules, general_rules


async def _fetch_graph_entities(
    db: AsyncSession,
    user: User,
    terms: list[str],
    limit_entities: int,
    target_project: str | None = None,
    rank_terms: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Batch fetch and activate relevant knowledge graph entities with 2-hop topology and project affinity decay.

    terms find the candidates; rank_terms (default: terms) rank them, so the project's name, which
    already earns its own boost, doesn't also count as a match."""
    rank_terms = rank_terms or terms
    entities_data: list[dict[str, Any]] = []
    if not terms:
        return entities_data

    try:
        valid_terms = [t.strip() for t in terms[:12] if t and t.strip()]
        if not valid_terms:
            return entities_data

        # One regex instead of an ILIKE per term and column (150ms -> 30ms on prod, 17k entities). It is
        # written exactly as idx_knowledge_entities_search_trgm is defined, with the constants inline (as
        # bound parameters the planner can't match it to the index): terms of 3+ characters then use the
        # index (~3ms); a two-character Chinese word has no trigram and scans. Entities named by a term
        # come first, or the LIMIT picks by recency alone and drops older exact matches.
        regex_pattern = "|".join(re.escape(t) for t in valid_terms)
        search_text = literal_column("(knowledge_entities.name || ' ' || coalesce(knowledge_entities.summary, ''))")
        ent_q = (
            select(KnowledgeEntity)
            .where(
                KnowledgeEntity.user_id == user.id,
                search_text.op("~*")(regex_pattern),
            )
            .order_by(
                case((KnowledgeEntity.name.op("~*")(regex_pattern), 0), else_=1),
                KnowledgeEntity.updated_at.desc().nulls_last(),
            )
            .limit(ENTITY_CANDIDATES)
        )
        async with _safe_begin_nested(db):
            ent_rows = (await db.execute(ent_q)).scalars().all()

            from datetime import datetime, timezone

            now = datetime.now(timezone.utc)

            def entity_affinity(ent: KnowledgeEntity) -> float:
                # A term in the name says more than one somewhere in the summary
                base_score = float(score(f"{ent.name} {ent.summary or ''}", rank_terms) + 2 * score(ent.name, rank_terms))
                # 艾宾浩斯时间与频次衰减（半衰期 7 天，越近越活跃）
                ent_time = getattr(ent, "updated_at", None) or getattr(ent, "created_at", None)
                if ent_time:
                    if ent_time.tzinfo is None:
                        ent_time = ent_time.replace(tzinfo=timezone.utc)
                    age_days = max(0.0, (now - ent_time).total_seconds() / 86400.0)
                    temporal_factor = 1.0 / (1.0 + age_days / 7.0)
                else:
                    temporal_factor = 0.5

                decayed_score = base_score * (0.4 + 0.6 * temporal_factor)

                if target_project:
                    low_p = target_project.lower()
                    low_name = ent.name.lower()
                    low_sum = (ent.summary or "").lower()
                    if low_p in low_name or low_p in low_sum:
                        decayed_score += 15.0
                return decayed_score

            sorted_ents = sorted(
                ent_rows,
                key=entity_affinity,
                reverse=True,
            )[:limit_entities]

            if not sorted_ents:
                return entities_data

            ent_ids = [e.id for e in sorted_ents]

            # Batch 1: Observations for all matched entities in single query
            obs_map: dict[Any, list[str]] = {eid: [] for eid in ent_ids}
            obs_q = (
                select(KnowledgeObservation.entity_id, KnowledgeObservation.content)
                .where(KnowledgeObservation.entity_id.in_(ent_ids))
                .order_by(KnowledgeObservation.observed_at.desc().nulls_last())
            )
            for eid, content in (await db.execute(obs_q)).all():
                if len(obs_map[eid]) < 2:
                    obs_map[eid].append(content)

            # Batch 2: 1-hop outgoing relations for all matched entities
            rel_map: dict[Any, list[dict[str, Any]]] = {eid: [] for eid in ent_ids}
            rel_q = (
                select(
                    KnowledgeRelation.source_id,
                    KnowledgeRelation.relation_type,
                    KnowledgeEntity.id,
                    KnowledgeEntity.name,
                )
                .join(KnowledgeEntity, KnowledgeRelation.target_id == KnowledgeEntity.id)
                .where(KnowledgeRelation.source_id.in_(ent_ids))
            )
            target_ids = []
            for sid, rel_type, tid, tname in (await db.execute(rel_q)).all():
                if len(rel_map[sid]) < 2:
                    rel_map[sid].append({"rel": rel_type, "target_id": tid, "target_name": tname})
                    target_ids.append(tid)

            # Batch 3: Optional 2-hop extension (fetch 2nd degree outgoing relations for targets)
            second_hop_map: dict[Any, list[str]] = {tid: [] for tid in target_ids}
            if target_ids:
                hop2_q = (
                    select(
                        KnowledgeRelation.source_id,
                        KnowledgeRelation.relation_type,
                        KnowledgeEntity.name,
                    )
                    .join(KnowledgeEntity, KnowledgeRelation.target_id == KnowledgeEntity.id)
                    .where(KnowledgeRelation.source_id.in_(target_ids[:6]))
                )
                for sid, rtype, name in (await db.execute(hop2_q)).all():
                    if len(second_hop_map[sid]) < 1:
                        second_hop_map[sid].append(f"{rtype} → {name}")

        for ent in sorted_ents:
            formatted_rels = []
            for r in rel_map.get(ent.id, []):
                rel_str = f"{r['rel']} → {r['target_name']}"
                hop2 = second_hop_map.get(r["target_id"])
                if hop2:
                    rel_str += f" ({hop2[0]})"
                formatted_rels.append(rel_str)

            entities_data.append({
                "name": ent.name,
                "type": ent.entity_type,
                # Marked stale: later conversations contradict it (entity_canon), so it isn't stated as fact
                "summary": "" if ent.stale_at else (ent.summary or ""),
                "observations": obs_map.get(ent.id, []),
                "relations": formatted_rels,
            })
    except Exception as e:
        logger.warning("Error activating graph entities in mind resonance: %s", e)
    return entities_data


# How much a word says on its own, from the document frequencies jieba ships with: below 6 it is
# everyday language (完成, 继续, 开始, 解决), below 8 common (部署, 优化, 提交), else specific.
_COMMON_WORDS: dict[str, float] | None = None
_FILLER_EN = frozenset(
    "test testing code user users request session http https com www ok okay hi hello hey yes no please help run "
    "use new add fix get set out ran being continued summary ping echo true false none null this that with from "
    "have what when where which will would should could your about into just like make more only some than them "
    "then there these they very want work also back been both each even here how its many most much must other "
    "over same such sure take thing those through upon well were while who why year".split()
)
_CJK = re.compile(r"[一-鿿]")
_PARTICLES = re.compile(r"[了吗呢吧啊呀么的嘛哦]+$")


def _common_words() -> dict[str, float]:
    global _COMMON_WORDS
    if _COMMON_WORDS is None:
        import os

        import jieba

        words: dict[str, float] = {}
        try:
            with open(os.path.join(os.path.dirname(jieba.__file__), "analyse", "idf.txt"), encoding="utf-8") as f:
                for line in f:
                    w, _, v = line.strip().partition(" ")
                    try:
                        idf = float(v)
                    except ValueError:
                        continue
                    if idf < 8:
                        words[w] = idf
        except OSError as e:
            logger.warning("jieba's word frequencies are missing, every word counts as specific: %s", e)
        _COMMON_WORDS = words
    return _COMMON_WORDS


def term_specificity(term: str) -> float:
    """0 for filler, 0.5 for a common word, 1 for one that names something."""
    from .tokenize import _STOPWORDS

    if term in _STOPWORDS or not re.search(r"[a-z一-鿿]", term):
        return 0.0
    if _CJK.search(term):
        base = _PARTICLES.sub("", term)
        if len(base) < 2:
            return 0.0
        idf = _common_words().get(base)
        return 1.0 if idf is None else 0.0 if idf < 6 else 0.5
    w = term.strip(":.")
    if w in _FILLER_EN or len(w) < 2:
        return 0.0
    return 0.5 if len(w) == 2 else 1.0


def pitfall_terms(query: str, action: str | None = None) -> list[str]:
    """What the request is about, for matching pitfalls. A run of Chinese without spaces
    ("部署完了吗") is a phrase whose words jieba already gives; whole, it only matches text
    repeating it verbatim, so it goes."""
    from .tokenize import _segment

    low = (query or "").lower()
    raw = {w for w in re.split(r"[\s_\-/,，;；]+", low) if w}
    tokens = {t.lower().strip() for t in _segment(query or "")}
    return [
        t for t in terms_for(action, query)
        if len(t) >= 2 and not (t in raw and _CJK.search(t) and t not in tokens)
    ]


# A pitfall is injected only when the request names what it is about: one specific word that at most
# one memory has, or rarer words adding up to as much. Tuned by replaying 660 real prompts against 235
# memories on 2026-10-27: "完成了吗", "继续", "发版" inject nothing; "fleet 卡住了" brings the Fleet ones.
PITFALL_MIN_SHARE = 0.94  # of the weight of a specific word only one memory has
PITFALL_KEEP_SHARE = 0.6  # of the best match's score
# Rarity means little among a handful of memories: counted as if there were at least this many
PITFALL_MIN_CORPUS = 50


async def _fetch_pitfalls(
    db: AsyncSession,
    user: User,
    terms: list[str],
    limit_pitfalls: int,
    target_project: str | None = None,
) -> list[dict[str, str]]:
    """Pitfalls, rules and architecture notes the request is specifically about, best first.
    terms: pitfall_terms() of the request; none of them specific, nothing comes back."""
    pitfalls_data: list[dict[str, str]] = []
    if not terms:
        return pitfalls_data
    try:
        async with _safe_begin_nested(db):
            mem_q = select(UserMemory).where(
                UserMemory.user_id == user.id,
                UserMemory.status == "active",
                UserMemory.is_folder.is_(False),
                UserMemory.category.in_(("pitfall", "rule", "architecture")),
            )
            all_mems = (await db.execute(mem_q)).scalars().all()
        texts = [f"{m.key} {m.tree_path or ''} {m.content}".lower() for m in all_mems]
        n = max(len(texts), PITFALL_MIN_CORPUS)
        # A word few memories share (fleet) says more than a common one (卡住); filler says nothing
        weight = {}
        for t in dict.fromkeys(terms):
            spec = term_specificity(t)
            if spec > 0:
                weight[t] = spec * math.log((n + 1) / (1 + sum(t in x for x in texts)))
        min_score = PITFALL_MIN_SHARE * math.log((n + 1) / 2)
        scored_pitfalls = []
        for m, text in zip(all_mems, texts):
            hit = [t for t in weight if t in text]
            # 部署 inside 部署流水线 is the same match
            hit = [t for t in hit if not any(t != o and t in o for o in hit)]
            sc = sum(weight[t] for t in hit)
            if not hit or sc < min_score:
                continue
            if m.category == "pitfall":
                sc += 2  # boost explicit pitfalls
            if target_project and target_project.lower() in (m.tree_path or "").lower():
                sc += 2  # filed under the project being worked on
            scored_pitfalls.append((sc, m))

        scored_pitfalls.sort(key=lambda item: item[0], reverse=True)
        best = scored_pitfalls[0][0] if scored_pitfalls else 0
        for sc, p_mem in scored_pitfalls[:limit_pitfalls]:
            if sc < PITFALL_KEEP_SHARE * best:
                break
            pitfalls_data.append({
                "key": p_mem.key,
                "category": p_mem.category,
                "content": p_mem.content,
            })
    except Exception as e:
        logger.warning("Error fetching pitfalls in mind resonance: %s", e)
    return pitfalls_data


# Entities matched in the database before ranking
ENTITY_CANDIDATES = 200
# Actions naming how a request runs rather than what it is about
_DISPATCH_ACTIONS = {"agent", "ask", "chat"}


async def _project_name(db: AsyncSession, project: str | None) -> str | None:
    """A project id resolved to its title, a working directory to its last segment."""
    p = (project or "").strip()
    if not p:
        return None
    try:
        pid = uuid.UUID(p)
    except ValueError:
        return p.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] or p
    try:
        async with _safe_begin_nested(db):
            return (await db.execute(select(Project.title).where(Project.id == pid))).scalar_one_or_none()
    except Exception as e:
        logger.warning("Could not resolve project %s in mind resonance: %s", p, e)
        return None


async def sense_resonance(
    db: AsyncSession,
    user: User,
    query: str | None = None,
    project: str | None = None,
    action: str | None = None,
    limit_entities: int = 4,
    limit_pitfalls: int = 4,
) -> dict[str, Any]:
    """Sense the user's profile rules, knowledge graph entities and pitfalls relevant to the request.

    project may be a name, a project id or a working directory. action "agent" / "ask" only says how the
    request runs, so it isn't matched against memories.
    """
    import asyncio

    from .session_compactor import clean_text

    # What the user asked, not the context a continuation put in front of it
    q_text = clean_text(query or "")
    project = await _project_name(db, project)
    topic_action = None if (action or "").lower() in _DISPATCH_ACTIONS else action
    terms = terms_for(topic_action, project, q_text)
    # Single characters (了, 吗, ...) match nearly everything
    match_terms = [t for t in terms if len(t) >= 2]
    # What the request is about; the project's name gets its own boost wherever it ranks
    topic_terms = [t for t in terms_for(topic_action, q_text) if len(t) >= 2] or match_terms
    # The request decides the scenario; the project's name only when the request says nothing about it
    scenario = detect_scenario(terms_for(topic_action, q_text), f"{q_text} {topic_action or ''}")
    if scenario["id"] == "general_engineering" and project:
        scenario = detect_scenario(terms, f"{q_text} {project} {topic_action or ''}")

    # Redis lookup alongside; the database queries share one session, which can't run them concurrently
    durable_task = asyncio.ensure_future(get_user_durable_corrections(user.id))
    try:
        scoped_rules, general_rules = await _fetch_scoped_and_general_rules(db, user, match_terms, scenario, project)
        entities_data = await _fetch_graph_entities(
            db, user, match_terms, limit_entities, target_project=project, rank_terms=topic_terms,
        )
        pitfalls_data = await _fetch_pitfalls(
            db, user, pitfall_terms(q_text, topic_action), limit_pitfalls, target_project=project,
        )
    finally:
        durable_corrections = await durable_task

    return {
        "scenario": scenario,
        "mindset": scenario["mindset"],
        "scoped_rules": scoped_rules,
        "general_rules": general_rules,
        "entities": entities_data,
        "pitfalls": pitfalls_data,
        "durable_corrections": durable_corrections,
    }


def render_mind_resonance_markdown(res: dict[str, Any], live_rules: list[str] | None = None) -> str:
    """Format the resonance payload into a crisp, high-signal system prompt section."""
    scen = res.get("scenario") or {}
    lines = [
        "【心领神会·默契前置激活层 (Mind Resonance)】",
        f"识别场景：{scen.get('name', '通用工程')} ｜ 核心心智模型：{res.get('mindset', '')}",
    ]

    # Live Session Corrections (highest priority within current turn)
    active_live = live_rules or res.get("live_rules") or []
    if active_live:
        lines.append("\n【当前会话实时纠偏与行为守则（用户在本会话中特别强调，必须绝对遵守）】：")
        for lr in active_live[:5]:
            lines.append(f"- {lr.strip('- * ')}")

    # Durable Learned Corrections across sessions
    durable_rules = res.get("durable_corrections") or []
    if durable_rules:
        lines.append("\n【用户历史多轮强化纠偏铁律（已通过自进化沉淀，必须严格遵守）】：")
        for dr in durable_rules[-5:]:
            lines.append(f"- {dr.strip('- * ')}")

    # Scoped rules
    scoped = res.get("scoped_rules") or []
    if scoped:
        lines.append("\n当前场景专项铁律与深层偏好：")
        for r in scoped[:5]:
            lines.append(f"- {r.strip('- * ')}")

    # High-signal general rules
    gen = res.get("general_rules") or []
    if gen and not scoped:
        lines.append("\n高优先级通用协作准则：")
        for g in gen[:3]:
            lines.append(f"- {g.strip('- * ')}")

    # Knowledge Graph Active Nodes
    entities = res.get("entities") or []
    if entities:
        lines.append("\n知识图谱前置热激活实体网络（背景事实与已定决策）：")
        for e in entities:
            e_line = f"- 实体「{e['name']}」({e['type']})"
            if e.get("summary"):
                e_line += f"：{e['summary']}"
            lines.append(e_line)
            for obs in e.get("observations") or []:
                lines.append(f"  · 沉淀经验: {obs}")
            for rel in e.get("relations") or []:
                lines.append(f"  · 关联关系: {rel}")

    # Defensive Pitfalls
    pitfalls = res.get("pitfalls") or []
    if pitfalls:
        lines.append("\n历史避坑与防御性预警（历史上类似场景踩过的深坑，绝不能重复出现）：")
        for p in pitfalls:
            lines.append(f"- 避坑提醒 [{p['key']}]：{p['content']}")

    lines.append("\n心领神会行动要求：严格基于上述心智模型与图谱关联展开工作，不反问用户，直达终局。")
    return "\n".join(lines)


# Live Correction Patterns for In-Flight Learning
# Exclude interrogative/question clauses and only capture explicit behavioral directives
_QUESTION_PARTICLES = (
    "?", "？", "为什么", "怎么", "如何", "是不是", "能不能", "要不要", "有没有",
    "行不行", "好不好", "能否", "可否", "请问", "吗", "呢", "吧", "为何",
)

_DIRECTIVE_PREFIXES = (
    "以后", "今后", "后续", "下次", "切记", "记住", "务必", "千万", "所有对话", "每次",
)

_ACTION_DIRECTIVE_PREFIXES = (
    "回答时", "回复时", "写代码时", "交付前", "交付时", "输出时", "排查时", "回答", "回复", "回复中", "回答中",
    "发版", "发布", "部署", "提交", "改动", "重跑", "测试",
)

# "别" only as a prohibition, not inside 特别/区别/识别/级别/个别/告别…
_DIRECTIVE_WORDS = re.compile(r"不要|严禁|杜绝|必须|统一|只能|只用|(?<![特区识级个差告类性派分辨鉴])别(?![人的])")

# Rules live in Redis, shared by every api replica. This process keeps a small copy
# only to fall back on while Redis is unreachable.
_RULES_FALLBACK_MAX = 500
_rules_fallback: dict[str, list[str]] = {}


def _remember_fallback(key: str, rules: list[str]) -> None:
    _rules_fallback.pop(key, None)
    _rules_fallback[key] = rules
    while len(_rules_fallback) > _RULES_FALLBACK_MAX:
        _rules_fallback.pop(next(iter(_rules_fallback)))


async def _load_rules(key: str) -> list[str]:
    """Rules stored under key: Redis decides (missing or expired means none); this
    process's copy is used only when Redis can't be reached."""
    import json
    from .cache import redis_client
    c = redis_client()
    if c is not None:
        try:
            raw = await c.get(key)
            _rules_fallback.pop(key, None)
            if raw is None:
                return []
            value = json.loads(raw)
            return [str(x) for x in value] if isinstance(value, list) else []
        except Exception as e:
            logger.debug("Reading %s from Redis failed, using this process's copy: %s", key, e)
    return list(_rules_fallback.get(key, []))


async def _store_rules(key: str, rules: list[str], ttl_seconds: int) -> None:
    import json
    from .cache import redis_client
    c = redis_client()
    if c is not None:
        try:
            await c.set(key, json.dumps(rules, ensure_ascii=False), ex=ttl_seconds)
            _rules_fallback.pop(key, None)
            return
        except Exception as e:
            logger.debug("Saving %s to Redis failed, keeping it in this process: %s", key, e)
    _remember_fallback(key, rules)


def extract_live_correction_rules(text: str) -> list[str]:
    """Extract explicit developer/user behavioral corrections and negative constraints from prompt.

    Strictly ignores questions, bug descriptions, and inquiries (e.g. '为什么不能滚动', '是不是必须先登录').
    Only extracts clear, directive instructions targeted at AI behavior.
    """
    if not text:
        return []
    rules: list[str] = []
    # Split text by newlines, punctuation, and clause delimiters
    raw_clauses = re.split(r"[\n。；;！!，,]", text)
    for clause in raw_clauses:
        clause = clause.strip(" ，,、\t\r")
        if not clause or len(clause) < 4 or len(clause) > 60:
            continue
        # 1. Skip if it is any form of question or inquiry
        if any(q in clause for q in _QUESTION_PARTICLES):
            continue
        # 2. Skip problem/error descriptions
        if any(err in clause for err in ("报错", "异常", "失败原因", "为什么", "提示", "堆栈")):
            continue

        matched_rule: str | None = None

        # Pattern 1: Explicit directive prefix (e.g. "以后不要用 **", "切记不要回滚", "记住必须用中文")
        if any(clause.startswith(p) for p in _DIRECTIVE_PREFIXES):
            if _DIRECTIVE_WORDS.search(clause):
                matched_rule = clause

        # Pattern 2: Action-scoped directive (e.g. "回答时不要反问", "交付前必须先自测", "发版必须确认所有 pod 状态")
        elif any(clause.startswith(p) for p in _ACTION_DIRECTIVE_PREFIXES):
            if _DIRECTIVE_WORDS.search(clause):
                matched_rule = clause

        # Pattern 3: Standalone direct imperative command without question context
        elif re.search(r"(?:不要|(?<![特区识级个差告类性派分辨鉴])别|严禁|杜绝)\s*(?:在|用|加|使用|包含|反问|回滚|删除|臆测|编造|截断|乱动)", clause):
            matched_rule = clause
        elif re.search(r"(?:必须|统一)\s*(?:用|在|按照|保持|使用|确认|检查|自测|先|打|记录)", clause):
            matched_rule = clause

        if matched_rule:
            clean = matched_rule.strip(" ，,、*#- ")
            if len(clean) >= 4 and clean not in rules:
                rules.append(clean)

    return rules[:4]


async def _increment_rule_frequency(user_id: Any, rule: str) -> int:
    """How many times this rule has been stated (across conversations, last 7 days)."""
    import hashlib
    from .cache import redis_client
    rule_hash = hashlib.md5(rule.strip().encode()).hexdigest()[:12]
    key = f"rule_freq:{user_id}:{rule_hash}"
    c = redis_client()
    if c is None:
        return 1
    try:
        pipe = c.pipeline(transaction=True)
        pipe.incr(key)
        pipe.expire(key, 86400 * 7)
        count, _ = await pipe.execute()
        return int(count)
    except Exception:
        return 1


async def save_user_durable_correction(user_id: Any, rule: str, weight: float = 1.0) -> list[str]:
    """Persist user-level reinforced correction rules across conversations."""
    clean_r = rule.strip("- *# \t\n")
    if len(clean_r) < 3:
        return []
    key = f"user_durable_corrections:{user_id}"
    combined = await get_user_durable_corrections(user_id)
    if clean_r not in combined:
        combined.append(clean_r)
    combined = combined[-20:]
    await _store_rules(key, combined, 86400 * 7)
    return combined


async def get_user_durable_corrections(user_id: Any) -> list[str]:
    """User-level reinforced correction rules."""
    return await _load_rules(f"user_durable_corrections:{user_id}")


async def save_session_live_rules(user_id: Any, conversation_id: str, new_rules: list[str]) -> list[str]:
    """Save newly learned session live rules, escalating to durable rules only when
    stated as lasting ("以后", "记住"…) or repeated."""
    if not conversation_id or not new_rules:
        return []
    key = f"session_live_rules:{user_id}:{conversation_id}"
    combined = await get_session_live_rules(user_id, conversation_id)
    for r in new_rules:
        if r not in combined:
            combined.append(r)
        is_explicit_durable = any(k in r for k in ("以后", "今后", "记住", "切记", "所有对话", "永久"))
        if is_explicit_durable or await _increment_rule_frequency(user_id, r) >= 2:
            await save_user_durable_correction(user_id, r)
    combined = combined[-10:]
    await _store_rules(key, combined, 7200)
    return combined


async def get_session_live_rules(user_id: Any, conversation_id: str) -> list[str]:
    """Session live rules of this conversation."""
    if not conversation_id:
        return []
    return await _load_rules(f"session_live_rules:{user_id}:{conversation_id}")


def expand_query_for_search(query: str, target_project: str | None = None) -> str:
    """Expand short query with domain scenario keywords and mindset anchors for higher hybrid recall."""
    if not query or len(query.strip()) > 30:
        return query
    terms = terms_for(None, target_project, query)
    scen = detect_scenario(terms, f"{query} {target_project or ''}")
    anchors: list[str] = list(scen.get("anchors") or [])

    if anchors:
        clean_q = query.strip()
        extras = [a for a in anchors if a.lower() not in clean_q.lower()][:3]
        if extras:
            return f"{clean_q} {' '.join(extras)}"
    return query


def clean_guardrail_output(text: str) -> str:
    """Sanitize model output to strictly enforce formatting rules (e.g. strip bold asterisks outside code blocks)."""
    if not text:
        return ""
    parts = text.split("```")
    for i in range(0, len(parts), 2):  # Prose sections outside of code blocks
        parts[i] = re.sub(r"\*\*([^\n*]+?)\*\*", r"\1", parts[i])
        parts[i] = re.sub(r"\*\*", "", parts[i])
    return "```".join(parts)


async def record_online_graph_observation(
    db: AsyncSession,
    user_id: Any,
    entity_name: str,
    observation_content: str,
    *,
    entity_type: str = "technology",
    summary: str | None = None,
) -> KnowledgeObservation | None:
    """Record an online knowledge graph observation in real-time, closing the feedback loop and invalidating cache."""
    if not user_id or not entity_name or not observation_content:
        return None

    clean_name = entity_name.strip()
    clean_obs = observation_content.strip()
    if not clean_name or not clean_obs:
        return None

    try:
        async with _safe_begin_nested(db):
            from .entity_canon import find_entity

            entity = await find_entity(db, user_id, clean_name, entity_type)

            now_utc = datetime.now(timezone.utc)
            if not entity:
                entity = KnowledgeEntity(
                    user_id=user_id,
                    name=clean_name,
                    entity_type=entity_type,
                    summary=summary or clean_obs[:150],
                )
                db.add(entity)
                await db.flush()
            else:
                if summary and not entity.summary:
                    entity.summary = summary
                entity.updated_at = now_utc

            dup_q = select(KnowledgeObservation).where(
                KnowledgeObservation.entity_id == entity.id,
                KnowledgeObservation.content == clean_obs,
            )
            dup = (await db.execute(dup_q)).scalars().first()
            if dup:
                return dup

            obs = KnowledgeObservation(
                entity_id=entity.id,
                content=clean_obs,
                observed_at=now_utc,
            )
            db.add(obs)
            await db.flush()

        try:
            from .cache import cache_delete_prefix
            await cache_delete_prefix(f"memory:resonance:{user_id}")
        except Exception as e:
            logger.debug("Failed to invalidate resonance cache in record_online_graph_observation: %s", e)

        return obs
    except Exception as e:
        logger.warning("Failed to record online graph observation: %s", e)
        return None


def validate_shell_command_against_iron_rules(
    command: str,
    machine_name: str = "",
    platform_hint: str = "",
) -> tuple[bool, str | None]:
    """Validate a shell command against user iron rules and architectural safety guardrails.

    Returns (is_allowed, warning_or_error_message).
    """
    cmd = command.strip()
    cmd_lower = cmd.lower()

    # 1. Iron Rule: Destructive database deletion without backup
    dangerous_db_patterns = [
        r"\bdrop\s+database\b",
        r"\bdrop\s+table\b",
        r"\btruncate\s+table\b",
        r"\btruncate\b\s+[a-zA-Z0-9_]+",
    ]
    for pat in dangerous_db_patterns:
        if re.search(pat, cmd_lower):
            return False, "【用户铁律守门拦截】：严禁执行未经备份的物理硬删除！修改或清空数据前必须先备份原表数据；数据操作倾向打标记归档而非物理删除，便于审计。"

    # 2. Iron Rule: Dangerous physical root or disk deletion
    dangerous_rm_patterns = [
        r"\brm\s+-(?:r|rf|fr)\s+/(?:\s|$)",
        r"\brm\s+-(?:r|rf|fr)\s+/data2?(?:\s|/|$)",
        r"\brm\s+-(?:r|rf|fr)\s+~/?(?:\s|$)",
        r"\brm\s+-(?:r|rf|fr)\s+\*$",
    ]
    for pat in dangerous_rm_patterns:
        if re.search(pat, cmd_lower):
            return False, "【系统安全防线】：检测到针对根目录、用户主目录或核心数据目录的破坏性递归删除命令，已被拦截。请改用精细化、可审计的归档清理策略。"

    # 3. Iron Rule: Rerun tasks must stop old services and carry version tags
    if any(k in cmd_lower for k in ("run_all", "batch_run", "harvest_all", "reindex_all")):
        if "--version" not in cmd_lower and "-v " not in cmd_lower:
            return True, "【用户铁律提醒】：已标注的数据不要重跑，重跑需带版本号；重跑前先确认已停掉旧服务/旧任务，且只针对指定范围。"

    # 4. OS mismatch guard
    plat = (platform_hint or machine_name).lower()
    is_mac = any(k in plat for k in ("mac", "darwin", "mbp", "apple", "imac", "mini"))
    is_linux = any(k in plat for k in ("linux", "ubuntu", "debian", "centos", "server"))

    if is_mac and any(tool in cmd_lower for tool in ("systemctl ", "apt-get ", "apt ", "yum ", "journalctl ")):
        return False, f"【平台指令不匹配】：目标设备「{machine_name}」为 macOS 环境，不支持 systemctl/apt/yum 等 Linux 命令。请选用 Linux 运算设备或改用 macOS 对应命令（如 brew / launchctl）。"
    if is_linux and any(tool in cmd_lower for tool in ("osascript ", "pbcopy", "pbpaste", "open -a ")):
        return False, f"【平台指令不匹配】：目标设备「{machine_name}」为 Linux 环境，不支持 AppleScript 或 macOS 专属命令。请选用 Mac 设备执行。"

    return True, None


def _resolve_scenario_meta(scenario: dict[str, Any]) -> dict[str, Any]:
    """Merge partial scenario dict with registered scenario defaults by id."""
    scen_id = scenario.get("id")
    if scen_id:
        registered = next((s for s in _ACTIVE_SCENARIOS if s.get("id") == scen_id), None)
        if registered:
            merged = dict(registered)
            merged.update(scenario)
            return merged
    return scenario


def enrich_search_query_with_mindset(query: str, scenario: dict[str, Any]) -> str:
    """Expand short query with domain mindset keywords to boost contextual retrieval recall."""
    clean_q = query.strip()
    if len(clean_q) > 40:
        return clean_q

    scen = _resolve_scenario_meta(scenario)
    extras = scen.get("search_query_extras") or ""
    if extras:
        words = [w for w in extras.split() if w.lower() not in clean_q.lower()]
        if words:
            return f"{clean_q} {' '.join(words)}"
    return clean_q


def enrich_skill_with_mindset(skill_md: str, scenario: dict[str, Any]) -> str:
    """Append mental guardrails to skill markdown based on scenario."""
    scen = _resolve_scenario_meta(scenario)
    defense_lines = list(scen.get("defense_rules") or [])
    if not defense_lines:
        defense_lines = [
            "1) 仔细深入调查问题，从根子上彻底解决；一次做到位，交付前本地类型检查与自测确认通过。",
            "2) 直接给结论和指令，不绕弯子、不废话、不反问用户。",
        ]

    defenses_text = "\n".join(defense_lines)
    return (
        f"{skill_md.rstrip()}\n\n"
        f"【心领神会·本操作专项执行防线与心智铁律】：\n{defenses_text}"
    )


def enrich_check_rules_result(guidance_md: str, resonance: dict[str, Any]) -> str:
    """Enrich check_rules output with real-time mind resonance, project scoped rules, and graph nodes."""
    scen = resonance.get("scenario") or {}
    scoped = resonance.get("scoped_rules") or []
    general = resonance.get("general_rules") or []
    entities = resonance.get("entities") or []
    pitfalls = resonance.get("pitfalls") or []
    durable = resonance.get("durable_corrections") or []

    sections = [guidance_md.strip()]

    mind_lines = [
        f"\n【心领神会·场景综合心智感知 ({scen.get('name', '工程研发')})】",
        f"核心导向：{resonance.get('mindset', '')}",
    ]

    if scoped:
        mind_lines.append("\n【当前项目专项铁律与深层偏好】：")
        for r in scoped[:5]:
            mind_lines.append(f"- {r.strip('- * ')}")
    elif general:
        mind_lines.append("\n【高优先级通用协作准则】：")
        for g in general[:3]:
            mind_lines.append(f"- {g.strip('- * ')}")

    if durable:
        mind_lines.append("\n【跨会话强化铁律（用户多轮纠偏记忆）】：")
        for d in durable[:4]:
            mind_lines.append(f"- {d.strip('- * ')}")

    if entities:
        mind_lines.append("\n【相关知识图谱实体与历史决策】：")
        for e in entities[:3]:
            obs_str = f"（{e['observations'][0]}）" if e.get("observations") else ""
            mind_lines.append(f"- {e['name']}{obs_str}")

    if pitfalls:
        mind_lines.append("\n【必须坚决规避的历史踩坑】：")
        for p in pitfalls[:3]:
            mind_lines.append(f"- {p['key']}：{p['content'][:120]}")

    sections.append("\n".join(mind_lines))
    return "\n\n".join(s for s in sections if s.strip())


def enrich_todo_creation(
    title: str,
    project: str | None,
    scenario: dict[str, Any],
) -> tuple[str, str | None, str | None]:
    """Align todo title and project with user iron rules."""
    clean_title = title.strip()
    proj = (project or "").strip() or None

    scen = _resolve_scenario_meta(scenario)
    # Auto-infer project from decoupled scenario schema if missing
    if not proj:
        proj = scen.get("target_project") or None

    # Suggestion if the model tries to record an immediate task
    hint = None
    if any(k in clean_title for k in ("现在", "马上", "立即", "正在", "当前")):
        hint = "【用户心智规约提示】：当前就要做的事不要记为待办，应由智能体直接执行完成；待办仅用于沉淀后续跟进事项。"

    return clean_title, proj, hint


def enrich_device_listing(devices: list[dict[str, Any]], scenario: dict[str, Any]) -> list[dict[str, Any]]:
    """Annotate devices with affinity recommendations according to scenario."""
    scen = _resolve_scenario_meta(scenario)
    preferred_os = scen.get("device_affinity")
    enriched = []
    for d in devices:
        d_copy = dict(d)
        name_lower = str(d.get("name") or "").lower()
        is_mac = any(k in name_lower for k in ("mac", "darwin", "mbp", "apple", "imac", "mini"))
        is_linux = any(k in name_lower for k in ("linux", "ubuntu", "debian", "centos", "server"))

        if is_mac:
            d_copy["affinity"] = "推荐用于 Mac 本地开发 / 前端 UI 调试 / AppleScript / 客户端打包"
        elif is_linux:
            d_copy["affinity"] = "推荐用于 Linux / 高并发后端 / 化学逆合成 / /data2 数据集抓取与处理"
        else:
            d_copy["affinity"] = "通用设备节点"

        # Highlight if best match for current scenario
        if (preferred_os == "linux" and is_linux) or (preferred_os == "mac" and is_mac):
            d_copy["scenario_best_match"] = True

        enriched.append(d_copy)
    return enriched


