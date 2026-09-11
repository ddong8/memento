"""WebSocket client for real-time task dispatch and chunk streaming.

Maintains an asynchronous full-duplex connection to the Memento server.
When a task is pushed down, runs the subprocess and streams stdout/stderr
chunks in real-time back to the server, enabling sub-second latency and
live terminal printing on the web UI.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import threading
import urllib.parse
from typing import Any

from .config import CollectorConfig
from .executor import build_subprocess_env, enroll, is_enabled, remote_exec_key
from .tls import SSL_CONTEXT

logger = logging.getLogger(__name__)

# Active subprocesses keyed by task_id for cancellation
_running_tasks: dict[str, asyncio.subprocess.Process] = {}


def _kill_subprocess(proc: asyncio.subprocess.Process, sig: int = signal.SIGTERM) -> None:
    """Kill process and its entire process group if on POSIX."""
    try:
        if os.name != "nt":
            os.killpg(os.getpgid(proc.pid), sig)
        else:
            proc.send_signal(sig)
    except (ProcessLookupError, OSError):
        try:
            if sig == signal.SIGKILL:
                proc.kill()
            else:
                proc.terminate()
        except Exception:
            pass



def _to_ws_url(http_url: str, device_id: str, token: str, key: str) -> str:
    parsed = urllib.parse.urlparse(http_url)
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    netloc = parsed.netloc
    path = f"{parsed.path.rstrip('/')}/api/tasks/ws/{device_id}"
    query = urllib.parse.urlencode({"token": token, "key": key})
    return f"{ws_scheme}://{netloc}{path}?{query}"


async def _stream_pipe(stream: asyncio.StreamReader | None, name: str, task_id: str,
                       ws: Any, accumulator: list[str]) -> None:
    if stream is None:
        return
    while True:
        chunk = await stream.read(1024)
        if not chunk:
            break
        text = chunk.decode("utf-8", errors="replace")
        accumulator.append(text)
        try:
            await ws.send(json.dumps({
                "type": "task_chunk",
                "task_id": task_id,
                "stream": name,
                "text": text,
            }))
        except Exception:
            break


async def _execute_task_stream(ws: Any, task_id: str, action: str, payload: dict[str, Any],
                               timeout: int) -> None:
    raw_cwd = payload.get("cwd")
    cwd = None
    if raw_cwd:
        s = str(raw_cwd).strip()
        import re
        match = re.search(r"((?:[a-zA-Z]:[/\\]|/)[a-zA-Z0-9_\.\-]+(?:[/\\][a-zA-Z0-9_\.\-]+)*)", s)
        candidate = os.path.expanduser(match.group(1).rstrip("/\\")) if match else os.path.expanduser(s.split("\n")[0].split('"')[0].strip().rstrip("/\\"))
        if os.path.isdir(candidate):
            cwd = candidate
        elif os.path.isdir(os.path.expanduser(s)):
            cwd = os.path.expanduser(s)
        else:
            logger.warning("Cwd path '%s' not found on this machine; falling back to default working directory", raw_cwd)
            cwd = None

    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    try:
        extra_kwargs: dict[str, Any] = {}
        if os.name != "nt":
            extra_kwargs["start_new_session"] = True

        if action == "shell":
            command = payload.get("command") or ""
            if not command.strip():
                raise ValueError("empty command")

            proc = await asyncio.create_subprocess_shell(
                command,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=build_subprocess_env(),
                **extra_kwargs,
            )
        elif action == "agent":
            prompt = payload.get("prompt") or ""
            if not prompt.strip():
                raise ValueError("empty prompt")
            binary = str(payload.get("binary") or "claude").strip().lower()
            sub_env = build_subprocess_env()

            # Smart agent resolution
            resolved = None
            if binary in ("claude", "claude-code"):
                resolved = shutil.which("claude", path=sub_env.get("PATH"))
                if not resolved:
                    import glob
                    candidates = glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/claude")) + [
                        os.path.expanduser("~/.fnm/current/bin/claude"),
                        os.path.expanduser("~/.local/bin/claude"),
                    ]
                    for c in candidates:
                        if os.path.isfile(c) and os.access(c, os.X_OK):
                            resolved = c
                            break
                session_id = str(payload.get("session_id") or "").strip()
                model = str(payload.get("model") or "").strip()

                cmd = [resolved, "-p"]
                if session_id:
                    cmd += ["-r", session_id]
                cmd += ["--output-format", "text", "--dangerously-skip-permissions"]
                if model:
                    cmd += ["--model", model]
                cmd += [prompt]

            elif binary in ("codex", "codex-cli"):
                resolved = shutil.which("codex", path=sub_env.get("PATH"))
                if not resolved:
                    import glob
                    candidates = [
                        "/Applications/ChatGPT.app/Contents/Resources/codex",
                        os.path.expanduser("~/.local/bin/codex"),
                    ] + glob.glob(os.path.expanduser("~/.vscode/extensions/openai.chatgpt-*/bin/macos-*/codex")) \
                      + glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/codex"))
                    for c in candidates:
                        if os.path.isfile(c) and os.access(c, os.X_OK):
                            resolved = c
                            break
                if not resolved:
                    raise FileNotFoundError("Codex CLI ('codex') not found on this device.")

                session_id = str(payload.get("session_id") or "").strip()
                model = str(payload.get("model") or "").strip()
                effort = str(payload.get("effort") or "").strip()

                if session_id:
                    cmd = [resolved, "exec", "resume", "--color", "never", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"]
                    if effort:
                        cmd += ["-c", f'model_reasoning_effort="{effort}"']
                    if model:
                        cmd += ["-m", model]
                    cmd += [session_id, prompt]
                else:
                    cmd = [resolved, "exec", "--color", "never", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"]
                    if effort:
                        cmd += ["-c", f'model_reasoning_effort="{effort}"']
                    if model:
                        cmd += ["-m", model]
                    cmd += [prompt]

            elif binary in ("agy", "antigravity"):
                resolved = shutil.which("agy", path=sub_env.get("PATH")) or shutil.which("antigravity", path=sub_env.get("PATH"))
                if not resolved:
                    candidates = [
                        os.path.expanduser("~/.gemini/antigravity/bin/agy_cli.py"),
                        os.path.expanduser("~/.antigravity/antigravity/bin/agy"),
                        "/opt/homebrew/bin/agy",
                    ]
                    for c in candidates:
                        if os.path.isfile(c) and os.access(c, os.X_OK):
                            resolved = c
                            break
                if not resolved:
                    raise FileNotFoundError("Antigravity CLI ('agy') not found on this device.")

                session_id = str(payload.get("session_id") or "").strip()
                model = str(payload.get("model") or "").strip()

                cmd = [resolved]
                if session_id:
                    cmd += ["--resume", session_id]
                if model:
                    cmd += ["--model", model]
                cmd += ["-p", prompt]

            else:
                resolved = shutil.which(binary, path=sub_env.get("PATH"))
                if not resolved:
                    raise FileNotFoundError(f"agent binary not found: {binary}")
                session_id = str(payload.get("session_id") or "").strip()
                model = str(payload.get("model") or "").strip()
                cmd = [resolved]
                if session_id:
                    cmd += ["--resume", session_id]
                if model:
                    cmd += ["--model", model]
                cmd += ["-p", prompt]

            if payload.get("max_budget_usd"):
                cmd += ["--max-budget-usd", str(payload["max_budget_usd"])]
            if isinstance(payload.get("args"), list):
                cmd += [str(a) for a in payload["args"]]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=sub_env,
                **extra_kwargs,
            )
        else:
            raise ValueError(f"unsupported action: {action}")

        _running_tasks[task_id] = proc

        # Stream stdout and stderr concurrently in background tasks
        stream_out_task = asyncio.create_task(
            _stream_pipe(proc.stdout, "stdout", task_id, ws, stdout_chunks)
        )
        stream_err_task = asyncio.create_task(
            _stream_pipe(proc.stderr, "stderr", task_id, ws, stderr_chunks)
        )

        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning("Task %s timed out after %ds, terminating process group", task_id, timeout)
            _kill_subprocess(proc, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                _kill_subprocess(proc, signal.SIGKILL)
            stream_out_task.cancel()
            stream_err_task.cancel()
            await asyncio.gather(stream_out_task, stream_err_task, return_exceptions=True)
            await ws.send(json.dumps({
                "type": "task_finished",
                "task_id": task_id,
                "status": "timeout",
                "exit_code": -1,
                "stdout": "".join(stdout_chunks)[:100_000],
                "stderr": "".join(stderr_chunks)[:100_000],
                "error": f"timed out after {timeout}s",
            }))
            return

        # Wait for streams to finish reading remaining output
        await asyncio.gather(stream_out_task, stream_err_task, return_exceptions=True)

        full_stdout = "".join(stdout_chunks)[:100_000]
        full_stderr = "".join(stderr_chunks)[:100_000]
        status = "succeeded" if proc.returncode == 0 else "failed"

        await ws.send(json.dumps({
            "type": "task_finished",
            "task_id": task_id,
            "status": status,
            "exit_code": proc.returncode,
            "stdout": full_stdout,
            "stderr": full_stderr,
            "error": None if proc.returncode == 0 else f"exit code {proc.returncode}",
        }))
    except Exception as e:
        logger.exception("Task %s failed: %s", task_id, e)
        try:
            await ws.send(json.dumps({
                "type": "task_finished",
                "task_id": task_id,
                "status": "failed",
                "exit_code": 1,
                "stdout": "".join(stdout_chunks)[:100_000],
                "stderr": "".join(stderr_chunks)[:100_000],
                "error": str(e),
            }))
        except Exception:
            pass
    finally:
        _running_tasks.pop(task_id, None)


def _patch_websockets_connection_lost() -> None:
    """Patch websockets Connection.connection_lost to prevent AttributeError on dropped handshake."""
    try:
        from websockets.asyncio.connection import Connection
        orig = getattr(Connection, "connection_lost", None)
        if orig is None:
            return

        def safe_connection_lost(self: Any, exc: Exception | None) -> None:
            if not hasattr(self, "recv_messages"):
                try:
                    if hasattr(self, "protocol"):
                        self.protocol.receive_eof()
                except Exception:
                    pass
                if hasattr(self, "connection_lost_waiter") and not self.connection_lost_waiter.done():
                    self.connection_lost_waiter.set_result(None)
                return
            return orig(self, exc)

        Connection.connection_lost = safe_connection_lost
    except Exception:
        pass


async def _run_ws_loop(config: CollectorConfig) -> None:
    try:
        import websockets
        _patch_websockets_connection_lost()
    except ImportError:
        logger.info("websockets library not installed; remote tasks will use HTTP polling")
        return

    backoff = 2
    while True:
        if not is_enabled():
            enroll(config)
            if not is_enabled():
                await asyncio.sleep(10)
                continue

        key = remote_exec_key()
        ws_url = _to_ws_url(config.server.url, config.device_id, config.server.token, key)
        ssl_ctx = SSL_CONTEXT if ws_url.startswith("wss://") else None
        headers = {
            "X-Collector-Token": config.server.token,
            "X-Remote-Exec-Key": key,
        }

        connect_kwargs: dict[str, Any] = {
            "ssl": ssl_ctx,
            "ping_interval": 20,
            "ping_timeout": 20,
        }
        # websockets >= 13 uses additional_headers, older versions use extra_headers
        try:
            import inspect
            sig = inspect.signature(websockets.connect)
            if "additional_headers" in sig.parameters:
                connect_kwargs["additional_headers"] = headers
            elif "extra_headers" in sig.parameters:
                connect_kwargs["extra_headers"] = headers
        except Exception:
            pass

        try:
            logger.info("Connecting to Memento server WebSocket: %s", config.server.url)
            async with websockets.connect(ws_url, **connect_kwargs) as ws:
                backoff = 2
                logger.info("Connected to Memento server via WebSocket for real-time task streaming")

                # Send discovered local agent capabilities to server
                try:
                    from .agent_capabilities import get_all_agent_capabilities
                    caps = get_all_agent_capabilities()
                    await ws.send(json.dumps({"type": "agent_capabilities", "capabilities": caps}))
                    logger.info("Reported dynamic agent capabilities to server (Codex models: %d)", len(caps.get("codex", {}).get("models", [])))
                except Exception as e:
                    logger.debug("Failed to report agent capabilities: %s", e)

                async for raw_msg in ws:
                    try:
                        msg = json.loads(raw_msg)
                    except Exception:
                        continue

                    mtype = msg.get("type")
                    if mtype == "connected":
                        logger.info("WebSocket handshake verified by server")
                    elif mtype == "get_agent_capabilities":
                        try:
                            from .agent_capabilities import get_all_agent_capabilities
                            caps = get_all_agent_capabilities()
                            await ws.send(json.dumps({"type": "agent_capabilities", "capabilities": caps}))
                        except Exception as e:
                            logger.debug("Failed to answer get_agent_capabilities: %s", e)
                    elif mtype == "task_dispatch":
                        task = msg.get("task") or {}
                        task_id = task.get("id")
                        action = task.get("action")
                        payload = task.get("payload") or {}
                        timeout = min(int(task.get("timeout_seconds") or 300), 86400)
                        logger.info("Received real-time task %s (%s) over WebSocket", task_id, action)
                        # Launch in background so message loop is not blocked
                        asyncio.create_task(
                            _execute_task_stream(ws, task_id, action, payload, timeout)
                        )
                    elif mtype == "task_cancel":
                        task_id = msg.get("task_id")
                        proc = _running_tasks.get(task_id)
                        if proc:
                            logger.info("Received task_cancel for %s, terminating process group", task_id)
                            _kill_subprocess(proc, signal.SIGTERM)
        except Exception as e:
            logger.debug("WebSocket connection closed or failed: %s (reconnecting in %ds)", e, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


def start_ws_client_thread(config: CollectorConfig, main_logger: logging.Logger) -> None:
    """Start WebSocket streaming client in a daemon thread."""
    def _target() -> None:
        try:
            asyncio.run(_run_ws_loop(config))
        except Exception as e:
            main_logger.debug("WebSocket worker terminated: %s", e)

    t = threading.Thread(target=_target, name="memento-ws-client", daemon=True)
    t.start()
