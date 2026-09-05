"""Remote task executor — runs work dispatched by the server on this device.

The collector already polls the server for control commands (resync/update).
This module handles the parameterized task queue on top of that same
pull-based channel: fetch queued tasks, run them, post results back.

Two actions:

  shell — run a command line via the platform shell.
  agent — run a headless coding agent (``claude -p``) on a prompt, so work
          can be delegated to whichever machine has the relevant checkout.

Opt-in
------
This is OFF unless the operator sets MEMENTO_REMOTE_EXEC_KEY on this device.
Without that key the executor never polls, so a collector installed from
PyPI does nothing new by default — remote execution requires deliberate
configuration on BOTH the server and the device.

The key is deliberately separate from the collector sync token: the sync
token lives in a config file and travels on every upload, and a leaked
read-only sync token must not escalate to arbitrary execution.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys

import httpx

from .config import CollectorConfig
from .tls import SSL_CONTEXT

logger = logging.getLogger(__name__)

# Cap what we upload. The server truncates too, but sending a multi-hundred-MB
# body from a runaway process would waste the device's uplink first.
MAX_OUTPUT_CHARS = 100_000

# Absolute ceiling regardless of what the server asks for, so a bad dispatch
# can't pin a device forever.
MAX_TIMEOUT_SECONDS = 24 * 3600


def remote_exec_key() -> str:
    return os.environ.get("MEMENTO_REMOTE_EXEC_KEY", "").strip()


def is_enabled() -> bool:
    return bool(remote_exec_key())


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n...(输出已截断，共 {len(text)} 字符)"


def _run_shell(payload: dict, timeout: int) -> dict:
    command = (payload or {}).get("command") or ""
    if not command.strip():
        return {"status": "failed", "error": "empty command"}
    cwd = (payload or {}).get("cwd") or None
    if cwd and not os.path.isdir(cwd):
        return {"status": "failed", "error": f"cwd not found: {cwd}"}

    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            # Inherit the user's environment: the point of remote execution is
            # to run things exactly as the operator would in their own shell.
            env=os.environ.copy(),
        )
        return {
            "status": "succeeded" if proc.returncode == 0 else "failed",
            "exit_code": proc.returncode,
            "stdout": _truncate(proc.stdout or ""),
            "stderr": _truncate(proc.stderr or ""),
        }
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "error": f"timed out after {timeout}s"}
    except Exception as e:
        return {"status": "failed", "error": f"{type(e).__name__}: {e}"}


def _run_agent(payload: dict, timeout: int) -> dict:
    """Run a headless coding agent on a prompt.

    Uses `claude -p` (non-interactive print mode). The binary must already be
    installed and authenticated on this device — the collector deliberately
    does not ship or manage agent credentials.
    """
    prompt = (payload or {}).get("prompt") or ""
    if not prompt.strip():
        return {"status": "failed", "error": "empty prompt"}

    binary = (payload or {}).get("binary") or "claude"
    resolved = shutil.which(binary)
    if not resolved:
        return {"status": "failed", "error": f"agent binary not found on PATH: {binary}"}

    cwd = (payload or {}).get("cwd") or None
    if cwd and not os.path.isdir(cwd):
        return {"status": "failed", "error": f"cwd not found: {cwd}"}

    cmd = [resolved, "-p", prompt]
    model = (payload or {}).get("model")
    if model:
        cmd += ["--model", model]
    # Optional spend ceiling — a long agent run on someone else's machine
    # should be boundable by the person dispatching it.
    budget = (payload or {}).get("max_budget_usd")
    if budget:
        cmd += ["--max-budget-usd", str(budget)]
    extra = (payload or {}).get("args")
    if isinstance(extra, list):
        cmd += [str(a) for a in extra]

    try:
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True,
            timeout=timeout, env=os.environ.copy(),
        )
        return {
            "status": "succeeded" if proc.returncode == 0 else "failed",
            "exit_code": proc.returncode,
            "stdout": _truncate(proc.stdout or ""),
            "stderr": _truncate(proc.stderr or ""),
        }
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "error": f"agent timed out after {timeout}s"}
    except Exception as e:
        return {"status": "failed", "error": f"{type(e).__name__}: {e}"}


HANDLERS = {"shell": _run_shell, "agent": _run_agent}


def _post_result(config: CollectorConfig, task_id: str, result: dict) -> None:
    try:
        httpx.post(
            f"{config.server.url}/api/tasks/{task_id}/result",
            headers={
                "X-Collector-Token": config.server.token,
                "X-Remote-Exec-Key": remote_exec_key(),
            },
            json=result,
            timeout=30,
            verify=SSL_CONTEXT,
        )
    except Exception as e:
        # The task already ran; losing the result is bad but not fatal — the
        # server will show it stuck in `running` rather than claim success.
        logger.warning("failed to post result for task %s: %s", task_id, e)


def poll_and_run(config: CollectorConfig) -> None:
    """Fetch queued tasks for this device, run them, report back.

    Called from the main loop on the same cadence as the control-command poll.
    Never raises — a failure here must not take down file syncing.
    """
    if not is_enabled():
        return
    try:
        resp = httpx.get(
            f"{config.server.url}/api/tasks/poll/{config.device_id}",
            headers={
                "X-Collector-Token": config.server.token,
                "X-Remote-Exec-Key": remote_exec_key(),
            },
            timeout=15,
            verify=SSL_CONTEXT,
        )
        if resp.status_code == 403:
            logger.warning("remote exec rejected by server (key mismatch or disabled)")
            return
        if resp.status_code != 200:
            return
        tasks = resp.json() or []
    except Exception:
        return  # Server unreachable — try again next tick.

    for task in tasks:
        task_id = task.get("id")
        action = task.get("action")
        handler = HANDLERS.get(action)
        if not handler:
            # resync/update are handled by the legacy command path, not here.
            continue
        timeout = min(int(task.get("timeout_seconds") or 300), MAX_TIMEOUT_SECONDS)
        logger.info("running remote task %s (%s)", task_id, action)
        try:
            result = handler(task.get("payload") or {}, timeout)
        except Exception as e:
            result = {"status": "failed", "error": f"executor error: {type(e).__name__}: {e}"}
        logger.info("remote task %s -> %s", task_id, result.get("status"))
        _post_result(config, task_id, result)
