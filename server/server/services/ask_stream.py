"""Streaming for /api/ask: the direct-agent SSE stream and the response that
wraps a run's event stream.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..services.ask_runs import RunConflict, ask_runs
from .agent_limits import USAGE_LIMIT
from .ask_store import append_conversation_turns, record_stopped_orphans, store_images
from .device_reports import get_device_environment_summary

logger = logging.getLogger("server.ask")

_TRANSIENT_LINE_RE = re.compile(
    r"^(?:(?:⚡|⏳|✅|⏹\uFE0F?|❌|🈳)\s*\[(?:后台任务|模型思考|等待用户|工具|任务在后台)[^\]]*\]|\[STATUS_STILL_RUNNING:[^\]]*\])"
)

_STDERR_NOISE_PATTERNS = [
    # Node / npm
    r"^\s*npm\s+(?:warn|WARN|notice|NOTICE)\b.*",
    r"^\s*\(node:\d+\)\s+(?:\[\w+\]\s+)?(?:ExperimentalWarning|DeprecationWarning|Warning)\b.*",
    r"^\s*\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)",
    r"^\s*node:\s*--openssl-legacy-provider\b.*",
    r"^\s*Debugger attached\..*",
    r"^\s*Waiting for the debugger to disconnect\..*",
    r"^\s*Browserslist: caniuse-lite is outdated\..*",
    r"^\s*punycode module is deprecated\..*",
    # Python
    r"^.*?(?:UserWarning|DeprecationWarning|FutureWarning|SyntaxWarning|RuntimeWarning|PendingDeprecationWarning):\s+.*",
    r"^\s*warnings\.warn\(.*",
    r"^.*?/[\w\.\-]+/site-packages/[\w\.\-]+:\d+:\s*(?:UserWarning|DeprecationWarning|FutureWarning|RuntimeWarning).*",
    r"^\s*Python\(\d+,0x[0-9a-fA-F]+\)\s+malloc:\s+.*",
    # Git informational notices
    r"^\s*(?:To|From)\s+https?://.*",
    r"^\s*\*\s+\[(?:new branch|new tag|branch)\]\s+.*",
    r"^\s*Switched to a new branch\s+.*",
    r"^\s*Switched to branch\s+.*",
    r"^\s*Already on\s+.*",
]

_STDERR_NOISE_RE = re.compile("|".join(f"(?:{p})" for p in _STDERR_NOISE_PATTERNS), re.IGNORECASE)


def _clean_stderr_noise(stderr: str) -> str:
    """Filter out non-fatal noisy warnings (npm, Python warnings, Node deprecation) from stderr."""
    if not stderr:
        return ""
    meaningful_lines = []
    for line in stderr.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        if _STDERR_NOISE_RE.match(trimmed):
            continue
        meaningful_lines.append(line)
    return "\n".join(meaningful_lines).strip()


async def _coalesced_device_stream(db: AsyncSession, user: User, run_args: dict, delay: float = 0.020):
    """Wrap _tool_run_on_device with a 20ms sliding buffer (Chunk Coalescing) to merge micro task_chunk events."""
    from ..services.orchestrator import _tool_run_on_device

    queue: asyncio.Queue = asyncio.Queue()
    sentinel = object()

    async def _reader():
        try:
            async for event in _tool_run_on_device(db, user, run_args):
                await queue.put(event)
        except BaseException as exc:
            if not isinstance(exc, (asyncio.CancelledError, GeneratorExit)):
                try:
                    queue.put_nowait(exc)
                except Exception:
                    pass
            raise
        finally:
            try:
                queue.put_nowait(sentinel)
            except Exception:
                pass

    reader_task = asyncio.create_task(_reader())
    pending_chunk: dict | None = None

    try:
        while True:
            if pending_chunk is not None:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=delay)
                except (asyncio.TimeoutError, TimeoutError):
                    yield pending_chunk
                    pending_chunk = None
                    continue
            else:
                item = await queue.get()

            if item is sentinel:
                if pending_chunk is not None:
                    yield pending_chunk
                    pending_chunk = None
                break

            if isinstance(item, Exception):
                if pending_chunk is not None:
                    yield pending_chunk
                    pending_chunk = None
                raise item

            if item.get("type") == "task_chunk":
                if pending_chunk is not None:
                    if (
                        pending_chunk.get("stream") == item.get("stream")
                        and pending_chunk.get("task_id") == item.get("task_id")
                        and pending_chunk.get("device_name") == item.get("device_name")
                        and len(pending_chunk.get("text", "")) < 32768
                    ):
                        pending_chunk["text"] += item.get("text", "")
                        if item.get("seq") is not None:
                            pending_chunk["seq"] = item["seq"]
                    else:
                        yield pending_chunk
                        pending_chunk = dict(item)
                else:
                    pending_chunk = dict(item)
            else:
                if pending_chunk is not None:
                    yield pending_chunk
                    pending_chunk = None
                yield item
    finally:
        if not reader_task.done():
            reader_task.cancel()
            try:
                await reader_task
            except (asyncio.CancelledError, Exception):
                pass



def _clean_agent_summary(text: str) -> str:
    """Strip transient heartbeat and background task status tags from assistant stdout."""
    if not text:
        return ""
    lines = text.splitlines()
    substantive_start = -1
    for i, line in enumerate(lines):
        trimmed = line.strip()
        if not trimmed:
            continue
        is_transient = bool(_TRANSIENT_LINE_RE.match(trimmed))
        if not is_transient:
            substantive_start = i
            break

    if substantive_start != -1:
        cleaned = "\n".join(lines[substantive_start:]).strip()
        cleaned_lines = [l for l in cleaned.splitlines() if not l.strip().startswith("[STATUS_STILL_RUNNING:")]
        return "\n".join(cleaned_lines).strip()
    return text.strip()


async def _prepare_agent_args(
    db: AsyncSession,
    user: User,
    question: str,
    conv_id: uuid.UUID,
    conv_title: str,
    execution_mode: str,
    device_id: str | None,
    cwd: str | None,
    model: str | None,
    effort: str | None,
    session_id: str | None,
    project_id: str | None,
    fork: bool | None,
    compact_mode: bool | None,
    history: list[dict] | None,
    timeout_seconds: int | None,
    images: list[str] | None,
    attachments: list[dict] | None,
    worktree: bool,
) -> tuple[str, dict, str, str | None, str | None]:
    """The run_on_device args of a direct agent/shell ask: (action, args, command shown, session id
    the task resumes (None once compacted), session id the client asked for)."""
    from ..services.orchestrator import is_likely_long_running_task

    action = "shell" if execution_mode == "shell" else "agent"

    # Determine effective timeout: respect user choice; otherwise auto-expand for heavy migration/sync/build tasks
    effective_timeout = timeout_seconds
    if effective_timeout is None or effective_timeout < 0:
        if is_likely_long_running_task(question):
            effective_timeout = 14400  # 4 hours for migration/archive/build tasks
        else:
            effective_timeout = 7200 if action == "agent" else 60
    # Note: effective_timeout == 0 is explicitly preserved as unlimited!

    args = {
        "action": action,
        "device_id": device_id or "",
        "cwd": cwd or "",
        "timeout_seconds": effective_timeout,
        "conversation_id": str(conv_id),
        "user_question": question,
    }
    if model:
        args["model"] = model
    if effort:
        args["effort"] = effort
    if session_id:
        args["session_id"] = session_id
    if project_id:
        args["project_id"] = project_id
    if fork is not None:
        args["fork"] = fork
    if worktree and action == "agent":
        args["worktree"] = True
    if conv_title and action == "agent":
        # The device names the agent's session after the conversation, so it reads the same everywhere
        args["title"] = conv_title

    orig_session_id = session_id
    # Not chosen by the client: a Claude Code session past the heavy threshold resumes from a compacted
    # snapshot, whichever client asked (each raw step would carry its whole context, and after an idle
    # hour the first one re-caches all of it). An explicit False keeps the raw resume.
    if compact_mode is None and session_id and action == "agent" and execution_mode == "claude" and not fork:
        try:
            from ..services.session_compactor import claude_resume_cost
            from ..services.user_filter import user_machine_ids
            cost = await claude_resume_cost(db, session_id, await user_machine_ids(db, user))
            if cost.get("heavy"):
                compact_mode = True
                logger.info("Session %s carries %s tokens: resuming from a compacted snapshot", session_id, cost.get("context_tokens"))
        except Exception as e:
            logger.warning("Failed to size session %s for resume: %s", session_id, e)
    if compact_mode and session_id and action == "agent":
        try:
            from ..services.session_compactor import build_compacted_continuation
            from ..services.user_filter import user_machine_ids
            comp_res = await build_compacted_continuation(
                db, session_id, question, recent_turns=6, machine_ids=await user_machine_ids(db, user),
            )
            injected_ctx = comp_res.get("injected_context", "")
            if injected_ctx:
                args["compact_mode"] = True
                args["parent_session_id"] = session_id
                # Only in the prompt: it stays in the new session's history, and a copy in the system
                # prompt as well would send it twice
                args["prompt"] = f"{injected_ctx}\n\n当前用户指令：\n{question}"
                args.pop("session_id", None)
                session_id = None
        except Exception as e:
            logger.warning("Failed to perform compact continuation for session %s: %s", session_id, e)

    # Format attachments and images for agent prompt
    att_notes = []
    for a in (attachments or []):
        name = a.get("name") or "attachment"
        content = a.get("text_content")
        if content:
            ext = os.path.splitext(name)[1].lstrip(".") or ""
            att_notes.append(f"【用户附加文件: {name}】\n```{ext}\n{content}\n```")
        elif a.get("type") == "image":
            att_notes.append(f"【用户上传了截图/图片: {name}】")

    if images:
        args["images"] = images
        for idx, img in enumerate(images):
            if img.startswith("data:image/"):
                try:
                    header, b64data = img.split(",", 1)
                    mime = header.split(";")[0].split(":")[1] if ":" in header else "image/png"
                    ext = mime.split("/")[1] if "/" in mime else "png"
                    if ext == "jpeg":
                        ext = "jpg"
                    import tempfile
                    base_img_root = Path("/data2/memento/images") if Path("/data2").exists() else Path(tempfile.gettempdir()) / "memento_images"
                    img_dir = base_img_root / str(conv_id)
                    img_dir.mkdir(parents=True, exist_ok=True)
                    img_path = img_dir / f"image_{idx + 1}.{ext}"
                    img_path.write_bytes(base64.b64decode(b64data))
                    # 设备端 Daemon 统一落盘到 /tmp/memento_images/{conv_id}/image_N.ext（或通过软链指向 /data2 大盘）
                    # 因此提示给 Agent CLI 的本地查看路径统一为全平台兼容的 /tmp/memento_images 路径
                    agent_file_path = f"/tmp/memento_images/{conv_id}/image_{idx + 1}.{ext}"
                    att_notes.append(
                        f"【用户上传了图片 #{idx + 1}】\n"
                        f"本地文件路径: {agent_file_path}\n"
                        f"提示: 你可以使用视觉/文件查看工具（如 view_file）直接读取该文件进行图像分析与代码实现。"
                    )
                except Exception as e:
                    logger.warning("Failed to save image attachment to disk: %s", e)
                    att_notes.append(f"【用户上传了图片 #{idx + 1} (多模态图像数据)】")
            else:
                att_notes.append(f"【用户上传了图片 #{idx + 1}: {img}】")

    att_summary = "\n\n".join(att_notes)

    if action == "shell":
        args["command"] = question
        cmd_display = question
    else:
        binary_map = {
            "claude": "claude",
            "codex": "codex",
            "antigravity": "agy",
            "workbuddy": "workbuddy",
        }
        binary = binary_map.get(execution_mode, execution_mode)

        # Context injection for multi-turn conversations
        final_prompt = question
        if att_summary:
            final_prompt = f"{att_summary}\n\n{final_prompt}"

        if not orig_session_id and history and "prompt" not in args:
            prior_turns = []
            msgs = history[:-1] if (history and history[-1].get("role") == "user" and (history[-1].get("content") or "").strip() == question.strip()) else history
            for m in msgs:
                r = m.get("role")
                c = (m.get("content") or "").strip()
                if not c:
                    continue
                if len(c) > 800:
                    c = c[:750] + "\n...[输出过长已节略]..."
                role_label = "用户" if r == "user" else "助手"
                prior_turns.append(f"{role_label}: {c}")

            if prior_turns:
                ctx_summary = "\n\n".join(prior_turns[-6:])
                final_prompt = (
                    f"【前文对话历史】\n"
                    f"{ctx_summary}\n\n"
                    f"--------------------\n"
                    f"【当前用户指令】\n"
                    f"{question}"
                )

        if "prompt" not in args:
            args["prompt"] = final_prompt
        args["binary"] = binary

        env_summary = get_device_environment_summary(device_id, user)
        if env_summary and not orig_session_id:
            curr_spa = args.get("system_prompt_append") or ""
            args["system_prompt_append"] = f"{curr_spa}\n\n【目标设备就绪环境指纹画像】\n{env_summary}".strip()
        if orig_session_id:
            tag = "compact" if compact_mode else ("fork" if fork else "resume")
            resume_tag = f" [{tag}:{orig_session_id[:8]}]"
        else:
            resume_tag = ""
        model_tag = f" ({model})" if model else ""
        effort_tag = f" [{effort}]" if effort else ""
        cmd_display = f"[{execution_mode.upper()}{model_tag}{effort_tag}]{resume_tag} {question}"

    return action, args, cmd_display, session_id, orig_session_id


def _without_images(args: dict) -> dict:
    """Args as saved: image data replaced by placeholders."""
    if "images" not in args:
        return args
    clean = dict(args)
    img_val = clean.get("images")
    if isinstance(img_val, list):
        clean["images"] = [f"<image attachment {i+1}>" for i in range(len(img_val))]
    else:
        del clean["images"]
    return clean


# The session to resume isn't on the device (any more)
_SESSION_GONE = ("No conversation found", "session not found", "conversation not found", "could not find session", "no rollout found")


def _next_session(result: dict | None, session_id: str | None, orig_session_id: str | None) -> str | None:
    """The session the conversation goes on in after a run: the one the device reports it ran, also when
    the run failed (a resume that found nothing starts a new session, and its work is in that one); ""
    when the session to resume is gone and nothing replaced it; None to keep what the conversation has."""
    res = result or {}
    asked = {str(s) for s in (session_id, orig_session_id) if s}
    reported = str(res.get("session_id") or "")
    errors = f"{res.get('error') or ''}\n{res.get('stderr') or ''}"
    gone = bool(asked) and any(s in errors for s in _SESSION_GONE)
    if reported and not (gone and reported in asked):
        return reported
    if gone:
        return ""
    if res.get("status") == "failed":
        return None
    return str(session_id or orig_session_id or "") or None


async def _append_turns_or_slim(**kw) -> None:
    """Save the turn; failing that, again without the step log and with the output cut down, so the
    answer stays in the conversation (lost whole, the question showed no reply after a refresh)."""
    if await append_conversation_turns(**kw):
        return
    logger.warning("Saving the turn of %s failed, retrying it slimmed", kw.get("conv_id"))
    kw["tool_calls"] = [_slim_call(c) for c in kw.get("tool_calls") or []]
    await append_conversation_turns(**kw)


def _slim_call(call: dict) -> dict:
    res = call.get("result")
    if not isinstance(res, dict):
        return call
    res = {k: v for k, v in res.items() if k != "events"}
    for k in ("stdout", "stderr"):
        if isinstance(res.get(k), str) and len(res[k]) > _SLIM_OUTPUT_CHARS:
            res[k] = res[k][-_SLIM_OUTPUT_CHARS:]
    return {**call, "result": res}


_SLIM_OUTPUT_CHARS = 20_000


async def direct_agent_stream(
    db: AsyncSession,
    user: User,
    question: str,
    conv_id: uuid.UUID,
    conv_title: str,
    execution_mode: str,
    device_id: str | None,
    cwd: str | None,
    model: str | None = None,
    effort: str | None = None,
    session_id: str | None = None,
    project_id: str | None = None,
    fork: bool | None = None,
    compact_mode: bool | None = None,
    history: list[dict] | None = None,
    timeout_seconds: int | None = None,
    images: list[str] | None = None,
    attachments: list[dict] | None = None,
    worktree: bool = False,
    checkpoint: dict | None = None,
    resume: bool = False,
):
    """Directly dispatch an agent/shell task to the user's online device without LLM intermediate step.

    checkpoint is filled in as the run goes (the call, the task on the device, thinking so far).
    When this replica shuts down mid-task, another one continues the run from it with resume=True
    (ask_runs.drain): it follows the task already on the device and saves the turn when it ends."""
    from ..services.orchestrator import _tool_run_on_device

    ckpt = checkpoint if checkpoint is not None else {}
    if resume:
        user_created_at = ckpt["user_created_at"]
        req_start_mono = time.monotonic() - max(0.0, time.time() - float(ckpt.get("started_at") or time.time()))
        action = ckpt["action"]
        session_id = ckpt.get("session_id")
        orig_session_id = ckpt.get("orig_session_id")
        call_id = ckpt["call_id"]
        tool_call_item = ckpt["call"]
        run_args = {"attach_task_id": ckpt["task_id"]}
    else:
        user_created_at = datetime.now(timezone.utc).isoformat()
        req_start_mono = time.monotonic()

        yield f"data: {json.dumps({'type': 'conversation_id', 'id': str(conv_id), 'title': conv_title, 'user_created_at': user_created_at}, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'type': 'sources', 'sources': []}, ensure_ascii=False)}\n\n"

        orphans = []
        if execution_mode != "shell":
            from ..services.orchestrator import stop_orphaned_agent_tasks
            try:
                orphans = await stop_orphaned_agent_tasks(db, user, str(conv_id))
                await record_stopped_orphans(db, conv_id, orphans)
            except Exception as e:  # never in the way of the question itself
                logger.warning("Could not stop orphaned agent tasks of %s: %s", conv_id, e)
                await db.rollback()
            # Its result never came back, so this question still asks for the session it set out from;
            # it goes on in the one the stopped task ran in instead (a new one, when it started without)
            for old in orphans:
                if (not fork and not compact_mode and old.session_id
                        and str((old.payload or {}).get("session_id") or "") == (session_id or "")):
                    session_id = old.session_id

        action, run_args, cmd_display, session_id, orig_session_id = await _prepare_agent_args(
            db, user, question, conv_id, conv_title, execution_mode, device_id, cwd, model, effort, session_id,
            project_id, fork, compact_mode, history, timeout_seconds, images, attachments, worktree,
        )
        call_id = f"direct_{uuid.uuid4().hex[:8]}"
        tool_call_item = {
            "id": call_id,
            "tool_call_id": call_id,
            "name": "run_on_device",
            "device_name": device_id or "auto",
            "args": run_args,
            "command": cmd_display,
            "action": action,
            "binary": run_args.get("binary"),
            "status": "running",
        }
        yield f"data: {json.dumps({'type': 'tool_call', 'id': call_id, 'tool_call_id': call_id, 'name': 'run_on_device', 'args': run_args, 'device_name': device_id or 'auto', 'call': tool_call_item}, ensure_ascii=False)}\n\n"
        ckpt.update(
            user_created_at=user_created_at,
            started_at=time.time(),
            action=action,
            session_id=session_id,
            orig_session_id=orig_session_id,
            call_id=call_id,
            call={**tool_call_item, "args": _without_images(run_args)},
        )
        for old in orphans:
            asked = str((old.payload or {}).get("user_question") or "").strip().replace("\n", " ")
            asked = f"「{asked[:40]}{'…' if len(asked) > 40 else ''}」" if asked else ""
            began = old.dispatched_at or old.created_at
            mins = int((datetime.now(timezone.utc) - began).total_seconds() // 60) if began else None
            since = "" if mins is None else ("（刚开始）" if mins < 1 else f"（{mins} 分钟前开始）")
            its_session = old.session_id or str((old.payload or {}).get("session_id") or "")
            then = ("这次在它的会话里接着执行，它做到的部分智能体都能看到" if its_session and its_session in (session_id, orig_session_id)
                    else "这次重新执行")
            note = f"\n⚡ [接替] 上一次的提问{asked}{since}还在设备上运行，但没有回答在跟进；已先停掉它，{then}。\n\n"
            yield f"data: {json.dumps({'type': 'task_chunk', 'task_id': None, 'tool_call_id': call_id, 'device_name': old.device_id, 'stream': 'stdout', 'text': note}, ensure_ascii=False)}\n\n"

    result_dict = None
    summary_text = ""
    accumulated_thinking: list[str] = ckpt.setdefault("thinking", [])
    saved = False
    stopped: str | None = None  # "cancelled" by the user, or "interrupted" with the device task left going
    stream_error: str | None = None
    assistant_created_at_final: str | None = None
    duration_ms_final: int | None = None

    async def _persist():
        nonlocal saved, summary_text, assistant_created_at_final, duration_ms_final
        if saved:
            return
        if ckpt.get("moving") and not result_dict:
            return  # handed over: the replica taking the run saves the turn when the task ends
        if stopped == "interrupted" and ckpt.get("task_id") and not result_dict:
            # Shut down with nowhere to hand it over: the device task goes on, and when it reports
            # the whole turn is saved from it (ask_store.recover_orphaned_tasks_for_conv). Saving a
            # placeholder here left the question in the conversation twice.
            return
        saved = True
        assistant_created_at_final = datetime.now(timezone.utc).isoformat()
        duration_ms_final = int((time.monotonic() - req_start_mono) * 1000)
        tool_calls_to_save = []
        if tool_call_item:
            saved_call = dict(tool_call_item)
            if result_dict:
                saved_call["result"] = result_dict
                saved_call["status"] = result_dict.get("status", "executed")
            elif stopped == "cancelled":
                # Stopped by the user: say so, not "done" (the device task was cancelled with it)
                summary_text = summary_text or "⏹ 已停止"
                saved_call["status"] = "failed"
                saved_call["result"] = {"task_id": ckpt.get("task_id"), "status": "cancelled", "error": "已手动停止"}
            elif stopped == "interrupted":
                # Cut short before its task reached the device
                summary_text = summary_text or "⚠️ 服务更新中断了这次回答，任务还没发到设备上，请重新发送。"
                saved_call["status"] = "failed"
                saved_call["result"] = {"status": "interrupted", "error": summary_text}
            elif stream_error:
                summary_text = summary_text or f"❌ {stream_error}"
                saved_call["status"] = "failed"
                saved_call["result"] = {"task_id": ckpt.get("task_id"), "status": "failed", "error": stream_error}
            else:
                saved_call["status"] = "executed"
                saved_call["result"] = {
                    "status": "succeeded",
                    "stdout": summary_text or "任务执行完成",
                    "exit_code": 0,
                }
            if isinstance(saved_call.get("args"), dict):
                saved_call["args"] = _without_images(saved_call["args"])
            tool_calls_to_save.append(saved_call)

        next_session = _next_session(result_dict, session_id, orig_session_id)

        persisted_dev_id = (
            (result_dict.get("device_id") or result_dict.get("device_name"))
            if (result_dict and (not device_id or device_id == "auto"))
            else device_id
        )

        persisted_thinking = "".join(accumulated_thinking).strip() or None

        await _append_turns_or_slim(
            conv_id=conv_id,
            user_content=question,
            assistant_content=summary_text or "任务执行完成",
            sources=None,
            tool_calls=tool_calls_to_save,
            thinking=persisted_thinking,
            device_id=persisted_dev_id,
            cwd=cwd,
            images=images,
            attachments=attachments,
            config={
                "execution_mode": execution_mode,
                "model": model or "",
                "effort": effort or "",
                "project_id": project_id or "",
                "session_id": next_session or "",
                "device_id": persisted_dev_id or "",
                "worktree": bool(worktree),
                "compact_mode": False,  # 瘦身完成后复位，后续在当前对话中默认以正常会话无缝续接
            },
            user_created_at=user_created_at,
            assistant_created_at=assistant_created_at_final,
            duration_ms=duration_ms_final,
            forget_session=next_session == "",
        )

    try:
        try:
            async for evt in _coalesced_device_stream(db, user, run_args, delay=0.020):
                etype = evt.get("type")
                if etype == "task_chunk":
                    stream_name = evt.get("stream", "stdout")
                    text = evt.get("text", "")
                    yield f"data: {json.dumps({'type': 'task_chunk', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'device_name': evt.get('device_name'), 'stream': stream_name, 'text': text}, ensure_ascii=False)}\n\n"
                elif etype == "task_progress":
                    if evt.get("task_id"):
                        ckpt["task_id"] = str(evt["task_id"])  # on the device from here on: a resume follows it
                    yield f"data: {json.dumps({'type': 'task_progress', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'device_name': evt.get('device_name'), 'device_id': evt.get('device_id'), 'status': evt.get('status')}, ensure_ascii=False)}\n\n"
                elif etype == "task_alert":
                    yield f"data: {json.dumps({'type': 'task_alert', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'device_name': evt.get('device_name'), 'alert': evt.get('alert')}, ensure_ascii=False)}\n\n"
                elif etype == "task_event":
                    ev = evt.get("event") or {}
                    if ev.get("kind") == "thinking" and ev.get("text"):
                        thinking_chunk = ev.get("text")
                        accumulated_thinking.append(thinking_chunk)
                        yield f"data: {json.dumps({'type': 'thinking', 'text': thinking_chunk}, ensure_ascii=False)}\n\n"
                    yield f"data: {json.dumps({'type': 'task_event', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'event': evt.get('event')}, ensure_ascii=False)}\n\n"
                elif etype == "tool_result":
                    result_dict = evt.get("result") or {}
                    ckpt["result"] = True
                    if result_dict.get("device_name"):
                        tool_call_item["device_name"] = result_dict["device_name"]
                    if action == "agent" and _next_session(result_dict, session_id, orig_session_id) == "":
                        # The session is gone from the device and nothing replaced it: the client drops it too
                        result_dict["session_reset"] = True
                    yield f"data: {json.dumps({'type': 'tool_result', 'task_id': result_dict.get('task_id'), 'tool_call_id': call_id, 'result': result_dict}, ensure_ascii=False)}\n\n"
                elif etype == "ping":
                    yield "data: {\"type\": \"ping\"}\n\n"
        except (asyncio.CancelledError, GeneratorExit):
            stopped = "interrupted" if ask_runs.keeps_device_tasks(ckpt.get("task_id")) else "cancelled"
            raise
        except Exception as e:
            logger.exception("Error in direct agent stream: %s", e)
            stream_error = str(e) or type(e).__name__
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

        # Summary delta message
        if result_dict:
            status = result_dict.get("status", "completed")
            exit_code = result_dict.get("exit_code")
            stdout = (result_dict.get("stdout") or "").strip()
            stderr_raw = (result_dict.get("stderr") or "").strip()
            stderr = _clean_stderr_noise(stderr_raw)
            err_msg = result_dict.get("error") or stderr or (f"退出码 {exit_code}" if exit_code not in (None, 0) else "") or "任务异常结束"

            is_only_tool_calls = False
            if action == "agent" and stdout:
                non_empty_lines = [line.strip() for line in stdout.splitlines() if line.strip()]
                if non_empty_lines and all(l.startswith(("[Tool:", "⚡ [", "[Tool ")) for l in non_empty_lines):
                    is_only_tool_calls = True

            if result_dict.get("error_type") == USAGE_LIMIT:
                tool_name = {"claude": "Claude Code", "codex": "Codex", "antigravity": "Antigravity", "workbuddy": "WorkBuddy"}.get(execution_mode, execution_mode)
                note = f"⛔ {tool_name} 的额度已用完（{err_msg}），这一步没做完。额度恢复后发送“继续”接着做。"
                # Claude Code also gives the message as its answer
                before = _clean_agent_summary(stdout.replace(str(err_msg), "")).strip() if stdout else ""
                summary_text = f"{before}\n\n> {note}" if before else note
            elif status == "failed":
                if action == "agent" and stdout:
                    summary_text = f"{_clean_agent_summary(stdout)}\n\n> ❌ *[任务执行遇到错误: {err_msg}]*"
                else:
                    summary_text = f"❌ {err_msg}"
            elif status == "timeout" or exit_code == 124:
                if stdout:
                    summary_text = f"{_clean_agent_summary(stdout)}\n\n> ⚠️ *[任务执行耗时较长触发安全保护中断，已记录上述排查过程。请发送“继续”以获取完整结论]*"
                else:
                    summary_text = f"⚠️ 任务执行超时（{err_msg[:100]}）。您可以发送“继续”继续获取结果。"
            elif status == "still_running":
                if stdout:
                    summary_text = f"{_clean_agent_summary(stdout)}\n\n> ⏳ *[智能体结束时还有它启动的后台任务没有跑完]*"
                else:
                    summary_text = "⏳ 智能体结束时还有它启动的后台任务没有跑完。"
            elif action == "agent" and stdout:
                if is_only_tool_calls:
                    summary_text = f"{stdout}\n\n> 💡 *[阶段工具排查已完成，正在生成结论。如未显示完整回复，请发送“继续”]*"
                else:
                    summary_text = _clean_agent_summary(stdout)
            elif status == "succeeded" or exit_code == 0:
                if not stdout:
                    if stderr and any(s in stderr for s in ["No conversation found", "session not found", "conversation not found", "could not find session"]):
                        summary_text = f"⚠️ 历史会话未在设备上找到或已过期（{stderr.strip()[:120]}）。已自动为您重置会话，请重新提问。"
                    elif stderr:
                        summary_text = f"⚠️ 任务执行完成但无输出（{stderr.strip()[:120]}）。"
                    else:
                        summary_text = f"✅ {execution_mode.capitalize()} 任务在设备上执行完毕。"
                else:
                    if action == "shell":
                        summary_text = f"```\n{stdout}\n```"
                    elif is_only_tool_calls:
                        summary_text = f"{stdout}\n\n> 💡 *[阶段工具排查已完成，正在生成结论。如未显示完整回复，请发送“继续”]*"
                    else:
                        cleaned = _clean_agent_summary(stdout)
                        summary_text = cleaned if cleaned.strip() else f"✅ {execution_mode.capitalize()} 任务在设备上执行完毕。"
            else:
                summary_text = f"⚠️ 任务执行完成（{err_msg[:100]}）。"
        elif stream_error:
            summary_text = f"❌ {stream_error}"
        else:
            summary_text = "任务执行结束。"

        yield f"data: {json.dumps({'type': 'delta', 'text': summary_text}, ensure_ascii=False)}\n\n"
    finally:
        await _persist()

    # done only after the turn is saved: it carries the saved timestamps, and the client refreshes the history list on it.
    yield f"data: {json.dumps({'type': 'done', 'assistant_created_at': assistant_created_at_final, 'duration_ms': duration_ms_final})}\n\n"
    await asyncio.sleep(0.05)


SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


async def run_response(
    conv_id,
    user: User,
    question: str,
    request_id: str | None,
    factory,
    *,
    execution_mode: str | None = None,
    model: str | None = None,
    device_name: str | None = None,
    title: str | None = None,
    images: list[str] | None = None,
    request_db: AsyncSession | None = None,
    resume: dict | None = None,
) -> StreamingResponse:
    """Start the ask as a background run and stream it. The run survives the
    client disconnecting; see services/ask_runs.py.

    request_db is the request's own session: the run uses its own, so this one's transaction
    ends here instead of staying open for the whole stream (the database cuts it after 60 s).

    resume ({"kind", "kwargs", "checkpoint"}) lets another replica continue the run when this
    one shuts down; kind names an entry in ask_runs.resumers."""
    if request_db is not None:
        await request_db.commit()
    if images:
        # The run's summary goes out with every /run and /runs poll and every mirror write:
        # links to the stored images, not the pasted base64 (a photo was 200 KB+ each time).
        # The answer itself still gets the originals through the factory.
        try:
            images = await asyncio.wait_for(store_images(images), timeout=5)
        except asyncio.TimeoutError:
            logger.warning("storing the images of an ask timed out, the run keeps them inline")
    try:
        run = await ask_runs.start(
            str(conv_id),
            user.id,
            question,
            factory,
            request_id=request_id,
            execution_mode=execution_mode,
            model=model,
            device_name=device_name,
            title=title,
            images=images,
            resume=resume,
        )
    except RunConflict:
        raise HTTPException(status_code=409, detail="这个对话还有任务在运行，请等它结束或先停止")
    return StreamingResponse(run.stream(0), media_type="text/event-stream", headers=SSE_HEADERS)


def _resume_direct_agent(kwargs: dict, ckpt: dict):
    return lambda db, user: direct_agent_stream(
        db, user, **{**kwargs, "conv_id": uuid.UUID(kwargs["conv_id"])}, checkpoint=ckpt, resume=True
    )


ask_runs.resumers["direct_agent"] = _resume_direct_agent
