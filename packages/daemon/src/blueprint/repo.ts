// What the generator does to a repo besides writing the blueprint: the git hooks that keep it
// current, the HEAD marker the collector compares, the .git/info/exclude line, the optional hint in
// agent instruction files, and a per-repo record of all of it so uninstalling takes everything back.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  atomicWrite,
  chmodExec,
  exists,
  gitOk,
  homeDir,
  isDir,
  isFile,
  isOSError,
  isSymlink,
  iterdir,
  pjoin,
  pname,
  pparent,
  pglob,
  readTextIgnore,
  readTextStrict,
  resolvePath,
  runGit,
  samePath,
  sha1Hex,
  sortedPaths,
  toNative,
  toPosix,
} from "./files.js";
import { cmpStr, isDict, pyGet, pyIter, pyLstrip, pyRstrip, pySplitWs, pySplitlines, pyStr, pyStrip, reEscape, reFinditer, reSub, reSubn, truthy, type PyDict, type PyValue } from "./py.js";
import { dumps, loads } from "./pyjson.js";
import { buildBlueprintContent } from "./content.js";
import {
  BLUEPRINT_FILE,
  BLUEPRINT_SCRIPT_VERSION,
  GENERATED_MARK,
  HEAD_MARKER,
  HOOK_MARKER_END,
  HOOK_MARKER_START,
  LEGACY_GENERATED_MARK,
  LEGACY_SCRIPT_NAME,
  MANAGED_GIT_HOOKS,
  RUNTIME_NAME,
  SCRIPT_NAME,
  scriptVersionOf,
} from "./meta.js";

export { MANAGED_GIT_HOOKS, SCRIPT_NAME };

// Keeps a generated, untracked blueprint out of `git status` (in .git/info/exclude, never .gitignore)
export const EXCLUDE_MARK = "# memento:blueprint (generated locally, not tracked)";
export const ANCHOR_MARKER = "<!-- memento:blueprint-anchor -->";

/** `git rev-parse --git-dir` / `--git-common-dir` as an absolute path (worktrees have a .git file). */
function gitPath(root: string, flag: string): string | null {
  const out = runGit(["rev-parse", flag], root);
  if (out) {
    const p = toPosix(out);
    return resolvePath(/^(?:[A-Za-z]:)?\//.test(p) ? p : pjoin(root, p));
  }
  const dotGit = pjoin(root, ".git");
  return isDir(dotGit) ? dotGit : null;
}

function isTracked(root: string): boolean {
  return gitOk(["ls-files", "--error-unmatch", "--", BLUEPRINT_FILE], root);
}

/** A blueprint this generator (or the Python one before it) wrote, not a hand-written file of the same name. */
export function isGenerated(p: string): boolean {
  let text: string;
  try {
    text = readTextIgnore(p);
  } catch {
    return false;
  }
  return text.startsWith("# Project Blueprint:") && (text.includes(GENERATED_MARK) || text.includes(LEGACY_GENERATED_MARK));
}

// ---------------------------------------------------------------- per-repo state

// What this generator changed in each repo, so turning it off or uninstalling takes all of it back.
// One file per repo: the collector refreshes several repos at once.
function stateDir(): string {
  return pjoin(homeDir(), ".memento", "blueprint_repos");
}

/** Keyed by the resolved root as Python printed it, so records written by the Python generator are found. */
function stateFile(root: string): string {
  return pjoin(stateDir(), `${sha1Hex(toNative(resolvePath(root))).slice(0, 16)}.json`);
}

function loadState(root: string): PyDict {
  try {
    const data = loads(readTextStrict(stateFile(root)));
    return isDict(data) ? data : new Map();
  } catch {
    return new Map();
  }
}

type StateChange = boolean | string[];

/** Merge into the repo's state; lists are unions (hooks, anchors), other values replace. */
function recordState(root: string, changes: Record<string, StateChange>): void {
  const state = loadState(root);
  state.set("root", toNative(resolvePath(root)));
  for (const [key, value] of Object.entries(changes)) {
    if (Array.isArray(value)) {
      const prev = state.get(key);
      const merged = new Set<PyValue>([...pyIter(truthy(prev) ? prev : []), ...value]);
      const items = [...merged];
      if (items.some((x) => typeof x !== "string")) throw new TypeError("'<' not supported between mixed types");
      state.set(key, (items as string[]).sort(cmpStr));
    } else {
      state.set(key, value);
    }
  }
  try {
    const path = stateFile(root);
    fs.mkdirSync(toNative(pparent(path)), { recursive: true });
    atomicWrite(path, dumps(state) + "\n");
  } catch {
    // the state dir can't be written: nothing to take back later
  }
}

// ---------------------------------------------------------------- agent instruction hint

const GUIDANCE_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".clinerules", ".github/copilot-instructions.md"];

/**
 * Add a "read the blueprint first" hint to the repo's own agent instruction files (only with --anchor:
 * these files are usually tracked, and the resident profile already carries the same rule).
 * Returns the files changed, recorded so uninstalling takes the hint back out.
 */
export function ensureAgentGuidanceAnchor(root: string): string[] {
  const anchorSnippet =
    `${ANCHOR_MARKER}\n` +
    "> [!TIP]\n" +
    "> **架构心智指引**：新会话或全局重构前，先读根目录活体代码蓝图 [PROJECT_BLUEPRINT.md](PROJECT_BLUEPRINT.md) 开头的「0. 速览与章节索引」，再按行号只读需要的章节，避免重复 grep 扫描。\n" +
    `${ANCHOR_MARKER}\n\n`;

  const modified: string[] = [];
  for (const rel of GUIDANCE_FILES) {
    const gf = pjoin(root, rel);
    if (!exists(gf)) continue;
    try {
      const text = readTextIgnore(gf);
      if (text.includes(BLUEPRINT_FILE)) continue;
      const lines = pySplitlines(text, true);
      const newText = lines.length && lines[0]!.startsWith("#") ? lines[0]! + "\n" + anchorSnippet + lines.slice(1).join("") : anchorSnippet + text;
      atomicWrite(gf, newText);
      modified.push(rel);
    } catch {
      // unreadable or read-only: left as it is
    }
  }
  if (modified.length) recordState(root, { anchors: modified });
  return modified;
}

/** Take out the hint ensureAgentGuidanceAnchor added (only from the files it recorded). */
function removeAgentGuidanceAnchor(root: string, files: string[]): void {
  const snippet = String.raw`${reEscape(ANCHOR_MARKER)}\n[\s\S]*?${reEscape(ANCHOR_MARKER)}\n\n?`;
  for (const rel of files) {
    const gf = pjoin(root, rel);
    let text: string;
    try {
      text = readTextStrict(gf);
    } catch {
      continue;
    }
    if (!text.includes(ANCHOR_MARKER)) continue;
    // The exact inverse of the insert: after the first heading line and a blank line, or at the top
    let [cleaned, n] = reSubn(String.raw`^(#[^\n]*\n)\n${snippet}`, String.raw`\1`, text, 1);
    if (!n) [cleaned, n] = reSubn(`^${snippet}`, "", text, 1);
    if (!n) cleaned = reSub(snippet, "", text, 1);
    atomicWrite(gf, cleaned);
  }
}

// ---------------------------------------------------------------- HEAD marker & exclude

/** Record the HEAD the blueprint matches, in the git dir, for the collector's staleness check. */
function recordBlueprintHead(root: string): void {
  const gitDir = gitPath(root, "--git-dir");
  if (!gitDir) return;
  try {
    const sha = runGit(["rev-parse", "--short", "HEAD"], root);
    if (sha) atomicWrite(pjoin(gitDir, HEAD_MARKER), pyStrip(sha) + "\n");
  } catch {
    // a read-only git dir: the collector regenerates when it can't tell
  }
}

/**
 * Keep an untracked generated blueprint out of `git status`, through .git/info/exclude (local to this
 * clone, unlike .gitignore). False when the user's own rules already ignore it.
 */
function ensureExcluded(root: string): boolean {
  const common = gitPath(root, "--git-common-dir");
  if (!common) return false;
  const exclude = pjoin(common, "info", "exclude");
  try {
    const text = exists(exclude) ? readTextStrict(exclude) : "";
    if (text.includes(EXCLUDE_MARK)) return true;
    if (gitOk(["check-ignore", "-q", "--", BLUEPRINT_FILE], root)) return false;
    fs.mkdirSync(toNative(pparent(exclude)), { recursive: true });
    const sep = !text || text.endsWith("\n") ? "" : "\n";
    atomicWrite(exclude, `${text}${sep}${EXCLUDE_MARK}\n/${BLUEPRINT_FILE}\n`);
    return true;
  } catch (e) {
    if (!isOSError(e)) throw e; // a non-UTF-8 exclude file fails the run, as in Python
    return false;
  }
}

function removeExcluded(root: string): void {
  const common = gitPath(root, "--git-common-dir");
  const exclude = common ? pjoin(common, "info", "exclude") : null;
  if (!exclude || !isFile(exclude)) return;
  let text: string;
  try {
    text = readTextStrict(exclude);
  } catch {
    return;
  }
  if (text.includes(EXCLUDE_MARK)) {
    atomicWrite(exclude, reSub(String.raw`(?m)^${reEscape(EXCLUDE_MARK)}\n(?:/${reEscape(BLUEPRINT_FILE)}\n?)?`, "", text));
  }
}

// ---------------------------------------------------------------- writing

/**
 * Generate the blueprint and write it (atomically, only when it changed). Returns [path, changed].
 * A hand-written PROJECT_BLUEPRINT.md of the same name is left as it is. `root` is resolved.
 */
export function writeBlueprint(root: string, outPath: string | null = null): [string, boolean] {
  const target = outPath ?? pjoin(root, BLUEPRINT_FILE);
  if (outPath === null && isFile(target) && !isGenerated(target)) return [target, false];
  const changed = atomicWrite(target, buildBlueprintContent(root));
  if (samePath(resolvePath(target), resolvePath(pjoin(root, BLUEPRINT_FILE)))) {
    recordBlueprintHead(root);
    const untracked = !isTracked(root);
    const excluded = untracked ? ensureExcluded(root) : false;
    recordState(root, { generated_untracked: untracked, ...(excluded ? { excluded: true } : {}) });
  }
  return [target, changed];
}

// ---------------------------------------------------------------- git hooks


const scriptCandidates = [
  ["", `scripts/${SCRIPT_NAME}`],
  ["$MEMENTO_HOME", `$MEMENTO_HOME/scripts/${SCRIPT_NAME}`],
  ["", `$HOME/.memento/scripts/${SCRIPT_NAME}`],
  ["$USERPROFILE", `$USERPROFILE/.memento/scripts/${SCRIPT_NAME}`],
] as const;

/**
 * POSIX sh, appended to the end of the hook. It runs in a subshell and then restores the exit status
 * of whatever ran before it, so a pre-commit check that failed still stops the commit. The generator
 * runs on Memento's own runtime (~/.memento/scripts/runtime, written by the app: Electron as Node),
 * or on `node` when Memento isn't installed here.
 */
export const HOOK_TEMPLATE = [
  HOOK_MARKER_START,
  "# Keeps PROJECT_BLUEPRINT.md current on commit, merge, rebase and branch switch (managed by Memento)",
  "__memento_rc=$?",
  "(",
  "    GIT_DIR_PATH=$(git rev-parse --git-dir 2>/dev/null) || exit 0",
  '    if [ -d "$GIT_DIR_PATH/rebase-merge" ] || [ -d "$GIT_DIR_PATH/rebase-apply" ]; then',
  "        exit 0",
  "    fi",
  '    HOOK_NAME=$(basename "$0")',
  "    # post-checkout: only a branch switch ($3 = 1), not a file checkout",
  '    if [ "$HOOK_NAME" = "post-checkout" ] && [ "$3" != "1" ]; then',
  "        exit 0",
  "    fi",
  '    BP_SCRIPT=""',
  ...scriptCandidates.map(([guard, path], i) => {
    const test = `${guard ? `[ -n "${guard}" ] && ` : ""}[ -f "${path}" ]`;
    return `    ${i === 0 ? "if" : "elif"} ${test}; then\n        BP_SCRIPT="${path}"`;
  }),
  "    fi",
  '    [ -n "$BP_SCRIPT" ] || exit 0',
  '    BP_NODE=""',
  `    for BP_RT in "$MEMENTO_NODE" "\${MEMENTO_HOME:+$MEMENTO_HOME/scripts/${RUNTIME_NAME}}" "$HOME/.memento/scripts/${RUNTIME_NAME}" "\${USERPROFILE:+$USERPROFILE/.memento/scripts/${RUNTIME_NAME}}"; do`,
  '        if [ -n "$BP_RT" ] && [ -x "$BP_RT" ]; then',
  '            BP_NODE="$BP_RT"',
  "            break",
  "        fi",
  "    done",
  '    [ -n "$BP_NODE" ] || BP_NODE=$(command -v node 2>/dev/null) || exit 0',
  "    if git ls-files --error-unmatch PROJECT_BLUEPRINT.md >/dev/null 2>&1; then",
  "        # Tracked: regenerated into the commit itself; afterwards only the HEAD it matches is recorded",
  '        if [ "$HOOK_NAME" = "pre-commit" ]; then',
  '            ELECTRON_RUN_AS_NODE=1 "$BP_NODE" "$BP_SCRIPT" --root . --quiet >/dev/null 2>&1 && git add PROJECT_BLUEPRINT.md >/dev/null 2>&1',
  "        else",
  '            git rev-parse --short HEAD > "$GIT_DIR_PATH/.memento_blueprint_head" 2>/dev/null',
  "        fi",
  '    elif [ "$HOOK_NAME" != "pre-commit" ]; then',
  "        # Untracked: refreshed in the background so the git command returns at once",
  '        (ELECTRON_RUN_AS_NODE=1 "$BP_NODE" "$BP_SCRIPT" --root . --quiet </dev/null >/dev/null 2>&1 &)',
  "    fi",
  ") || true",
  "(exit $__memento_rc)",
  HOOK_MARKER_END,
].join("\n");

const SH_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const SHEBANG_ONLY = new Set(["", "#!/bin/sh", "#!/bin/bash", "#!/usr/bin/env sh", "#!/usr/bin/env bash"]);

/** Path(x).name for a shebang word: the last component on either separator. */
function progName(word: string): string {
  return pname(toPosix(word));
}

/** Whether a hook is a shell script our sh block can be appended to (not Python, Node, ...). */
export function hookIsShell(content: string): boolean {
  const stripped = pyLstrip(content, "﻿");
  if (!pyStrip(stripped)) return true;
  const first = pyStrip(pySplitlines(stripped)[0]!);
  if (!first.startsWith("#!")) return true; // no interpreter line: git runs it with sh
  const parts = pySplitWs(first.slice(2));
  if (!parts.length) return true;
  let prog = progName(parts[0]!);
  if (prog === "env") {
    const args = parts.slice(1).filter((p) => !p.startsWith("-"));
    prog = args.length ? progName(args[0]!) : "";
  }
  return SH_SHELLS.has(prog);
}

/** The hook without our block (and the untagged lines very early versions wrote). */
export function cleanHookContent(content: string): string {
  let cleaned = reSub(String.raw`\n*${reEscape(HOOK_MARKER_START)}[\s\S]*?${reEscape(HOOK_MARKER_END)}\n?`, "\n", content);
  cleaned = reSub(
    String.raw`# Auto-update PROJECT_BLUEPRINT\.md[^\n]*\n(?:[^\n]*\n)*?python3[^\n]*project_blueprint\.py[^\n]*\n(?:fi\n)?`,
    "",
    cleaned,
  );
  const cleanLines = pySplitlines(cleaned).filter(
    (line) => !(line.includes("project_blueprint.py") && line.includes("python")) && !line.includes("# Auto-update PROJECT_BLUEPRINT.md"),
  );
  const nonTrivial = cleanLines.filter((line) => pyStrip(line) && !pyStrip(line).startsWith("#!") && pyStrip(line) !== "fi");
  if (!nonTrivial.length) return "";
  return pyStrip(cleanLines.join("\n"));
}

/** This generator's own file when it runs as the bundled script (not from source, as in tests). */
function currentScript(): string | null {
  try {
    const p = toPosix(fileURLToPath(import.meta.url));
    return pname(p) === SCRIPT_NAME ? resolvePath(p) : null;
  } catch {
    return null;
  }
}

/** Mirror this script to ~/.memento/scripts for hooks in repos that don't carry it (never downgrading). */
function syncGlobalScript(): void {
  try {
    const current = currentScript();
    const globalScript = pjoin(homeDir(), ".memento", "scripts", SCRIPT_NAME);
    if (!current || !isFile(current) || samePath(current, resolvePath(globalScript))) return;
    const curContent = readTextStrict(current);
    const existing = exists(globalScript) ? readTextStrict(globalScript) : "";
    if (existing === curContent || scriptVersionOf(existing) > BLUEPRINT_SCRIPT_VERSION) return;
    fs.mkdirSync(toNative(pparent(globalScript)), { recursive: true });
    atomicWrite(globalScript, curContent);
    chmodExec(globalScript);
  } catch {
    // the hooks fall back to a repo's own copy, or skip
  }
}

/**
 * Append the refresh block to the repo's commit, merge, checkout and rewrite hooks.
 *
 * Left alone: repos whose hooks belong to another tool (core.hooksPath: husky, lefthook...),
 * hooks written in another language, and symlinked hooks. The collector still refreshes
 * those repos' blueprints when HEAD moves.
 */
export function installGitHook(root: string): boolean {
  if (!gitOk(["rev-parse", "--git-dir"], root)) {
    process.stderr.write(`Error: ${toNative(root)} is not a git repository.\n`);
    return false;
  }
  syncGlobalScript();
  if (runGit(["config", "--get", "core.hooksPath"], root)) return true;
  const common = gitPath(root, "--git-common-dir");
  if (!common) return false;
  const hooksDir = pjoin(common, "hooks");
  try {
    fs.mkdirSync(toNative(hooksDir), { recursive: true });
  } catch {
    return false;
  }

  const installed: string[] = [];
  let allOk = true;
  for (const hname of MANAGED_GIT_HOOKS) {
    const hookFile = pjoin(hooksDir, hname);
    if (isSymlink(hookFile)) continue;
    let existing: string;
    try {
      existing = exists(hookFile) ? readTextIgnore(hookFile) : "";
    } catch {
      allOk = false;
      continue;
    }
    if (!hookIsShell(existing)) continue;
    const cleaned = cleanHookContent(existing);
    const newContent = SHEBANG_ONLY.has(pyStrip(cleaned)) ? `#!/bin/sh\n\n${HOOK_TEMPLATE}\n` : `${pyRstrip(cleaned)}\n\n${HOOK_TEMPLATE}\n`;
    try {
      atomicWrite(hookFile, newContent);
      chmodExec(hookFile);
      installed.push(hname);
    } catch {
      allOk = false;
    }
  }
  if (installed.length) recordState(root, { hooks: installed });
  return allOk;
}

/** Take our block out of every managed hook; a hook left with nothing else in it is deleted. */
export function uninstallGitHook(root: string): boolean {
  const common = gitPath(root, "--git-common-dir");
  const hooksDir = common ? pjoin(common, "hooks") : null;
  if (!hooksDir || !isDir(hooksDir)) return true;
  let allOk = true;
  for (const hname of MANAGED_GIT_HOOKS) {
    const hookFile = pjoin(hooksDir, hname);
    if (!isFile(hookFile) || isSymlink(hookFile)) continue;
    try {
      const existing = readTextIgnore(hookFile);
      if (!existing.includes(HOOK_MARKER_START) && !existing.includes(LEGACY_SCRIPT_NAME) && !existing.includes(SCRIPT_NAME)) continue;
      const cleaned = cleanHookContent(existing);
      if (SHEBANG_ONLY.has(pyStrip(cleaned))) {
        fs.unlinkSync(toNative(hookFile));
      } else {
        atomicWrite(hookFile, pyStrip(cleaned) + "\n");
        chmodExec(hookFile);
      }
    } catch {
      allOk = false;
    }
  }
  return allOk;
}

// ---------------------------------------------------------------- uninstalling

function hasOurTraces(root: string): boolean {
  if (exists(stateFile(root))) return true;
  const common = gitPath(root, "--git-common-dir");
  if (!common) return false;
  for (const hname of MANAGED_GIT_HOOKS) {
    try {
      if (readTextIgnore(pjoin(common, "hooks", hname)).includes(HOOK_MARKER_START)) return true;
    } catch {
      // no such hook
    }
  }
  try {
    return readTextIgnore(pjoin(common, "info", "exclude")).includes(EXCLUDE_MARK);
  } catch {
    return false;
  }
}

/**
 * Take back everything this generator did in one repo: hook blocks, the HEAD marker, the exclude
 * line, hints it added to instruction files, and the generated file when git doesn't track it.
 */
export function uninstallRepo(root: string): boolean {
  const state = loadState(root);
  let ok = uninstallGitHook(root);
  const dirs: string[] = [];
  for (const d of [gitPath(root, "--git-dir"), gitPath(root, "--git-common-dir"), pjoin(root, ".git")]) {
    if (d && !dirs.some((x) => samePath(x, d))) dirs.push(d);
  }
  for (const d of dirs) {
    const marker = pjoin(d, HEAD_MARKER);
    if (isFile(marker)) {
      try {
        fs.unlinkSync(toNative(marker));
      } catch {
        ok = false;
      }
    }
  }
  removeExcluded(root);
  const anchors = pyGet(state, "anchors");
  removeAgentGuidanceAnchor(root, pyIter(truthy(anchors) ? anchors : []).map((f) => pyStr(f)));
  const bp = pjoin(root, BLUEPRINT_FILE);
  if (isFile(bp) && !isTracked(root) && isGenerated(bp)) {
    try {
      fs.unlinkSync(toNative(bp));
    } catch {
      ok = false;
    }
  }
  try {
    fs.rmSync(toNative(stateFile(root)), { force: true });
    if (!iterdir(stateDir()).length) fs.rmdirSync(toNative(stateDir()));
  } catch {
    // shared with other repos still recorded
  }
  return ok;
}

// Where the collector looks for repos (packages/daemon/src/blueprint-auto.ts discoverLocalGitRepositories)
const DISCOVERY_BASES = ["dev", "Desktop/dev", "WorkBuddy", "projects", "workspace", "code", "repos"];

function childDirs(d: string): string[] {
  return iterdir(d).filter((child) => isDir(child));
}

function discoverGitRoots(): string[] {
  const home = homeDir();
  const roots: string[] = [];
  const add = (p: string) => {
    const r = resolvePath(p);
    if (!roots.some((x) => samePath(x, r))) roots.push(r);
  };

  const visit = (d: string, depth: number) => {
    const name = pname(d);
    if (depth > 2 || name.startsWith(".") || name === "node_modules" || name === "venv" || name.toLowerCase().includes("worktree")) return;
    if (exists(pjoin(d, ".git"))) {
      add(d);
      return;
    }
    if (depth === 2) return;
    try {
      for (const child of childDirs(d)) visit(child, depth + 1);
    } catch {
      // unreadable
    }
  };

  for (const rel of DISCOVERY_BASES) {
    const base = pjoin(home, rel);
    if (!isDir(base)) continue;
    try {
      for (const child of childDirs(base)) visit(child, 1);
    } catch {
      // unreadable
    }
  }
  return roots;
}

/**
 * uninstallRepo for every repo recorded in ~/.memento/blueprint_repos, plus any repo in the usual
 * workspace folders that still carries our hook block or exclude line (written before the record existed).
 */
export function uninstallAll(quiet = false): number {
  const roots: string[] = [];
  const add = (r: string) => {
    if (!roots.some((x) => samePath(x, r))) roots.push(r);
  };
  const dir = stateDir();
  if (isDir(dir)) {
    for (const f of pglob(dir, "*.json")) {
      let root: PyValue | undefined;
      try {
        const data = loads(readTextStrict(f));
        root = isDict(data) ? pyGet(data, "root") : undefined;
      } catch {
        root = undefined;
      }
      if (typeof root === "string" && isDir(toPosix(root))) add(toPosix(root));
      else fs.rmSync(toNative(f), { force: true });
    }
  }
  for (const r of discoverGitRoots()) if (hasOurTraces(r)) add(r);
  let failed = 0;
  for (const r of sortedPaths(roots)) {
    if (uninstallRepo(r)) {
      if (!quiet) process.stdout.write(`Removed living blueprint & hooks from: ${toNative(r)}\n`);
    } else {
      failed++;
      if (!quiet) process.stderr.write(`Could not fully clean ${toNative(r)}\n`);
    }
  }
  try {
    if (isDir(dir) && !iterdir(dir).length) fs.rmdirSync(toNative(dir));
  } catch {
    // ignore
  }
  return failed ? 1 : 0;
}

/** Scan local AI instruction files and common dev workspaces to deploy living blueprints & hooks. */
export function bootstrapDiscoveredProjects(quiet = false, anchor = false): number {
  const home = homeDir();
  const roots: string[] = [];
  const add = (r: string) => {
    if (!roots.some((x) => samePath(x, r))) roots.push(r);
  };

  // 1. Extract scoped project directories from Memento resident profile files
  for (const pf of [
    pjoin(home, ".claude", "CLAUDE.md"),
    pjoin(home, ".codex", "AGENTS.md"),
    pjoin(home, ".gemini", "GEMINI.md"),
    pjoin(home, ".memento", "mind_snapshot.json"),
  ]) {
    if (!exists(pf)) continue;
    try {
      const text = readTextIgnore(pf);
      for (const m of reFinditer("####\\s+[^\\s（(]+[（(]`([^`]+)`[）)]", text)) {
        const cand = toPosix(pyStrip(m.g(1)));
        if (exists(pjoin(cand, ".git"))) add(resolvePath(cand));
      }
    } catch {
      // unreadable
    }
  }

  // 2. The workspace folders the collector scans
  for (const r of discoverGitRoots()) add(r);

  for (const r of sortedPaths(roots)) {
    try {
      installGitHook(r);
      if (anchor) ensureAgentGuidanceAnchor(r);
      writeBlueprint(r);
      if (!quiet) process.stdout.write(`Bootstrapped living blueprint & hooks for: ${toNative(r)}\n`);
    } catch (e) {
      if (!quiet) process.stderr.write(`Skipped ${toNative(r)}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return 0;
}
