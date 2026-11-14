"""BUSINESS_BLUEPRINT.md on the server: the copy to show, what its check says, and which of the user's own
rules for the project it doesn't carry yet.

The file lives in each repo (packages/daemon/src/blueprint/business.ts writes its generated regions and checks
it against the code on every commit); devices upload it next to PROJECT_BLUEPRINT.md. The server never reads
a device's disk: it picks among the uploaded copies, reads the summary the generator wrote, and compares the
entries' sources with the project rules in the user's published profile ("## 项目：<name>" sections). A rule
the user set for the project that no entry names is one the code isn't checked against.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, Project
from .user_filter import apply_user_filter

BUSINESS_FILE = "BUSINESS_BLUEPRINT.md"

_ENTRY_RE = re.compile(r"^###\s+([TFRS]-[A-Z0-9][A-Z0-9-]*)\s+(.+?)\s*$")
_FIELD_RE = re.compile(r"^\s*[-*]\s*(来源|说明|定义)\s*[:：]\s*(.*)$")
_SUMMARY_RE = re.compile(
    r"规则\s*(\d+)（✅\s*(\d+)\s*·\s*⚠️\s*(\d+)\s*·\s*❌\s*(\d+)）\s*·\s*流程\s*(\d+)\s*·\s*术语\s*(\d+)\s*·\s*状态\s*(\d+)"
)
_CHECK_START = "<!-- memento:business-check:start"
_NOISE_RE = re.compile(r"[\s，。、；：:;,.!?！？「」『』“”\"'`（）()【】\[\]<>《》\-—_/\\|*#]+")


@dataclass
class BusinessEntry:
    id: str
    kind: str
    title: str
    texts: list[str] = field(default_factory=list)  # 来源 / 说明 / 定义 lines


def parse_entries(text: str) -> list[BusinessEntry]:
    """The entries written by hand (the generated check region is skipped)."""
    entries: list[BusinessEntry] = []
    cur: BusinessEntry | None = None
    for line in (text or "").split("\n"):
        if line.startswith(_CHECK_START):
            break
        m = _ENTRY_RE.match(line)
        if m:
            cur = BusinessEntry(id=m.group(1), kind={"T": "term", "F": "flow", "R": "rule", "S": "state"}[m.group(1)[0]], title=m.group(2))
            entries.append(cur)
            continue
        if re.match(r"^#{1,3}\s", line):
            cur = None
            continue
        if cur is not None:
            f = _FIELD_RE.match(line)
            if f:
                cur.texts.append(f.group(2).strip())
    return entries


def check_summary(text: str) -> dict[str, Any] | None:
    """What the generator's last check found, from the summary it wrote; None when the file has no check yet."""
    m = _SUMMARY_RE.search(text or "")
    if not m:
        return None
    rules, ok, warn, fail, flows, terms, states = (int(x) for x in m.groups())
    problems = []
    start = (text or "").find(_CHECK_START)
    if start >= 0:
        for line in text[start:].split("\n"):
            if line.startswith("- ❌") or line.startswith("- ⚠️"):
                problems.append(line[2:].strip())
    return {"rules": rules, "ok": ok, "warn": warn, "fail": fail, "flows": flows, "terms": terms, "states": states, "problems": problems[:30]}


def _norm(s: str) -> str:
    s = re.sub(r"\*\*|__", "", s or "")
    return _NOISE_RE.sub("", s).lower()


def _bigrams(s: str) -> set[str]:
    return {s[i : i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s}


def rule_covered(rule: str, entries: list[BusinessEntry]) -> bool:
    """Whether some entry names this rule: its words inside an entry's source / title, or most of its
    two-character pieces in one (rules get reworded: "后台任务要跟踪到结束，不要提前结束" against
    "后台任务跟踪到结束，不提前收尾")."""
    r = _norm(re.sub(r"^\s*[-*]\s*", "", rule))
    if len(r) < 4:
        return True
    rb = _bigrams(r)
    for e in entries:
        for t in [e.title, *e.texts]:
            n = _norm(t)
            if not n:
                continue
            if r in n or (len(n) >= 8 and n in r):
                return True
            if len(rb & _bigrams(n)) / len(rb) >= 0.6:
                return True
    return False


def rule_clauses(rule: str) -> list[str]:
    """One profile line often holds several rules joined by "；": each is checked on its own."""
    body = re.sub(r"^\s*[-*]\s*", "", rule or "").strip().rstrip("。.")
    return [c.strip().rstrip("。.") for c in re.split(r"[；;]", body) if len(_norm(c)) >= 4]


def uncovered_rules(text: str, rules: list[str]) -> list[str]:
    """The user's rules for the project (each clause of a profile line) that no rule entry of the business
    blueprint names, in the profile's order."""
    entries = [e for e in parse_entries(text) if e.kind == "rule"]
    out: list[str] = []
    for r in rules:
        for clause in rule_clauses(r):
            if not rule_covered(clause, entries) and clause not in out:
                out.append(clause)
    return out


def rules_total(rules: list[str]) -> int:
    return sum(len(rule_clauses(r)) for r in rules)


async def resolve_business_blueprint(
    db: AsyncSession,
    project: Project,
    mids: list[uuid.UUID] | None,
    prefer_machine: uuid.UUID | None = None,
) -> tuple[str, uuid.UUID | None] | None:
    """BUSINESS_BLUEPRINT.md as the devices uploaded it: the copy from the device whose code blueprint was
    picked (the same checkout), else the project's own copy synced last, else a same-named project's."""
    conds = [Document.project_id == project.id]
    for key in (project.title, project.slug):
        if key:
            leaf = key.rsplit("/", 1)[-1]
            conds.append(Document.relative_path == f"{leaf}/{BUSINESS_FILE}")
    # Case-sensitive and the whole file name: an agent's memory note "project_business_blueprint.md" (collected
    # like any other document) matched ilike '%BUSINESS_BLUEPRINT.md' and was shown as the blueprint (2026-11-14)
    q = (
        select(Document.content, Document.synced_at, Document.project_id, Document.machine_id)
        .where(or_(Document.relative_path == BUSINESS_FILE, Document.relative_path.like(f"%/{BUSINESS_FILE}")), or_(*conds))
        .order_by(Document.synced_at.desc())
        .limit(20)
    )
    q = apply_user_filter(q, mids, Document.machine_id)
    rows = [r for r in (await db.execute(q)).all() if r[0]]
    if not rows:
        return None
    if prefer_machine is not None:
        same = [r for r in rows if r[3] == prefer_machine]
        if same:
            return same[0][0], same[0][3]
    own = [r for r in rows if r[2] == project.id]
    best = (own or rows)[0]
    return best[0], best[3]


async def project_rules(db: AsyncSession, user: Any, project: Project) -> list[str]:
    """The rules the user's published profile keeps for this project ("## 项目：<name>")."""
    from .profile_service import get_published_profile_content, norm_scope_name, split_profile_scopes

    content = await get_published_profile_content(db, user)
    if not content:
        return []
    scopes = split_profile_scopes(content)
    keys = {norm_scope_name(k.rsplit("/", 1)[-1]) for k in (project.title, project.slug) if k}
    out: list[str] = []
    for name, lines in scopes.projects.items():
        if norm_scope_name(name) in keys:
            out.extend(line for line in lines if line.strip().startswith(("-", "*")))
    return out


def generation_prompt(project_name: str, rules: list[str], has_file: bool) -> str:
    """What the agent sent to write (or bring up to date) a repo's BUSINESS_BLUEPRINT.md is told."""
    rule_lines = "\n".join(f"- {re.sub(r'^\s*[-*]\s*', '', r)}" for r in rules) or "（画像里还没有这个项目的专属规则）"
    action = "更新仓库根目录已有的 BUSINESS_BLUEPRINT.md：保留已有条目，修好失效的代码位置，补上缺的规则" if has_file else "在仓库根目录新建 BUSINESS_BLUEPRINT.md"
    return f"""请为项目 {project_name} {action}。这是业务蓝图：项目应该做成什么样，每一条落在哪段代码、由哪个测试或检查保证，用来发现"用户定的规则和代码实现对不上"这类问题。

先读根目录 PROJECT_BLUEPRINT.md 开头的「0. 速览与章节索引」了解代码结构。

格式（生成器按这个格式解析，必须照写）：
- 一级标题 `# Business Blueprint: {project_name}`，下面四个二级章节：`## 1. 业务对象与术语`、`## 2. 关键流程`、`## 3. 业务规则`、`## 4. 状态归属`。
- 每个条目是 `### <编号> <名称>`，编号字母表示种类：T- 术语，F- 流程，R- 规则，S- 状态归属（如 `### R-UPLOAD-DEDUP 同一文件不重复入库`）。编号全大写，不重复。
- 条目下面用列表字段：
  - `- 来源: 用户 YYYY-MM-DD「原话」`（规则必填，写清是谁、什么时候说的）
  - `- 代码: \\`相对路径#函数或类名\\`, \\`相对路径\\``（代码里决定这件事的地方，符号按名字查找，必须真实存在）
  - `- 测试: \\`测试文件#测试标题里的一段原文\\``（证明它成立的测试）
  - `- 禁止: \\`文本\\` @ \\`目录/\\``（这里不许出现的写法，即 bug 的样子；`/正则/` 也行，注释行不算）
  - `- 要求: \\`文本\\` @ \\`文件\\``（这里必须出现的写法，即修复靠的东西）
  - 状态条目用 `- 事实源:`、`- 副本:`、`- 同步:`，里面的 \\`路径#符号\\` 同样会被核对
  - `- 说明:` / `- 定义:` 写背景
  - `- 类型: 协作约定`：规则管的是怎么干活（提交规范、流程），不是代码做什么时加上，这类可以不挂代码和测试
- 流程条目用编号步骤：`1. 做什么 — \\`路径#符号\\``。

内容要求：
1. 下面每条用户规则都要有一个 R- 条目，来源照抄原话，并找到代码里落实它的位置；找不到就说明代码还没做，在说明里写清楚，不要编造位置。
2. 术语写清本项目里容易混淆的概念；流程覆盖最核心的两三条业务链路；状态归属写出每个重要状态的唯一事实来源和它的副本。
3. 只写有依据的内容，代码位置和测试名必须在仓库里真实存在。不要写密钥、内网地址。

这个项目的用户规则：
{rule_lines}

写完后运行核对，直到没有 ❌：
- macOS / Linux：`node ~/.memento/scripts/project_blueprint.mjs --business --root .`（没有 node 就用 `ELECTRON_RUN_AS_NODE=1 ~/.memento/scripts/runtime ~/.memento/scripts/project_blueprint.mjs --business --root .`）
- Windows：`node %USERPROFILE%\\.memento\\scripts\\project_blueprint.mjs --business --root .`
核对会在文件开头和末尾写入自动生成的索引和核对结果，不要手改这两段。不要提交 git，改完告诉用户结果（规则数、✅/⚠️/❌ 各多少、还有哪些规则没找到代码）。"""
