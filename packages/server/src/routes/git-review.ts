// Git diff review, hidden turn checkpoint restore, commit/push/PR and repo discovery (server/server/api/git_review.py).
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import type { AppEnv, Deps } from "../context";
import type { Db } from "../db/client";
import { userMemories } from "../db/pulled/schema";
import { HttpError, parseJsonObject } from "../http";
import { callPlainChat } from "../services/ai-provider";
import { cluster } from "../services/cluster";
import type { MachineRow } from "../services/device-merge";
import { deviceHasFeature, getCachedDeviceCapabilities } from "../services/device-reports";
import { notifyUser } from "../services/notify";
import { findMachineByIdOrHash } from "../services/user-filter";
import { seesAll, userMachineIds } from "../services/visibility";
import { wsManager } from "../services/ws-manager";

const SAFE_REF_RE = /^(?:HEAD|refs\/memento\/checkpoints\/[A-Za-z0-9._/-]+|[0-9a-fA-F]{7,40})$/;
const SAFE_CHECKPOINT_REF_RE = /^refs\/memento\/checkpoints\/[A-Za-z0-9._/-]+$/;
const CHECKPOINT_PREFIX = "refs/memento/checkpoints/";
const MAX_DIFF_BYTES_PER_FILE = 180 * 1024;
const MAX_TOTAL_DIFF_BYTES = 1_200 * 1024;
const MIN_NATIVE_VERSION = [1, 0, 158] as const;
const SUGGEST_DIFF_CHARS = 14_000;
const COMMIT_RULE_RE = /提交|commit|Commit|PR|尾注|Co-Authored|Conventional|中文/;
const TRAILER_RE = /^\s*(Co-Authored-By:.*|🤖 Generated with.*|Generated (?:with|by) .*)$/gim;
const PR_LIST_FIELDS = "number,title,author,headRefName,baseRefName,isDraft,updatedAt,url,reviewDecision,statusCheckRollup,additions,deletions";
const PR_VIEW_FIELDS =
  "number,title,body,author,state,isDraft,headRefName,baseRefName,url,mergeable,mergeStateStatus,reviewDecision," +
  "statusCheckRollup,files,comments,commits,additions,deletions,updatedAt";
const PR_DIFF_CHARS = 400_000;

function shQuote(s: string): string {
  if (!s) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", "'\"'\"'")}'`;
}

function psQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function parseVersion(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(raw));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
}

function versionGte(a: number[], b: readonly number[]): boolean {
  if (!a.length) return false;
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function deviceSupportsNativeGit(machine: MachineRow, user: UserRow, settings: Settings): boolean {
  if (deviceHasFeature(machine.name, "git_review", user, settings)) return true;
  return versionGte(parseVersion(machine.collectorVersion), MIN_NATIVE_VERSION);
}

function isWindowsDevice(machine: MachineRow, user: UserRow, settings: Settings, cwd: string): boolean {
  const caps = getCachedDeviceCapabilities(machine.name, null, user, settings);
  const env = caps?.environment && typeof caps.environment === "object" ? (caps.environment as Record<string, unknown>) : null;
  const plat = String(env?.platform ?? "").toLowerCase();
  if (plat === "win32") return true;
  if (plat === "darwin" || plat === "linux") return false;
  if (/^[A-Za-z]:[\\/]/.test(cwd || "")) return true;
  return (machine.name || "").toLowerCase().includes("windows");
}

export function parseUnifiedDiff(raw: string): Record<string, unknown>[] {
  const files: Record<string, unknown>[] = [];
  if (!raw || !raw.trim()) return files;

  let current: Record<string, unknown> | null = null;
  let currentHunk: Record<string, unknown> | null = null;
  let oldLine = 0;
  let newLine = 0;
  let fileBytes = 0;

  const flushHunk = () => {
    if (current && currentHunk) {
      (current.hunks as unknown[]).push(currentHunk);
      currentHunk = null;
    }
  };
  const flushFile = () => {
    flushHunk();
    if (current) {
      files.push(current);
      current = null;
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const oldP = m ? m[1]!.replace(/^"+|"+$/g, "") : "";
      const newP = m ? m[2]!.replace(/^"+|"+$/g, "") : "";
      current = {
        path: newP || oldP,
        ...(oldP && newP && oldP !== newP ? { old_path: oldP } : {}),
        status: "M",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      fileBytes = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode ")) {
      current.status = "A";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.status = "D";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "R";
      current.old_path = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.status = "R";
      current.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
      continue;
    }
    if (/^(?:--- |\+\+\+ |index |similarity index |old mode |new mode )/.test(line)) continue;
    if (line.startsWith("@@ ")) {
      flushHunk();
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (hm) {
        oldLine = Number(hm[1]);
        const oldCount = hm[2] !== undefined ? Number(hm[2]) : 1;
        newLine = Number(hm[3]);
        const newCount = hm[4] !== undefined ? Number(hm[4]) : 1;
        currentHunk = {
          header: line,
          old_start: oldLine,
          old_lines: oldCount,
          new_start: newLine,
          new_lines: newCount,
          lines: [],
        };
      }
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;

    fileBytes += line.length + 1;
    if (fileBytes > MAX_DIFF_BYTES_PER_FILE) {
      current.truncated = true;
      continue;
    }
    const hLines = currentHunk.lines as Record<string, unknown>[];
    if (line.startsWith("+")) {
      current.additions = Number(current.additions) + 1;
      hLines.push({ type: "add", old_line: null, new_line: newLine, content: line.slice(1) });
      newLine++;
    } else if (line.startsWith("-")) {
      current.deletions = Number(current.deletions) + 1;
      hLines.push({ type: "del", old_line: oldLine, new_line: null, content: line.slice(1) });
      oldLine++;
    } else if (line.startsWith(" ")) {
      hLines.push({ type: "context", old_line: oldLine, new_line: newLine, content: line.slice(1) });
      oldLine++;
      newLine++;
    }
  }
  flushFile();
  return files;
}

export async function resolveDevice(db: Db, settings: Settings, deviceId: string, user: UserRow): Promise<[MachineRow, string[]]> {
  const raw = (deviceId || "").trim();
  if (!raw || raw === "auto" || raw === "ask_only" || raw === "all") {
    throw new HttpError(400, "请先指定具体设备后再进行 Git 代码审阅或操作");
  }
  const machine = await findMachineByIdOrHash(db, settings, raw, user);
  if (!machine) throw new HttpError(404, "未找到目标设备");

  const mids = await userMachineIds(db, user, settings);
  if (!seesAll(user, settings) && mids !== null && !mids.includes(machine.id)) {
    throw new HttpError(403, "无权访问该设备");
  }
  const candidates: string[] = [];
  for (const cand of [machine.collectorTokenHash, raw, machine.name, String(machine.id)]) {
    if (cand && !candidates.includes(cand)) candidates.push(cand);
  }
  return [machine, candidates];
}

async function rpcDevice(candidates: string[], payload: Record<string, unknown>, timeoutSec: number): Promise<Record<string, unknown>> {
  let lastResp: Record<string, unknown> | null = null;
  for (const cand of candidates) {
    const resp = await wsManager.requestDevice(cand, payload, timeoutSec);
    lastResp = resp;
    if (resp.code !== "offline") return resp;
  }
  return lastResp ?? { ok: false, error: "目标设备当前不在线", code: "offline" };
}

export async function runEphemeralShell(
  candidates: string[],
  cwd: string,
  command: string,
  timeoutSec = 25,
): Promise<[number, string, string, string | null]> {
  const tid = `gitrpc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const q = await wsManager.subscribeTask(tid);
  try {
    let dispatched = false;
    const taskPayload = {
      id: tid,
      action: "shell",
      payload: { command, cwd },
      timeout_seconds: Math.max(15, Math.trunc(timeoutSec)),
    };
    for (const cand of candidates) {
      if (await wsManager.sendTask(cand, taskPayload)) {
        dispatched = true;
        break;
      }
    }
    if (!dispatched) return [1, "", "目标设备当前不在线", "offline"];

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    const deadline = performance.now() + timeoutSec * 1000;
    while (true) {
      const rem = deadline - performance.now();
      if (rem <= 0) return [124, stdoutChunks.join(""), "设备执行 Git 命令超时", "timeout"];
      const evt = await q.get(rem);
      if (!evt) return [124, stdoutChunks.join(""), "设备执行 Git 命令超时", "timeout"];
      const etype = evt.type;
      if (etype === "task_chunk") {
        const txt = String(evt.text ?? "");
        if (evt.stream === "stderr") {
          if (stderrLen < 120_000) {
            stderrChunks.push(txt);
            stderrLen += txt.length;
          }
        } else if (stdoutLen < MAX_TOTAL_DIFF_BYTES + 200_000) {
          stdoutChunks.push(txt);
          stdoutLen += txt.length;
        }
      } else if (etype === "task_finished") {
        const res = (evt.result && typeof evt.result === "object" ? evt.result : {}) as Record<string, unknown>;
        const exitCode = res.exit_code !== undefined && res.exit_code !== null ? Number(res.exit_code) : res.status === "succeeded" ? 0 : 1;
        const out = stdoutChunks.join("") || String(res.stdout ?? "");
        const err = stderrChunks.join("") || String(res.stderr ?? res.error ?? "");
        return [exitCode, out, err, null];
      }
    }
  } finally {
    await wsManager.unsubscribeTask(tid);
  }
}

function splitSections(raw: string, markers: string[]): Record<string, string> {
  const positions: [number, number, string][] = [];
  for (const mk of markers) {
    const idx = raw.indexOf(mk);
    if (idx >= 0) positions.push([idx, idx + mk.length, mk]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  const out: Record<string, string> = {};
  for (let i = 0; i < positions.length; i++) {
    const [, bodyStart, mk] = positions[i]!;
    const end = i + 1 < positions.length ? positions[i + 1]![0] : raw.length;
    out[mk] = raw.slice(bodyStart, end).replace(/^[\r\n]+/, "");
  }
  return out;
}

function buildPosixDiffCmd(baseRef: string, targetRef: string, filePath: string): string {
  const pathTail = filePath ? ` -- ${shQuote(filePath)}` : "";
  let diffCmd: string;
  let untrackedCmd = "";
  if (baseRef && targetRef) {
    diffCmd = `git -c core.quotePath=false diff --no-color --unified=3 -M ${shQuote(baseRef)} ${shQuote(targetRef)}${pathTail}`;
  } else if (targetRef) {
    diffCmd = `git -c core.quotePath=false show --format= --no-color --unified=3 -M ${shQuote(targetRef)}${pathTail}`;
  } else {
    diffCmd =
      `if git rev-parse --verify HEAD >/dev/null 2>&1; then ` +
      `git -c core.quotePath=false diff --no-color --unified=3 -M HEAD${pathTail}; ` +
      `else git -c core.quotePath=false diff --no-color --unified=3 -M${pathTail}; fi`;
    untrackedCmd =
      `git -c core.quotePath=false ls-files --others --exclude-standard${pathTail} | head -n 30 | ` +
      `while IFS= read -r f; do ` +
      `  [ -f "$f" ] || continue; ` +
      `  sz=$(wc -c < "$f" 2>/dev/null || echo 999999); ` +
      `  printf "===M_UFILE===%s\\t%s\\n" "$f" "$sz"; ` +
      `  if [ "$sz" -le 49152 ]; then head -c 49152 "$f"; fi; ` +
      `  printf "\\n===M_UEND===\\n"; ` +
      `done`;
  }
  const lines = [
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
    diffCmd,
  ];
  if (untrackedCmd) lines.push('echo "===M_UNTRACKED==="', untrackedCmd);
  return lines.join("\n");
}

function buildWindowsDiffCmd(baseRef: string, targetRef: string, filePath: string): string {
  const pathTail = filePath ? ` -- ${psQuote(filePath)}` : "";
  let diffCmd: string;
  let untrackedCmd = "";
  if (baseRef && targetRef) {
    diffCmd = `git -c core.quotePath=false diff --no-color --unified=3 -M ${psQuote(baseRef)} ${psQuote(targetRef)}${pathTail}`;
  } else if (targetRef) {
    diffCmd = `git -c core.quotePath=false show --format= --no-color --unified=3 -M ${psQuote(targetRef)}${pathTail}`;
  } else {
    diffCmd =
      `git rev-parse --verify HEAD *>$null; if ($LASTEXITCODE -eq 0) { ` +
      `git -c core.quotePath=false diff --no-color --unified=3 -M HEAD${pathTail} ` +
      `} else { git -c core.quotePath=false diff --no-color --unified=3 -M${pathTail} }`;
    untrackedCmd =
      `$uf = git -c core.quotePath=false ls-files --others --exclude-standard${pathTail} | Select-Object -First 30; ` +
      `foreach ($f in $uf) { if (Test-Path -LiteralPath $f -PathType Leaf) { ` +
      `$sz = (Get-Item -LiteralPath $f).Length; Write-Output "===M_UFILE===$f\`t$sz"; ` +
      `if ($sz -le 49152) { Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue }; ` +
      `Write-Output '===M_UEND===' } }`;
  }
  const parts = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
    "$root = (git -c core.quotePath=false rev-parse --show-toplevel 2>$null); if ($LASTEXITCODE -ne 0 -or -not $root) { Write-Output 'NOT_A_GIT_REPO'; exit 2 };",
    "Set-Location -LiteralPath $root;",
    "Write-Output '===M_META==='; Write-Output $root;",
    "$br = (git symbolic-ref --short HEAD 2>$null); if ($LASTEXITCODE -ne 0 -or -not $br) { $br = 'HEAD' }; Write-Output $br;",
    "$hd = (git rev-parse --verify HEAD 2>$null); if ($LASTEXITCODE -ne 0) { $hd = '' }; Write-Output $hd;",
    "Write-Output '===M_STATUS==='; git -c core.quotePath=false status --porcelain 2>$null;",
    "Write-Output '===M_COMMITS==='; git -c core.quotePath=false log -n 12 --format='%H%x09%P%x09%h%x09%s%x09%cI' 2>$null;",
    "Write-Output '===M_CHECKPOINTS==='; git for-each-ref --sort=-committerdate --format='%(refname)%09%(committerdate:iso-strict)' refs/memento/checkpoints/ 2>$null;",
    `Write-Output '===M_DIFF==='; ${diffCmd};`,
  ];
  if (untrackedCmd) parts.push(`Write-Output '===M_UNTRACKED==='; ${untrackedCmd};`);
  return parts.join(" ");
}

function parseUntrackedSection(raw: string): Record<string, unknown>[] {
  if (!raw || !raw.includes("===M_UFILE===")) return [];
  const out: Record<string, unknown>[] = [];
  for (const block of raw.split("===M_UFILE===").slice(1)) {
    const body = block.split("===M_UEND===", 1)[0] ?? "";
    const firstNl = body.indexOf("\n");
    const header = (firstNl < 0 ? body : body.slice(0, firstNl)).trim();
    const content = firstNl < 0 ? "" : body.slice(firstNl + 1);
    const parts = header.split("\t");
    const path = (parts[0] ?? "").trim();
    if (!path) continue;
    const size = parts.length > 1 && /^\d+$/.test(parts[1]!.trim()) ? Number(parts[1]!.trim()) : Buffer.byteLength(content, "utf8");
    if (size > 49_152) {
      out.push({ path, status: "A", additions: 0, deletions: 0, binary: false, truncated: true, hunks: [] });
      continue;
    }
    if (content.slice(0, 4096).includes("\x00")) {
      out.push({ path, status: "A", additions: 0, deletions: 0, binary: true, hunks: [] });
      continue;
    }
    const lines = content.replaceAll("\r\n", "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const diffLines = lines.map((ln, idx) => ({ type: "add", old_line: null, new_line: idx + 1, content: ln }));
    out.push({
      path,
      status: "A",
      additions: diffLines.length,
      deletions: 0,
      binary: false,
      hunks: diffLines.length
        ? [
            {
              header: `@@ -0,0 +1,${diffLines.length} @@ (new file)`,
              old_start: 0,
              old_lines: 0,
              new_start: 1,
              new_lines: diffLines.length,
              lines: diffLines,
            },
          ]
        : [],
    });
  }
  return out;
}

function parseCheckpointsSection(raw: string): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const line of (raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const ref = (parts[0] ?? "").trim();
    const dt = (parts[1] ?? "").trim();
    if (!ref.startsWith(CHECKPOINT_PREFIX)) continue;
    const segs = ref.slice(CHECKPOINT_PREFIX.length).split("/");
    if (segs.length < 2 || (segs[1] !== "before" && segs[1] !== "after")) continue;
    const [cid, kind] = [segs[0]!, segs[1]!];
    let entry = byId.get(cid);
    if (!entry) {
      entry = { id: cid };
      byId.set(cid, entry);
    }
    if (kind === "before") {
      entry.before_ref = ref;
      if (dt && !("created_at" in entry)) entry.created_at = dt;
    } else {
      entry.after_ref = ref;
      if (dt) entry.created_at = dt;
    }
  }
  return [...byId.values()].filter((e) => Boolean(e.before_ref && e.after_ref)).slice(0, 30);
}

function parseCommitsSection(raw: string): Record<string, unknown>[] {
  const commits: Record<string, unknown>[] = [];
  for (const line of (raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const sha = (parts[0] ?? "").trim();
    if (!sha) continue;
    const parents = (parts[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const shortSha = (parts[2] ?? "").trim() || sha.slice(0, 8);
    const subject = (parts[3] ?? "").trim();
    const dt = (parts[4] ?? "").trim();
    commits.push({ sha, parent_sha: parents[0] ?? "", short_sha: shortSha, subject, created_at: dt || null });
  }
  return commits;
}

async function fallbackGitDiff(
  candidates: string[],
  machine: MachineRow,
  user: UserRow,
  settings: Settings,
  cwd: string,
  baseRef: string,
  targetRef: string,
  filePath: string,
): Promise<Record<string, unknown>> {
  const isWin = isWindowsDevice(machine, user, settings, cwd);
  const cmd = isWin ? buildWindowsDiffCmd(baseRef, targetRef, filePath) : buildPosixDiffCmd(baseRef, targetRef, filePath);
  const [code, stdout, stderr, errCode] = await runEphemeralShell(candidates, cwd, cmd, 25);
  if (errCode === "offline") throw new HttpError(503, "目标设备当前不在线");
  if (errCode === "timeout") throw new HttpError(504, "获取 Git Diff 超时，请确认设备运行正常");
  if (stdout.includes("NOT_A_GIT_REPO") || (code === 2 && !stdout.includes("===M_META==="))) {
    throw new HttpError(400, "当前目录不是 Git 仓库");
  }
  if (!stdout.includes("===M_META===")) {
    throw new HttpError(400, (stderr || stdout).trim().slice(0, 300) || "获取 Git Diff 失败");
  }
  const sections = splitSections(stdout, ["===M_META===", "===M_STATUS===", "===M_COMMITS===", "===M_CHECKPOINTS===", "===M_DIFF===", "===M_UNTRACKED==="]);
  const metaLines = (sections["===M_META==="] ?? "").split(/\r?\n/);
  const repoRoot = metaLines[0]?.trim() || cwd;
  const branch = metaLines[1]?.trim() || "HEAD";
  const headSha = metaLines[2]?.trim() || "";

  let rawDiff = sections["===M_DIFF==="] ?? "";
  let truncated = false;
  if (rawDiff.length > MAX_TOTAL_DIFF_BYTES) {
    rawDiff = rawDiff.slice(0, MAX_TOTAL_DIFF_BYTES);
    truncated = true;
  }
  const files = [...parseUnifiedDiff(rawDiff), ...parseUntrackedSection(sections["===M_UNTRACKED==="] ?? "")];
  const totalAdd = files.reduce((acc, f) => acc + Number(f.additions ?? 0), 0);
  const totalDel = files.reduce((acc, f) => acc + Number(f.deletions ?? 0), 0);
  return {
    ok: true,
    repo_root: repoRoot,
    branch,
    head_sha: headSha,
    is_dirty: Boolean((sections["===M_STATUS==="] ?? "").trim()),
    base_ref: baseRef || (headSha ? "HEAD" : ""),
    target_ref: targetRef || "WORKING_TREE",
    total_files: files.length,
    total_additions: totalAdd,
    total_deletions: totalDel,
    truncated,
    files,
    checkpoints: parseCheckpointsSection(sections["===M_CHECKPOINTS==="] ?? ""),
    recent_commits: parseCommitsSection(sections["===M_COMMITS==="] ?? ""),
    legacy_fallback: true,
    client_version: machine.collectorVersion ?? null,
  };
}

export function diffForPrompt(diff: Record<string, unknown>, files?: string[] | null, limit = SUGGEST_DIFF_CHARS): string {
  const wanted = new Set((files ?? []).map((f) => f.trim()).filter(Boolean));
  const out: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  const list = Array.isArray(diff.files) ? (diff.files as Record<string, unknown>[]) : [];
  for (const f of list) {
    const path = String(f.path ?? "");
    if (wanted.size && !wanted.has(path)) continue;
    const head = `--- ${String(f.status || "M")} ${path} (+${Number(f.additions ?? 0)} -${Number(f.deletions ?? 0)})`;
    let body: string;
    if (f.binary) {
      body = "（二进制文件）";
    } else {
      const rows: string[] = [];
      for (const h of Array.isArray(f.hunks) ? (f.hunks as Record<string, unknown>[]) : []) {
        rows.push(String(h.header || "@@"));
        for (const ln of Array.isArray(h.lines) ? (h.lines as Record<string, unknown>[]) : []) {
          const mark = ln.type === "add" ? "+" : ln.type === "del" ? "-" : " ";
          rows.push(`${mark}${String(ln.content ?? "")}`);
        }
      }
      body = rows.join("\n");
    }
    const block = `${head}\n${body}`;
    if (used + block.length > limit) {
      skipped.push(`${path} (+${Number(f.additions ?? 0)} -${Number(f.deletions ?? 0)})`);
      continue;
    }
    out.push(block);
    used += block.length;
  }
  if (skipped.length) out.push(`其余改动（内容太长未列出）：${skipped.join("、")}`);
  return out.join("\n\n");
}

export function commitRulesFromGuidance(guidance: string, limit = 2000): string {
  const lines = (guidance || "")
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter((ln) => Boolean(ln) && COMMIT_RULE_RE.test(ln));
  return [...new Set(lines)].join("\n").slice(0, limit);
}

export function parseSuggestion(raw: string): { message: string; pr_title: string; pr_body: string } {
  const text = (raw || "").trim();
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const data = JSON.parse(m[0]) as Record<string, unknown>;
      const msg = String(data.message ?? "").trim();
      if (msg) {
        return {
          message: msg,
          pr_title: String(data.pr_title ?? msg.split(/\r?\n/)[0] ?? "").trim(),
          pr_body: String(data.pr_body ?? "").trim(),
        };
      }
    } catch {
      /* fall through */
    }
  }
  const first = text.replace(/^`+|`+$/g, "").trim();
  return { message: first, pr_title: first ? (first.split(/\r?\n/)[0] ?? "") : "", pr_body: "" };
}

export function stripAgentTrailers(text: string): string {
  return (text || "").replace(TRAILER_RE, "").trim();
}

export function summarizeChecks(rollup: Record<string, unknown>[] | null | undefined): {
  state: string;
  passed: number;
  failed: number;
  pending: number;
  total: number;
} {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of rollup ?? []) {
    const status = String(c.status ?? "").toUpperCase();
    const conclusion = String(c.conclusion ?? c.state ?? "").toUpperCase();
    if (status && status !== "COMPLETED") pending++;
    else if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") passed++;
    else if (conclusion === "PENDING" || conclusion === "EXPECTED" || conclusion === "") pending++;
    else failed++;
  }
  const total = passed + failed + pending;
  const state = !total ? "none" : failed ? "failure" : pending ? "pending" : "success";
  return { state, passed, failed, pending, total };
}

export function reposCommand(cwd: string, windows: boolean): string {
  if (windows) {
    const p = psQuote(cwd);
    return (
      `$r = ${p}; if (Test-Path (Join-Path $r '.git')) { $r }; ` +
      `Get-ChildItem -LiteralPath $r -Directory -Recurse -Depth 2 -Force -Filter .git -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.FullName -notmatch '\\\\node_modules\\\\' } | Select-Object -First 50 | ForEach-Object { $_.Parent.FullName }`
    );
  }
  return `cd ${shQuote(cwd)} 2>/dev/null && find . -maxdepth 3 -name node_modules -prune -o -name .git -print 2>/dev/null | head -50`;
}

export function parseRepoRoots(out: string, cwd: string, windows: boolean): string[] {
  const roots: string[] = [];
  const base = cwd.replace(/[/\\]+$/, "");
  for (const line of out.split(/\r?\n/)) {
    let s = line.trim();
    if (!s) continue;
    if (!windows) {
      if (s.endsWith("/.git")) s = s.slice(0, -5);
      s = s === "." || s === "" ? base : `${base}/${s.startsWith("./") ? s.slice(2) : s}`;
    }
    if (!roots.includes(s)) roots.push(s);
  }
  roots.sort((a, b) => {
    const ab = a !== base ? 1 : 0;
    const bb = b !== base ? 1 : 0;
    if (ab !== bb) return ab - bb;
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
  return roots;
}

function reqStr(body: Record<string, unknown>, field: string, minLen = 1, maxLen?: number): string {
  if (!(field in body) || body[field] === undefined || body[field] === null) {
    throw new HttpError(422, [{ type: "missing", loc: ["body", field], msg: "Field required", input: body }]);
  }
  if (typeof body[field] !== "string") {
    throw new HttpError(422, [{ type: "string_type", loc: ["body", field], msg: "Input should be a valid string", input: body[field] }]);
  }
  const s = body[field] as string;
  if (s.length < minLen) {
    throw new HttpError(422, [{ type: "string_too_short", loc: ["body", field], msg: `String should have at least ${minLen} character`, input: s }]);
  }
  if (maxLen !== undefined && s.length > maxLen) {
    throw new HttpError(422, [{ type: "string_too_long", loc: ["body", field], msg: `String should have at most ${maxLen} characters`, input: s }]);
  }
  return s;
}

function reqInt(body: Record<string, unknown>, field: string, ge = 1): number {
  const v = body[field];
  if (v === undefined || v === null) {
    throw new HttpError(422, [{ type: "missing", loc: ["body", field], msg: "Field required", input: body }]);
  }
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n < ge) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["body", field], msg: `Input should be an integer >= ${ge}`, input: v }]);
  }
  return n;
}

async function runGh(deps: Deps, user: UserRow, deviceId: string, cwd: string, args: string, timeoutSec = 30): Promise<string> {
  const [, candidates] = await resolveDevice(deps.db, deps.settings, deviceId, user);
  const [code, out, err, transport] = await runEphemeralShell(candidates, cwd.trim(), `gh ${args}`, timeoutSec);
  if (transport === "offline") throw new HttpError(503, "目标设备当前不在线");
  if (transport === "timeout") throw new HttpError(504, "设备上的 gh 命令超时");
  if (code !== 0) {
    let msg = (err || out || "").trim();
    if ((msg.includes("not found") && msg.includes("gh")) || msg.includes("不是内部或外部命令") || msg.includes("is not recognized")) {
      msg = "设备上没有安装 GitHub CLI（gh），装好并 gh auth login 后再试";
    } else if (msg.includes("auth login")) {
      msg = "设备上的 gh 还没登录 GitHub，在设备上运行 gh auth login 后再试";
    }
    throw new HttpError(400, msg.slice(0, 500) || "gh 命令失败");
  }
  return out;
}

function jsonOr502(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(502, "gh 返回的不是 JSON");
  }
}

async function computeGitDiff(
  deps: Deps,
  user: UserRow,
  params: { deviceId: string; cwd: string; baseRef?: string; targetRef?: string; filePath?: string },
): Promise<Record<string, unknown>> {
  const baseRef = (params.baseRef ?? "").trim();
  const targetRef = (params.targetRef ?? "").trim();
  const filePath = (params.filePath ?? "").trim();
  if (baseRef && !SAFE_REF_RE.test(baseRef)) throw new HttpError(400, `非法 base_ref：${baseRef}`);
  if (targetRef && !SAFE_REF_RE.test(targetRef)) throw new HttpError(400, `非法 target_ref：${targetRef}`);
  if (filePath.includes("\x00")) throw new HttpError(400, "非法文件路径");

  const [machine, candidates] = await resolveDevice(deps.db, deps.settings, params.deviceId, user);
  if (!deviceSupportsNativeGit(machine, user, deps.settings)) {
    return fallbackGitDiff(candidates, machine, user, deps.settings, params.cwd.trim(), baseRef, targetRef, filePath);
  }
  const payload: Record<string, unknown> = { type: "git_diff_req", cwd: params.cwd.trim() };
  if (baseRef) payload.base_ref = baseRef;
  if (targetRef) payload.target_ref = targetRef;
  if (filePath) payload.file_path = filePath;

  const resp = await rpcDevice(candidates, payload, 15);
  if (resp.code === "timeout" && !deviceHasFeature(machine.name, "git_review", user, deps.settings)) {
    return fallbackGitDiff(candidates, machine, user, deps.settings, params.cwd.trim(), baseRef, targetRef, filePath);
  }
  if (resp.code === "offline") throw new HttpError(503, String(resp.error || "目标设备当前不在线"));
  if (resp.code === "timeout") throw new HttpError(504, String(resp.error || "获取 Diff 超时"));
  if (!resp.ok) throw new HttpError(400, String(resp.error || "获取 Git Diff 失败"));
  return resp;
}

async function watchPrChecks(deps: Deps, user: UserRow, deviceId: string, cwd: string, num: number, intervalSec = 60, maxWaitSec = 3 * 3600): Promise<string> {
  const key = `memento:prwatch:${user.id}:${deviceId}:${cwd}:${num}`;
  const tok = await cluster.tryLock(key, Math.trunc(maxWaitSec) + 300);
  if (!tok) return "already";
  const deadline = performance.now() + maxWaitSec * 1000;
  let title = `PR #${num}`;
  while (performance.now() < deadline) {
    let pr: Record<string, unknown>;
    try {
      pr = jsonOr502(await runGh(deps, user, deviceId, cwd, `pr view ${num} --json number,title,url,statusCheckRollup`)) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 503 || e.status === 504)) {
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
        continue;
      }
      return "error";
    }
    title = `PR #${num} ${String(pr.title ?? "")}`.trim();
    const checks = summarizeChecks(pr.statusCheckRollup as Record<string, unknown>[] | undefined);
    if (checks.state === "success" || checks.state === "failure" || checks.state === "none") {
      if (checks.state === "success") {
        await notifyUser(deps, user.id, "task_done", "CI 通过", `${title}：${checks.passed} 项检查全部通过`, { url: pr.url ? String(pr.url) : null });
      } else if (checks.state === "failure") {
        await notifyUser(deps, user.id, "risky", "CI 失败", `${title}：${checks.failed} 项检查失败`, { url: pr.url ? String(pr.url) : null });
      }
      return checks.state;
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
  await notifyUser(deps, user.id, "task_done", "CI 还没跑完", `${title}：等了 ${Math.trunc(maxWaitSec / 3600)} 小时，停止盯了`);
  return "timeout";
}

export const gitReviewRoutes = new Hono<AppEnv>();

gitReviewRoutes.post("/diff", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const res = await computeGitDiff(c.var.deps, user, {
    deviceId: reqStr(body, "device_id"),
    cwd: reqStr(body, "cwd"),
    baseRef: typeof body.base_ref === "string" ? body.base_ref : undefined,
    targetRef: typeof body.target_ref === "string" ? body.target_ref : undefined,
    filePath: typeof body.file_path === "string" ? body.file_path : undefined,
  });
  return c.json(res);
});

gitReviewRoutes.post("/checkpoint/restore", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const deviceId = reqStr(body, "device_id");
  const cwd = reqStr(body, "cwd");
  const targetRef = reqStr(body, "target_ref").trim();
  if (!SAFE_CHECKPOINT_REF_RE.test(targetRef)) {
    throw new HttpError(400, "仅允许回滚到 Memento 隐藏检查点（refs/memento/checkpoints/...）");
  }
  const [machine, candidates] = await resolveDevice(c.var.deps.db, c.var.deps.settings, deviceId, user);
  if (!deviceSupportsNativeGit(machine, user, c.var.deps.settings)) {
    const ver = machine.collectorVersion || "旧版本";
    throw new HttpError(409, `设备「${machine.name}」当前 Memento 版本为 ${ver}，升级到 1.0.158 及以上即可使用回合检查点一键回滚`);
  }
  const resp = await rpcDevice(candidates, { type: "git_checkpoint_restore_req", cwd: cwd.trim(), target_ref: targetRef }, 35);
  if (resp.code === "offline") throw new HttpError(503, String(resp.error || "目标设备当前不在线"));
  if (resp.code === "timeout") throw new HttpError(504, String(resp.error || "回滚检查点超时"));
  if (!resp.ok) throw new HttpError(400, String(resp.error || "回滚检查点失败"));
  return c.json(resp);
});

gitReviewRoutes.post("/deliver", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const deviceId = reqStr(body, "device_id");
  const cwd = reqStr(body, "cwd").trim();
  const message = reqStr(body, "message", 1, 4000).trim();
  if (!message) throw new HttpError(400, "提交信息不能为空");
  const files = Array.isArray(body.files) ? body.files.map((f) => String(f ?? "").trim()).filter(Boolean) : [];
  const push = Boolean(body.push);
  const createPr = Boolean(body.create_pr);
  const prTitle = typeof body.pr_title === "string" ? body.pr_title.trim() : "";
  const prBody = typeof body.pr_body === "string" ? body.pr_body.trim() : "";
  const prBase = typeof body.pr_base === "string" ? body.pr_base.trim() : "";

  const [machine, candidates] = await resolveDevice(c.var.deps.db, c.var.deps.settings, deviceId, user);
  if (!deviceSupportsNativeGit(machine, user, c.var.deps.settings)) {
    const doPush = push || createPr;
    const isWin = isWindowsDevice(machine, user, c.var.deps.settings, cwd);
    let cmd: string;
    if (isWin) {
      const addCmd = files.length ? `git add -- ${files.map(psQuote).join(" ")}` : "git add -A";
      const parts = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
        "$root = (git rev-parse --show-toplevel 2>$null); if ($LASTEXITCODE -ne 0 -or -not $root) { Write-Output 'ERR:当前目录不是 Git 仓库'; exit 2 };",
        "Set-Location -LiteralPath $root;",
        "$br = (git symbolic-ref --short HEAD 2>$null); if (-not $br) { $br = 'HEAD' };",
        `${addCmd}; if ($LASTEXITCODE -ne 0) { Write-Output 'ERR:暂存改动失败'; exit 3 };`,
        "$st = (git diff --cached --name-only);",
        `if ($st) { git commit -m ${psQuote(message)}; if ($LASTEXITCODE -ne 0) { Write-Output 'ERR:提交失败'; exit 4 } }`,
        `elseif (-not $${doPush ? "true" : "false"}) { Write-Output 'ERR:没有可提交的改动'; exit 5 };`,
        '$sha = (git rev-parse HEAD 2>$null); Write-Output "META:$root|$br|$sha";',
      ];
      if (doPush) parts.push("git push -u origin $br; if ($LASTEXITCODE -ne 0) { Write-Output 'ERR:推送远端失败'; exit 6 }; Write-Output 'PUSHED:1';");
      if (createPr) {
        const pt = prTitle || message.split(/\r?\n/)[0]!.trim();
        const pb = prBody || "由 Memento 一键创建。";
        const baseOpt = prBase ? ` --base ${psQuote(prBase)}` : "";
        parts.push(`$prOut = (gh pr create --title ${psQuote(pt)} --body ${psQuote(pb)}${baseOpt} 2>&1 | Out-String); Write-Output "PR_OUT:$prOut";`);
      }
      cmd = parts.join(" ");
    } else {
      const addCmd = files.length ? `git add -- ${files.map(shQuote).join(" ")}` : "git add -A";
      const lines = [
        'ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "ERR:当前目录不是 Git 仓库"; exit 2; }',
        'cd "$ROOT" || exit 2',
        'BR=$(git symbolic-ref --short HEAD 2>/dev/null || echo "HEAD")',
        `${addCmd} || { echo "ERR:暂存改动失败"; exit 3; }`,
        'if [ -n "$(git diff --cached --name-only)" ]; then',
        `  git commit -m ${shQuote(message)} || { echo "ERR:提交失败"; exit 4; }`,
        "else",
        `  ${doPush ? "true" : "echo ERR:没有可提交的改动; exit 5"}`,
        "fi",
        'SHA=$(git rev-parse HEAD 2>/dev/null || echo "")',
        'echo "META:${ROOT}|${BR}|${SHA}"',
      ];
      if (doPush) {
        lines.push('git push -u origin "$BR" || { echo "ERR:推送远端失败"; exit 6; }');
        lines.push('echo "PUSHED:1"');
      }
      if (createPr) {
        const pt = prTitle || message.split(/\r?\n/)[0]!.trim();
        const pb = prBody || "由 Memento 一键创建。";
        const baseOpt = prBase ? ` --base ${shQuote(prBase)}` : "";
        lines.push(`PR_OUT=$(gh pr create --title ${shQuote(pt)} --body ${shQuote(pb)}${baseOpt} 2>&1 || true)`);
        lines.push('echo "PR_OUT:${PR_OUT}"');
      }
      cmd = lines.join("\n");
    }

    const [code, stdout, stderr, errCode] = await runEphemeralShell(candidates, cwd, cmd, 70);
    if (errCode === "offline") throw new HttpError(503, "目标设备当前不在线");
    if (errCode === "timeout") throw new HttpError(504, "提交/推送超时");
    const metaM = /META:([^|\r\n]*)\|([^|\r\n]*)\|([0-9a-fA-F]*)/.exec(stdout);
    const repoRoot = metaM?.[1] || cwd;
    const branch = metaM?.[2] || "HEAD";
    const commitSha = metaM?.[3] || "";
    const pushed = stdout.includes("PUSHED:1");
    if (code !== 0) {
      const errM = /ERR:([^\r\n]+)/.exec(stdout);
      const detail = errM?.[1] || (stderr || stdout).trim().slice(0, 300) || "Git 交付失败";
      if (commitSha) return c.json({ ok: false, repo_root: repoRoot, branch, commit_sha: commitSha, pushed, error: detail });
      throw new HttpError(400, detail);
    }
    let prUrl: string | null = null;
    let prError: string | null = null;
    if (createPr) {
      const idx = stdout.indexOf("PR_OUT:");
      const prRaw = idx >= 0 ? stdout.slice(idx + 7).trim() : "";
      const urlM = /https:\/\/[^\s]+/.exec(prRaw);
      if (urlM) prUrl = urlM[0];
      else prError = prRaw.slice(0, 300) || "创建 PR 失败（请确认目标设备已安装并登录 gh CLI）";
    }
    const summaryParts: string[] = [];
    if (commitSha) summaryParts.push(`已提交 ${commitSha.slice(0, 8)}`);
    if (pushed) summaryParts.push(`已推送到 origin/${branch}`);
    if (prUrl) summaryParts.push("已创建 PR");
    return c.json({
      ok: !prError,
      repo_root: repoRoot,
      branch,
      commit_sha: commitSha,
      pushed,
      pr_url: prUrl,
      pr_error: prError,
      summary: summaryParts.join(" · ") || "操作完成",
      ...(prError ? { error: prError } : {}),
      legacy_fallback: true,
    });
  }

  const payload: Record<string, unknown> = {
    type: "git_commit_push_pr_req",
    cwd,
    message,
    push: push || createPr,
    create_pr: createPr,
  };
  if (files.length) payload.files = files;
  if (prTitle) payload.pr_title = prTitle;
  if (prBody) payload.pr_body = prBody;
  if (prBase) payload.pr_base = prBase;

  const resp = await rpcDevice(candidates, payload, 70);
  if (resp.code === "offline") throw new HttpError(503, String(resp.error || "目标设备当前不在线"));
  if (resp.code === "timeout") throw new HttpError(504, String(resp.error || "提交/推送超时"));
  if (!resp.ok && !resp.commit_sha) throw new HttpError(400, String(resp.error || "Git 交付失败"));
  return c.json(resp);
});

gitReviewRoutes.post("/suggest-message", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const diff = await computeGitDiff(c.var.deps, user, {
    deviceId: reqStr(body, "device_id"),
    cwd: reqStr(body, "cwd"),
    baseRef: typeof body.base_ref === "string" ? body.base_ref : undefined,
    targetRef: typeof body.target_ref === "string" ? body.target_ref : undefined,
  });
  const reqFiles = Array.isArray(body.files) ? body.files.map(String) : null;
  const diffText = diffForPrompt(diff, reqFiles);
  if (!diffText.trim()) throw new HttpError(400, "没有可描述的改动");

  const recent = (Array.isArray(diff.recent_commits) ? (diff.recent_commits as Record<string, unknown>[]) : [])
    .slice(0, 12)
    .map((x) => String(x.subject ?? ""))
    .filter(Boolean);

  let guidance = "";
  try {
    const ruleRows = await c.var.deps.db
      .select({ content: userMemories.content })
      .from(userMemories)
      .where(and(eq(userMemories.userId, user.id), eq(userMemories.status, "active"), inArray(userMemories.category, ["rule", "preference", "habit"])))
      .orderBy(desc(userMemories.updatedAt))
      .limit(40);
    guidance = ruleRows.map((r) => r.content).join("\n");
  } catch {
    /* ignore */
  }
  const rules = commitRulesFromGuidance(guidance);

  const system =
    "你是资深工程师，为一组代码改动写 git 提交说明和 PR。只输出一个 JSON 对象：" +
    '{"message": "提交说明（第一行是标题，可空一行后写正文要点）", "pr_title": "PR 标题", "pr_body": "PR 描述（Markdown，改了什么、为什么、怎么验证）"}。' +
    "风格跟仓库最近的提交保持一致（语言、前缀格式、长度）；只写改动里确实有的内容，不编造；" +
    "不要加任何 Co-Authored-By、Generated with 之类的署名尾注。";
  const userMsg =
    (rules ? `用户关于提交的规则：\n${rules}\n\n` : "") +
    (recent.length ? `仓库最近的提交标题：\n${recent.map((s) => `- ${s}`).join("\n")}\n\n` : "") +
    `当前分支：${String(diff.branch || "未知")}\n\n改动：\n${diffText}`;

  const raw = await callPlainChat(
    c.var.deps.settings,
    c.var.deps.redis(),
    [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
    { temperature: 0.2, maxTokens: 1200, timeoutSec: 90, user, background: false },
  );
  if (!raw) throw new HttpError(502, "模型没有返回内容，检查个人设置里的大模型配置");
  const out = parseSuggestion(raw);
  return c.json({
    message: stripAgentTrailers(out.message),
    pr_title: stripAgentTrailers(out.pr_title),
    pr_body: stripAgentTrailers(out.pr_body),
    branch: diff.branch ?? null,
  });
});

gitReviewRoutes.post("/prs", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const stateRaw = typeof body.state === "string" ? body.state : "open";
  const state = ["open", "closed", "merged", "all"].includes(stateRaw) ? stateRaw : "open";
  const rows = jsonOr502(
    await runGh(c.var.deps, user, reqStr(body, "device_id"), reqStr(body, "cwd"), `pr list --state ${state} --limit 40 --json ${PR_LIST_FIELDS}`),
  ) as Record<string, unknown>[];
  for (const r of rows) {
    const rollup = r.statusCheckRollup as Record<string, unknown>[] | undefined;
    delete r.statusCheckRollup;
    r.checks = summarizeChecks(rollup);
    const author = r.author && typeof r.author === "object" ? (r.author as Record<string, unknown>) : null;
    r.author = String(author?.login ?? "");
  }
  return c.json({ prs: rows });
});

gitReviewRoutes.post("/pr", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const deviceId = reqStr(body, "device_id");
  const cwd = reqStr(body, "cwd");
  const num = reqInt(body, "number", 1);
  const pr = jsonOr502(await runGh(c.var.deps, user, deviceId, cwd, `pr view ${num} --json ${PR_VIEW_FIELDS}`)) as Record<string, unknown>;
  const rollup = (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []) as Record<string, unknown>[];
  delete pr.statusCheckRollup;
  pr.checks = summarizeChecks(rollup);
  pr.check_runs = rollup.map((x) => ({
    name: String(x.name || x.context || ""),
    status: String(x.status || ""),
    conclusion: String(x.conclusion || x.state || ""),
    url: String(x.detailsUrl || x.targetUrl || ""),
  }));
  const author = pr.author && typeof pr.author === "object" ? (pr.author as Record<string, unknown>) : null;
  pr.author = String(author?.login ?? "");
  let diff = "";
  try {
    diff = await runGh(c.var.deps, user, deviceId, cwd, `pr diff ${num}`, 45);
  } catch {
    diff = "";
  }
  pr.diff = diff.slice(0, PR_DIFF_CHARS);
  pr.diff_truncated = diff.length > PR_DIFF_CHARS;
  return c.json(pr);
});

gitReviewRoutes.post("/pr/merge", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const methodRaw = typeof body.method === "string" ? body.method : "rebase";
  const method = ["rebase", "squash", "merge"].includes(methodRaw) ? methodRaw : "rebase";
  const delBranch = body.delete_branch !== false;
  const num = reqInt(body, "number", 1);
  const out = await runGh(
    c.var.deps,
    user,
    reqStr(body, "device_id"),
    reqStr(body, "cwd"),
    `pr merge ${num} --${method}${delBranch ? " --delete-branch" : ""}`,
    60,
  );
  return c.json({ ok: true, method, output: out.trim().slice(0, 2000) });
});

gitReviewRoutes.post("/pr/watch-checks", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const deviceId = reqStr(body, "device_id");
  const cwd = reqStr(body, "cwd");
  const num = reqInt(body, "number", 1);
  const deps = c.var.deps;
  cluster.spawn(() => watchPrChecks(deps, user, deviceId, cwd, num).then(() => {}));
  return c.json({ ok: true });
});

gitReviewRoutes.post("/repos", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const deviceId = reqStr(body, "device_id");
  const cwd = reqStr(body, "cwd").trim();
  const [machine, candidates] = await resolveDevice(c.var.deps.db, c.var.deps.settings, deviceId, user);
  const windows = isWindowsDevice(machine, user, c.var.deps.settings, cwd);
  const [, out, , transport] = await runEphemeralShell(candidates, cwd, reposCommand(cwd, windows), 20);
  if (transport === "offline") throw new HttpError(503, "目标设备当前不在线");
  if (transport === "timeout") throw new HttpError(504, "查找仓库超时");
  return c.json({ repos: parseRepoRoots(out, cwd, windows) });
});
