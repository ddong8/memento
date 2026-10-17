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
from .ask_store import append_conversation_turns
from .device_reports import get_device_environment_summary

logger = logging.getLogger("server.ask")

_TRANSIENT_LINE_RE = re.compile(
    r"^(?:(?:⚡|⏳|✅|⏹\uFE0F?|❌|🈳)\s*\[(?:后台任务|模型思考|等待用户|工具|任务在后台)[^\]]*\]|\[STATUS_STILL_RUNNING:[^\]]*\])"
)


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
):
    """Directly dispatch an agent/shell task to the user's online device without LLM intermediate step."""
    from ..services.orchestrator import _tool_run_on_device, is_likely_long_running_task

    user_created_at = datetime.now(timezone.utc).isoformat()
    req_start_mono = time.monotonic()

    yield f"data: {json.dumps({'type': 'conversation_id', 'id': str(conv_id), 'title': conv_title, 'user_created_at': user_created_at}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type': 'sources', 'sources': []}, ensure_ascii=False)}\n\n"

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

    orig_session_id = session_id
    if compact_mode and session_id and action == "agent":
        try:
            from ..services.session_compactor import build_compacted_continuation
            comp_res = await build_compacted_continuation(db, session_id, question, recent_turns=6)
            injected_ctx = comp_res.get("injected_context", "")
            if injected_ctx:
                args["compact_mode"] = True
                args["parent_session_id"] = session_id
                args["system_prompt_append"] = injected_ctx
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
                    img_dir = Path("/tmp/memento_images") / str(conv_id)
                    img_dir.mkdir(parents=True, exist_ok=True)
                    img_path = img_dir / f"image_{idx + 1}.{ext}"
                    img_path.write_bytes(base64.b64decode(b64data))
                    att_notes.append(
                        f"【用户上传了图片 #{idx + 1}】\n"
                        f"本地文件路径: {img_path.as_posix()}\n"
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

    call_id = f"direct_{uuid.uuid4().hex[:8]}"
    tool_call_item = {
        "id": call_id,
        "tool_call_id": call_id,
        "name": "run_on_device",
        "device_name": device_id or "auto",
        "args": args,
        "command": cmd_display,
        "action": action,
        "binary": args.get("binary"),
        "status": "running",
    }
    yield f"data: {json.dumps({'type': 'tool_call', 'id': call_id, 'tool_call_id': call_id, 'name': 'run_on_device', 'args': args, 'device_name': device_id or 'auto', 'call': tool_call_item}, ensure_ascii=False)}\n\n"

    result_dict = None
    summary_text = ""
    accumulated_thinking: list[str] = []
    saved = False
    assistant_created_at_final: str | None = None
    duration_ms_final: int | None = None

    async def _persist():
        nonlocal saved, assistant_created_at_final, duration_ms_final
        if saved:
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
            else:
                saved_call["status"] = "executed"
                saved_call["result"] = {
                    "status": "succeeded",
                    "stdout": summary_text or "任务执行完成",
                    "exit_code": 0,
                }
            if isinstance(saved_call.get("args"), dict) and "images" in saved_call["args"]:
                clean_args = dict(saved_call["args"])
                img_val = clean_args.get("images")
                if isinstance(img_val, list):
                    clean_args["images"] = [f"<image attachment {i+1}>" for i in range(len(img_val))]
                else:
                    del clean_args["images"]
                saved_call["args"] = clean_args
            tool_calls_to_save.append(saved_call)

        persisted_session_id = ""
        res_status = (result_dict or {}).get("status")
        res_err = str((result_dict or {}).get("error") or (result_dict or {}).get("stderr") or "")
        session_dead = res_status == "failed" or any(s in res_err for s in [
            "No conversation found", "session not found", "conversation not found", "could not find session", "no rollout found"
        ])
        if not session_dead:
            if result_dict and result_dict.get("session_id"):
                persisted_session_id = str(result_dict.get("session_id"))
            elif session_id:
                persisted_session_id = str(session_id)
            elif orig_session_id:
                persisted_session_id = str(orig_session_id)

        persisted_dev_id = (
            (result_dict.get("device_id") or result_dict.get("device_name"))
            if (result_dict and (not device_id or device_id == "auto"))
            else device_id
        )

        persisted_thinking = "".join(accumulated_thinking).strip() or None

        await append_conversation_turns(
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
                "session_id": persisted_session_id,
                "device_id": persisted_dev_id or "",
                "worktree": bool(worktree),
                "compact_mode": False,  # 瘦身完成后复位，后续在当前对话中默认以正常会话无缝续接
            },
            user_created_at=user_created_at,
            assistant_created_at=assistant_created_at_final,
            duration_ms=duration_ms_final,
        )

    try:
        try:
            async for evt in _tool_run_on_device(db, user, args):
                etype = evt.get("type")
                if etype == "task_chunk":
                    stream_name = evt.get("stream", "stdout")
                    text = evt.get("text", "")
                    yield f"data: {json.dumps({'type': 'task_chunk', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'device_name': evt.get('device_name'), 'stream': stream_name, 'text': text}, ensure_ascii=False)}\n\n"
                elif etype == "task_progress":
                    yield f"data: {json.dumps({'type': 'task_progress', 'task_id': evt.get('task_id'), 'tool_call_id': call_id, 'device_name': evt.get('device_name'), 'status': evt.get('status')}, ensure_ascii=False)}\n\n"
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
                    if result_dict.get("device_name"):
                        tool_call_item["device_name"] = result_dict["device_name"]
                    yield f"data: {json.dumps({'type': 'tool_result', 'task_id': result_dict.get('task_id'), 'tool_call_id': call_id, 'result': result_dict}, ensure_ascii=False)}\n\n"
                elif etype == "ping":
                    yield "data: {\"type\": \"ping\"}\n\n"
        except Exception as e:
            logger.exception("Error in direct agent stream: %s", e)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

        # Summary delta message
        if result_dict:
            status = result_dict.get("status", "completed")
            exit_code = result_dict.get("exit_code")
            stdout = (result_dict.get("stdout") or "").strip()
            stderr = (result_dict.get("stderr") or "").strip()
            err_msg = result_dict.get("error") or stderr or f"退出码 {exit_code}"

            is_only_tool_calls = False
            if action == "agent" and stdout:
                non_empty_lines = [line.strip() for line in stdout.splitlines() if line.strip()]
                if non_empty_lines and all(l.startswith(("[Tool:", "⚡ [", "[Tool ")) for l in non_empty_lines):
                    is_only_tool_calls = True

            if status == "failed":
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
                    summary_text = f"{_clean_agent_summary(stdout)}\n\n> ⏳ *[原始工具后台任务仍在持续执行中，请稍候]*"
                else:
                    summary_text = "⏳ 任务已转入后台持续执行中。"
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
                    else:
                        summary_text = f"✅ {execution_mode.capitalize()} 任务在设备上执行完毕。"
            else:
                summary_text = f"⚠️ 任务执行完成（{err_msg[:100]}）。"
        else:
            summary_text = "任务执行结束。"

        yield f"data: {json.dumps({'type': 'delta', 'text': summary_text}, ensure_ascii=False)}\n\n"
    finally:
        await _persist()

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
) -> StreamingResponse:
    """Start the ask as a background run and stream it. The run survives the
    client disconnecting; see services/ask_runs.py."""
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
        )
    except RunConflict:
        raise HTTPException(status_code=409, detail="这个对话还有任务在运行，请等它结束或先停止")
    return StreamingResponse(run.stream(0), media_type="text/event-stream", headers=SSE_HEADERS)
