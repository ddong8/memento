"""24/7 Life Rhythm, Screen Time & AI Lifestyle Decision Service.

Tracks daily sleep/wake schedules, app usage allocation (work vs distraction),
computes life regularity metrics, and delivers AI-driven lifestyle & scheduling decisions.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, Document, Todo, User, UserLifeRhythm
from .ai_provider import call_plain_chat

logger = logging.getLogger("server.life_service")

# Professional display names for developer tools
TOOL_DISPLAY_NAMES: dict[str, str] = {
    "claude": "Claude Code",
    "claude_code": "Claude Code",
    "cursor": "Cursor",
    "vscode": "VS Code",
    "antigravity": "Antigravity",
    "trae": "Trae",
    "windsurf": "Windsurf",
    "terminal": "Terminal",
    "iterm2": "iTerm2",
    "chatgpt": "ChatGPT",
    "codex": "Codex",
    "workbuddy": "WorkBuddy",
    "pycharm": "PyCharm",
    "intellij": "IntelliJ IDEA",
}


def format_tool_name(raw_name: str) -> str:
    norm = raw_name.strip().lower()
    return TOOL_DISPLAY_NAMES.get(norm, raw_name.strip() or "开发工具")

# Categorization rules for common desktop and mobile applications
APP_CATEGORIES: dict[str, str] = {
    # Work & Productivity
    "cursor": "work",
    "vscode": "work",
    "visual studio code": "work",
    "xcode": "work",
    "pycharm": "work",
    "intellij idea": "work",
    "antigravity": "work",
    "workbuddy": "work",
    "terminal": "work",
    "iterm2": "work",
    "notion": "work",
    "obsidian": "work",
    "feishu": "work",
    "lark": "work",
    "slack": "work",
    "dingtalk": "work",
    "钉钉": "work",
    "企业微信": "work",
    "wps": "work",
    "word": "work",
    "excel": "work",
    "chrome": "work",
    "google chrome": "work",
    "arc": "work",
    "edge": "work",
    "microsoft edge": "work",
    "postman": "work",
    "figma": "work",
    "datagrip": "work",
    "docker": "work",
    "chatgpt": "work",
    "claude": "work",

    # Communication & Social
    "wechat": "social",
    "微信": "social",
    "qq": "social",
    "telegram": "social",
    "whatsapp": "social",
    "discord": "social",
    "weibo": "social",
    "微博": "social",

    # Entertainment & Distraction
    "douyin": "entertainment",
    "抖音": "entertainment",
    "tiktok": "entertainment",
    "bilibili": "entertainment",
    "哔哩哔哩": "entertainment",
    "xiaohongshu": "entertainment",
    "小红书": "entertainment",
    "kuaishou": "entertainment",
    "快手": "entertainment",
    "youtube": "entertainment",
    "genshin impact": "entertainment",
    "原神": "entertainment",
    "honor of kings": "entertainment",
    "王者荣耀": "entertainment",
    "steam": "entertainment",
    "netflix": "entertainment",

    # Reading & Learning
    "wechat read": "reading",
    "微信读书": "reading",
    "kindle": "reading",
    "duolingo": "reading",
    "知乎": "reading",
    "zhihu": "reading",
}


def classify_app(app_name: str) -> str:
    """Classify an application into work, social, entertainment, reading, or general."""
    norm = app_name.strip().lower()
    # Match more specific patterns first (e.g. "微信读书" before "微信")
    for pattern in sorted(APP_CATEGORIES.keys(), key=len, reverse=True):
        if pattern in norm:
            return APP_CATEGORIES[pattern]
    return "general"


async def record_daily_rhythm(
    db: AsyncSession,
    user: User,
    log_date: date,
    app_usages: list[dict[str, Any]],
    wakeup_time: str | None = None,
    bedtime: str | None = None,
    sleep_hours: float | None = None,
) -> UserLifeRhythm:
    """Record or update a user's daily sleep rhythm and app usage allocation."""
    processed_apps = []
    for item in app_usages:
        name = item.get("name", "Unknown").strip()
        minutes = int(item.get("minutes", 0))
        cat = item.get("category") or classify_app(name)
        processed_apps.append({
            "name": name,
            "category": cat,
            "minutes": minutes,
            "icon": item.get("icon"),
        })

    # Compute sleep hours if wakeup and bedtime are provided
    if wakeup_time and bedtime and sleep_hours is None:
        try:
            bh, bm = map(int, bedtime.split(":"))
            wh, wm = map(int, wakeup_time.split(":"))
            b_total = bh * 60 + bm
            w_total = wh * 60 + wm
            if w_total < b_total:
                # Slept across midnight (e.g. 00:30 to 07:45)
                dur = (1440 - b_total) + w_total
            else:
                dur = w_total - b_total
            sleep_hours = round(dur / 60.0, 1)
        except Exception:
            pass

    # Find existing row for this day
    existing = (await db.execute(
        select(UserLifeRhythm).where(
            UserLifeRhythm.user_id == user.id,
            UserLifeRhythm.log_date == log_date,
        )
    )).scalar_one_or_none()

    if existing:
        # Smart merge of existing apps and incoming apps (so Mac and mobile don't overwrite each other)
        app_map: dict[str, dict[str, Any]] = {}
        for old in (existing.app_usages or []):
            if isinstance(old, dict) and old.get("name"):
                app_map[old["name"]] = dict(old)
        for new in processed_apps:
            name = new["name"]
            if name in app_map:
                old_min = int(app_map[name].get("minutes", 0))
                app_map[name]["minutes"] = max(old_min, new["minutes"])
                if new.get("category"):
                    app_map[name]["category"] = new["category"]
            else:
                app_map[name] = new

        merged_apps = list(app_map.values())
        merged_apps.sort(key=lambda x: int(x.get("minutes", 0)), reverse=True)

        total_screen_min = sum(int(a.get("minutes", 0)) for a in merged_apps)
        prod_min = sum(int(a.get("minutes", 0)) for a in merged_apps if a.get("category") in ("work", "reading"))
        dist_min = sum(int(a.get("minutes", 0)) for a in merged_apps if a.get("category") in ("entertainment", "social"))

        if wakeup_time:
            existing.wakeup_time = wakeup_time
        if bedtime:
            existing.bedtime = bedtime
        if sleep_hours is not None:
            existing.sleep_hours = sleep_hours
        existing.total_screen_minutes = total_screen_min
        existing.productive_minutes = prod_min
        existing.distraction_minutes = dist_min
        existing.app_usages = merged_apps
        existing.updated_at = datetime.now(timezone.utc)
        record = existing
    else:
        processed_apps.sort(key=lambda x: x["minutes"], reverse=True)
        total_screen_min = sum(a["minutes"] for a in processed_apps)
        prod_min = sum(a["minutes"] for a in processed_apps if a["category"] in ("work", "reading"))
        dist_min = sum(a["minutes"] for a in processed_apps if a["category"] in ("entertainment", "social"))

        record = UserLifeRhythm(
            user_id=user.id,
            log_date=log_date,
            wakeup_time=wakeup_time,
            bedtime=bedtime,
            sleep_hours=sleep_hours,
            total_screen_minutes=total_screen_min,
            productive_minutes=prod_min,
            distraction_minutes=dist_min,
            app_usages=processed_apps,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(record)

    await db.commit()
    await db.refresh(record)
    return record


async def sync_rhythms_from_collector(
    db: AsyncSession,
    user: User,
    days: int = 7,
    tz_offset: int = 0,
) -> list[UserLifeRhythm]:
    """Analyze real collector activity (conversation messages & document events) to compute authentic sleep/wake rhythms.

    Logic:
    - Working days cut off at 04:00 AM local time (night owl developer working past midnight belongs to previous day).
    - Wakeup Time: First interaction event of the day.
    - Bedtime: Last interaction event of the day before sleep.
    - Sleep Hours: Rest duration between previous day's end and current day's start.
    - Productive Minutes & Tool Allocation: Active session slicing of interactions per tool.
    """
    from ..services.user_filter import user_machine_ids

    mids = await user_machine_ids(db, user)
    tz_delta = timedelta(minutes=-tz_offset)
    user_now = datetime.now(timezone.utc) + tz_delta
    today_user_date = user_now.date()

    # Look back (days + 2) days so we have the prior day to compute sleep hours for day 1
    start_date = today_user_date - timedelta(days=days + 2)
    start_cutoff_utc = datetime.combine(start_date, datetime.min.time()) + timedelta(hours=4) - tz_delta

    # 1. Fetch conversation messages
    msg_stmt = (
        select(ConversationMessage.timestamp, Document.tool_id)
        .join(Document, ConversationMessage.document_id == Document.id)
        .where(
            ConversationMessage.timestamp >= start_cutoff_utc,
            ConversationMessage.timestamp.isnot(None),
            Document.tool_id != "system",
        )
    )
    if mids is not None:
        msg_stmt = msg_stmt.where(Document.machine_id.in_(mids))

    msg_res = await db.execute(msg_stmt)
    raw_events: list[tuple[datetime, str]] = []
    for ts, tool in msg_res.all():
        if ts:
            raw_events.append((ts, tool or "unknown"))

    # 2. Also fetch document synced timestamps as supplement
    doc_stmt = (
        select(Document.synced_at, Document.tool_id)
        .where(
            Document.synced_at >= start_cutoff_utc,
            Document.synced_at.isnot(None),
            Document.tool_id != "system",
        )
    )
    if mids is not None:
        doc_stmt = doc_stmt.where(Document.machine_id.in_(mids))

    doc_res = await db.execute(doc_stmt)
    for ts, tool in doc_res.all():
        if ts:
            raw_events.append((ts, tool or "unknown"))

    if not raw_events:
        return []

    # Convert all timestamps to local time and sort chronologically
    local_events: list[tuple[datetime, str]] = []
    for utc_ts, tool in raw_events:
        if utc_ts.tzinfo is None:
            utc_ts = utc_ts.replace(tzinfo=timezone.utc)
        local_dt = utc_ts + tz_delta
        local_events.append((local_dt.replace(tzinfo=None), tool))

    local_events.sort(key=lambda x: x[0])

    # Group events by logical working day (Day boundary: 04:00 AM)
    def event_to_work_date(dt: datetime) -> date:
        if dt.hour < 4:
            return (dt - timedelta(days=1)).date()
        return dt.date()

    days_events: dict[date, list[tuple[datetime, str]]] = {}
    for dt, tool in local_events:
        w_date = event_to_work_date(dt)
        if w_date not in days_events:
            days_events[w_date] = []
        days_events[w_date].append((dt, tool))

    sorted_work_dates = sorted(days_events.keys())
    saved_records: list[UserLifeRhythm] = []
    last_event_of_prev_day: datetime | None = None

    for w_date in sorted_work_dates:
        evs = days_events[w_date]
        if not evs:
            continue

        first_dt = evs[0][0]
        last_dt = evs[-1][0]

        wakeup_str = first_dt.strftime("%H:%M")
        bedtime_str = last_dt.strftime("%H:%M")

        # Sleep duration between prior day's last event and current day's first event
        sleep_hrs: float | None = None
        if last_event_of_prev_day:
            gap_seconds = (first_dt - last_event_of_prev_day).total_seconds()
            gap_hours = gap_seconds / 3600.0
            if 3.0 <= gap_hours <= 16.0:
                sleep_hrs = round(gap_hours, 1)

        last_event_of_prev_day = last_dt

        # Slicing active session duration per tool
        tool_minutes: dict[str, int] = {}
        SESSION_GAP_MINUTES = 20
        BASE_INTERACTION_MINUTES = 3

        if len(evs) == 1:
            disp_tool = format_tool_name(evs[0][1])
            tool_minutes[disp_tool] = BASE_INTERACTION_MINUTES
        else:
            i = 0
            while i < len(evs):
                tool = format_tool_name(evs[i][1])
                session_start = evs[i][0]
                session_end = session_start

                while i + 1 < len(evs) and (evs[i + 1][0] - session_end).total_seconds() <= SESSION_GAP_MINUTES * 60:
                    i += 1
                    session_end = evs[i][0]

                duration_min = max(BASE_INTERACTION_MINUTES, int((session_end - session_start).total_seconds() / 60))
                tool_minutes[tool] = tool_minutes.get(tool, 0) + duration_min
                i += 1

        app_usages: list[dict[str, Any]] = []
        for t_name, mins in sorted(tool_minutes.items(), key=lambda x: x[1], reverse=True):
            app_usages.append({
                "name": t_name,
                "category": "work",
                "minutes": mins,
                "icon": t_name.lower().replace(" ", ""),
            })

        rec = await record_daily_rhythm(
            db=db,
            user=user,
            log_date=w_date,
            app_usages=app_usages,
            wakeup_time=wakeup_str,
            bedtime=bedtime_str,
            sleep_hours=sleep_hrs,
        )
        saved_records.append(rec)

    return saved_records


async def get_recent_rhythms(
    db: AsyncSession,
    user: User,
    days: int = 7,
    tz_offset: int = 0,
    sync_collector: bool = True,
) -> list[dict[str, Any]]:
    """Retrieve daily rhythms for the past N days, automatically derived from collector activity."""
    if sync_collector:
        try:
            await sync_rhythms_from_collector(db, user, days=days, tz_offset=tz_offset)
        except Exception as e:
            logger.warning("Collector rhythm auto-sync skipped: %s", e)

    start_date = date.today() - timedelta(days=days)
    records = (await db.execute(
        select(UserLifeRhythm)
        .where(UserLifeRhythm.user_id == user.id, UserLifeRhythm.log_date >= start_date)
        .order_by(UserLifeRhythm.log_date.desc())
    )).scalars().all()

    return [
        {
            "id": str(r.id),
            "date": r.log_date.isoformat(),
            "wakeup_time": r.wakeup_time,
            "bedtime": r.bedtime,
            "sleep_hours": r.sleep_hours,
            "total_screen_minutes": r.total_screen_minutes,
            "productive_minutes": r.productive_minutes,
            "distraction_minutes": r.distraction_minutes,
            "app_usages": r.app_usages,
            "ai_advice": r.ai_advice,
        }
        for r in records
    ]


async def generate_life_decision_advice(db: AsyncSession, user: User, target_date: date) -> str:
    """Analyze the user's recent sleep schedule, app time allocation and generate actionable life decisions."""
    # Fetch target day record and previous days for trend comparison
    rhythms = (await db.execute(
        select(UserLifeRhythm)
        .where(
            UserLifeRhythm.user_id == user.id,
            UserLifeRhythm.log_date <= target_date,
            UserLifeRhythm.log_date >= target_date - timedelta(days=7),
        )
        .order_by(UserLifeRhythm.log_date.desc())
    )).scalars().all()

    if not rhythms:
        return "暂无足够的作息与屏幕时间数据供 AI 分析建议。"

    target_record = rhythms[0]

    # Gather open todos for lifestyle-work alignment
    todos = (await db.execute(
        select(Todo).where(Todo.user_id == user.id, Todo.status == "open").limit(5)
    )).scalars().all()
    todo_titles = [t.title for t in todos]

    history_summary = []
    for r in rhythms:
        top_apps = ", ".join([f"{a['name']}({a['minutes']}m)" for a in r.app_usages[:4]])
        history_summary.append(
            f"- {r.log_date}: 起床 {r.wakeup_time or '未知'}, 入睡 {r.bedtime or '未知'}, 睡眠 {r.sleep_hours or '未知'}h, "
            f"总屏幕 {r.total_screen_minutes}m (工作专注 {r.productive_minutes}m, 娱乐社交 {r.distraction_minutes}m). 主要应用: {top_apps}"
        )

    prompt = f"""你是一名世界级的个人精力管理与生活决策 AI 导师。
请根据用户近期的真实作息记录、手机与电脑 App 时间分配以及待办任务，为用户提供极其深刻、真实、具有实际决策指导意义的生活顾问建议。

【用户近期作息与屏幕时间数据】
{chr(10).join(history_summary)}

【当前重要待办事项】
{json.dumps(todo_titles, ensure_ascii=False) if todo_titles else '无紧急待办'}

请严格按照以下 3 大模块输出专业分析与生活决策建议（语气真诚、客观、直击痛点，拒绝虚头巴脑的客套）：
1) 【作息与精力状态诊断】客观评估睡眠规律度与精力起伏（是否存在晚睡拖延、睡眠债或作息紊乱）；
2) 【时间黑洞与注意力审计】指出吞噬用户时间的典型 App 或碎片化分心时段（量化分析生产力与娱乐比例）；
3) 【生活决策行动指南（今日与明日本周）】给出 2~3 条立即可执行的精准决策（例如：调整就寝时间、晚间电子屏幕断网阈值、根据精力高低峰重排今日关键工作任务、设立专注时段等）。

控制在 350 字以内，排版清晰美观："""

    try:
        advice = await call_plain_chat([{"role": "user", "content": prompt}], background=True, user=user)
        target_record.ai_advice = (advice or "").strip()
        await db.commit()
        return (advice or "").strip()
    except Exception as e:
        logger.warning("Failed to generate life decision advice: %s", e)
        return "AI 决策建议生成暂不可用，已记录今日基础作息数据。"


async def clear_user_rhythms(db: AsyncSession, user: User, log_date: date | None = None) -> int:
    """Clear rhythm records for the user (all or a specific date)."""
    stmt = select(UserLifeRhythm).where(UserLifeRhythm.user_id == user.id)
    if log_date:
        stmt = stmt.where(UserLifeRhythm.log_date == log_date)
    records = (await db.execute(stmt)).scalars().all()
    count = len(records)
    for r in records:
        await db.delete(r)
    await db.commit()
    return count


async def parse_screen_time_screenshot(
    db: AsyncSession,
    user: User,
    image_base64: str,
) -> dict[str, Any]:
    """Use AI Vision model to parse an iOS/Android Screen Time screenshot into structured usage records."""
    from .ai_provider import call_chat_completion

    if not image_base64.startswith("data:image"):
        image_url = f"data:image/jpeg;base64,{image_base64}"
    else:
        image_url = image_base64

    prompt = (
        "这是一张手机系统的「屏幕使用时间」或应用时长统计截图。\n"
        "请仔细识别并提取出：\n"
        "1. 截图对应的日期（如果截图显示今天或未显示年份，请使用当天的 YYYY-MM-DD）；\n"
        "2. 出现的每个具体的应用名称（App Name）及其实际使用时长（请务必统一换算为整数总分钟数，如 1小时15分 -> 75）；\n"
        "3. 屏幕总使用时间（换算为分钟数）；\n"
        "4. 将每个 App 归入类别：work (生产力/工作/研发), social (社交/通讯), entertainment (娱乐/游戏/视频), reading (阅读/图书), general (其他系统工具)。\n\n"
        "请严格只返回 JSON 格式，不要返回任何额外 Markdown 或说明：\n"
        '{"log_date": "YYYY-MM-DD", "total_screen_minutes": 180, "app_usages": [{"name": "微信", "minutes": 65, "category": "social"}, {"name": "抖音", "minutes": 40, "category": "entertainment"}]}'
    )

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        }
    ]

    try:
        data, provider = await call_chat_completion(
            messages=messages,
            temperature=0.1,
            max_tokens=1500,
            user=user,
        )
        msg = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        clean_json = msg.strip()
        if "```json" in clean_json:
            clean_json = clean_json.split("```json", 1)[1].split("```", 1)[0].strip()
        elif "```" in clean_json:
            clean_json = clean_json.split("```", 1)[1].split("```", 1)[0].strip()

        parsed = json.loads(clean_json)
        target_date_str = parsed.get("log_date")
        target_date = date.fromisoformat(target_date_str) if target_date_str else date.today()
        raw_apps = parsed.get("app_usages") or []

        record = await record_daily_rhythm(
            db,
            user,
            log_date=target_date,
            app_usages=raw_apps,
        )
        return {
            "status": "ok",
            "log_date": record.log_date.isoformat(),
            "apps_count": len(record.app_usages or []),
            "total_screen_minutes": record.total_screen_minutes,
            "apps": record.app_usages,
        }
    except Exception as e:
        logger.warning("Failed to parse screen time screenshot: %s", e)
        raise RuntimeError(f"屏幕截图解析失败: {e}")

