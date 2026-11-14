// BUSINESS_BLUEPRINT.md: what the project is supposed to do, tied to the code that does it, checked on
// every commit. PROJECT_BLUEPRINT.md maps the code; it can't say the code does the wrong thing, because
// the code is all it reads. Most bugs fixed in memento on 2026-11-14 were of that kind: the user's rule
// was clear ("the agent works in the folder I picked"), the code did something else (it took the
// project made last), and nothing in the code looked wrong. This file holds the rules, the terms, the
// flows and who owns each piece of state, each with where it lives in the code; the checks below say
// when that link breaks or a rule is broken.
//
// The file is written by people and agents; the generator only fills two regions between markers (an
// index at the top, the check results at the bottom) and leaves everything else as it is.
//
// Entries are `### <ID> <title>` headings, the ID's letter telling the kind:
//   T- a term        what a word means here, and where the code decides it
//   F- a flow        numbered steps, each with where it happens
//   R- a rule        what must hold, said by whom and when, the code that keeps it, the test that proves it
//   S- a state       one piece of state: its single source of truth, its copies and how they stay in step
// with list fields under it:
//   - 来源: who said it, when, their words           (rules)
//   - 代码: `path#symbol`, `path`                     code that decides it (a symbol is found by name)
//   - 测试: `test/file.ts#a test's title`             the test that proves it (title found in the file)
//   - 禁止: `text` @ `path`; `/regex/` @ `dir/`       must not appear there: how the bug looked
//   - 要求: `text` @ `path`                           must appear there: what keeps it fixed
//   - 事实源 / 副本 / 同步: …                          (states) anchors in them are checked too
// Flow steps are numbered lines; backticked `path#symbol` in them are anchors.
import { BUSINESS_FILE } from "./meta.js";
import { atomicWrite, exists, isDir, isFile, iterdir, pjoin, pname, readTextIgnore, relTo, runGit, toPosix } from "./files.js";

export { BUSINESS_FILE };

export type EntryKind = "term" | "flow" | "rule" | "state";
const KIND_OF: Record<string, EntryKind> = { T: "term", F: "flow", R: "rule", S: "state" };
const KIND_LABEL: Record<EntryKind, string> = { term: "术语", flow: "流程", rule: "规则", state: "状态" };

export const INDEX_START = "<!-- memento:business-index:start (自动生成，勿手改) -->";
export const INDEX_END = "<!-- memento:business-index:end -->";
export const CHECK_START = "<!-- memento:business-check:start (自动生成，勿手改) -->";
export const CHECK_END = "<!-- memento:business-check:end -->";

const ENTRY_RE = /^###\s+([TFRS]-[A-Z0-9][A-Z0-9-]*)\s+(.+?)\s*$/;
const FIELD_RE = /^\s*[-*]\s*(来源|代码|测试|禁止|要求|事实源|副本|同步|定义|说明)\s*[:：]\s*(.*)$/;
const STEP_RE = /^\s*\d+[.)、]\s+(.*)$/;
const TICKED_RE = /`([^`\n]+)`/g;
/** Fields whose backticked paths are code anchors */
const ANCHOR_FIELDS = new Set(["代码", "事实源", "副本", "同步"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "__pycache__", ".venv", "venv", ".turbo", "target"]);
const MAX_SCAN_FILES = 20_000;
const MAX_HITS = 5;

export interface Anchor {
  ref: string; // as written: path#symbol
  path: string;
  symbol: string;
  ok: boolean;
  line?: number;
  reason?: string;
}
export interface PatternCheck {
  pattern: string;
  paths: string[];
  /** 禁止: where it was found (must stay empty). 要求: whether it was found. */
  hits: string[];
  ok: boolean;
  reason?: string;
}
export interface Entry {
  id: string;
  kind: EntryKind;
  title: string;
  line: number; // 1-based line of the heading
  sources: string[];
  anchors: Anchor[];
  tests: Anchor[];
  forbidden: PatternCheck[];
  required: PatternCheck[];
}
export type Verdict = "ok" | "warn" | "fail";
export interface EntryResult extends Entry {
  verdict: Verdict;
  problems: string[];
}
export interface ImpactItem {
  commit: string;
  subject: string;
  ids: string[];
}
export interface BusinessReport {
  file: string;
  entries: EntryResult[];
  counts: Record<EntryKind, number>;
  rules: { ok: number; warn: number; fail: number };
  fails: number;
  warns: number;
  impact: ImpactItem[];
  duplicates: string[];
}

// ---------------------------------------------------------------- parsing

/** `path#symbol` → [path, symbol]; a bare path has no symbol. Leading ./ dropped, separators as /. */
function splitRef(ref: string): [string, string] {
  const at = ref.indexOf("#");
  const path = (at < 0 ? ref : ref.slice(0, at)).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return [path, at < 0 ? "" : ref.slice(at + 1).trim()];
}

/** Whether a backticked token names a file or folder rather than being code or a word. */
export function looksLikePath(tok: string): boolean {
  const [path] = splitRef(tok);
  if (!path || /\s/.test(path) || /^[a-z]+:\/\//i.test(path)) return false;
  return path.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(path);
}

function anchorsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TICKED_RE)) if (looksLikePath(m[1]!)) out.push(m[1]!.trim());
  return out;
}

/** `text` @ `path`, `path2`; `/re/` @ `dir/` → one check per clause. */
function patternClauses(text: string): Array<{ pattern: string; paths: string[] }> {
  const out: Array<{ pattern: string; paths: string[] }> = [];
  for (const clause of text.split(/[;；]/)) {
    const at = clause.search(/\s@\s/);
    if (at < 0) continue;
    const pat = [...clause.slice(0, at).matchAll(TICKED_RE)].map((m) => m[1]!)[0];
    const paths = [...clause.slice(at).matchAll(TICKED_RE)].map((m) => splitRef(m[1]!)[0]).filter(Boolean);
    if (pat && paths.length) out.push({ pattern: pat, paths });
  }
  return out;
}

/** The entries of a business blueprint, in file order. Text inside the generated regions is skipped. */
export function parseBusinessBlueprint(text: string): Entry[] {
  const lines = text.split("\n");
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  let inGenerated = false;
  let inFence = false;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(INDEX_START) || line.startsWith(CHECK_START)) inGenerated = true;
    if (line.startsWith(INDEX_END) || line.startsWith(CHECK_END)) {
      inGenerated = false;
      return;
    }
    if (inGenerated) return;
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const head = line.match(ENTRY_RE);
    if (head) {
      cur = { id: head[1]!, kind: KIND_OF[head[1]![0]!]!, title: head[2]!, line: i + 1, sources: [], anchors: [], tests: [], forbidden: [], required: [] };
      entries.push(cur);
      return;
    }
    if (/^#{1,3}\s/.test(line)) {
      cur = null;
      return;
    }
    if (!cur) return;
    const e: Entry = cur;
    const field = line.match(FIELD_RE);
    if (field) {
      const [, name, value] = field as unknown as [string, string, string];
      if (name === "来源") e.sources.push(value.trim());
      else if (ANCHOR_FIELDS.has(name)) for (const ref of anchorsIn(value)) e.anchors.push(blankAnchor(ref));
      else if (name === "测试") for (const ref of anchorsIn(value)) e.tests.push(blankAnchor(ref));
      else if (name === "禁止") for (const c of patternClauses(value)) e.forbidden.push({ ...c, hits: [], ok: true });
      else if (name === "要求") for (const c of patternClauses(value)) e.required.push({ ...c, hits: [], ok: true });
      return;
    }
    const step = line.match(STEP_RE);
    if (step && e.kind === "flow") for (const ref of anchorsIn(step[1]!)) e.anchors.push(blankAnchor(ref));
  });
  return entries;
}

function blankAnchor(ref: string): Anchor {
  const [path, symbol] = splitRef(ref);
  return { ref, path, symbol, ok: true };
}

// ---------------------------------------------------------------- checking

const fileCache = new Map<string, string | null>();
function fileText(root: string, rel: string): string | null {
  const key = `${root}\0${rel}`;
  if (!fileCache.has(key)) {
    const p = pjoin(root, rel);
    fileCache.set(key, isFile(p) ? readTextIgnore(p) : null);
  }
  return fileCache.get(key)!;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Line (1-based) where `symbol` is in `text`, 0 when it isn't. An identifier (or a dotted / `::` chain:
 * `Class.method`) is matched as whole words, its last part preferring a definition; anything else is
 * found as written.
 */
export function findSymbol(text: string, symbol: string): number {
  const lines = text.split("\n");
  const ident = /^[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*$/.test(symbol);
  if (!ident) {
    const i = lines.findIndex((l) => l.includes(symbol));
    return i + 1;
  }
  const parts = symbol.split(/\.|::/);
  const last = parts[parts.length - 1]!;
  const word = new RegExp(`(?<![\\w$])${escapeRe(last)}(?![\\w$])`);
  const def = new RegExp(
    `(?:function\\*?|class|def|interface|type|enum|const|let|var|async\\s+def|async\\s+function)\\s+${escapeRe(last)}(?![\\w$])|(?<![\\w$.])${escapeRe(last)}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function|\\w+\\s*=>|use[A-Z]\\w*\\()|^\\s*(?:(?:public|private|protected|static|async|export|readonly)\\s+)*${escapeRe(last)}\\s*\\(`,
  );
  // A chain needs its first part in the file too
  if (parts.length > 1) {
    const first = new RegExp(`(?<![\\w$])${escapeRe(parts[0]!)}(?![\\w$])`);
    if (!lines.some((l) => first.test(l))) return 0;
  }
  const d = lines.findIndex((l) => def.test(l));
  if (d >= 0) return d + 1;
  return lines.findIndex((l) => word.test(l)) + 1;
}

function checkAnchor(root: string, a: Anchor): Anchor {
  const abs = pjoin(root, a.path);
  if (!exists(abs)) return { ...a, ok: false, reason: "文件不存在" };
  if (!a.symbol) return { ...a, ok: true };
  if (isDir(abs)) return { ...a, ok: false, reason: "目录不能带符号" };
  const text = fileText(root, a.path) ?? "";
  const line = findSymbol(text, a.symbol);
  return line ? { ...a, ok: true, line } : { ...a, ok: false, reason: `找不到 ${a.symbol}` };
}

function checkTest(root: string, a: Anchor): Anchor {
  const abs = pjoin(root, a.path);
  if (!isFile(abs)) return { ...a, ok: false, reason: "测试文件不存在" };
  if (!a.symbol) return { ...a, ok: true };
  const text = fileText(root, a.path) ?? "";
  const i = text.split("\n").findIndex((l) => l.includes(a.symbol));
  return i >= 0 ? { ...a, ok: true, line: i + 1 } : { ...a, ok: false, reason: `测试里找不到「${a.symbol}」` };
}

/** Files under `rel` (itself when it's a file), skipping dependencies and build output. */
function filesUnder(root: string, rel: string): string[] {
  const start = pjoin(root, rel);
  if (isFile(start)) return [rel.replace(/\/+$/, "")];
  if (!isDir(start)) return [];
  const out: string[] = [];
  const stack = [start];
  while (stack.length && out.length < MAX_SCAN_FILES) {
    const d = stack.pop()!;
    let kids: string[];
    try {
      kids = iterdir(d).sort();
    } catch {
      continue;
    }
    for (const k of kids) {
      const name = pname(k);
      if (isDir(k)) {
        if (!SKIP_DIRS.has(name) && !name.startsWith(".")) stack.push(k);
      } else if (isFile(k)) {
        out.push(toPosix(relTo(k, root)));
      }
    }
  }
  return out;
}

function patternTester(pattern: string): (line: string) => boolean {
  const re = pattern.length > 2 && pattern.startsWith("/") && pattern.lastIndexOf("/") > 0 ? pattern.slice(1, pattern.lastIndexOf("/")) : null;
  if (re !== null) {
    try {
      const flags = pattern.slice(pattern.lastIndexOf("/") + 1).replace(/[^imsu]/g, "");
      const r = new RegExp(re, flags);
      return (l) => r.test(l);
    } catch {
      return () => false;
    }
  }
  return (l) => l.includes(pattern);
}

/** Files whose comment lines are skipped by 禁止 / 要求: a fix's own comment naming the old way isn't the old way. */
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|ya?ml|sh|bash|css|scss|go|rs|java|kt|swift|rb|toml)$/i;
const COMMENT_LINE = /^\s*(?:\/\/|#(?!!)|\/?\*|<!--)/;

function scanPattern(root: string, c: PatternCheck, forbid: boolean): PatternCheck {
  const test = patternTester(c.pattern);
  const missing = c.paths.filter((p) => !exists(pjoin(root, p)));
  if (missing.length) return { ...c, ok: false, hits: [], reason: `路径不存在: ${missing.join(", ")}` };
  const hits: string[] = [];
  for (const p of c.paths) {
    for (const f of filesUnder(root, p)) {
      const text = fileText(root, f);
      if (text === null || text.includes("\u0000")) continue;
      const lines = text.split("\n");
      const code = CODE_EXT.test(f);
      for (let i = 0; i < lines.length; i++) {
        if (code && COMMENT_LINE.test(lines[i]!)) continue;
        if (!test(lines[i]!)) continue;
        hits.push(`${f}:${i + 1}`);
        if (!forbid || hits.length >= MAX_HITS) break;
      }
      if (hits.length >= MAX_HITS || (!forbid && hits.length)) break;
    }
    if (!forbid && hits.length) break;
  }
  return { ...c, hits, ok: forbid ? hits.length === 0 : hits.length > 0 };
}

/** Run every entry's checks against the code under `root`. */
export function checkEntries(root: string, entries: Entry[]): EntryResult[] {
  fileCache.clear();
  return entries.map((e) => {
    const anchors = e.anchors.map((a) => checkAnchor(root, a));
    const tests = e.tests.map((a) => checkTest(root, a));
    const forbidden = e.forbidden.map((c) => scanPattern(root, c, true));
    const required = e.required.map((c) => scanPattern(root, c, false));
    const problems: string[] = [];
    for (const a of anchors) if (!a.ok) problems.push(`代码位置失效 \`${a.ref}\`：${a.reason}`);
    for (const a of tests) if (!a.ok) problems.push(`测试失效 \`${a.ref}\`：${a.reason}`);
    for (const c of forbidden) {
      if (c.reason) problems.push(`禁止项 \`${c.pattern}\`：${c.reason}`);
      else if (!c.ok) problems.push(`出现了禁止的写法 \`${c.pattern}\`：${c.hits.join(", ")}`);
    }
    for (const c of required) {
      if (c.reason) problems.push(`要求项 \`${c.pattern}\`：${c.reason}`);
      else if (!c.ok) problems.push(`缺少要求的写法 \`${c.pattern}\`（在 ${c.paths.join(", ")}）`);
    }
    let verdict: Verdict = problems.length ? "fail" : "ok";
    if (verdict === "ok") {
      if (e.kind === "rule" && !anchors.length) problems.push("没有挂代码位置");
      if (e.kind === "rule" && !tests.length && !forbidden.length && !required.length) problems.push("没有测试或检查保证");
      if (e.kind === "rule" && !e.sources.length) problems.push("没有写来源");
      if (e.kind !== "rule" && !anchors.length) problems.push("没有挂代码位置");
      if (problems.length) verdict = "warn";
    }
    return { ...e, anchors, tests, forbidden, required, verdict, problems };
  });
}

function covers(path: string, file: string): boolean {
  const p = path.replace(/\/+$/, "");
  return file === p || file.startsWith(p + "/");
}

function lastPart(symbol: string): string {
  const parts = symbol.split(/\.|::/);
  return parts[parts.length - 1]!;
}

interface CommitDiff {
  commit: string;
  subject: string;
  /** file → its changed lines (added and removed), and the new-side line ranges of its hunks */
  files: Map<string, { changed: string; ranges: Array<[number, number]> }>;
}

/** The last `n` commits as files, changed lines and hunk ranges (`git log -p -U0`), CI bot commits left out. */
function recentDiffs(root: string, n: number): CommitDiff[] {
  const log = runGit(["log", `-${n}`, "--no-merges", "-p", "-U0", "--no-color", "--format=%x1e%h%x1f%s"], root);
  if (!log) return [];
  const out: CommitDiff[] = [];
  for (const rec of log.split("\x1e")) {
    const nl = rec.indexOf("\n");
    const head = nl < 0 ? rec : rec.slice(0, nl);
    if (!head.includes("\x1f")) continue;
    const [commit, subject] = head.split("\x1f") as [string, string];
    // The image tag bumps and release metadata the CI bot commits
    if (subject.includes("[skip ci]")) continue;
    const files: CommitDiff["files"] = new Map();
    let cur: { changed: string; ranges: Array<[number, number]> } | null = null;
    for (const line of (nl < 0 ? "" : rec.slice(nl + 1)).split("\n")) {
      const d = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (d) {
        const file = d[2]!;
        cur = file === BUSINESS_FILE || file === "PROJECT_BLUEPRINT.md" ? null : { changed: "", ranges: [] };
        if (cur) files.set(file, cur);
        continue;
      }
      if (!cur) continue;
      const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (h) {
        const start = Number(h[1]);
        const count = h[2] === undefined ? 1 : Number(h[2]);
        // A pure deletion (+N,0) sits between lines N and N+1
        cur.ranges.push(count ? [start, start + count - 1] : [start, start + 1]);
      } else if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
        cur.changed += "\n" + line.slice(1);
      }
    }
    if (files.size) out.push({ commit, subject, files });
  }
  return out;
}

/**
 * Lines [start, end] (1-based) of the definition starting at `line`: until the code comes back to its
 * indentation (a closing bracket at that indentation still belongs to it). One line when the next line
 * is already at its indentation.
 */
export function blockSpan(lines: string[], line: number): [number, number] {
  const indent = (l: string) => l.length - l.trimStart().length;
  const base = indent(lines[line - 1] ?? "");
  let end = line;
  for (let i = line; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    if (indent(l) > base) {
      end = i + 1;
      continue;
    }
    if (indent(l) === base && /^\s*[}\])]/.test(l)) end = i + 1;
    break;
  }
  return [line, end];
}

/** Whether a commit's changes reach an entry: its anchors (a symbol's own lines), its tests, the code its checks look at. */
function touches(root: string, e: Entry, c: CommitDiff, versions: Map<string, string[] | null>): boolean {
  for (const [file, diff] of c.files) {
    for (const a of e.anchors) {
      if (!covers(a.path, file)) continue;
      if (!a.symbol) return true;
      const name = lastPart(a.symbol);
      if (diff.changed.includes(name)) return true;
      // The change is inside the symbol's definition, as the file was at that commit
      const key = `${c.commit}:${file}`;
      if (!versions.has(key)) {
        const text = runGit(["show", key], root);
        versions.set(key, text ? text.split("\n") : null);
      }
      const lines = versions.get(key);
      if (!lines) continue;
      const at = findSymbol(lines.join("\n"), a.symbol);
      if (!at) continue;
      const [s, t] = blockSpan(lines, at);
      if (diff.ranges.some(([x, y]) => x <= t && y >= s)) return true;
    }
    for (const t of e.tests) {
      if (t.path !== file) continue;
      if (!t.symbol || diff.changed.includes(t.symbol)) return true;
    }
    for (const chk of [...e.forbidden, ...e.required]) {
      if (!chk.paths.some((p) => covers(p, file))) continue;
      const test = patternTester(chk.pattern);
      if (diff.changed.split("\n").some((l) => test(l))) return true;
    }
  }
  return false;
}

/**
 * The entries each of the last `n` commits reached (see touches): the rules to look at again after a
 * change. A whole-file anchor counts any change to the file; a `path#symbol` anchor only changes whose
 * lines or enclosing function mention the symbol.
 */
export function recentImpact(root: string, entries: Entry[], n = 8): ImpactItem[] {
  const out: ImpactItem[] = [];
  for (const c of recentDiffs(root, n)) {
    const versions = new Map<string, string[] | null>();
    const ids = entries.filter((e) => touches(root, e, c, versions)).map((e) => e.id);
    if (ids.length) out.push({ commit: c.commit, subject: c.subject, ids: [...new Set(ids)] });
  }
  return out;
}

export function checkBusinessBlueprint(root: string, text?: string): BusinessReport | null {
  const file = pjoin(root, BUSINESS_FILE);
  const body = text ?? (isFile(file) ? readTextIgnore(file) : null);
  if (body === null) return null;
  const parsed = parseBusinessBlueprint(body);
  if (!parsed.length) return null;
  const entries = checkEntries(root, parsed);
  const counts: Record<EntryKind, number> = { term: 0, flow: 0, rule: 0, state: 0 };
  const rules = { ok: 0, warn: 0, fail: 0 };
  for (const e of entries) {
    counts[e.kind]++;
    if (e.kind === "rule") rules[e.verdict]++;
  }
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const e of entries) {
    if (seen.has(e.id)) duplicates.push(e.id);
    seen.add(e.id);
  }
  return {
    file: BUSINESS_FILE,
    entries,
    counts,
    rules,
    fails: entries.filter((e) => e.verdict === "fail").length + duplicates.length,
    warns: entries.filter((e) => e.verdict === "warn").length,
    impact: recentImpact(root, parsed),
    duplicates,
  };
}

// ---------------------------------------------------------------- rendering

const MARK: Record<Verdict, string> = { ok: "✅", warn: "⚠️", fail: "❌" };

function anchorLink(a: Anchor): string {
  const target = a.line ? `${a.path}#L${a.line}` : a.path;
  return `[\`${a.ref}\`](${target})`;
}

/** One line counting it all, for section 0 of both blueprints. */
export function summaryLine(r: BusinessReport): string {
  const c = r.counts;
  return `规则 ${c.rule}（✅ ${r.rules.ok} · ⚠️ ${r.rules.warn} · ❌ ${r.rules.fail}）· 流程 ${c.flow} · 术语 ${c.term} · 状态 ${c.state}`;
}

function problemLines(r: BusinessReport, limit = Infinity): string[] {
  const out: string[] = [];
  for (const id of r.duplicates) out.push(`- ❌ \`${id}\`：编号重复`);
  for (const e of r.entries) {
    if (e.verdict === "ok") continue;
    out.push(`- ${MARK[e.verdict]} \`${e.id}\` ${e.title}（L${e.line}）：${e.problems.join("；")}`);
  }
  if (out.length > limit) return [...out.slice(0, limit), `- …… 还有 ${out.length - limit} 条，见 ${BUSINESS_FILE} 末尾「自动核对」`];
  return out;
}

/** The generated block at the end of BUSINESS_BLUEPRINT.md: stable while the results are (no commit hash). */
export function renderCheckRegion(r: BusinessReport): string[] {
  const lines = [
    CHECK_START,
    "## 自动核对 (Auto Check)",
    "",
    "> 生成器随每次提交核对：代码位置还在不在、测试还在不在、禁止 / 要求的写法满不满足。✅ 通过 · ⚠️ 缺代码位置、测试或来源 · ❌ 位置失效或违反规则（CI 会拦下）。",
    "",
    `- 汇总：${summaryLine(r)}`,
    "",
    "| 编号 | 名称 | 代码位置 | 测试 | 检查 | 结论 |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |",
  ];
  for (const e of r.entries) {
    const okA = e.anchors.filter((a) => a.ok).length;
    const okT = e.tests.filter((a) => a.ok).length;
    const checks = e.forbidden.length + e.required.length;
    const okC = e.forbidden.filter((c) => c.ok).length + e.required.filter((c) => c.ok).length;
    const frac = (ok: number, all: number) => (all ? `${ok}/${all}` : "—");
    lines.push(`| \`${e.id}\` | ${e.title.replace(/\|/g, "\\|")} | ${frac(okA, e.anchors.length)} | ${frac(okT, e.tests.length)} | ${frac(okC, checks)} | ${MARK[e.verdict]} |`);
  }
  const problems = problemLines(r);
  lines.push("", "### 需要处理", "", ...(problems.length ? problems : ["- 没有。"]), CHECK_END);
  return lines;
}

/** The generated index after the title: sections with line ranges, so an agent reads only what it needs. */
function renderIndex(r: BusinessReport, sections: Array<{ title: string; start: number; end: number }>): string[] {
  return [
    INDEX_START,
    "> 先读这一段定位；要细节时按下表行号只读对应章节。改了「代码位置」里的文件，先看对应条目还成不成立。",
    "",
    `- 汇总：${summaryLine(r)}`,
    `- 核对：${r.fails ? `❌ ${r.fails} 条需要处理` : "全部通过"}${r.warns ? ` · ⚠️ ${r.warns} 条待补` : ""}（详见末尾「自动核对」）`,
    "",
    "| 章节 | 行号 |",
    "| :--- | :--- |",
    ...sections.map((s) => `| ${s.title} | L${s.start}-L${s.end} |`),
    INDEX_END,
  ];
}

function stripRegion(lines: string[], start: string, end: string): { lines: string[]; at: number } {
  const s = lines.findIndex((l) => l.startsWith(start));
  if (s < 0) return { lines, at: -1 };
  let e = lines.findIndex((l, i) => i > s && l.startsWith(end));
  if (e < 0) e = s;
  return { lines: [...lines.slice(0, s), ...lines.slice(e + 1)], at: s };
}

/**
 * BUSINESS_BLUEPRINT.md with both generated regions brought up to date: the index right after the title
 * (or where it already is), the check results at the end. Everything else is left exactly as written.
 */
export function refreshBusinessText(root: string, text: string): { text: string; report: BusinessReport } | null {
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  const idx = stripRegion(lines, INDEX_START, INDEX_END);
  lines = idx.lines;
  lines = stripRegion(lines, CHECK_START, CHECK_END).lines;
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  // Index after the title line (and the blank line under it), unless it already had a place
  let at = idx.at;
  if (at < 0) {
    const title = lines.findIndex((l) => l.startsWith("# "));
    at = title < 0 ? 0 : title + 1;
    if (lines[at] !== undefined && !lines[at]!.trim()) at++;
  }
  // Checked on the text as written; entry lines then moved past the index that goes in before them
  const report = checkBusinessBlueprint(root, lines.join("\n"));
  if (!report) return null;
  const indexLen = renderIndex(report, Array.from({ length: lines.slice(at).filter((l) => l.startsWith("## ")).length + 1 }, () => ({ title: "", start: 0, end: 0 }))).length;
  for (const e of report.entries) if (e.line > at) e.line += indexLen;
  const check = renderCheckRegion(report);
  // Index rows are one per "## " heading after it, plus the check region's own heading
  const headingsAfter = lines.slice(at).filter((l) => l.startsWith("## ")).length + 1;
  const placeholder = renderIndex(report, Array.from({ length: headingsAfter }, () => ({ title: "", start: 0, end: 0 })));
  const out = [...lines.slice(0, at), ...placeholder, ...lines.slice(at), "", ...check, ""];
  const starts: number[] = [];
  for (let i = at + placeholder.length; i < out.length; i++) if (out[i]!.startsWith("## ")) starts.push(i);
  const sections = starts.map((s, n) => {
    let end = (n + 1 < starts.length ? starts[n + 1]! : out.length) - 1;
    while (end > s && (!out[end]!.trim() || out[end]!.startsWith("<!-- memento:"))) end--;
    return { title: out[s]!.replace(/^##\s+/, ""), start: s + 1, end: end + 1 };
  });
  const index = renderIndex(report, sections);
  out.splice(at, placeholder.length, ...index);
  return { text: out.join("\n"), report };
}

/** Rewrite the generated regions of the repo's BUSINESS_BLUEPRINT.md; the report, or null when there's none. */
export function refreshBusinessBlueprint(root: string): BusinessReport | null {
  const file = pjoin(root, BUSINESS_FILE);
  if (!isFile(file)) return null;
  const res = refreshBusinessText(root, readTextIgnore(file));
  if (!res) return null;
  atomicWrite(file, res.text);
  return res.report;
}

/** Section 11 of PROJECT_BLUEPRINT.md: how the business blueprint holds against this code, and what recent commits touched. */
export function projectBlueprintSection(r: BusinessReport): string[] {
  const lines = [
    "## 11. 业务蓝图核对 (Business Blueprint Check)",
    "",
    `- 业务蓝图：[${BUSINESS_FILE}](${BUSINESS_FILE}) · ${summaryLine(r)}`,
    `- 结论：${r.fails ? `❌ ${r.fails} 条位置失效或违反规则` : "✅ 没有失效或违规"}${r.warns ? ` · ⚠️ ${r.warns} 条缺测试 / 代码位置 / 来源` : ""}`,
  ];
  const problems = problemLines(r, 12);
  if (problems.length) lines.push("", "### 需要处理", "", ...problems);
  if (r.impact.length) {
    lines.push("", "### 最近提交碰到的业务条目（改动后复查它们还成不成立）", "");
    for (const it of r.impact) lines.push(`- \`${it.commit}\` ${it.subject.slice(0, 80)} → ${it.ids.map((id) => `\`${id}\``).join(", ")}`);
  }
  return lines;
}

/** Plain-text report for `--business` (CI, a terminal). */
export function formatReport(r: BusinessReport): string {
  const out = [`${BUSINESS_FILE}: ${summaryLine(r)}`];
  const problems = problemLines(r);
  out.push(...(problems.length ? problems : ["全部通过。"]));
  if (r.impact.length) {
    out.push("最近提交碰到的条目:");
    for (const it of r.impact) out.push(`  ${it.commit} ${it.subject.slice(0, 70)} → ${it.ids.join(", ")}`);
  }
  return out.join("\n");
}

/** A starting BUSINESS_BLUEPRINT.md for a repo that has none: the layout, one example of each kind. */
export function businessSkeleton(name: string): string {
  return [
    `# Business Blueprint: ${name}`,
    "",
    "> 业务蓝图：这个项目应该做成什么样，以及每一条落在哪段代码、由哪个测试保证。和 PROJECT_BLUEPRINT.md（代码长什么样）配合看。",
    "> 条目格式见 `scripts/project_blueprint.mjs --help` 的业务蓝图说明；`### ` 开头的编号 T-/F-/R-/S- 分别是术语、流程、规则、状态。",
    "",
    "## 1. 业务对象与术语",
    "",
    "### T-EXAMPLE 示例术语",
    "- 定义: 这个词在本项目里的准确意思。",
    "- 代码: `src/example.ts#decide`",
    "",
    "## 2. 关键流程",
    "",
    "### F-EXAMPLE 示例流程",
    "1. 用户发起 — `src/page.tsx#submit`",
    "2. 服务端处理 — `server/api.py#handle`",
    "",
    "## 3. 业务规则",
    "",
    "### R-EXAMPLE 示例规则",
    "- 来源: 用户 YYYY-MM-DD「原话」",
    "- 代码: `src/example.ts#decide`",
    "- 测试: `test/example.test.ts#the test title`",
    "- 禁止: `bad pattern` @ `src/`",
    "",
    "## 4. 状态归属",
    "",
    "### S-EXAMPLE 示例状态",
    "- 事实源: `server/models.py#Thing`",
    "- 副本: `web/cache.ts#thingCache`（失效方式）",
    "",
  ].join("\n");
}

export { KIND_LABEL };
