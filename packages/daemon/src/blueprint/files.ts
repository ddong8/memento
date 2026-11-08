// Paths, file reading, directory walking and git, with the semantics of the pathlib / os.walk /
// subprocess calls the Python generator made. Paths are absolute strings with "/" separators.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { cmpStr, endsWithAny, pyStrip, reEscape, reMatch, sortedStr } from "./py.js";

export const IS_WIN = process.platform === "win32";

export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".tox",
  "dist",
  "build",
  ".next",
  ".turbo",
  "out",
  "target",
  "coverage",
  "htmlcov",
  ".idea",
  ".vscode",
  ".gemini",
  "data",
  "datasets",
  "logs",
  "tmp",
  "temp",
  "checkpoints",
  "weights",
  "site-packages",
  "vendor",
]);

// ---------------------------------------------------------------- pure paths

export function toPosix(p: string): string {
  return IS_WIN ? p.replace(/\\/g, "/") : p;
}

/** The path as the OS writes it (backslashes on Windows). */
export function toNative(p: string): string {
  return IS_WIN ? p.replace(/\//g, "\\") : p;
}

function isAbs(p: string): boolean {
  return p.startsWith("/") || (IS_WIN && /^[A-Za-z]:\//.test(p));
}

/** pathlib's normalisation: no empty or "." parts, no trailing slash (".." is kept). */
export function normPath(p: string): string {
  const s = toPosix(p);
  let head = "";
  let rest = s;
  if (IS_WIN && /^[A-Za-z]:\//.test(s)) {
    head = s.slice(0, 3);
    rest = s.slice(3);
  } else if (s.startsWith("/")) {
    head = "/";
    rest = s.slice(1);
  }
  const parts = rest.split("/").filter((x) => x !== "" && x !== ".");
  const joined = head + parts.join("/");
  return joined || ".";
}

/** a / b / c */
export function pjoin(base: string, ...parts: string[]): string {
  let out = base;
  for (const raw of parts) {
    const p = toPosix(raw);
    out = isAbs(p) ? p : out === "." ? p : `${out}/${p}`;
  }
  return normPath(out);
}

export function pname(p: string): string {
  const s = normPath(p);
  if (s === "/" || s === ".") return "";
  const i = s.lastIndexOf("/");
  return i < 0 ? s : s.slice(i + 1);
}

export function pparent(p: string): string {
  const s = normPath(p);
  const i = s.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  if (IS_WIN && i === 2 && /^[A-Za-z]:/.test(s)) return s.slice(0, 3);
  return s.slice(0, i);
}

/** Path.suffix (3.14: a trailing single dot counts as a suffix) */
export function psuffix(p: string): string {
  const name = pname(p);
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  if (name.slice(0, i).replace(/\./g, "") === "") return "";
  return name.slice(i);
}

export function pstem(p: string): string {
  const name = pname(p);
  const suf = psuffix(p);
  return suf ? name.slice(0, name.length - suf.length) : name;
}

/** Path.with_suffix("") */
export function withoutSuffix(p: string): string {
  const suf = psuffix(p);
  if (!suf) return normPath(p);
  const s = normPath(p);
  return s.slice(0, s.length - suf.length);
}

/** Path.parts */
export function pparts(p: string): string[] {
  const s = normPath(p);
  if (s === ".") return [];
  if (s.startsWith("/")) return ["/", ...s.slice(1).split("/").filter(Boolean)];
  return s.split("/");
}

/** Path.relative_to(root) as a "/" string; throws when p is not under root. */
export function relTo(p: string, root: string): string {
  const a = pparts(p);
  const b = pparts(root);
  const eq = (x: string, y: string) => (IS_WIN ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (b.length > a.length || !b.every((x, i) => eq(x, a[i]!))) throw new Error(`${p} is not in the subpath of ${root}`);
  const rest = a.slice(b.length);
  return rest.length ? rest.join("/") : ".";
}

/** Path ordering: part lists compared (case-insensitively on Windows). */
export function cmpPath(a: string, b: string): number {
  const pa = normPath(a).split("/");
  const pb = normPath(b).split("/");
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = IS_WIN ? pa[i]!.toLowerCase() : pa[i]!;
    const y = IS_WIN ? pb[i]!.toLowerCase() : pb[i]!;
    const c = cmpStr(x, y);
    if (c) return c;
  }
  return pa.length - pb.length;
}

export function sortedPaths(paths: Iterable<string>): string[] {
  return Array.from(paths).sort(cmpPath);
}

export function samePath(a: string, b: string): boolean {
  return cmpPath(a, b) === 0;
}

/** Ordered de-duplication of paths (dict.fromkeys) */
export function uniqPaths(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = IS_WIN ? normPath(p).toLowerCase() : normPath(p);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

export function homeDir(): string {
  return normPath(toPosix(os.homedir()));
}

/** Path.resolve() */
export function resolvePath(p: string): string {
  const abs = toPosix(nodePath.resolve(toNative(p)));
  try {
    return normPath(toPosix(fs.realpathSync(toNative(abs))));
  } catch {
    // strict=False: resolve the part that exists, keep the rest as written
    const parent = nodePath.dirname(toNative(abs));
    if (parent === toNative(abs)) return normPath(abs);
    return pjoin(resolvePath(toPosix(parent)), nodePath.basename(toNative(abs)));
  }
}

// ---------------------------------------------------------------- file system

export function exists(p: string): boolean {
  try {
    fs.statSync(toNative(p));
    return true;
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(toNative(p)).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(toNative(p)).isDirectory();
  } catch {
    return false;
  }
}

export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(toNative(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Path.iterdir() (throws like Python when the directory can't be listed) */
/** An error Python raises as OSError (a failed system call), not a decoding or programming error. */
export function isOSError(e: unknown): boolean {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).errno === "number";
}

export function iterdir(d: string): string[] {
  return fs.readdirSync(toNative(d)).map((name) => pjoin(d, name));
}

// UTF-8 decoding with errors="ignore": invalid bytes are dropped (maximal invalid subparts).
const FATAL = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeIgnore(buf: Uint8Array): string {
  try {
    return FATAL.decode(buf);
  } catch {
    // fall through to the byte-level decoder
  }
  const parts: string[] = [];
  let runStart = 0;
  let i = 0;
  const n = buf.length;
  const flush = (end: number) => {
    if (end > runStart) parts.push(FATAL.decode(buf.subarray(runStart, end)));
  };
  while (i < n) {
    const b = buf[i]!;
    if (b < 0x80) {
      i++;
      continue;
    }
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    }
    if (need === 0) {
      flush(i);
      i += 1;
      runStart = i;
      continue;
    }
    let j = 1;
    let ok = true;
    for (; j <= need; j++) {
      const c = buf[i + j];
      const l = j === 1 ? lo : 0x80;
      const h = j === 1 ? hi : 0xbf;
      if (c === undefined || c < l || c > h) {
        ok = false;
        break;
      }
    }
    if (ok) {
      i += need + 1;
      continue;
    }
    // drop the maximal invalid subpart (the lead byte and the valid continuation bytes before the bad one)
    flush(i);
    i += j;
    runStart = i;
  }
  flush(n);
  return parts.join("");
}

/** Universal newlines, as text mode reads with newline=None. */
export function translateNewlines(s: string): string {
  return s.includes("\r") ? s.replace(/\r\n?/g, "\n") : s;
}

function decodeStrict(buf: Uint8Array): string {
  return FATAL.decode(buf);
}

/** Path.read_text(encoding="utf-8", errors="ignore") — throws when the file can't be read. */
export function readTextIgnore(p: string): string {
  return translateNewlines(decodeIgnore(fs.readFileSync(toNative(p))));
}

/** Path.read_text(encoding="utf-8") — throws on invalid UTF-8 too. */
export function readTextStrict(p: string): string {
  return translateNewlines(decodeStrict(fs.readFileSync(toNative(p))));
}

function cpPrefix(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  // maxChars code points
  let units = 0;
  let count = 0;
  while (units < s.length && count < maxChars) {
    const c = s.charCodeAt(units);
    units += c >= 0xd800 && c <= 0xdbff && units + 1 < s.length ? 2 : 1;
    count++;
  }
  return s.slice(0, units);
}

function cpCountAtLeast(s: string, n: number): boolean {
  if (s.length < n) return false;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(c >= 0xdc00 && c <= 0xdfff)) count++;
    if (count >= n) return true;
  }
  return false;
}

/** _read_code: up to max_chars characters of a file, "" when it can't be read. */
export function readCode(p: string, maxChars = 200_000): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(toNative(p), "r");
    const size = fs.fstatSync(fd).size;
    const want = maxChars * 4 + 4;
    let buf: Buffer;
    if (size <= want) {
      buf = fs.readFileSync(fd);
    } else {
      buf = Buffer.alloc(want);
      const got = fs.readSync(fd, buf, 0, want, 0);
      buf = buf.subarray(0, got);
      const text = translateNewlines(decodeIgnore(buf));
      if (cpCountAtLeast(text, maxChars + 1)) return cpPrefix(text, maxChars);
      buf = fs.readFileSync(toNative(p));
    }
    return cpPrefix(translateNewlines(decodeIgnore(buf)), maxChars);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** Write through a temp file and a rename. False when the content is already there. */
export function atomicWrite(p: string, content: string): boolean {
  try {
    if (readTextStrict(p) === content) return false;
  } catch {
    // missing or unreadable: write it
  }
  const tmp = pjoin(pparent(p), `.${pname(p)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(toNative(tmp), content, "utf8");
    fs.renameSync(toNative(tmp), toNative(p));
  } finally {
    if (exists(tmp)) {
      try {
        fs.unlinkSync(toNative(tmp));
      } catch {
        // ignore
      }
    }
  }
  return true;
}

export function chmodExec(p: string): void {
  fs.chmodSync(toNative(p), 0o755);
}

// ---------------------------------------------------------------- git

export function runGit(args: string[], cwd: string): string {
  try {
    const res = spawnSync("git", args, { cwd: toNative(cwd), timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (res.error || !res.stdout) return "";
    return pyStrip(translateNewlines(decodeStrict(res.stdout)));
  } catch {
    return "";
  }
}

export function gitOk(args: string[], cwd: string): boolean {
  try {
    const res = spawnSync("git", args, { cwd: toNative(cwd), timeout: 5000, windowsHide: true, stdio: "ignore" });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- repo walk & glob

type RepoFile = [full: string, relPosix: string];
const REPO_FILE_CACHE = new Map<string, RepoFile[]>();

export function clearRepoFileCache(root: string): void {
  REPO_FILE_CACHE.delete(resolvePath(root));
}

interface Listing {
  dirs: string[];
  files: string[];
}

/** One os.scandir pass: entries that are directories (following symlinks) and the rest. */
function scanDir(dir: string): Listing | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(toNative(dir), { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    let isD = e.isDirectory();
    if (e.isSymbolicLink()) isD = isDir(pjoin(dir, e.name));
    (isD ? dirs : files).push(e.name);
  }
  return { dirs, files };
}

function getRepoFiles(root: string): RepoFile[] {
  const resolved = resolvePath(root);
  const cached = REPO_FILE_CACHE.get(resolved);
  if (cached) return cached;
  const files: RepoFile[] = [];
  // os.walk, top-down, with the directory list pruned and sorted in place
  const stack: string[] = [""];
  outer: while (stack.length) {
    const relDir = stack.pop()!;
    const curDir = relDir ? `${resolved}/${relDir}` : resolved;
    const listing = scanDir(curDir);
    if (!listing) continue;
    const depth = relDir ? relDir.split("/").length : 0;
    let dirs: string[] = [];
    if (depth < 6) {
      dirs = sortedStr(
        listing.dirs.filter((d) => !IGNORED_DIRS.has(d) && !d.startsWith(".git") && (d === ".github" || !d.startsWith("."))),
      );
    }
    for (const fn of sortedStr(listing.files)) {
      if (fn.startsWith(".") && fn !== ".env.example" && fn !== ".env.sample") continue;
      if (endsWithAny(fn, [".min.js", ".bundle.js", ".chunk.js", ".map"])) continue;
      files.push([`${curDir}/${fn}`, relDir ? `${relDir}/${fn}` : fn]);
      if (files.length >= 6000) break outer;
    }
    for (let i = dirs.length - 1; i >= 0; i--) {
      const sub = relDir ? `${relDir}/${dirs[i]}` : dirs[i]!;
      if (!isSymlink(`${resolved}/${sub}`)) stack.push(sub);
    }
  }
  REPO_FILE_CACHE.set(resolved, files);
  return files;
}

const GLOB_CACHE = new Map<string, string>();

/** _compile_glob_pattern: the Python regex source for a repo-relative glob. */
function globRegex(pattern: string): string {
  const cached = GLOB_CACHE.get(pattern);
  if (cached !== undefined) return cached;
  const out: string[] = ["^"];
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    if (pattern.startsWith("/**/", i)) {
      out.push("(?:/.+)?/");
      i += 4;
    } else if (i === 0 && pattern.startsWith("**/", i)) {
      out.push("(?:.+/)?");
      i += 3;
    } else if (pattern[i] === "*") {
      out.push("[^/]*");
      i += 1;
    } else if (pattern[i] === "?") {
      out.push("[^/]");
      i += 1;
    } else if (pattern[i] === "[") {
      const j = pattern.indexOf("]", i + 1);
      if (j !== -1) {
        out.push(pattern.slice(i, j + 1));
        i = j + 1;
      } else {
        out.push("\\[");
        i += 1;
      }
    } else {
      out.push(reEscape(pattern[i]!));
      i += 1;
    }
  }
  out.push("$");
  const src = out.join("");
  GLOB_CACHE.set(pattern, src);
  return src;
}

/** _iter_repo_files: the first `limit` repo files matching the glob, sorted. */
export function iterRepoFiles(root: string, pattern: string, limit = 80): string[] {
  const rx = globRegex(pattern);
  const out: string[] = [];
  for (const [full, rel] of getRepoFiles(root)) {
    if (reMatch(rx, rel)) {
      out.push(full);
      if (out.length >= limit) break;
    }
  }
  return sortedPaths(out);
}

const NAME_RX_CACHE = new Map<string, RegExp>();

/** A pathlib glob segment (fnmatch rules; case-sensitive except on Windows). */
function nameMatcher(seg: string): RegExp {
  let rx = NAME_RX_CACHE.get(seg);
  if (rx) return rx;
  let src = "";
  let i = 0;
  while (i < seg.length) {
    const c = seg[i]!;
    if (c === "*") {
      src += "[\\s\\S]*";
      i++;
    } else if (c === "?") {
      src += "[\\s\\S]";
      i++;
    } else if (c === "[") {
      let j = i + 1;
      if (seg[j] === "!") j++;
      if (seg[j] === "]") j++;
      while (j < seg.length && seg[j] !== "]") j++;
      if (j >= seg.length) {
        src += "\\[";
        i++;
      } else {
        let body = seg.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        else if (body.startsWith("^")) body = `\\${body}`;
        src += `[${body}]`;
        i = j + 1;
      }
    } else {
      src += c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
      i++;
    }
  }
  rx = new RegExp(`^${src}$`, IS_WIN ? "iu" : "u");
  NAME_RX_CACHE.set(seg, rx);
  return rx;
}

/** Path.glob for "name" and "**\/name" patterns (results unsorted, like pathlib). */
export function pglob(base: string, pattern: string): string[] {
  const recursive = pattern.startsWith("**/");
  const seg = recursive ? pattern.slice(3) : pattern;
  if (seg.includes("/")) throw new Error(`unsupported glob ${pattern}`);
  const rx = nameMatcher(seg);
  const out: string[] = [];
  const stack = [normPath(base)];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(toNative(dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (rx.test(e.name)) out.push(full);
      if (recursive && e.isDirectory()) stack.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------- state files

export function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}
