"""Which agent actions are worth telling the user about.

Classification only: nothing here blocks an action. The rules live on the server so
they can be tightened with a deploy, without shipping a new collector. They cover
both agent tool calls reported by devices (Claude Code PreToolUse hook) and shell
commands the orchestrator LLM decides to run.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class RiskFinding:
    label: str   # short Chinese label, used as the push title
    detail: str  # the command or path, truncated
    level: str = "danger"  # "low" | "warn" | "danger" | "critical"
    reasons: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.reasons and self.label:
            object.__setattr__(self, "reasons", [self.label])

    def as_alert(self, tool: str) -> dict[str, str]:
        return {"label": self.label, "detail": self.detail, "tool": tool, "level": self.level}


DETAIL_MAX = 300

# First match wins, so more specific rules come before general ones.
_SHELL_RULES: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(p), label, level) for p, label, level in [
        (r"\bmkfs\b|\bdiskutil\s+(erase|partition)|\bdd\s+if=", "格式化或直接写磁盘", "critical"),
        (r"(?i)\b(drop|truncate)\s+(table|database|schema)\b", "删除数据库表或库", "critical"),
        (r"\bcrontab\s+-r\b", "清空定时任务", "critical"),
        (r"\bgit\s+reset\s+[^;&|\n]*--hard\b", "git reset --hard 丢弃改动", "critical"),
        (r"\bgit\s+branch\s+[^;&|\n]*-D\b", "强制删除分支", "danger"),
        (r"\bgit\s+push\b[^;&|\n]*\s(--force\b|--force-with-lease\b|-f\b)", "强制推送 git", "critical"),
        (r"\bgit\s+push\b", "推送代码到远端", "warn"),
        (r"\bgit\s+clean\s+-[a-zA-Z]*f", "git clean 删除未跟踪文件", "danger"),
        (r"\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)", "丢弃工作区改动", "danger"),
        (r"\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+", "递归或强制删除文件", "danger"),
        (r"\bsudo\s", "以 root 权限执行", "danger"),
        (r"\b(chmod|chown)\s+-R\b", "递归修改文件权限", "danger"),
        (r"\bkubectl\b[^;&|\n]*\s(delete|drain|edit)\b", "删除或修改 Kubernetes 核心集群", "critical"),
        (r"\bkubectl\b[^;&|\n]*\s(apply|replace|patch|scale|rollout|set)\b", "部署更新 Kubernetes 集群", "warn"),
        (r"\bhelm\b[^;&|\n]*\s(uninstall|delete)\b", "删除 Helm 发布", "danger"),
        (r"\bhelm\b[^;&|\n]*\s(install|upgrade|rollback)\b", "操作 Helm 发布", "warn"),
        (r"\bdocker(-compose|\s+compose)?\b[^;&|\n]*\s(system\s+prune|volume\s+(rm|prune)|image\s+prune)\b",
         "批量清理 Docker 卷与镜像", "danger"),
        (r"\bdocker(-compose|\s+compose)?\b[^;&|\n]*\s(rm|rmi|down|kill)\b", "删除或停用 Docker 容器", "warn"),
        (r"\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\b(flutter|dart)\s+pub\s+publish\b"
         r"|\bgh\s+release\s+create\b", "向公共仓库发布软件包", "danger"),
        (r"\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z)?sh\b", "下载并直接执行网络脚本", "critical"),
        (r"(?i)\bdelete\s+from\s+[\w.\"`]+\s*(;|$|\")", "无条件删除表全部数据", "critical"),
        (r"\b(shutdown|reboot|halt)\b", "关机或重启操作系统", "critical"),
        (r"\b(launchctl|systemctl)\s+(stop|disable|unload|bootout|mask)\b", "停用系统关键服务", "danger"),
        (r">\s*/etc/|\btee\s+(-a\s+)?/etc/", "修改系统全局配置", "critical"),
    ]
]

# Files whose change can leak credentials or alter how the machine or its tools behave.
_SENSITIVE_PATH_RULES: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(p, re.IGNORECASE), label, level) for p, label, level in [
        (r"(^|/)\.ssh/|(^|/)(id_rsa|id_ed25519|authorized_keys)$", "修改 SSH 密钥或配置", "critical"),
        (r"(^|/)\.(aws|gnupg|docker)/|(^|/)\.kube/config$|(^|/)\.netrc$|(^|/)\.npmrc$|(^|/)\.pypirc$", "修改全局凭据文件", "critical"),
        (r"(^|/)\.env(\.[\w.-]+)?$", "修改 .env 环境变量文件", "danger"),
        (r"^/etc/|^/private/etc/|/library/launch(agents|daemons)/", "修改系统配置或开机启动项", "critical"),
        (r"(^|/)\.(zshrc|bashrc|bash_profile|profile|zprofile|zshenv)$", "修改 shell 启动脚本", "danger"),
        (r"(^|/)\.claude/settings(\.local)?\.json$|(^|/)\.codex/config\.toml$", "修改 AI 工具配置", "warn"),
    ]
]

_TEMP_DIRS = ("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")
_FILE_TOOLS = {"Write": "file_path", "Edit": "file_path", "MultiEdit": "file_path", "NotebookEdit": "notebook_path"}


def _truncate(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= DETAIL_MAX else text[: DETAIL_MAX - 1] + "…"


def classify_shell_command(command: str | None) -> RiskFinding | None:
    if not command:
        return None
    for pattern, label, level in _SHELL_RULES:
        if pattern.search(command):
            return RiskFinding(label, _truncate(command), level=level)
    return None


def _normalize_path(path: str) -> str:
    return path.replace("\\", "/").rstrip("/")


def _is_windows_path(path: str) -> bool:
    return bool(re.match(r"^[a-zA-Z]:/", path))


def _is_inside(path: str, root: str) -> bool:
    if _is_windows_path(path) or _is_windows_path(root):
        path, root = path.lower(), root.lower()
    return path == root or path.startswith(root + "/")


def classify_file_change(path: str | None, cwd: str | None) -> RiskFinding | None:
    if not path:
        return None
    norm = _normalize_path(path)
    for pattern, label, level in _SENSITIVE_PATH_RULES:
        if pattern.search(norm):
            return RiskFinding(label, _truncate(path), level=level)
    is_absolute = norm.startswith("/") or _is_windows_path(norm)
    if cwd and is_absolute:
        root = _normalize_path(cwd)
        in_temp = any(norm.startswith(t) for t in _TEMP_DIRS)
        if root and not in_temp and not _is_inside(norm, root):
            return RiskFinding("修改工作目录以外的文件", _truncate(path), level="danger")
    return None


def classify_tool_use(tool: str | None, tool_input: dict | None, cwd: str | None) -> RiskFinding | None:
    """Classify one agent tool call as reported by a device. None = nothing to report."""
    tool_input = tool_input or {}
    if tool == "Bash":
        return classify_shell_command(str(tool_input.get("command") or ""))
    key = _FILE_TOOLS.get(tool or "")
    if key:
        return classify_file_change(str(tool_input.get(key) or ""), cwd)
    return None
