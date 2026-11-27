// Risk classification for agent tool calls and shell commands (server/server/services/risk_policy.py).

export interface RiskFinding {
  label: string;
  detail: string;
  level: "low" | "warn" | "danger" | "critical";
  reasons: string[];
}

export function findingAsAlert(f: RiskFinding, tool: string): { label: string; detail: string; tool: string; level: string } {
  return { label: f.label, detail: f.detail, tool, level: f.level };
}

export const DETAIL_MAX = 300;

const SHELL_RULES: [RegExp, string, RiskFinding["level"]][] = [
  [/\bmkfs\b|\bdiskutil\s+(erase|partition)|\bdd\s+if=/, "格式化或直接写磁盘", "critical"],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, "删除数据库表或库", "critical"],
  [/\bcrontab\s+-r\b/, "清空定时任务", "critical"],
  [/\bgit\s+reset\s+[^;&|\n]*--hard\b/, "git reset --hard 丢弃改动", "critical"],
  [/\bgit\s+branch\s+[^;&|\n]*-D\b/, "强制删除分支", "danger"],
  [/\bgit\s+push\b[^;&|\n]*\s(--force\b|--force-with-lease\b|-f\b)/, "强制推送 git", "critical"],
  [/\bgit\s+push\b/, "推送代码到远端", "warn"],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, "git clean 删除未跟踪文件", "danger"],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, "丢弃工作区改动", "danger"],
  [/\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+/, "递归或强制删除文件", "danger"],
  [/\bsudo\s/, "以 root 权限执行", "danger"],
  [/\b(chmod|chown)\s+-R\b/, "递归修改文件权限", "danger"],
  [/\bkubectl\b[^;&|\n]*\s(delete|drain|edit)\b/, "删除或修改 Kubernetes 核心集群", "critical"],
  [/\bkubectl\b[^;&|\n]*\s(apply|replace|patch|scale|rollout|set)\b/, "部署更新 Kubernetes 集群", "warn"],
  [/\bhelm\b[^;&|\n]*\s(uninstall|delete)\b/, "删除 Helm 发布", "danger"],
  [/\bhelm\b[^;&|\n]*\s(install|upgrade|rollback)\b/, "操作 Helm 发布", "warn"],
  [/\bdocker(-compose|\s+compose)?\b[^;&|\n]*\s(system\s+prune|volume\s+(rm|prune)|image\s+prune)\b/, "批量清理 Docker 卷与镜像", "danger"],
  [/\bdocker(-compose|\s+compose)?\b[^;&|\n]*\s(rm|rmi|down|kill)\b/, "删除或停用 Docker 容器", "warn"],
  [
    /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\b(flutter|dart)\s+pub\s+publish\b|\bgh\s+release\s+create\b/,
    "向公共仓库发布软件包",
    "danger",
  ],
  [/\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/, "下载并直接执行网络脚本", "critical"],
  [/\bdelete\s+from\s+[\w."`]+\s*(;|$|")/i, "无条件删除表全部数据", "critical"],
  [/\b(shutdown|reboot|halt)\b/, "关机或重启操作系统", "critical"],
  [/\b(launchctl|systemctl)\s+(stop|disable|unload|bootout|mask)\b/, "停用系统关键服务", "danger"],
  [/>\s*\/etc\/|\btee\s+(-a\s+)?\/etc\//, "修改系统全局配置", "critical"],
];

const SENSITIVE_PATH_RULES: [RegExp, string, RiskFinding["level"]][] = [
  [/(^|\/)\.ssh\/|(^|\/)(id_rsa|id_ed25519|authorized_keys)$/i, "修改 SSH 密钥或配置", "critical"],
  [/(^|\/)\.(aws|gnupg|docker)\/|(^|\/)\.kube\/config$|(^|\/)\.netrc$|(^|\/)\.npmrc$|(^|\/)\.pypirc$/i, "修改全局凭据文件", "critical"],
  [/(^|\/)\.env(\.[\w.-]+)?$/i, "修改 .env 环境变量文件", "danger"],
  [/^\/etc\/|^\/private\/etc\/|\/library\/launch(agents|daemons)\//i, "修改系统配置或开机启动项", "critical"],
  [/(^|\/)\.(zshrc|bashrc|bash_profile|profile|zprofile|zshenv)$/i, "修改 shell 启动脚本", "danger"],
  [/(^|\/)\.claude\/settings(\.local)?\.json$|(^|\/)\.codex\/config\.toml$/i, "修改 AI 工具配置", "warn"],
];

const TEMP_DIRS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];
const FILE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

const CATASTROPHIC_RULES: [RegExp, string][] = [
  [/\bmkfs\b|\bdiskutil\s+(erase\w*|partition\w*|zeroDisk|randomDisk|secureErase)\b|\bdd\b[^;&|\n]*\bof=\/dev\//, "格式化或直接写磁盘"],
  [
    /\brm\s+(-[a-zA-Z-]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z-]*\s+)*(\/|\/\*|~|~\/|~\/\*|\$HOME\/?|\$\{HOME\}\/?|\$HOME\/\*|\/Users\/?|\/Users\/[^/\s;&|]+\/?|\/System|\/Applications|\/Library|\/usr|\/etc|\/var|\/home\/?|\/home\/[^/\s;&|]+\/?)(?=\s|$|;|&|\|)/,
    "删除系统目录或整个主目录",
  ],
  [/(^|[;&|(]|&&|\|\|)\s*(sudo\s+)?(shutdown|reboot|halt|poweroff)\b/, "关闭或重启这台电脑"],
];

const SSH_REMOTE_RE = /\bssh\b[^"';&|\n]*("(?:[^"\\]|\\.)*"|'[^']*')/g;

function truncate(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length <= DETAIL_MAX ? flat : `${flat.slice(0, DETAIL_MAX - 1)}…`;
}

function makeFinding(label: string, detail: string, level: RiskFinding["level"]): RiskFinding {
  return { label, detail, level, reasons: label ? [label] : [] };
}

export function classifyShellCommand(command: string | null | undefined): RiskFinding | null {
  if (!command) return null;
  for (const [pattern, label, level] of SHELL_RULES) {
    if (pattern.test(command)) return makeFinding(label, truncate(command), level);
  }
  return null;
}

export function classifyCatastrophic(command: string | null | undefined): RiskFinding | null {
  if (!command) return null;
  const local = command.replace(SSH_REMOTE_RE, (full, quoted: string) => {
    const idx = full.indexOf(quoted);
    return idx >= 0 ? `${full.slice(0, idx)}""` : full;
  });
  for (const [pattern, label] of CATASTROPHIC_RULES) {
    if (pattern.test(local)) return makeFinding(label, truncate(command), "critical");
  }
  return null;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path);
}

function isInside(path: string, root: string): boolean {
  let p = path;
  let r = root;
  if (isWindowsPath(p) || isWindowsPath(r)) {
    p = p.toLowerCase();
    r = r.toLowerCase();
  }
  return p === r || p.startsWith(`${r}/`);
}

export function classifyFileChange(path: string | null | undefined, cwd: string | null | undefined): RiskFinding | null {
  if (!path) return null;
  const norm = normalizePath(path);
  for (const [pattern, label, level] of SENSITIVE_PATH_RULES) {
    if (pattern.test(norm)) return makeFinding(label, truncate(path), level);
  }
  const isAbs = norm.startsWith("/") || isWindowsPath(norm);
  if (cwd && isAbs) {
    const root = normalizePath(cwd);
    const inTemp = TEMP_DIRS.some((t) => norm.startsWith(t));
    if (root && !inTemp && !isInside(norm, root)) {
      return makeFinding("修改工作目录以外的文件", truncate(path), "danger");
    }
  }
  return null;
}

export function classifyToolUse(
  tool: string | null | undefined,
  toolInput: Record<string, unknown> | null | undefined,
  cwd: string | null | undefined,
): RiskFinding | null {
  const input = toolInput ?? {};
  if (tool === "Bash") return classifyShellCommand(String(input.command ?? ""));
  const key = FILE_TOOLS[tool ?? ""];
  if (key) return classifyFileChange(String(input[key] ?? ""), cwd);
  return null;
}
