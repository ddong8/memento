"""Persistence for /api/ask conversations: finding or creating them, appending
turns, inferring their runtime config, recovering orphaned device tasks.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import uuid
from datetime import datetime, timezone

from typing import Any

from sqlalchemy import select, func
from sqlalchemy.orm import defer
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, Machine, User, AskConversation, Project
from ..db.session import async_session_factory
from .storage_service import store_image_b64

logger = logging.getLogger("server.ask")

# What the user sends or saves: "" for model / effort is the CLI's own default, for project / session
# "none" (a new session): the user cleared them, so they are neither kept nor inferred back from earlier
# turns. For the other keys "" means "not given".
_EMPTY_IS_A_CHOICE = ("model", "effort", "project_id", "session_id")
# What a finished run reports: no session there means none came back (the device was offline, say),
# not that the user dropped it
_RUN_EMPTY_IS_A_CHOICE = ("model", "effort")

# The tool whose sessions an execution mode resumes
MODE_TOOL = {"claude": "claude_code", "codex": "codex", "antigravity": "antigravity", "workbuddy": "workbuddy"}


def _skip_config_value(k: str, v, choices: tuple[str, ...] = _EMPTY_IS_A_CHOICE) -> bool:
    return v is None or (v == "" and k not in choices)


async def get_or_create_conversation(
    conv_id_str: str | None,
    user: User,
    question: str,
    device_id: str | None,
    cwd: str | None,
    session_id: str | None = None,
    history: list[dict] | None = None,
    config: dict | None = None,
) -> tuple[uuid.UUID, str, dict]:
    """Retrieve existing conversation or create a new one."""
    async with async_session_factory() as session:
        if conv_id_str:
            try:
                cid = uuid.UUID(conv_id_str)
                conv = (await session.execute(
                    select(AskConversation)
                    .options(defer(AskConversation.turns))
                    .where(
                        (AskConversation.id == cid) &
                        ((AskConversation.user_id == user.id) | (AskConversation.user_id.is_(None)))
                    )
                )).scalars().first()
                if conv:
                    updated = False
                    cfg = dict(conv.config or {})
                    if config:
                        for k, v in config.items():
                            if not _skip_config_value(k, v):
                                if k == "execution_mode" and v == "ai" and cfg.get("execution_mode") and cfg.get("execution_mode") != "ai":
                                    continue
                                if k == "device_id" and v == "auto" and cfg.get("device_id") and cfg.get("device_id") not in ("auto", "ask_only", "all"):
                                    continue
                                if k == "compact_mode":
                                    continue
                                cfg[k] = v
                        cfg["compact_mode"] = False
                        conv.config = cfg
                        updated = True
                    elif "compact_mode" in cfg and cfg["compact_mode"]:
                        cfg["compact_mode"] = False
                        conv.config = cfg
                        updated = True

                    if device_id and conv.device_id != device_id:
                        if device_id != "auto" or not conv.device_id:
                            conv.device_id = device_id
                            updated = True
                    if cwd and conv.cwd != cwd:
                        conv.cwd = cwd
                        updated = True
                    if updated:
                        conv.updated_at = datetime.now(timezone.utc)
                        await session.commit()
                    return conv.id, conv.title, dict(conv.config or {})
            except Exception:
                pass

        # 尝试通过底层 session_id 复用已有 AskConversation，避免续接时重复新开会话。
        # 严格铁律：仅在明确传入了 conv_id_str（例如传入的是关联的 Document ID 或需重定向的特定实体）时，
        # 才尝试复用已有的 AskConversation；如果客户端未传入 conv_id_str，代表是明确的新建对话请求，
        # 必须创建全新的独立 AskConversation，严禁被历史旧会话反向劫持！
        if conv_id_str:
            effective_sess_id = session_id
            if not effective_sess_id:
                try:
                    doc_cid = uuid.UUID(conv_id_str)
                    doc_item = (await session.execute(
                        select(Document)
                        .options(
                            defer(Document.content),
                            defer(Document.content_tsv),
                            defer(Document.rendered_html),
                        )
                        .where(Document.id == doc_cid)
                    )).scalars().first()
                    if doc_item:
                        meta = doc_item.metadata_ or {}
                        effective_sess_id = meta.get("session_id") or meta.get("cascade_id")
                except Exception:
                    pass

            if effective_sess_id:
                try:
                    sess_conv = (await session.execute(
                        select(AskConversation)
                        .options(defer(AskConversation.turns))
                        .where(
                            (AskConversation.config.op("->>")("session_id") == effective_sess_id) &
                            ((AskConversation.user_id == user.id) | (AskConversation.user_id.is_(None)))
                        ).order_by(AskConversation.updated_at.desc().nulls_last()).limit(1)
                    )).scalars().first()

                    if not sess_conv:
                        # 备选深层匹配：遍历最近的会话，推导检查 session_id
                        recent_cands = (await session.execute(
                            select(AskConversation).where(
                                ((AskConversation.user_id == user.id) | (AskConversation.user_id.is_(None)))
                            ).order_by(AskConversation.updated_at.desc().nulls_last()).limit(50)
                        )).scalars().all()
                        for rc in recent_cands:
                            rc_cfg, rc_inf = infer_conversation_config(rc)
                            if rc_cfg.get("session_id") == effective_sess_id or rc_inf.get("session_id") == effective_sess_id:
                                sess_conv = rc
                                break

                    if sess_conv:
                        updated = False
                        cfg = dict(sess_conv.config or {})
                        if config:
                            for k, v in config.items():
                                if not _skip_config_value(k, v):
                                    if k == "execution_mode" and v == "ai" and cfg.get("execution_mode") and cfg.get("execution_mode") != "ai":
                                        continue
                                    if k == "device_id" and v == "auto" and cfg.get("device_id") and cfg.get("device_id") not in ("auto", "ask_only", "all"):
                                        continue
                                    if k == "compact_mode":
                                        continue
                                    cfg[k] = v
                        cfg["compact_mode"] = False
                        cfg["session_id"] = effective_sess_id
                        sess_conv.config = cfg
                        if device_id and sess_conv.device_id != device_id:
                            if device_id != "auto" or not sess_conv.device_id:
                                sess_conv.device_id = device_id
                                updated = True
                        if cwd and sess_conv.cwd != cwd:
                            sess_conv.cwd = cwd
                            updated = True
                        sess_conv.updated_at = datetime.now(timezone.utc)
                        await session.commit()
                        return sess_conv.id, sess_conv.title, dict(sess_conv.config or {})
                except Exception:
                    pass

        # Determine title
        from ..services.ingest_service import _is_junk_or_uuid_title
        title = None
        if session_id:
            try:
                doc_row = (await session.execute(
                    select(Document.title).where(
                        (Document.metadata_.op("->>")("session_id") == session_id)
                        | (Document.metadata_.op("->>")("cascade_id") == session_id)
                    ).limit(1)
                )).scalar_one_or_none()
                if not doc_row:
                    try:
                        doc_uuid = uuid.UUID(session_id)
                        doc_row = (await session.execute(
                            select(Document.title).where(Document.id == doc_uuid)
                        )).scalar_one_or_none()
                    except Exception:
                        pass
                if doc_row and doc_row.strip() and not _is_junk_or_uuid_title(doc_row.strip(), session_id):
                    title = doc_row.strip()
            except Exception:
                pass

        def _clean_smart_conversation_title(raw_text: str) -> str | None:
            if not raw_text:
                return None
            c = raw_text.strip()
            c = re.sub(r"^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*", "", c)
            c = re.sub(r"^【前文对话历史】[\s\S]*?【当前用户指令】\s*", "", c)
            if "进行图像分析与代码实现。" in c:
                c = c.split("进行图像分析与代码实现。", 1)[-1].strip()
            c = re.sub(r"【用户上传了图片[\s\S]*?】", "", c).strip()
            c = re.sub(r"【用户附加文件[\s\S]*?】", "", c).strip()
            c = re.sub(r"^(请问下|请问|请帮我|帮我看下|帮我查看|能不能帮我|麻烦帮我|你好[，, ]*|您好[，, ]*|请[，, ]*)", "", c).strip()
            c = " ".join(c.split())
            if c and not _is_junk_or_uuid_title(c, session_id):
                return c[:36]
            return None

        if not title and history:
            for h in history:
                if h.get("role") == "user" and h.get("content"):
                    t_cand = _clean_smart_conversation_title(h["content"])
                    if t_cand:
                        title = t_cand
                        break

        if not title and question:
            t_cand = _clean_smart_conversation_title(question)
            if t_cand:
                title = t_cand

        if not title:
            title = f"会话 {session_id[:8]}" if session_id else "新对话"

        # Prepopulate turns with existing history if provided
        init_turns = []
        if history:
            now_iso = datetime.now(timezone.utc).isoformat()
            init_turns = [
                {
                    "role": t.get("role", "user"),
                    "content": t.get("content", ""),
                    "toolCalls": t.get("tool_calls") or t.get("toolCalls") or [],
                    "thinking": t.get("thinking"),
                    "created_at": t.get("created_at") or now_iso,
                    **({"started_at": t["started_at"]} if t.get("started_at") else {}),
                    **({"duration_ms": t["duration_ms"]} if t.get("duration_ms") is not None else {}),
                }
                for t in history
                if t.get("content")
            ]
        elif session_id and conv_id_str:
            try:
                from ..db.models import ConversationMessage
                doc_target = (await session.execute(
                    select(Document)
                    .options(
                        defer(Document.content),
                        defer(Document.content_tsv),
                        defer(Document.rendered_html),
                    )
                    .where(
                        (Document.metadata_.op("->>")("session_id") == session_id)
                        | (Document.metadata_.op("->>")("cascade_id") == session_id)
                    ).limit(1)
                )).scalars().first()
                if doc_target:
                    if (not device_id or device_id == "auto") and doc_target.machine_id:
                        doc_mach = await session.get(Machine, doc_target.machine_id)
                        if doc_mach:
                            device_id = doc_mach.collector_token_hash or doc_mach.name
                    msg_rows = (await session.execute(
                        select(ConversationMessage.role, ConversationMessage.content, ConversationMessage.timestamp)
                        .where(ConversationMessage.document_id == doc_target.id)
                        .order_by(ConversationMessage.line_number.asc())
                    )).all()
                    for role, content, ts in msg_rows:
                        init_turns.append({
                            "role": role or "user",
                            "content": content or "",
                            "toolCalls": [],
                            "created_at": ts.isoformat() if ts else datetime.now(timezone.utc).isoformat(),
                        })
            except Exception:
                pass

        conv_cfg = dict(config or {})
        conv_cfg["compact_mode"] = False
        if session_id:
            conv_cfg["session_id"] = session_id
        if device_id and device_id != "auto":
            conv_cfg["device_id"] = device_id

        conv = AskConversation(
            id=uuid.uuid4(),
            user_id=user.id,
            title=title,
            turns=init_turns,
            message_count=len(init_turns),
            device_id=device_id,
            cwd=cwd,
            config=conv_cfg,
        )
        session.add(conv)
        await session.commit()
        await session.refresh(conv)
        return conv.id, conv.title, dict(conv.config or {})


def _compress_b64_image_safe(data_uri: str, max_size: int = 1600, quality: int = 82) -> str:
    """Safely compress base64 image if it exceeds threshold (>80KB).
    Returns compressed data URL (image/jpeg) or original if already small or invalid.
    """
    if not isinstance(data_uri, str) or not data_uri.startswith("data:image"):
        return data_uri

    if len(data_uri) < 80_000:
        return data_uri

    try:
        header, b64_part = data_uri.split(",", 1)
        raw_bytes = base64.b64decode(b64_part)
        from io import BytesIO
        from PIL import Image

        img = Image.open(BytesIO(raw_bytes))
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > max_size:
            ratio = max_size / max(w, h)
            new_w, new_h = int(w * ratio), int(h * ratio)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        out_io = BytesIO()
        img.save(out_io, format="JPEG", quality=quality, optimize=True)
        out_bytes = out_io.getvalue()
        if len(out_bytes) < len(raw_bytes):
            new_b64 = base64.b64encode(out_bytes).decode("ascii")
            return f"data:image/jpeg;base64,{new_b64}"
        return data_uri
    except Exception as e:
        logger.warning("Failed to compress base64 image: %s", e)
        return data_uri


async def append_conversation_turns(
    conv_id: uuid.UUID,
    user_content: str,
    assistant_content: str,
    sources: list[dict] | None = None,
    tool_calls: list[dict] | None = None,
    thinking: str | None = None,
    device_id: str | None = None,
    cwd: str | None = None,
    images: list[str] | None = None,
    attachments: list[dict] | None = None,
    config: dict | None = None,
    user_created_at: str | None = None,
    assistant_created_at: str | None = None,
    duration_ms: int | None = None,
):
    """Persist user and assistant turns into the conversation row."""
    try:
        async with async_session_factory() as session:
            conv = (await session.execute(
                select(AskConversation).where(AskConversation.id == conv_id)
            )).scalars().first()
            if not conv:
                return

            turns = list(conv.turns or [])
            now_iso = datetime.now(timezone.utc).isoformat()
            u_iso = user_created_at or now_iso
            a_iso = assistant_created_at or now_iso
            user_turn: dict = {
                "role": "user",
                "content": user_content,
                "created_at": u_iso,
            }
            if images:
                stored_images = []
                for img in images:
                    compressed = _compress_b64_image_safe(img)
                    stored = await store_image_b64(compressed)
                    stored_images.append(stored)
                user_turn["images"] = stored_images
            if attachments:
                user_turn["attachments"] = attachments
            turns.append(user_turn)
            asst_turn: dict = {
                "role": "assistant",
                "content": assistant_content,
                "created_at": a_iso,
                "started_at": u_iso,
            }
            if duration_ms is not None:
                asst_turn["duration_ms"] = duration_ms
            if thinking:
                asst_turn["thinking"] = thinking
            if sources:
                asst_turn["sources"] = sources
            if config:
                if config.get("model"):
                    asst_turn["model"] = str(config["model"])
                if config.get("execution_mode"):
                    asst_turn["execution_mode"] = str(config["execution_mode"])
                if config.get("effort"):
                    asst_turn["effort"] = str(config["effort"])
            inferred_tc_dev = None
            if tool_calls:
                clean_tool_calls = []
                for tc in tool_calls:
                    if isinstance(tc, dict):
                        tc_copy = dict(tc)
                        res_d = tc_copy.get("result") if isinstance(tc_copy.get("result"), dict) else {}
                        args_d = tc_copy.get("args") if isinstance(tc_copy.get("args"), dict) else {}
                        for d_cand in (res_d.get("device_id"), res_d.get("device_name"), tc_copy.get("device_name"), args_d.get("device_id")):
                            if d_cand and str(d_cand).strip() not in ("", "auto", "ask_only", "all"):
                                inferred_tc_dev = str(d_cand).strip()
                                break
                        args = tc_copy.get("args")
                        if isinstance(args, dict) and "images" in args:
                            clean_args = dict(args)
                            img_val = clean_args.get("images")
                            if isinstance(img_val, list):
                                clean_args["images"] = [f"<image attachment {i+1}>" for i in range(len(img_val))]
                            else:
                                del clean_args["images"]
                            tc_copy["args"] = clean_args
                        clean_tool_calls.append(tc_copy)
                    else:
                        clean_tool_calls.append(tc)
                    asst_turn["toolCalls"] = clean_tool_calls
            turns.append(asst_turn)

            conv.turns = turns
            conv.message_count = len(turns)
            flag_modified(conv, "turns")
            conv.updated_at = datetime.now(timezone.utc)
            effective_dev = device_id
            if (not effective_dev or effective_dev == "auto") and inferred_tc_dev:
                effective_dev = inferred_tc_dev
            if effective_dev and (effective_dev != "auto" or not conv.device_id):
                conv.device_id = effective_dev
            if cwd:
                conv.cwd = cwd
            if config or (effective_dev and effective_dev != "auto"):
                cfg = dict(conv.config or {})
                if config:
                    for k, v in config.items():
                        if not _skip_config_value(k, v, _RUN_EMPTY_IS_A_CHOICE):
                            if k == "execution_mode" and v == "ai" and cfg.get("execution_mode") and cfg.get("execution_mode") != "ai":
                                continue
                            if k == "device_id" and v == "auto" and cfg.get("device_id") and cfg.get("device_id") not in ("auto", "ask_only", "all"):
                                continue
                            cfg[k] = v
                if effective_dev and effective_dev != "auto":
                    cfg["device_id"] = effective_dev
                conv.config = cfg
            await session.commit()
            if conv.user_id:
                try:
                    from .cache import cache_delete_prefix
                    await cache_delete_prefix(f"ask_conv_list:{conv.user_id}")
                except Exception:
                    pass

            # Sync non-CLI AskConversation turns (ai, agent, shell, rag, or sessions without a local daemon JSONL file)
            # into Document + ConversationMessage so RAG retrieval, daily digest, and session reviews all include them.
            cfg_now = dict(conv.config or {})
            exec_mode_now = (cfg_now.get("execution_mode") or "ai").lower()
            has_cli_session = bool(cfg_now.get("session_id")) and exec_mode_now in ("claude", "codex", "antigravity", "workbuddy")
            if not has_cli_session and conv.user_id:
                try:
                    import hashlib
                    from ..db.models import ConversationMessage, Tool

                    tool_row = await session.get(Tool, "memento")
                    if not tool_row:
                        session.add(Tool(id="memento", display_name="Memento"))
                        await session.flush()

                    mach_id = None
                    if conv.device_id:
                        m = (await session.execute(
                            select(Machine.id).where(
                                (Machine.collector_token_hash == conv.device_id) | (Machine.name == conv.device_id)
                            ).limit(1)
                        )).scalar_one_or_none()
                        mach_id = m
                    if not mach_id:
                        mach_id = (await session.execute(
                            select(Machine.id).where(Machine.user_id == conv.user_id)
                            .order_by(Machine.last_heartbeat.desc().nulls_last()).limit(1)
                        )).scalar_one_or_none()

                    if mach_id:
                        rel_path = f"ask-conversations/{conv.id}.jsonl"
                        doc = (await session.execute(
                            select(Document).where(
                                Document.machine_id == mach_id,
                                Document.tool_id == "memento",
                                Document.relative_path == rel_path,
                            )
                        )).scalar_one_or_none()
                        full_text = "\n".join(
                            f"{t.get('role')}: {t.get('content', '')}" for t in turns if isinstance(t, dict)
                        )
                        content_hash = hashlib.sha256(full_text.encode("utf-8", errors="ignore")).hexdigest()
                        now_dt = datetime.now(timezone.utc)
                        if not doc:
                            doc = Document(
                                tool_id="memento",
                                machine_id=mach_id,
                                relative_path=rel_path,
                                category="conversation",
                                content_type="jsonl",
                                title=conv.title or "客户端对话",
                                content=full_text[:200000],
                                content_hash=content_hash,
                                file_size_bytes=len(full_text.encode("utf-8", errors="ignore")),
                                synced_at=now_dt,
                                source_modified_at=now_dt,
                            )
                            session.add(doc)
                            await session.flush()
                        else:
                            doc.title = conv.title or doc.title
                            doc.content = full_text[:200000]
                            doc.content_hash = content_hash
                            doc.file_size_bytes = len(full_text.encode("utf-8", errors="ignore"))
                            doc.synced_at = now_dt
                            doc.source_modified_at = now_dt

                        u_dt = datetime.fromisoformat(u_iso.replace("Z", "+00:00"))
                        a_dt = datetime.fromisoformat(a_iso.replace("Z", "+00:00"))
                        line_base = max(1, len(turns) - 1)
                        existing_lines = set((await session.execute(
                            select(ConversationMessage.line_number).where(
                                ConversationMessage.document_id == doc.id,
                                ConversationMessage.line_number.in_([line_base, line_base + 1]),
                            )
                        )).scalars().all())
                        if line_base not in existing_lines:
                            session.add(ConversationMessage(
                                document_id=doc.id,
                                line_number=line_base,
                                message_type="user",
                                role="user",
                                content=user_content,
                                timestamp=u_dt,
                            ))
                        if (line_base + 1) not in existing_lines:
                            tc_suffix = ""
                            if tool_calls:
                                tc_lines = [
                                    f"[Tool: {tc.get('name', 'tool')}]\n{json.dumps(tc.get('args') or {}, ensure_ascii=False)}"
                                    for tc in tool_calls if isinstance(tc, dict)
                                ]
                                if tc_lines:
                                    tc_suffix = "\n" + "\n".join(tc_lines)
                            session.add(ConversationMessage(
                                document_id=doc.id,
                                line_number=line_base + 1,
                                message_type="assistant",
                                role="assistant",
                                content=(assistant_content or "") + tc_suffix,
                                timestamp=a_dt,
                            ))
                        await session.commit()
                except Exception as sync_ex:
                    logger.debug("Non-CLI AskConversation mirror to Document skipped: %s", sync_ex)

            # Fast-path self-evolution: immediately trigger background correction and todo learning
            user_id_val = conv.user_id
            from ..services.correction_service import looks_like_pushback, learn_from_corrections
            from ..services.todo_service import looks_like_later, looks_like_close, learn_todos
            from ..services.notify_service import spawn

            need_corr = looks_like_pushback(user_content)
            need_todo = looks_like_later(user_content) or looks_like_close(user_content)
            if (need_corr or need_todo) and user_id_val:
                async def _bg_instant_learn():
                    try:
                        async with async_session_factory() as sdb:
                            u = await sdb.get(User, user_id_val)
                            if not u:
                                return
                            if need_corr:
                                await learn_from_corrections(sdb, u)
                            if need_todo:
                                await learn_todos(sdb, u)
                    except Exception as ex:
                        logger.debug("Background instant learning scan skipped: %s", ex)

                spawn(_bg_instant_learn())
    except Exception as e:
        logger.exception("Failed to persist conversation %s turns: %s", conv_id, e)


def infer_conversation_config(conv: AskConversation) -> tuple[dict, dict]:
    """Extract runtime config (execution_mode, model, effort, project_id, session_id, device_id, cwd)
    from historical turns if missing or defaulted to 'ai'."""
    cfg = dict(conv.config or {})
    existing_mode = cfg.get("execution_mode")
    mode_needed = not existing_mode or existing_mode == "ai"

    inferred: dict = {}
    for turn in reversed(conv.turns or []):
        tcs = turn.get("toolCalls") or turn.get("tool_calls") or []
        for tc in reversed(tcs):
            if not isinstance(tc, dict):
                continue

            raw_args = tc.get("args") or {}
            if isinstance(raw_args, str):
                try:
                    args = json.loads(raw_args)
                except Exception:
                    args = {}
            elif isinstance(raw_args, dict):
                args = raw_args
            else:
                args = {}

            call_dict = tc.get("call") or {}
            if isinstance(call_dict, str):
                try:
                    call_dict = json.loads(call_dict)
                except Exception:
                    call_dict = {}
            elif not isinstance(call_dict, dict):
                call_dict = {}

            res_dict = tc.get("result") or {}
            if isinstance(res_dict, str):
                try:
                    res_dict = json.loads(res_dict)
                except Exception:
                    res_dict = {}
            elif not isinstance(res_dict, dict):
                res_dict = {}

            binary = str(
                args.get("binary")
                or tc.get("binary")
                or call_dict.get("binary")
                or res_dict.get("binary")
                or ""
            ).lower().strip()

            action = str(
                res_dict.get("action")
                or args.get("action")
                or tc.get("action")
                or call_dict.get("action")
                or ("shell" if tc.get("name") == "run_on_device" and "command" in args else "")
                or ""
            ).lower().strip()

            name = str(tc.get("name") or call_dict.get("name") or "").lower().strip()
            cmd = str(args.get("command") or args.get("prompt") or tc.get("command") or call_dict.get("command") or "")

            detected_mode = None
            if "claude" in binary or name == "claude" or "[claude" in cmd.lower() or "[claude" in (tc.get("command") or "").lower():
                detected_mode = "claude"
            elif "codex" in binary or name == "codex" or "[codex" in cmd.lower() or "[codex" in (tc.get("command") or "").lower():
                detected_mode = "codex"
            elif "agy" in binary or "antigravity" in binary or name == "antigravity" or "[antigravity" in cmd.lower() or "[agy" in cmd.lower():
                detected_mode = "antigravity"
            elif "workbuddy" in binary or "codebuddy" in binary or name == "workbuddy" or "[workbuddy" in cmd.lower() or "[workbuddy" in (tc.get("command") or "").lower():
                detected_mode = "workbuddy"
            elif action == "shell" or binary in ("bash", "sh", "zsh") or "[shell" in cmd.lower():
                detected_mode = "shell"

            if detected_mode and ("execution_mode" not in inferred):
                inferred["execution_mode"] = detected_mode

            pid = args.get("project_id") or call_dict.get("project_id") or res_dict.get("project_id")
            if pid and "project_id" not in inferred:
                inferred["project_id"] = str(pid)

            sid = (
                res_dict.get("session_id")
                or args.get("session_id")
                or call_dict.get("session_id")
            )
            if sid and "session_id" not in inferred:
                inferred["session_id"] = str(sid)

            mod = args.get("model") or call_dict.get("model")
            if mod and "model" not in inferred:
                inferred["model"] = str(mod)

            eff = args.get("effort") or call_dict.get("effort")
            if eff and "effort" not in inferred:
                inferred["effort"] = str(eff)

            tc_cwd = args.get("cwd") or call_dict.get("cwd")
            if tc_cwd and "cwd" not in inferred:
                inferred["cwd"] = str(tc_cwd)

            for cand_dev in (
                res_dict.get("device_id"),
                res_dict.get("device_name"),
                tc.get("device_name"),
                args.get("device_id"),
                call_dict.get("device_name"),
            ):
                if cand_dev and str(cand_dev).strip() not in ("", "auto", "ask_only", "all"):
                    if "device_id" not in inferred:
                        inferred["device_id"] = str(cand_dev).strip()
                    break

            if detected_mode and inferred.get("session_id") and inferred.get("project_id") and inferred.get("device_id"):
                break
        if inferred.get("execution_mode") and inferred.get("session_id") and inferred.get("project_id") and inferred.get("device_id"):
            break

    if conv.device_id and conv.device_id not in ("auto", "ask_only", "all") and (not cfg.get("device_id") or cfg.get("device_id") == "auto"):
        cfg["device_id"] = conv.device_id

    if mode_needed and inferred.get("execution_mode"):
        cfg["execution_mode"] = inferred["execution_mode"]

    for k in ("project_id", "session_id", "model", "effort", "cwd", "device_id"):
        cur_val = cfg.get(k)
        # A saved "" model / effort is a choice (the CLI's own default): only fill these when never saved
        if k in _EMPTY_IS_A_CHOICE and cur_val is not None:
            continue
        if (not cur_val or (k == "device_id" and cur_val == "auto")) and inferred.get(k):
            cfg[k] = inferred[k]

    return cfg, inferred


async def resolve_concrete_device_for_conv(
    db: AsyncSession,
    conv: AskConversation,
    cfg: dict,
    inferred: dict,
) -> str | None:
    """Resolve the concrete execution device (collector_token_hash or name) for a conversation
    when device_id is missing, 'auto', or a display name rather than collector_token_hash."""
    candidate: str | None = None
    for raw_cand in (
        inferred.get("device_id"),
        conv.device_id,
        cfg.get("device_id"),
    ):
        s = str(raw_cand or "").strip()
        if s and s not in ("auto", "ask_only", "all"):
            candidate = s
            break

    # 1. If still no concrete device, check underlying session Document -> Machine
    sess_id = str(cfg.get("session_id") or "").strip()
    if not candidate and sess_id:
        try:
            doc_mid = (await db.execute(
                select(Document.machine_id).where(
                    Document.machine_id.is_not(None),
                    (Document.metadata_.op("->>")("session_id") == sess_id)
                    | (Document.metadata_.op("->>")("cascade_id") == sess_id),
                ).limit(1)
            )).scalar_one_or_none()
            if not doc_mid:
                try:
                    doc_uuid = uuid.UUID(sess_id)
                    doc_mid = (await db.execute(
                        select(Document.machine_id).where(Document.id == doc_uuid)
                    )).scalar_one_or_none()
                except Exception:
                    pass
            if doc_mid:
                mach = await db.get(Machine, doc_mid)
                if mach and mach.merged_into:
                    mach = await db.get(Machine, mach.merged_into) or mach
                if mach:
                    candidate = mach.collector_token_hash or mach.name
        except Exception:
            pass

    # 2. If still no concrete device, infer from cwd path signature
    cwd_val = str(conv.cwd or cfg.get("cwd") or inferred.get("cwd") or "").strip().lower()
    if not candidate and cwd_val:
        try:
            if "/users/haixingdong" in cwd_val:
                mach = (await db.execute(
                    select(Machine).where(
                        Machine.merged_into.is_(None),
                        Machine.name.ilike("%mac-mini%"),
                    ).order_by(Machine.last_heartbeat.desc().nulls_last()).limit(1)
                )).scalars().first()
                if mach:
                    candidate = mach.collector_token_hash or mach.name
            elif "/users/donghaixing" in cwd_val:
                mach = (await db.execute(
                    select(Machine).where(
                        Machine.merged_into.is_(None),
                        Machine.name.ilike("%macbook%"),
                    ).order_by(Machine.last_heartbeat.desc().nulls_last()).limit(1)
                )).scalars().first()
                if mach:
                    candidate = mach.collector_token_hash or mach.name
        except Exception:
            pass

    # 3. If still no concrete device, infer from project's most recent Document -> Machine
    proj_id_str = str(cfg.get("project_id") or "").strip()
    if not candidate and proj_id_str:
        try:
            pid = uuid.UUID(proj_id_str)
            doc_mid = (await db.execute(
                select(Document.machine_id).where(
                    Document.project_id == pid,
                    Document.machine_id.is_not(None),
                ).order_by(Document.synced_at.desc().nulls_last()).limit(1)
            )).scalar_one_or_none()
            if doc_mid:
                mach = await db.get(Machine, doc_mid)
                if mach and mach.merged_into:
                    mach = await db.get(Machine, mach.merged_into) or mach
                if mach:
                    candidate = mach.collector_token_hash or mach.name
        except Exception:
            pass

    if not candidate:
        return conv.device_id or cfg.get("device_id")

    # Normalize candidate (which might be a machine name like 'haixingdeMac-mini' or a merged machine's old hash) to active collector_token_hash
    try:
        clean_name = re.sub(
            r"\.local$",
            "",
            re.sub(r"\s*\([^)]*\)\s*$", "", candidate),
            flags=re.IGNORECASE,
        ).strip()
        mach = (await db.execute(
            select(Machine).where(
                (Machine.collector_token_hash == candidate)
                | (Machine.name == candidate)
                | (Machine.name == clean_name)
                | (func.lower(Machine.name) == clean_name.lower())
                | (Machine.name.ilike(f"{clean_name}.local%"))
                | (Machine.name.ilike(f"{clean_name} (%")),
            ).order_by(
                Machine.merged_into.is_(None).desc(),
                Machine.last_heartbeat.desc().nulls_last(),
            ).limit(1)
        )).scalars().first()
        if mach and mach.merged_into:
            mach = await db.get(Machine, mach.merged_into) or mach
        if mach and mach.collector_token_hash:
            return mach.collector_token_hash
    except Exception:
        pass

    return candidate


async def _live_machine(db: AsyncSession, machine: Machine | None) -> Machine | None:
    """The machine itself, or the one it was merged into."""
    if machine is not None and machine.merged_into:
        return await db.get(Machine, machine.merged_into) or machine
    return machine


async def _session_home(db: AsyncSession, user: User, session_id: str) -> tuple[str | None, Machine] | None:
    """The tool and the machine of a synced agent session (None: not synced yet, or not the user's)."""
    from .user_filter import user_machine_ids

    q = select(Document.tool_id, Document.machine_id).where(
        Document.machine_id.is_not(None),
        (Document.metadata_.op("->>")("session_id") == session_id)
        | (Document.metadata_.op("->>")("cascade_id") == session_id),
    )
    mids = await user_machine_ids(db, user)
    if mids is not None:
        q = q.where(Document.machine_id.in_(mids))
    row = (await db.execute(q.order_by(Document.updated_at.desc().nulls_last()).limit(1))).first()
    if row is None:
        return None
    machine = await _live_machine(db, await db.get(Machine, row[1]))
    return (row[0], machine) if machine is not None else None


async def reconcile_session(
    db: AsyncSession, user: User, exec_mode: str, device_id: str | None, session_id: str | None
) -> tuple[str | None, str | None]:
    """The session to resume and the device to run on, made to belong together.

    A session lives with one tool on one machine. The page sends what it shows, and a slow reply or a
    quick switch could leave it showing one conversation's session with another mode or device: resuming
    that fails (the device doesn't have it) or picks up unrelated work. Such a session isn't resumed;
    with no device picked ("auto") the run goes to the machine holding the session.
    """
    from .user_filter import find_machine_by_id_or_hash

    tool = MODE_TOOL.get(exec_mode)
    if not session_id or not tool:
        return session_id, device_id
    home = await _session_home(db, user, session_id)
    if home is None:
        return session_id, device_id
    session_tool, holder = home
    if session_tool in MODE_TOOL.values() and session_tool != tool:
        logger.warning("Not resuming %s session %s in %s mode", session_tool, session_id, exec_mode)
        return None, device_id
    if device_id and device_id not in ("auto", "ask_only", "all"):
        target = await _live_machine(db, await find_machine_by_id_or_hash(db, device_id, user))
        if target is not None and target.id != holder.id:
            logger.warning("Not resuming session %s on %s: it is on %s", session_id, target.name, holder.name)
            return None, device_id
        return session_id, device_id
    return session_id, holder.collector_token_hash or device_id


def _fix_iso_timestamp(val: Any) -> str | None:
    if not val:
        return None
    if isinstance(val, (int, float)):
        sec = val / 1000.0 if val >= 1e11 else float(val)
        return datetime.fromtimestamp(sec, tz=timezone.utc).isoformat()
    s = str(val).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.year < 2000:
            ts = dt.timestamp()
            if ts > 1_000_000:
                return datetime.fromtimestamp(ts * 1000.0, tz=timezone.utc).isoformat()
    except Exception:
        pass
    return s


def sanitize_turns_for_response(turns: list[dict], fallback_iso: str | None = None, start_index: int = 0) -> list[dict]:
    """Strip bloated duplicate inlined base64 images from tool_calls args, compress oversized user images, and ensure turn timestamps and absolute indices."""
    sanitized = []
    prev_user_ts: str | None = None
    fixed_fallback = _fix_iso_timestamp(fallback_iso)
    for i, t in enumerate(turns):
        t_copy = dict(t)
        t_copy["index"] = start_index + i
        if t_copy.get("created_at"):
            t_copy["created_at"] = _fix_iso_timestamp(t_copy.get("created_at"))
        elif fixed_fallback:
            t_copy["created_at"] = fixed_fallback
        if t_copy.get("started_at"):
            t_copy["started_at"] = _fix_iso_timestamp(t_copy.get("started_at"))
        role = t_copy.get("role")
        if role == "user":
            prev_user_ts = t_copy.get("created_at")
        elif role == "assistant":
            if not t_copy.get("started_at") and prev_user_ts and prev_user_ts != t_copy.get("created_at"):
                t_copy["started_at"] = prev_user_ts
            start_iso = t_copy.get("started_at")
            end_iso = t_copy.get("created_at")
            if start_iso and end_iso and t_copy.get("duration_ms") is None:
                try:
                    dt_s = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
                    dt_e = datetime.fromisoformat(str(end_iso).replace("Z", "+00:00"))
                    dur = int((dt_e - dt_s).total_seconds() * 1000)
                    if dur > 0:
                        t_copy["duration_ms"] = dur
                except Exception:
                    pass
        imgs = t_copy.get("images")
        if imgs and isinstance(imgs, list):
            t_copy["images"] = [_compress_b64_image_safe(img) for img in imgs]
        tcs = t_copy.get("toolCalls") or t_copy.get("tool_calls")
        if tcs and isinstance(tcs, list):
            clean_tcs = []
            for tc in tcs:
                if not isinstance(tc, dict):
                    clean_tcs.append(tc)
                    continue
                tc_copy = dict(tc)
                args = tc_copy.get("args")
                if isinstance(args, dict) and "images" in args:
                    clean_args = dict(args)
                    img_val = clean_args.get("images")
                    if isinstance(img_val, list):
                        clean_args["images"] = [f"<image attachment {i+1}>" for i in range(len(img_val))]
                    else:
                        del clean_args["images"]
                    tc_copy["args"] = clean_args

                # If this turn has assistant content, any hanging tool calls should be marked executed/succeeded
                if role == "assistant" and (t_copy.get("content") or "").strip():
                    cur_status = tc_copy.get("status")
                    res = tc_copy.get("result")
                    if not res or (isinstance(res, dict) and res.get("status") in ("running", "queued")):
                        res_status = "succeeded"
                        if isinstance(res, dict) and res.get("status") == "failed":
                            res_status = "failed"
                        tc_copy["status"] = "executed" if res_status == "succeeded" else "failed"
                        tc_copy["result"] = {
                            **(res if isinstance(res, dict) else {}),
                            "status": res_status,
                            "stdout": (res.get("stdout") if isinstance(res, dict) else None) or "任务执行完成",
                        }
                    elif cur_status in ("running", "queued"):
                        tc_copy["status"] = "executed"

                clean_tcs.append(tc_copy)
            t_copy["toolCalls"] = clean_tcs
        sanitized.append(t_copy)
    return sanitized


async def lookup_project_title(db: AsyncSession, project_id_val: str | None) -> str | None:
    if not project_id_val:
        return None
    try:
        pid = uuid.UUID(str(project_id_val))
        p_obj = (await db.execute(select(Project).where(Project.id == pid))).scalars().first()
        if p_obj:
            return p_obj.title or p_obj.slug
    except Exception:
        pass
    return None


async def recover_orphaned_tasks_for_conv(db: AsyncSession, conv: AskConversation, cfg: dict) -> list[dict] | None:
    """If deploy/api restarted while a DeviceTask was running, recover completed turns that were not persisted to conv.turns."""
    try:
        from ..db.models import DeviceTask
        from ..services.ask_runs import ask_runs

        conv_id_str = str(conv.id)
        active_run = await ask_runs.get(conv_id_str, conv.user_id) if conv.user_id else None
        if active_run and not active_run.done:
            return None

        raw_turns = list(conv.turns or [])
        recorded_task_ids: set[str] = set()
        last_turn_dt: datetime | None = None
        for t in raw_turns:
            ts_str = t.get("created_at")
            if ts_str:
                try:
                    dt = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
                    if dt.year >= 2000 and (last_turn_dt is None or dt > last_turn_dt):
                        last_turn_dt = dt
                except Exception:
                    pass
            for tc in (t.get("toolCalls") or t.get("tool_calls") or []):
                if isinstance(tc, dict):
                    res = tc.get("result")
                    if isinstance(res, dict) and res.get("task_id"):
                        recorded_task_ids.add(str(res["task_id"]))
                    if tc.get("task_id"):
                        recorded_task_ids.add(str(tc["task_id"]))

        sess_id = str(cfg.get("session_id") or "").strip()
        q = (
            select(DeviceTask)
            .where(
                DeviceTask.user_id == conv.user_id,
                DeviceTask.status.in_(["succeeded", "failed", "timeout"]),
            )
            .order_by(DeviceTask.created_at.desc())
            .limit(8)
        )
        recent_tasks = (await db.execute(q)).scalars().all()
        to_recover: list[DeviceTask] = []
        for dt_row in reversed(recent_tasks):
            tid = str(dt_row.id)
            if tid in recorded_task_ids:
                continue
            pl = dt_row.payload or {}
            pl_conv = str(pl.get("conversation_id") or "").strip()
            pl_sess = str(pl.get("session_id") or "").strip()
            matched = (pl_conv == conv_id_str) or (not pl_conv and sess_id and pl_sess == sess_id)
            if not matched:
                continue
            fin_dt = dt_row.finished_at or dt_row.created_at
            if last_turn_dt and fin_dt and fin_dt <= last_turn_dt:
                continue
            to_recover.append(dt_row)

        if not to_recover:
            return None

        for dt_row in to_recover:
            pl = dt_row.payload or {}
            user_q = str(pl.get("user_question") or "").strip()
            if not user_q:
                raw_prompt = str(pl.get("prompt") or "").strip()
                if "【当前用户指令】\n" in raw_prompt:
                    user_q = raw_prompt.split("【当前用户指令】\n", 1)[1].strip()
                elif "提示: 你可以使用视觉/文件查看工具" in raw_prompt:
                    parts = raw_prompt.split("进行图像分析与代码实现。")
                    user_q = parts[-1].strip() or raw_prompt
                else:
                    user_q = raw_prompt
            ans = (dt_row.stdout or "").strip() or (dt_row.stderr or "").strip() or (dt_row.error or "任务执行完成")
            start_dt = dt_row.dispatched_at or dt_row.created_at or datetime.now(timezone.utc)
            end_dt = dt_row.finished_at or datetime.now(timezone.utc)
            dur_ms = max(0, int((end_dt - start_dt).total_seconds() * 1000))
            call_id = f"direct_{str(dt_row.id).replace('-', '')[:8]}"
            clean_pl = {k: v for k, v in pl.items() if k != "images"}
            tc_entry = {
                "id": call_id,
                "tool_call_id": call_id,
                "name": "run_on_device",
                "device_name": dt_row.device_id or "auto",
                "args": clean_pl,
                "action": dt_row.action,
                "binary": pl.get("binary"),
                "status": "executed" if dt_row.status == "succeeded" else "failed",
                "result": {
                    "task_id": str(dt_row.id),
                    "status": dt_row.status,
                    "exit_code": dt_row.exit_code,
                    "stdout": dt_row.stdout,
                    "stderr": dt_row.stderr,
                    "error": dt_row.error,
                    "events": dt_row.events or [],
                },
            }
            raw_turns.append({
                "role": "user",
                "content": user_q,
                "created_at": start_dt.isoformat(),
            })
            raw_turns.append({
                "role": "assistant",
                "content": ans,
                "started_at": start_dt.isoformat(),
                "created_at": end_dt.isoformat(),
                "duration_ms": dur_ms,
                "toolCalls": [tc_entry],
                "model": pl.get("model") or None,
                "execution_mode": pl.get("execution_mode") or dt_row.action or None,
            })
        conv.turns = raw_turns
        conv.message_count = len(raw_turns)
        conv.updated_at = datetime.now(timezone.utc)
        await db.commit()
        return raw_turns
    except Exception as e:
        logger.warning("Failed to recover orphaned device tasks for conv %s: %s", conv.id, e)
        return None
