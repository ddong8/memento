"""Skills: procedures that worked in the user's own environment, shipped to AI tools as SKILL.md.

Session reviews propose them as drafts; the user publishes. Collectors write each
published skill into its own directory under the tools' personal skills folders
(Agent Skills format: `<dir>/<name>/SKILL.md` with `name` and `description`
frontmatter), so Claude Code, Codex and Gemini CLI pick them up by description.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine, Skill, User

# Agent Skills spec: name is 1-64 chars of a-z, 0-9 and single hyphens; description up to 1024.
SLUG_MAX = 64
DESCRIPTION_MAX = 1024
TITLE_MAX = 120
BODY_MAX = 20000
EVIDENCE_KEEP = 10
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

# Which skills folder each profile target implies. Codex and Gemini CLI both read
# ~/.agents/skills; Claude Code reads ~/.claude/skills.
SKILL_DIR_FOR_TARGET = {"claude_code": "claude", "codex": "agents", "antigravity": "agents", "workbuddy": "workbuddy"}


def is_valid_slug(slug: str) -> bool:
    return bool(slug) and len(slug) <= SLUG_MAX and bool(_SLUG_RE.match(slug))


def slugify(text: str | None, fallback_seed: str = "") -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    s = re.sub(r"-{2,}", "-", s)[:SLUG_MAX].strip("-")
    if not s:
        s = "skill-" + hashlib.sha1((fallback_seed or text or "").encode()).hexdigest()[:8]
    return s


async def unique_slug(db: AsyncSession, user: User, base: str, exclude_id: Any = None) -> str:
    base = slugify(base)
    taken = set((await db.execute(
        select(Skill.slug).where(Skill.user_id == user.id, *( [Skill.id != exclude_id] if exclude_id else [] ))
    )).scalars().all())
    if base not in taken:
        return base
    for n in range(2, 100):
        suffix = f"-{n}"
        candidate = base[:SLUG_MAX - len(suffix)].strip("-") + suffix
        if candidate not in taken:
            return candidate
    return slugify("", fallback_seed=f"{base}{datetime.now(timezone.utc).isoformat()}")


def one_line(text: str | None, limit: int) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:limit]


def clean_body(text: str | None) -> str:
    body = (text or "").replace("\r\n", "\n").strip()
    return body[:BODY_MAX]


def render_skill_md(skill: Skill) -> str:
    """SKILL.md as the tools read it. The description is JSON-quoted, which is valid YAML."""
    description = one_line(skill.description, DESCRIPTION_MAX)
    return (
        "---\n"
        f"name: {skill.slug}\n"
        f"description: {json.dumps(description, ensure_ascii=False)}\n"
        "metadata:\n"
        "  source: memento\n"
        f"  memento-id: \"{skill.id}\"\n"
        f"  memento-version: {skill.version}\n"
        "---\n\n"
        f"# {one_line(skill.title, TITLE_MAX)}\n\n"
        f"{clean_body(skill.body)}\n"
    )


def skill_out(skill: Skill, full: bool = True) -> dict[str, Any]:
    out = {
        "id": str(skill.id),
        "slug": skill.slug,
        "title": skill.title,
        "description": skill.description,
        "project": skill.project,
        "status": skill.status,
        "version": skill.version,
        "times_seen": skill.times_seen,
        "edited_by_user": skill.edited_by_user,
        "has_update": bool(skill.pending_update),
        "evidence": skill.evidence or [],
        "first_seen_at": skill.first_seen_at.isoformat() if skill.first_seen_at else None,
        "last_seen_at": skill.last_seen_at.isoformat() if skill.last_seen_at else None,
        "published_at": skill.published_at.isoformat() if skill.published_at else None,
        "updated_at": skill.updated_at.isoformat() if skill.updated_at else None,
    }
    if full:
        out["body"] = skill.body
        out["pending_update"] = skill.pending_update
        out["skill_md"] = render_skill_md(skill)
    return out


def add_evidence(skill: Skill, evidence: dict[str, Any]) -> None:
    items = [e for e in (skill.evidence or []) if e.get("doc_id") != evidence.get("doc_id")]
    items.append(evidence)
    skill.evidence = items[-EVIDENCE_KEEP:]


async def apply_edits(db: AsyncSession, user: User, skill: Skill, edits: dict[str, Any]) -> None:
    """Apply the user's edits (title / description / body / slug / project). Raises ValueError."""
    if edits.get("title") is not None:
        skill.title = one_line(edits["title"], TITLE_MAX) or skill.title
    if edits.get("description") is not None:
        description = one_line(edits["description"], DESCRIPTION_MAX)
        if not description:
            raise ValueError("说明不能为空：AI 靠它判断什么时候用这个技能")
        skill.description = description
    if edits.get("body") is not None:
        body = clean_body(edits["body"])
        if not body:
            raise ValueError("步骤不能为空")
        skill.body = body
    if edits.get("project") is not None:
        skill.project = one_line(edits["project"], 120) or None
    if edits.get("slug") is not None and edits["slug"] != skill.slug:
        slug = str(edits["slug"]).strip().lower()
        if not is_valid_slug(slug):
            raise ValueError("名称只能用小写字母、数字和单个连字符，最长 64 个字符")
        if await unique_slug(db, user, slug, exclude_id=skill.id) != slug:
            raise ValueError(f"已经有叫 {slug} 的技能了")
        skill.slug = slug
    skill.edited_by_user = True


def publish(skill: Skill) -> None:
    skill.status = "published"
    skill.version = (skill.version or 0) + 1
    skill.published_at = datetime.now(timezone.utc)


def apply_pending_update(skill: Skill) -> None:
    update = skill.pending_update or {}
    if update.get("description"):
        skill.description = one_line(update["description"], DESCRIPTION_MAX)
    if update.get("body"):
        skill.body = clean_body(update["body"])
    skill.pending_update = None
    if skill.status == "published":
        publish(skill)


def upsert_mined(
    user: User,
    candidate: dict[str, Any],
    existing: Skill | None,
    evidence: dict[str, Any],
    slug: str,
    now: datetime,
) -> tuple[Skill, str]:
    """Merge a skill proposed by a session review. Returns (skill, what happened):
    "new" | "refined" (a draft took the newer steps) | "update_pending" (a published
    skill has a proposed change) | "seen" (only counted)."""
    title = one_line(candidate.get("title"), TITLE_MAX)
    description = one_line(candidate.get("description"), DESCRIPTION_MAX)
    body = clean_body(candidate.get("body"))
    project = one_line(candidate.get("project"), 120) or None
    changes = one_line(candidate.get("changes"), 300)

    if existing is None:
        skill = Skill(
            user_id=user.id, slug=slug, title=title or slug, description=description, body=body,
            project=project, status="draft", version=0, evidence=[], times_seen=1,
            first_seen_at=now, last_seen_at=now,
        )
        add_evidence(skill, evidence)
        return skill, "new"

    existing.times_seen = (existing.times_seen or 0) + 1
    existing.last_seen_at = now
    add_evidence(existing, evidence)
    if existing.status in ("dismissed", "retired") or not (description and body):
        return existing, "seen"
    if existing.status == "draft" and not existing.edited_by_user:
        existing.title = title or existing.title
        existing.description = description
        existing.body = body
        existing.project = project or existing.project
        return existing, "refined"
    if changes:
        existing.pending_update = {
            "description": description, "body": body, "reason": changes, "at": now.isoformat(),
        }
        return existing, "update_pending"
    return existing, "seen"


async def injection_for(db: AsyncSession, user: User, machine: Machine) -> dict[str, Any]:
    """What this device should have in each tool's skills folder."""
    dirs = sorted({SKILL_DIR_FOR_TARGET[t] for t in (machine.profile_targets or []) if t in SKILL_DIR_FOR_TARGET})
    skills = (await db.execute(
        select(Skill).where(Skill.user_id == user.id, Skill.status == "published").order_by(Skill.slug)
    )).scalars().all()
    return {
        "targets": dirs,
        "skills": [
            {"slug": s.slug, "version": s.version, "id": str(s.id), "content": render_skill_md(s)}
            for s in skills
        ],
    }


async def skill_counts(db: AsyncSession, user: User) -> dict[str, int]:
    rows = (await db.execute(
        select(Skill.status, func.count()).where(Skill.user_id == user.id).group_by(Skill.status)
    )).all()
    counts = {status: n for status, n in rows}
    pending = (await db.execute(
        select(func.count()).select_from(Skill).where(
            Skill.user_id == user.id, Skill.status == "published", Skill.pending_update.is_not(None),
        )
    )).scalar() or 0
    return {
        "draft": counts.get("draft", 0),
        "published": counts.get("published", 0),
        "dismissed": counts.get("dismissed", 0),
        "retired": counts.get("retired", 0),
        "updates": pending,
    }
