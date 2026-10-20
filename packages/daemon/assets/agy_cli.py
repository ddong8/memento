#!/usr/bin/env python3
"""Antigravity CLI runner: communicates with the running Antigravity language_server."""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def _auto_discover_antigravity_ls():
    """Auto-detect ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN if not explicitly exported."""
    if os.environ.get("ANTIGRAVITY_LS_ADDRESS") and os.environ.get("ANTIGRAVITY_CSRF_TOKEN"):
        return

    try:
        if sys.platform in ("darwin", "linux"):
            out = subprocess.check_output(["ps", "-eo", "pid,command"], text=True)
            pid = None
            csrf_token = None
            for line in out.splitlines():
                if "language_server" in line and "antigravity" in line and "grep" not in line:
                    m_pid = re.match(r"^\s*(\d+)", line)
                    if m_pid:
                        pid = m_pid.group(1)
                    m_token = re.search(r"--csrf_token\s+([^\s]+)", line)
                    if m_token:
                        csrf_token = m_token.group(1)
                    break
            if not pid:
                return

            lsof_out = subprocess.check_output(["lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pid], text=True)
            ports = []
            for pline in lsof_out.splitlines():
                m_port = re.search(r"TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)", pline)
                if m_port:
                    ports.append(int(m_port.group(1)))

            for port in ports:
                try:
                    url = f"http://127.0.0.1:{port}/"
                    req = urllib.request.Request(url, headers={"User-Agent": "Antigravity-Probe"})
                    with urllib.request.urlopen(req, timeout=1) as resp:
                        if resp.status == 200:
                            content = resp.read(2048).decode("utf-8", errors="ignore")
                            if "antigravity" in content or "csrfToken" in content:
                                if not csrf_token:
                                    m_c = re.search(r'"csrfToken":"([^"]+)"', content)
                                    if m_c:
                                        csrf_token = m_c.group(1)
                                os.environ["ANTIGRAVITY_LS_ADDRESS"] = f"localhost:{port}"
                                if csrf_token:
                                    os.environ["ANTIGRAVITY_CSRF_TOKEN"] = csrf_token

                                if not os.environ.get("ANTIGRAVITY_PROJECT_ID"):
                                    storage_paths = [
                                        Path.home() / "Library" / "Application Support" / "Antigravity" / "app_storage.json",
                                        Path.home() / ".config" / "Antigravity" / "app_storage.json",
                                        Path(os.environ.get("APPDATA", "")) / "Antigravity" / "app_storage.json",
                                    ]
                                    for sp in storage_paths:
                                        if sp.exists():
                                            try:
                                                with open(sp, "r", encoding="utf-8") as sf:
                                                    sdata = json.load(sf)
                                                    pid_val = sdata.get("lastCreatedProjectId")
                                                    if pid_val:
                                                        os.environ["ANTIGRAVITY_PROJECT_ID"] = str(pid_val)
                                                        break
                                            except Exception:
                                                pass
                                return
                except Exception:
                    pass
        elif sys.platform == "win32":
            try:
                ps_cmd = [
                    "powershell", "-NoProfile", "-Command",
                    'Get-CimInstance Win32_Process -Filter "Name LIKE \'%language_server%\'" | Select-Object -Property ProcessId, CommandLine | ConvertTo-Json'
                ]
                raw = subprocess.check_output(ps_cmd, text=True, timeout=3)
                data = json.loads(raw)
                items = data if isinstance(data, list) else [data]
                pid = None
                csrf_token = None
                for item in items:
                    cmd_line = item.get("CommandLine") or ""
                    if "antigravity" in cmd_line.lower():
                        pid = str(item.get("ProcessId"))
                        m_token = re.search(r"--csrf_token\s+([^\s]+)", cmd_line)
                        if m_token:
                            csrf_token = m_token.group(1)
                        break
                if pid:
                    net_out = subprocess.check_output(f"netstat -ano | findstr {pid}", shell=True, text=True)
                    ports = []
                    for pline in net_out.splitlines():
                        if "LISTENING" in pline:
                            m_port = re.search(r"127\.0\.0\.1:(\d+)", pline)
                            if m_port:
                                ports.append(int(m_port.group(1)))
                    for port in ports:
                        try:
                            url = f"http://127.0.0.1:{port}/"
                            req = urllib.request.Request(url, headers={"User-Agent": "Antigravity-Probe"})
                            with urllib.request.urlopen(req, timeout=1) as resp:
                                if resp.status == 200:
                                    cnt = resp.read(2048).decode("utf-8", errors="ignore")
                                    if "antigravity" in cnt or "csrfToken" in cnt:
                                        if not csrf_token:
                                            m_c = re.search(r'"csrfToken":"([^"]+)"', cnt)
                                            if m_c:
                                                csrf_token = m_c.group(1)
                                        os.environ["ANTIGRAVITY_LS_ADDRESS"] = f"localhost:{port}"
                                        if csrf_token:
                                            os.environ["ANTIGRAVITY_CSRF_TOKEN"] = csrf_token
                                        break
                        except Exception:
                            pass
            except Exception:
                pass
    except Exception:
        pass


def _is_antigravity_ls_alive():
    """Probe if Antigravity language_server HTTP probe responds."""
    addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
    if not addr:
        return False
    try:
        req = urllib.request.Request(f"http://{addr}/", headers={"User-Agent": "Antigravity-Probe"})
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def ls_running_commands() -> list:
    """Commands Antigravity is running right now: its language server's child
    processes (a run_command shows up as `zsh -c <command>`). Empty where this
    can't be told (no pgrep, e.g. Windows)."""
    try:
        pids = subprocess.run(
            ["pgrep", "-f", "[Aa]ntigravity.*language_server"], capture_output=True, text=True, timeout=2
        ).stdout.split()
        cmds = []
        for pid in pids:
            for child in subprocess.run(
                ["pgrep", "-P", pid], capture_output=True, text=True, timeout=2
            ).stdout.split():
                cmd = subprocess.run(
                    ["ps", "-o", "command=", "-p", child], capture_output=True, text=True, timeout=2
                ).stdout.strip()
                if cmd:
                    cmds.append(cmd)
        return cmds
    except Exception:
        return []


def thinking_heartbeat(elapsed_sec: int, running_cmds: list) -> str:
    """Status line while the transcript is quiet and no tool call is known to be in flight."""
    if running_cmds:
        shown = running_cmds[0]
        for prefix in ("/bin/zsh -c ", "zsh -c ", "/bin/bash -c ", "bash -c ", "sh -c "):
            if shown.startswith(prefix):
                shown = shown[len(prefix):]
                break
        return f"⏳ [命令执行中（已用时 {elapsed_sec}s）：{shown[:60]}]"
    if elapsed_sec >= 600:
        return (f"⏳ [模型仍在生成（已用时 {elapsed_sec}s），远端模型可能在排队重试；"
                f"任务仍在进行，可随时停止]")
    return f"⏳ [模型思考推理中（已用时 {elapsed_sec}s），请稍候...]"


def get_model_candidates(requested_model: str) -> list:
    """Return ordered list of Antigravity model tiers (flash, pro, flash_lite) to attempt."""
    m = (requested_model or "").lower().strip()
    if m in ("flash_lite", "flash-lite", "gemini-3.6-flash", "gemini-2.5-flash-lite"):
        return ["flash_lite", "flash", "pro"]
    elif m in ("pro", "gemini-3.1-pro", "gemini-2.5-pro", "claude-sonnet-4-6", "claude-opus-4-6", "claude-3-7-sonnet"):
        return ["pro", "flash", "flash_lite"]
    else:
        return ["flash", "pro", "flash_lite"]


def is_transient_error(err_msg: str) -> bool:
    """Detect if an Antigravity error is an upstream transient retry, rate-limit or temporary capacity issue."""
    if not err_msg:
        return False
    msg_low = err_msg.lower()
    if re.search(r"attempt\s+\d+", msg_low):
        return True
    transient_keywords = (
        "connection reset", "eof", "broken pipe", "timeout", "timed out",
        "handshake", "temporarily unavailable", "stream was interrupted",
        "stream interrupted", "interrupted", "please continue the task",
        "rate limit", "resource exhausted", "overloaded", "retry", "try again",
        "no capacity available", "capacity available", "code 503", "unavailable",
        "service unavailable", "bad gateway", "502", "503", "504",
        "quota reached", "quota", "temporarily",
    )
    return any(kw in msg_low for kw in transient_keywords)


def main():
    parser = argparse.ArgumentParser(description="Antigravity CLI Runner")
    parser.add_argument("-p", "--prompt", dest="prompt_flag", help="Prompt to send to Antigravity")
    parser.add_argument("--resume", dest="resume_id", default="", help="Resume an existing conversation by ID")
    parser.add_argument("--model", dest="model", default="", help="Model tier: flash_lite, flash, or pro")
    parser.add_argument("--title", dest="title", default="", help="Conversation title")
    parser.add_argument("--timeout", type=int, default=0, help="Timeout in seconds (0 = unlimited)")
    parser.add_argument("prompt_pos", nargs="*", help="Positional prompt words")

    args, unknown = parser.parse_known_args()

    prompt_parts = []
    if args.prompt_flag:
        prompt_parts.append(args.prompt_flag)
    if args.prompt_pos:
        prompt_parts.extend(args.prompt_pos)

    prompt = " ".join(prompt_parts).strip()
    if not prompt:
        if not sys.stdin.isatty():
            try:
                prompt = sys.stdin.read().strip()
            except Exception:
                pass

    if not prompt:
        print("Error: empty prompt", file=sys.stderr)
        sys.exit(1)

    agentapi = Path.home() / ".gemini" / "antigravity" / "bin" / ("agentapi.cmd" if sys.platform == "win32" else "agentapi")
    if not agentapi.exists():
        ls_candidates = [
            Path("/Applications/Antigravity.app/Contents/Resources/bin/language_server"),
            Path.home() / "AppData" / "Local" / "Programs" / "Antigravity" / "resources" / "bin" / "language_server.exe",
            Path("C:/Program Files/Antigravity/resources/bin/language_server.exe"),
        ]
        for c in ls_candidates:
            if c.exists():
                agentapi.parent.mkdir(parents=True, exist_ok=True)
                if sys.platform == "win32":
                    with open(agentapi, "w", encoding="utf-8") as f:
                        f.write(f'@echo off\r\n"{c}" agentapi %*\r\n')
                else:
                    with open(agentapi, "w", encoding="utf-8") as f:
                        f.write(f'#!/bin/sh\nexec "{c}" agentapi "$@"\n')
                    agentapi.chmod(0o755)
                break

    if not agentapi.exists():
        print(f"Error: agentapi not found at {agentapi}", file=sys.stderr)
        sys.exit(1)

    # Auto-detect Antigravity language_server address and CSRF token if not set
    if not os.environ.get("ANTIGRAVITY_LS_ADDRESS"):
        _auto_discover_antigravity_ls()

    if not os.environ.get("ANTIGRAVITY_LS_ADDRESS"):
        print("💡 未检测到正在运行的 Antigravity 应用服务。请先启动 Antigravity 应用后再试。", file=sys.stderr)
        sys.exit(1)

    # Strip any inherited Antigravity parent session/subagent environment variables
    # to avoid "sender conversation not found" errors when calling agentapi
    for k in (
        "ANTIGRAVITY_SOURCE_METADATA",
        "ANTIGRAVITY_CONVERSATION_ID",
        "ANTIGRAVITY_AGENT",
        "ANTIGRAVITY_TRAJECTORY_ID",
    ):
        os.environ.pop(k, None)

    candidate_models = get_model_candidates(args.model)
    model = candidate_models[0]

    title = args.title or prompt[:40]
    conv_id = args.resume_id.strip()
    start_pos = 0

    if conv_id:
        # Resume existing conversation
        target_log = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs" / "transcript_full.jsonl"
        fallback_log = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs" / "transcript.jsonl"
        if target_log.exists():
            start_pos = target_log.stat().st_size
        elif fallback_log.exists():
            start_pos = fallback_log.stat().st_size

        cmd = [
            str(agentapi),
            "send-message",
            f"--title={title}",
            conv_id,
            prompt,
        ]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ))
            if res.returncode != 0:
                err_text = (res.stderr or res.stdout or "").strip()
                print(f"Error resuming conversation via Antigravity: {err_text}", file=sys.stderr)
                sys.exit(1)
        except Exception as e:
            print(f"Error resuming conversation via Antigravity: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        # Start new conversation with automatic tier fallback
        created = False
        last_init_err = ""
        for cand in candidate_models:
            cmd = [
                str(agentapi),
                "new-conversation",
                f"--model={cand}",
                f"--title={title}",
                prompt,
            ]
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ))
                if res.returncode == 0:
                    out_json = json.loads(res.stdout)
                    conv_id = out_json["response"]["newConversation"]["conversationId"]
                    model = cand
                    created = True
                    if cand != candidate_models[0]:
                        sys.stderr.write(f"\n⚡ [提示: 模型 {candidate_models[0]} 暂不可用，已自动智能降级至 {cand} 成功建立会话]\n\n")
                        sys.stderr.flush()
                    break
                else:
                    err_text = (res.stderr or res.stdout or "").strip()
                    last_init_err = err_text
                    sys.stderr.write(f"\n⏳ [模型 {cand} 启动遇到异常 ({err_text[:80]})，自动尝试切换下一档位...]\n\n")
                    sys.stderr.flush()
            except Exception as e:
                last_init_err = str(e)
                sys.stderr.write(f"\n⏳ [模型 {cand} 启动失败 ({e})，自动尝试切换下一档位...]\n\n")
                sys.stderr.flush()

        if not created or not conv_id:
            print(f"Error initiating conversation via Antigravity: {last_init_err}", file=sys.stderr)
            sys.exit(1)

    sys.stderr.write(f"session id: {conv_id}\n")
    sys.stderr.flush()

    import threading

    state = {
        "waiting_user_input": False,
        "in_flight_tools": [],
        "tool_start_time": None,
    }

    def _listen_stdin(cid, agentapi_bin):
        try:
            for line in sys.stdin:
                ans = line.strip()
                if not ans:
                    continue
                state["waiting_user_input"] = False
                cmd_send = [str(agentapi_bin), "send-message", cid, ans]
                try:
                    subprocess.run(cmd_send, capture_output=True, text=True, env=dict(os.environ))
                except Exception as ex:
                    sys.stderr.write(f"Error forwarding answer to Antigravity: {ex}\n")
                    sys.stderr.flush()
        except Exception:
            pass

    threading.Thread(target=_listen_stdin, args=(conv_id, agentapi), daemon=True).start()

    target_log = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs" / "transcript_full.jsonl"
    fallback_log = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs" / "transcript.jsonl"

    # Wait for transcript file to appear
    wait_start = time.time()
    while not target_log.exists() and not fallback_log.exists():
        if time.time() - wait_start > 20:
            print("Timed out waiting for Antigravity response log.", file=sys.stderr)
            sys.exit(1)
        time.sleep(0.1)

    transcript_file = target_log if target_log.exists() else fallback_log

    start_time = time.time()
    idle_count = 0
    completed = False
    last_error_message = ""
    active_background_tasks = set()
    task_log_sizes = {}
    ls_dead_checks = 0
    tasks_dir = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "tasks"

    with open(transcript_file, "r", encoding="utf-8") as f:
        if start_pos > 0:
            f.seek(start_pos)

        while True:
            if args.timeout > 0 and (time.time() - start_time > args.timeout):
                if active_background_tasks:
                    tid_names = ", ".join(t.split("/")[-1] for t in active_background_tasks)
                    sys.stderr.write(f"\n[STATUS_STILL_RUNNING: tasks={tid_names}]\n")
                    sys.stderr.write(f"\n⏳ [任务在后台持续执行中（{tid_names}），达到单次等待上限（{args.timeout}s），保持后台运行]\n")
                    sys.stderr.flush()
                    completed = True
                    break
                else:
                    sys.stderr.write(f"\n[Agent timeout: 任务执行已达到安全上限（{args.timeout}s）]\n")
                    sys.stderr.flush()
                    sys.exit(124)

            line = f.readline()
            if not line:
                time.sleep(0.2)
                idle_count += 1

                # 若存在后台任务，检查其 log 产出以判断是否仍在活跃运行或定时器是否已触发/提前终止
                if active_background_tasks and tasks_dir.exists():
                    has_log_growth = False
                    for bg_t in list(active_background_tasks):
                        tc = bg_t.split("/")[-1]
                        lp = tasks_dir / f"{tc}.log"
                        if lp.exists():
                            try:
                                sz = lp.stat().st_size
                                prev_sz = task_log_sizes.get(tc, -1)
                                if sz > prev_sz:
                                    task_log_sizes[tc] = sz
                                    has_log_growth = True
                                if sz > 0:
                                    with open(lp, "rb") as lf:
                                        lf.seek(max(0, sz - 512))
                                        tail_txt = lf.read().decode("utf-8", errors="ignore")
                                    if "] Timer fired." in tail_txt or "] Timer cancelled:" in tail_txt:
                                        active_background_tasks.discard(bg_t)
                                        sys.stderr.write(f"\n✅ [后台任务 {tc} 执行完毕/已结束]\n\n")
                                        sys.stderr.flush()
                                        idle_count = 0
                            except Exception:
                                pass
                    if has_log_growth:
                        idle_count = 0  # 任务日志在持续写入，说明后台进程活跃，重置空闲计时

                # 周期性保活心跳与状态提示（输出至 stderr，确保不污染正文 stdout）
                if idle_count > 0 and idle_count % 125 == 0:  # 每 25 秒输出一次心跳
                    if state.get("waiting_user_input"):
                        sys.stderr.write("\n\n⏳ [等待用户选择或回复中...]\n\n")
                        sys.stderr.flush()
                    elif state.get("in_flight_tools"):
                        tool_names = ", ".join(state["in_flight_tools"])
                        el_sec = int(time.time() - state["tool_start_time"]) if state.get("tool_start_time") else int(idle_count * 0.2)
                        sys.stderr.write(f"\n\n⏳ [工具 {tool_names} 持续执行中（已运行 {el_sec}s），请稍候...]\n\n")
                        sys.stderr.flush()
                    elif active_background_tasks:
                        tid_names = ", ".join(t.split("/")[-1] for t in active_background_tasks)
                        sys.stderr.write(f"\n\n⏳ [后台任务 {tid_names} 执行中，请稍候...]\n\n")
                        sys.stderr.flush()
                    else:
                        el_sec = int(idle_count * 0.2)
                        sys.stderr.write(f"\n\n{thinking_heartbeat(el_sec, ls_running_commands())}\n\n")
                        sys.stderr.flush()

                # 静默超过 20 秒后，每 10 秒探测 Antigravity 语言服务器存活状态
                if idle_count > 100 and idle_count % 50 == 0:
                    if not _is_antigravity_ls_alive():
                        ls_dead_checks += 1
                        if ls_dead_checks >= 3:  # 连续 3 次（30s）无响应判定为语言服务器断开
                            sys.stderr.write("\n[Agent error: Antigravity 语言服务器已断开连接]\n")
                            sys.stderr.flush()
                            sys.exit(1)
                    else:
                        ls_dead_checks = 0

                if last_error_message and idle_count > 25:  # 5s idle after confirmed non-transient error
                    sys.stderr.write(f"\nAntigravity Error: {last_error_message}\n")
                    sys.stderr.flush()
                    sys.exit(1)

                # 超时判定分支状态机：
                # 1. 处于等待用户输入时：不触发空闲超时（受全局 args.timeout 约束）
                if state.get("waiting_user_input"):
                    continue

                # 2. 处于工具在途执行期：工具执行单次最长允许 3600 秒（或 args.timeout），杜绝误杀
                if state.get("in_flight_tools"):
                    tool_timeout = min(3600, args.timeout) if args.timeout > 0 else 3600
                    if state.get("tool_start_time") and (time.time() - state["tool_start_time"] > tool_timeout):
                        tool_names = ", ".join(state["in_flight_tools"])
                        sys.stderr.write(f"\n[Tool timeout: 工具 {tool_names} 执行超时（超过 {tool_timeout}s）]\n")
                        sys.stderr.flush()
                        sys.exit(124)
                    continue

                # 3. 处于后台任务轮询期：空闲 180s 后平滑转入后台监控
                if active_background_tasks:
                    if idle_count > 900:  # 180s
                        tid_names = ", ".join(t.split("/")[-1] for t in active_background_tasks)
                        sys.stderr.write(f"\n[STATUS_STILL_RUNNING: tasks={tid_names}]\n")
                        sys.stderr.write(f"\n⏳ [后台任务（{tid_names}）持续运行中，达到单次轮询等待上限（180s），已安全转入后台监控]\n")
                        sys.stderr.flush()
                        completed = True
                        break
                    continue

                # 4. 纯模型生成、日志无新行：不按空闲时长结束。Antigravity 遇到 503 等容量问题会
                #    静默重试，一步生成可能持续十几分钟、甚至一次容量故障持续 40 分钟，但它自己不会
                #    放弃；在这里结束只会让 memento 报失败、而 Antigravity 在后台照常把活干完。
                #    语言服务器断开（上面的存活探测）和任务总超时（args.timeout）仍然生效。
                continue

            idle_count = 0
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except Exception:
                continue

            source = data.get("source")
            step_type = data.get("type")
            step_status = data.get("status")
            content = data.get("content") or ""
            tool_calls = data.get("tool_calls") or []

            # 仅在真实异步工具启动步骤（type=GENERIC, status=RUNNING）中提取 task-<数字> ID，
            # 彻底杜绝 view_file 查看源码或 grep 搜索日志时把代码文本误识别为后台任务
            if step_type == "GENERIC" and step_status == "RUNNING" and content.startswith("Created At:"):
                m_bg = re.search(
                    r"(?:Tool is running as a background task with task id|Command running in background with ID|Task running in background with ID):\s*((?:[0-9a-fA-F-]+/)?task-\d+)",
                    content,
                    flags=re.IGNORECASE,
                )
                if m_bg:
                    bg_tid = m_bg.group(1).strip()
                    active_background_tasks.add(bg_tid)
                    tid_clean = bg_tid.split("/")[-1]
                    sys.stderr.write(f"\n⏳ [后台任务启动: {tid_clean}，持续追踪执行进度...]\n\n")
                    sys.stderr.flush()
                    idle_count = 0

            # Check if any active background task finished, failed, or was canceled
            is_file_view = "File Path: `" in content or "The following changes were made by the " in content
            for bg_tid in list(active_background_tasks):
                tid_clean = bg_tid.split("/")[-1]
                matched = not is_file_view and (tid_clean in content or bg_tid in content)
                sender_matched = step_type == "SYSTEM_MESSAGE" and (
                    f"sender={bg_tid}" in content or f"sender={tid_clean}" in content
                )
                is_canceled = matched and any(kw in content for kw in (
                    "was canceled", "was cancelled", "Tool execution was canceled",
                    "Tool execution was cancelled", "Status: CANCELLED", "Status: CANCELED",
                    "Status: ERROR", "Status: FAILED", "failed with result",
                    f'Task "{bg_tid}" cancelled', f'Task "{tid_clean}" cancelled',
                ))
                is_finished = (not is_canceled) and (
                    sender_matched or (
                        matched and any(kw in content for kw in (
                            "finished with result", "The command exited with code", "Timer fired", "Status: DONE"
                        ))
                    )
                )
                if is_finished or is_canceled:
                    active_background_tasks.discard(bg_tid)
                    status_desc = "已取消/终止" if is_canceled else "执行完毕，已接收运行结果"
                    icon = "⏹️" if is_canceled else "✅"
                    sys.stderr.write(f"\n{icon} [后台任务 {tid_clean} {status_desc}]\n\n")
                    sys.stderr.flush()
                    idle_count = 0
                elif tasks_dir.exists():
                    log_path = tasks_dir / f"{tid_clean}.log"
                    if log_path.exists():
                        try:
                            sz = log_path.stat().st_size
                            if sz > 0:
                                with open(log_path, "rb") as lf:
                                    lf.seek(max(0, sz - 512))
                                    tail_bytes = lf.read().decode("utf-8", errors="ignore")
                                if "] Timer fired." in tail_bytes or "] Timer cancelled:" in tail_bytes:
                                    active_background_tasks.discard(bg_tid)
                                    sys.stderr.write(f"\n✅ [后台任务 {tid_clean} 执行完毕/已结束]\n\n")
                                    sys.stderr.flush()
                                    idle_count = 0
                        except Exception:
                            pass

            # 工具/系统/用户结果到达时更新在途状态
            if step_type in ("GENERIC", "SYSTEM_MESSAGE"):
                if state.get("in_flight_tools"):
                    state["in_flight_tools"].pop(0)
                if not state.get("in_flight_tools"):
                    state["tool_start_time"] = None

            if step_type == "USER_INPUT":
                state["waiting_user_input"] = False
                state["in_flight_tools"] = []
                state["tool_start_time"] = None

            # Filter out non-model steps and internal tool output dumps
            if step_type in ("USER_INPUT", "CHECKPOINT", "GENERIC", "SYSTEM_MESSAGE"):
                continue

            if step_type == "ERROR_MESSAGE":
                state["in_flight_tools"] = []
                state["tool_start_time"] = None
                err_msg = data.get("error") or data.get("message") or data.get("content") or ""
                m_attempt = re.search(r"attempt\s+(\d+)", err_msg, re.IGNORECASE)
                if m_attempt or is_transient_error(err_msg):
                    attempt_str = f"（第 {m_attempt.group(1)} 次重试）" if m_attempt else ""
                    sys.stderr.write(f"\n⏳ [远端模型服务容量紧张/排队中，Antigravity 正在自动退避重试{attempt_str}，请稍候...]\n\n")
                    sys.stderr.flush()
                    idle_count = 0  # 收到语言服务器重试事件说明后台持续活跃，重置空闲计数
                    continue
                last_error_message = err_msg
                continue

            if source == "MODEL" and step_type == "PLANNER_RESPONSE":
                last_error_message = ""
                state["in_flight_tools"] = []
                state["tool_start_time"] = None

                # Render tool action badges if any tools were invoked
                if tool_calls:
                    t_names = [tc.get("name", "tool") for tc in tool_calls]
                    has_ask = any(tc.get("name") == "ask_question" for tc in tool_calls)
                    if has_ask:
                        state["waiting_user_input"] = True
                        state["in_flight_tools"] = []
                        state["tool_start_time"] = None
                    else:
                        state["in_flight_tools"] = t_names
                        state["tool_start_time"] = time.time()

                    for tc in tool_calls:
                        tc_name = tc.get("name", "tool")
                        tc_args = tc.get("args") or {}
                        if isinstance(tc_args, str):
                            try:
                                tc_args = json.loads(tc_args)
                            except Exception:
                                tc_args = {}
                        if tc_name == "manage_task" and tc_args.get("Action") in ("kill", "stop", "cancel"):
                            target_tid = str(tc_args.get("TaskId") or "")
                            for bg_tid in list(active_background_tasks):
                                if target_tid and (target_tid in bg_tid or bg_tid in target_tid or target_tid.split("/")[-1] == bg_tid.split("/")[-1]):
                                    active_background_tasks.discard(bg_tid)
                                    tid_c = bg_tid.split("/")[-1]
                                    sys.stderr.write(f"\n⏹️ [后台任务 {tid_c} 已由 Agent 主动终止]\n\n")
                                    sys.stderr.flush()
                                    idle_count = 0

                        if tc_name == "ask_question":
                            # ask_question_interactive marker
                            q_args = tc_args.get("questions") or []
                            if q_args and isinstance(q_args, list):
                                q_item = q_args[0]
                                q_text = q_item.get("question") or "请选择或确认下一步操作"
                                q_options = q_item.get("options") or []
                                q_multi = bool(q_item.get("is_multi_select", False))
                            else:
                                q_text = tc_args.get("question") or "请选择或确认下一步操作"
                                q_options = tc_args.get("options") or []
                                q_multi = bool(tc_args.get("is_multi_select", False))

                            q_id = tc.get("id") or f"agy_q_{int(time.time()*1000)}"
                            q_event = {
                                "type": "memento_event",
                                "event": {
                                    "kind": "question",
                                    "id": q_id,
                                    "tool": "ask_question",
                                    "question": q_text,
                                    "options": q_options,
                                    "is_multi_select": q_multi,
                                    "status": "waiting",
                                }
                            }
                            sys.stdout.write(f"\n{json.dumps(q_event, ensure_ascii=False)}\n")
                            sys.stdout.flush()

                        action = tc_args.get("toolAction") or tc_args.get("toolSummary") or tc_name
                        if isinstance(action, str):
                            action = action.strip('"\'')
                        sys.stdout.write(f"\n\n⚡ [{action}]\n\n")
                        sys.stdout.flush()

                # Render assistant content
                if content and content.strip():
                    sys.stdout.write(content.strip() + "\n\n")
                    sys.stdout.flush()

                    if not tool_calls:
                        if not active_background_tasks and not state.get("waiting_user_input"):
                            # Final response produced and no active background task, turn completed!
                            completed = True
                            break
                        elif active_background_tasks:
                            # 只要后台任务仍在运行（is_waiting_transition），模型输出的所有过渡提示均保持流式展示，坚决不提前退出
                            is_waiting_transition = True
                            tid_names = ", ".join(t.split("/")[-1] for t in active_background_tasks)
                            sys.stderr.write(f"\n⏳ [后台任务 {tid_names} 持续执行中，持续追踪进度...]\n\n")
                            sys.stderr.flush()
                            idle_count = 0

    if not completed:
        sys.exit(124)


if __name__ == "__main__":
    main()

