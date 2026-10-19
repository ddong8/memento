"""Mind Resonance Service — 前置心领神会与默契共鸣引擎.

让 AI 在生成任何回复或执行任何操作之前，先主动与用户完成「心智同频」：
1. 意图与领域场景智能推断（Intent & Domain Deduction）
2. 知识图谱核心实体与前序决策主动激活（Knowledge Graph Entity Resonance）
3. 历史踩坑与防御性避雷前置预警（Defensive Pitfalls & Failure Patterns）
4. 深度契合用户底层心智模型与隐式偏好（User Mental Model & Iron Rules）
"""

from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import KnowledgeEntity, KnowledgeObservation, KnowledgeRelation, User, UserMemory
from .guidance_service import score, terms_for
from .profile_service import get_published_profile, split_profile_scopes

logger = logging.getLogger("server.mind_resonance")

# Domain pattern definitions mapping terms to intuitive user scenarios
DOMAIN_SCENARIOS = [
    {
        "id": "evolution_memory",
        "name": "AI 记忆与自进化底座",
        "keywords": ("自进化", "心领神会", "懂我", "记忆", "画像", "dreaming", "memento", "mcp", "profile", "agentic"),
        "mindset": "希望工具能越用越了解用户，具备自进化能力；打破工具孤岛，沉淀终身资产；一次做到位，不绕弯子。",
    },
    {
        "id": "chemistry_pubchem",
        "name": "化学研发与逆合成规划",
        "keywords": ("逆合成", "pubchem", "cas", "smiles", "化合物", "路线", "试剂", "化学", "分子"),
        "mindset": "CAS号精准表述不猜测名称；路线条数可控且AI重排；严禁不稳定格式试剂；一键接入oneapi模型。",
    },
    {
        "id": "data_harvest",
        "name": "化学数据抓取与资产沉淀",
        "keywords": ("workbuddy", "抓取", "爬虫", "爬取", "数据源", "数据清洗", "资产登记"),
        "mindset": "优先中文网站且必抓中文名；CAS和SMILES为必须字段；先整库dump本地再处理；提供可溯源登记。",
    },
    {
        "id": "ui_performance",
        "name": "前端交互极致性能与设计",
        "keywords": ("前端", "tab", "切换", "卡顿", "渲染", "ui", "aurora", "延迟", "流畅", "动画", "保活"),
        "mindset": "交互零延迟、0ms切换无损保活；界面精致高级；绝不阻塞主线程；桌面端应用名称去掉desktop后缀。",
    },
    {
        "id": "devops_release",
        "name": "发布交付与无故障上线",
        "keywords": ("发布", "部署", "k8s", "pod", "release", "tag", "更新", "发版", "构建", "docker"),
        "mindset": "发版前必查历史经验避免重踩坑；代码发版打tag并确认所有pod状态；CI/CD零停机更新；帮用户做完勿让用户手动敲命令。",
    },
    {
        "id": "data_safety",
        "name": "数据资产安全与审计",
        "keywords": ("删除", "解绑", "设备", "machine", "归档", "purge", "清理数据", "备份"),
        "mindset": "修改前先备份原表数据；倾向打标记归档而非物理硬删除便于审计；删除设备允许保留数据。",
    },
]


def detect_scenario(terms: list[str], raw_text: str = "") -> dict[str, str]:
    """Infer the primary scenario and user mindset from query terms and text."""
    low_text = raw_text.lower()
    best_match = None
    best_score = 0
    for scen in DOMAIN_SCENARIOS:
        sc = sum(2 for k in scen["keywords"] if k in low_text) + sum(1 for k in scen["keywords"] if k in terms)
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
        prof = await get_published_profile(db, user)
        if prof and prof.content:
            scopes = split_profile_scopes(prof.content)
            target_proj = (project or "").strip().lower()
            if not target_proj:
                if scenario["id"] == "chemistry_pubchem":
                    target_proj = "pubchem"
                elif scenario["id"] == "data_harvest":
                    target_proj = "workbuddy"
                elif scenario["id"] in ("evolution_memory", "ui_performance", "devops_release"):
                    target_proj = "memento"

            if target_proj:
                for p_name, lines in scopes.projects.items():
                    if target_proj in p_name.lower() or p_name.lower() in target_proj:
                        scoped_rules.extend(lines)

                # Fallback: scan markdown headings (e.g. #### memento or ### pubchem)
                if not scoped_rules:
                    in_target = False
                    for line in prof.content.splitlines():
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
) -> list[dict[str, Any]]:
    """Batch fetch and activate relevant knowledge graph entities with 2-hop topology."""
    entities_data: list[dict[str, Any]] = []
    if not terms:
        return entities_data

    try:
        or_conditions = []
        for t in terms[:8]:
            pattern = f"%{t}%"
            or_conditions.append(KnowledgeEntity.name.ilike(pattern))
            or_conditions.append(KnowledgeEntity.summary.ilike(pattern))

        if not or_conditions:
            return entities_data

        ent_q = (
            select(KnowledgeEntity)
            .where(KnowledgeEntity.user_id == user.id, or_(*or_conditions))
            .limit(limit_entities * 2)
        )
        ent_rows = (await db.execute(ent_q)).scalars().all()
        sorted_ents = sorted(
            ent_rows,
            key=lambda e: score(f"{e.name} {e.summary or ''}", terms),
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
                "summary": ent.summary or "",
                "observations": obs_map.get(ent.id, []),
                "relations": formatted_rels,
            })
    except Exception as e:
        logger.warning("Error activating graph entities in mind resonance: %s", e)
    return entities_data


async def _fetch_pitfalls(
    db: AsyncSession,
    user: User,
    terms: list[str],
    limit_pitfalls: int,
) -> list[dict[str, str]]:
    """Fetch defensive pitfall memories ranked by contextual relevance."""
    pitfalls_data: list[dict[str, str]] = []
    try:
        mem_q = select(UserMemory).where(
            UserMemory.user_id == user.id,
            UserMemory.status == "active",
            UserMemory.is_folder.is_(False),
            UserMemory.category.in_(("pitfall", "rule", "architecture")),
        )
        all_mems = (await db.execute(mem_q)).scalars().all()
        scored_pitfalls = []
        for m in all_mems:
            sc = score(f"{m.key} {m.tree_path or ''} {m.content}", terms)
            if m.category == "pitfall":
                sc += 2  # boost explicit pitfalls
            if sc > 0 or not terms:
                scored_pitfalls.append((sc, m))

        scored_pitfalls.sort(key=lambda item: item[0], reverse=True)
        for _, p_mem in scored_pitfalls[:limit_pitfalls]:
            pitfalls_data.append({
                "key": p_mem.key,
                "category": p_mem.category,
                "content": p_mem.content,
            })
    except Exception as e:
        logger.warning("Error fetching pitfalls in mind resonance: %s", e)
    return pitfalls_data


async def sense_resonance(
    db: AsyncSession,
    user: User,
    query: str | None = None,
    project: str | None = None,
    action: str | None = None,
    limit_entities: int = 4,
    limit_pitfalls: int = 4,
) -> dict[str, Any]:
    """Execute mind resonance sensing concurrently across user profile, knowledge graph, and pitfalls."""
    import asyncio

    q_text = query or ""
    terms = terms_for(action, project, q_text)
    scenario = detect_scenario(terms, f"{q_text} {project or ''} {action or ''}")

    # Concurrently execute 3 dimensions: Profile rules, Graph entities (with 2-hop), Defensive pitfalls
    rules_task = _fetch_scoped_and_general_rules(db, user, terms, scenario, project)
    entities_task = _fetch_graph_entities(db, user, terms, limit_entities)
    pitfalls_task = _fetch_pitfalls(db, user, terms, limit_pitfalls)

    (scoped_rules, general_rules), entities_data, pitfalls_data = await asyncio.gather(
        rules_task,
        entities_task,
        pitfalls_task,
    )

    return {
        "scenario": scenario,
        "mindset": scenario["mindset"],
        "scoped_rules": scoped_rules,
        "general_rules": general_rules,
        "entities": entities_data,
        "pitfalls": pitfalls_data,
    }


def render_mind_resonance_markdown(res: dict[str, Any]) -> str:
    """Format the resonance payload into a crisp, high-signal system prompt section."""
    scen = res.get("scenario") or {}
    lines = [
        "【心领神会·默契前置激活层 (Mind Resonance)】",
        f"识别场景：{scen.get('name', '通用工程')} ｜ 核心心智模型：{res.get('mindset', '')}",
    ]

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
