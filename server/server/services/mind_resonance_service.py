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
import re
from typing import Any

from sqlalchemy import func, or_, select
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
    target_project: str | None = None,
) -> list[dict[str, Any]]:
    """Batch fetch and activate relevant knowledge graph entities with 2-hop topology and project affinity decay."""
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

        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)

        def entity_affinity(ent: KnowledgeEntity) -> float:
            base_score = float(score(f"{ent.name} {ent.summary or ''}", terms))
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

    # Concurrently execute dimensions: Profile rules, Graph entities (with 2-hop), Defensive pitfalls, and Durable corrections
    rules_task = _fetch_scoped_and_general_rules(db, user, terms, scenario, project)
    entities_task = _fetch_graph_entities(db, user, terms, limit_entities, target_project=project)
    pitfalls_task = _fetch_pitfalls(db, user, terms, limit_pitfalls)
    durable_task = get_user_durable_corrections(user.id)

    (scoped_rules, general_rules), entities_data, pitfalls_data, durable_corrections = await asyncio.gather(
        rules_task,
        entities_task,
        pitfalls_task,
        durable_task,
    )

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
_CORRECTION_PATTERNS = [
    re.compile(r"(?:以后|严禁|杜绝|不要|不能|必须|统一|记住|切记)(?:在|用|加|使用|包含|反问|回滚|删除)?\s*([^\n。，；]{3,50})"),
    re.compile(r"(?:不要|不能|严禁)\s*([^\n。，；]{2,30})"),
    re.compile(r"(?:必须|统一|只能)\s*([^\n。，；]{2,30})"),
]

_session_live_rules_mem: dict[str, list[str]] = {}


def extract_live_correction_rules(text: str) -> list[str]:
    """Extract explicit developer/user behavioral corrections and negative constraints from prompt."""
    if not text:
        return []
    rules: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or len(line) < 4:
            continue
        for pat in _CORRECTION_PATTERNS:
            for m in pat.finditer(line):
                matched = m.group(0).strip("，。；、 ")
                if any(k in matched for k in ("不要忘了", "能不能", "要不要", "是不是")):
                    continue
                if len(matched) >= 4 and matched not in rules:
                    rules.append(matched)
    return rules[:4]


_user_durable_corrections_mem: dict[str, list[str]] = {}


async def save_user_durable_correction(user_id: Any, rule: str, weight: float = 1.0) -> list[str]:
    """Persist user-level reinforced correction rules across conversations."""
    clean_r = rule.strip("- *# \t\n")
    if len(clean_r) < 3:
        return []
    cache_key = f"user_durable_corrections:{user_id}"
    existing = await get_user_durable_corrections(user_id)
    combined = list(existing)
    if clean_r not in combined:
        combined.append(clean_r)
    combined = combined[-20:]
    _user_durable_corrections_mem[cache_key] = combined
    try:
        from .cache import cache_set
        await cache_set(cache_key, combined, ttl_seconds=86400 * 7)
    except Exception as e:
        logger.debug("Failed to set redis user_durable_corrections: %s", e)
    return combined


async def get_user_durable_corrections(user_id: Any) -> list[str]:
    """Retrieve user-level reinforced correction rules."""
    cache_key = f"user_durable_corrections:{user_id}"
    if cache_key in _user_durable_corrections_mem:
        return _user_durable_corrections_mem[cache_key]
    try:
        from .cache import cache_get
        cached = await cache_get(cache_key)
        if isinstance(cached, list):
            _user_durable_corrections_mem[cache_key] = [str(x) for x in cached]
            return _user_durable_corrections_mem[cache_key]
    except Exception as e:
        logger.debug("Failed to get redis user_durable_corrections: %s", e)
    return []


async def save_session_live_rules(user_id: Any, conversation_id: str, new_rules: list[str]) -> list[str]:
    """Save newly learned session live rules to cache and durable store."""
    if not conversation_id or not new_rules:
        return []
    cache_key = f"session_live_rules:{user_id}:{conversation_id}"
    existing = await get_session_live_rules(user_id, conversation_id)
    combined = list(existing)
    for r in new_rules:
        if r not in combined:
            combined.append(r)
        # Simultaneously reinforce across the user's durable mindset
        await save_user_durable_correction(user_id, r)
    combined = combined[-10:]
    _session_live_rules_mem[cache_key] = combined
    try:
        from .cache import cache_set
        await cache_set(cache_key, combined, ttl_seconds=7200)
    except Exception as e:
        logger.debug("Failed to set redis session_live_rules: %s", e)
    return combined


async def get_session_live_rules(user_id: Any, conversation_id: str) -> list[str]:
    """Retrieve session live rules."""
    if not conversation_id:
        return []
    cache_key = f"session_live_rules:{user_id}:{conversation_id}"
    if cache_key in _session_live_rules_mem:
        return _session_live_rules_mem[cache_key]
    try:
        from .cache import cache_get
        cached = await cache_get(cache_key)
        if isinstance(cached, list):
            _session_live_rules_mem[cache_key] = [str(x) for x in cached]
            return _session_live_rules_mem[cache_key]
    except Exception as e:
        logger.debug("Failed to get redis session_live_rules: %s", e)
    return []


def expand_query_for_search(query: str, target_project: str | None = None) -> str:
    """Expand short query with domain scenario keywords and mindset anchors for higher hybrid recall."""
    if not query or len(query.strip()) > 30:
        return query
    terms = terms_for(None, target_project, query)
    scen = detect_scenario(terms, f"{query} {target_project or ''}")
    scen_id = scen.get("id")
    anchors: list[str] = []
    if scen_id == "devops_release":
        anchors = ["version.json", "kustomization", "Fleet", "package.json", "tag", "部署"]
    elif scen_id == "chemistry_pubchem":
        anchors = ["CAS", "SMILES", "逆合成", "格式试剂", "路线重排"]
    elif scen_id == "data_harvest":
        anchors = ["CAS", "SMILES", "中文名称", "数据抓取", "资产登记"]
    elif scen_id == "ui_performance":
        anchors = ["交互零延迟", "全屏铺满", "缓存", "流式输出"]
    elif scen_id == "data_safety":
        anchors = ["归档", "备份", "保留标记", "审计"]
    elif scen_id == "evolution_memory":
        anchors = ["心领神会", "常驻画像", "自进化", "避坑"]

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
        q = select(KnowledgeEntity).where(
            KnowledgeEntity.user_id == user_id,
            func.lower(KnowledgeEntity.name) == clean_name.lower(),
        )
        res = await db.execute(q)
        entity = res.scalars().first()

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


def enrich_search_query_with_mindset(query: str, scenario: dict[str, Any]) -> str:
    """Expand short query with domain mindset keywords to boost contextual retrieval recall."""
    clean_q = query.strip()
    if len(clean_q) > 40:
        return clean_q

    scen_id = scenario.get("id", "")
    if scen_id == "chemistry_pubchem" and not any(k in clean_q.lower() for k in ("cas", "smiles", "pubchem")):
        return f"{clean_q} CAS SMILES 逆合成"
    elif scen_id == "data_harvest" and not any(k in clean_q.lower() for k in ("dump", "workbuddy", "中文名")):
        return f"{clean_q} 数据抓取 中文名称 dump"
    elif scen_id == "devops_release" and not any(k in clean_q.lower() for k in ("version.json", "tag", "release")):
        return f"{clean_q} 发布 三位一体 version.json tag"
    elif scen_id == "ui_performance" and not any(k in clean_q.lower() for k in ("延迟", "保活", "卡顿")):
        return f"{clean_q} 零延迟 保活 页面流畅"
    return clean_q


def enrich_skill_with_mindset(skill_md: str, scenario: dict[str, Any]) -> str:
    """Append mental guardrails to skill markdown based on scenario."""
    scen_id = scenario.get("id", "")
    defense_lines = []

    if scen_id == "devops_release":
        defense_lines.extend([
            "1) 发版前必查历史经验避免重踩坑，确认代码发版打 tag，且所有 pod 确认已部署更新。",
            "2) 桌面端发布严格遵守元数据三位一体校验（version.json、GitHub Release 与 updates.py 强一致）。",
            "3) 代码提交规范：中文 Conventional Commits 风格，严禁添加 Claude 共同作者信息，保持线性 Git 历史。",
            "4) 发布、部署全流程直接帮用户闭环做完，严禁让用户手动敲命令。",
        ])
    elif scen_id == "chemistry_pubchem":
        defense_lines.extend([
            "1) 遇到原文中是 CAS 号的化合物，直接使用 CAS 号表述，严禁猜测化合物名称。",
            "2) 逆合成结果必须经过 AI 重排，步数多的路线不能排在前面；避免生成不稳定的格式试剂。",
        ])
    elif scen_id == "data_harvest":
        defense_lines.extend([
            "1) 抓取化学数据源优先中文网站，且必须抓取中文名称；CAS 与 SMILES 为必须字段。",
            "2) 先整库 dump 到本地再处理数据；修改数据前先备份原表数据，倾向打标记而非硬删除。",
        ])
    else:
        defense_lines.extend([
            "1) 仔细深入调查问题，从根子上彻底解决；一次做到位，交付前本地类型检查与自测确认通过。",
            "2) 直接给结论和指令，不绕弯子、不废话、不反问用户。",
        ])

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

    # Auto-infer project from detected scenario if missing
    if not proj:
        scen_id = scenario.get("id", "")
        if scen_id in ("evolution_memory", "ui_performance", "devops_release"):
            proj = "memento"
        elif scen_id == "chemistry_pubchem":
            proj = "pubchem"
        elif scen_id == "data_harvest":
            proj = "workbuddy"

    # Suggestion if the model tries to record an immediate task
    hint = None
    if any(k in clean_title for k in ("现在", "马上", "立即", "正在", "当前")):
        hint = "【用户心智规约提示】：当前就要做的事不要记为待办，应由智能体直接执行完成；待办仅用于沉淀后续跟进事项。"

    return clean_title, proj, hint


def enrich_device_listing(devices: list[dict[str, Any]], scenario: dict[str, Any]) -> list[dict[str, Any]]:
    """Annotate devices with affinity recommendations according to scenario."""
    scen_id = scenario.get("id", "")
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
        if (scen_id in ("chemistry_pubchem", "data_harvest") and is_linux) or (scen_id == "ui_performance" and is_mac):
            d_copy["scenario_best_match"] = True

        enriched.append(d_copy)
    return enriched


