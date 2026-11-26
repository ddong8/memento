"""Git diff review, hidden turn checkpoint restore, and one-click commit/push/PR API."""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.enterprise_policy import sees_all
from ..services.user_filter import find_machine_by_id_or_hash, user_machine_ids
from ..services.ws_manager import ws_manager

router = APIRouter(prefix="/api/git", tags=["git"])
logger = logging.getLogger("server.git_review")

_SAFE_CHECKPOINT_REF_RE = re.compile(r"^refs/memento/checkpoints/[A-Za-z0-9._/-]+$")


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


async def _resolve_device_candidates(db: AsyncSession, device_id: str, user: User) -> list[str]:
    """Verify the user may access `device_id` and return ordered WS identifiers to try."""
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
    return candidates


async def _rpc_device(candidates: list[str], payload: dict, *, timeout: float) -> dict:
    """Send a Git RPC frame to the first reachable alias of the target device."""
    last_resp: dict | None = None
    for cand in candidates:
        resp = await ws_manager.request_device(cand, payload, timeout=timeout)
        last_resp = resp
        if resp.get("code") != "offline":
            return resp
    return last_resp or {"ok": False, "error": "目标设备当前不在线", "code": "offline"}


@router.post("/diff")
async def git_diff(
    body: GitDiffRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Fetch structured per-file diffs (working tree or hidden turn checkpoint) from a device."""
    candidates = await _resolve_device_candidates(db, body.device_id, _user)
    payload: dict = {
        "type": "git_diff_req",
        "cwd": body.cwd.strip(),
    }
    if body.base_ref:
        payload["base_ref"] = body.base_ref.strip()
    if body.target_ref:
        payload["target_ref"] = body.target_ref.strip()
    if body.file_path:
        payload["file_path"] = body.file_path.strip()

    resp = await _rpc_device(candidates, payload, timeout=35.0)
    if resp.get("code") == "offline":
        raise HTTPException(status_code=503, detail=resp.get("error") or "目标设备不在线")
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

    candidates = await _resolve_device_candidates(db, body.device_id, _user)
    resp = await _rpc_device(
        candidates,
        {
            "type": "git_checkpoint_restore_req",
            "cwd": body.cwd.strip(),
            "target_ref": target_ref,
        },
        timeout=40.0,
    )
    if resp.get("code") == "offline":
        raise HTTPException(status_code=503, detail=resp.get("error") or "目标设备不在线")
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

    candidates = await _resolve_device_candidates(db, body.device_id, _user)
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

    resp = await _rpc_device(candidates, payload, timeout=75.0)
    if resp.get("code") == "offline":
        raise HTTPException(status_code=503, detail=resp.get("error") or "目标设备不在线")
    if resp.get("code") == "timeout":
        raise HTTPException(status_code=504, detail=resp.get("error") or "提交/推送超时")
    if not resp.get("ok") and not resp.get("commit_sha"):
        raise HTTPException(status_code=400, detail=resp.get("error") or "Git 交付失败")
    return resp
