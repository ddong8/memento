"""Git diff review, hidden turn checkpoint restore, and one-click commit/push/PR API.

Supports both:
1) Native WS RPC (`git_diff_req` / `git_checkpoint_restore_req` / `git_commit_push_pr_req`) on daemons >= 1.0.158
   (or daemons advertising the `git_review` capability feature).
2) Automatic zero-upgrade fallback via ephemeral `gitrpc-*` shell dispatch on older daemons (e.g. 1.0.157 and earlier),
   so diff review, recent commit inspection, and one-click commit/push/PR work immediately without waiting for every
   device to update.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shlex
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services import device_reports
from ..services.enterprise_policy import sees_all
from ..services.user_filter import find_machine_by_id_or_hash, user_machine_ids
from ..services.ws_manager import ws_manager

router = APIRouter(prefix="/api/git", tags=["git"])
logger = logging.getLogger("server.git_review")

_SAFE_REF_RE = re.compile(r"^(?:HEAD|refs/memento/checkpoints/[A-Za-z0-9._/-]+|[0-9a-fA-F]{7,40})$")
_SAFE_CHECKPOINT_REF_RE = re.compile(r"^refs/memento/checkpoints/[A-Za-z0-9._/-]+$")
_CHECKPOINT_PREFIX = "refs/memento/checkpoints/"
_MAX_DIFF_BYTES_PER_FILE = 180 * 1024
_MAX_TOTAL_DIFF_BYTES = 1_200 * 1024
_MIN_NATIVE_VERSION = (1, 0, 158)


class GitDiffRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    cwd: str = Field(..., min_length=1)
    base_ref: str | None = None
    target_ref: str | None = None
    file_path: str | None = None


class GitRestoreRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    cwd: str = Field(..., min_length=1)
    target_ref: str = Field(..., min_length=1)


class GitDeliverRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    cwd: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1, max_length=4000)
    files: list[str] | None = None
    push: bool = False
    create_pr: bool = False
    pr_title: str | None = None
    pr_body: str | None = None
    pr_base: str | None = None


def _parse_version(raw: str | None) -> tuple[int, ...]:
    if not raw:
        return ()
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", str(raw))
    if not m:
        return ()
    return tuple(int(p) for p in m.groups())


def _device_supports_native_git(machine: Machine, user: User) -> bool:
    """True when the device daemon implements native `git_*_req` WebSocket handlers."""
    if device_reports.device_has_feature(machine.name, "git_review", user):
        return True
    ver = _parse_version(getattr(machine, "collector_version", None))
    return bool(ver and ver >= _MIN_NATIVE_VERSION)


def _is_windows_device(machine: Machine, user: User, cwd: str) -> bool:
    caps = device_reports.get_cached_device_capabilities(machine.name, user=user)
    env = caps.get("environment") if isinstance(caps, dict) else None
    plat = str(env.get("platform") or "").lower() if isinstance(env, dict) else ""
    if plat == "win32":
        return True
    if plat in ("darwin", "linux"):
        return False
    if re.match(r"^[A-Za-z]:[\\/]", cwd or ""):
        return True
    return "windows" in (machine.name or "").lower()


def _ps_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def parse_unified_diff(raw: str) -> list[dict]:
    """Parse standard `git diff --unified=3` output into structured per-file hunks & numbered lines."""
    files: list[dict] = []
    if not raw or not raw.strip():
        return files

    current: dict | None = None
    current_hunk: dict | None = None
    old_line = 0
    new_line = 0
    file_bytes = 0

    def _flush_hunk() -> None:
        nonlocal current_hunk
        if current is not None and current_hunk is not None:
            current["hunks"].append(current_hunk)
            current_hunk = None

    def _flush_file() -> None:
        nonlocal current
        _flush_hunk()
        if current is not None:
            files.append(current)
            current = None

    for line in raw.splitlines():
        if line.startswith("diff --git "):
            _flush_file()
            m = re.match(r"^diff --git a/(.+?) b/(.+)$", line)
            old_p = m.group(1).strip('"') if m else ""
            new_p = m.group(2).strip('"') if m else ""
            current = {
                "path": new_p or old_p,
                **({"old_path": old_p} if old_p and new_p and old_p != new_p else {}),
                "status": "M",
                "additions": 0,
                "deletions": 0,
                "binary": False,
                "hunks": [],
            }
            file_bytes = 0
            continue
        if current is None:
            continue
        if line.startswith("new file mode "):
            current["status"] = "A"
            continue
        if line.startswith("deleted file mode "):
            current["status"] = "D"
            continue
        if line.startswith("rename from "):
            current["status"] = "R"
            current["old_path"] = line[len("rename from "):].strip()
            continue
        if line.startswith("rename to "):
            current["status"] = "R"
            current["path"] = line[len("rename to "):].strip()
            continue
        if line.startswith("Binary files ") or line == "GIT binary patch":
            current["binary"] = True
            continue
        if line.startswith(("--- ", "+++ ", "index ", "similarity index ", "old mode ", "new mode ")):
            continue
        if line.startswith("@@ "):
            _flush_hunk()
            hm = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$", line)
            if hm:
                old_line = int(hm.group(1))
                old_count = int(hm.group(2)) if hm.group(2) is not None else 1
                new_line = int(hm.group(3))
                new_count = int(hm.group(4)) if hm.group(4) is not None else 1
                current_hunk = {
                    "header": line,
                    "old_start": old_line,
                    "old_lines": old_count,
                    "new_start": new_line,
                    "new_lines": new_count,
                    "lines": [],
                }
            continue
        if current_hunk is None:
            continue
        if line.startswith("\\ No newline at end of file"):
            continue

        file_bytes += len(line) + 1
        if file_bytes > _MAX_DIFF_BYTES_PER_FILE:
            current["truncated"] = True
            continue

        if line.startswith("+"):
            current["additions"] += 1
            current_hunk["lines"].append({
                "type": "add", "old_line": None, "new_line": new_line, "content": line[1:],
            })
            new_line += 1
        elif line.startswith("-"):
            current["deletions"] += 1
            current_hunk["lines"].append({
                "type": "del", "old_line": old_line, "new_line": None, "content": line[1:],
            })
            old_line += 1
        elif line.startswith(" "):
            current_hunk["lines"].append({
                "type": "context", "old_line": old_line, "new_line": new_line, "content": line[1:],
            })
            old_line += 1
            new_line += 1

    _flush_file()
    return files


async def _resolve_device(db: AsyncSession, device_id: str, user: User) -> tuple[Machine, list[str]]:
    """Verify the user may access `device_id` and return (machine, ordered WS identifiers)."""
    raw = (device_id or "").strip()
    if not raw or raw in ("auto", "ask_only", "all"):
        raise HTTPException(status_code=400, detail="请先指定具体设备后再进行 Git 代码审阅或操作")

    machine = await find_machine_by_id_or_hash(db, raw, user)
    if machine is None:
        raise HTTPException(status_code=404, detail="未找到目标设备")

    mids = await user_machine_ids(db, user)
    if not sees_all(user) and mids is not None and machine.id not in mids:
        raise HTTPException(status_code=403, detail="无权访问该设备")

    candidates: list[str] = []
    for cand in (machine.collector_token_hash, raw, machine.name, str(machine.id)):
        if cand and cand not in candidates:
            candidates.append(cand)
    return machine, candidates


async def _rpc_device(candidates: list[str], payload: dict, *, timeout: float) -> dict:
    """Send a native Git RPC frame to the first reachable alias of the target device."""
    last_resp: dict | None = None
    for cand in candidates:
        resp = await ws_manager.request_device(cand, payload, timeout=timeout)
        last_resp = resp
        if resp.get("code") != "offline":
            return resp
    return last_resp or {"ok": False, "error": "目标设备当前不在线", "code": "offline"}


async def _run_ephemeral_shell(
    candidates: list[str], cwd: str, command: str, *, timeout: float = 25.0,
) -> tuple[int, str, str, str | None]:
    """Run a fast ephemeral shell task (`gitrpc-*`) on an older daemon over WebSocket.

    Returns (exit_code, stdout, stderr, transport_error_code_or_None).
    """
    tid = f"gitrpc-{uuid.uuid4().hex[:12]}"
    q = await ws_manager.subscribe_task(tid)
    try:
        dispatched = False
        task_payload = {
            "id": tid,
            "action": "shell",
            "payload": {"command": command, "cwd": cwd},
            "timeout_seconds": max(15, int(timeout)),
        }
        for cand in candidates:
            if await ws_manager.send_task(cand, task_payload):
                dispatched = True
                break
        if not dispatched:
            return 1, "", "目标设备当前不在线", "offline"

        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        stdout_len = 0
        stderr_len = 0
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            rem = deadline - asyncio.get_running_loop().time()
            if rem <= 0:
                return 124, "".join(stdout_chunks), "设备执行 Git 命令超时", "timeout"
            try:
                evt = await asyncio.wait_for(q.get(), timeout=rem)
            except asyncio.TimeoutError:
                return 124, "".join(stdout_chunks), "设备执行 Git 命令超时", "timeout"
            etype = evt.get("type")
            if etype == "task_chunk":
                txt = str(evt.get("text") or "")
                if evt.get("stream") == "stderr":
                    if stderr_len < 120_000:
                        stderr_chunks.append(txt)
                        stderr_len += len(txt)
                else:
                    if stdout_len < _MAX_TOTAL_DIFF_BYTES + 200_000:
                        stdout_chunks.append(txt)
                        stdout_len += len(txt)
            elif etype == "task_finished":
                res = evt.get("result") or {}
                exit_code = int(res.get("exit_code") if res.get("exit_code") is not None else (0 if res.get("status") == "succeeded" else 1))
                out = "".join(stdout_chunks) or str(res.get("stdout") or "")
                err = "".join(stderr_chunks) or str(res.get("stderr") or res.get("error") or "")
                return exit_code, out, err, None
    finally:
        await ws_manager.unsubscribe_task(tid)


def _split_sections(raw: str, markers: list[str]) -> dict[str, str]:
    positions: list[tuple[int, int, str]] = []
    for mk in markers:
        idx = raw.find(mk)
        if idx >= 0:
            positions.append((idx, idx + len(mk), mk))
    positions.sort()
    out: dict[str, str] = {}
    for i, (_start, body_start, mk) in enumerate(positions):
        end = positions[i + 1][0] if i + 1 < len(positions) else len(raw)
        out[mk] = raw[body_start:end].lstrip("\r\n")
    return out


def _build_posix_diff_cmd(base_ref: str, target_ref: str, file_path: str) -> str:
    path_tail = f" -- {shlex.quote(file_path)}" if file_path else ""
    if base_ref and target_ref:
        diff_cmd = f"git -c core.quotePath=false diff --no-color --unified=3 -M {shlex.quote(base_ref)} {shlex.quote(target_ref)}{path_tail}"
        untracked_cmd = ""
    elif target_ref:
        diff_cmd = f"git -c core.quotePath=false show --format= --no-color --unified=3 -M {shlex.quote(target_ref)}{path_tail}"
        untracked_cmd = ""
    else:
        diff_cmd = (
            f"if git rev-parse --verify HEAD >/dev/null 2>&1; then "
            f"git -c core.quotePath=false diff --no-color --unified=3 -M HEAD{path_tail}; "
            f"else git -c core.quotePath=false diff --no-color --unified=3 -M{path_tail}; fi"
        )
        untracked_cmd = (
            f"git -c core.quotePath=false ls-files --others --exclude-standard{path_tail} | head -n 30 | "
            "while IFS= read -r f; do "
            '  [ -f "$f" ] || continue; '
            '  sz=$(wc -c < "$f" 2>/dev/null || echo 999999); '
            '  printf "===M_UFILE===%s\\t%s\\n" "$f" "$sz"; '
            '  if [ "$sz" -le 49152 ]; then head -c 49152 "$f"; fi; '
            '  printf "\\n===M_UEND===\\n"; '
            "done"
        )

    lines = [
        'ROOT=$(git -c core.quotePath=false rev-parse --show-toplevel 2>/dev/null) || { echo "NOT_A_GIT_REPO"; exit 2; }',
        'cd "$ROOT" || exit 2',
        'echo "===M_META==="',
        'printf "%s\\n" "$ROOT"',
        'git symbolic-ref --short HEAD 2>/dev/null || echo "HEAD"',
        'git rev-parse --verify HEAD 2>/dev/null || echo ""',
        'echo "===M_STATUS==="',
        'git -c core.quotePath=false status --porcelain 2>/dev/null || true',
        'echo "===M_COMMITS==="',
        'git -c core.quotePath=false log -n 12 --format="%H%x09%P%x09%h%x09%s%x09%cI" 2>/dev/null || true',
        'echo "===M_CHECKPOINTS==="',
        'git for-each-ref --sort=-committerdate --format="%(refname)%09%(committerdate:iso-strict)" refs/memento/checkpoints/ 2>/dev/null || true',
        'echo "===M_DIFF==="',
        diff_cmd,
    ]
    if untracked_cmd:
        lines += ['echo "===M_UNTRACKED==="', untracked_cmd]
    return "\n".join(lines)


def _build_windows_diff_cmd(base_ref: str, target_ref: str, file_path: str) -> str:
    path_tail = f" -- {_ps_quote(file_path)}" if file_path else ""
    if base_ref and target_ref:
        diff_cmd = f"git -c core.quotePath=false diff --no-color --unified=3 -M {_ps_quote(base_ref)} {_ps_quote(target_ref)}{path_tail}"
        untracked_cmd = ""
    elif target_ref:
        diff_cmd = f"git -c core.quotePath=false show --format= --no-color --unified=3 -M {_ps_quote(target_ref)}{path_tail}"
        untracked_cmd = ""
    else:
        diff_cmd = (
            f"git rev-parse --verify HEAD *>$null; if ($LASTEXITCODE -eq 0) {{ "
            f"git -c core.quotePath=false diff --no-color --unified=3 -M HEAD{path_tail} "
            f"}} else {{ git -c core.quotePath=false diff --no-color --unified=3 -M{path_tail} }}"
        )
        untracked_cmd = (
            f"$uf = git -c core.quotePath=false ls-files --others --exclude-standard{path_tail} | Select-Object -First 30; "
            "foreach ($f in $uf) { if (Test-Path -LiteralPath $f -PathType Leaf) { "
            "$sz = (Get-Item -LiteralPath $f).Length; Write-Output \"===M_UFILE===$f`t$sz\"; "
            "if ($sz -le 49152) { Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue }; "
            "Write-Output '===M_UEND===' } }"
        )
    parts = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
        "$root = (git -c core.quotePath=false rev-parse --show-toplevel 2>$null); if ($LASTEXITCODE -ne 0 -or -not $root) { Write-Output 'NOT_A_GIT_REPO'; exit 2 };",
        "Set-Location -LiteralPath $root;",
        "Write-Output '===M_META==='; Write-Output $root;",
        "$br = (git symbolic-ref --short HEAD 2>$null); if ($LASTEXITCODE -ne 0 -or -not $br) { $br = 'HEAD' }; Write-Output $br;",
        "$hd = (git rev-parse --verify HEAD 2>$null); if ($LASTEXITCODE -ne 0) { $hd = '' }; Write-Output $hd;",
        "Write-Output '===M_STATUS==='; git -c core.quotePath=false status --porcelain 2>$null;",
        "Write-Output '===M_COMMITS==='; git -c core.quotePath=false log -n 12 --format='%H%x09%P%x09%h%x09%s%x09%cI' 2>$null;",
        "Write-Output '===M_CHECKPOINTS==='; git for-each-ref --sort=-committerdate --format='%(refname)%09%(committerdate:iso-strict)' refs/memento/checkpoints/ 2>$null;",
        f"Write-Output '===M_DIFF==='; {diff_cmd};",
    ]
    if untracked_cmd:
        parts.append(f"Write-Output '===M_UNTRACKED==='; {untracked_cmd};")
    return " ".join(parts)


def _parse_untracked_section(raw: str) -> list[dict]:
    if not raw or "===M_UFILE===" not in raw:
        return []
    out: list[dict] = []
    for block in raw.split("===M_UFILE===")[1:]:
        body, *_ = block.split("===M_UEND===", 1)
        first_nl = body.find("\n")
        if first_nl < 0:
            header, content = body.strip(), ""
        else:
            header, content = body[:first_nl].strip(), body[first_nl + 1:]
        parts = header.split("\t")
        path = parts[0].strip()
        if not path:
            continue
        try:
            size = int(parts[1].strip()) if len(parts) > 1 else len(content.encode("utf-8", errors="ignore"))
        except ValueError:
            size = 0
        if size > 49_152:
            out.append({"path": path, "status": "A", "additions": 0, "deletions": 0, "binary": False, "truncated": True, "hunks": []})
            continue
        if "\x00" in content[:4096]:
            out.append({"path": path, "status": "A", "additions": 0, "deletions": 0, "binary": True, "hunks": []})
            continue
        lines = content.replace("\r\n", "\n").split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        diff_lines = [{"type": "add", "old_line": None, "new_line": idx + 1, "content": ln} for idx, ln in enumerate(lines)]
        out.append({
            "path": path,
            "status": "A",
            "additions": len(diff_lines),
            "deletions": 0,
            "binary": False,
            "hunks": (
                [{
                    "header": f"@@ -0,0 +1,{len(diff_lines)} @@ (new file)",
                    "old_start": 0,
                    "old_lines": 0,
                    "new_start": 1,
                    "new_lines": len(diff_lines),
                    "lines": diff_lines,
                }]
                if diff_lines
                else []
            ),
        })
    return out


def _parse_checkpoints_section(raw: str) -> list[dict]:
    by_id: dict[str, dict] = {}
    for line in (raw or "").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        ref = parts[0].strip()
        dt = parts[1].strip() if len(parts) > 1 else ""
        if not ref.startswith(_CHECKPOINT_PREFIX):
            continue
        segs = ref[len(_CHECKPOINT_PREFIX):].split("/")
        if len(segs) < 2 or segs[1] not in ("before", "after"):
            continue
        cid, kind = segs[0], segs[1]
        entry = by_id.setdefault(cid, {"id": cid})
        if kind == "before":
            entry["before_ref"] = ref
            if dt and "created_at" not in entry:
                entry["created_at"] = dt
        else:
            entry["after_ref"] = ref
            if dt:
                entry["created_at"] = dt
    return [e for e in by_id.values() if e.get("before_ref") and e.get("after_ref")][:30]


def _parse_commits_section(raw: str) -> list[dict]:
    commits: list[dict] = []
    for line in (raw or "").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        sha = parts[0].strip() if parts else ""
        if not sha:
            continue
        parents = (parts[1].strip() if len(parts) > 1 else "").split()
        short_sha = parts[2].strip() if len(parts) > 2 else sha[:8]
        subject = parts[3].strip() if len(parts) > 3 else ""
        dt = parts[4].strip() if len(parts) > 4 else ""
        commits.append({
            "sha": sha,
            "parent_sha": parents[0] if parents else "",
            "short_sha": short_sha,
            "subject": subject,
            "created_at": dt or None,
        })
    return commits


async def _fallback_git_diff(
    candidates: list[str],
    machine: Machine,
    user: User,
    cwd: str,
    base_ref: str,
    target_ref: str,
    file_path: str,
) -> dict:
    is_win = _is_windows_device(machine, user, cwd)
    cmd = (
        _build_windows_diff_cmd(base_ref, target_ref, file_path)
        if is_win
        else _build_posix_diff_cmd(base_ref, target_ref, file_path)
    )
    code, stdout, stderr, err_code = await _run_ephemeral_shell(candidates, cwd, cmd, timeout=25.0)
    if err_code == "offline":
        raise HTTPException(status_code=503, detail="目标设备当前不在线")
    if err_code == "timeout":
        raise HTTPException(status_code=504, detail="获取 Git Diff 超时，请确认设备运行正常")
    if "NOT_A_GIT_REPO" in stdout or (code == 2 and "===M_META===" not in stdout):
        raise HTTPException(status_code=400, detail="当前目录不是 Git 仓库")
    if "===M_META===" not in stdout:
        detail = (stderr or stdout).strip()[:300] or "获取 Git Diff 失败"
        raise HTTPException(status_code=400, detail=detail)

    sections = _split_sections(
        stdout,
        ["===M_META===", "===M_STATUS===", "===M_COMMITS===", "===M_CHECKPOINTS===", "===M_DIFF===", "===M_UNTRACKED==="],
    )
    meta_lines = sections.get("===M_META===", "").splitlines()
    repo_root = meta_lines[0].strip() if len(meta_lines) > 0 else cwd
    branch = meta_lines[1].strip() if len(meta_lines) > 1 and meta_lines[1].strip() else "HEAD"
    head_sha = meta_lines[2].strip() if len(meta_lines) > 2 else ""

    raw_diff = sections.get("===M_DIFF===", "")
    truncated = False
    if len(raw_diff) > _MAX_TOTAL_DIFF_BYTES:
        raw_diff = raw_diff[:_MAX_TOTAL_DIFF_BYTES]
        truncated = True

    files = parse_unified_diff(raw_diff) + _parse_untracked_section(sections.get("===M_UNTRACKED===", ""))
    total_add = sum(int(f.get("additions") or 0) for f in files)
    total_del = sum(int(f.get("deletions") or 0) for f in files)

    return {
        "ok": True,
        "repo_root": repo_root,
        "branch": branch,
        "head_sha": head_sha,
        "is_dirty": bool(sections.get("===M_STATUS===", "").strip()),
        "base_ref": base_ref or ("HEAD" if head_sha else ""),
        "target_ref": target_ref or "WORKING_TREE",
        "total_files": len(files),
        "total_additions": total_add,
        "total_deletions": total_del,
        "truncated": truncated,
        "files": files,
        "checkpoints": _parse_checkpoints_section(sections.get("===M_CHECKPOINTS===", "")),
        "recent_commits": _parse_commits_section(sections.get("===M_COMMITS===", "")),
        "legacy_fallback": True,
        "client_version": getattr(machine, "collector_version", None),
    }


async def _fallback_git_deliver(
    candidates: list[str],
    machine: Machine,
    user: User,
    body: GitDeliverRequest,
) -> dict:
    cwd = body.cwd.strip()
    message = body.message.strip()
    selected = [f.strip() for f in (body.files or []) if f and f.strip()]
    do_push = bool(body.push or body.create_pr)
    is_win = _is_windows_device(machine, user, cwd)

    if is_win:
        q = _ps_quote
        add_cmd = (
            "git add -- " + " ".join(q(f) for f in selected)
            if selected
            else "git add -A"
        )
        parts = [
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
            "$root = (git rev-parse --show-toplevel 2>$null); if ($LASTEXITCODE -ne 0 -or -not $root) { Write-Output 'ERR:当前目录不是 Git 仓库'; exit 2 };",
            "Set-Location -LiteralPath $root;",
            "$br = (git symbolic-ref --short HEAD 2>$null); if (-not $br) { $br = 'HEAD' };",
            f"{add_cmd}; if ($LASTEXITCODE -ne 0) {{ Write-Output 'ERR:暂存改动失败'; exit 3 }};",
            "$st = (git diff --cached --name-only);",
            f"if ($st) {{ git commit -m {q(message)}; if ($LASTEXITCODE -ne 0) {{ Write-Output 'ERR:提交失败'; exit 4 }} }}",
            "elseif (-not $" + ("true" if do_push else "false") + ") { Write-Output 'ERR:没有可提交的改动'; exit 5 };",
            "$sha = (git rev-parse HEAD 2>$null); Write-Output \"META:$root|$br|$sha\";",
        ]
        if do_push:
            parts.append("git push -u origin $br; if ($LASTEXITCODE -ne 0) { Write-Output 'ERR:推送远端失败'; exit 6 }; Write-Output 'PUSHED:1';")
        if body.create_pr:
            pr_title = (body.pr_title or message.splitlines()[0]).strip()
            pr_body = (body.pr_body or "由 Memento 一键创建。").strip()
            base_opt = f" --base {q(body.pr_base.strip())}" if body.pr_base and body.pr_base.strip() else ""
            parts.append(f"$prOut = (gh pr create --title {q(pr_title)} --body {q(pr_body)}{base_opt} 2>&1 | Out-String); Write-Output \"PR_OUT:$prOut\";")
        cmd = " ".join(parts)
    else:
        add_cmd = (
            "git add -- " + " ".join(shlex.quote(f) for f in selected)
            if selected
            else "git add -A"
        )
        lines = [
            'ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "ERR:当前目录不是 Git 仓库"; exit 2; }',
            'cd "$ROOT" || exit 2',
            'BR=$(git symbolic-ref --short HEAD 2>/dev/null || echo "HEAD")',
            f'{add_cmd} || {{ echo "ERR:暂存改动失败"; exit 3; }}',
            'if [ -n "$(git diff --cached --name-only)" ]; then',
            f'  git commit -m {shlex.quote(message)} || {{ echo "ERR:提交失败"; exit 4; }}',
            'else',
            f'  {"true" if do_push else "echo ERR:没有可提交的改动; exit 5"}',
            'fi',
            'SHA=$(git rev-parse HEAD 2>/dev/null || echo "")',
            'echo "META:${ROOT}|${BR}|${SHA}"',
        ]
        if do_push:
            lines.append('git push -u origin "$BR" || { echo "ERR:推送远端失败"; exit 6; }')
            lines.append('echo "PUSHED:1"')
        if body.create_pr:
            pr_title = (body.pr_title or message.splitlines()[0]).strip()
            pr_body = (body.pr_body or "由 Memento 一键创建。").strip()
            base_opt = f" --base {shlex.quote(body.pr_base.strip())}" if body.pr_base and body.pr_base.strip() else ""
            lines.append(f'PR_OUT=$(gh pr create --title {shlex.quote(pr_title)} --body {shlex.quote(pr_body)}{base_opt} 2>&1 || true)')
            lines.append('echo "PR_OUT:${PR_OUT}"')
        cmd = "\n".join(lines)

    code, stdout, stderr, err_code = await _run_ephemeral_shell(candidates, cwd, cmd, timeout=70.0)
    if err_code == "offline":
        raise HTTPException(status_code=503, detail="目标设备当前不在线")
    if err_code == "timeout":
        raise HTTPException(status_code=504, detail="提交/推送超时")

    meta_m = re.search(r"META:([^|\r\n]*)\|([^|\r\n]*)\|([0-9a-fA-F]*)", stdout)
    repo_root = meta_m.group(1) if meta_m else cwd
    branch = meta_m.group(2) if meta_m else "HEAD"
    commit_sha = meta_m.group(3) if meta_m else ""
    pushed = "PUSHED:1" in stdout

    if code != 0:
        err_m = re.search(r"ERR:([^\r\n]+)", stdout)
        detail = err_m.group(1) if err_m else ((stderr or stdout).strip()[:300] or "Git 交付失败")
        if commit_sha:
            return {
                "ok": False,
                "repo_root": repo_root,
                "branch": branch,
                "commit_sha": commit_sha,
                "pushed": pushed,
                "error": detail,
            }
        raise HTTPException(status_code=400, detail=detail)

    pr_url = None
    pr_error = None
    if body.create_pr:
        pr_idx = stdout.find("PR_OUT:")
        pr_raw = stdout[pr_idx + len("PR_OUT:"):].strip() if pr_idx >= 0 else ""
        url_m = re.search(r"https://[^\s]+", pr_raw)
        if url_m:
            pr_url = url_m.group(0)
        else:
            pr_error = pr_raw[:300] or "创建 PR 失败（请确认目标设备已安装并登录 gh CLI）"

    summary_parts: list[str] = []
    if commit_sha:
        summary_parts.append(f"已提交 {commit_sha[:8]}")
    if pushed:
        summary_parts.append(f"已推送到 origin/{branch}")
    if pr_url:
        summary_parts.append("已创建 PR")

    return {
        "ok": not pr_error,
        "repo_root": repo_root,
        "branch": branch,
        "commit_sha": commit_sha,
        "pushed": pushed,
        "pr_url": pr_url,
        "pr_error": pr_error,
        "summary": " · ".join(summary_parts) or "操作完成",
        **({"error": pr_error} if pr_error else {}),
        "legacy_fallback": True,
    }


@router.post("/diff")
async def git_diff(
    body: GitDiffRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Fetch structured per-file diffs (working tree, recent commit, or hidden checkpoint) from a device."""
    base_ref = (body.base_ref or "").strip()
    target_ref = (body.target_ref or "").strip()
    file_path = (body.file_path or "").strip()
    if base_ref and not _SAFE_REF_RE.match(base_ref):
        raise HTTPException(status_code=400, detail=f"非法 base_ref：{base_ref}")
    if target_ref and not _SAFE_REF_RE.match(target_ref):
        raise HTTPException(status_code=400, detail=f"非法 target_ref：{target_ref}")
    if "\x00" in file_path:
        raise HTTPException(status_code=400, detail="非法文件路径")

    machine, candidates = await _resolve_device(db, body.device_id, _user)

    if not _device_supports_native_git(machine, _user):
        return await _fallback_git_diff(candidates, machine, _user, body.cwd.strip(), base_ref, target_ref, file_path)

    payload: dict = {"type": "git_diff_req", "cwd": body.cwd.strip()}
    if base_ref:
        payload["base_ref"] = base_ref
    if target_ref:
        payload["target_ref"] = target_ref
    if file_path:
        payload["file_path"] = file_path

    resp = await _rpc_device(candidates, payload, timeout=15.0)
    # If collector_version in DB was ahead of the actual running WS process, fall back seamlessly instead of 504
    if resp.get("code") == "timeout" and not device_reports.device_has_feature(machine.name, "git_review", _user):
        logger.info("Native git_diff_req timed out on %s without git_review feature; falling back to shell", machine.name)
        return await _fallback_git_diff(candidates, machine, _user, body.cwd.strip(), base_ref, target_ref, file_path)
    if resp.get("code") == "offline":
        raise HTTPException(status_code=503, detail=resp.get("error") or "目标设备当前不在线")
    if resp.get("code") == "timeout":
        raise HTTPException(status_code=504, detail=resp.get("error") or "获取 Diff 超时")
    if not resp.get("ok"):
        raise HTTPException(status_code=400, detail=resp.get("error") or "获取 Git Diff 失败")
    return resp


@router.post("/checkpoint/restore")
async def git_checkpoint_restore(
    body: GitRestoreRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Safely restore a device's working tree to a hidden Memento checkpoint ref."""
    target_ref = body.target_ref.strip()
    if not _SAFE_CHECKPOINT_REF_RE.match(target_ref):
        raise HTTPException(status_code=400, detail="仅允许回滚到 Memento 隐藏检查点（refs/memento/checkpoints/...）")

    machine, candidates = await _resolve_device(db, body.device_id, _user)
    if not _device_supports_native_git(machine, _user):
        ver = getattr(machine, "collector_version", None) or "旧版本"
        raise HTTPException(
            status_code=409,
            detail=f"设备「{machine.name}」当前 Memento 版本为 {ver}，升级到 1.0.158 及以上即可使用回合检查点一键回滚",
        )

    resp = await _rpc_device(
        candidates,
        {"type": "git_checkpoint_restore_req", "cwd": body.cwd.strip(), "target_ref": target_ref},
        timeout=35.0,
    )
    if resp.get("code") == "offline":
        raise HTTPException(status_code=503, detail=resp.get("error") or "目标设备当前不在线")
    if resp.get("code") == "timeout":
        raise HTTPException(status_code=504, detail=resp.get("error") or "回滚检查点超时")
    if not resp.get("ok"):
        raise HTTPException(status_code=400, detail=resp.get("error") or "回滚检查点失败")
    return resp


@router.post("/deliver")
async def git_deliver(
    body: GitDeliverRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Stage, commit, optionally push, and optionally create a GitHub PR on a device."""
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="提交信息不能为空")

    machine, candidates = await _resolve_device(db, body.device_id, _user)
    if not _device_supports_native_git(machine, _user):
        return await _fallback_git_deliver(candidates, machine, _user, body)

    payload: dict = {
        "type": "git_commit_push_pr_req",
        "cwd": body.cwd.strip(),
        "message": message,
        "push": bool(body.push or body.create_pr),
        "create_pr": bool(body.create_pr),
    }
    if body.files:
        payload["files"] = [f.strip() for f in body.files if f and f.strip()]
    if body.pr_title:
        payload["pr_title"] = body.pr_title.strip()
    if body.pr_body:
        payload["pr_body"] = body.pr_body.strip()
    if body.pr_base:
        payload["pr_base"] = body.pr_base.strip()

    resp = await _rpc_device(candidates, payload, timeout=70.0)
    if resp.get("code") == "offline":
        raise HTTPException(status_code=503, detail=resp.get("error") or "目标设备当前不在线")
    if resp.get("code") == "timeout":
        raise HTTPException(status_code=504, detail=resp.get("error") or "提交/推送超时")
    if not resp.get("ok") and not resp.get("commit_sha"):
        raise HTTPException(status_code=400, detail=resp.get("error") or "Git 交付失败")
    return resp


# ── AI-written commit message / PR description ───────────────────────────────────────────────────

class GitSuggestRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    cwd: str = Field(..., min_length=1)
    base_ref: str | None = None
    target_ref: str | None = None
    # Only these files (what the user ticked for the commit); all changed files when empty
    files: list[str] | None = None


_SUGGEST_DIFF_CHARS = 14_000
_COMMIT_RULE_RE = re.compile(r"提交|commit|Commit|PR|尾注|Co-Authored|Conventional|中文")


def diff_for_prompt(diff: dict, files: list[str] | None = None, limit: int = _SUGGEST_DIFF_CHARS) -> str:
    """The device's structured diff back to compact unified text for the model, cut at `limit` characters
    (whole files first; the rest only named, so a huge change still says what it touched)."""
    wanted = {f.strip() for f in (files or []) if f and f.strip()}
    out: list[str] = []
    skipped: list[str] = []
    used = 0
    for f in diff.get("files") or []:
        path = str(f.get("path") or "")
        if wanted and path not in wanted:
            continue
        head = f"--- {f.get('status') or 'M'} {path} (+{f.get('additions', 0)} -{f.get('deletions', 0)})"
        if f.get("binary"):
            body = "（二进制文件）"
        else:
            rows: list[str] = []
            for h in f.get("hunks") or []:
                rows.append(str(h.get("header") or "@@"))
                for ln in h.get("lines") or []:
                    mark = {"add": "+", "del": "-"}.get(ln.get("type"), " ")
                    rows.append(f"{mark}{ln.get('content', '')}")
            body = "\n".join(rows)
        block = f"{head}\n{body}"
        if used + len(block) > limit:
            skipped.append(f"{path} (+{f.get('additions', 0)} -{f.get('deletions', 0)})")
            continue
        out.append(block)
        used += len(block)
    if skipped:
        out.append("其余改动（内容太长未列出）：" + "、".join(skipped))
    return "\n\n".join(out)


def commit_rules_from_guidance(guidance: str, limit: int = 2_000) -> str:
    """Just the lines of the user's rules about commits / PRs (the full guidance is far too long for this)."""
    lines = [ln.strip() for ln in (guidance or "").splitlines() if _COMMIT_RULE_RE.search(ln)]
    text = "\n".join(dict.fromkeys(ln for ln in lines if ln))
    return text[:limit]


def parse_suggestion(raw: str) -> dict:
    """The model's JSON ({message, pr_title, pr_body}); a reply that isn't JSON becomes the commit message."""
    import json

    text = (raw or "").strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            data = json.loads(m.group(0))
            msg = str(data.get("message") or "").strip()
            if msg:
                return {
                    "message": msg,
                    "pr_title": str(data.get("pr_title") or msg.splitlines()[0]).strip(),
                    "pr_body": str(data.get("pr_body") or "").strip(),
                }
        except (ValueError, AttributeError):
            pass
    first = text.strip("`").strip()
    return {"message": first, "pr_title": first.splitlines()[0] if first else "", "pr_body": ""}


# Agent credits a model likes to add: the user's rule is no co-author trailers in their commits
_TRAILER_RE = re.compile(r"^\s*(Co-Authored-By:.*|🤖 Generated with.*|Generated (with|by) .*)$", re.IGNORECASE | re.MULTILINE)


def strip_agent_trailers(text: str) -> str:
    return _TRAILER_RE.sub("", text or "").strip()


@router.post("/suggest-message")
async def git_suggest_message(
    body: GitSuggestRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Write the commit message (and a PR title / description) for the changes on a device with the user's own
    model, in the repository's style and following the user's rules about commits."""
    from ..services.ai_provider import call_plain_chat
    from ..services.orchestrator_tools import _run_check_rules

    diff = await git_diff(
        GitDiffRequest(device_id=body.device_id, cwd=body.cwd, base_ref=body.base_ref, target_ref=body.target_ref),
        db=db, _user=_user,
    )
    diff_text = diff_for_prompt(diff, body.files)
    if not diff_text.strip():
        raise HTTPException(status_code=400, detail="没有可描述的改动")

    recent = [str(c.get("subject") or "") for c in (diff.get("recent_commits") or [])[:12] if c.get("subject")]
    try:
        guidance = (await _run_check_rules(db, _user, {"action_type": "git commit", "details": "写提交说明和 PR 描述"})).get("guidance", "")
    except Exception:
        logger.warning("Couldn't read the user's rules for a commit message", exc_info=True)
        guidance = ""
    rules = commit_rules_from_guidance(guidance)

    system = (
        "你是资深工程师，为一组代码改动写 git 提交说明和 PR。只输出一个 JSON 对象："
        '{"message": "提交说明（第一行是标题，可空一行后写正文要点）", "pr_title": "PR 标题", "pr_body": "PR 描述（Markdown，改了什么、为什么、怎么验证）"}。'
        "风格跟仓库最近的提交保持一致（语言、前缀格式、长度）；只写改动里确实有的内容，不编造；"
        "不要加任何 Co-Authored-By、Generated with 之类的署名尾注。"
    )
    user_msg = (
        (f"用户关于提交的规则：\n{rules}\n\n" if rules else "")
        + ("仓库最近的提交标题：\n" + "\n".join(f"- {s}" for s in recent) + "\n\n" if recent else "")
        + f"当前分支：{diff.get('branch') or '未知'}\n\n改动：\n{diff_text}"
    )
    raw = await call_plain_chat(
        [{"role": "system", "content": system}, {"role": "user", "content": user_msg}],
        temperature=0.2, max_tokens=1200, timeout=90.0, user=_user, background=False,
    )
    if not raw:
        raise HTTPException(status_code=502, detail="模型没有返回内容，检查个人设置里的大模型配置")
    out = parse_suggestion(raw)
    return {
        "message": strip_agent_trailers(out["message"]),
        "pr_title": strip_agent_trailers(out["pr_title"]),
        "pr_body": strip_agent_trailers(out["pr_body"]),
        "branch": diff.get("branch"),
    }


# ── Pull requests (GitHub, through the `gh` CLI signed in on the device) ────────────────────────────

class GitPrListRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    cwd: str = Field(..., min_length=1)
    state: str = "open"  # open | closed | merged | all


class GitPrRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    cwd: str = Field(..., min_length=1)
    number: int = Field(..., ge=1)


class GitPrMergeRequest(GitPrRequest):
    # rebase keeps the history linear (the user's rule); squash for a one-commit change; merge if asked
    method: str = "rebase"
    delete_branch: bool = True


_PR_LIST_FIELDS = "number,title,author,headRefName,baseRefName,isDraft,updatedAt,url,reviewDecision,statusCheckRollup,additions,deletions"
_PR_VIEW_FIELDS = (
    "number,title,body,author,state,isDraft,headRefName,baseRefName,url,mergeable,mergeStateStatus,reviewDecision,"
    "statusCheckRollup,files,comments,commits,additions,deletions,updatedAt"
)
_PR_DIFF_CHARS = 400_000


def summarize_checks(rollup: list | None) -> dict:
    """GitHub's statusCheckRollup (check runs and commit statuses mixed) as counts and one overall state:
    pending while anything runs, failure once anything failed, success when all passed, none without checks."""
    passed = failed = pending = 0
    for c in rollup or []:
        status = str(c.get("status") or "").upper()  # check runs: QUEUED / IN_PROGRESS / COMPLETED
        conclusion = str(c.get("conclusion") or c.get("state") or "").upper()  # statuses carry `state`
        if status and status != "COMPLETED":
            pending += 1
        elif conclusion in ("SUCCESS", "NEUTRAL", "SKIPPED"):
            passed += 1
        elif conclusion in ("PENDING", "EXPECTED", ""):
            pending += 1
        else:
            failed += 1
    total = passed + failed + pending
    state = "none" if not total else "failure" if failed else "pending" if pending else "success"
    return {"state": state, "passed": passed, "failed": failed, "pending": pending, "total": total}


async def _gh(body_device: str, cwd: str, args: str, db: AsyncSession, user: User, *, timeout: float = 30.0) -> str:
    """Run `gh <args>` in the repo on the device; stdout, or an HTTP error with gh's own message."""
    _machine, candidates = await _resolve_device(db, body_device, user)
    code, out, err, transport = await _run_ephemeral_shell(candidates, cwd.strip(), f"gh {args}", timeout=timeout)
    if transport == "offline":
        raise HTTPException(status_code=503, detail="目标设备当前不在线")
    if transport == "timeout":
        raise HTTPException(status_code=504, detail="设备上的 gh 命令超时")
    if code != 0:
        msg = (err or out or "").strip()
        if "not found" in msg and "gh" in msg or "不是内部或外部命令" in msg or "is not recognized" in msg:
            msg = "设备上没有安装 GitHub CLI（gh），装好并 gh auth login 后再试"
        elif "auth login" in msg:
            msg = "设备上的 gh 还没登录 GitHub，在设备上运行 gh auth login 后再试"
        raise HTTPException(status_code=400, detail=msg[:500] or "gh 命令失败")
    return out


def _json_or_400(raw: str):
    import json

    try:
        return json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=502, detail="gh 返回的不是 JSON") from None


@router.post("/prs")
async def git_pr_list(body: GitPrListRequest, db: AsyncSession = Depends(get_db), _user: User = Depends(get_current_user)):
    """The repository's pull requests with their CI state, newest activity first."""
    state = body.state if body.state in ("open", "closed", "merged", "all") else "open"
    rows = _json_or_400(await _gh(body.device_id, body.cwd, f"pr list --state {state} --limit 40 --json {_PR_LIST_FIELDS}", db, _user))
    for r in rows:
        r["checks"] = summarize_checks(r.pop("statusCheckRollup", None))
        r["author"] = (r.get("author") or {}).get("login", "")
    return {"prs": rows}


@router.post("/pr")
async def git_pr_view(body: GitPrRequest, db: AsyncSession = Depends(get_db), _user: User = Depends(get_current_user)):
    """One pull request: description, checks, files, comments, commits and its diff."""
    pr = _json_or_400(await _gh(body.device_id, body.cwd, f"pr view {body.number} --json {_PR_VIEW_FIELDS}", db, _user))
    rollup = pr.pop("statusCheckRollup", None) or []
    pr["checks"] = summarize_checks(rollup)
    pr["check_runs"] = [
        {"name": c.get("name") or c.get("context") or "", "status": c.get("status") or "", "conclusion": c.get("conclusion") or c.get("state") or "",
         "url": c.get("detailsUrl") or c.get("targetUrl") or ""}
        for c in rollup
    ]
    pr["author"] = (pr.get("author") or {}).get("login", "")
    try:
        diff = await _gh(body.device_id, body.cwd, f"pr diff {body.number}", db, _user, timeout=45.0)
    except HTTPException:
        diff = ""
    pr["diff"] = diff[:_PR_DIFF_CHARS]
    pr["diff_truncated"] = len(diff) > _PR_DIFF_CHARS
    return pr


@router.post("/pr/merge")
async def git_pr_merge(body: GitPrMergeRequest, db: AsyncSession = Depends(get_db), _user: User = Depends(get_current_user)):
    method = body.method if body.method in ("rebase", "squash", "merge") else "rebase"
    out = await _gh(
        body.device_id, body.cwd, f"pr merge {body.number} --{method}{' --delete-branch' if body.delete_branch else ''}", db, _user, timeout=60.0,
    )
    return {"ok": True, "method": method, "output": out.strip()[:2000]}


async def _watch_pr_checks(user: User, device_id: str, cwd: str, number: int, *, interval: float = 60.0, max_wait: float = 3 * 3600) -> str:
    """Poll the PR's checks until none is pending, then push the result to the user's phone. One per PR at a
    time across replicas (a lock in Redis); gives up after `max_wait`."""
    from ..db.session import async_session_factory
    from ..services import notify_service
    from ..services.cluster import cluster

    key = f"memento:prwatch:{user.id}:{device_id}:{cwd}:{number}"
    if not await cluster.try_lock(key, int(max_wait) + 300):
        return "already"
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max_wait
    title = f"PR #{number}"
    while loop.time() < deadline:
        try:
            async with async_session_factory() as db:
                pr = _json_or_400(await _gh(device_id, cwd, f"pr view {number} --json number,title,url,statusCheckRollup", db, user))
        except HTTPException as e:
            if e.status_code in (503, 504):  # device asleep / slow: try again next round
                await asyncio.sleep(interval)
                continue
            return "error"
        title = f"PR #{number} {pr.get('title') or ''}".strip()
        checks = summarize_checks(pr.get("statusCheckRollup"))
        if checks["state"] in ("success", "failure", "none"):
            if checks["state"] == "success":
                await notify_service.notify_user(user.id, "task_done", "CI 通过", f"{title}：{checks['passed']} 项检查全部通过", url=pr.get("url"))
            elif checks["state"] == "failure":
                await notify_service.notify_user(user.id, "risky", "CI 失败", f"{title}：{checks['failed']} 项检查失败", url=pr.get("url"))
            return checks["state"]
        await asyncio.sleep(interval)
    await notify_service.notify_user(user.id, "task_done", "CI 还没跑完", f"{title}：等了 {int(max_wait // 3600)} 小时，停止盯了")
    return "timeout"


@router.post("/pr/watch-checks")
async def git_pr_watch_checks(body: GitPrRequest, _user: User = Depends(get_current_user)):
    """Keep an eye on the PR's CI and push the result to the phone when it finishes."""
    from ..services import notify_service

    notify_service.spawn(_watch_pr_checks(_user, body.device_id, body.cwd, body.number))
    return {"ok": True}


# ── projects with several repositories ───────────────────────────────────────────────────────────

class GitReposRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    cwd: str = Field(..., min_length=1)


def repos_command(cwd: str, windows: bool) -> str:
    """Lists the git repositories in `cwd` (itself, and up to two levels down), one root per line."""
    if windows:
        p = _ps_quote(cwd)
        return (
            f"$r = {p}; if (Test-Path (Join-Path $r '.git')) {{ $r }}; "
            f"Get-ChildItem -LiteralPath $r -Directory -Recurse -Depth 2 -Force -Filter .git -ErrorAction SilentlyContinue | "
            "Where-Object { $_.FullName -notmatch '\\\\node_modules\\\\' } | Select-Object -First 50 | ForEach-Object { $_.Parent.FullName }"
        )
    q = shlex.quote(cwd)
    return f"cd {q} 2>/dev/null && find . -maxdepth 3 -name node_modules -prune -o -name .git -print 2>/dev/null | head -50"


def parse_repo_roots(out: str, cwd: str, windows: bool) -> list[str]:
    """Absolute repo roots from repos_command's output, `cwd` first when it is one, no duplicates."""
    roots: list[str] = []
    base = cwd.rstrip("/\\")
    for line in out.splitlines():
        s = line.strip()
        if not s:
            continue
        if not windows:
            # "./.git" -> cwd, "./web/.git" -> cwd/web
            s = s[:-len("/.git")] if s.endswith("/.git") else s
            s = base if s in (".", "") else f"{base}/{s[2:] if s.startswith('./') else s}"
        if s not in roots:
            roots.append(s)
    roots.sort(key=lambda r: (r != base, r.lower()))
    return roots


@router.post("/repos")
async def git_repos(body: GitReposRequest, db: AsyncSession = Depends(get_db), _user: User = Depends(get_current_user)):
    """The git repositories in a project folder (a project may hold several: web, server, ...)."""
    machine, candidates = await _resolve_device(db, body.device_id, _user)
    windows = _is_windows_device(machine, _user, body.cwd)
    code, out, err, transport = await _run_ephemeral_shell(candidates, body.cwd.strip(), repos_command(body.cwd.strip(), windows), timeout=20.0)
    if transport == "offline":
        raise HTTPException(status_code=503, detail="目标设备当前不在线")
    if transport == "timeout":
        raise HTTPException(status_code=504, detail="查找仓库超时")
    return {"repos": parse_repo_roots(out, body.cwd.strip(), windows)}
