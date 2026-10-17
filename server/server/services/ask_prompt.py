"""Prompt assembly for /api/ask: the system prompt, the history window, and
the heuristics that tell a follow-up apart from a new question.
"""

from __future__ import annotations

import logging
import os
import re



from ..db.models import UserMemory

logger = logging.getLogger("server.ask")

# Conversation turns kept for follow-ups. Older turns are dropped rather than
# summarized — cheap, and follow-ups nearly always reference recent context.
MAX_HISTORY_TURNS = 6

SYSTEM_PROMPT = """你是 Memento 的记忆助手。用户把自己在各种 AI 编程工具里的对话、笔记、计划都同步到了这里,你的任务是基于检索到的资料回答问题。

规则:
1. 只根据提供的「资料」回答。资料里没有的,直接说不知道,不要编造。
2. 引用时用 [1] [2] 这样的编号标注来源,编号对应资料的序号。
3. 用户问什么语言就用什么语言回答。
4. 简洁直接。有具体命令、配置、路径就原样给出,不要改写。
5. 如果资料只是部分相关,说清楚你能确定什么、不能确定什么。"""


ACTION_VERBS = (
    "关闭", "关掉", "关了", "关一下", "关了它", "关掉它", "把它关了", "把它关掉", "帮我关",
    "杀死", "杀掉", "杀了", "杀一下", "干掉", "结束", "终止", "掐死",
    "停止", "停掉", "停了", "停一下", "停了它", "停掉它", "把它停了",
    "清理", "清掉", "清除", "清理掉", "把它清理了", "帮我清理",
    "重启", "重新启动", "重启一下",
    "启动", "运行", "跑一下", "执行",
    "修复", "解决", "搞定", "搞一下", "处理", "接着修",
    "排查", "检查", "查一下", "查看", "看下", "看看",
    "删除", "删掉", "移除",
)

REFERENCE_TERMS = (
    "它", "它们", "这个", "那个", "这些", "那些", "上面", "刚才", "之前", "上个", "上一个",
    "遗留", "残留", "进程", "任务", "守护进程", "端口", "服务", "容器", "机器", "设备",
)

CONFIRMATION_TERMS = (
    "好", "好的", "行", "行吧", "可以", "可以的", "没问题", "确认", "同意", "同意执行",
    "搞起", "执行吧", "弄吧", "处理吧", "清理吧", "关吧", "杀吧", "停吧", "干吧",
    "ok", "OK", "yes", "YES", "y", "Y",
)

CONTINUATION_PHRASES = (
    "继续", "修复", "重试", "接着", "还没好", "没好", "再试", "重新",
    "还是报错", "依然报错", "解决一下", "搞定它", "接着修", "排查", "查一下", "启动一下",
    "怎么回事", "为什么", "关掉", "关闭", "杀掉", "杀死", "停掉", "停止", "清理掉",
)


def classify_continuation(
    question: str,
    history: list[dict] | None,
) -> tuple[bool, bool, dict]:
    """Classify if the question is a continuation and whether it requires device action.

    Returns: (is_continuation, is_action, extracted_context)
    """
    q = question.strip()
    extracted = {
        "device_name": None,
        "device_id": None,
        "entities": [],
        "last_assistant_text": "",
    }
    if not history:
        return False, False, extracted

    last_asst = None
    for turn in reversed(history):
        if turn.get("role") == "assistant":
            last_asst = turn
            break

    last_asst_content = (last_asst.get("content") or "").strip() if last_asst else ""
    last_tool_calls = (last_asst.get("tool_calls") or last_asst.get("toolCalls") or []) if last_asst else []
    extracted["last_assistant_text"] = last_asst_content[:300]

    # Extract target device from previous tool calls
    for tc in reversed(last_tool_calls):
        args = tc.get("args") or {}
        dev = tc.get("device_name") or args.get("device_id")
        if dev and dev not in ("auto", "ask_only"):
            extracted["device_name"] = dev
            extracted["device_id"] = args.get("device_id") or dev
            break

    # If device not in tool_calls, search in assistant text
    if not extracted["device_name"] and last_asst_content:
        m_dev = re.search(r"(?:在|于|目标设备|设备)\s*[:：]?\s*([A-Za-z0-9_\-\s]{2,20}?)(?:上|的|设备|机器|\n|,|，)", last_asst_content)
        if m_dev:
            dev_candidate = m_dev.group(1).strip()
            if len(dev_candidate) >= 2 and not dev_candidate.isdigit():
                extracted["device_name"] = dev_candidate

    # Extract PID(s) and processes from assistant text
    if last_asst_content:
        pids = re.findall(r"(?:PID|pid)\s*[:：=]?\s*(\d{2,7})", last_asst_content)
        if not pids:
            pids = re.findall(r"\(PID\s*(\d{2,7})\)", last_asst_content)
        for pid in pids:
            ent = f"PID {pid}"
            if ent not in extracted["entities"]:
                extracted["entities"].append(ent)

        tasks = re.findall(r"(\d+\.\s*[^:\n]+(?:\(PID\s*\d+\))?\s*:\s*[^\n]+)", last_asst_content)
        for t in tasks[:2]:
            clean_t = t.strip()
            if clean_t not in extracted["entities"]:
                extracted["entities"].append(clean_t)

    q_lower = q.lower()
    has_continuation_phrase = any(kw in q for kw in CONTINUATION_PHRASES)
    has_action_verb = any(v in q for v in ACTION_VERBS)
    has_reference = any(r in q for r in REFERENCE_TERMS)
    is_confirmation = any(c == q_lower or q_lower.startswith(c) for c in CONFIRMATION_TERMS)

    asst_offered_action = any(
        phrase in last_asst_content
        for phrase in ("可以告诉我帮你清理", "帮你清理", "是否需要关闭", "帮您关闭", "要不要关掉", "是否关闭", "是否终止", "是否重启", "可以告诉我帮你", "需要我帮你")
    )

    is_cont = False
    is_action = False

    if len(q) <= 60:
        if has_continuation_phrase or is_confirmation:
            is_cont = True
        elif has_action_verb and (has_reference or "帮" in q or len(q) <= 15):
            is_cont = True
        elif has_reference and (has_action_verb or "吗" in q or "怎么" in q or "为什么" in q or "干嘛" in q or len(q) <= 20):
            is_cont = True
        elif asst_offered_action and (is_confirmation or has_action_verb or has_reference):
            is_cont = True

    if is_cont:
        if has_action_verb:
            is_action = True
        elif is_confirmation and asst_offered_action:
            is_action = True
        elif any(act in q for act in ("关", "杀", "停", "清", "重", "修", "执", "跑")):
            is_action = True

    return is_cont, is_action, extracted


def _format_tool_calls_summary(tool_calls: list[dict]) -> str:
    if not tool_calls:
        return ""
    lines = ["[系统记录：上一轮在设备上的操作与执行结果 (只读事实参考)]:"]
    for tc in tool_calls:
        name = tc.get("name") or "run_on_device"
        args = tc.get("args") or {}
        dev = tc.get("device_name") or args.get("device_id") or ""
        cmd = args.get("command") or args.get("prompt") or ""
        action = args.get("action") or ("shell" if "command" in args else "agent")
        status = tc.get("status") or "executed"
        exit_code = tc.get("exit_code")
        err = tc.get("stderr") or tc.get("error") or ""
        out = tc.get("stdout") or ""

        info = f"- 工具: {name} (类型: {action}"
        if dev:
            info += f", 目标设备: {dev}"
        info += ")"
        if cmd:
            info += f"\n  执行内容: {cmd}"
        info += f"\n  执行状态: {status}"
        if exit_code is not None:
            info += f" (退出码: {exit_code})"
        if err:
            info += f"\n  错误输出/stderr:\n```\n{err.strip()[:1500]}\n```"
        elif out:
            info += f"\n  终端输出/stdout:\n```\n{out.strip()[:600]}\n```"
        lines.append(info)
    return "\n".join(lines)


def build_messages(
    question: str,
    sources: list[dict],
    history: list[dict] | None,
    is_continuation: bool = False,
    is_action: bool = False,
    extracted_context: dict | None = None,
    images: list[str] | None = None,
    attachments: list[dict] | None = None,
    core_memories: list[UserMemory] | None = None,
    user_profile_content: str | None = None,
    guidance_data: dict | None = None,
    device_id: str | None = None,
) -> list[dict]:
    context = "\n\n".join(
        f"[{i + 1}] {s['title']} ({s['tool_id']}, {s['relative_path']})\n{s['excerpt']}"
        for i, s in enumerate(sources)
    ) or "(没有检索到相关资料)"

    system_prompt = SYSTEM_PROMPT

    # 1. Resident User Profile (Highest priority: About Me, Rules, Preferences)
    if user_profile_content and user_profile_content.strip():
        system_prompt += f"\n\n【用户常驻画像与最高铁律 (关于我)】\n{user_profile_content.strip()}"

    # 2. Guidance (Rules & Pitfalls & Verified Skills)
    if guidance_data:
        from ..services.guidance_service import render_guidance
        rendered_g = render_guidance(guidance_data)
        if rendered_g.strip():
            system_prompt += f"\n\n{rendered_g.strip()}"

    # 3. Core Memories
    if core_memories:
        core_snippets = "\n".join(
            f"- [{m.category}/{m.key}]: {m.content}" for m in core_memories
        )
        system_prompt += f"\n\n【用户长期核心记忆与工程规范 (MEMORY.md)】\n{core_snippets}"

    # 4. Device Environment Fingerprint
    if device_id and device_id not in ("auto", "ask_only"):
        from .tasks import get_device_environment_summary
        env_summary = get_device_environment_summary(device_id)
        if env_summary:
            system_prompt += f"\n\n【目标设备就绪环境指纹画像】\n{env_summary}"

    messages = [{"role": "system", "content": system_prompt}]
    for turn in (history or [])[-MAX_HISTORY_TURNS:]:
        role = turn.get("role")
        content = (turn.get("content") or "").strip()
        tool_calls = turn.get("tool_calls") or turn.get("toolCalls") or []

        if role == "assistant":
            parts = []
            t_summary = _format_tool_calls_summary(tool_calls)
            if t_summary:
                parts.append(t_summary)
            # Filter out misleading empty or bogus fallback messages from previous turns
            if content and content != "任务已执行完成。" and "未获取到需要执行的具体设备操作" not in content:
                parts.append(content)
            combined = "\n\n".join(parts)
            if combined:
                messages.append({"role": role, "content": combined})
        elif role == "user" and content:
            messages.append({"role": role, "content": content})

    # Format text/code attachments into structured snippets
    attachment_snippets = []
    for att in (attachments or []):
        name = att.get("name") or "attachment"
        text = att.get("text_content")
        if text:
            ext = os.path.splitext(name)[1].lstrip(".") or ""
            attachment_snippets.append(f"【用户附加的文件: {name}】\n```{ext}\n{text}\n```")
    att_prefix = "\n\n".join(attachment_snippets)

    if is_action:
        dev_info = ""
        if extracted_context and extracted_context.get("device_name"):
            dev_info += f"- 目标设备: {extracted_context['device_name']}\n"
        if extracted_context and extracted_context.get("entities"):
            dev_info += f"- 涉及对象: {', '.join(extracted_context['entities'])}\n"

        user_prompt = (
            f"【跟进操作指令】\n"
            f"用户指令: 「{question}」\n"
        )
        if dev_info:
            user_prompt += f"上下文参考:\n{dev_info}"
        user_prompt += (
            "规则与要求:\n"
            "1. 必须仔细结合前序交互历史，主动调用 run_on_device 工具在目标物理机上执行真实操作（如 kill 进程、停止服务、重启等）！\n"
            "2. 绝对严禁在文本中编写或伪造执行状态，所有操作必须通过触发真实的 run_on_device 工具下发！\n"
            "3. 严禁在未调用工具前回复「未获取到操作」或直接结束！"
        )
        if sources:
            user_prompt = f"参考资料:\n{context}\n\n{user_prompt}"
    elif is_continuation:
        user_prompt = (
            f"【跟进与继续排查/修复指令】\n"
            f"用户指令: 「{question}」\n"
            f"请仔细结合上方历史记录中上一轮在设备上执行的命令、退出码以及报错日志（stderr），"
            f"分析原因，并在目标设备上主动调用 run_on_device 执行下一步排查或修复操作"
            f"（例如杀死占用端口的进程、修复代码/配置、安装依赖、重启并检查状态）。\n"
            f"若涉及设备排查，必须调用 run_on_device 执行，绝对不可在未执行排查时直接结束！"
        )
        if sources:
            user_prompt = f"参考资料:\n{context}\n\n{user_prompt}"
    else:
        user_prompt = f"资料:\n{context}\n\n问题: {question}"

    if att_prefix:
        user_prompt = f"{att_prefix}\n\n{user_prompt}"

    # Build multimodal content payload if images present (OpenAI Vision standard)
    if images:
        content_parts: list[dict] = [{"type": "text", "text": user_prompt}]
        for img_url in images:
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": img_url}
            })
        messages.append({
            "role": "user",
            "content": content_parts,
        })
    else:
        messages.append({
            "role": "user",
            "content": user_prompt,
        })

    return messages
