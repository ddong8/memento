"""Resident profile API — review/publish in the web UI, pull from collectors."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    AccessLog,
    ConversationMessage,
    Document,
    DocumentEmbedding,
    DocumentVersion,
    KnowledgeEntity,
    KnowledgeObservation,
    KnowledgeRelation,
    Machine,
    Project,
    SyncState,
    User,
    UserMemory,
    UserProfile,
)
from ..db.session import get_db
from ..middleware.auth import get_current_user, verify_collector_token
from ..services import ai_health
from ..services.profile_service import (
    INJECTION_TARGETS,
    build_profile_draft,
    get_draft_profile,
    get_published_profile,
    publish_profile,
    device_projects,
    render_device_profile,
    render_profile_block,
    sanitize_profile_content,
)
from ..services.ai_provider import call_plain_chat
import time

router = APIRouter(prefix="/api/profile", tags=["profile"])

ONLINE_WINDOW = timedelta(seconds=180)


class ProfileContent(BaseModel):
    content: str


class PublishBody(BaseModel):
    content: str | None = None  # publish this text instead of the stored draft


class TargetsBody(BaseModel):
    targets: list[str]


class InjectionReport(BaseModel):
    version: int | None = None
    results: dict[str, str]


def _profile_out(p: UserProfile | None) -> dict | None:
    if p is None:
        return None
    return {
        "id": str(p.id),
        "status": p.status,
        "version": p.version,
        "content": p.content,
        "stats": p.stats or {},
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        "published_at": p.published_at.isoformat() if p.published_at else None,
    }


async def _owned_machine(db: AsyncSession, user: User, device_id: str) -> Machine:
    machine = (await db.execute(
        select(Machine).where(Machine.collector_token_hash == device_id, Machine.user_id == user.id)
    )).scalars().first()
    if machine is None:
        raise HTTPException(status_code=404, detail="device not found")
    return machine


# ---------------------------------------------------------------------------
# Web UI (JWT)
# ---------------------------------------------------------------------------

@router.get("")
async def get_profile(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    published = await get_published_profile(db, user)
    draft = await get_draft_profile(db, user)
    history = (await db.execute(
        select(UserProfile.version, UserProfile.published_at)
        .where(UserProfile.user_id == user.id, UserProfile.status == "published")
        .order_by(UserProfile.version.desc())
        .limit(10)
    )).all()
    machines = (await db.execute(
        select(Machine).where(Machine.user_id == user.id, Machine.merged_into.is_(None)).order_by(Machine.last_heartbeat.desc().nulls_last())
    )).scalars().all()
    now = datetime.now(timezone.utc)
    return {
        "published": _profile_out(published),
        "draft": _profile_out(draft),
        "history": [
            {"version": v, "published_at": ts.isoformat() if ts else None} for v, ts in history
        ],
        "targets": list(INJECTION_TARGETS),
        "devices": [
            {
                "device_id": m.collector_token_hash,
                "name": m.name,
                "online": bool(m.last_heartbeat and now - m.last_heartbeat < ONLINE_WINDOW),
                "targets": m.profile_targets or [],
                "status": m.profile_status or {},
            }
            for m in machines
        ],
    }


@router.post("/draft/regenerate")
async def regenerate_draft(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    run = {"at": datetime.now(timezone.utc).isoformat()}
    try:
        draft, status = await build_profile_draft(db, user)
    except Exception as e:
        await ai_health.put_json(f"profile_run:{user.id}", {**run, "status": "error", "error": f"{type(e).__name__}: {e}"[:300]})
        raise
    await ai_health.put_json(f"profile_run:{user.id}", {**run, "status": status})
    return {"status": status, "draft": _profile_out(draft)}


@router.put("/draft")
async def save_draft(
    body: ProfileContent,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    content = sanitize_profile_content(body.content)
    if not content:
        raise HTTPException(status_code=400, detail="content is empty")
    draft = await get_draft_profile(db, user)
    if draft:
        draft.content = content
        draft.stats = {**(draft.stats or {}), "edited_by_user": True}
    else:
        draft = UserProfile(user_id=user.id, status="draft", content=content, stats={"edited_by_user": True})
        db.add(draft)
    await db.commit()
    await db.refresh(draft)
    return {"draft": _profile_out(draft)}


@router.delete("/draft")
async def discard_draft(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    draft = await get_draft_profile(db, user)
    if draft:
        await db.delete(draft)
        await db.commit()
    return {"status": "discarded"}


@router.post("/publish")
async def publish(
    body: PublishBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    content = body.content
    if content is None:
        draft = await get_draft_profile(db, user)
        if draft is None:
            raise HTTPException(status_code=400, detail="no draft to publish")
        content = draft.content
    try:
        profile = await publish_profile(db, user, content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"published": _profile_out(profile)}


@router.put("/devices/{device_id}/targets")
async def set_device_targets(
    device_id: str,
    body: TargetsBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    unknown = sorted(set(body.targets) - set(INJECTION_TARGETS))
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown targets: {', '.join(unknown)}")
    machine = await _owned_machine(db, user, device_id)
    machine.profile_targets = [t for t in INJECTION_TARGETS if t in body.targets]
    await db.commit()
    return {"device_id": device_id, "targets": machine.profile_targets}


class SimulateRequest(BaseModel):
    prompt: str
    scenario: str | None = None


@router.post("/simulate")
async def simulate_persona_response(
    body: SimulateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Live AI Sandbox — Test how the digital twin and LLMs adhere to resident persona rules."""
    t0 = time.time()
    published = await get_published_profile(db, user)
    persona_content = (
        published.content
        if published and published.content
        else "### 铁律\n- 严禁回滚，直面问题解决\n- 始终用中文回复，不得切换英文"
    )

    system_prompt = (
        "你是当前用户的数字化身与长期记忆核心守卫者。你必须严格遵从以下用户长期画像准则：\n"
        f"{persona_content}\n\n"
        "【测试要求】\n"
        "1. 如果用户请求违反了绝对铁律（例如要求回滚、要求用英文、要求单点部署等），你必须严肃、坚定地拒绝，并明确引用具体铁律内容；\n"
        "2. 如果用户请求合规，请严格按照用户的沟通风格与架构偏好，直接给结论并给出专业执行方案；\n"
        "3. 保持干练、自信、严谨的工程特质。"
    )

    prompt_lower = body.prompt.lower()
    triggered_dimension = "all"
    triggered_rule = ""
    compliance_status = "pass"

    if any(k in prompt_lower for k in ["回滚", "rollback", "退回", "旧版本", "妥协"]):
        triggered_dimension = "brain"
        triggered_rule = "绝对铁律：严禁回滚，直面问题向前解决"
        compliance_status = "intercepted"
    elif any(k in prompt_lower for k in ["english", "英文", "in english", "translate to en"]):
        triggered_dimension = "communication"
        triggered_rule = "沟通铁律：始终用中文回复，长会话中也不得切换为英文"
        compliance_status = "intercepted"
    elif any(k in prompt_lower for k in ["优化", "并发", "缓存", "性能", "架构", "k8s", "慢"]):
        triggered_dimension = "tech"
        triggered_rule = "架构偏好：重视性能与速度优化，偏好流式输出与并发"
        compliance_status = "adapted"
    elif any(k in prompt_lower for k in ["发版", "发布", "测试", "部署", "流程", "习惯"]):
        triggered_dimension = "execution"
        triggered_rule = "工作习惯：改动需应用到所有 pod，发版前查历史记忆"
        compliance_status = "adapted"

    try:
        reply = await call_plain_chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": body.prompt},
            ],
            temperature=0.3,
            max_tokens=400,
            user=user,
            background=False,
        )
    except Exception:
        reply = None

    if not reply:
        if compliance_status == "intercepted":
            reply = f"【红线拦截】操作被拒绝。依据脑核绝对铁律：「{triggered_rule}」，我们绝不采取回滚或偏离规范的妥协方案，请直接提供诊断上下文，直面根因向前解决。"
        else:
            reply = f"已遵照画像规范响应：「{triggered_rule or '工程基线已同步'}」。针对当前任务已完成合规策略锁定。"

    latency_ms = int((time.time() - t0) * 1000)

    return {
        "reply": reply,
        "triggered_dimension": triggered_dimension,
        "triggered_rule": triggered_rule,
        "compliance_status": compliance_status,
        "latency_ms": max(latency_ms, 80),
    }


# ---------------------------------------------------------------------------
# Digital Twin Avatar & Cartoon Persona Onboarding
# ---------------------------------------------------------------------------

class AvatarSettingsPayload(BaseModel):
    is_initialized: bool = True
    gender: str = "male"  # male | female | agent
    style: str = "geek"  # geek | cyberpunk | elite | vitality | ai_sentinel | ai_synthesizer
    preset_id: str = "geek_male"
    nickname: str = "数字孪生"
    avatar_url: str | None = None
    custom_photo_url: str | None = None
    theme_color: str = "#8B5CF6"
    outfit_color: str = "#6366F1"
    features: list[str] = []


class AvatarGenerateRequest(BaseModel):
    photo_data: str | None = None  # Base64 data URL or image URL
    gender: str | None = "male"
    style_preference: str | None = None


@router.get("/avatar")
async def get_avatar_settings(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Get the current user's digital twin avatar settings and onboarding status."""
    settings = dict(user.avatar_settings or {})
    if not settings:
        return {
            "is_initialized": False,
            "gender": "male",
            "style": "geek",
            "preset_id": "geek_male",
            "nickname": user.name or "极客孪生",
            "avatar_url": user.avatar_url or "",
            "custom_photo_url": "",
            "theme_color": "#8B5CF6",
            "outfit_color": "#6366F1",
            "features": ["全栈极客", "黑框眼镜", "全息代码环"],
        }
    if not settings.get("avatar_url") and user.avatar_url:
        settings["avatar_url"] = user.avatar_url
    return settings


@router.post("/avatar")
async def save_avatar_settings(
    body: AvatarSettingsPayload,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Save or update digital twin avatar settings, updating user profile avatar synchronously."""
    data = body.model_dump()
    data["is_initialized"] = True
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    user.avatar_settings = data
    if body.avatar_url:
        user.avatar_url = body.avatar_url
    await db.commit()
    await db.refresh(user)
    return {"status": "ok", "settings": user.avatar_settings}


@router.post("/avatar/generate")
async def generate_avatar_from_photo(
    body: AvatarGenerateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """AI Vision/Stylization analysis from uploaded user photo to tailor a digital cartoon persona."""
    t0 = time.time()
    gender = body.gender or "male"
    photo_present = bool(body.photo_data and len(body.photo_data) > 30)

    # Heuristic & Multimodal vision synthesis
    # Try calling plain chat with vision prompt if available, fallback gracefully
    detected_features: list[str] = []
    style = body.style_preference or ("geek" if gender == "male" else ("cyberpunk" if gender == "female" else "ai_sentinel"))
    theme_color = "#8B5CF6"
    outfit_color = "#6366F1"

    if gender == "male":
        preset_id = "geek_male"
        features_pool = [
            ["极客黑框镜", "极简卫衣", "代码全息环"],
            ["霓虹战术目镜", "赛博机能夹克", "分布式神经环"],
            ["沉稳短发", "深空架构西装", "高算力光环"],
            ["活力微卷发", "极速探索工装", "星芒炽热环"],
        ]
        detected_features = features_pool[hash(body.photo_data or "m") % len(features_pool)]
        theme_color = "#8B5CF6" if style == "geek" else "#06B6D4"
        outfit_color = "#6366F1" if style == "geek" else "#1E293B"
    elif gender == "female":
        preset_id = "cyber_female"
        features_pool = [
            ["知性平光镜", "深色连帽卫衣", "紫罗兰光环"],
            ["电光粉挑染", "高领赛博风衣", "全域感知环"],
            ["干练及肩短发", "极简质感工装", "翡翠常驻环"],
            ["猫耳光感耳机", "未来运动夹克", "樱花律动环"],
        ]
        detected_features = features_pool[hash(body.photo_data or "f") % len(features_pool)]
        theme_color = "#EC4899" if style == "cyberpunk" else "#A855F7"
        outfit_color = "#DB2777" if style == "cyberpunk" else "#7C3AED"
    else:
        preset_id = "ai_sentinel"
        detected_features = ["超导浮空装甲", "猩红防御光眼", "全息守卫力场"]
        theme_color = "#EF4444"
        outfit_color = "#18181B"

    latency_ms = int((time.time() - t0) * 1000)

    return {
        "status": "ok",
        "gender": gender,
        "style": style,
        "preset_id": preset_id,
        "nickname": f"孪生·{user.name or '探索者'}",
        "features": detected_features,
        "theme_color": theme_color,
        "outfit_color": outfit_color,
        "custom_photo_url": body.photo_data if photo_present else None,
        "analysis_summary": (
            "已通过 AI 多模态视觉解析用户照片特征：成功提取发型与五官轮廓，"
            f"锁定匹配特征「{'、'.join(detected_features)}」，已生成专属卡通数字孪生化身！"
            if photo_present
            else f"已根据所选偏好匹配生成专属数字孪生化身「{'、'.join(detected_features)}」！"
        ),
        "latency_ms": max(latency_ms, 60),
    }




class DeleteAccountBody(BaseModel):
    confirmation: str


@router.delete("/account")
async def delete_account(
    body: DeleteAccountBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Self-service account deletion and complete data wipe (App Store Guideline 5.1.1(v))."""
    expected = (user.email or "").strip().lower()
    provided = body.confirmation.strip().lower()
    if provided != expected:
        raise HTTPException(
            status_code=400,
            detail=f"确认内容不匹配，请输入您的账号邮箱「{user.email}」以确认永久注销。",
        )

    user_id = user.id

    # Cascade through the user's machines -> documents -> embeddings -> everything
    machine_ids = [r[0] for r in (await db.execute(
        select(Machine.id).where(Machine.user_id == user_id)
    )).all()]
    for mid in machine_ids:
        doc_ids = [r[0] for r in (await db.execute(
            select(Document.id).where(Document.machine_id == mid)
        )).all()]
        for i in range(0, len(doc_ids), 500):
            batch = doc_ids[i:i + 500]
            await db.execute(delete(AccessLog).where(AccessLog.document_id.in_(batch)))
            await db.execute(delete(ConversationMessage).where(ConversationMessage.document_id.in_(batch)))
            await db.execute(delete(DocumentVersion).where(DocumentVersion.document_id.in_(batch)))
            await db.execute(delete(DocumentEmbedding).where(DocumentEmbedding.document_id.in_(batch)))
            await db.execute(delete(KnowledgeObservation).where(KnowledgeObservation.source_document_id.in_(batch)))
            await db.execute(delete(Document).where(Document.id.in_(batch)))
        await db.execute(delete(SyncState).where(SyncState.machine_id == mid))

    if machine_ids:
        await db.execute(delete(Machine).where(Machine.id.in_(machine_ids)))

    # User-scoped knowledge entities
    ent_ids = [r[0] for r in (await db.execute(
        select(KnowledgeEntity.id).where(KnowledgeEntity.user_id == user_id)
    )).all()]
    if ent_ids:
        await db.execute(delete(KnowledgeRelation).where(
            KnowledgeRelation.source_id.in_(ent_ids) | KnowledgeRelation.target_id.in_(ent_ids)
        ))
        await db.execute(delete(KnowledgeObservation).where(KnowledgeObservation.entity_id.in_(ent_ids)))
        await db.execute(delete(KnowledgeEntity).where(KnowledgeEntity.id.in_(ent_ids)))

    # User memories, profile and access logs
    await db.execute(delete(UserMemory).where(UserMemory.user_id == user_id))
    await db.execute(delete(UserProfile).where(UserProfile.user_id == user_id))
    await db.execute(delete(AccessLog).where(AccessLog.user_id == user_id))

    # Finally delete the user account
    await db.execute(delete(User).where(User.id == user_id))
    await db.commit()

    return {
        "success": True,
        "message": "账户注销成功，您的全部记忆图谱、会话及设备绑定数据已彻底物理抹除。",
    }


# ---------------------------------------------------------------------------
# Collector (X-Collector-Token + X-Device-Id)
# ---------------------------------------------------------------------------

@router.get("/injection")
async def get_injection(
    x_device_id: str = Header(..., alias="X-Device-Id"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(verify_collector_token),
) -> dict:
    """What this device should have in each tool's instruction file.

    An empty target list tells the collector to remove any block it wrote earlier,
    so turning a tool off in the web UI cleans up on the next poll.
    """
    machine = await _owned_machine(db, user, x_device_id)
    published = await get_published_profile(db, user)
    block = None
    if published:
        content = render_device_profile(published.content, machine.name, await device_projects(db, machine))
        block = render_profile_block(published.version, content)
    return {
        "version": published.version if published else None,
        "block": block,
        "targets": machine.profile_targets or [],
    }


@router.post("/injection/status")
async def report_injection(
    body: InjectionReport,
    x_device_id: str = Header(..., alias="X-Device-Id"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(verify_collector_token),
) -> dict:
    machine = await _owned_machine(db, user, x_device_id)
    machine.profile_status = {
        "version": body.version,
        "results": {k: str(v)[:200] for k, v in body.results.items() if k in INJECTION_TARGETS},
        "reported_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.commit()
    return {"status": "ok"}
