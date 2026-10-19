"""Resident profile — the short "about me" block every AI tool loads at session start.

Built from what the user actually typed (the user-voice stage shared with dreaming)
plus their preference/rule core memories, then held as a draft until the user
publishes it. Collectors write only published text, between the begin/end markers,
into each enabled tool's global instruction file (CLAUDE.md, AGENTS.md, ...).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, Machine, Project, User, UserMemory, UserProfile
from .ai_provider import call_plain_chat, get_ai_providers
from .dreaming_service import fetch_user_voice_rows, plan_user_voice_batches, render_user_voice

logger = logging.getLogger("server.profile_service")

PROFILE_MAX_CHARS = 1800  # the general part, loaded by every tool in every project
SCOPED_MAX_CHARS = 800  # each "## 项目：…" / "## 设备：…" section
PROFILE_VOICE_DAYS = 30
# Tools whose global instruction file a collector can carry the block in.
# Cursor keeps its global rules in a settings database, not a file, so it isn't here.
INJECTION_TARGETS = ("claude_code", "codex", "antigravity", "workbuddy", "openclaw", "hermes")

# The collector matches these same markers (mobile/lib/collector/services/profile_inject_service.dart).
PROFILE_BEGIN = "<!-- memento:begin"
PROFILE_END = "<!-- memento:end -->"
PROFILE_BLOCK_RE = re.compile(r"<!-- memento:begin[^>]*-->[\s\S]*?<!-- memento:end -->\n?")

_PROFILE_PROMPT = """你在为一位用户维护一段"常驻画像"。它会在用户每次打开 Claude Code、Codex、Gemini 等 AI 工具时自动加载，让 AI 一开始就知道该怎么和这位用户协作。

## 当前已发布的画像
{current}

## 用户最近 {days} 天亲口说的话（只含用户本人输入）
{voice}

## 用户的偏好与铁律类长期记忆
{memories}

## 用户的项目与设备（原话前的 [项目 @ 设备] 标注用的就是这些名字）
项目：{projects}
设备：{devices}

## 要求
- 在当前画像基础上增删改，不要无故重写。已有条目除非被新证据推翻，否则保留；不要为了给新内容腾地方删掉已有的通用条目。
- 只写能指导 AI 行为的内容：沟通方式、必须遵守的规则、工作习惯、技术偏好。不写提交哈希、一次性任务。
- 通用部分不写某套具体系统的操作细节（某台服务器、某个集群、某个站点的命令、路径、版本号、账号）。这类内容能判断出属于哪个项目的，放进那个项目的小节；判断不出的，不写。放不下时，先删最具体、最不通用的条目。
- 每条都必须能在上面的原话或记忆里找到依据；只在一次随口的话里出现过的，不写。
- 直接对 AI 下指令的祈使句（如"始终用中文回复"），不要写成"用户喜欢……"。
- 分清作用域。默认写成通用规矩；只在某个项目里才成立的（涉及那个项目的业务领域、数据格式、专有工具或目录，例如化学结构式、某个站点的字段），放进"## 项目：项目名"小节；只在某台设备上成立的（那台机器的磁盘、路径、本机服务），放进"## 设备：设备名"小节。项目名、设备名照抄上面列表里的写法。当前画像里已有的这类条目，按原话标注判断归属后挪过去；判断不出属于哪个项目的，保持通用。沟通方式、工作习惯这类到哪都适用的，即使只在一个项目里说过，也写成通用。
- Markdown。通用部分按这几个小标题分组，没有内容的省略：### 沟通、### 铁律、### 工作方式、### 技术偏好。项目、设备小节放在最后，条目直接写在小节下面，不再分小标题。每条一行，以"- "开头。
- 通用部分不超过 {max_chars} 个字符，每个项目或设备小节不超过 {scoped_max} 个字符。
- 只输出画像正文，不要解释、前言或代码块包裹。"""


def strip_profile_block(text: str) -> str:
    """Remove an injected profile block, so collecting a tool's instruction file
    never feeds Memento its own output back as something to learn from."""
    if not text or PROFILE_BEGIN not in text:
        return text
    return PROFILE_BLOCK_RE.sub("", text)


# A rule that only holds in one project or on one machine lives in its own
# section at the end of the profile, e.g. "## 项目：chem-search" or
# "## 设备：DESKTOP-KR9IPP4". Everything above the first such heading is general.
SCOPE_HEADING_RE = re.compile(r"^##\s*(项目|设备)\s*[:：]\s*(.+?)\s*$")
SCOPE_KINDS = {"项目": "project", "设备": "device"}


@dataclass
class ProfileScopes:
    general: str
    projects: dict[str, list[str]] = field(default_factory=dict)  # name -> lines, as written
    devices: dict[str, list[str]] = field(default_factory=dict)


def split_profile_scopes(content: str) -> ProfileScopes:
    scopes = ProfileScopes(general="")
    general: list[str] = []
    current: list[str] | None = None
    for line in (content or "").split("\n"):
        m = SCOPE_HEADING_RE.match(line.strip())
        if m:
            bucket = scopes.projects if SCOPE_KINDS[m.group(1)] == "project" else scopes.devices
            current = bucket.setdefault(m.group(2), [])
            continue
        if current is None:
            general.append(line)
        elif line.strip() and not line.lstrip().startswith("#"):
            current.append(line.rstrip())
    scopes.general = "\n".join(general).strip()
    return scopes


def join_profile_scopes(scopes: ProfileScopes) -> str:
    parts = [scopes.general.strip()] if scopes.general.strip() else []
    for label, bucket in (("项目", scopes.projects), ("设备", scopes.devices)):
        for name, lines in bucket.items():
            if lines:
                parts.append(f"## {label}：{name}\n" + "\n".join(lines))
    return "\n\n".join(parts)


def _cap(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text.rfind("\n", 0, limit)
    return text[: cut if cut > 0 else limit].rstrip()


def deduplicate_rule_lines(lines: list[str]) -> list[str]:
    """Deduplicate rule lines while preserving order and markdown section structure."""
    seen: set[str] = set()
    deduped: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("-") or stripped.startswith("*"):
            norm = re.sub(r"[\s，,。；;！!]+", "", stripped.lstrip("-*• \t").lower())
            if norm in seen:
                continue
            seen.add(norm)
        deduped.append(line)
    return deduped


def sanitize_profile_content(text: str | None) -> str:
    """Normalize LLM or user-edited profile text into something safe to inject."""
    if not text:
        return ""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.rstrip().endswith("```"):
            cleaned = cleaned.rstrip()[:-3]
    # HTML comment delimiters would let the text forge or close the managed block.
    cleaned = cleaned.replace("<!--", "").replace("-->", "").strip()
    scopes = split_profile_scopes(cleaned)
    scopes.general = "\n".join(deduplicate_rule_lines(scopes.general.split("\n")))
    scopes.general = _cap(scopes.general, PROFILE_MAX_CHARS)
    for bucket in (scopes.projects, scopes.devices):
        for name, lines in bucket.items():
            cleaned_lines = deduplicate_rule_lines(lines)
            bucket[name] = _cap("\n".join(cleaned_lines), SCOPED_MAX_CHARS).split("\n") if cleaned_lines else []
    return join_profile_scopes(scopes)


def clean_device_name(name: str | None) -> str:
    """"haixingdeMac-mini.local (Darwin)" -> "haixingdeMac-mini", the name the user knows."""
    text = re.sub(r"\s*\([^)]*\)\s*$", "", (name or "").strip())
    return re.sub(r"\.local$", "", text).strip()


def norm_scope_name(name: str) -> str:
    return re.sub(r"\s+", "", name or "").lower()


def render_device_profile(content: str, device_name: str, projects_here: dict[str, str]) -> str:
    """What one device's tools load: the general rules, this device's own, and the
    rules of each project that lives on it, tied to that project's directory there.
    Project and device rules for elsewhere stay out, so they can't leak into
    unrelated work."""
    scopes = split_profile_scopes(content)
    parts = [scopes.general] if scopes.general else []
    device_key = norm_scope_name(clean_device_name(device_name))
    own = [line for name, lines in scopes.devices.items() if norm_scope_name(clean_device_name(name)) == device_key for line in lines]
    if own:
        parts.append("### 本机专属\n" + "\n".join(own))
    paths = {norm_scope_name(name): path for name, path in projects_here.items()}
    here = [(name, paths[norm_scope_name(name)], lines) for name, lines in scopes.projects.items() if lines and norm_scope_name(name) in paths]
    if here:
        sections = [f"#### {name}（`{path}`）\n" + "\n".join(lines) for name, path, lines in here]
        parts.append(
            "### 只在对应项目里适用\n在下面这些目录（含子目录）里工作时才适用，在其他项目里忽略。\n\n"
            + "\n\n".join(sections)
        )
    return "\n\n".join(parts)


def render_profile_block(version: int, content: str) -> str:
    """The exact text a collector writes into a tool's instruction file."""
    return (
        f"{PROFILE_BEGIN} v{version} · 由 Memento 生成，请在 Memento 中修改，手改此段会被覆盖 -->\n"
        "## 关于我（Memento 长期记忆）\n\n"
        f"{content.strip()}\n\n"
        "需要更多上下文时，用 memento-memory MCP 的 memory_search / memory_core 查询。\n"
        f"{PROFILE_END}\n"
    )


PROJECT_ACTIVE_DAYS = 120


async def device_projects(db: AsyncSession, machine: Machine, days: int = PROJECT_ACTIVE_DAYS) -> dict[str, str]:
    """Projects this machine worked on lately: name -> its directory on this machine."""
    from .ingest_service import _clean_source_path

    rows = (await db.execute(
        select(Project.title, func.max(Document.metadata_["project_path"].astext))
        .join(Project, Project.id == Document.project_id)
        .where(
            Document.machine_id == machine.id,
            Document.synced_at >= datetime.now(timezone.utc) - timedelta(days=days),
            Document.metadata_.has_key("project_path"),
        )
        .group_by(Project.title)
    )).all()
    found: dict[str, str] = {}
    for title, raw_path in rows:
        path = _clean_source_path(raw_path)
        if title and path:
            found.setdefault(title, path)
    return found


async def user_scopes(db: AsyncSession, user: User, days: int = PROJECT_ACTIVE_DAYS) -> tuple[list[str], list[str]]:
    """The user's recently active project names and device names, as the profile should spell them."""
    machines = (await db.execute(select(Machine).where(Machine.user_id == user.id))).scalars().all()
    devices = sorted({clean_device_name(m.name) for m in machines if m.name})
    projects = (await db.execute(
        select(Project.title)
        .join(Document, Document.project_id == Project.id)
        .where(
            Document.machine_id.in_([m.id for m in machines] or [None]),
            Document.synced_at >= datetime.now(timezone.utc) - timedelta(days=days),
        )
        .group_by(Project.title)
        .order_by(func.max(Document.synced_at).desc())
        .limit(40)
    )).scalars().all()
    return [p for p in projects if p], devices


async def get_published_profile(db: AsyncSession, user: User) -> UserProfile | None:
    return (await db.execute(
        select(UserProfile)
        .where(UserProfile.user_id == user.id, UserProfile.status == "published")
        .order_by(UserProfile.version.desc())
        .limit(1)
    )).scalar_one_or_none()


async def get_draft_profile(db: AsyncSession, user: User) -> UserProfile | None:
    return (await db.execute(
        select(UserProfile)
        .where(UserProfile.user_id == user.id, UserProfile.status == "draft")
        .order_by(UserProfile.updated_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def publish_profile(db: AsyncSession, user: User, content: str) -> UserProfile:
    """Freeze content as the next published version and drop the pending draft."""
    content = sanitize_profile_content(content)
    if not content:
        raise ValueError("profile content is empty")
    last = (await db.execute(
        select(func.max(UserProfile.version)).where(UserProfile.user_id == user.id)
    )).scalar() or 0
    draft = await get_draft_profile(db, user)
    now = datetime.now(timezone.utc)
    if draft:
        draft.status = "published"
        draft.version = last + 1
        draft.content = content
        draft.published_at = now
        profile = draft
    else:
        profile = UserProfile(
            user_id=user.id, status="published", version=last + 1,
            content=content, stats={"source": "manual"}, published_at=now,
        )
        db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return profile


async def _profile_memories(db: AsyncSession, user: User) -> list[UserMemory]:
    rows = (await db.execute(
        select(UserMemory)
        .where(
            UserMemory.user_id == user.id,
            UserMemory.category.in_(("preference", "rule", "rules")),
            UserMemory.is_folder.is_(False),
            UserMemory.status == "active",
        )
        .order_by(UserMemory.updated_at.desc())
        .limit(120)
    )).scalars().all()
    # Hand-written entries first; among the rest, the ones dreaming is surest about.
    return sorted(rows, key=lambda m: (m.source != "manual", -(m.confidence or 0)))[:60]


async def build_profile_draft(db: AsyncSession, user: User) -> tuple[UserProfile | None, str]:
    """Refresh the user's draft profile.

    Returns (draft, "updated"), or (None, reason) with reason one of: "no_llm",
    "user_editing", "no_input", "llm_failed", "same_as_published".
    """
    if not get_ai_providers():
        return None, "no_llm"

    draft = await get_draft_profile(db, user)
    if draft and (draft.stats or {}).get("edited_by_user"):
        return None, "user_editing"  # never clobber an edit the user hasn't published yet

    now = datetime.now(timezone.utc)
    voice_rows = await fetch_user_voice_rows(
        db, user, now - timedelta(days=PROFILE_VOICE_DAYS), now, with_source=True,
    )
    batches, voice_stats = plan_user_voice_batches(voice_rows)
    memories = await _profile_memories(db, user)
    published = await get_published_profile(db, user)
    projects, devices = await user_scopes(db, user)
    # The LLM calls below can take minutes. End the read transaction so the
    # pooled connection isn't held idle meanwhile (and closed under us).
    await db.commit()

    voice = await render_user_voice(batches)

    if not voice and not memories:
        return None, "no_input"

    memory_lines = "\n".join(f"- [{m.category}] {m.content.strip()[:200]}" for m in memories)
    raw = await call_plain_chat(
        messages=[
            {"role": "system", "content": "You maintain a concise user profile for AI assistants. Output only the profile body."},
            {"role": "user", "content": _PROFILE_PROMPT.format(
                current=published.content if published else "（尚无）",
                days=PROFILE_VOICE_DAYS,
                voice=voice or "（无）",
                memories=memory_lines or "（无）",
                projects="、".join(projects) or "（无）",
                devices="、".join(devices) or "（无）",
                max_chars=PROFILE_MAX_CHARS,
                scoped_max=SCOPED_MAX_CHARS,
            )},
        ],
        # Room for a reasoning model's thinking plus a PROFILE_MAX_CHARS answer;
        # the client waits up to 5 minutes for this request.
        max_tokens=6000,
        timeout=180.0,
    )
    content = sanitize_profile_content(raw)
    if not content:
        return None, "llm_failed"
    if published and content == published.content.strip():
        return None, "same_as_published"

    stats = {"user_voice": voice_stats, "memories": len(memories), "generated_at": now.isoformat()}
    if draft:
        draft.content = content
        draft.stats = stats
    else:
        draft = UserProfile(user_id=user.id, status="draft", content=content, stats=stats)
        db.add(draft)
    await db.commit()
    await db.refresh(draft)
    return draft, "updated"
