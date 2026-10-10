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


def main():
    parser = argparse.ArgumentParser(description="Antigravity CLI Runner")
    parser.add_argument("-p", "--prompt", dest="prompt_flag", help="Prompt to send to Antigravity")
    parser.add_argument("--resume", dest="resume_id", default="", help="Resume an existing conversation by ID")
    parser.add_argument("--model", dest="model", default="", help="Model tier: flash_lite, flash, or pro")
    parser.add_argument("--title", dest="title", default="", help="Conversation title")
    parser.add_argument("--timeout", type=int, default=1800, help="Timeout in seconds")
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

    # Normalize model tier
    model_arg = (args.model or "").lower().strip()
    if model_arg in ("flash_lite", "flash-lite", "gemini-3.6-flash", "gemini-2.5-flash-lite"):
        model = "flash_lite"
    elif model_arg in ("pro", "gemini-3.1-pro", "gemini-2.5-pro", "claude-sonnet-4-6", "claude-opus-4-6", "claude-3-7-sonnet"):
        model = "pro"
    elif model_arg in ("flash", "gemini-3.8-flash", "gemini-3.7-flash"):
        model = "flash"
    else:
        model = "flash"

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
        # Start new conversation
        cmd = [
            str(agentapi),
            "new-conversation",
            f"--model={model}",
            f"--title={title}",
            prompt,
        ]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ))
            if res.returncode != 0:
                err_text = (res.stderr or res.stdout or "").strip()
                print(f"Error initiating conversation via Antigravity: {err_text}", file=sys.stderr)
                sys.exit(1)
            out_json = json.loads(res.stdout)
            conv_id = out_json["response"]["newConversation"]["conversationId"]
        except Exception as e:
            print(f"Error initiating conversation via Antigravity: {e}", file=sys.stderr)
            sys.exit(1)

    sys.stderr.write(f"session id: {conv_id}\n")
    sys.stderr.flush()

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
    tasks_dir = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "tasks"

    with open(transcript_file, "r", encoding="utf-8") as f:
        if start_pos > 0:
            f.seek(start_pos)

        while True:
            if time.time() - start_time > args.timeout:
                if active_background_tasks:
                    tid_names = ", ".join(t.split("/")[-1] for t in active_background_tasks)
                    sys.stdout.write(f"\n[STATUS_STILL_RUNNING: tasks={tid_names}]\n")
                    sys.stderr.write(f"\n⏳ [任务在后台持续执行中（{tid_names}），达到单次等待上限（{args.timeout}s），保持后台运行]\n")
                    sys.stdout.flush()
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
                if last_error_message and idle_count > 75:  # 15s idle after error
                    sys.stderr.write(f"\nAntigravity Error: {last_error_message}\n")
                    sys.stderr.flush()
                    sys.exit(1)
                if idle_count > 900:  # 180s (3 minutes) idle timeout
                    if active_background_tasks:
                        tid_names = ", ".join(t.split("/")[-1] for t in active_background_tasks)
                        sys.stdout.write(f"\n[STATUS_STILL_RUNNING: tasks={tid_names}]\n")
                        sys.stderr.write(f"\n⏳ [后台任务（{tid_names}）持续运行中，达到单次轮询等待上限（180s），已安全转入后台监控]\n")
                        sys.stdout.flush()
                        sys.stderr.flush()
                        completed = True
                        break
                    else:
                        sys.stderr.write("\n[Agent timeout: 任务空闲超过 180s 无响应]\n")
                        sys.stderr.flush()
                        sys.exit(124)
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
            content = data.get("content") or ""
            tool_calls = data.get("tool_calls") or []

            # Check if any background task was spawned
            m_bg = re.search(r"(?:Tool is running as a background task with task id|Command running in background with ID|Task running in background with ID):\s*([^\s\n\r]+)", content)
            if m_bg:
                bg_tid = m_bg.group(1).strip()
                active_background_tasks.add(bg_tid)
                tid_clean = bg_tid.split("/")[-1]
                sys.stdout.write(f"\n⏳ [后台任务启动: {tid_clean}，持续追踪执行进度...]\n\n")
                sys.stdout.flush()
                idle_count = 0

            # Check if any active background task finished, failed, or was canceled
            for bg_tid in list(active_background_tasks):
                tid_clean = bg_tid.split("/")[-1]
                matched = (tid_clean in content or bg_tid in content)
                is_finished = matched and any(kw in content for kw in (
                    "finished with result", "The command exited with code", "Timer fired", "Status: DONE"
                ))
                is_canceled = matched and any(kw in content for kw in (
                    "was canceled", "was cancelled", "Tool execution was canceled",
                    "Tool execution was cancelled", "cancelled", "canceled",
                    "Status: CANCELLED", "Status: CANCELED", "Status: ERROR", "Status: FAILED",
                    "failed with result", "terminated", "killed"
                ))
                if is_finished or is_canceled:
                    active_background_tasks.discard(bg_tid)
                    status_desc = "已取消/终止" if is_canceled else "执行完毕，已接收运行结果"
                    icon = "⏹️" if is_canceled else "✅"
                    sys.stdout.write(f"\n{icon} [后台任务 {tid_clean} {status_desc}]\n\n")
                    sys.stdout.flush()
                    idle_count = 0
                elif tasks_dir.exists():
                    log_path = tasks_dir / f"{tid_clean}.log"
                    if log_path.exists():
                        try:
                            if log_path.stat().st_size > 0:
                                with open(log_path, "rb") as lf:
                                    lf.seek(max(0, log_path.stat().st_size - 1024))
                                    tail_bytes = lf.read().decode("utf-8", errors="ignore")
                                    if any(kw in tail_bytes for kw in (
                                        "The command exited with code", "Timer fired",
                                        "was canceled", "cancelled", "canceled", "Terminated", "Killed"
                                    )):
                                        active_background_tasks.discard(bg_tid)
                                        sys.stdout.write(f"\n✅ [后台任务 {tid_clean} 执行完毕/已结束]\n\n")
                                        sys.stdout.flush()
                                        idle_count = 0
                        except Exception:
                            pass

            # Filter out non-model steps and internal tool output dumps
            if step_type in ("USER_INPUT", "CHECKPOINT", "GENERIC", "SYSTEM_MESSAGE"):
                continue

            if step_type == "ERROR_MESSAGE":
                err_msg = data.get("error") or data.get("message") or data.get("content") or ""
                # Filter out transient API retry messages (e.g. attempt 1 failure) where Antigravity retries upstream
                is_transient = any(kw in err_msg.lower() for kw in (
                    "attempt 1", "attempt 2", "connection reset", "eof", "broken pipe",
                    "timeout", "handshake", "temporarily unavailable"
                ))
                if is_transient:
                    continue
                last_error_message = err_msg
                continue

            if source == "MODEL" and step_type == "PLANNER_RESPONSE":
                last_error_message = ""
                # Render tool action badges if any tools were invoked
                if tool_calls:
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
                                    sys.stdout.write(f"\n⏹️ [后台任务 {tid_c} 已由 Agent 主动终止]\n\n")
                                    sys.stdout.flush()
                                    idle_count = 0

                        action = tc_args.get("toolAction") or tc_args.get("toolSummary") or tc_name
                        if isinstance(action, str):
                            action = action.strip('"\'')
                        sys.stdout.write(f"\n⚡ [{action}]\n")
                        sys.stdout.flush()

                # Render assistant content
                if content and content.strip():
                    sys.stdout.write(content.strip() + "\n\n")
                    sys.stdout.flush()

                    if not tool_calls:
                        if not active_background_tasks:
                            # Final response produced and no active background task, turn completed!
                            completed = True
                            break
                        else:
                            trimmed_c = content.strip()
                            # Check whether this message is a brief transitional waiting notification
                            is_waiting_transition = (
                                len(trimmed_c) < 120 and
                                any(wkw in trimmed_c for wkw in (
                                    "正在等待", "稍后", "请稍候", "持续追踪", "waiting for", "等待后台", "等待执行"
                                ))
                            )
                            if not is_waiting_transition:
                                # Substantive final answer produced by model, turn logically completed!
                                tid_names = ", ".join(t.split("/")[-1] for t in active_background_tasks)
                                sys.stdout.write(f"\n[STATUS_STILL_RUNNING: tasks={tid_names}]\n")
                                sys.stderr.write(f"\n⏳ [本轮答复已输出，部分任务仍保持后台运行（{tid_names}）]\n")
                                sys.stdout.flush()
                                sys.stderr.flush()
                                completed = True
                                break
                            else:
                                tid_names = ", ".join(t.split("/")[-1] for t in active_background_tasks)
                                sys.stdout.write(f"\n⏳ [等待后台任务 {tid_names} 完成...]\n\n")
                                sys.stdout.flush()
                                idle_count = 0

    if not completed:
        sys.exit(124)


if __name__ == "__main__":
    main()

