#!/usr/bin/env node
// Memento living blueprint generator: writes and maintains PROJECT_BLUEPRINT.md for AI agents. Run with --help.
// Generated from packages/daemon/src/blueprint by packages/daemon/scripts/build-runners.mjs: do not edit.

// packages/daemon/src/blueprint/files.ts
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

// packages/daemon/src/blueprint/py.ts
var PY_WS_CLASS = "\\t-\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
var WORD_CLASS = "\\p{L}\\p{N}_";
var WS_RE = new RegExp(`[${PY_WS_CLASS}]`, "u");
function isPySpace(ch) {
  return ch.length > 0 && WS_RE.test(ch);
}
var JS_SYNTAX = new Set("^$\\.*+?()[]{}|/".split(""));
function translatePyRegex(pattern, flags = {}) {
  let { i = false, m = false, s = false } = flags;
  let pos = 0;
  for (; ; ) {
    const fm = /^\(\?([aiLmsux]+)\)/.exec(pattern.slice(pos));
    if (!fm) break;
    for (const f of fm[1]) {
      if (f === "i") i = true;
      else if (f === "m") m = true;
      else if (f === "s") s = true;
    }
    pos += fm[0].length;
  }
  const n = pattern.length;
  let out = "";
  let lastWasAtom = false;
  while (pos < n) {
    const c = pattern[pos];
    if (c === "\\") {
      const e = pattern[pos + 1];
      if (e === void 0) throw new Error("bad escape (end of pattern)");
      pos += 2;
      lastWasAtom = true;
      switch (e) {
        case "s":
          out += `[${PY_WS_CLASS}]`;
          continue;
        case "S":
          out += `[^${PY_WS_CLASS}]`;
          continue;
        case "w":
          out += `[${WORD_CLASS}]`;
          continue;
        case "W":
          out += `[^${WORD_CLASS}]`;
          continue;
        case "d":
          out += "\\p{Nd}";
          continue;
        case "D":
          out += "\\P{Nd}";
          continue;
        case "b":
          out += `(?:(?<=[${WORD_CLASS}])(?![${WORD_CLASS}])|(?<![${WORD_CLASS}])(?=[${WORD_CLASS}]))`;
          lastWasAtom = false;
          continue;
        case "B":
          out += `(?:(?<=[${WORD_CLASS}])(?=[${WORD_CLASS}])|(?<![${WORD_CLASS}])(?![${WORD_CLASS}]))`;
          lastWasAtom = false;
          continue;
        case "Z":
          out += "(?![\\s\\S])";
          lastWasAtom = false;
          continue;
        case "A":
          out += "(?<![\\s\\S])";
          lastWasAtom = false;
          continue;
        case "n":
        case "t":
        case "r":
        case "f":
        case "v":
          out += `\\${e}`;
          continue;
        case "x": {
          out += `\\x${pattern.slice(pos, pos + 2)}`;
          pos += 2;
          continue;
        }
        case "u": {
          out += `\\u${pattern.slice(pos, pos + 4)}`;
          pos += 4;
          continue;
        }
        default:
          if (/[0-9]/.test(e)) {
            out += `\\${e}`;
            continue;
          }
          if (/[A-Za-z]/.test(e)) throw new Error(`unsupported escape \\${e}`);
          out += JS_SYNTAX.has(e) ? `\\${e}` : e;
          continue;
      }
    }
    if (c === "[") {
      const [cls, next2] = translateClass(pattern, pos);
      out += cls;
      pos = next2;
      lastWasAtom = true;
      continue;
    }
    if (c === "(") {
      if (pattern.startsWith("(?P<", pos)) {
        out += "(?<";
        pos += 4;
      } else if (pattern.startsWith("(?P=", pos)) {
        const end = pattern.indexOf(")", pos);
        out += `\\k<${pattern.slice(pos + 4, end)}>`;
        pos = end + 1;
        lastWasAtom = true;
        continue;
      } else if (pattern.startsWith("(?#", pos)) {
        pos = pattern.indexOf(")", pos) + 1;
        continue;
      } else if (/^\(\?(?::|=|!|<=|<!)/.test(pattern.slice(pos, pos + 4))) {
        const len = pattern.startsWith("(?<", pos) ? 4 : 3;
        out += pattern.slice(pos, pos + len);
        pos += len;
      } else if (pattern.startsWith("(?", pos)) {
        throw new Error("unsupported group construct");
      } else {
        out += "(";
        pos += 1;
      }
      lastWasAtom = false;
      continue;
    }
    if (c === ")") {
      out += ")";
      pos += 1;
      lastWasAtom = true;
      continue;
    }
    if (c === "{") {
      const q = /^\{(\d*)(,?)(\d*)\}/.exec(pattern.slice(pos));
      if (q && lastWasAtom && (q[1] !== "" || q[2] === "," && q[3] !== "")) {
        out += q[2] ? `{${q[1] || "0"},${q[3]}}` : `{${q[1]}}`;
        pos += q[0].length;
        if (pattern[pos] === "?") {
          out += "?";
          pos += 1;
        }
        lastWasAtom = false;
        continue;
      }
      out += "\\{";
      pos += 1;
      lastWasAtom = true;
      continue;
    }
    if (c === "}" || c === "]") {
      out += `\\${c}`;
      pos += 1;
      lastWasAtom = true;
      continue;
    }
    if (c === ".") {
      out += s ? "[\\s\\S]" : "[^\\n]";
      pos += 1;
      lastWasAtom = true;
      continue;
    }
    if (c === "^") {
      out += m ? "(?:(?<![\\s\\S])|(?<=\\n))" : "(?<![\\s\\S])";
      pos += 1;
      lastWasAtom = false;
      continue;
    }
    if (c === "$") {
      out += m ? "(?=\\n|(?![\\s\\S]))" : "(?=\\n?(?![\\s\\S]))";
      pos += 1;
      lastWasAtom = false;
      continue;
    }
    if (c === "*" || c === "+" || c === "?") {
      out += c;
      pos += 1;
      if (pattern[pos] === "?" || pattern[pos] === "+") {
        if (pattern[pos] === "+") throw new Error("possessive quantifier");
        out += "?";
        pos += 1;
      }
      lastWasAtom = false;
      continue;
    }
    if (c === "|") {
      out += "|";
      pos += 1;
      lastWasAtom = false;
      continue;
    }
    out += c === "/" ? "\\/" : c;
    pos += c.length;
    lastWasAtom = true;
  }
  return { source: out, flags: i ? "iu" : "u" };
}
function translateClass(pattern, start) {
  if (pattern.startsWith("[\\s\\S]", start)) return ["[\\s\\S]", start + 6];
  if (pattern.startsWith("[\\W_]", start)) return ["[^\\p{L}\\p{N}]", start + 5];
  let pos = start + 1;
  let out = "[";
  if (pattern[pos] === "^") {
    out += "^";
    pos += 1;
  }
  let first = true;
  for (; ; ) {
    const c = pattern[pos];
    if (c === void 0) throw new Error("unterminated character set");
    if (c === "]" && !first) {
      out += "]";
      pos += 1;
      break;
    }
    first = false;
    if (c === "\\") {
      const e = pattern[pos + 1];
      if (e === void 0) throw new Error("bad escape in class");
      pos += 2;
      switch (e) {
        case "s":
          out += PY_WS_CLASS;
          continue;
        case "w":
          out += WORD_CLASS;
          continue;
        case "d":
          out += "\\p{Nd}";
          continue;
        case "D":
          out += "\\P{Nd}";
          continue;
        case "S":
        case "W":
          throw new Error("negated shorthand inside a character set");
        case "n":
        case "t":
        case "r":
        case "f":
        case "v":
          out += `\\${e}`;
          continue;
        case "x":
          out += `\\x${pattern.slice(pos, pos + 2)}`;
          pos += 2;
          continue;
        case "u":
          out += `\\u${pattern.slice(pos, pos + 4)}`;
          pos += 4;
          continue;
        case "b":
          out += "\\x08";
          continue;
        default:
          if (/[A-Za-z0-9]/.test(e)) throw new Error(`unsupported class escape \\${e}`);
          out += JS_SYNTAX.has(e) || e === "-" ? `\\${e}` : e;
          continue;
      }
    }
    if (c === "[" || c === "/") {
      out += `\\${c}`;
      pos += 1;
      continue;
    }
    out += c;
    pos += 1;
  }
  return [out, pos];
}
var RX_CACHE = /* @__PURE__ */ new Map();
function compiled(pattern, flags, mode) {
  const key = `${mode}|${flags.i ? 1 : 0}${flags.m ? 1 : 0}${flags.s ? 1 : 0}|${pattern}`;
  let rx = RX_CACHE.get(key);
  if (!rx) {
    const t = translatePyRegex(pattern, flags);
    rx = new RegExp(t.source, t.flags + mode);
    RX_CACHE.set(key, rx);
  }
  rx.lastIndex = 0;
  return rx;
}
var PyMatch = class {
  constructor(m) {
    this.m = m;
  }
  m;
  group(n = 0) {
    const v = this.m[n];
    return v === void 0 ? null : v;
  }
  /** group(n) where the pattern guarantees the group matched. */
  g(n) {
    return this.m[n] ?? "";
  }
  get index() {
    return this.m.index;
  }
  get end() {
    return this.m.index + this.m[0].length;
  }
  get groupCount() {
    return this.m.length - 1;
  }
};
function reMatch(pattern, text, flags = {}) {
  const rx = compiled(pattern, flags, "y");
  const m = rx.exec(text);
  return m ? new PyMatch(m) : null;
}
function reSearch(pattern, text, flags = {}) {
  const rx = compiled(pattern, flags, "");
  const m = rx.exec(text);
  return m ? new PyMatch(m) : null;
}
function* reFinditer(pattern, text, flags = {}) {
  for (const m of text.matchAll(compiled(pattern, flags, "g"))) yield new PyMatch(m);
}
function reFindall(pattern, text, flags = {}) {
  const out = [];
  for (const m of reFinditer(pattern, text, flags)) {
    if (m.groupCount === 0) out.push(m.g(0));
    else if (m.groupCount === 1) out.push(m.group(1) ?? "");
    else throw new Error("findall with several groups is not used");
  }
  return out;
}
function expandTemplate(template, m) {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = template[i + 1];
    if (e === void 0) throw new Error("bad escape (end of pattern)");
    if (/[0-9]/.test(e)) {
      let j = i + 1;
      while (j < template.length && j < i + 3 && /[0-9]/.test(template[j])) j++;
      out += m.group(Number(template.slice(i + 1, j))) ?? "";
      i = j - 1;
      continue;
    }
    if (e === "g") {
      const end = template.indexOf(">", i);
      const name = template.slice(i + 3, end);
      out += m.group(Number(name)) ?? "";
      i = end;
      continue;
    }
    const simple = { n: "\n", t: "	", r: "\r", f: "\f", v: "\v", a: "\x07", b: "\b", "\\": "\\" };
    if (e in simple) out += simple[e];
    else if (/[A-Za-z]/.test(e)) throw new Error(`bad escape \\${e}`);
    else out += `\\${e}`;
    i += 1;
  }
  return out;
}
function reSubn(pattern, repl, text, count = 0, flags = {}) {
  let out = "";
  let last = 0;
  let n = 0;
  let prevEnd = -1;
  for (const m of reFinditer(pattern, text, flags)) {
    if (count && n >= count) break;
    if (m.index === m.end && m.index === prevEnd) continue;
    out += text.slice(last, m.index) + expandTemplate(repl, m);
    last = m.end;
    prevEnd = m.end;
    n++;
  }
  return [out + text.slice(last), n];
}
function reSub(pattern, repl, text, count = 0, flags = {}) {
  return reSubn(pattern, repl, text, count, flags)[0];
}
var ESCAPE_SET = new Set("()[]{}?*+-|^$\\.&~# 	\n\r\v\f".split(""));
function reEscape(text) {
  let out = "";
  for (const ch of text) out += ESCAPE_SET.has(ch) ? `\\${ch}` : ch;
  return out;
}
function hasSurrogates(s) {
  return /[\uD800-\uDFFF]/.test(s);
}
function pyLen(s) {
  if (!hasSurrogates(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}
function pySlice(s, start, end) {
  if (!hasSurrogates(s)) return s.slice(start, end);
  const cps = Array.from(s);
  return cps.slice(start, end).join("");
}
function charSet(chars) {
  if (chars === void 0) return isPySpace;
  const set = new Set(Array.from(chars));
  return (ch) => set.has(ch);
}
function pyLstrip(s, chars) {
  const test = charSet(chars);
  const cps = Array.from(s);
  let i = 0;
  while (i < cps.length && test(cps[i])) i++;
  return i === 0 ? s : cps.slice(i).join("");
}
function pyRstrip(s, chars) {
  const test = charSet(chars);
  const cps = Array.from(s);
  let j = cps.length;
  while (j > 0 && test(cps[j - 1])) j--;
  return j === cps.length ? s : cps.slice(0, j).join("");
}
function pyStrip(s, chars) {
  return pyRstrip(pyLstrip(s, chars), chars);
}
var LINE_BREAKS = "\n\r\v\f\u2028\u2029";
function pySplitlines(s, keepends = false) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (LINE_BREAKS.includes(c)) {
      let eol = i + 1;
      if (c === "\r" && s[i + 1] === "\n") eol = i + 2;
      out.push(s.slice(start, keepends ? eol : i));
      start = eol;
      i = eol;
    } else {
      i++;
    }
  }
  if (start < n) out.push(s.slice(start));
  return out;
}
function pySplitWs(s) {
  const out = [];
  let cur = "";
  for (const ch of s) {
    if (isPySpace(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
function pySplit(s, sep, maxsplit = -1) {
  if (maxsplit < 0) return s.split(sep);
  const out = [];
  let rest = s;
  while (out.length < maxsplit) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}
function pyCapitalize(s) {
  if (!s) return s;
  const [first, ...rest] = Array.from(s);
  return first.toUpperCase() + rest.join("").toLowerCase();
}
function pyIslower(s) {
  return /[a-z]/.test(s) && !/[A-Z]/.test(s);
}
function startsWithAny(s, prefixes) {
  return prefixes.some((p) => s.startsWith(p));
}
function endsWithAny(s, suffixes) {
  return suffixes.some((p) => s.endsWith(p));
}
function cmpStr(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 55296) x = x >= 57344 ? x - 2048 : x + 8192;
    if (y >= 55296) y = y >= 57344 ? y - 2048 : y + 8192;
    return x - y;
  }
  return a.length - b.length;
}
function sortedStr(items) {
  return Array.from(items).sort(cmpStr);
}
function uniq(items) {
  return Array.from(new Set(items));
}
function isDict(v) {
  return v instanceof Map;
}
function truthy(v) {
  if (v === null || v === void 0 || v === false || v === 0 || v === 0n || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return true;
}
function pyGet(obj, key) {
  if (!(obj instanceof Map)) throw new TypeError("'get' on a non-dict");
  return obj.get(key);
}
function orDict(v) {
  const r = truthy(v) ? v : /* @__PURE__ */ new Map();
  if (!(r instanceof Map)) throw new TypeError("not a mapping");
  return r;
}
function mergeDicts(...dicts) {
  const out = /* @__PURE__ */ new Map();
  for (const d of dicts) for (const [k, v] of d) out.set(k, v);
  return out;
}
function pyIn(needle, container) {
  if (typeof container === "string") return container.includes(needle);
  if (Array.isArray(container)) return container.some((v) => v === needle);
  if (container instanceof Map) return container.has(needle);
  throw new TypeError("argument is not iterable");
}
function pyIter(v) {
  if (typeof v === "string") return Array.from(v);
  if (Array.isArray(v)) return v;
  if (v instanceof Map) return Array.from(v.keys());
  throw new TypeError("object is not iterable");
}
function pyStr(v) {
  if (typeof v === "string") return v;
  return pyRepr(v);
}
function pyRepr(v) {
  if (v === null || v === void 0) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return pyFloatRepr(v);
  if (typeof v === "string") return pyStrRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Map) return `{${Array.from(v).map(([k, x]) => `${pyStrRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  return String(v);
}
function pyFloatRepr(v) {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const [mant, expStr] = v.toExponential().split("e");
  const exp = Number(expStr);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  let body;
  if (exp < -4 || exp >= 16) {
    const d = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    body = `${d}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  } else if (exp < 0) {
    body = `0.${"0".repeat(-exp - 1)}${digits}`;
  } else if (digits.length > exp + 1) {
    body = `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  } else {
    body = `${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
  }
  return neg ? `-${body}` : body;
}
var PRINTABLE_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\x20]$/u;
function surrogateStandIn(cp) {
  const off = cp - 55296;
  return String.fromCharCode(56320 | off >> 10, 56320 | off & 1023);
}
function* pyChars(s) {
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c >= 56320 && c <= 57343 && i + 1 < s.length) {
      yield [s.slice(i, i + 2), 55296 + ((c & 1023) << 10 | s.charCodeAt(i + 1) & 1023)];
      i += 2;
      continue;
    }
    const cp = s.codePointAt(i);
    const n = cp > 65535 ? 2 : 1;
    yield [s.slice(i, i + n), cp];
    i += n;
  }
}
function pyCodePoint(ch) {
  return pyChars(ch).next().value[1];
}
function pyIsPrintable(ch) {
  return PRINTABLE_RE.test(ch);
}
function pyStrRepr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const [ch, cp] of pyChars(s)) {
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (PRINTABLE_RE.test(ch)) out += ch;
    else if (cp < 256) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 65536) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

// packages/daemon/src/blueprint/files.ts
var IS_WIN = process.platform === "win32";
var IGNORED_DIRS = /* @__PURE__ */ new Set([
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
  "vendor"
]);
function toPosix(p) {
  return IS_WIN ? p.replace(/\\/g, "/") : p;
}
function toNative(p) {
  return IS_WIN ? p.replace(/\//g, "\\") : p;
}
function isAbs(p) {
  return p.startsWith("/") || IS_WIN && /^[A-Za-z]:\//.test(p);
}
function normPath(p) {
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
function pjoin(base, ...parts) {
  let out = base;
  for (const raw of parts) {
    const p = toPosix(raw);
    out = isAbs(p) ? p : out === "." ? p : `${out}/${p}`;
  }
  return normPath(out);
}
function pname(p) {
  const s = normPath(p);
  if (s === "/" || s === ".") return "";
  const i = s.lastIndexOf("/");
  return i < 0 ? s : s.slice(i + 1);
}
function pparent(p) {
  const s = normPath(p);
  const i = s.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  if (IS_WIN && i === 2 && /^[A-Za-z]:/.test(s)) return s.slice(0, 3);
  return s.slice(0, i);
}
function psuffix(p) {
  const name = pname(p);
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  if (name.slice(0, i).replace(/\./g, "") === "") return "";
  return name.slice(i);
}
function pstem(p) {
  const name = pname(p);
  const suf = psuffix(p);
  return suf ? name.slice(0, name.length - suf.length) : name;
}
function withoutSuffix(p) {
  const suf = psuffix(p);
  if (!suf) return normPath(p);
  const s = normPath(p);
  return s.slice(0, s.length - suf.length);
}
function pparts(p) {
  const s = normPath(p);
  if (s === ".") return [];
  if (s.startsWith("/")) return ["/", ...s.slice(1).split("/").filter(Boolean)];
  return s.split("/");
}
function relTo(p, root) {
  const a = pparts(p);
  const b = pparts(root);
  const eq = (x, y) => IS_WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
  if (b.length > a.length || !b.every((x, i) => eq(x, a[i]))) throw new Error(`${p} is not in the subpath of ${root}`);
  const rest = a.slice(b.length);
  return rest.length ? rest.join("/") : ".";
}
function cmpPath(a, b) {
  const pa = normPath(a).split("/");
  const pb = normPath(b).split("/");
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = IS_WIN ? pa[i].toLowerCase() : pa[i];
    const y = IS_WIN ? pb[i].toLowerCase() : pb[i];
    const c = cmpStr(x, y);
    if (c) return c;
  }
  return pa.length - pb.length;
}
function sortedPaths(paths) {
  return Array.from(paths).sort(cmpPath);
}
function samePath(a, b) {
  return cmpPath(a, b) === 0;
}
function uniqPaths(paths) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const p of paths) {
    const key = IS_WIN ? normPath(p).toLowerCase() : normPath(p);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}
function homeDir() {
  return normPath(toPosix(os.homedir()));
}
function resolvePath(p) {
  const abs = toPosix(nodePath.resolve(toNative(p)));
  try {
    return normPath(toPosix(fs.realpathSync(toNative(abs))));
  } catch {
    const parent = nodePath.dirname(toNative(abs));
    if (parent === toNative(abs)) return normPath(abs);
    return pjoin(resolvePath(toPosix(parent)), nodePath.basename(toNative(abs)));
  }
}
function exists(p) {
  try {
    fs.statSync(toNative(p));
    return true;
  } catch {
    return false;
  }
}
function isFile(p) {
  try {
    return fs.statSync(toNative(p)).isFile();
  } catch {
    return false;
  }
}
function isDir(p) {
  try {
    return fs.statSync(toNative(p)).isDirectory();
  } catch {
    return false;
  }
}
function isSymlink(p) {
  try {
    return fs.lstatSync(toNative(p)).isSymbolicLink();
  } catch {
    return false;
  }
}
function isOSError(e) {
  return e instanceof Error && typeof e.errno === "number";
}
function iterdir(d) {
  return fs.readdirSync(toNative(d)).map((name) => pjoin(d, name));
}
var FATAL = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeIgnore(buf) {
  try {
    return FATAL.decode(buf);
  } catch {
  }
  const parts = [];
  let runStart = 0;
  let i = 0;
  const n = buf.length;
  const flush = (end) => {
    if (end > runStart) parts.push(FATAL.decode(buf.subarray(runStart, end)));
  };
  while (i < n) {
    const b = buf[i];
    if (b < 128) {
      i++;
      continue;
    }
    let need = 0;
    let lo = 128;
    let hi = 191;
    if (b >= 194 && b <= 223) need = 1;
    else if (b >= 224 && b <= 239) {
      need = 2;
      if (b === 224) lo = 160;
      if (b === 237) hi = 159;
    } else if (b >= 240 && b <= 244) {
      need = 3;
      if (b === 240) lo = 144;
      if (b === 244) hi = 143;
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
      const l = j === 1 ? lo : 128;
      const h = j === 1 ? hi : 191;
      if (c === void 0 || c < l || c > h) {
        ok = false;
        break;
      }
    }
    if (ok) {
      i += need + 1;
      continue;
    }
    flush(i);
    i += j;
    runStart = i;
  }
  flush(n);
  return parts.join("");
}
function translateNewlines(s) {
  return s.includes("\r") ? s.replace(/\r\n?/g, "\n") : s;
}
function decodeStrict(buf) {
  return FATAL.decode(buf);
}
function readTextIgnore(p) {
  return translateNewlines(decodeIgnore(fs.readFileSync(toNative(p))));
}
function readTextStrict(p) {
  return translateNewlines(decodeStrict(fs.readFileSync(toNative(p))));
}
function cpPrefix(s, maxChars) {
  if (s.length <= maxChars) return s;
  let units = 0;
  let count = 0;
  while (units < s.length && count < maxChars) {
    const c = s.charCodeAt(units);
    units += c >= 55296 && c <= 56319 && units + 1 < s.length ? 2 : 1;
    count++;
  }
  return s.slice(0, units);
}
function cpCountAtLeast(s, n) {
  if (s.length < n) return false;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(c >= 56320 && c <= 57343)) count++;
    if (count >= n) return true;
  }
  return false;
}
function readCode(p, maxChars = 2e5) {
  let fd;
  try {
    fd = fs.openSync(toNative(p), "r");
    const size = fs.fstatSync(fd).size;
    const want = maxChars * 4 + 4;
    let buf;
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
    if (fd !== void 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function atomicWrite(p, content) {
  try {
    if (readTextStrict(p) === content) return false;
  } catch {
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
      }
    }
  }
  return true;
}
function chmodExec(p) {
  fs.chmodSync(toNative(p), 493);
}
function runGit(args, cwd) {
  try {
    const res = spawnSync("git", args, { cwd: toNative(cwd), timeout: 5e3, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (res.error || !res.stdout) return "";
    return pyStrip(translateNewlines(decodeStrict(res.stdout)));
  } catch {
    return "";
  }
}
function gitOk(args, cwd) {
  try {
    const res = spawnSync("git", args, { cwd: toNative(cwd), timeout: 5e3, windowsHide: true, stdio: "ignore" });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}
var REPO_FILE_CACHE = /* @__PURE__ */ new Map();
function clearRepoFileCache(root) {
  REPO_FILE_CACHE.delete(resolvePath(root));
}
function scanDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(toNative(dir), { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    let isD = e.isDirectory();
    if (e.isSymbolicLink()) isD = isDir(pjoin(dir, e.name));
    (isD ? dirs : files).push(e.name);
  }
  return { dirs, files };
}
function getRepoFiles(root) {
  const resolved = resolvePath(root);
  const cached = REPO_FILE_CACHE.get(resolved);
  if (cached) return cached;
  const files = [];
  const stack = [""];
  outer: while (stack.length) {
    const relDir = stack.pop();
    const curDir = relDir ? `${resolved}/${relDir}` : resolved;
    const listing = scanDir(curDir);
    if (!listing) continue;
    const depth = relDir ? relDir.split("/").length : 0;
    let dirs = [];
    if (depth < 6) {
      dirs = sortedStr(
        listing.dirs.filter((d) => !IGNORED_DIRS.has(d) && !d.startsWith(".git") && (d === ".github" || !d.startsWith(".")))
      );
    }
    for (const fn of sortedStr(listing.files)) {
      if (fn.startsWith(".") && fn !== ".env.example" && fn !== ".env.sample") continue;
      if (endsWithAny(fn, [".min.js", ".bundle.js", ".chunk.js", ".map"])) continue;
      files.push([`${curDir}/${fn}`, relDir ? `${relDir}/${fn}` : fn]);
      if (files.length >= 6e3) break outer;
    }
    for (let i = dirs.length - 1; i >= 0; i--) {
      const sub = relDir ? `${relDir}/${dirs[i]}` : dirs[i];
      if (!isSymlink(`${resolved}/${sub}`)) stack.push(sub);
    }
  }
  REPO_FILE_CACHE.set(resolved, files);
  return files;
}
var GLOB_CACHE = /* @__PURE__ */ new Map();
function globRegex(pattern) {
  const cached = GLOB_CACHE.get(pattern);
  if (cached !== void 0) return cached;
  const out = ["^"];
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
      out.push(reEscape(pattern[i]));
      i += 1;
    }
  }
  out.push("$");
  const src = out.join("");
  GLOB_CACHE.set(pattern, src);
  return src;
}
function iterRepoFiles(root, pattern, limit = 80) {
  const rx = globRegex(pattern);
  const out = [];
  for (const [full, rel2] of getRepoFiles(root)) {
    if (reMatch(rx, rel2)) {
      out.push(full);
      if (out.length >= limit) break;
    }
  }
  return sortedPaths(out);
}
var NAME_RX_CACHE = /* @__PURE__ */ new Map();
function nameMatcher(seg) {
  let rx = NAME_RX_CACHE.get(seg);
  if (rx) return rx;
  let src = "";
  let i = 0;
  while (i < seg.length) {
    const c = seg[i];
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
function pglob(base, pattern) {
  const recursive = pattern.startsWith("**/");
  const seg = recursive ? pattern.slice(3) : pattern;
  if (seg.includes("/")) throw new Error(`unsupported glob ${pattern}`);
  const rx = nameMatcher(seg);
  const out = [];
  const stack = [normPath(base)];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
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
function sha1Hex(text) {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

// packages/daemon/src/blueprint/pyjson.ts
var JSONDecodeError = class extends Error {
};
var WS = /* @__PURE__ */ new Set([" ", "	", "\n", "\r"]);
var NUMBER_RE = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
var ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "	" };
var HEX4 = /^[0-9a-fA-F]{4}$/;
var Scanner = class {
  constructor(s) {
    this.s = s;
  }
  s;
  i = 0;
  ws() {
    while (this.i < this.s.length && WS.has(this.s[this.i])) this.i++;
  }
  fail(msg) {
    throw new JSONDecodeError(`${msg}: char ${this.i}`);
  }
  value() {
    const s = this.s;
    const c = s[this.i];
    if (c === '"') {
      this.i++;
      return this.str();
    }
    if (c === "{") return this.obj();
    if (c === "[") return this.arr();
    if (c === "n" && s.startsWith("null", this.i)) {
      this.i += 4;
      return null;
    }
    if (c === "t" && s.startsWith("true", this.i)) {
      this.i += 4;
      return true;
    }
    if (c === "f" && s.startsWith("false", this.i)) {
      this.i += 5;
      return false;
    }
    if (c === "N" && s.startsWith("NaN", this.i)) {
      this.i += 3;
      return NaN;
    }
    if (c === "I" && s.startsWith("Infinity", this.i)) {
      this.i += 8;
      return Infinity;
    }
    if (c === "-" && s.startsWith("-Infinity", this.i)) {
      this.i += 9;
      return -Infinity;
    }
    NUMBER_RE.lastIndex = this.i;
    const m = NUMBER_RE.exec(s);
    if (m) {
      this.i += m[0].length;
      if (m[1] !== void 0 || m[2] !== void 0) return Number(m[0]);
      const digits = m[0].replace("-", "");
      if (digits.length > 4300) throw new RangeError("Exceeds the limit (4300 digits) for integer string conversion");
      return BigInt(m[0]);
    }
    this.fail("Expecting value");
  }
  str() {
    const s = this.s;
    let out = "";
    for (; ; ) {
      let j = this.i;
      while (j < s.length) {
        const ch = s.charCodeAt(j);
        if (ch === 34 || ch === 92 || ch < 32) break;
        j++;
      }
      out += s.slice(this.i, j);
      this.i = j;
      if (j >= s.length) this.fail("Unterminated string starting at");
      const c = s[j];
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c !== "\\") this.fail("Invalid control character at");
      const e = s[j + 1];
      if (e === void 0) this.fail("Unterminated string starting at");
      if (e !== "u") {
        const rep = ESCAPES[e];
        if (rep === void 0) this.fail("Invalid \\escape");
        out += rep;
        this.i = j + 2;
        continue;
      }
      const hex2 = s.slice(j + 2, j + 6);
      if (!HEX4.test(hex2)) this.fail("Invalid \\uXXXX escape");
      let cp = parseInt(hex2, 16);
      this.i = j + 6;
      if (cp >= 55296 && cp <= 56319 && s[this.i] === "\\" && s[this.i + 1] === "u") {
        const hex22 = s.slice(this.i + 2, this.i + 6);
        if (HEX4.test(hex22)) {
          const lo = parseInt(hex22, 16);
          if (lo >= 56320 && lo <= 57343) {
            cp = 65536 + (cp - 55296 << 10) + (lo - 56320);
            this.i += 6;
          }
        }
      }
      out += String.fromCodePoint(cp);
    }
  }
  obj() {
    const s = this.s;
    const out = /* @__PURE__ */ new Map();
    this.i++;
    this.ws();
    if (s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (; ; ) {
      if (s[this.i] !== '"') this.fail("Expecting property name enclosed in double quotes");
      this.i++;
      const key = this.str();
      this.ws();
      if (s[this.i] !== ":") this.fail("Expecting ':' delimiter");
      this.i++;
      this.ws();
      out.set(key, this.value());
      this.ws();
      const c = s[this.i];
      this.i++;
      if (c === "}") return out;
      if (c !== ",") this.fail("Expecting ',' delimiter");
      this.ws();
    }
  }
  arr() {
    const s = this.s;
    const out = [];
    this.i++;
    this.ws();
    if (s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (; ; ) {
      out.push(this.value());
      this.ws();
      const c = s[this.i];
      this.i++;
      if (c === "]") return out;
      if (c !== ",") this.fail("Expecting ',' delimiter");
      this.ws();
    }
  }
  document() {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i !== this.s.length) this.fail("Extra data");
    return v;
  }
};
function loads(text) {
  if (text.startsWith("\uFEFF")) throw new JSONDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)");
  return new Scanner(text).document();
}
function dumpStr(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = ch.charCodeAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 32) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}
function dumpValue(v, level, indent) {
  if (v === null || v === void 0) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    return Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) < 2 ** 53 ? String(v) : pyFloatRepr(v);
  }
  if (typeof v === "string") return dumpStr(v);
  const inner = "\n" + " ".repeat(indent * (level + 1));
  const outer = "\n" + " ".repeat(indent * level);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[${inner}${v.map((x) => dumpValue(x, level + 1, indent)).join(`,${inner}`)}${outer}]`;
  }
  const entries = v instanceof Map ? Array.from(v) : Object.entries(v);
  if (!entries.length) return "{}";
  return `{${inner}${entries.map(([k, x]) => `${dumpStr(k)}: ${dumpValue(x, level + 1, indent)}`).join(`,${inner}`)}${outer}}`;
}
function dumps(value, indent = 2) {
  return dumpValue(value, 0, indent);
}

// packages/daemon/src/blueprint/pylex.ts
var PySyntaxError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PySyntaxError";
  }
};
function syntaxError(message) {
  throw new PySyntaxError(message);
}
var KEYWORDS = /* @__PURE__ */ new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield"
]);
var MAXINDENT = 100;
var MAXLEVEL = 200;
var MAXFSTRINGLEVEL = 150;
var MAX_EXPR_NESTING = 3;
var MAX_STR_DIGITS = 4300;
var THREE = /* @__PURE__ */ new Set(["**=", "...", "//=", "<<=", ">>="]);
var TWO = /* @__PURE__ */ new Set([
  "!=",
  "%=",
  "&=",
  "**",
  "*=",
  "+=",
  "-=",
  "->",
  "//",
  "/=",
  ":=",
  "<<",
  "<=",
  "<>",
  "==",
  ">=",
  ">>",
  "@=",
  "^=",
  "|="
]);
var ONE = /* @__PURE__ */ new Set([..."!%&()*+,-./:;<=>@[]^{|}~"]);
var CLOSER = { ")": "(", "]": "[", "}": "{" };
var IDENT_RE = new RegExp("^[\\p{XID_Start}_]\\p{XID_Continue}*$", "u");
var isDigit = (c) => c !== void 0 && c >= "0" && c <= "9";
var isHex = (c) => c !== void 0 && (c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F");
var isOct = (c) => c !== void 0 && c >= "0" && c <= "7";
var isBin = (c) => c === "0" || c === "1";
function identStart(c) {
  if (c === void 0) return false;
  const k = c.charCodeAt(0);
  return k >= 97 && k <= 122 || k >= 65 && k <= 90 || k === 95 || k >= 128;
}
function identChar(c) {
  return identStart(c) || isDigit(c);
}
function decodeLiteral(body, raw, bytes) {
  if (bytes) {
    for (let i2 = 0; i2 < body.length; i2++) {
      if (body.charCodeAt(i2) >= 128) syntaxError("bytes can only contain ASCII literal characters");
    }
  }
  if (raw || !body.includes("\\")) return body;
  let out = "";
  const n = body.length;
  let i = 0;
  while (i < n) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    i++;
    if (i >= n) {
      out += "\\";
      break;
    }
    const e = body[i];
    i++;
    switch (e) {
      case "\n":
        break;
      case "\\":
      case "'":
      case '"':
        out += e;
        break;
      case "a":
        out += "\x07";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "	";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        let v = e.charCodeAt(0) - 48;
        for (let k = 0; k < 2 && isOct(body[i]); k++) v = v * 8 + body.charCodeAt(i++) - 48;
        out += bytes ? String.fromCharCode(v & 255) : String.fromCodePoint(v);
        break;
      }
      case "x": {
        if (!isHex(body[i]) || !isHex(body[i + 1])) syntaxError("(unicode error) truncated \\xXX escape");
        out += String.fromCharCode(parseInt(body.slice(i, i + 2), 16));
        i += 2;
        break;
      }
      case "u":
      case "U": {
        if (bytes) {
          out += `\\${e}`;
          break;
        }
        const len = e === "u" ? 4 : 8;
        const hex2 = body.slice(i, i + len);
        if (hex2.length !== len || ![...hex2].every((h) => isHex(h))) {
          syntaxError(`(unicode error) truncated \\${e}${"X".repeat(len)} escape`);
        }
        const cp = parseInt(hex2, 16);
        if (cp > 1114111) syntaxError("(unicode error) illegal Unicode character");
        out += cp >= 55296 && cp <= 57343 ? surrogateStandIn(cp) : String.fromCodePoint(cp);
        i += len;
        break;
      }
      case "N": {
        if (bytes) {
          out += "\\N";
          break;
        }
        const close = body[i] === "{" ? body.indexOf("}", i) : -1;
        const name = close > i + 1 ? body.slice(i + 1, close) : "";
        if (!/^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(name)) syntaxError("(unicode error) malformed \\N character escape");
        out += "�";
        i = close + 1;
        break;
      }
      default:
        out += `\\${e}`;
    }
  }
  return out;
}
function stripFieldComments(s) {
  let hash = false;
  let inStr = false;
  let q = "";
  for (let i2 = 0; i2 < s.length; i2++) {
    const ch = s[i2];
    if (ch === "\\") {
      i2++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!inStr) {
        inStr = true;
        q = ch;
      } else if (ch === q) inStr = false;
      continue;
    }
    if (ch === "#" && !inStr) {
      hash = true;
      break;
    }
  }
  if (!hash) return s;
  let out = "";
  inStr = false;
  q = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      if (!inStr) {
        inStr = true;
        q = ch;
      } else if (ch === q) inStr = false;
      out += ch;
    } else if (ch === "#" && !inStr) {
      while (i < s.length && s[i] !== "\n") i++;
      if (i < s.length) out += "\n";
    } else out += ch;
    i++;
  }
  return out;
}
function stripInterpolationExpr(s) {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "=" || isPySpace(s[end - 1]))) end--;
  return s.slice(0, end);
}
var Lexer = class {
  src;
  i = 0;
  parens = [];
  fdepth = 0;
  constructor(src) {
    this.src = src;
  }
  run() {
    const src = this.src;
    const toks = [];
    const ind = [0];
    const alt = [0];
    let atbol = true;
    let blank = false;
    const push = (t, s, e = s) => toks.push({ t, v: "", s, e });
    for (; ; ) {
      if (atbol) {
        atbol = false;
        let col = 0;
        let altcol = 0;
        let cont = 0;
        for (; ; ) {
          const c3 = src[this.i];
          if (c3 === " ") {
            col++;
            altcol++;
          } else if (c3 === "	") {
            col = (Math.floor(col / 8) + 1) * 8;
            altcol++;
          } else if (c3 === "\f") {
            col = altcol = 0;
          } else if (c3 === "\\") {
            cont = cont || col;
            this.continuation();
            continue;
          } else break;
          this.i++;
        }
        const c2 = src[this.i];
        blank = c2 === "#" || c2 === "\n";
        if (!blank && this.parens.length === 0) {
          if (cont) col = altcol = cont;
          const top = ind.length - 1;
          if (col === ind[top]) {
            if (altcol !== alt[top]) syntaxError("inconsistent use of tabs and spaces in indentation");
          } else if (col > ind[top]) {
            if (top + 1 >= MAXINDENT) syntaxError("too many levels of indentation");
            if (altcol <= alt[top]) syntaxError("inconsistent use of tabs and spaces in indentation");
            ind.push(col);
            alt.push(altcol);
            push("INDENT", this.i);
          } else {
            while (ind.length > 1 && col < ind[ind.length - 1]) {
              ind.pop();
              alt.pop();
              push("DEDENT", this.i);
            }
            if (col !== ind[ind.length - 1]) syntaxError("unindent does not match any outer indentation level");
            if (altcol !== alt[alt.length - 1]) syntaxError("inconsistent use of tabs and spaces in indentation");
          }
        }
      }
      while (src[this.i] === " " || src[this.i] === "	" || src[this.i] === "\f") this.i++;
      if (src[this.i] === "#") {
        while (this.i < src.length && src[this.i] !== "\n") this.i++;
      }
      const c = src[this.i];
      if (c === void 0) {
        if (this.parens.length) syntaxError(`'${this.parens[this.parens.length - 1]}' was never closed`);
        push("END", this.i);
        return toks;
      }
      if (c === "\n") {
        this.i++;
        atbol = true;
        if (blank || this.parens.length > 0) continue;
        push("NEWLINE", this.i - 1, this.i);
        continue;
      }
      if (c === "\\") {
        this.continuation();
        continue;
      }
      toks.push(this.scanToken());
    }
  }
  /** At a backslash: it must end the line, and something must follow. */
  continuation() {
    if (this.src[this.i + 1] !== "\n") syntaxError("unexpected character after line continuation character");
    this.i += 2;
    if (this.i >= this.src.length) syntaxError("unexpected EOF while parsing");
  }
  /** One token starting at this.i (whitespace and comments already skipped). */
  scanToken() {
    const src = this.src;
    const start = this.i;
    const c = src[start];
    if (identStart(c)) {
      let b = false;
      let r = false;
      let u = false;
      let f = false;
      let t = false;
      let j = start;
      for (; ; ) {
        const ch = src[j];
        if (!(b || u || f || t) && (ch === "b" || ch === "B")) b = true;
        else if (!(b || u || r || f || t) && (ch === "u" || ch === "U")) u = true;
        else if (!(r || u) && (ch === "r" || ch === "R")) r = true;
        else if (!(f || b || u || t) && (ch === "f" || ch === "F")) f = true;
        else if (!(t || u || b || f) && (ch === "t" || ch === "T")) t = true;
        else break;
        j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          return f || t ? this.fstring(start, j, r, t) : this.string(start, j, b, r);
        }
      }
      let k = start;
      let nonascii = false;
      while (identChar(src[k])) {
        if (src.charCodeAt(k) >= 128) nonascii = true;
        k++;
      }
      const raw = src.slice(start, k);
      if (nonascii && !IDENT_RE.test(raw)) syntaxError("invalid character in identifier");
      this.i = k;
      return { t: "NAME", v: nonascii ? raw.normalize("NFKC") : raw, raw, kw: KEYWORDS.has(raw), s: start, e: k };
    }
    if (isDigit(c) || c === "." && isDigit(src[start + 1])) return this.number();
    if (c === "'" || c === '"') return this.string(start, start, false, false);
    const three = src.substr(start, 3);
    if (THREE.has(three)) {
      this.i = start + 3;
      return { t: "OP", v: three, s: start, e: this.i };
    }
    const two = src.substr(start, 2);
    if (TWO.has(two)) {
      this.i = start + 2;
      return { t: "OP", v: two, s: start, e: this.i };
    }
    if (!ONE.has(c)) syntaxError(`invalid character '${c}'`);
    if (c === "(" || c === "[" || c === "{") {
      if (this.parens.length >= MAXLEVEL) syntaxError("too many nested parentheses");
      this.parens.push(c);
    } else if (c in CLOSER) {
      const open = this.parens.pop();
      if (open === void 0) syntaxError(`unmatched '${c}'`);
      if (open !== CLOSER[c]) syntaxError(`closing parenthesis '${c}' does not match opening parenthesis '${open}'`);
    }
    this.i = start + 1;
    return { t: "OP", v: c, s: start, e: this.i };
  }
  number() {
    const src = this.src;
    const start = this.i;
    let p = start;
    const nextc = () => {
      const ch = src[p];
      if (ch !== void 0) p++;
      return ch;
    };
    const backup = (ch) => {
      if (ch !== void 0) p--;
    };
    const decimalTail = () => {
      let ch;
      for (; ; ) {
        do
          ch = nextc();
        while (isDigit(ch));
        if (ch !== "_") break;
        ch = nextc();
        if (!isDigit(ch)) syntaxError("invalid decimal literal");
      }
      return ch;
    };
    const verifyEnd = (ch, kind) => {
      const look = (s) => src.startsWith(s, p) && !identChar(src[p + s.length]);
      let ok = false;
      if (ch === "a") ok = look("nd");
      else if (ch === "e") ok = look("lse");
      else if (ch === "f") ok = look("or");
      else if (ch === "i") ok = src[p] === "f" || src[p] === "n" || src[p] === "s";
      else if (ch === "o") ok = look("r");
      else if (ch === "n") ok = look("ot");
      if (ok) return;
      if (ch !== void 0 && ch.charCodeAt(0) < 128 && identChar(ch)) syntaxError(`invalid ${kind} literal`);
    };
    const radix = (isD, kind, checkDigit) => {
      let ch = nextc();
      do {
        if (ch === "_") ch = nextc();
        if (!isD(ch)) {
          if (checkDigit && isDigit(ch)) syntaxError(`invalid digit '${ch}' in ${kind} literal`);
          syntaxError(`invalid ${kind} literal`);
        }
        do
          ch = nextc();
        while (isD(ch));
      } while (ch === "_");
      if (checkDigit && isDigit(ch)) syntaxError(`invalid digit '${ch}' in ${kind} literal`);
      verifyEnd(ch, kind);
      backup(ch);
    };
    let c = nextc();
    let stage;
    if (c === ".") {
      c = nextc();
      stage = "fraction";
    } else if (c === "0") {
      c = nextc();
      if (c === "x" || c === "X") {
        radix(isHex, "hexadecimal", false);
        return this.numberTok(start, p);
      }
      if (c === "o" || c === "O") {
        radix(isOct, "octal", true);
        return this.numberTok(start, p);
      }
      if (c === "b" || c === "B") {
        radix(isBin, "binary", true);
        return this.numberTok(start, p);
      }
      let nonzero = false;
      for (; ; ) {
        if (c === "_") {
          c = nextc();
          if (!isDigit(c)) syntaxError("invalid decimal literal");
        }
        if (c !== "0") break;
        c = nextc();
      }
      if (isDigit(c)) {
        nonzero = true;
        c = decimalTail();
      }
      if (c === ".") {
        c = nextc();
        stage = "fraction";
      } else if (c === "e" || c === "E") stage = "exponent";
      else if (c === "j" || c === "J") stage = "imag";
      else {
        if (nonzero) {
          syntaxError("leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers");
        }
        verifyEnd(c, "decimal");
        stage = "done";
      }
    } else {
      c = decimalTail();
      if (c === ".") {
        c = nextc();
        stage = "fraction";
      } else stage = "postfrac";
    }
    if (stage === "fraction") {
      if (isDigit(c)) c = decimalTail();
      stage = "postfrac";
    }
    if (stage === "postfrac") {
      if (c === "e" || c === "E") stage = "exponent";
      else if (c === "j" || c === "J") stage = "imag";
      else {
        verifyEnd(c, "decimal");
        stage = "done";
      }
    }
    if (stage === "exponent") {
      const e = c;
      c = nextc();
      if (c === "+" || c === "-") {
        c = nextc();
        if (!isDigit(c)) syntaxError("invalid decimal literal");
      } else if (!isDigit(c)) {
        backup(c);
        verifyEnd(e, "decimal");
        backup(e);
        return this.numberTok(start, p);
      }
      c = decimalTail();
      if (c === "j" || c === "J") stage = "imag";
      else {
        verifyEnd(c, "decimal");
        stage = "done";
      }
    }
    if (stage === "imag") {
      c = nextc();
      verifyEnd(c, "imaginary");
    }
    backup(c);
    return this.numberTok(start, p);
  }
  numberTok(start, end) {
    this.i = end;
    const text = this.src.slice(start, end).replace(/_/g, "");
    let num;
    const last = text[text.length - 1];
    if (last === "j" || last === "J") num = { k: "complex", v: Number(text.slice(0, -1)) };
    else if (/^0[xXoObB]/.test(text)) num = { k: "int", v: BigInt(`0${text[1].toLowerCase()}${text.slice(2)}`) };
    else if (/^[0-9]+$/.test(text)) {
      if (text[0] === "0") num = { k: "int", v: 0n };
      else {
        if (text.length > MAX_STR_DIGITS) {
          syntaxError(`Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion`);
        }
        num = { k: "int", v: BigInt(text) };
      }
    } else num = { k: "float", v: Number(text) };
    return { t: "NUMBER", v: text, num, s: start, e: end };
  }
  /** A plain (non-f) string literal; q is the index of its opening quote. */
  string(start, q, isBytes, isRaw) {
    const src = this.src;
    const quote = src[q];
    const size = src.startsWith(quote.repeat(3), q) ? 3 : 1;
    let p = q + size;
    if (size === 1 && src[p] === quote) {
      this.i = p + 1;
      return { t: "STRING", v: "", bytes: isBytes, u: src[start] === "u", sv: "", s: start, e: this.i };
    }
    const bodyStart = p;
    let endq = 0;
    while (endq !== size) {
      const c = src[p];
      if (c === void 0 || size === 1 && c === "\n") {
        syntaxError(size === 3 ? "unterminated triple-quoted string literal" : "unterminated string literal");
      }
      p++;
      if (c === quote) endq++;
      else {
        endq = 0;
        if (c === "\\" && src[p] !== void 0) p++;
      }
    }
    this.i = p;
    const sv = decodeLiteral(src.slice(bodyStart, p - size), isRaw, isBytes);
    return { t: "STRING", v: "", bytes: isBytes, u: src[start] === "u", sv, s: start, e: p };
  }
  fstring(start, q, isRaw, isT) {
    if (this.fdepth + 1 >= MAXFSTRINGLEVEL) syntaxError("too many nested f-strings");
    this.fdepth++;
    const src = this.src;
    const quote = src[q];
    const size = src.startsWith(quote.repeat(3), q) ? 3 : 1;
    const ctx = { quote, size, raw: isRaw, tstr: isT };
    const { parts, p } = this.fbody(q + size, ctx, false, 0);
    this.fdepth--;
    this.i = p;
    return { t: "FSTRING", v: "", tstr: isT, parts, s: start, e: p };
  }
  /**
   * The literal part of an f-string body, or of a format spec (inSpec). Returns at the end of
   * the string (after the closing quotes) or, in a spec, at the '}' that closes the field.
   */
  fbody(p0, ctx, inSpec, fieldDepth) {
    const src = this.src;
    const parts = [];
    const closing = ctx.quote.repeat(ctx.size);
    let lit = "";
    let p = p0;
    let uni = false;
    const flush = () => {
      if (lit) parts.push({ lit: decodeLiteral(lit, ctx.raw, false) });
      lit = "";
    };
    for (; ; ) {
      const c = src[p];
      if (c === void 0) syntaxError("unterminated f-string literal");
      if (c === ctx.quote && src.startsWith(closing, p)) {
        if (inSpec) syntaxError("f-string: expecting '}'");
        flush();
        return { parts, p: p + ctx.size };
      }
      if (ctx.size === 1 && c === "\n") {
        if (inSpec) syntaxError("f-string: newlines are not allowed in format specifiers for single quoted f-strings");
        syntaxError("unterminated f-string literal");
      }
      if (c === "{") {
        if (!inSpec && src[p + 1] === "{") {
          lit += "{";
          p += 2;
          uni = false;
          continue;
        }
        flush();
        uni = false;
        const r = this.field(p, ctx, fieldDepth);
        parts.push({ field: r.field });
        p = r.p;
        continue;
      }
      if (c === "}") {
        if (uni) {
          lit += "}";
          p++;
          uni = false;
          continue;
        }
        if (inSpec) {
          flush();
          return { parts, p };
        }
        if (src[p + 1] === "}") {
          lit += "}";
          p += 2;
          uni = false;
          continue;
        }
        syntaxError("f-string: single '}' is not allowed");
      }
      if (c === "\\") {
        const peek = src[p + 1];
        if (peek === "{" || peek === "}") {
          lit += "\\";
          p++;
          continue;
        }
        if (!ctx.raw && peek === "N" && src[p + 2] === "{") {
          lit += "\\N{";
          p += 3;
          uni = true;
          continue;
        }
        if (peek === void 0) {
          p++;
          continue;
        }
        lit += c + peek;
        p += 2;
        continue;
      }
      lit += c;
      p++;
    }
  }
  /** Whitespace, newlines, comments and continuations inside a replacement field. */
  skipFieldSpace() {
    const src = this.src;
    for (; ; ) {
      const c = src[this.i];
      if (c === " " || c === "	" || c === "\f" || c === "\n") this.i++;
      else if (c === "#") {
        while (this.i < src.length && src[this.i] !== "\n") this.i++;
      } else if (c === "\\") this.continuation();
      else return;
    }
  }
  /** A replacement field; p0 is at its '{'. Returns just after the closing '}'. */
  field(p0, ctx, fieldDepth) {
    if (fieldDepth >= MAX_EXPR_NESTING) syntaxError("f-string: expressions nested too deeply");
    if (this.parens.length >= MAXLEVEL) syntaxError("too many nested parentheses");
    const src = this.src;
    this.parens.push("{");
    const base = this.parens.length;
    const exprStart = p0 + 1;
    this.i = exprStart;
    const toks = [];
    let bang = -1;
    let term;
    for (; ; ) {
      this.skipFieldSpace();
      const c = src[this.i];
      if (c === void 0) syntaxError("f-string: expecting '}'");
      if (this.parens.length === base) {
        if (c === "}" || c === ":" || c === "!" && src[this.i + 1] !== "=") {
          term = c;
          break;
        }
        if (c === "!") bang = this.i;
      }
      toks.push(this.scanToken());
    }
    const exprEnd = this.i;
    let debug = false;
    const last = toks[toks.length - 1];
    if (last && last.t === "OP" && last.v === "=") {
      debug = true;
      toks.pop();
    }
    if (toks.length === 0) syntaxError("f-string: valid expression required before '}'");
    const metaEnd = term === ":" && bang >= 0 ? bang : exprEnd;
    const meta = stripFieldComments(src.slice(exprStart, metaEnd));
    let conv = -1;
    if (term === "!") {
      this.i++;
      if (!identStart(src[this.i])) {
        syntaxError(
          src[this.i] === "}" || src[this.i] === ":" ? "f-string: missing conversion character" : "f-string: conversion type must come right after the exclamation mark"
        );
      }
      const nt = this.scanToken();
      if (nt.t !== "NAME" || nt.kw || !(nt.v === "s" || nt.v === "r" || nt.v === "a")) {
        syntaxError("f-string: invalid conversion character: expected 's', 'r', or 'a'");
      }
      conv = nt.v.charCodeAt(0);
      this.skipFieldSpace();
      const c2 = src[this.i];
      if (c2 !== ":" && c2 !== "}") syntaxError("f-string: expecting ':' or '}'");
      term = c2;
    }
    let spec = null;
    if (term === ":") {
      const r = this.fbody(this.i + 1, ctx, true, fieldDepth + 1);
      spec = r.parts;
      this.i = r.p;
    }
    if (src[this.i] !== "}") syntaxError("f-string: expecting '}'");
    this.i++;
    this.parens.pop();
    if (debug && conv === -1 && spec === null) conv = 114;
    toks.push({ t: "END", v: "", s: exprEnd, e: exprEnd });
    const field = {
      toks,
      debug: debug ? meta : null,
      str: stripInterpolationExpr(meta),
      conv,
      spec,
      interp: ctx.tstr && fieldDepth === 0
    };
    return { field, p: this.i };
  }
};
function tokenize(source) {
  if (source.includes("\0")) syntaxError("source code string cannot contain null bytes");
  let src = source.replace(/\r\n?/g, "\n");
  if (src.length > 0 && !src.endsWith("\n")) src += "\n";
  return new Lexer(src).run();
}

// packages/daemon/src/blueprint/pyparse.ts
var AUGASSIGN = /* @__PURE__ */ new Set(["+=", "-=", "*=", "@=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "**=", "//="]);
var SUM_OPS = /* @__PURE__ */ new Set(["+", "-"]);
var TERM_OPS = /* @__PURE__ */ new Set(["*", "/", "//", "%", "@"]);
var SHIFT_OPS = /* @__PURE__ */ new Set(["<<", ">>"]);
var OR_OPS = /* @__PURE__ */ new Set(["|"]);
var XOR_OPS = /* @__PURE__ */ new Set(["^"]);
var AND_OPS = /* @__PURE__ */ new Set(["&"]);
var SIMPLE_CMP = /* @__PURE__ */ new Set(["==", "<=", "<", ">=", ">"]);
var FUTURE_FEATURES = /* @__PURE__ */ new Set([
  "nested_scopes",
  "generators",
  "division",
  "absolute_import",
  "with_statement",
  "print_function",
  "unicode_literals",
  "barry_as_FLUFL",
  "generator_stop",
  "annotations"
]);
var strConst = (v, kind = null) => ({ _t: "Constant", cv: "str", v, kind });
var nameNode = (id) => ({ _t: "Name", id });
var tupleNode = (elts) => ({ _t: "Tuple", elts });
function foldConstants(flat, dropEmpty) {
  const out = [];
  for (let i = 0; i < flat.length; i++) {
    let el = flat[i];
    if (el._t === "Constant") {
      if (i + 1 < flat.length && flat[i + 1]._t === "Constant") {
        let v = "";
        let j = i;
        for (; j < flat.length && flat[j]._t === "Constant"; j++) v += flat[j].v;
        el = strConst(v, el.kind);
        i = j - 1;
      }
      if (dropEmpty && el.v === "") continue;
    }
    out.push(el);
  }
  return out;
}
var Parser = class _Parser {
  toks;
  p = 0;
  sh;
  memos = /* @__PURE__ */ new Map();
  constructor(toks, sh) {
    this.toks = toks;
    this.sh = sh;
  }
  // ---------------------------------------------------------------- token helpers
  get tok() {
    return this.toks[this.p];
  }
  at(k) {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)];
  }
  isOp(v, k = 0) {
    const t = this.at(k);
    return t.t === "OP" && t.v === v;
  }
  op(v) {
    if (!this.isOp(v)) return false;
    this.p++;
    return true;
  }
  isKw(w, k = 0) {
    const t = this.at(k);
    return t.t === "NAME" && t.kw === true && t.raw === w;
  }
  kw(w) {
    if (!this.isKw(w)) return false;
    this.p++;
    return true;
  }
  isSoft(w) {
    const t = this.tok;
    return t.t === "NAME" && !t.kw && t.raw === w;
  }
  /** NAME (not a keyword): the normalised identifier */
  name() {
    const t = this.tok;
    if (t.t !== "NAME" || t.kw) return null;
    this.p++;
    return t.v;
  }
  tLookahead() {
    return this.isOp("(") || this.isOp("[") || this.isOp(".");
  }
  mem(key, fn) {
    let tab = this.memos.get(key);
    if (!tab) this.memos.set(key, tab = /* @__PURE__ */ new Map());
    const start = this.p;
    const hit = tab.get(start);
    if (hit) {
      this.p = hit.e;
      return hit.r;
    }
    const r = fn();
    if (r === null) this.p = start;
    tab.set(start, { r, e: this.p });
    return r;
  }
  /** item (sep item)*: a separator is only taken when an item follows it */
  gather(item, sep = ",") {
    const first = item();
    if (first === null) return null;
    const out = [first];
    for (; ; ) {
      const q = this.p;
      if (!this.op(sep)) break;
      const it = item();
      if (it === null) {
        this.p = q;
        break;
      }
      out.push(it);
    }
    return out;
  }
  many(item) {
    const out = [];
    for (let it = item(); it !== null; it = item()) out.push(it);
    return out;
  }
  // ---------------------------------------------------------------- statements
  file() {
    const body = this.statements() ?? [];
    if (this.tok.t !== "END") syntaxError("invalid syntax");
    return { _t: "Module", body };
  }
  statements() {
    const out = [];
    for (; ; ) {
      const s = this.statement();
      if (!s) break;
      out.push(...s);
    }
    return out.length ? out : null;
  }
  statement() {
    const c = this.compoundStmt();
    if (c) return [c];
    return this.simpleStmts();
  }
  simpleStmts() {
    const m = this.p;
    const first = this.simpleStmt();
    if (!first) return null;
    if (!this.isOp(";") && this.tok.t === "NEWLINE") {
      this.p++;
      return [first];
    }
    const out = [first];
    for (; ; ) {
      const q = this.p;
      if (!this.op(";")) break;
      const s = this.simpleStmt();
      if (!s) {
        this.p = q;
        break;
      }
      out.push(s);
    }
    this.op(";");
    if (this.tok.t !== "NEWLINE") {
      this.p = m;
      return null;
    }
    this.p++;
    return out;
  }
  simpleStmt() {
    return this.mem("simple_stmt", () => {
      const a = this.assignment();
      if (a) return a;
      if (this.isSoft("type")) {
        const t2 = this.typeAlias();
        if (t2) return t2;
      }
      const e = this.starExpressions();
      if (e) return { _t: "Expr", value: e };
      const t = this.tok;
      if (t.t !== "NAME" || !t.kw) return null;
      switch (t.raw) {
        case "return":
          return this.returnStmt();
        case "import":
        case "from":
          return this.importStmt();
        case "raise":
          return this.raiseStmt();
        case "pass":
        case "break":
        case "continue":
          this.p++;
          return { _t: t.raw === "pass" ? "Pass" : t.raw === "break" ? "Break" : "Continue" };
        case "del":
          return this.delStmt();
        case "yield": {
          const y = this.yieldExpr();
          return y ? { _t: "Expr", value: y } : null;
        }
        case "assert":
          return this.assertStmt();
        case "global":
        case "nonlocal":
          return this.globalStmt();
      }
      return null;
    });
  }
  /** ['=' annotated_rhs] */
  optAssignValue() {
    const q = this.p;
    if (this.op("=")) {
      const v = this.annotatedRhs();
      if (v) return v;
      this.p = q;
    }
    return null;
  }
  assignment() {
    const m = this.p;
    const t = this.tok;
    if (t.t === "NAME" && !t.kw && this.isOp(":", 1)) {
      this.p += 2;
      const annotation = this.expression();
      if (annotation) {
        const value = this.optAssignValue();
        return { _t: "AnnAssign", target: nameNode(t.v), annotation, value, simple: 1 };
      }
      this.p = m;
    }
    let target = null;
    if (this.op("(")) {
      const s = this.singleTarget();
      if (s && this.op(")")) target = s;
      else this.p = m;
    }
    if (!target) target = this.subscriptAttributeTarget();
    if (target && this.op(":")) {
      const annotation = this.expression();
      if (annotation) {
        const value = this.optAssignValue();
        return { _t: "AnnAssign", target, annotation, value, simple: 0 };
      }
    }
    this.p = m;
    const targets = [];
    for (; ; ) {
      const q = this.p;
      const st2 = this.starTargets();
      if (!st2 || !this.op("=")) {
        this.p = q;
        break;
      }
      targets.push(st2);
    }
    if (targets.length) {
      const value = this.annotatedRhs();
      if (value && !this.isOp("=")) return { _t: "Assign", targets, value };
    }
    this.p = m;
    const st = this.singleTarget();
    if (st && this.tok.t === "OP" && AUGASSIGN.has(this.tok.v)) {
      this.p++;
      const value = this.annotatedRhs();
      if (value) return { _t: "AugAssign", target: st, value };
    }
    this.p = m;
    return null;
  }
  annotatedRhs() {
    return this.yieldExpr() ?? this.starExpressions();
  }
  typeAlias() {
    const m = this.p;
    this.p++;
    const n = this.name();
    if (n !== null) {
      this.typeParams();
      if (this.op("=")) {
        const value = this.expression();
        if (value) return { _t: "TypeAlias", name: n, value };
      }
    }
    this.p = m;
    return null;
  }
  returnStmt() {
    this.p++;
    return { _t: "Return", value: this.starExpressions() };
  }
  raiseStmt() {
    this.p++;
    const exc = this.expression();
    if (exc) {
      const q = this.p;
      if (this.kw("from") && !this.expression()) this.p = q;
    }
    return { _t: "Raise" };
  }
  globalStmt() {
    const m = this.p;
    this.p++;
    const names = this.gather(() => this.name());
    if (!names) {
      this.p = m;
      return null;
    }
    return { _t: "Global" };
  }
  assertStmt() {
    const m = this.p;
    this.p++;
    if (!this.expression()) {
      this.p = m;
      return null;
    }
    const q = this.p;
    if (this.op(",") && !this.expression()) this.p = q;
    return { _t: "Assert" };
  }
  delStmt() {
    const m = this.p;
    this.p++;
    const targets = this.delTargets();
    if (targets && (this.isOp(";") || this.tok.t === "NEWLINE")) return { _t: "Delete" };
    this.p = m;
    return null;
  }
  importStmt() {
    if (this.isKw("import")) {
      const m = this.p;
      this.p++;
      if (this.gather(() => this.dottedAsName())) return { _t: "Import" };
      this.p = m;
      return null;
    }
    return this.importFrom();
  }
  dottedAsName() {
    const n = this.dottedName();
    if (n === null) return null;
    const q = this.p;
    if (this.kw("as") && this.name() === null) this.p = q;
    return n;
  }
  dottedName() {
    let n = this.name();
    if (n === null) return null;
    for (; ; ) {
      const q = this.p;
      if (!this.op(".")) break;
      const part = this.name();
      if (part === null) {
        this.p = q;
        break;
      }
      n += `.${part}`;
    }
    return n;
  }
  importFrom() {
    const m = this.p;
    this.p++;
    let level = 0;
    while (this.isOp(".") || this.isOp("...")) {
      level += this.tok.v.length;
      this.p++;
    }
    const afterDots = this.p;
    const module = this.dottedName();
    if (module !== null && this.kw("import")) {
      const names = this.importFromTargets();
      if (names) {
        if (level === 0 && module === "__future__" && names.includes("barry_as_FLUFL")) this.sh.flufl = true;
        return { _t: "ImportFrom", module, names, level };
      }
    }
    this.p = afterDots;
    if (level > 0 && this.kw("import")) {
      const names = this.importFromTargets();
      if (names) return { _t: "ImportFrom", module: null, names, level };
    }
    this.p = m;
    return null;
  }
  importFromTargets() {
    const m = this.p;
    if (this.op("(")) {
      const names2 = this.importFromAsNames();
      if (names2) {
        this.op(",");
        if (this.op(")")) return names2;
      }
      this.p = m;
    }
    const names = this.importFromAsNames();
    if (names && !this.isOp(",")) return names;
    this.p = m;
    if (this.op("*")) return ["*"];
    return null;
  }
  importFromAsNames() {
    return this.gather(() => {
      const n = this.name();
      if (n === null) return null;
      const q = this.p;
      if (this.kw("as") && this.name() === null) this.p = q;
      return n;
    });
  }
  // ---------------------------------------------------------------- compound statements
  compoundStmt() {
    const t = this.tok;
    if (t.t === "OP" && t.v === "@") return this.functionDef() ?? this.classDef();
    if (t.t !== "NAME") return null;
    if (!t.kw) return t.raw === "match" ? this.matchStmt() : null;
    switch (t.raw) {
      case "def":
        return this.functionDef();
      case "async":
        return this.functionDef() ?? this.withStmt() ?? this.forStmt();
      case "if":
        return this.ifStmt();
      case "class":
        return this.classDef();
      case "with":
        return this.withStmt();
      case "for":
        return this.forStmt();
      case "try":
        return this.tryStmt();
      case "while":
        return this.whileStmt();
    }
    return null;
  }
  block() {
    return this.mem("block", () => {
      const m = this.p;
      if (this.tok.t === "NEWLINE" && this.at(1).t === "INDENT") {
        this.p += 2;
        const s = this.statements();
        if (s && this.at(0).t === "DEDENT") {
          this.p++;
          return s;
        }
        this.p = m;
      }
      return this.simpleStmts();
    });
  }
  decorators() {
    let any = false;
    for (; ; ) {
      const q = this.p;
      if (this.op("@") && this.namedExpression() && this.tok.t === "NEWLINE") {
        this.p++;
        any = true;
        continue;
      }
      this.p = q;
      return any;
    }
  }
  functionDef() {
    const m = this.p;
    this.decorators();
    const f = this.functionDefRaw();
    if (!f) this.p = m;
    return f;
  }
  functionDefRaw() {
    const m = this.p;
    let isAsync = false;
    if (this.isKw("async")) {
      this.p++;
      isAsync = true;
    }
    if (this.kw("def")) {
      const n = this.name();
      if (n !== null) {
        this.typeParams();
        if (!this.op("(")) syntaxError("expected '('");
        this.params(false);
        if (this.op(")")) {
          const q = this.p;
          if (this.op("->") && !this.expression()) this.p = q;
          if (!this.op(":")) syntaxError("expected ':'");
          const body = this.block();
          if (body) return { _t: isAsync ? "AsyncFunctionDef" : "FunctionDef", name: n, body };
        }
      }
    }
    this.p = m;
    return null;
  }
  classDef() {
    const m = this.p;
    this.decorators();
    if (this.kw("class")) {
      const n = this.name();
      if (n !== null) {
        this.typeParams();
        let bases = [];
        const q = this.p;
        if (this.op("(")) {
          const a = this.arguments();
          if (this.op(")")) bases = a?.args ?? [];
          else this.p = q;
        }
        if (this.op(":")) {
          const body = this.block();
          if (body) return { _t: "ClassDef", name: n, bases, body };
        }
      }
    }
    this.p = m;
    return null;
  }
  typeParams() {
    const m = this.p;
    if (this.op("[")) {
      const ps = this.gather(() => this.typeParam());
      if (ps) {
        this.op(",");
        if (this.op("]")) return true;
      }
      this.p = m;
    }
    return false;
  }
  typeParam() {
    return this.mem("type_param", () => {
      const m = this.p;
      if (this.name() !== null) {
        const q = this.p;
        if (this.op(":") && !this.expression()) this.p = q;
        const r = this.p;
        if (this.op("=") && !this.expression()) this.p = r;
        return true;
      }
      const star = this.isOp("*") ? "*" : this.isOp("**") ? "**" : null;
      if (star) {
        this.p++;
        if (this.name() !== null) {
          const q = this.p;
          if (this.op("=") && !(star === "*" ? this.starExpression() : this.expression())) this.p = q;
          return true;
        }
      }
      this.p = m;
      return null;
    });
  }
  ifStmt() {
    const m = this.p;
    this.p++;
    const test = this.namedExpression();
    if (test && this.op(":")) {
      const body = this.block();
      if (body) {
        const elif = this.elifStmt();
        if (elif) return { _t: "If", body, orelse: [elif] };
        return { _t: "If", body, orelse: this.elseBlock() ?? [] };
      }
    }
    this.p = m;
    return null;
  }
  elifStmt() {
    if (!this.isKw("elif")) return null;
    return this.ifStmt();
  }
  elseBlock() {
    const m = this.p;
    if (!this.kw("else")) return null;
    if (!this.op(":")) syntaxError("expected ':'");
    const b = this.block();
    if (!b) this.p = m;
    return b;
  }
  whileStmt() {
    const m = this.p;
    this.p++;
    const test = this.namedExpression();
    if (test && this.op(":")) {
      const body = this.block();
      if (body) return { _t: "While", body, orelse: this.elseBlock() ?? [] };
    }
    this.p = m;
    return null;
  }
  forStmt() {
    const m = this.p;
    const isAsync = this.kw("async");
    if (this.kw("for")) {
      const target = this.starTargets();
      if (target && this.kw("in")) {
        const iter = this.starExpressions();
        if (iter && this.op(":")) {
          const body = this.block();
          if (body) return { _t: isAsync ? "AsyncFor" : "For", body, orelse: this.elseBlock() ?? [] };
        }
      }
    }
    this.p = m;
    return null;
  }
  withStmt() {
    const m = this.p;
    const isAsync = this.kw("async");
    if (!this.kw("with")) {
      this.p = m;
      return null;
    }
    const t = isAsync ? "AsyncWith" : "With";
    const afterWith = this.p;
    if (this.op("(")) {
      const items2 = this.gather(() => this.withItem());
      if (items2) {
        this.op(",");
        if (this.op(")") && this.op(":")) {
          const body = this.block();
          if (body) return { _t: t, body };
        }
      }
      this.p = afterWith;
    }
    const items = this.gather(() => this.withItem());
    if (items && this.op(":")) {
      const body = this.block();
      if (body) return { _t: t, body };
    }
    this.p = m;
    return null;
  }
  withItem() {
    if (!this.expression()) return null;
    const q = this.p;
    if (this.kw("as") && this.starTarget() && (this.isOp(",") || this.isOp(")") || this.isOp(":"))) return true;
    this.p = q;
    return true;
  }
  tryStmt() {
    const m = this.p;
    this.p++;
    if (!this.op(":")) syntaxError("expected ':'");
    const body = this.block();
    if (body) {
      const fin = this.finallyBlock();
      if (fin) return { _t: "Try", body, handlers: [], orelse: [], finalbody: fin };
      for (const star of [false, true]) {
        const handlers = this.many(() => this.exceptBlock(star));
        if (handlers.length) {
          const orelse = this.elseBlock() ?? [];
          const finalbody = this.finallyBlock() ?? [];
          return { _t: star ? "TryStar" : "Try", body, handlers, orelse, finalbody };
        }
      }
    }
    this.p = m;
    return null;
  }
  finallyBlock() {
    const m = this.p;
    if (!this.kw("finally")) return null;
    if (!this.op(":")) syntaxError("expected ':'");
    const b = this.block();
    if (!b) this.p = m;
    return b;
  }
  exceptBlock(star) {
    const m = this.p;
    if (!this.kw("except") || star && !this.op("*")) {
      this.p = m;
      return null;
    }
    const handler = () => {
      const b = this.block();
      return b ? { _t: "ExceptHandler", body: b } : null;
    };
    const q = this.p;
    if (this.expression()) {
      const r = this.p;
      if (this.op(":")) {
        const h = handler();
        if (h) return h;
      }
      this.p = r;
      if (this.kw("as") && this.name() !== null && this.op(":")) {
        const h = handler();
        if (h) return h;
      }
      this.p = q;
      if (this.expressions() && this.op(":")) {
        const h = handler();
        if (h) return h;
      }
      this.p = q;
    }
    if (!star && this.op(":")) {
      const h = handler();
      if (h) return h;
    }
    this.p = m;
    return null;
  }
  // ---------------------------------------------------------------- match statement
  matchStmt() {
    const m = this.p;
    this.p++;
    if (this.subjectExpr() && this.op(":") && this.tok.t === "NEWLINE" && this.at(1).t === "INDENT") {
      this.p += 2;
      const cases = this.many(() => this.caseBlock());
      if (cases.length && this.at(0).t === "DEDENT") {
        this.p++;
        return { _t: "Match", cases };
      }
    }
    this.p = m;
    return null;
  }
  subjectExpr() {
    const m = this.p;
    const v = this.starNamedExpression();
    if (v && this.op(",")) return tupleNode([v, ...this.starNamedExpressions() ?? []]);
    this.p = m;
    return this.namedExpression();
  }
  caseBlock() {
    const m = this.p;
    if (!this.isSoft("case")) return null;
    this.p++;
    if (this.patterns()) {
      const q = this.p;
      if (this.kw("if") && !this.namedExpression()) this.p = q;
      if (this.op(":")) {
        const body = this.block();
        if (body) return { _t: "match_case", body };
      }
    }
    this.p = m;
    return null;
  }
  patterns() {
    const m = this.p;
    if (this.openSequencePattern()) return true;
    this.p = m;
    return this.pattern();
  }
  pattern() {
    return this.asPattern() || this.orPattern();
  }
  asPattern() {
    const m = this.p;
    if (this.orPattern() && this.kw("as") && this.patternCaptureTarget()) return true;
    this.p = m;
    return false;
  }
  orPattern() {
    return this.gather(() => this.closedPattern(), "|") !== null;
  }
  closedPattern() {
    return this.mem("closed_pattern", () => {
      const ok = this.literalPattern() || this.patternCaptureTarget() || this.wildcardPattern() || this.valuePattern() || this.groupPattern() || this.sequencePattern() || this.mappingPattern() || this.classPattern();
      return ok ? true : null;
    });
  }
  /** literal_pattern and literal_expr accept the same tokens */
  literalPattern() {
    const m = this.p;
    if (this.signedNumber() && !this.isOp("+") && !this.isOp("-")) return true;
    this.p = m;
    if (this.complexNumber()) return true;
    this.p = m;
    if (this.tok.t === "STRING" || this.tok.t === "FSTRING") return this.strings() !== null;
    if (this.isKw("None") || this.isKw("True") || this.isKw("False")) {
      this.p++;
      return true;
    }
    return false;
  }
  signedNumber() {
    if (this.tok.t === "NUMBER") {
      this.p++;
      return true;
    }
    if (this.isOp("-") && this.at(1).t === "NUMBER") {
      this.p += 2;
      return true;
    }
    return false;
  }
  complexNumber() {
    const m = this.p;
    if (this.op("-")) {
      if (!this.realNumber()) {
        this.p = m;
        return false;
      }
    } else if (!this.realNumber()) return false;
    if ((this.op("+") || this.op("-")) && this.imaginaryNumber()) return true;
    this.p = m;
    return false;
  }
  realNumber() {
    const t = this.tok;
    if (t.t !== "NUMBER") return false;
    if (t.num?.k === "complex") syntaxError("real number required in complex literal");
    this.p++;
    return true;
  }
  imaginaryNumber() {
    const t = this.tok;
    if (t.t !== "NUMBER") return false;
    if (t.num?.k !== "complex") syntaxError("imaginary number required in complex literal");
    this.p++;
    return true;
  }
  /** !"_" NAME !('.' | '(' | '=') */
  patternCaptureTarget() {
    if (this.isSoft("_")) return false;
    const m = this.p;
    if (this.name() !== null && !this.isOp(".") && !this.isOp("(") && !this.isOp("=")) return true;
    this.p = m;
    return false;
  }
  wildcardPattern() {
    if (!this.isSoft("_")) return false;
    this.p++;
    return true;
  }
  valuePattern() {
    const m = this.p;
    if (this.attr() && !this.isOp(".") && !this.isOp("(") && !this.isOp("=")) return true;
    this.p = m;
    return false;
  }
  /** NAME ('.' NAME)+ */
  attr() {
    const m = this.p;
    if (this.name() === null) return false;
    let dots = 0;
    for (; ; ) {
      const q = this.p;
      if (!this.op(".")) break;
      if (this.name() === null) {
        this.p = q;
        break;
      }
      dots++;
    }
    if (dots) return true;
    this.p = m;
    return false;
  }
  groupPattern() {
    const m = this.p;
    if (this.op("(") && this.pattern() && this.op(")")) return true;
    this.p = m;
    return false;
  }
  sequencePattern() {
    const m = this.p;
    if (this.op("[")) {
      this.maybeSequencePattern();
      if (this.op("]")) return true;
    } else if (this.op("(")) {
      const q = this.p;
      if (!this.openSequencePattern()) this.p = q;
      if (this.op(")")) return true;
    }
    this.p = m;
    return false;
  }
  openSequencePattern() {
    const m = this.p;
    if (this.maybeStarPattern() && this.op(",")) {
      this.maybeSequencePattern();
      return true;
    }
    this.p = m;
    return false;
  }
  maybeSequencePattern() {
    if (!this.gather(() => this.maybeStarPattern() ? true : null)) return false;
    this.op(",");
    return true;
  }
  maybeStarPattern() {
    return this.starPattern() || this.pattern();
  }
  starPattern() {
    const m = this.p;
    if (this.op("*") && (this.patternCaptureTarget() || this.wildcardPattern())) return true;
    this.p = m;
    return false;
  }
  mappingPattern() {
    const m = this.p;
    if (!this.op("{")) return false;
    if (this.op("}")) return true;
    const afterBrace = this.p;
    if (this.doubleStarPattern()) {
      this.op(",");
      if (this.op("}")) return true;
    }
    this.p = afterBrace;
    const items = this.gather(() => this.keyValuePattern() ? true : null);
    if (items) {
      const q = this.p;
      if (this.op(",") && this.doubleStarPattern()) {
        this.op(",");
        if (this.op("}")) return true;
      }
      this.p = q;
      this.op(",");
      if (this.op("}")) return true;
    }
    this.p = m;
    return false;
  }
  keyValuePattern() {
    const m = this.p;
    if ((this.literalPattern() || this.attr()) && this.op(":") && this.pattern()) return true;
    this.p = m;
    return false;
  }
  doubleStarPattern() {
    const m = this.p;
    if (this.op("**") && this.patternCaptureTarget()) return true;
    this.p = m;
    return false;
  }
  classPattern() {
    const m = this.p;
    if (this.dottedName() === null || !this.op("(")) {
      this.p = m;
      return false;
    }
    if (this.op(")")) return true;
    const afterParen = this.p;
    const positional = () => this.gather(() => this.pattern() ? true : null);
    const keywords = () => this.gather(() => {
      const q = this.p;
      if (this.name() !== null && this.op("=") && this.pattern()) return true;
      this.p = q;
      return null;
    });
    if (positional()) {
      this.op(",");
      if (this.op(")")) return true;
    }
    this.p = afterParen;
    if (keywords()) {
      this.op(",");
      if (this.op(")")) return true;
    }
    this.p = afterParen;
    if (positional() && this.op(",") && keywords()) {
      this.op(",");
      if (this.op(")")) return true;
    }
    this.p = m;
    return false;
  }
  // ---------------------------------------------------------------- function parameters
  /** def parameters (terminated by ')', annotations allowed) or lambda parameters (':') */
  params(lambda) {
    const m = this.p;
    const term = lambda ? ":" : ")";
    const endOk = () => this.op(",") || this.isOp(term);
    const param = () => {
      const n = this.name();
      if (n === null) return null;
      let annotation = null;
      if (!lambda) {
        const q = this.p;
        if (this.op(":")) {
          annotation = this.expression();
          if (!annotation) this.p = q;
        }
      }
      return { _t: "arg", arg: n, annotation };
    };
    const dflt = () => {
      const q = this.p;
      if (!this.op("=")) return null;
      const e = this.expression();
      if (!e) this.p = q;
      return e;
    };
    const noDefault = () => {
      const q = this.p;
      const a = param();
      if (a && endOk()) return a;
      this.p = q;
      return null;
    };
    const withDefault = () => {
      const q = this.p;
      const a = param();
      if (a) {
        const d = dflt();
        if (d && endOk()) return [a, d];
      }
      this.p = q;
      return null;
    };
    const maybeDefault = () => {
      const q = this.p;
      const a = param();
      if (a) {
        const d = dflt();
        if (endOk()) return [a, d];
      }
      this.p = q;
      return null;
    };
    const starAnnotated = () => {
      if (lambda) return null;
      const q = this.p;
      const n = this.name();
      if (n !== null && this.op(":")) {
        const annotation = this.starExpression();
        if (annotation && endOk()) return { _t: "arg", arg: n, annotation };
      }
      this.p = q;
      return null;
    };
    const kwds = () => {
      const q = this.p;
      if (this.op("**")) {
        const a = noDefault();
        if (a) return a;
      }
      this.p = q;
      return null;
    };
    const starEtc = () => {
      const q = this.p;
      if (this.op("*")) {
        const afterStar = this.p;
        for (const first of [noDefault, starAnnotated]) {
          const a = first();
          if (a) return { vararg: a, kwonly: this.many(maybeDefault), kwarg: kwds() };
          this.p = afterStar;
        }
        if (this.op(",")) {
          const kwonly = this.many(maybeDefault);
          if (kwonly.length) return { vararg: null, kwonly, kwarg: kwds() };
        }
        this.p = q;
        return null;
      }
      const k = kwds();
      return k ? { vararg: null, kwonly: [], kwarg: k } : null;
    };
    const slash = () => {
      if (this.op("/")) {
        if (this.op(",") || this.isOp(term)) return true;
      }
      return false;
    };
    const make = (posonly, posonlyDefaults, plain, withDefs, se2) => ({
      _t: "arguments",
      posonlyargs: posonly,
      args: [...plain, ...withDefs.map((d) => d[0])],
      defaults: [...posonlyDefaults, ...withDefs.map((d) => d[1])],
      vararg: se2?.vararg ?? null,
      kwonlyargs: se2?.kwonly.map((d) => d[0]) ?? [],
      kw_defaults: se2?.kwonly.map((d) => d[1]) ?? [],
      kwarg: se2?.kwarg ?? null
    });
    {
      const a = this.many(noDefault);
      if (a.length && slash()) {
        const b = this.many(noDefault);
        const c = this.many(withDefault);
        return make(a, [], b, c, starEtc());
      }
      this.p = m;
    }
    {
      const a = this.many(noDefault);
      const b = this.many(withDefault);
      if (b.length && slash()) {
        const c = this.many(withDefault);
        return make([...a, ...b.map((d) => d[0])], b.map((d) => d[1]), [], c, starEtc());
      }
      this.p = m;
    }
    {
      const a = this.many(noDefault);
      if (a.length) return make([], [], a, this.many(withDefault), starEtc());
    }
    {
      const a = this.many(withDefault);
      if (a.length) return make([], [], [], a, starEtc());
    }
    const se = starEtc();
    if (se) return make([], [], [], [], se);
    this.p = m;
    return null;
  }
  // ---------------------------------------------------------------- expressions
  expressions() {
    const a = this.expression();
    if (!a) return null;
    if (!this.isOp(",")) return a;
    const elts = [a];
    for (; ; ) {
      const q = this.p;
      if (!this.op(",")) break;
      const b = this.expression();
      if (!b) {
        this.p = q;
        break;
      }
      elts.push(b);
    }
    this.op(",");
    return tupleNode(elts);
  }
  expression() {
    return this.mem("expression", () => {
      const a = this.disjunction();
      if (a) {
        if (this.isKw("if")) {
          const q = this.p;
          this.p++;
          const test = this.disjunction();
          if (test && this.kw("else")) {
            const orelse = this.expression();
            if (orelse) return { _t: "IfExp", test, body: a, orelse };
          }
          this.p = q;
        }
        return a;
      }
      return this.lambdef();
    });
  }
  lambdef() {
    if (!this.isKw("lambda")) return null;
    const m = this.p;
    this.p++;
    const args = this.params(true) ?? {
      _t: "arguments",
      posonlyargs: [],
      args: [],
      defaults: [],
      vararg: null,
      kwonlyargs: [],
      kw_defaults: [],
      kwarg: null
    };
    if (this.op(":")) {
      const body = this.expression();
      if (body) return { _t: "Lambda", args, body };
    }
    this.p = m;
    return null;
  }
  yieldExpr() {
    if (!this.isKw("yield")) return null;
    const m = this.p;
    this.p++;
    if (this.kw("from")) {
      const value = this.expression();
      if (value) return { _t: "YieldFrom", value };
      this.p = m + 1;
    }
    return { _t: "Yield", value: this.starExpressions() };
  }
  starExpressions() {
    const a = this.starExpression();
    if (!a) return null;
    if (!this.isOp(",")) return a;
    const elts = [a];
    for (; ; ) {
      const q = this.p;
      if (!this.op(",")) break;
      const b = this.starExpression();
      if (!b) {
        this.p = q;
        break;
      }
      elts.push(b);
    }
    this.op(",");
    return tupleNode(elts);
  }
  starExpression() {
    return this.mem("star_expression", () => {
      if (this.isOp("*")) {
        const m = this.p;
        this.p++;
        const v = this.bitwiseOr();
        if (v) return { _t: "Starred", value: v };
        this.p = m;
      }
      return this.expression();
    });
  }
  starNamedExpressions() {
    const items = this.gather(() => this.starNamedExpression());
    if (items) this.op(",");
    return items;
  }
  starNamedExpression() {
    if (this.isOp("*")) {
      const m = this.p;
      this.p++;
      const v = this.bitwiseOr();
      if (v) return { _t: "Starred", value: v };
      this.p = m;
    }
    return this.namedExpression();
  }
  assignmentExpression() {
    const t = this.tok;
    if (t.t !== "NAME" || t.kw || !this.isOp(":=", 1)) return null;
    const m = this.p;
    this.p += 2;
    const value = this.expression();
    if (value) return { _t: "NamedExpr", target: nameNode(t.v), value };
    this.p = m;
    return null;
  }
  namedExpression() {
    const a = this.assignmentExpression();
    if (a) return a;
    const m = this.p;
    const e = this.expression();
    if (e && !this.isOp(":=")) return e;
    this.p = m;
    return null;
  }
  /** assignment_expression | expression !':=' */
  namedOrPlain() {
    return this.namedExpression();
  }
  disjunction() {
    return this.mem("disjunction", () => this.boolOp("or", () => this.conjunction()));
  }
  conjunction() {
    return this.mem("conjunction", () => this.boolOp("and", () => this.inversion()));
  }
  boolOp(word, sub) {
    const a = sub();
    if (!a) return null;
    const values = [a];
    while (this.isKw(word)) {
      const q = this.p;
      this.p++;
      const b = sub();
      if (!b) {
        this.p = q;
        break;
      }
      values.push(b);
    }
    return values.length > 1 ? { _t: "BoolOp", op: word, values } : a;
  }
  inversion() {
    return this.mem("inversion", () => {
      if (this.isKw("not")) {
        const m = this.p;
        this.p++;
        const operand = this.inversion();
        if (operand) return { _t: "UnaryOp", op: "not", operand };
        this.p = m;
      }
      return this.comparison();
    });
  }
  comparison() {
    const left = this.bitwiseOr();
    if (!left) return null;
    const ops = [];
    const comparators = [];
    for (; ; ) {
      const q = this.p;
      const o = this.compareOp();
      if (o === null) break;
      const b = this.bitwiseOr();
      if (!b) {
        this.p = q;
        break;
      }
      ops.push(o);
      comparators.push(b);
    }
    return ops.length ? { _t: "Compare", left, ops, comparators } : left;
  }
  compareOp() {
    const t = this.tok;
    if (t.t === "OP") {
      if (SIMPLE_CMP.has(t.v)) {
        this.p++;
        return t.v;
      }
      if (t.v === "!=") {
        if (this.sh.flufl) syntaxError("with Barry as BDFL, use '<>' instead of '!='");
        this.p++;
        return "!=";
      }
      if (t.v === "<>" && this.sh.flufl) {
        this.p++;
        return "!=";
      }
      return null;
    }
    if (t.t === "NAME" && t.kw) {
      if (t.raw === "in") {
        this.p++;
        return "in";
      }
      if (t.raw === "not" && this.isKw("in", 1)) {
        this.p += 2;
        return "not in";
      }
      if (t.raw === "is") {
        if (this.isKw("not", 1)) {
          this.p += 2;
          return "is not";
        }
        this.p++;
        return "is";
      }
    }
    return null;
  }
  binLoop(sub, ops) {
    let left = sub();
    if (!left) return null;
    for (; ; ) {
      const t = this.tok;
      if (t.t !== "OP" || !ops.has(t.v)) break;
      const q = this.p;
      this.p++;
      const right = sub();
      if (!right) {
        this.p = q;
        break;
      }
      left = { _t: "BinOp", left, op: t.v, right };
    }
    return left;
  }
  bitwiseOr() {
    return this.mem("bitwise_or", () => this.binLoop(() => this.bitwiseXor(), OR_OPS));
  }
  bitwiseXor() {
    return this.binLoop(() => this.bitwiseAnd(), XOR_OPS);
  }
  bitwiseAnd() {
    return this.binLoop(() => this.shiftExpr(), AND_OPS);
  }
  shiftExpr() {
    return this.binLoop(() => this.sum(), SHIFT_OPS);
  }
  sum() {
    return this.binLoop(() => this.term(), SUM_OPS);
  }
  term() {
    return this.binLoop(() => this.factor(), TERM_OPS);
  }
  factor() {
    return this.mem("factor", () => {
      const t = this.tok;
      if (t.t === "OP" && (t.v === "+" || t.v === "-" || t.v === "~")) {
        const m = this.p;
        this.p++;
        const operand = this.factor();
        if (operand) return { _t: "UnaryOp", op: t.v, operand };
        this.p = m;
      }
      return this.power();
    });
  }
  power() {
    const left = this.awaitPrimary();
    if (!left) return null;
    if (this.isOp("**")) {
      const q = this.p;
      this.p++;
      const right = this.factor();
      if (right) return { _t: "BinOp", left, op: "**", right };
      this.p = q;
    }
    return left;
  }
  awaitPrimary() {
    return this.mem("await_primary", () => {
      if (this.isKw("await")) {
        const m = this.p;
        this.p++;
        const value = this.primary();
        if (value) return { _t: "Await", value };
        this.p = m;
      }
      return this.primary();
    });
  }
  primary() {
    return this.mem("primary", () => {
      let a = this.atom();
      if (!a) return null;
      for (let b = this.trailer(a, false); b; b = this.trailer(a, false)) a = b;
      return a;
    });
  }
  /** One '.' NAME / genexp / '(' [arguments] ')' / '[' slices ']' step of primary or t_primary. */
  trailer(a, lookahead) {
    const q = this.p;
    const ok = () => !lookahead || this.tLookahead();
    if (this.op(".")) {
      const attr = this.name();
      if (attr !== null && ok()) return { _t: "Attribute", value: a, attr };
      this.p = q;
      return null;
    }
    if (this.isOp("(")) {
      const g = this.genexp();
      if (g && ok()) return { _t: "Call", func: a, args: [g], keywords: [] };
      this.p = q + 1;
      const args = this.arguments();
      if (this.op(")") && ok()) return { _t: "Call", func: a, args: args?.args ?? [], keywords: args?.keywords ?? [] };
      this.p = q;
      return null;
    }
    if (this.op("[")) {
      const slice = this.slices();
      if (slice && this.op("]") && ok()) return { _t: "Subscript", value: a, slice };
      this.p = q;
    }
    return null;
  }
  slices() {
    const m = this.p;
    const a = this.slice();
    if (a && !this.isOp(",")) return a;
    this.p = m;
    const items = this.gather(() => this.slice() ?? this.starredExpression());
    if (!items) return null;
    this.op(",");
    return tupleNode(items);
  }
  slice() {
    const m = this.p;
    const lower = this.expression();
    if (this.op(":")) {
      const upper = this.expression();
      let step = null;
      if (this.op(":")) step = this.expression();
      return { _t: "Slice", lower, upper, step };
    }
    this.p = m;
    return this.namedExpression();
  }
  starredExpression() {
    if (!this.isOp("*")) return null;
    const m = this.p;
    this.p++;
    const value = this.expression();
    if (value) return { _t: "Starred", value };
    this.p = m;
    return null;
  }
  atom() {
    return this.mem("atom", () => {
      const t = this.tok;
      switch (t.t) {
        case "NAME":
          if (!t.kw) {
            this.p++;
            return nameNode(t.v);
          }
          if (t.raw === "True" || t.raw === "False") {
            this.p++;
            return { _t: "Constant", cv: "bool", v: t.raw === "True", kind: null };
          }
          if (t.raw === "None") {
            this.p++;
            return { _t: "Constant", cv: "None", v: null, kind: null };
          }
          return null;
        case "STRING":
        case "FSTRING":
          return this.strings();
        case "NUMBER": {
          this.p++;
          const n = t.num;
          return { _t: "Constant", cv: n.k, v: n.v, kind: null };
        }
        case "OP":
          switch (t.v) {
            case "(":
              return this.tuple() ?? this.group() ?? this.genexp();
            case "[":
              return this.list() ?? this.listcomp();
            case "{":
              return this.dict() ?? this.set() ?? this.dictcomp() ?? this.setcomp();
            case "...":
              this.p++;
              return { _t: "Constant", cv: "Ellipsis", v: null, kind: null };
          }
      }
      return null;
    });
  }
  tuple() {
    const m = this.p;
    this.p++;
    let elts = [];
    const q = this.p;
    const a = this.starNamedExpression();
    if (a && this.op(",")) elts = [a, ...this.starNamedExpressions() ?? []];
    else this.p = q;
    if (this.op(")")) return tupleNode(elts);
    this.p = m;
    return null;
  }
  group() {
    const m = this.p;
    this.p++;
    const e = this.yieldExpr() ?? this.namedExpression();
    if (e && this.op(")")) return e;
    this.p = m;
    return null;
  }
  /** '(' (assignment_expression | expression !':=') for_if_clauses ')' */
  genexp() {
    const m = this.p;
    if (!this.op("(")) return null;
    const elt = this.namedOrPlain();
    if (elt) {
      const generators = this.forIfClauses();
      if (generators && this.op(")")) return { _t: "GeneratorExp", elt, generators };
    }
    this.p = m;
    return null;
  }
  list() {
    const m = this.p;
    this.p++;
    const elts = this.starNamedExpressions() ?? [];
    if (this.op("]")) return { _t: "List", elts };
    this.p = m;
    return null;
  }
  listcomp() {
    const m = this.p;
    this.p++;
    const elt = this.namedExpression();
    if (elt) {
      const generators = this.forIfClauses();
      if (generators && this.op("]")) return { _t: "ListComp", elt, generators };
    }
    this.p = m;
    return null;
  }
  dict() {
    const m = this.p;
    this.p++;
    const keys = [];
    const values = [];
    const items = this.gather(() => this.doubleStarredKvpair());
    if (items) {
      this.op(",");
      for (const [k, v] of items) {
        keys.push(k);
        values.push(v);
      }
    }
    if (this.op("}")) return { _t: "Dict", keys, values };
    this.p = m;
    return null;
  }
  doubleStarredKvpair() {
    if (this.isOp("**")) {
      const m = this.p;
      this.p++;
      const v = this.bitwiseOr();
      if (v) return [null, v];
      this.p = m;
    }
    return this.kvpair();
  }
  kvpair() {
    const m = this.p;
    const k = this.expression();
    if (k && this.op(":")) {
      const v = this.expression();
      if (v) return [k, v];
    }
    this.p = m;
    return null;
  }
  set() {
    const m = this.p;
    this.p++;
    const elts = this.starNamedExpressions();
    if (elts && this.op("}")) return { _t: "Set", elts };
    this.p = m;
    return null;
  }
  dictcomp() {
    const m = this.p;
    this.p++;
    const kv = this.kvpair();
    if (kv) {
      const generators = this.forIfClauses();
      if (generators && this.op("}")) return { _t: "DictComp", key: kv[0], value: kv[1], generators };
    }
    this.p = m;
    return null;
  }
  setcomp() {
    const m = this.p;
    this.p++;
    const elt = this.namedExpression();
    if (elt) {
      const generators = this.forIfClauses();
      if (generators && this.op("}")) return { _t: "SetComp", elt, generators };
    }
    this.p = m;
    return null;
  }
  forIfClauses() {
    const out = this.many(() => this.forIfClause());
    return out.length ? out : null;
  }
  forIfClause() {
    const m = this.p;
    const isAsync = this.isKw("async") && this.isKw("for", 1);
    if (isAsync) this.p++;
    if (this.kw("for")) {
      const target = this.starTargets();
      if (target && this.kw("in")) {
        const iter = this.disjunction();
        if (iter) {
          const ifs = [];
          for (; ; ) {
            const q = this.p;
            if (!this.kw("if")) break;
            const c = this.disjunction();
            if (!c) {
              this.p = q;
              break;
            }
            ifs.push(c);
          }
          return { _t: "comprehension", target, iter, ifs, is_async: isAsync };
        }
      }
    }
    this.p = m;
    return null;
  }
  // ---------------------------------------------------------------- call arguments
  arguments() {
    return this.mem("arguments", () => {
      const a = this.args();
      if (a) {
        this.op(",");
        if (this.isOp(")")) return a;
      }
      return null;
    });
  }
  args() {
    const m = this.p;
    const positional = () => {
      const s = this.starredExpression();
      if (s) return s;
      const q = this.p;
      let e = this.assignmentExpression();
      if (!e) {
        e = this.expression();
        if (e && this.isOp(":=")) e = null;
      }
      if (e && !this.isOp("=")) return e;
      this.p = q;
      return null;
    };
    const pos = this.gather(positional);
    if (pos) {
      const q = this.p;
      let kw2 = null;
      if (this.op(",")) {
        kw2 = this.kwargs();
        if (!kw2) this.p = q;
      }
      return this.splitArgs(pos, kw2 ?? []);
    }
    this.p = m;
    const kw = this.kwargs();
    return kw ? this.splitArgs([], kw) : null;
  }
  splitArgs(pos, kw) {
    return {
      args: [...pos, ...kw.filter((k) => k._t === "Starred")],
      keywords: kw.filter((k) => k._t === "keyword")
    };
  }
  kwargs() {
    const m = this.p;
    const a = this.gather(() => this.kwarg(false));
    if (a) {
      const q = this.p;
      if (this.op(",")) {
        const b = this.gather(() => this.kwarg(true));
        if (b) return [...a, ...b];
      }
      this.p = q;
      return a;
    }
    this.p = m;
    return this.gather(() => this.kwarg(true));
  }
  /** kwarg_or_starred, or kwarg_or_double_starred when double */
  kwarg(double) {
    const t = this.tok;
    if (t.t === "NAME" && !t.kw && this.isOp("=", 1)) {
      const m = this.p;
      this.p += 2;
      const value = this.expression();
      if (value) return { _t: "keyword", arg: t.v, value };
      this.p = m;
    }
    if (!double) return this.starredExpression();
    if (this.isOp("**")) {
      const m = this.p;
      this.p++;
      const value = this.expression();
      if (value) return { _t: "keyword", arg: null, value };
      this.p = m;
    }
    return null;
  }
  // ---------------------------------------------------------------- assignment targets
  starTargets() {
    const a = this.starTarget();
    if (!a) return null;
    if (!this.isOp(",")) return a;
    const elts = [a];
    for (; ; ) {
      const q = this.p;
      if (!this.op(",")) break;
      const b = this.starTarget();
      if (!b) {
        this.p = q;
        break;
      }
      elts.push(b);
    }
    this.op(",");
    return tupleNode(elts);
  }
  starTarget() {
    return this.mem("star_target", () => {
      if (this.isOp("*")) {
        this.p++;
        if (!this.isOp("*")) {
          const t = this.starTarget();
          if (t) return { _t: "Starred", value: t };
        }
        return null;
      }
      return this.targetWithStarAtom();
    });
  }
  targetWithStarAtom() {
    return this.mem("target_with_star_atom", () => this.subscriptAttributeTarget() ?? this.starAtom());
  }
  starAtom() {
    const m = this.p;
    const n = this.name();
    if (n !== null) return nameNode(n);
    if (this.op("(")) {
      const a = this.targetWithStarAtom();
      if (a && this.op(")")) return a;
      this.p = m + 1;
      const q = this.p;
      const elts = this.starTargetsTupleSeq();
      if (!elts) this.p = q;
      if (this.op(")")) return tupleNode(elts ?? []);
    } else if (this.op("[")) {
      const elts = this.gather(() => this.starTarget());
      if (elts) this.op(",");
      if (this.op("]")) return { _t: "List", elts: elts ?? [] };
    }
    this.p = m;
    return null;
  }
  starTargetsTupleSeq() {
    const m = this.p;
    const a = this.starTarget();
    if (!a) return null;
    const out = [a];
    for (; ; ) {
      const q = this.p;
      if (!this.op(",")) break;
      const b = this.starTarget();
      if (!b) {
        this.p = q;
        break;
      }
      out.push(b);
    }
    if (out.length > 1) {
      this.op(",");
      return out;
    }
    if (this.op(",")) return out;
    this.p = m;
    return null;
  }
  singleTarget() {
    const s = this.subscriptAttributeTarget();
    if (s) return s;
    const n = this.name();
    if (n !== null) return nameNode(n);
    const m = this.p;
    if (this.op("(")) {
      const t = this.singleTarget();
      if (t && this.op(")")) return t;
    }
    this.p = m;
    return null;
  }
  /** t_primary '.' NAME !t_lookahead | t_primary '[' slices ']' !t_lookahead */
  subscriptAttributeTarget() {
    const m = this.p;
    const a = this.tPrimary();
    if (a) {
      const q = this.p;
      if (this.op(".")) {
        const attr = this.name();
        if (attr !== null && !this.tLookahead()) return { _t: "Attribute", value: a, attr };
      }
      this.p = q;
      if (this.op("[")) {
        const slice = this.slices();
        if (slice && this.op("]") && !this.tLookahead()) return { _t: "Subscript", value: a, slice };
      }
    }
    this.p = m;
    return null;
  }
  tPrimary() {
    return this.mem("t_primary", () => {
      let a = this.atom();
      if (!a || !this.tLookahead()) return null;
      for (let b = this.trailer(a, true); b; b = this.trailer(a, true)) a = b;
      return a;
    });
  }
  delTargets() {
    const items = this.gather(() => this.delTarget());
    if (items) this.op(",");
    return items;
  }
  delTarget() {
    return this.mem("del_target", () => {
      const s = this.subscriptAttributeTarget();
      if (s) return s;
      const m = this.p;
      const n = this.name();
      if (n !== null) return nameNode(n);
      if (this.op("(")) {
        const a = this.delTarget();
        if (a && this.op(")")) return a;
        this.p = m + 1;
        const elts = this.delTargets();
        if (this.op(")")) return tupleNode(elts ?? []);
      } else if (this.op("[")) {
        const elts = this.delTargets();
        if (this.op("]")) return { _t: "List", elts: elts ?? [] };
      }
      this.p = m;
      return null;
    });
  }
  // ---------------------------------------------------------------- string literals
  strings() {
    return this.mem("strings", () => {
      const toks = [];
      while (this.tok.t === "STRING" || this.tok.t === "FSTRING") toks.push(this.toks[this.p++]);
      if (!toks.length) return null;
      const isT = toks.some((t) => t.tstr);
      if (isT && toks.some((t) => !t.tstr)) syntaxError("cannot mix t-string literals with string or bytes literals");
      const hasF = toks.some((t) => t.t === "FSTRING");
      if (toks.some((t) => t.bytes) && toks.some((t) => !t.bytes)) syntaxError("cannot mix bytes and nonbytes literals");
      const first = toks[0];
      if (first.bytes) return { _t: "Constant", cv: "bytes", v: toks.map((t) => t.sv).join(""), kind: null };
      if (!hasF && toks.length === 1) return strConst(first.sv, first.u ? "u" : null);
      const flat = [];
      for (const t of toks) {
        if (t.t === "STRING") flat.push(strConst(t.sv, t.u ? "u" : null));
        else this.ftParts(t.parts, flat);
      }
      const values = foldConstants(flat, hasF);
      if (!hasF) return values[0];
      return { _t: isT ? "TemplateStr" : "JoinedStr", values };
    });
  }
  ftParts(parts, out) {
    for (const part of parts) {
      if ("lit" in part) {
        if (part.lit) out.push(strConst(part.lit));
        continue;
      }
      const f = part.field;
      if (f.debug !== null) out.push(strConst(f.debug));
      out.push(this.fieldNode(f));
    }
  }
  fieldNode(f) {
    const sub = new _Parser(f.toks, this.sh);
    const value = sub.annotatedRhs();
    if (!value || sub.tok.t !== "END") syntaxError("f-string: expecting '=', or '!', or ':', or '}'");
    let format_spec = null;
    if (f.spec) {
      const flat = [];
      this.ftParts(f.spec, flat);
      format_spec = { _t: "JoinedStr", values: foldConstants(flat, true) };
    }
    if (f.interp) return { _t: "Interpolation", value, str: f.str, conversion: f.conv, format_spec };
    return { _t: "FormattedValue", value, conversion: f.conv, format_spec };
  }
};
function checkFuture(mod) {
  const body = mod.body;
  let i = 0;
  const doc = body[0];
  if (doc && doc._t === "Expr" && doc.value._t === "Constant" && doc.value.cv === "str") i = 1;
  for (; i < body.length; i++) {
    const s = body[i];
    if (s._t !== "ImportFrom" || s.level !== 0 || s.module !== "__future__") return;
    for (const feature of s.names) {
      if (FUTURE_FEATURES.has(feature)) continue;
      if (feature === "braces") syntaxError("not a chance");
      syntaxError(`future feature ${feature} is not defined`);
    }
  }
}
function stmtChildren(n) {
  switch (n._t) {
    case "Module":
    case "FunctionDef":
    case "AsyncFunctionDef":
    case "ClassDef":
    case "With":
    case "AsyncWith":
    case "ExceptHandler":
    case "match_case":
      return n.body;
    case "If":
    case "For":
    case "AsyncFor":
    case "While":
      return [...n.body, ...n.orelse];
    case "Try":
    case "TryStar":
      return [...n.body, ...n.handlers, ...n.orelse, ...n.finalbody];
    case "Match":
      return n.cases;
  }
  return [];
}
function parseModule(source) {
  let mod;
  try {
    mod = new Parser(tokenize(source), { flufl: false }).file();
  } catch (e) {
    if (e instanceof RangeError) throw new PySyntaxError("source too complex to parse");
    throw e;
  }
  checkFuture(mod);
  const imports = [];
  const queue = [mod];
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi];
    if (n._t === "ImportFrom") imports.push({ module: n.module, names: n.names, level: n.level });
    queue.push(...stmtChildren(n));
  }
  const classes = [];
  for (const s of mod.body) {
    if (s._t !== "ClassDef") continue;
    const fields = [];
    for (const st of s.body) {
      if (st._t === "AnnAssign" && st.target._t === "Name") fields.push({ name: st.target.id, annotation: st.annotation });
    }
    classes.push({ name: s.name, bases: s.bases, fields });
  }
  return { imports, classes };
}

// packages/daemon/src/blueprint/pyunparse.ts
var NAMED_EXPR = 1;
var TUPLE = 2;
var YIELD = 3;
var TEST = 4;
var OR = 5;
var AND = 6;
var NOT = 7;
var CMP = 8;
var EXPR = 9;
var BOR = 9;
var BXOR = 10;
var BAND = 11;
var SHIFT = 12;
var ARITH = 13;
var TERM = 14;
var FACTOR = 15;
var POWER = 16;
var AWAIT = 17;
var ATOM = 18;
var next = (p) => Math.min(p + 1, ATOM);
var BINOP_PRECEDENCE = {
  "+": ARITH,
  "-": ARITH,
  "*": TERM,
  "@": TERM,
  "/": TERM,
  "%": TERM,
  "<<": SHIFT,
  ">>": SHIFT,
  "|": BOR,
  "^": BXOR,
  "&": BAND,
  "//": TERM,
  "**": POWER
};
var INFSTR = "1e309";
var MAX_STR_DIGITS2 = 4300;
var MULTI_QUOTES = ['"""', "'''"];
var ALL_QUOTES = ["'", '"', '"""', "'''"];
var hex = (cp, width) => cp.toString(16).padStart(width, "0");
function unicodeEscape(c) {
  if (c === "\\") return "\\\\";
  if (c === "	") return "\\t";
  if (c === "\n") return "\\n";
  if (c === "\r") return "\\r";
  const cp = pyCodePoint(c);
  if (cp < 256) return `\\x${hex(cp, 2)}`;
  if (cp < 65536) return `\\u${hex(cp, 4)}`;
  return `\\U${hex(cp, 8)}`;
}
function bytesRepr(v) {
  const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
  let out = "b" + quote;
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "	") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (c < 32 || c >= 127) out += `\\x${hex(c, 2)}`;
    else out += ch;
  }
  return out + quote;
}
function numberText(cv, v) {
  let s = pyFloatRepr(v);
  if (cv === "complex") s = (s.endsWith(".0") ? s.slice(0, -2) : s) + "j";
  return s.replaceAll("inf", INFSTR).replaceAll("nan", `(${INFSTR}-${INFSTR})`);
}
function intText(v) {
  const s = v.toString();
  if (s.length - (s.startsWith("-") ? 1 : 0) > MAX_STR_DIGITS2) {
    throw new Error(`Exceeds the limit (${MAX_STR_DIGITS2} digits) for integer string conversion`);
  }
  return s;
}
function strLiteralHelper(string, quoteTypes, escapeSpecialWhitespace) {
  let escaped = "";
  for (const [c] of pyChars(string)) {
    if (!escapeSpecialWhitespace && (c === "\n" || c === "	")) escaped += c;
    else if (c === "\\" || !pyIsPrintable(c)) escaped += unicodeEscape(c);
    else escaped += c;
  }
  let possible = quoteTypes;
  if (escaped.includes("\n")) possible = possible.filter((q) => MULTI_QUOTES.includes(q));
  possible = possible.filter((q) => !escaped.includes(q));
  if (!possible.length) {
    const s = pyStrRepr(string);
    const quote = quoteTypes.find((q) => q.includes(s[0])) ?? s[0];
    return [s.slice(1, -1), [quote]];
  }
  if (escaped) {
    const last = escaped[escaped.length - 1];
    possible = [...possible.filter((q) => q[0] !== last), ...possible.filter((q) => q[0] === last)];
    if (possible[0][0] === last) escaped = escaped.slice(0, -1) + "\\" + last;
  }
  return [escaped, possible];
}
var Unparser = class _Unparser {
  out = [];
  precedences = /* @__PURE__ */ new Map();
  visit(node) {
    this.out = [];
    this.traverse(node);
    return this.out.join("");
  }
  setPrecedence(p, ...nodes) {
    for (const n of nodes) if (n) this.precedences.set(n, p);
  }
  write(...text) {
    this.out.push(...text);
  }
  buffered(fn) {
    const saved = this.out;
    this.out = [];
    try {
      fn();
      return this.out;
    } finally {
      this.out = saved;
    }
  }
  requireParens(p, node, body) {
    const parens = (this.precedences.get(node) ?? TEST) > p;
    if (parens) this.write("(");
    body();
    if (parens) this.write(")");
  }
  interleave(sep, f, seq) {
    seq.forEach((x, i) => {
      if (i) this.write(sep);
      f(x);
    });
  }
  itemsView(items) {
    if (items.length === 1) {
      this.traverse(items[0]);
      this.write(",");
    } else {
      this.interleave(", ", (n) => this.traverse(n), items);
    }
  }
  traverse(node) {
    switch (node._t) {
      case "Name":
        return this.write(node.id);
      case "Constant":
        return this.constant(node);
      case "NamedExpr":
        return this.requireParens(NAMED_EXPR, node, () => {
          this.setPrecedence(ATOM, node.target, node.value);
          this.traverse(node.target);
          this.write(" := ");
          this.traverse(node.value);
        });
      case "Await":
      case "Yield":
        return this.requireParens(node._t === "Await" ? AWAIT : YIELD, node, () => {
          this.write(node._t === "Await" ? "await" : "yield");
          if (node.value) {
            this.write(" ");
            this.setPrecedence(ATOM, node.value);
            this.traverse(node.value);
          }
        });
      case "YieldFrom":
        return this.requireParens(YIELD, node, () => {
          this.write("yield from ");
          this.setPrecedence(ATOM, node.value);
          this.traverse(node.value);
        });
      case "JoinedStr":
      case "TemplateStr":
        return this.ftstring(node.values, node._t === "JoinedStr" ? "f" : "t");
      case "List":
        this.write("[");
        this.interleave(", ", (n) => this.traverse(n), node.elts);
        return this.write("]");
      case "ListComp":
      case "GeneratorExp":
      case "SetComp": {
        const [open, close] = node._t === "ListComp" ? ["[", "]"] : node._t === "SetComp" ? ["{", "}"] : ["(", ")"];
        this.write(open);
        this.traverse(node.elt);
        for (const g of node.generators) this.traverse(g);
        return this.write(close);
      }
      case "DictComp":
        this.write("{");
        this.traverse(node.key);
        this.write(": ");
        this.traverse(node.value);
        for (const g of node.generators) this.traverse(g);
        return this.write("}");
      case "comprehension":
        this.write(node.is_async ? " async for " : " for ");
        this.setPrecedence(TUPLE, node.target);
        this.traverse(node.target);
        this.write(" in ");
        this.setPrecedence(next(TEST), node.iter, ...node.ifs);
        this.traverse(node.iter);
        for (const c of node.ifs) {
          this.write(" if ");
          this.traverse(c);
        }
        return;
      case "IfExp":
        return this.requireParens(TEST, node, () => {
          this.setPrecedence(next(TEST), node.body, node.test);
          this.traverse(node.body);
          this.write(" if ");
          this.traverse(node.test);
          this.write(" else ");
          this.setPrecedence(TEST, node.orelse);
          this.traverse(node.orelse);
        });
      case "Set":
        if (!node.elts.length) return this.write("{*()}");
        this.write("{");
        this.interleave(", ", (n) => this.traverse(n), node.elts);
        return this.write("}");
      case "Dict":
        this.write("{");
        this.interleave(
          ", ",
          (i) => {
            const k = node.keys[i];
            const v = node.values[i];
            if (k === null) {
              this.write("**");
              this.setPrecedence(EXPR, v);
            } else {
              this.traverse(k);
              this.write(": ");
            }
            this.traverse(v);
          },
          node.keys.map((_, i) => i)
        );
        return this.write("}");
      case "Tuple": {
        const parens = node.elts.length === 0 || (this.precedences.get(node) ?? TEST) > TUPLE;
        if (parens) this.write("(");
        this.itemsView(node.elts);
        if (parens) this.write(")");
        return;
      }
      case "UnaryOp": {
        const p = node.op === "not" ? NOT : FACTOR;
        return this.requireParens(p, node, () => {
          this.write(node.op);
          if (p !== FACTOR) this.write(" ");
          this.setPrecedence(p, node.operand);
          this.traverse(node.operand);
        });
      }
      case "BinOp": {
        const p = BINOP_PRECEDENCE[node.op];
        return this.requireParens(p, node, () => {
          const rassoc = node.op === "**";
          this.setPrecedence(rassoc ? next(p) : p, node.left);
          this.traverse(node.left);
          this.write(` ${node.op} `);
          this.setPrecedence(rassoc ? p : next(p), node.right);
          this.traverse(node.right);
        });
      }
      case "Compare":
        return this.requireParens(CMP, node, () => {
          this.setPrecedence(next(CMP), node.left, ...node.comparators);
          this.traverse(node.left);
          node.ops.forEach((o, i) => {
            this.write(` ${o} `);
            this.traverse(node.comparators[i]);
          });
        });
      case "BoolOp": {
        let p = node.op === "and" ? AND : OR;
        return this.requireParens(p, node, () => {
          this.interleave(
            ` ${node.op} `,
            (v) => {
              p = next(p);
              this.setPrecedence(p, v);
              this.traverse(v);
            },
            node.values
          );
        });
      }
      case "Attribute":
        this.setPrecedence(ATOM, node.value);
        this.traverse(node.value);
        if (node.value._t === "Constant" && (node.value.cv === "int" || node.value.cv === "bool")) this.write(" ");
        return this.write(".", node.attr);
      case "Call": {
        this.setPrecedence(ATOM, node.func);
        this.traverse(node.func);
        this.write("(");
        this.interleave(", ", (n) => this.traverse(n), [...node.args, ...node.keywords]);
        return this.write(")");
      }
      case "keyword":
        this.write(node.arg === null ? "**" : `${node.arg}=`);
        return this.traverse(node.value);
      case "Subscript":
        this.setPrecedence(ATOM, node.value);
        this.traverse(node.value);
        this.write("[");
        if (node.slice._t === "Tuple" && node.slice.elts.length) this.itemsView(node.slice.elts);
        else this.traverse(node.slice);
        return this.write("]");
      case "Starred":
        this.write("*");
        this.setPrecedence(EXPR, node.value);
        return this.traverse(node.value);
      case "Slice":
        if (node.lower) this.traverse(node.lower);
        this.write(":");
        if (node.upper) this.traverse(node.upper);
        if (node.step) {
          this.write(":");
          this.traverse(node.step);
        }
        return;
      case "Lambda":
        return this.requireParens(TEST, node, () => {
          this.write("lambda");
          const buffer = this.buffered(() => this.traverse(node.args));
          if (buffer.length) this.write(" ", ...buffer);
          this.write(": ");
          this.setPrecedence(TEST, node.body);
          this.traverse(node.body);
        });
      case "arguments":
        return this.args(node);
      case "arg":
        this.write(node.arg);
        if (node.annotation) {
          this.write(": ");
          this.traverse(node.annotation);
        }
        return;
    }
    throw new Error(`unparse: unexpected node ${node._t}`);
  }
  constant(node) {
    switch (node.cv) {
      case "Ellipsis":
        return this.write("...");
      case "str":
        return this.write(node.kind === "u" ? "u" : "", pyStrRepr(node.v));
      case "bytes":
        return this.write(bytesRepr(node.v));
      case "int":
        return this.write(intText(node.v));
      case "float":
      case "complex":
        return this.write(numberText(node.cv, node.v));
      case "bool":
        return this.write(node.v ? "True" : "False");
      case "None":
        return this.write("None");
    }
    throw new Error(`unparse: unexpected constant ${node.cv}`);
  }
  args(node) {
    let first = true;
    const sep = () => {
      if (first) first = false;
      else this.write(", ");
    };
    const all = [...node.posonlyargs, ...node.args];
    const defaults = [...Array(all.length - node.defaults.length).fill(null), ...node.defaults];
    all.forEach((a, i) => {
      sep();
      this.traverse(a);
      const d = defaults[i];
      if (d) {
        this.write("=");
        this.traverse(d);
      }
      if (i + 1 === node.posonlyargs.length) this.write(", /");
    });
    if (node.vararg || node.kwonlyargs.length) {
      sep();
      this.write("*");
      if (node.vararg) {
        this.write(node.vararg.arg);
        if (node.vararg.annotation) {
          this.write(": ");
          this.traverse(node.vararg.annotation);
        }
      }
    }
    node.kwonlyargs.forEach((a, i) => {
      this.write(", ");
      this.traverse(a);
      const d = node.kw_defaults[i];
      if (d) {
        this.write("=");
        this.traverse(d);
      }
    });
    if (node.kwarg) {
      sep();
      this.write("**" + node.kwarg.arg);
      if (node.kwarg.annotation) {
        this.write(": ");
        this.traverse(node.kwarg.annotation);
      }
    }
  }
  // ------------------------------------------------------------- f-strings and t-strings
  ftstring(values, prefix) {
    this.write(prefix);
    const parts = values.map((v) => [this.buffered(() => this.ftstringInner(v, false)).join(""), v._t === "Constant"]);
    this.ftstringHelper(parts);
  }
  ftstringInner(node, isFormatSpec) {
    if (node._t === "JoinedStr") {
      for (const v of node.values) this.ftstringInner(v, isFormatSpec);
    } else if (node._t === "Constant" && node.cv === "str") {
      let value = node.v.replaceAll("{", "{{").replaceAll("}", "}}");
      if (isFormatSpec) {
        value = value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll('"', '\\"').replaceAll("\n", "\\n");
      }
      this.write(value);
    } else if (node._t === "FormattedValue" || node._t === "Interpolation") {
      this.interpolation(node, node._t === "Interpolation" && node.str !== null);
    } else {
      throw new Error(`Unexpected node inside JoinedStr, ${node._t}`);
    }
  }
  interpolation(node, useStrAttr) {
    this.write("{");
    let expr;
    if (useStrAttr) {
      expr = node.str;
    } else {
      const inner = new _Unparser();
      inner.setPrecedence(next(TEST), node.value);
      expr = inner.visit(node.value);
    }
    if (expr.startsWith("{")) this.write(" ");
    this.write(expr);
    if (node.conversion !== -1) this.write("!" + String.fromCharCode(node.conversion));
    if (node.format_spec) {
      this.write(":");
      this.ftstringInner(node.format_spec, true);
    }
    this.write("}");
  }
  ftstringHelper(parts) {
    const newParts = [];
    let quoteTypes = [...ALL_QUOTES];
    let fallbackToRepr = false;
    for (const [part, isConstant] of parts) {
      let value = part;
      if (isConstant) {
        const [escaped, newQuoteTypes] = strLiteralHelper(value, quoteTypes, true);
        value = escaped;
        if (newQuoteTypes.every((q) => !quoteTypes.includes(q))) {
          fallbackToRepr = true;
          break;
        }
        quoteTypes = newQuoteTypes;
      } else {
        if (value.includes("\n")) {
          quoteTypes = quoteTypes.filter((q) => MULTI_QUOTES.includes(q));
          if (!quoteTypes.length) throw new Error("AssertionError");
        }
        const newQuoteTypes = quoteTypes.filter((q) => !value.includes(q));
        if (newQuoteTypes.length) quoteTypes = newQuoteTypes;
      }
      newParts.push(value);
    }
    if (fallbackToRepr) {
      quoteTypes = ["'''"];
      newParts.length = 0;
      for (const [value, isConstant] of parts) newParts.push(isConstant ? pyStrRepr('"' + value).slice(2, -1) : value);
    }
    this.write(quoteTypes[0], newParts.join(""), quoteTypes[0]);
  }
};
function unparse(node) {
  return new Unparser().visit(node);
}

// packages/daemon/src/blueprint/scan.ts
function rel(p, root) {
  return relTo(p, root);
}
function pathKey(p) {
  const n = normPath(p);
  return IS_WIN ? n.toLowerCase() : n;
}
var PathSet = class {
  s = /* @__PURE__ */ new Set();
  has(p) {
    return this.s.has(pathKey(p));
  }
  add(p) {
    this.s.add(pathKey(p));
  }
};
function pathIn(list, p) {
  return list.some((x) => samePath(x, p));
}
function replaceAll(s, from, to) {
  return s.split(from).join(to);
}
function lastPart(s, sep) {
  const parts = s.split(sep);
  return parts[parts.length - 1];
}
function firstLine(s) {
  const lines = pySplitlines(s);
  if (!lines.length) throw new RangeError("list index out of range");
  return lines[0];
}
var R = String.raw;
function detectTechStack(root) {
  const stack = [];
  const frameworks = [];
  let projectType = "Standard Repository";
  const pJson = pjoin(root, "package.json");
  const pnpmWs = pjoin(root, "pnpm-workspace.yaml");
  let isMonorepo = false;
  const pkgFiles = exists(pJson) ? [pJson] : [];
  for (const subPj of iterRepoFiles(root, "**/package.json", 25)) {
    if (!pathIn(pkgFiles, subPj)) pkgFiles.push(subPj);
  }
  if (pkgFiles.length > 1 || exists(pnpmWs) || isDir(pjoin(root, "backend")) && isDir(pjoin(root, "frontend"))) {
    projectType = "Multi-Service / Full-Stack Repository";
  }
  for (const pj of pkgFiles) {
    try {
      const data = loads(readCode(pj));
      if (samePath(pj, pJson) && (truthy(pyGet(data, "workspaces")) || exists(pnpmWs))) {
        isMonorepo = true;
        projectType = "Monorepo (Workspaces)";
      }
      const deps = mergeDicts(orDict(pyGet(data, "dependencies")), orDict(pyGet(data, "devDependencies")));
      const depKeys = new Set(Array.from(deps.keys(), (k) => k.toLowerCase()));
      if (depKeys.has("next")) frameworks.push("Next.js");
      if (depKeys.has("react") || depKeys.has("react-dom")) frameworks.push("React");
      if (depKeys.has("vue") || depKeys.has("nuxt")) frameworks.push("Vue / Nuxt");
      if (depKeys.has("electron")) frameworks.push("Electron");
      if (depKeys.has("@tauri-apps/api") || depKeys.has("@tauri-apps/cli")) frameworks.push("Tauri");
      if (depKeys.has("vite")) frameworks.push("Vite");
      if (depKeys.has("tailwindcss")) frameworks.push("TailwindCSS");
      if (depKeys.has("express")) frameworks.push("Express");
      if (depKeys.has("fastify")) frameworks.push("Fastify");
      if (depKeys.has("socket.io") || depKeys.has("socket.io-client")) frameworks.push("Socket.IO");
      if (depKeys.has("@modelcontextprotocol/sdk")) frameworks.push("Model Context Protocol (MCP)");
      stack.push("TypeScript/JavaScript");
    } catch {
    }
  }
  const pyManifests = [
    ...exists(pjoin(root, "pyproject.toml")) ? [pjoin(root, "pyproject.toml")] : [],
    ...exists(pjoin(root, "requirements.txt")) ? [pjoin(root, "requirements.txt")] : [],
    ...iterRepoFiles(root, "**/pyproject.toml", 15),
    ...iterRepoFiles(root, "**/requirements*.txt", 15)
  ];
  const pyFiles = iterRepoFiles(root, "**/*.py", 20);
  if (pyManifests.length || pyFiles.length) {
    stack.push("Python");
    let pyBlob = uniqPaths(pyManifests).map((m) => readCode(m, 5e4).toLowerCase()).join("\n");
    if (pyLen(pyBlob) < 200 && pyFiles.length) {
      pyBlob += "\n" + pyFiles.slice(0, 8).map((pf) => readCode(pf, 8e3).toLowerCase()).join("\n");
    }
    if (pyBlob.includes("fastapi")) frameworks.push("FastAPI");
    if (pyBlob.includes("flask")) frameworks.push("Flask");
    if (pyBlob.includes("django")) frameworks.push("Django");
    if (pyBlob.includes("sqlalchemy") || pyBlob.includes("sqlmodel")) frameworks.push("SQLAlchemy");
    if (pyBlob.includes("celery")) frameworks.push("Celery");
    if (pyBlob.includes("pydantic")) frameworks.push("Pydantic");
    if (pyBlob.includes("alembic")) frameworks.push("Alembic");
    if (pyBlob.includes("tqsdk")) frameworks.push("TqSdk (Futures Quant)");
    if (pyBlob.includes("rdkit")) frameworks.push("RDKit (Cheminformatics)");
    if (pyBlob.includes("socketio") || pyBlob.includes("engineio")) frameworks.push("Socket.IO");
  }
  const cargoFiles = [
    ...exists(pjoin(root, "Cargo.toml")) ? [pjoin(root, "Cargo.toml")] : [],
    ...iterRepoFiles(root, "**/Cargo.toml", 10)
  ];
  if (cargoFiles.length || iterRepoFiles(root, "**/*.rs", 5).length) {
    stack.push("Rust");
    const cargoBlob = cargoFiles.map((cf) => readCode(cf, 3e4).toLowerCase()).join("\n");
    if (cargoBlob.includes("tauri")) frameworks.push("Tauri");
    if (cargoBlob.includes("axum")) frameworks.push("Axum");
    if (cargoBlob.includes("actix-web")) frameworks.push("Actix Web");
  }
  if (exists(pjoin(root, "go.mod")) || iterRepoFiles(root, "**/go.mod", 5).length || iterRepoFiles(root, "**/*.go", 5).length) {
    stack.push("Go");
  }
  if (!stack.length && iterRepoFiles(root, "**/*.[tj]s*", 5).length) stack.push("TypeScript/JavaScript");
  if (iterRepoFiles(root, "**/*.sh", 5).length) stack.push("Shell / Bash");
  if (exists(pjoin(root, "Dockerfile")) || exists(pjoin(root, "docker-compose.yml")) || exists(pjoin(root, "docker-compose.yaml")) || iterRepoFiles(root, "**/Dockerfile*", 10).length || iterRepoFiles(root, "**/dockerfile*", 10).length) {
    frameworks.push("Docker");
  }
  if (isDir(pjoin(root, "deploy", "k8s")) || isDir(pjoin(root, "k8s")) || iterRepoFiles(root, "**/k8s/*.y*ml", 5).length) {
    frameworks.push("Kubernetes / Fleet");
  }
  return {
    project_type: projectType,
    is_monorepo: isMonorepo,
    languages: uniq(stack),
    frameworks: uniq(frameworks)
  };
}
var README_BOILERPLATE = [
  "this template should help get you started",
  "getting started with create react app",
  "a new flutter project",
  "welcome to your new",
  "bootstrapped with",
  "create-next-app",
  "react + typescript + vite",
  "vue 3 + typescript + vite",
  "recommended ide setup"
];
var README_NAMES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "README.zh-CN.md",
  "README_zh.md",
  "README.markdown",
  "README.rst",
  "README.txt",
  "README"
];
var ABOUT_MAX_CHARS = 200;
function plainMarkdown(line) {
  let text = reSub(R`!\[[^\]]*\]\([^)]*\)`, "", line);
  text = reSub(R`\[([^\]]*)\]\([^)]*\)`, R`\1`, text);
  text = reSub(R`<[^>]+>`, "", text);
  text = reSub(R`(\*\*|__|\*|${"`"})`, "", text);
  return pyStrip(reSub(R`\s+`, " ", text));
}
var SENTENCE_ENDS = ["。", "！", "？", ".", "!", "?", "；", ";"];
function readmeAbout(text) {
  const paragraphs = [];
  let current = [];
  let inFence = false;
  for (const raw of pySplitlines(text)) {
    let line = pyStrip(raw);
    if (startsWithAny(line, ["```", "~~~"])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith(">")) {
      line = pyStrip(pyLstrip(line, "> "));
      if (line.startsWith("[!")) line = "";
    }
    const skip = !line || startsWithAny(line, ["#", "<", "|", "![", "[![", "- ", "* ", "+ ", "===", "---", "***"]) || reMatch(R`^\d+[.)]\s`, line) !== null || reFindall(R`\]\(`, line).length >= 2;
    const plain = skip ? "" : plainMarkdown(line);
    if (!plain || pyLen(reSub(R`[\W_]`, "", plain)) < 4) {
      if (current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      if (line.startsWith("#") && paragraphs.length) break;
      continue;
    }
    const low = plain.toLowerCase();
    if (README_BOILERPLATE.some((bp) => low.includes(bp))) return "";
    current.push(plain);
    if (paragraphs.length >= 2) break;
  }
  if (current.length) paragraphs.push(current.join(" "));
  let about = "";
  for (const para of paragraphs.slice(0, 2)) {
    if (about && pyLen(about) >= 60) break;
    const sep = !about ? "" : endsWithAny(about, SENTENCE_ENDS) ? "" : "。";
    about = about ? `${about}${sep}${para}` : para;
  }
  return about;
}
function clipSentence(text, limit = ABOUT_MAX_CHARS) {
  if (pyLen(text) <= limit) return text;
  const head = pySlice(text, 0, limit);
  const cpIndex = (unitIndex) => unitIndex < 0 ? -1 : pyLen(head.slice(0, unitIndex));
  const cut = Math.max(...["。", "！", "？", "；", ". ", "! ", "? "].map((ch) => cpIndex(head.lastIndexOf(ch))));
  if (cut >= Math.floor(limit / 2)) return pyRstrip(pySlice(head, 0, cut + 1));
  return pyRstrip(head) + "…";
}
var DESCRIPTION_RE = R`^description\s*=\s*["\']([^"\']+)["\']`;
function detectProjectAbout(root) {
  for (const name of README_NAMES) {
    const rm = pjoin(root, name);
    if (isFile(rm)) {
      const about = readmeAbout(readCode(rm, 8e3));
      if (about) return clipSentence(sanitizeBlueprintText(about));
      break;
    }
  }
  const pj = pjoin(root, "package.json");
  if (isFile(pj)) {
    try {
      const desc = pyGet(loads(readCode(pj, 5e4)), "description");
      if (typeof desc === "string" && pyStrip(desc)) return clipSentence(sanitizeBlueprintText(plainMarkdown(desc)));
    } catch {
    }
  }
  for (const [manifest, section] of [
    ["pyproject.toml", "project"],
    ["pyproject.toml", "tool.poetry"],
    ["Cargo.toml", "package"]
  ]) {
    const mf = pjoin(root, manifest);
    if (!isFile(mf)) continue;
    const body = reSearch(R`^\[${reEscape(section)}\]\s*$([\s\S]*?)(?=^\[|\Z)`, readCode(mf, 5e4), { m: true });
    const m = body ? reSearch(DESCRIPTION_RE, body.g(1), { m: true }) : null;
    if (m && pyStrip(m.g(1))) return clipSentence(sanitizeBlueprintText(pyStrip(m.g(1))));
  }
  for (const name of ["README.md", "overview.md", "architecture.md", "index.md", "intro.md"]) {
    const doc = pjoin(root, "docs", name);
    if (isFile(doc)) {
      const about = readmeAbout(readCode(doc, 8e3));
      if (about) return clipSentence(sanitizeBlueprintText(about));
    }
  }
  return "";
}
var ROLE_MAP = {
  backend: ["Backend API Service", "Backend API server, domain business logic, and data access layer"],
  server: ["Backend API Service", "Backend service, HTTP/WebSocket handlers, and persistence"],
  api: ["API Layer", "REST / RPC API routers and request handlers"],
  src: ["Core Source Package", "Primary application source code, API handlers, and domain engines"],
  frontend: ["Frontend Web App", "Web frontend user interface, state management, and components"],
  web: ["Frontend Web App", "Browser web interface, interactive views, and client assets"],
  mobile: ["Mobile Application", "Cross-platform mobile client application"],
  client: ["Frontend Client", "Client-side application views and API integration"],
  desktop: ["Desktop Application", "Cross-platform desktop client application (Electron / Tauri)"],
  "src-tauri": ["Rust Native Core", "Tauri Rust native backend, system tray, and OS integration"],
  quant: ["Quant Trading Core", "Quantitative strategy execution, market data feed, and order routing"],
  research: ["Quant Research & Alpha", "Factor mining, backtesting experiments, and quantitative research scripts"],
  market_data: ["Market Data Pipeline", "Historical and real-time market quote ingestion and storage"],
  engineio: ["Real-Time Transport", "Socket.IO / Engine.IO bidirectional real-time event transport"],
  scripts: ["Automation & CLI Scripts", "Data loading, maintenance, operational CLI, and automation utilities"],
  "ci-scripts": ["CI/CD Automation", "Continuous integration build, packaging, and verification scripts"],
  docker: ["Container Infrastructure", "Dockerfiles, container entrypoints, and environment build configs"],
  deploy: ["Infrastructure & Deployment", "Kubernetes manifests, GitOps configs, and service deployment definitions"],
  k8s: ["Kubernetes Manifests", "Kubernetes Deployments, Services, Ingresses, and ConfigMaps"],
  docs: ["Architecture & Docs", "Technical specifications, runbooks, and design documentation"],
  tests: ["Test Suites", "Automated unit, integration, and end-to-end verification suites"],
  test: ["Test Suites", "Automated unit and integration verification suites"]
};
var DOCSTRING_RE = R`^(?:#![^\n]*\n)?\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')`;
function inferDirRoleAndDesc(d) {
  const name = pname(d);
  const nameLow = name.toLowerCase();
  const [role, defaultDesc] = Object.prototype.hasOwnProperty.call(ROLE_MAP, nameLow) ? ROLE_MAP[nameLow] : ["Core Module", `${name} domain module`];
  const pj = pjoin(d, "package.json");
  if (exists(pj)) {
    try {
      const pdata = loads(readCode(pj, 2e4));
      const desc = pyGet(pdata, "description");
      if (typeof desc === "string" && pyStrip(desc)) return [role, pySlice(pyStrip(desc), 0, 120)];
    } catch {
    }
  }
  const pp = pjoin(d, "pyproject.toml");
  if (exists(pp)) {
    const m = reSearch(DESCRIPTION_RE, readCode(pp, 2e4), { m: true });
    if (m && pyStrip(m.g(1))) return [role, pySlice(pyStrip(m.g(1)), 0, 120)];
  }
  for (const rmName of ["README.md", "readme.md"]) {
    const rm = pjoin(d, rmName);
    if (exists(rm)) {
      for (const line of pySplitlines(readCode(rm, 4e3))) {
        const sline = pyStrip(line);
        if (sline && !startsWithAny(sline, ["#", "!", "[", ">", "`", "-"])) {
          const low = sline.toLowerCase();
          if (README_BOILERPLATE.some((bp) => low.includes(bp))) break;
          return [role, pySlice(sline, 0, 120)];
        }
      }
    }
  }
  const entryCandidates = [
    pjoin(d, "main.py"),
    pjoin(d, "app.py"),
    pjoin(d, "server.py"),
    pjoin(d, "__init__.py"),
    pjoin(d, "app", "main.py"),
    pjoin(d, "src", "index.ts"),
    pjoin(d, "src", "main.ts")
  ];
  if (nameLow === "src") {
    for (const child of sortedPaths(iterdir(d))) {
      if (isDir(child) && !startsWithAny(pname(child), ["_", "."])) {
        entryCandidates.push(pjoin(child, "__init__.py"), pjoin(child, "main.py"), pjoin(child, "cli.py"), pjoin(child, "api", "app.py"));
      }
    }
  }
  for (const ep of entryCandidates) {
    if (isFile(ep)) {
      const txt = readCode(ep, 3e3);
      const dm = reMatch(DOCSTRING_RE, txt);
      if (dm && pyStrip(dm.g(1))) {
        const first = pyStrip(firstLine(pyStrip(dm.g(1))));
        if (first) return [role, pySlice(first, 0, 120)];
      }
    }
  }
  return [role, defaultDesc];
}
var IDE_TAGS = [
  "@time",
  "@author",
  "@file",
  "@software",
  "@project",
  "@date",
  "@version",
  "@contact",
  "@license",
  "copyright",
  "coding:",
  "-*-",
  "do have a faith",
  "all rights reserved"
];
var IDE_HEADER_TAGS = ["@time", "@author", "@file", "@software"];
function rootFileDoc(txt) {
  let doc = "";
  const dm = reMatch(DOCSTRING_RE, txt);
  if (dm && pyStrip(dm.g(1))) {
    const rawBlock = pyStrip(dm.g(1));
    const lowBlock = rawBlock.toLowerCase();
    const isIdeHeader = IDE_HEADER_TAGS.some((t) => lowBlock.includes(t));
    for (const dline of pySplitlines(rawBlock)) {
      let sd = pyLstrip(pyStrip(dline), "*#- ");
      if (!sd || startsWithAny(sd.toLowerCase(), IDE_TAGS)) continue;
      if (startsWithAny(sd.toLowerCase(), ["@description", "@desc"])) {
        sd = pyStrip(reSub(R`^@[a-zA-Z]+\s*[:：]?\s*`, "", sd));
        if (pyLen(sd) > 4) doc = sd;
        break;
      }
      if (!isIdeHeader && pyLen(sd) > 4) {
        doc = sd;
        break;
      }
    }
  }
  if (!doc) {
    const head = pySlice(txt, 0, 600).toLowerCase();
    const hasIdeComments = IDE_HEADER_TAGS.some((t) => head.includes(t));
    for (const cline of pySplitlines(txt).slice(0, 12)) {
      const scline = pyStrip(cline);
      const low = scline.toLowerCase();
      if (scline.startsWith("#!") || IDE_TAGS.some((tag) => low.includes(tag))) continue;
      if (startsWithAny(scline, ["#", "//"])) {
        let cand = pyStrip(pyLstrip(scline, "#/ "));
        if (startsWithAny(cand.toLowerCase(), ["@description", "@desc"])) {
          cand = pyStrip(reSub(R`^@[a-zA-Z]+\s*[:：]?\s*`, "", cand));
          if (pyLen(cand) > 4) doc = cand;
          break;
        }
        if (!hasIdeComments && pyLen(cand) > 4 && !startsWithAny(cand.toLowerCase(), IDE_TAGS)) {
          doc = cand;
          break;
        }
      }
    }
  }
  return doc;
}
var SUPPORT_NAMES = /* @__PURE__ */ new Set(["docs", "doc", "scripts", "script", "tests", "test", "docker", "deploy", "k8s", "ci-scripts", "ci"]);
var SUPPORT_TYPES = /* @__PURE__ */ new Set([
  "Architecture & Docs",
  "Automation & CLI Scripts",
  "Test Suites",
  "Container Infrastructure",
  "Infrastructure & Deployment",
  "CI/CD & Build Scripts",
  "Documentation",
  "Data / Config Asset"
]);
function subPriority(s) {
  const sname = s.name.toLowerCase();
  if (SUPPORT_NAMES.has(sname) || SUPPORT_TYPES.has(s.type)) return 2;
  if (["research", "notebooks", "examples", "benchmarks"].includes(sname) || s.type.includes("Research") || s.description.startsWith("Root-level ")) {
    return 1;
  }
  return 0;
}
function scanSubsystems(root) {
  const subsystems = [];
  const seenPaths = /* @__PURE__ */ new Set();
  const appsDir = pjoin(root, "apps");
  const pkgsDir = pjoin(root, "packages");
  if (isDir(appsDir) || isDir(pkgsDir)) {
    for (const [dir, prefix, type, suffix] of [
      [appsDir, "apps", "Application", "application"],
      [pkgsDir, "packages", "Package / Service", "package"]
    ]) {
      if (!isDir(dir)) continue;
      for (const d of sortedPaths(iterdir(dir))) {
        const dn = pname(d);
        if (isDir(d) && !IGNORED_DIRS.has(dn) && !dn.startsWith(".")) {
          const [, desc] = inferDirRoleAndDesc(d);
          const relPath = rel(d, root);
          seenPaths.add(relPath);
          subsystems.push({
            name: `${prefix}/${dn}`,
            path: relPath,
            type,
            description: desc !== `${dn} domain module` ? desc : `${dn} ${suffix}`
          });
        }
      }
    }
    for (const [fixedName, fixedType, fixedDesc] of [
      ["server", "Backend API Service", "FastAPI backend services, database models, background Celery workers"],
      ["embedding", "Embedding Microservice", "Vector embedding & semantic indexing service"],
      ["deploy", "Infrastructure & Deployment", "Kubernetes kustomization manifests, Fleet GitOps configs, systemd services"]
    ]) {
      if (isDir(pjoin(root, fixedName)) && !seenPaths.has(fixedName)) {
        seenPaths.add(fixedName);
        subsystems.push({ name: fixedName, path: fixedName, type: fixedType, description: fixedDesc });
      }
    }
    return subsystems;
  }
  const skipDirs = /* @__PURE__ */ new Set([...IGNORED_DIRS, "backups", "uploads", "templates", "assets", "public", "static", "results", "output", "outputs", "artifacts"]);
  const entries = sortedPaths(iterdir(root));
  for (const d of entries) {
    const dn = pname(d);
    if (isDir(d) && !skipDirs.has(dn) && !dn.startsWith(".")) {
      const [role, desc] = inferDirRoleAndDesc(d);
      subsystems.push({ name: dn, path: dn, type: role, description: desc });
      if (isDir(pjoin(d, "src-tauri"))) {
        const [tRole, tDesc] = inferDirRoleAndDesc(pjoin(d, "src-tauri"));
        subsystems.push({ name: `${dn}/src-tauri`, path: `${dn}/src-tauri`, type: tRole, description: tDesc });
      }
    }
  }
  for (const f of sortedPaths(iterdir(root))) {
    const fn = pname(f);
    if (isFile(f) && [".py", ".ts", ".js"].includes(psuffix(f)) && !startsWithAny(fn, ["_", "test_"]) && fn !== "setup.py" && fn !== "conftest.py" && !endsWithAny(fn, [".config.js", ".config.ts"])) {
      const doc = rootFileDoc(readCode(f, 3e3));
      const stem = pstem(f);
      const role = ["server", "app", "main", "api"].includes(stem) ? "Backend / Web Entrypoint" : "Core Engine Module";
      subsystems.push({
        name: fn,
        path: fn,
        type: role,
        description: doc ? pySlice(doc, 0, 110) : `Root-level ${role.toLowerCase()} (${fn})`
      });
    }
  }
  if (!subsystems.length) {
    for (const f of sortedPaths(iterdir(root))) {
      const fn = pname(f);
      if (isFile(f) && !fn.startsWith(".") && !["PROJECT_BLUEPRINT.md", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(fn)) {
        const role = fn.toLowerCase().startsWith("readme") ? "Documentation" : "Data / Config Asset";
        subsystems.push({ name: fn, path: fn, type: role, description: `Repository ${role.toLowerCase()} (${fn})` });
      }
    }
  }
  return subsystems.map((s, i) => ({ s, i, p: subPriority(s), n: s.name.toLowerCase() })).sort((a, b) => a.p - b.p || cmpStr(a.n, b.n) || a.i - b.i).map((x) => x.s);
}
function scanFrontendRoutes(root) {
  const routes = [];
  const candidates = [pjoin(root, "apps", "web", "src", "app"), pjoin(root, "web", "src", "app"), pjoin(root, "src", "app"), pjoin(root, "app")];
  const appDir = candidates.find((c) => isDir(c));
  if (appDir) {
    for (const pageFile of sortedPaths(pglob(appDir, "**/page.[tj]s*"))) {
      const r = relTo(pparent(pageFile), appDir);
      let routePath = r === "." ? "/" : `/${r}`;
      routePath = reSub(R`/\([^)]+\)`, "", routePath) || "/";
      routes.push(routePath);
    }
  }
  for (const pagesCand of [pjoin(root, "apps", "web", "src", "pages"), pjoin(root, "src", "pages"), pjoin(root, "pages")]) {
    if (!isDir(pagesCand)) continue;
    for (const pf of [...sortedPaths(pglob(pagesCand, "**/*.[tvj]s*")), ...sortedPaths(pglob(pagesCand, "**/*.vue"))]) {
      if (pstem(pf).startsWith("_") || pname(pparent(pf)) === "api") continue;
      const r = withoutSuffix(relTo(pf, pagesCand));
      const rpath = "/" + pyLstrip(replaceAll(r, "/index", ""), "/");
      routes.push(rpath || "/");
    }
  }
  if (!routes.length) {
    for (const rf of [...iterRepoFiles(root, "**/*router*.[tj]s*", 15), ...iterRepoFiles(root, "**/*routes*.[tj]s*", 15)]) {
      try {
        const content = readTextIgnore(rf);
        for (const pm of reFinditer(R`\bpath\s*:\s*["\'](/[^"\']*)["\']`, content)) routes.push(pm.g(1));
      } catch {
      }
    }
  }
  return sortedStr(uniq(routes));
}
function route(name, file, prefix, endpoints) {
  return { name, file, prefix, endpoints: endpoints.slice(0, 5), total: endpoints.length };
}
function joinRoute(prefix, sub) {
  return pyRstrip(`${pyRstrip(prefix, "/")}/${pyLstrip(sub, "/")}`, "/") || "/";
}
function scanApiRoutes(root) {
  const routes = [];
  const seenFiles = new PathSet();
  const mountedPrefixes = /* @__PURE__ */ new Map();
  for (const initCand of [...iterRepoFiles(root, "**/api/**/*.py", 40), ...iterRepoFiles(root, "**/routers/**/*.py", 40)]) {
    const initTxt = readCode(initCand, 3e4);
    if (!initTxt.includes("include_router(")) continue;
    const varToMod = /* @__PURE__ */ new Map();
    for (const im of reFinditer(R`from\s+\.?([a-zA-Z0-9_.]+)\s+import\s+router\s+as\s+([a-zA-Z0-9_]+)`, initTxt)) {
      varToMod.set(im.g(2), lastPart(im.g(1), "."));
    }
    for (const im2 of reFinditer(R`from\s+\.?([a-zA-Z0-9_.]+)\s+import\s+([a-zA-Z0-9_]+)`, initTxt)) {
      if (!varToMod.has(im2.g(2))) varToMod.set(im2.g(2), lastPart(im2.g(1), "."));
    }
    for (const inc of reFinditer(R`include_router\(\s*([a-zA-Z0-9_.]+)\s*[^)]*?prefix\s*=\s*["\']([^"\']+)["\']`, initTxt)) {
      const rvar = inc.g(1);
      const pfx = inc.g(2);
      const modName = rvar.includes(".") ? rvar.split(".")[0] : varToMod.get(rvar) ?? replaceAll(rvar, "_router", "");
      if (modName && pfx) mountedPrefixes.set(modName, pfx);
    }
  }
  const pyApiFiles = [];
  for (const rootPy of ["server.py", "app.py", "main.py", "api.py"]) {
    const rp = pjoin(root, rootPy);
    if (isFile(rp)) pyApiFiles.push(rp);
  }
  for (const d of [
    pjoin(root, "server", "server", "api"),
    pjoin(root, "api"),
    pjoin(root, "app", "api"),
    pjoin(root, "src", "api"),
    pjoin(root, "backend", "app", "api")
  ]) {
    if (isDir(d)) pyApiFiles.push(...sortedPaths(pglob(d, "*.py")));
  }
  for (const pf of [
    ...iterRepoFiles(root, "**/api/**/*.py", 40),
    ...iterRepoFiles(root, "**/routers/**/*.py", 40),
    ...iterRepoFiles(root, "**/*route*.py", 30),
    ...iterRepoFiles(root, "**/views*.py", 25)
  ]) {
    if (!pathIn(pyApiFiles, pf)) pyApiFiles.push(pf);
  }
  for (const pyFile of pyApiFiles) {
    if (pname(pyFile).startsWith("_") || seenFiles.has(pyFile)) continue;
    seenFiles.add(pyFile);
    const name = pstem(pyFile);
    const content = readCode(pyFile);
    if (!reSearch(R`@(?:router|app|bp|api)\.(get|post|put|delete|patch|route|websocket)\b`, content) && !content.includes("APIRouter")) continue;
    const m = reSearch(R`(?:router|bp)\s*=\s*(?:APIRouter|Blueprint)\([^)]*(?:prefix|url_prefix)=["\']([^"\']+)["\']`, content);
    const explicitPrefix = m ? m.g(1) : mountedPrefixes.get(name) ?? "";
    const isRootApp = ["server", "app", "main"].includes(name);
    const displayPrefix = explicitPrefix || (isRootApp ? "/" : `/${name}`);
    const endpoints = [];
    for (const em of reFinditer(R`@(?:router|app|bp|api)\.(get|post|put|delete|patch|route|websocket)\(\s*["\']([^"\']*)["\']`, content)) {
      const rawM = em.g(1).toUpperCase();
      const method = rawM === "WEBSOCKET" ? "WS" : rawM;
      const subpath = em.g(2);
      let fullP;
      if (explicitPrefix) {
        if (subpath === explicitPrefix || subpath.startsWith(pyRstrip(explicitPrefix, "/") + "/")) fullP = subpath;
        else fullP = joinRoute(explicitPrefix, subpath);
      } else if (subpath.startsWith("/") && pyLen(subpath) > 1) {
        if (!isRootApp && !subpath.startsWith(`/${name}`)) fullP = joinRoute(displayPrefix, subpath);
        else fullP = pyRstrip(subpath, "/");
      } else {
        fullP = joinRoute(displayPrefix, subpath);
      }
      endpoints.push(`\`${method} ${fullP}\``);
    }
    if (endpoints.length) routes.push(route(name, pname(pyFile), displayPrefix, endpoints));
  }
  for (const appCand of [pjoin(root, "apps", "web", "src", "app", "api"), pjoin(root, "src", "app", "api"), pjoin(root, "app", "api")]) {
    if (!isDir(appCand)) continue;
    for (const routeFile of sortedPaths(pglob(appCand, "**/route.[tj]s*"))) {
      const prefix = `/${relTo(pparent(routeFile), pparent(appCand))}`;
      const content = readCode(routeFile);
      const methods = reFindall(R`export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\b`, content);
      routes.push(route(pname(pparent(routeFile)), pname(routeFile), prefix, uniq(methods).map((mm) => `\`${mm} ${prefix}\``)));
    }
  }
  for (const tsFile of uniqPaths([
    ...iterRepoFiles(root, "**/*.controller.ts", 30),
    ...iterRepoFiles(root, "**/routes/**/*.[tj]s", 30),
    ...iterRepoFiles(root, "server/src/**/*.[tj]s", 20)
  ])) {
    const content = readCode(tsFile);
    const endpoints = [];
    const ctrlM = reSearch(R`@Controller\(\s*["\']?([^"\')\s]*)["\']?\s*\)`, content);
    const prefix = ctrlM && ctrlM.g(1) ? "/" + pyStrip(ctrlM.g(1), "/") : `/${replaceAll(pstem(tsFile), ".controller", "")}`;
    for (const nm of reFinditer(R`@(Get|Post|Put|Delete|Patch)\(\s*["\']?([^"\')\s]*)["\']?\s*\)`, content)) {
      endpoints.push(`\`${nm.g(1).toUpperCase()} ${joinRoute(prefix, nm.g(2))}\``);
    }
    for (const exm of reFinditer(R`\b(?:app|router|server)\.(get|post|put|delete|patch)\(\s*["\']([^"\']+)["\']`, content)) {
      endpoints.push(`\`${exm.g(1).toUpperCase()} ${exm.g(2)}\``);
    }
    if (endpoints.length) routes.push(route(pstem(tsFile), pname(tsFile), prefix, endpoints));
  }
  for (const goFile of iterRepoFiles(root, "**/*.go", 40)) {
    if (pname(goFile).endsWith("_test.go")) continue;
    const content = readCode(goFile);
    const endpoints = [];
    for (const gm of reFinditer(R`\.\s*(GET|POST|PUT|DELETE|PATCH|HandleFunc)\(\s*"([^"]+)"`, content)) {
      endpoints.push(`\`${gm.g(1) === "HandleFunc" ? "ANY" : gm.g(1)} ${gm.g(2)}\``);
    }
    if (endpoints.length) routes.push(route(pstem(goFile), pname(goFile), `/${pstem(goFile)}`, endpoints));
  }
  for (const jkFile of [...iterRepoFiles(root, "**/*Controller.java", 25), ...iterRepoFiles(root, "**/*Controller.kt", 25)]) {
    const content = readCode(jkFile);
    const reqM = reSearch(R`@RequestMapping\(\s*(?:value\s*=\s*)?["\']([^"\']+)["\']`, content);
    const prefix = reqM ? reqM.g(1) : `/${replaceAll(pstem(jkFile), "Controller", "").toLowerCase()}`;
    const endpoints = [];
    for (const sm of reFinditer(R`@(Get|Post|Put|Delete|Patch)Mapping(?:\(\s*(?:value\s*=\s*)?["\']([^"\']*)["\'])?`, content)) {
      endpoints.push(`\`${sm.g(1).toUpperCase()} ${joinRoute(prefix, sm.group(2) || "")}\``);
    }
    if (endpoints.length) routes.push(route(pstem(jkFile), pname(jkFile), prefix, endpoints));
  }
  for (const rsFile of iterRepoFiles(root, "**/*.rs", 30)) {
    const content = readCode(rsFile);
    const endpoints = [];
    for (const tm of reFinditer(R`#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)`, content)) {
      endpoints.push(`\`IPC tauri:${tm.g(1)}\``);
    }
    for (const am of reFinditer(R`#\[(get|post|put|delete|patch)\(\s*"([^"]+)"`, content)) {
      endpoints.push(`\`${am.g(1).toUpperCase()} ${am.g(2)}\``);
    }
    if (endpoints.length) routes.push(route(pstem(rsFile), pname(rsFile), `ipc://${pstem(rsFile)}`, endpoints));
  }
  for (const elFile of [...iterRepoFiles(root, "**/main.ts", 15), ...iterRepoFiles(root, "**/ipc*.ts", 15)]) {
    const content = readCode(elFile);
    if (!content.includes("ipcMain.handle")) continue;
    const endpoints = Array.from(reFinditer(R`ipcMain\.handle\(\s*["\']([^"\']+)["\']`, content), (im) => `\`IPC ${im.g(1)}\``);
    if (endpoints.length) routes.push(route(pstem(elFile), pname(elFile), "ipc://electron", endpoints));
  }
  return routes;
}
function scanDataModels(root) {
  const models = [];
  const relations = [];
  const uniqueConstraints = [];
  const addModel = (name) => {
    if (name && !models.includes(name)) models.push(name);
  };
  const addRel = (r) => {
    if (r && !relations.includes(r)) relations.push(r);
  };
  const addUnique = (uq) => {
    if (uq && !uniqueConstraints.includes(uq)) uniqueConstraints.push(uq);
  };
  const files = (pattern, limit = 80) => iterRepoFiles(root, pattern, limit);
  const pyCandidates = [];
  const defaultPy = pjoin(root, "server", "server", "db", "models.py");
  if (exists(defaultPy)) pyCandidates.push(defaultPy);
  for (const cand of [...files("**/models.py", 30), ...files("**/models/*.py", 30)]) {
    if (!pathIn(pyCandidates, cand) && !pname(cand).startsWith("_")) pyCandidates.push(cand);
  }
  for (const modelsFile of pyCandidates) {
    let content;
    try {
      content = readTextIgnore(modelsFile);
    } catch {
      continue;
    }
    let currentClass = null;
    for (const line of pySplitlines(content)) {
      const cm = reMatch(R`^class\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*:`, line);
      if (cm) {
        const cname = cm.g(1);
        const bases = cm.g(2);
        if (["Base", "Model", "BaseModel", "SQLModel", "Table", "Document"].some((b) => bases.includes(b))) {
          addModel(cname);
          currentClass = cname;
        } else {
          currentClass = null;
        }
        continue;
      }
      if (!currentClass) continue;
      if (line.includes("ForeignKey(")) {
        const fkm = reSearch(R`([a-zA-Z0-9_]+)\s*[:=][^;]*ForeignKey\(\s*["\']([^"\']+)["\']`, line);
        if (fkm) addRel(`\`${currentClass}.${fkm.g(1)}\` ➔ \`${fkm.g(2)}\``);
      }
      if (line.includes("UniqueConstraint(")) {
        const uqm = reSearch(R`UniqueConstraint\(([^)]+)\)`, line);
        if (uqm) {
          const cols = uqm.g(1).split(",").filter((c) => !c.includes("name=") && pyStrip(c)).map((c) => pyStrip(pyStrip(c), `"'`));
          if (cols.length) addUnique(`\`${currentClass}\`: unique(${cols.join(", ")})`);
        }
      } else if (line.includes("unique=True")) {
        const ufm = reSearch(R`^\s*([a-zA-Z0-9_]+)\s*[:=]`, line);
        if (ufm) addUnique(`\`${currentClass}.${ufm.g(1)}\` (unique)`);
      }
      const dj = reSearch(R`([a-zA-Z0-9_]+)\s*=\s*(?:models\.)?(?:ForeignKey|OneToOneField|ManyToManyField)\(\s*["\']?([A-Za-z0-9_.]+)["\']?`, line);
      if (dj && dj.g(2) !== "self" && dj.g(2) !== "settings") addRel(`\`${currentClass}.${dj.g(1)}\` ➔ \`${dj.g(2)}\``);
    }
  }
  for (const prismaFile of files("**/*.prisma", 20)) {
    let content;
    try {
      content = readTextIgnore(prismaFile);
    } catch {
      continue;
    }
    let currentModel = null;
    for (const line of pySplitlines(content)) {
      const mm = reMatch(R`^\s*model\s+([A-Za-z0-9_]+)\s*\{`, line);
      if (mm) {
        currentModel = mm.g(1);
        addModel(currentModel);
        continue;
      }
      if (currentModel && reMatch(R`^\s*\}`, line)) {
        currentModel = null;
        continue;
      }
      if (currentModel && line.includes("@relation")) {
        const rm = reSearch(
          R`^\s*([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\??\s+.*@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*references:\s*\[([^\]]+)\]`,
          line
        );
        if (rm) addRel(`\`${currentModel}.${pyStrip(rm.g(3))}\` ➔ \`${rm.g(2)}.${pyStrip(rm.g(4))}\``);
      }
    }
  }
  for (const tsFile of uniqPaths([
    ...files("**/schema.ts", 30),
    ...files("**/schema/*.ts", 30),
    ...files("**/entities/*.ts", 30),
    ...files("**/*.entity.ts", 30)
  ])) {
    let content;
    try {
      content = readTextIgnore(tsFile);
    } catch {
      continue;
    }
    for (const dm of reFinditer(R`(?:pgTable|mysqlTable|sqliteTable)\(\s*["\']([a-zA-Z0-9_]+)["\']\s*,\s*\{([\s\S]*?)\}\s*[,)]`, content)) {
      const tname = dm.g(1);
      addModel(tname);
      for (const rfm of reFinditer(R`([a-zA-Z0-9_]+)\s*:[^\n,]*?\.references\(\s*\(\)\s*=>\s*([a-zA-Z0-9_.]+)`, dm.g(2))) {
        addRel(`\`${tname}.${rfm.g(1)}\` ➔ \`${rfm.g(2)}\``);
      }
    }
    if (content.includes("@Entity")) {
      let currentEntity = null;
      let pendingTarget = null;
      for (const line of pySplitlines(content)) {
        const em = reSearch(R`class\s+([A-Za-z0-9_]+)`, line);
        if (em) {
          currentEntity = em.g(1);
          addModel(currentEntity);
          continue;
        }
        const relDec = reSearch(R`@(?:ManyToOne|OneToOne|ManyToMany)\(\s*\(\)\s*=>\s*([A-Za-z0-9_]+)`, line);
        if (relDec) {
          pendingTarget = relDec.g(1);
          continue;
        }
        if (currentEntity && pendingTarget) {
          const prop = reMatch(R`^\s*([a-zA-Z0-9_]+)\??\s*:`, line);
          if (prop && !pyStrip(line).startsWith("@")) {
            addRel(`\`${currentEntity}.${prop.g(1)}\` ➔ \`${pendingTarget}\``);
            pendingTarget = null;
          }
        }
      }
    }
  }
  for (const goFile of files("**/*.go", 40)) {
    if (pname(goFile).endsWith("_test.go")) continue;
    let content;
    try {
      content = readTextIgnore(goFile);
    } catch {
      continue;
    }
    if (!content.includes("gorm:") && !content.includes("db:")) continue;
    for (const sm of reFinditer(R`type\s+([A-Za-z0-9_]+)\s+struct\s*\{([\s\S]*?)\}`, content)) {
      const sname = sm.g(1);
      const sbody = sm.g(2);
      if (!sbody.includes("gorm:") && !sbody.includes("db:")) continue;
      addModel(sname);
      for (const line of pySplitlines(sbody)) {
        const fkm = reSearch(R`^\s*([A-Za-z0-9_]+)\s+\*?([A-Za-z0-9_]+)\s+${"`"}[^${"`"}]*gorm:"[^"]*foreignKey:([A-Za-z0-9_]+)`, line);
        if (fkm) {
          addRel(`\`${sname}.${fkm.g(3)}\` ➔ \`${fkm.g(2)}\``);
        } else if (reSearch(R`^\s*([A-Za-z0-9_]+)ID\s+(?:uint|int|string|uuid\.UUID)\b`, line)) {
          const idm = reSearch(R`^\s*([A-Za-z0-9_]+)ID\s+`, line);
          if (idm && idm.g(1) !== sname) addRel(`\`${sname}.${idm.g(1)}ID\` ➔ \`${idm.g(1)}.ID\``);
        }
      }
    }
  }
  for (const rsFile of files("**/*.rs", 40)) {
    let content;
    try {
      content = readTextIgnore(rsFile);
    } catch {
      continue;
    }
    if (content.includes("sea_orm")) {
      const tm = reSearch(R`#\[sea_orm\(\s*table_name\s*=\s*"([^"]+)"`, content);
      const tname = tm ? tm.g(1) : pstem(rsFile);
      addModel(tname);
      for (const bm of reFinditer(R`#\[sea_orm\([^\]]*belongs_to\s*=\s*"([^"]+)"[^\]]*from\s*=\s*"([^"]+)"[^\]]*to\s*=\s*"([^"]+)"`, content)) {
        const parts = bm.g(1).split("::");
        const target = bm.g(1).includes("::") ? parts[parts.length - 2] : bm.g(1);
        addRel(`\`${tname}.${lastPart(bm.g(2), "::")}\` ➔ \`${target}.${lastPart(bm.g(3), "::")}\``);
      }
    }
    if (content.includes("#[diesel(")) {
      for (const dm of reFinditer(R`#\[diesel\(table_name\s*=\s*([a-zA-Z0-9_]+)\)\]`, content)) {
        const tname = dm.g(1);
        addModel(tname);
        for (const bm of reFinditer(R`#\[diesel\(belongs_to\(([A-Za-z0-9_]+)\)\)\]`, content)) addRel(`\`${tname}\` ➔ \`${bm.g(1)}\``);
      }
    }
  }
  for (const jvmFile of [...files("**/*.java", 30), ...files("**/*.kt", 30)]) {
    let content;
    try {
      content = readTextIgnore(jvmFile);
    } catch {
      continue;
    }
    if (!content.includes("@Entity") && !content.includes("@Table")) continue;
    const cm = reSearch(R`\bclass\s+([A-Za-z0-9_]+)`, content);
    if (!cm) continue;
    const cname = cm.g(1);
    addModel(cname);
    let pendingRel = false;
    for (const line of pySplitlines(content)) {
      if (reSearch(R`@(?:ManyToOne|OneToOne|ManyToMany|JoinColumn)\b`, line)) {
        pendingRel = true;
        continue;
      }
      if (pendingRel && !pyStrip(line).startsWith("@")) {
        const jm = reSearch(R`(?:private|protected|public)\s+([A-Za-z0-9_]+)\s+([a-zA-Z0-9_]+)\s*[;=]`, line);
        const km = reSearch(R`(?:val|var)\s+([a-zA-Z0-9_]+)\s*:\s*([A-Za-z0-9_]+)`, line);
        if (jm) {
          addRel(`\`${cname}.${jm.g(2)}\` ➔ \`${jm.g(1)}\``);
          pendingRel = false;
        } else if (km) {
          addRel(`\`${cname}.${km.g(1)}\` ➔ \`${km.g(2)}\``);
          pendingRel = false;
        }
      }
    }
  }
  const q = '["`]?';
  for (const sqlFile of files("**/*.sql", 30)) {
    let content;
    try {
      content = readTextIgnore(sqlFile);
    } catch {
      continue;
    }
    for (const ctm of reFinditer(R`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${q}([a-zA-Z0-9_.]+)${q}\s*\(([\s\S]*?)\);`, content, { i: true })) {
      const tname = ctm.g(1);
      const tbody = ctm.g(2);
      addModel(tname);
      for (const fkm of reFinditer(
        R`FOREIGN\s+KEY\s*\(\s*${q}([a-zA-Z0-9_]+)${q}\s*\)\s*REFERENCES\s+${q}([a-zA-Z0-9_.]+)${q}\s*\(\s*${q}([a-zA-Z0-9_]+)${q}\s*\)`,
        tbody,
        { i: true }
      )) {
        addRel(`\`${tname}.${fkm.g(1)}\` ➔ \`${fkm.g(2)}.${fkm.g(3)}\``);
      }
      for (const inm of reFinditer(
        R`^\s*${q}([a-zA-Z0-9_]+)${q}\s+[A-Za-z0-9_()]+[^,\n]*?\bREFERENCES\s+${q}([a-zA-Z0-9_.]+)${q}\s*\(\s*${q}([a-zA-Z0-9_]+)${q}\s*\)`,
        tbody,
        { i: true, m: true }
      )) {
        if (inm.g(1).toUpperCase() !== "FOREIGN") addRel(`\`${tname}.${inm.g(1)}\` ➔ \`${inm.g(2)}.${inm.g(3)}\``);
      }
    }
  }
  return { models, relations: relations.slice(0, 25), unique_constraints: uniqueConstraints.slice(0, 20) };
}
function generateErDiagram(relations) {
  if (!relations.length) return "";
  const edges = [];
  const seenEdges = /* @__PURE__ */ new Set();
  for (const r of relations.slice(0, 18)) {
    const m = reMatch(R`${"`"}([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)${"`"}\s*➔\s*${"`"}([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?${"`"}`, r);
    if (!m) continue;
    const srcEntity = m.g(1);
    const srcField = m.g(2);
    let srcNode = reSub(R`[^A-Za-z0-9_]`, "_", srcEntity).toUpperCase();
    let dstNode = reSub(R`[^A-Za-z0-9_]`, "_", m.g(3)).toUpperCase();
    if (dstNode.endsWith("IES") && !srcNode.endsWith("IES")) dstNode = dstNode.slice(0, -3) + "Y";
    else if (dstNode.endsWith("ES") && ["SES", "XES", "ZES", "CHES", "SHES"].some((s) => dstNode.endsWith(s))) dstNode = dstNode.slice(0, -2);
    else if (dstNode.endsWith("S") && !dstNode.endsWith("SS") && dstNode.length > 3) dstNode = dstNode.slice(0, -1);
    if (srcNode.endsWith("S") && !srcNode.endsWith("SS") && srcNode.length > 3 && pyIslower(srcEntity)) srcNode = srcNode.slice(0, -1);
    const edgeKey = `${dstNode}->${srcNode}:${srcField}`;
    if (!seenEdges.has(edgeKey)) {
      seenEdges.add(edgeKey);
      edges.push(`    ${dstNode} ||--o{ ${srcNode} : "${srcField}"`);
    }
  }
  if (!edges.length) return "";
  return ["```mermaid", "erDiagram", ...edges, "```"].join("\n");
}
function scanServicesAndSchedules(root) {
  const services = [];
  const schedules = [];
  const svcFiles = [];
  for (const sdir of [pjoin(root, "server", "server", "services"), pjoin(root, "src", "services"), pjoin(root, "services"), pjoin(root, "app", "services")]) {
    if (isDir(sdir)) {
      svcFiles.push(...sortedPaths(pglob(sdir, "*.py")), ...sortedPaths(pglob(sdir, "*.ts")), ...sortedPaths(pglob(sdir, "*.go")));
    }
  }
  for (const cand of [...iterRepoFiles(root, "**/services/*.[ptg]*", 40), ...iterRepoFiles(root, "**/*service*.[ptg]*", 30)]) {
    if (!pathIn(svcFiles, cand)) svcFiles.push(cand);
  }
  const seenSvc = new PathSet();
  for (const f of svcFiles) {
    const fn = pname(f);
    if (seenSvc.has(f) || fn.startsWith("_") || fn.includes(".test.") || fn.includes(".spec.") || fn.endsWith("_test.go")) continue;
    seenSvc.add(f);
    try {
      const text = readCode(f, 4e3);
      let doc = "";
      const dm = reMatch(R`^\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')`, text);
      if (dm) {
        doc = pyStrip(firstLine(pyStrip(dm.g(1))));
      } else {
        const cm = reMatch(R`^\s*(?://+|#+|/\*\*?)\s*([^\n*]+)`, text);
        if (cm) doc = pyStrip(cm.g(1));
      }
      services.push({
        name: pstem(f),
        path: rel(f, root),
        summary: doc ? sanitizeBlueprintText(pySlice(doc, 0, 110)) : "Core domain service module"
      });
    } catch {
    }
  }
  for (const pyF of iterRepoFiles(root, "**/*.py", 60)) {
    const content = readCode(pyF);
    if (content.includes("beat_schedule")) {
      for (const bm of reFinditer(R`"([a-zA-Z0-9_-]+)"\s*:\s*\{\s*"task"\s*:\s*"([^"]+)"\s*,\s*"schedule"\s*:\s*([^\n]+)`, content)) {
        schedules.push({ name: bm.g(1), task: bm.g(2), schedule: pyStrip(pyRstrip(bm.g(3), ",")) });
      }
    }
    if (content.includes("add_job(") || content.includes("scheduled_job(")) {
      for (const aj of reFinditer(R`(?:add_job|scheduled_job)\(\s*([a-zA-Z0-9_.]+)\s*,\s*["\']([^"\']+)["\']`, content)) {
        schedules.push({ name: aj.g(1), task: `${pstem(pyF)}.${aj.g(1)}`, schedule: aj.g(2) });
      }
    }
  }
  for (const tsF of iterRepoFiles(root, "**/*.[tj]s", 50)) {
    const content = readCode(tsF);
    try {
      if (content.includes("cron.schedule")) {
        for (const cm of reFinditer(R`cron\.schedule\(\s*["\']([^"\']+)["\']`, content)) {
          schedules.push({ name: pstem(tsF), task: rel(tsF, root), schedule: `cron(${cm.g(1)})` });
        }
      }
      if (content.includes("@Cron")) {
        for (const nm of reFinditer(R`@Cron\(\s*["\']([^"\']+)["\']\s*\)[\s\S]{1,120}?\b([a-zA-Z0-9_]+)\s*\(`, content)) {
          schedules.push({ name: nm.g(2), task: `${pstem(tsF)}.${nm.g(2)}`, schedule: `@Cron(${nm.g(1)})` });
        }
      }
    } catch {
    }
  }
  return { services: services.slice(0, 35), schedules: schedules.slice(0, 25) };
}
function scanMcpAndWsProtocols(root) {
  const mcpTools = [];
  const wsEvents = [];
  const rpcContracts = [];
  for (const mf of iterRepoFiles(root, "**/*.[tp][sy]", 60)) {
    const content = readCode(mf);
    try {
      if (content.includes("registerTool") || content.includes("@mcp.tool")) {
        for (const tm of reFinditer(R`registerTool\(\s*["\']([a-zA-Z0-9_-]+)["\']\s*,\s*\{[\s\S]*?description:\s*\n?\s*["\']([^"\']+)["\']`, content)) {
          mcpTools.push({ name: tm.g(1), description: pySlice(pyStrip(tm.g(2)), 0, 100) });
        }
        for (const pm of reFinditer(R`@mcp\.tool\([^)]*\)\s*(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?:->[^:]+)?:\s*(?:"""([^"]+)""")?`, content)) {
          mcpTools.push({ name: pm.g(1), description: pySlice(firstLine(pyStrip(pm.group(2) || "Python MCP tool")), 0, 100) });
        }
      }
      if (content.includes("WebSocket") || pstem(mf).toLowerCase().includes("ws") || content.includes("socket.on(") || content.includes("@sio.on(")) {
        for (const cm of reFinditer(R`(?:case|socket\.on\(|@sio\.on\()\s*["\']([a-zA-Z0-9_:-]+)["\']`, content)) {
          const ev = cm.g(1);
          if (!wsEvents.includes(ev) && ev.length > 2) wsEvents.push(ev);
        }
        for (const pm of reFinditer(R`msg_type\s*==\s*["\']([a-zA-Z0-9_:-]+)["\']`, content)) {
          const ev = pm.g(1);
          if (!wsEvents.includes(ev)) wsEvents.push(ev);
        }
      }
    } catch {
    }
  }
  for (const pf of iterRepoFiles(root, "**/*.proto", 20)) {
    let content;
    try {
      content = readTextIgnore(pf);
    } catch {
      continue;
    }
    for (const sm of reFinditer(R`service\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}`, content)) {
      const sname = sm.g(1);
      for (const rm of reFinditer(
        R`rpc\s+([A-Za-z0-9_]+)\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)`,
        sm.g(2)
      )) {
        rpcContracts.push(`gRPC \`${sname}.${rm.g(1)}(${rm.g(2)}) ➔ ${rm.g(3)}\``);
      }
    }
  }
  for (const gf of [...iterRepoFiles(root, "**/*.graphql", 20), ...iterRepoFiles(root, "**/*.gql", 20)]) {
    let content;
    try {
      content = readTextIgnore(gf);
    } catch {
      continue;
    }
    for (const tm of reFinditer(R`type\s+(Query|Mutation|Subscription)\s*\{([\s\S]*?)\}`, content)) {
      const kind = tm.g(1);
      for (const fm of reFinditer(R`^\s*([a-zA-Z0-9_]+)\s*(?:\([^)]*\))?\s*:\s*([A-Za-z0-9_\[\]!]+)`, tm.g(2), { m: true })) {
        rpcContracts.push(`GraphQL \`${kind}.${fm.g(1)} ➔ ${fm.g(2)}\``);
      }
    }
  }
  return { mcp_tools: mcpTools.slice(0, 25), ws_events: wsEvents.slice(0, 25), rpc_contracts: rpcContracts.slice(0, 20) };
}
function scanCicdAndDeploy(root) {
  const items = [];
  const wfDir = pjoin(root, ".github", "workflows");
  if (isDir(wfDir)) {
    for (const wf of sortedPaths(pglob(wfDir, "*.y*ml"))) {
      try {
        const content = readCode(wf, 5e4);
        const nm = reSearch(R`^name:\s*(.+)$`, content, { m: true });
        const wname = nm ? pyStrip(pyStrip(nm.g(1)), `"'`) : pstem(wf);
        const jm = reSearch(R`^jobs:\s*\n([\s\S]*)`, content, { m: true });
        const jobs = jm ? reFindall(R`^  ([a-zA-Z0-9_-]+):\s*(?:#.*)?$`, jm.g(1), { m: true }) : [];
        items.push({
          kind: "GitHub Actions",
          name: wname,
          path: rel(wf, root),
          details: jobs.length ? `Jobs: ${jobs.slice(0, 6).join(", ")}` : "CI/CD pipeline"
        });
      } catch {
      }
    }
  }
  const gitlabCi = pjoin(root, ".gitlab-ci.yml");
  if (isFile(gitlabCi)) {
    const content = readCode(gitlabCi, 5e4);
    const stagesM = reSearch(R`^stages:\s*\n((?:\s*-\s*[^\n]+\n)+)`, content, { m: true });
    const stages = stagesM ? pySplitlines(stagesM.g(1)).filter((s) => pyStrip(s)).map((s) => pyStrip(pyLstrip(pyStrip(s), "-"))) : [];
    items.push({
      kind: "GitLab CI",
      name: ".gitlab-ci.yml",
      path: ".gitlab-ci.yml",
      details: stages.length ? `Stages: ${stages.slice(0, 6).join(", ")}` : "GitLab CI/CD pipeline"
    });
  }
  for (const deployDir of [pjoin(root, "deploy"), pjoin(root, "k8s")]) {
    if (!isDir(deployDir)) continue;
    for (const ym of sortedPaths(pglob(deployDir, "**/*.y*ml")).slice(0, 12)) {
      try {
        const content = readCode(ym, 3e4);
        const kinds = uniq(reFindall(R`^kind:\s*([A-Za-z0-9]+)`, content, { m: true }));
        if (kinds.length) {
          items.push({ kind: "K8s / GitOps", name: pname(ym), path: rel(ym, root), details: `Resources: ${kinds.slice(0, 5).join(", ")}` });
        }
      } catch {
      }
    }
  }
  return items;
}
var HOTSPOT_SKIP_SUFFIXES = [".lock", ".json", ".min.js", ".map", "pnpm-lock.yaml", "package-lock.json", "Cargo.lock", "uv.lock", "poetry.lock"];
function scanHotspotsAndTests(root) {
  const hotspots = [];
  const out = runGit(["log", "-n", "60", "--grep=\\[skip ci\\]", "--invert-grep", "--pretty=format:", "--name-only"], root);
  if (out) {
    const counts = /* @__PURE__ */ new Map();
    for (const line of pySplitlines(out)) {
      const p = pyStrip(line);
      if (!p || p === "PROJECT_BLUEPRINT.md" || p === "deploy/k8s/kustomization.yaml" || endsWithAny(p, HOTSPOT_SKIP_SUFFIXES)) continue;
      if (pparts(p).some((part) => IGNORED_DIRS.has(part))) continue;
      if (!isFile(pjoin(root, p))) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const ranked2 = Array.from(counts).sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]));
    for (const [pathStr, cnt] of ranked2.slice(0, 10)) hotspots.push({ path: pathStr, commits: cnt });
  }
  const testSuites = [];
  const allTestFiles = [
    ...iterRepoFiles(root, "**/test_*.py", 150),
    ...iterRepoFiles(root, "**/*_test.py", 100),
    ...iterRepoFiles(root, "**/*.test.[tj]s*", 150),
    ...iterRepoFiles(root, "**/*.spec.[tj]s*", 100),
    ...iterRepoFiles(root, "**/*_test.go", 100),
    ...iterRepoFiles(root, "**/*Test.java", 100),
    ...iterRepoFiles(root, "**/*Test.kt", 100)
  ];
  const grouped = /* @__PURE__ */ new Map();
  for (const tf of uniqPaths(allTestFiles)) {
    const relDir = rel(pparent(tf), root);
    const list = grouped.get(relDir);
    if (list) list.push(pname(tf));
    else grouped.set(relDir, [pname(tf)]);
  }
  const ranked = Array.from(grouped).sort((a, b) => b[1].length - a[1].length || cmpStr(a[0], b[0]));
  for (const [relDir, tfiles] of ranked.slice(0, 10)) {
    const sfiles = sortedStr(uniq(tfiles));
    const runner = sfiles.some((n) => n.endsWith(".py")) ? "pytest" : sfiles.some((n) => n.endsWith(".go")) ? "go test" : sfiles.some((n) => endsWithAny(n, [".java", ".kt"])) ? "JUnit" : "vitest / jest";
    testSuites.push({
      suite: `${relDir} (${runner})`,
      dir: relDir,
      count: sfiles.length,
      samples: sfiles.slice(0, 5).map((n) => `\`${n}\``).join(", ")
    });
  }
  return { hotspots, test_suites: testSuites };
}
function scanAstCallGraphAndDeps(root) {
  const pkgEdges = [];
  const callEdges = [];
  const rootPj = pjoin(root, "package.json");
  const workspacePkgs = /* @__PURE__ */ new Map();
  for (const pj of iterRepoFiles(root, "**/package.json", 40)) {
    if (samePath(pj, rootPj)) continue;
    try {
      const data = loads(readTextIgnore(pj));
      const name = pyGet(data, "name");
      const relDir = rel(pparent(pj), root);
      if (typeof name === "string" && name) workspacePkgs.set(name, relDir);
    } catch {
    }
  }
  for (const pj of iterRepoFiles(root, "**/package.json", 40)) {
    if (samePath(pj, rootPj)) continue;
    try {
      const data = loads(readTextIgnore(pj));
      const srcDir = rel(pparent(pj), root);
      const deps = mergeDicts(orDict(pyGet(data, "dependencies")), orDict(pyGet(data, "devDependencies")));
      for (const depName of deps.keys()) {
        const target = workspacePkgs.get(depName);
        if (target !== void 0 && target !== srcDir) {
          const edge = `\`${srcDir}\` ➔ \`${target}\` (\`${depName}\`)`;
          if (!pkgEdges.includes(edge)) pkgEdges.push(edge);
        }
      }
    } catch {
    }
  }
  const pyFiles = [
    ...iterRepoFiles(root, "**/api/*.py", 35),
    ...iterRepoFiles(root, "**/tasks/*.py", 25),
    ...iterRepoFiles(root, "**/routers/*.py", 25),
    ...iterRepoFiles(root, "**/*.py", 40)
  ];
  const seenPy = new PathSet();
  for (const pf of pyFiles) {
    if (seenPy.has(pf) || pname(pf).startsWith("_") || pparts(pf).includes("test")) continue;
    seenPy.add(pf);
    let imports;
    try {
      imports = parseModule(readCode(pf)).imports;
    } catch {
      continue;
    }
    const parent = pparent(pf);
    const srcLabel = !samePath(parent, root) ? `${pname(parent)}/${pstem(pf)}` : pstem(pf);
    for (const node of imports) {
      const mod = node.module;
      if (!mod) continue;
      if (!(mod.includes("services") || mod.includes("db") || mod.includes("tasks"))) continue;
      const parts = mod.split(".");
      const last = parts[parts.length - 1];
      if (["services", "db", "tasks", "models", "core"].includes(last)) {
        for (const alias of node.names) {
          const targetMod = `${last}/${alias}`;
          const edge = `\`${srcLabel}\` ➔ \`${targetMod}\``;
          if (!callEdges.includes(edge) && srcLabel !== targetMod) callEdges.push(edge);
        }
      } else {
        const targetMod = parts.length >= 2 ? parts.slice(-2).join("/") : last;
        const edge = `\`${srcLabel}\` ➔ \`${targetMod}\``;
        if (!callEdges.includes(edge) && srcLabel !== targetMod) callEdges.push(edge);
      }
    }
  }
  if (callEdges.length < 10) {
    for (const tf of iterRepoFiles(root, "**/*.[tg][so]*", 45)) {
      const tn = pname(tf);
      if (tn.includes(".test.") || tn.includes(".spec.") || tn.endsWith("_test.go")) continue;
      const content = readCode(tf);
      const srcLabel = `${pname(pparent(tf))}/${pstem(tf)}`;
      for (const im of reFinditer(R`from\s+["\'](?:\.\.?/|@/)([a-zA-Z0-9_/-]+)["\']`, content)) {
        const edge = `\`${srcLabel}\` ➔ \`${pyRstrip(im.g(1), "/")}\``;
        if (!callEdges.includes(edge) && callEdges.length < 25) callEdges.push(edge);
      }
    }
  }
  return { package_edges: pkgEdges.slice(0, 15), call_edges: callEdges.slice(0, 20) };
}
function scanOpenapiAndDtoSchemas(root) {
  const schemas = [];
  const seen = /* @__PURE__ */ new Set();
  const key = (name, src) => `${name}\0${src}`;
  for (const oaFile of uniqPaths([...iterRepoFiles(root, "**/*openapi*.json", 5), ...iterRepoFiles(root, "**/*swagger*.json", 5)])) {
    try {
      const data = loads(readCode(oaFile, 1e5));
      const components = pyGet(data, "components");
      const fromComponents = pyGet(truthy(components) ? components : /* @__PURE__ */ new Map(), "schemas");
      let compSchemas = fromComponents;
      if (!truthy(compSchemas)) compSchemas = pyGet(data, "definitions");
      if (!truthy(compSchemas)) compSchemas = /* @__PURE__ */ new Map();
      if (!isDict(compSchemas)) throw new TypeError("'items' on a non-dict");
      const srcRel = rel(oaFile, root);
      for (const [sname, sdef] of Array.from(compSchemas).slice(0, 15)) {
        if (isDict(sdef) && !seen.has(key(sname, srcRel))) {
          seen.add(key(sname, srcRel));
          const propsRaw = pyGet(sdef, "properties");
          const propsDict = truthy(propsRaw) ? propsRaw : /* @__PURE__ */ new Map();
          if (!isDict(propsDict)) throw new TypeError("'keys' on a non-dict");
          const props = Array.from(propsDict.keys()).slice(0, 6);
          schemas.push({
            name: sname,
            kind: "OpenAPI Schema",
            source: srcRel,
            fields: props.length ? props.map((p) => `\`${p}\``).join(", ") : "object"
          });
        }
      }
    } catch {
    }
  }
  for (const pyFile of uniqPaths([...iterRepoFiles(root, "**/api/*.py", 30), ...iterRepoFiles(root, "**/schemas*.py", 20)])) {
    try {
      const { classes } = parseModule(readCode(pyFile));
      const srcRel = rel(pyFile, root);
      for (const node of classes) {
        if (seen.has(key(node.name, srcRel))) continue;
        const bases = node.bases.map((b) => unparse(b));
        if (!bases.some((b) => b.includes("BaseModel") || b.includes("Schema"))) continue;
        const fields = [];
        for (const f of node.fields) {
          if (f.name.startsWith("_")) continue;
          const ftype = replaceAll(unparse(f.annotation), "|", "\\|");
          fields.push(ftype ? `${f.name}: ${ftype}` : f.name);
        }
        if (fields.length) {
          seen.add(key(node.name, srcRel));
          schemas.push({
            name: node.name,
            kind: "Pydantic DTO",
            source: srcRel,
            fields: fields.slice(0, 6).map((f) => `\`${f}\``).join(", ")
          });
        }
      }
    } catch {
    }
  }
  if (schemas.length < 20) {
    for (const tsFile of uniqPaths([...iterRepoFiles(root, "**/types*.ts", 15), ...iterRepoFiles(root, "**/*dto*.ts", 15)])) {
      try {
        const content = readCode(tsFile);
        const srcRel = rel(tsFile, root);
        if (!content.includes("interface ")) continue;
        for (const im of reFinditer(R`export\s+interface\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}`, content)) {
          const iname = im.g(1);
          if (seen.has(key(iname, srcRel))) continue;
          const props = reFindall(R`^\s*([a-zA-Z0-9_]+)\??\s*:`, im.g(2), { m: true });
          if (props.length) {
            seen.add(key(iname, srcRel));
            schemas.push({
              name: iname,
              kind: "TS Interface",
              source: srcRel,
              fields: props.slice(0, 6).map((p) => `\`${p}\``).join(", ")
            });
          }
        }
      } catch {
      }
    }
  }
  return schemas.slice(0, 25);
}
function scanCliAndEntrypoints(root) {
  const entries = [];
  for (const pj of iterRepoFiles(root, "**/package.json", 30)) {
    try {
      const data = loads(readTextIgnore(pj));
      const bins = pyGet(data, "bin");
      if (isDict(bins)) {
        for (const [bname, bpath] of bins) {
          entries.push({ name: bname, kind: "Node CLI Binary", path: rel(pjoin(pparent(pj), pyStr(bpath)), root) });
        }
      } else if (typeof bins === "string" && truthy(pyGet(data, "name"))) {
        entries.push({ name: pyStr(pyGet(data, "name")), kind: "Node CLI Binary", path: rel(pjoin(pparent(pj), bins), root) });
      }
    } catch {
    }
  }
  for (const pp of iterRepoFiles(root, "**/pyproject.toml", 15)) {
    let content;
    try {
      content = readTextIgnore(pp);
    } catch {
      continue;
    }
    const sm = reSearch(R`\[project\.scripts\]([\s\S]*?)(?:\n\[|\Z)`, content);
    if (!sm) continue;
    for (const line of pySplitlines(sm.g(1))) {
      if (line.includes("=") && !pyStrip(line).startsWith("#")) {
        const [k, v] = pySplit(line, "=", 1);
        entries.push({ name: pyStrip(k), kind: "Python CLI Script", path: pyStrip(pyStrip(v), `"'`) });
      }
    }
  }
  for (const gm of iterRepoFiles(root, "cmd/*/main.go", 15)) {
    entries.push({ name: pname(pparent(gm)), kind: "Go Command", path: rel(gm, root) });
  }
  for (const rb of iterRepoFiles(root, "**/src/bin/*.rs", 15)) {
    entries.push({ name: pstem(rb), kind: "Rust Binary", path: rel(rb, root) });
  }
  const scriptsDir = pjoin(root, "scripts");
  if (isDir(scriptsDir)) {
    for (const sf of sortedPaths(iterdir(scriptsDir))) {
      if (isFile(sf) && !pname(sf).startsWith("_") && [".py", ".sh", ".mjs", ".ts", ".js"].includes(psuffix(sf))) {
        entries.push({ name: pname(sf), kind: "Automation Script", path: rel(sf, root) });
      }
    }
  }
  return entries.slice(0, 20);
}
var INFRA_RULES = [
  ["PostgreSQL", ["postgres", "asyncpg", "psycopg", "pgvector", '"pg"', "pgx"]],
  ["pgvector (Vector DB)", ["pgvector"]],
  ["Redis", ["redis", "ioredis", "bullmq"]],
  ["MySQL / MariaDB", ["mysql", "pymysql", "mariadb"]],
  ["SQLite", ["sqlite", "aiosqlite", "better-sqlite3"]],
  ["MongoDB", ["mongodb", "mongoose", "pymongo", "motor"]],
  ["MinIO / S3 Object Storage", ["minio", "s3", "boto3", "@aws-sdk/client-s3"]],
  ["Celery Task Queue", ["celery"]],
  ["Kafka", ["kafka", "confluent-kafka", "kafkajs"]],
  ["RabbitMQ", ["rabbitmq", "amqp", "pika"]],
  ["Elasticsearch / OpenSearch", ["elasticsearch", "opensearch"]]
];
function scanExternalInfra(root) {
  const manifestTexts = [];
  for (const fname of ["docker-compose.yml", "docker-compose.yaml", ".env.example", "pyproject.toml", "package.json", "go.mod", "Cargo.toml"]) {
    const p = pjoin(root, fname);
    if (exists(p)) {
      try {
        manifestTexts.push(readTextIgnore(p).toLowerCase());
      } catch {
      }
    }
  }
  for (const subM of [...iterRepoFiles(root, "**/pyproject.toml", 10), ...iterRepoFiles(root, "**/package.json", 15)]) {
    try {
      manifestTexts.push(readTextIgnore(subM).toLowerCase());
    } catch {
    }
  }
  const blob = manifestTexts.join("\n");
  return INFRA_RULES.filter(([, keywords]) => keywords.some((kw) => blob.includes(kw))).map(([label]) => label);
}
function sanitizeBlueprintText(text) {
  let t = reSub(R`192\.168\.\d{1,3}\.[a-zA-Z0-9_.-]+`, "<internal-ip>", text);
  t = reSub(R`10\.\d{1,3}\.\d{1,3}\.[a-zA-Z0-9_.-]+`, "<internal-ip>", t);
  t = reSub(R`172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.[a-zA-Z0-9_.-]+`, "<internal-ip>", t);
  return t;
}
function scanEnvVariables(root) {
  const vars = [];
  let envExample = pjoin(root, ".env.example");
  if (!exists(envExample)) envExample = pjoin(root, ".env.sample");
  if (!exists(envExample)) return vars;
  let content;
  try {
    content = readTextIgnore(envExample);
  } catch {
    return vars;
  }
  let currentComment = "";
  for (const line of pySplitlines(content)) {
    const sline = pyStrip(line);
    if (!sline) {
      currentComment = "";
      continue;
    }
    if (sline.startsWith("#")) {
      const cleaned = sanitizeBlueprintText(pyStrip(pyLstrip(sline, "#")));
      if (cleaned && !reMatch(R`^[-=_─*#\s]+$`, cleaned)) currentComment = cleaned;
      continue;
    }
    if (sline.includes("=")) {
      const [rawK, v] = pySplit(sline, "=", 1);
      const k = pyStrip(rawK);
      if (k && !k.startsWith("#")) {
        const cleanVal = sanitizeBlueprintText(pyStrip(v));
        vars.push({ name: k, default: cleanVal || "(required secret)", description: currentComment || "Environment configuration" });
        currentComment = "";
      }
    }
  }
  return vars;
}
function getGitEvolution(root, limit = 5) {
  const out = runGit(["log", `-n${limit * 3}`, "--pretty=format:%h|%s|%as"], root);
  if (!out) return [];
  const evos = [];
  for (const line of pySplitlines(out)) {
    const parts = pySplit(line, "|", 2);
    if (parts.length !== 3) continue;
    const [sha, msg, date] = parts;
    if (msg.includes("[skip ci]") || msg.includes("ci(deploy):")) continue;
    evos.push(`- \`${sha}\` (${date}): ${msg}`);
    if (evos.length >= limit) break;
  }
  return evos;
}
function manifestScripts(pdata) {
  const sc = pyGet(pdata, "scripts");
  return sc === void 0 ? /* @__PURE__ */ new Map() : sc;
}
function detectVerificationCommands(root) {
  const commands = [];
  if (isDir(pjoin(root, "packages", "daemon")) && isDir(pjoin(root, "server", "server"))) {
    commands.push(
      "# Backend Tests (Python)",
      "cd server && uv run pytest -W error::RuntimeWarning",
      "",
      "# Backend Lint",
      "uvx ruff check --isolated --select F server/server",
      "",
      "# Frontend Tests & Typecheck (Next.js)",
      "cd apps/web && npx tsc --noEmit && npm test",
      "",
      "# Daemon Tests",
      "cd packages/daemon && npm test",
      "",
      "# Desktop Tests & Typecheck (Electron)",
      "npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test"
    );
    return commands;
  }
  const pyproject = pjoin(root, "pyproject.toml");
  const hasPython = exists(pyproject) || exists(pjoin(root, "requirements.txt")) || exists(pjoin(root, "setup.py")) || pglob(root, "*.py").length > 0;
  if (hasPython) {
    if (exists(pjoin(root, "pytest.ini")) || isDir(pjoin(root, "tests")) || isDir(pjoin(root, "test"))) commands.push("# Python Tests", "pytest");
    if (exists(pjoin(root, "ruff.toml")) || exists(pyproject) && readCode(pyproject, 2e4).includes("ruff")) commands.push("# Python Lint", "ruff check .");
  } else if (isDir(pjoin(root, "backend")) && (exists(pjoin(root, "backend", "requirements.txt")) || exists(pjoin(root, "backend", "pyproject.toml")))) {
    if (isDir(pjoin(root, "backend", "tests")) || exists(pjoin(root, "backend", "pytest.ini"))) commands.push("# Backend Python Tests", "cd backend && pytest");
  }
  const pjsonPath = pjoin(root, "package.json");
  if (exists(pjsonPath)) {
    try {
      const scripts = manifestScripts(loads(readCode(pjsonPath, 2e4)));
      if (pyIn("test", scripts)) commands.push("# Unit Tests", "npm test");
      if (pyIn("typecheck", scripts) || exists(pjoin(root, "tsconfig.json"))) commands.push("# Typecheck", "npx tsc --noEmit");
      if (pyIn("lint", scripts)) commands.push("# Code Lint", "npm run lint");
      if (pyIn("build", scripts)) commands.push("# Build Package", "npm run build");
    } catch {
    }
  } else {
    for (const subNode of ["frontend", "desktop", "client", "web"]) {
      const subPj = pjoin(root, subNode, "package.json");
      if (!exists(subPj)) continue;
      try {
        const scripts = manifestScripts(loads(readCode(subPj, 2e4)));
        if (pyIn("test", scripts)) commands.push(`# ${pyCapitalize(subNode)} Tests`, `cd ${subNode} && npm test`);
        if (pyIn("build", scripts)) commands.push(`# ${pyCapitalize(subNode)} Build`, `cd ${subNode} && npm run build`);
      } catch {
      }
    }
  }
  if (exists(pjoin(root, "Cargo.toml"))) commands.push("# Cargo Tests", "cargo test", "", "# Cargo Clippy", "cargo clippy");
  if (exists(pjoin(root, "go.mod"))) commands.push("# Go Tests", "go test ./...");
  if (!commands.length) commands.push("# Project Status & Integrity Check", "git status -s");
  return commands;
}

// packages/daemon/src/blueprint/meta.ts
var BLUEPRINT_SCRIPT_VERSION = 20261122;
var BLUEPRINT_FILE = "PROJECT_BLUEPRINT.md";
var BUSINESS_FILE = "BUSINESS_BLUEPRINT.md";
var SCRIPT_NAME = "project_blueprint.mjs";
var LEGACY_SCRIPT_NAME = "project_blueprint.py";
var GENERATED_MARK = "_Auto-maintained by `scripts/project_blueprint.mjs`";
var LEGACY_GENERATED_MARK = "_Auto-maintained by `scripts/project_blueprint.py`";
var SCRIPT_VERSION_RE = /^(?:(?:export\s+)?(?:const|let|var)\s+)?BLUEPRINT_SCRIPT_VERSION\s*=\s*(\d+)/m;
var HEAD_MARKER = ".memento_blueprint_head";
var HOOK_MARKER_START = "# <<< Memento Blueprint Hook Start >>>";
var HOOK_MARKER_END = "# <<< Memento Blueprint Hook End >>>";
var MANAGED_GIT_HOOKS = ["pre-commit", "post-commit", "post-merge", "post-checkout", "post-rewrite"];
var RUNTIME_NAME = "runtime";
function scriptVersionOf(content) {
  const m = content.match(SCRIPT_VERSION_RE);
  return m ? Number(m[1]) : 0;
}

// packages/daemon/src/blueprint/business.ts
var KIND_OF = { T: "term", F: "flow", R: "rule", S: "state" };
var INDEX_START = "<!-- memento:business-index:start (自动生成，勿手改) -->";
var INDEX_END = "<!-- memento:business-index:end -->";
var CHECK_START = "<!-- memento:business-check:start (自动生成，勿手改) -->";
var CHECK_END = "<!-- memento:business-check:end -->";
var ENTRY_RE = /^###\s+([TFRS]-[A-Z0-9][A-Z0-9-]*)\s+(.+?)\s*$/;
var FIELD_RE = /^\s*[-*]\s*(来源|代码|测试|禁止|要求|事实源|副本|同步|定义|说明)\s*[:：]\s*(.*)$/;
var STEP_RE = /^\s*\d+[.)、]\s+(.*)$/;
var TICKED_RE = /`([^`\n]+)`/g;
var ANCHOR_FIELDS = /* @__PURE__ */ new Set(["代码", "事实源", "副本", "同步"]);
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "__pycache__", ".venv", "venv", ".turbo", "target"]);
var MAX_SCAN_FILES = 2e4;
var MAX_HITS = 5;
function splitRef(ref) {
  const at = ref.indexOf("#");
  const path = (at < 0 ? ref : ref.slice(0, at)).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return [path, at < 0 ? "" : ref.slice(at + 1).trim()];
}
function looksLikePath(tok) {
  const [path] = splitRef(tok);
  if (!path || /\s/.test(path) || /^[a-z]+:\/\//i.test(path)) return false;
  return path.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(path);
}
function anchorsIn(text) {
  const out = [];
  for (const m of text.matchAll(TICKED_RE)) if (looksLikePath(m[1])) out.push(m[1].trim());
  return out;
}
function patternClauses(text) {
  const out = [];
  for (const clause of text.split(/[;；]/)) {
    const at = clause.search(/\s@\s/);
    if (at < 0) continue;
    const pat = [...clause.slice(0, at).matchAll(TICKED_RE)].map((m) => m[1])[0];
    const paths = [...clause.slice(at).matchAll(TICKED_RE)].map((m) => splitRef(m[1])[0]).filter(Boolean);
    if (pat && paths.length) out.push({ pattern: pat, paths });
  }
  return out;
}
function parseBusinessBlueprint(text) {
  const lines = text.split("\n");
  const entries = [];
  let cur = null;
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
      cur = { id: head[1], kind: KIND_OF[head[1][0]], title: head[2], line: i + 1, sources: [], anchors: [], tests: [], forbidden: [], required: [] };
      entries.push(cur);
      return;
    }
    if (/^#{1,3}\s/.test(line)) {
      cur = null;
      return;
    }
    if (!cur) return;
    const e = cur;
    const field = line.match(FIELD_RE);
    if (field) {
      const [, name, value] = field;
      if (name === "来源") e.sources.push(value.trim());
      else if (ANCHOR_FIELDS.has(name)) for (const ref of anchorsIn(value)) e.anchors.push(blankAnchor(ref));
      else if (name === "测试") for (const ref of anchorsIn(value)) e.tests.push(blankAnchor(ref));
      else if (name === "禁止") for (const c of patternClauses(value)) e.forbidden.push({ ...c, hits: [], ok: true });
      else if (name === "要求") for (const c of patternClauses(value)) e.required.push({ ...c, hits: [], ok: true });
      return;
    }
    const step = line.match(STEP_RE);
    if (step && e.kind === "flow") for (const ref of anchorsIn(step[1])) e.anchors.push(blankAnchor(ref));
  });
  return entries;
}
function blankAnchor(ref) {
  const [path, symbol] = splitRef(ref);
  return { ref, path, symbol, ok: true };
}
var fileCache = /* @__PURE__ */ new Map();
function fileText(root, rel2) {
  const key = `${root}\0${rel2}`;
  if (!fileCache.has(key)) {
    const p = pjoin(root, rel2);
    fileCache.set(key, isFile(p) ? readTextIgnore(p) : null);
  }
  return fileCache.get(key);
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findSymbol(text, symbol) {
  const lines = text.split("\n");
  const ident = /^[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*$/.test(symbol);
  if (!ident) {
    const i = lines.findIndex((l) => l.includes(symbol));
    return i + 1;
  }
  const parts = symbol.split(/\.|::/);
  const last = parts[parts.length - 1];
  const word = new RegExp(`(?<![\\w$])${escapeRe(last)}(?![\\w$])`);
  const def = new RegExp(
    `(?:function\\*?|class|def|interface|type|enum|const|let|var|async\\s+def|async\\s+function)\\s+${escapeRe(last)}(?![\\w$])|(?<![\\w$.])${escapeRe(last)}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function|\\w+\\s*=>|use[A-Z]\\w*\\()|^\\s*(?:(?:public|private|protected|static|async|export|readonly)\\s+)*${escapeRe(last)}\\s*\\(`
  );
  if (parts.length > 1) {
    const first = new RegExp(`(?<![\\w$])${escapeRe(parts[0])}(?![\\w$])`);
    if (!lines.some((l) => first.test(l))) return 0;
  }
  const d = lines.findIndex((l) => def.test(l));
  if (d >= 0) return d + 1;
  return lines.findIndex((l) => word.test(l)) + 1;
}
function checkAnchor(root, a) {
  const abs = pjoin(root, a.path);
  if (!exists(abs)) return { ...a, ok: false, reason: "文件不存在" };
  if (!a.symbol) return { ...a, ok: true };
  if (isDir(abs)) return { ...a, ok: false, reason: "目录不能带符号" };
  const text = fileText(root, a.path) ?? "";
  const line = findSymbol(text, a.symbol);
  return line ? { ...a, ok: true, line } : { ...a, ok: false, reason: `找不到 ${a.symbol}` };
}
function checkTest(root, a) {
  const abs = pjoin(root, a.path);
  if (!isFile(abs)) return { ...a, ok: false, reason: "测试文件不存在" };
  if (!a.symbol) return { ...a, ok: true };
  const text = fileText(root, a.path) ?? "";
  const i = text.split("\n").findIndex((l) => l.includes(a.symbol));
  return i >= 0 ? { ...a, ok: true, line: i + 1 } : { ...a, ok: false, reason: `测试里找不到「${a.symbol}」` };
}
function filesUnder(root, rel2) {
  const start = pjoin(root, rel2);
  if (isFile(start)) return [rel2.replace(/\/+$/, "")];
  if (!isDir(start)) return [];
  const out = [];
  const stack = [start];
  while (stack.length && out.length < MAX_SCAN_FILES) {
    const d = stack.pop();
    let kids;
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
function patternTester(pattern) {
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
var CODE_EXT = /\.(?:[cm]?[jt]sx?|py|ya?ml|sh|bash|css|scss|go|rs|java|kt|swift|rb|toml)$/i;
var COMMENT_LINE = /^\s*(?:\/\/|#(?!!)|\/?\*|<!--)/;
function scanPattern(root, c, forbid) {
  const test = patternTester(c.pattern);
  const missing = c.paths.filter((p) => !exists(pjoin(root, p)));
  if (missing.length) return { ...c, ok: false, hits: [], reason: `路径不存在: ${missing.join(", ")}` };
  const hits = [];
  for (const p of c.paths) {
    for (const f of filesUnder(root, p)) {
      const text = fileText(root, f);
      if (text === null || text.includes("\0")) continue;
      const lines = text.split("\n");
      const code = CODE_EXT.test(f);
      for (let i = 0; i < lines.length; i++) {
        if (code && COMMENT_LINE.test(lines[i])) continue;
        if (!test(lines[i])) continue;
        hits.push(`${f}:${i + 1}`);
        if (!forbid || hits.length >= MAX_HITS) break;
      }
      if (hits.length >= MAX_HITS || !forbid && hits.length) break;
    }
    if (!forbid && hits.length) break;
  }
  return { ...c, hits, ok: forbid ? hits.length === 0 : hits.length > 0 };
}
function checkEntries(root, entries) {
  fileCache.clear();
  return entries.map((e) => {
    const anchors = e.anchors.map((a) => checkAnchor(root, a));
    const tests = e.tests.map((a) => checkTest(root, a));
    const forbidden = e.forbidden.map((c) => scanPattern(root, c, true));
    const required = e.required.map((c) => scanPattern(root, c, false));
    const problems = [];
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
    let verdict = problems.length ? "fail" : "ok";
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
function covers(path, file) {
  const p = path.replace(/\/+$/, "");
  return file === p || file.startsWith(p + "/");
}
function lastPart2(symbol) {
  const parts = symbol.split(/\.|::/);
  return parts[parts.length - 1];
}
function recentDiffs(root, n) {
  const log = runGit(["log", `-${n}`, "--no-merges", "-p", "-U0", "--no-color", "--format=%x1e%h%x1f%s"], root);
  if (!log) return [];
  const out = [];
  for (const rec of log.split("")) {
    const nl = rec.indexOf("\n");
    const head = nl < 0 ? rec : rec.slice(0, nl);
    if (!head.includes("")) continue;
    const [commit, subject] = head.split("");
    if (subject.includes("[skip ci]")) continue;
    const files = /* @__PURE__ */ new Map();
    let cur = null;
    for (const line of (nl < 0 ? "" : rec.slice(nl + 1)).split("\n")) {
      const d = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (d) {
        const file = d[2];
        cur = file === BUSINESS_FILE || file === "PROJECT_BLUEPRINT.md" ? null : { changed: "", ranges: [] };
        if (cur) files.set(file, cur);
        continue;
      }
      if (!cur) continue;
      const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (h) {
        const start = Number(h[1]);
        const count = h[2] === void 0 ? 1 : Number(h[2]);
        cur.ranges.push(count ? [start, start + count - 1] : [start, start + 1]);
      } else if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
        cur.changed += "\n" + line.slice(1);
      }
    }
    if (files.size) out.push({ commit, subject, files });
  }
  return out;
}
function blockSpan(lines, line) {
  const indent = (l) => l.length - l.trimStart().length;
  const base = indent(lines[line - 1] ?? "");
  let end = line;
  for (let i = line; i < lines.length; i++) {
    const l = lines[i];
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
function touches(root, e, c, versions) {
  for (const [file, diff] of c.files) {
    for (const a of e.anchors) {
      if (!covers(a.path, file)) continue;
      if (!a.symbol) return true;
      const name = lastPart2(a.symbol);
      if (diff.changed.includes(name)) return true;
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
function recentImpact(root, entries, n = 8) {
  const out = [];
  for (const c of recentDiffs(root, n)) {
    const versions = /* @__PURE__ */ new Map();
    const ids = entries.filter((e) => touches(root, e, c, versions)).map((e) => e.id);
    if (ids.length) out.push({ commit: c.commit, subject: c.subject, ids: [...new Set(ids)] });
  }
  return out;
}
function checkBusinessBlueprint(root, text) {
  const file = pjoin(root, BUSINESS_FILE);
  const body = text ?? (isFile(file) ? readTextIgnore(file) : null);
  if (body === null) return null;
  const parsed = parseBusinessBlueprint(body);
  if (!parsed.length) return null;
  const entries = checkEntries(root, parsed);
  const counts = { term: 0, flow: 0, rule: 0, state: 0 };
  const rules = { ok: 0, warn: 0, fail: 0 };
  for (const e of entries) {
    counts[e.kind]++;
    if (e.kind === "rule") rules[e.verdict]++;
  }
  const seen = /* @__PURE__ */ new Set();
  const duplicates = [];
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
    duplicates
  };
}
var MARK = { ok: "✅", warn: "⚠️", fail: "❌" };
function summaryLine(r) {
  const c = r.counts;
  return `规则 ${c.rule}（✅ ${r.rules.ok} · ⚠️ ${r.rules.warn} · ❌ ${r.rules.fail}）· 流程 ${c.flow} · 术语 ${c.term} · 状态 ${c.state}`;
}
function problemLines(r, limit = Infinity) {
  const out = [];
  for (const id of r.duplicates) out.push(`- ❌ \`${id}\`：编号重复`);
  for (const e of r.entries) {
    if (e.verdict === "ok") continue;
    out.push(`- ${MARK[e.verdict]} \`${e.id}\` ${e.title}（L${e.line}）：${e.problems.join("；")}`);
  }
  if (out.length > limit) return [...out.slice(0, limit), `- …… 还有 ${out.length - limit} 条，见 ${BUSINESS_FILE} 末尾「自动核对」`];
  return out;
}
function renderCheckRegion(r) {
  const lines = [
    CHECK_START,
    "## 自动核对 (Auto Check)",
    "",
    "> 生成器随每次提交核对：代码位置还在不在、测试还在不在、禁止 / 要求的写法满不满足。✅ 通过 · ⚠️ 缺代码位置、测试或来源 · ❌ 位置失效或违反规则（CI 会拦下）。",
    "",
    `- 汇总：${summaryLine(r)}`,
    "",
    "| 编号 | 名称 | 代码位置 | 测试 | 检查 | 结论 |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |"
  ];
  for (const e of r.entries) {
    const okA = e.anchors.filter((a) => a.ok).length;
    const okT = e.tests.filter((a) => a.ok).length;
    const checks = e.forbidden.length + e.required.length;
    const okC = e.forbidden.filter((c) => c.ok).length + e.required.filter((c) => c.ok).length;
    const frac = (ok, all) => all ? `${ok}/${all}` : "—";
    lines.push(`| \`${e.id}\` | ${e.title.replace(/\|/g, "\\|")} | ${frac(okA, e.anchors.length)} | ${frac(okT, e.tests.length)} | ${frac(okC, checks)} | ${MARK[e.verdict]} |`);
  }
  const problems = problemLines(r);
  lines.push("", "### 需要处理", "", ...problems.length ? problems : ["- 没有。"], CHECK_END);
  return lines;
}
function renderIndex(r, sections) {
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
    INDEX_END
  ];
}
function stripRegion(lines, start, end) {
  const s = lines.findIndex((l) => l.startsWith(start));
  if (s < 0) return { lines, at: -1 };
  let e = lines.findIndex((l, i) => i > s && l.startsWith(end));
  if (e < 0) e = s;
  return { lines: [...lines.slice(0, s), ...lines.slice(e + 1)], at: s };
}
function refreshBusinessText(root, text) {
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  const idx = stripRegion(lines, INDEX_START, INDEX_END);
  lines = idx.lines;
  lines = stripRegion(lines, CHECK_START, CHECK_END).lines;
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let at = idx.at;
  if (at < 0) {
    const title = lines.findIndex((l) => l.startsWith("# "));
    at = title < 0 ? 0 : title + 1;
    if (lines[at] !== void 0 && !lines[at].trim()) at++;
  }
  const report = checkBusinessBlueprint(root, lines.join("\n"));
  if (!report) return null;
  const indexLen = renderIndex(report, Array.from({ length: lines.slice(at).filter((l) => l.startsWith("## ")).length + 1 }, () => ({ title: "", start: 0, end: 0 }))).length;
  for (const e of report.entries) if (e.line > at) e.line += indexLen;
  const check = renderCheckRegion(report);
  const headingsAfter = lines.slice(at).filter((l) => l.startsWith("## ")).length + 1;
  const placeholder = renderIndex(report, Array.from({ length: headingsAfter }, () => ({ title: "", start: 0, end: 0 })));
  const out = [...lines.slice(0, at), ...placeholder, ...lines.slice(at), "", ...check, ""];
  const starts = [];
  for (let i = at + placeholder.length; i < out.length; i++) if (out[i].startsWith("## ")) starts.push(i);
  const sections = starts.map((s, n) => {
    let end = (n + 1 < starts.length ? starts[n + 1] : out.length) - 1;
    while (end > s && (!out[end].trim() || out[end].startsWith("<!-- memento:"))) end--;
    return { title: out[s].replace(/^##\s+/, ""), start: s + 1, end: end + 1 };
  });
  const index = renderIndex(report, sections);
  out.splice(at, placeholder.length, ...index);
  return { text: out.join("\n"), report };
}
function refreshBusinessBlueprint(root) {
  const file = pjoin(root, BUSINESS_FILE);
  if (!isFile(file)) return null;
  const res = refreshBusinessText(root, readTextIgnore(file));
  if (!res) return null;
  atomicWrite(file, res.text);
  return res.report;
}
function projectBlueprintSection(r) {
  const lines = [
    "## 11. 业务蓝图核对 (Business Blueprint Check)",
    "",
    `- 业务蓝图：[${BUSINESS_FILE}](${BUSINESS_FILE}) · ${summaryLine(r)}`,
    `- 结论：${r.fails ? `❌ ${r.fails} 条位置失效或违反规则` : "✅ 没有失效或违规"}${r.warns ? ` · ⚠️ ${r.warns} 条缺测试 / 代码位置 / 来源` : ""}`
  ];
  const problems = problemLines(r, 12);
  if (problems.length) lines.push("", "### 需要处理", "", ...problems);
  if (r.impact.length) {
    lines.push("", "### 最近提交碰到的业务条目（改动后复查它们还成不成立）", "");
    for (const it of r.impact) lines.push(`- \`${it.commit}\` ${it.subject.slice(0, 80)} → ${it.ids.map((id) => `\`${id}\``).join(", ")}`);
  }
  return lines;
}
function formatReport(r) {
  const out = [`${BUSINESS_FILE}: ${summaryLine(r)}`];
  const problems = problemLines(r);
  out.push(...problems.length ? problems : ["全部通过。"]);
  if (r.impact.length) {
    out.push("最近提交碰到的条目:");
    for (const it of r.impact) out.push(`  ${it.commit} ${it.subject.slice(0, 70)} → ${it.ids.join(", ")}`);
  }
  return out.join("\n");
}
function businessSkeleton(name) {
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
    ""
  ].join("\n");
}

// packages/daemon/src/blueprint/content.ts
function generateMermaidDiagram(subsystems, _stack, infra = [], pkgEdges = []) {
  const lines = ["```mermaid", "flowchart TD"];
  const hasWeb = subsystems.some((s) => s.name.includes("apps/web"));
  const hasDesktop = subsystems.some((s) => s.name.includes("apps/desktop"));
  const hasDaemon = subsystems.some((s) => s.name.includes("packages/daemon"));
  const hasMcp = subsystems.some((s) => s.name.includes("packages/mcp"));
  const hasServer = subsystems.some((s) => s.name === "server" || s.name.includes("server/"));
  const hasEmb = subsystems.some((s) => s.name.includes("embedding"));
  if (!(hasWeb || hasDesktop || hasDaemon || hasMcp)) {
    lines.push('    subgraph Modules["项目核心模块与子系统"]');
    const nodeMap = /* @__PURE__ */ new Map();
    const clientNodes = [];
    const serviceNodes = [];
    const otherNodes = [];
    subsystems.slice(0, 10).forEach((sub, idx) => {
      const nid = `M${idx}`;
      nodeMap.set(sub.path, nid);
      nodeMap.set(sub.name, nid);
      const safeLabel = sub.name.split('"').join("'");
      lines.push(`        ${nid}["${safeLabel} (${sub.type})"]`);
      const roleLow = sub.type.toLowerCase();
      if (["frontend", "client", "desktop", "web"].some((k) => roleLow.includes(k))) clientNodes.push(nid);
      else if (["backend", "api", "engine", "quant", "core", "transport"].some((k) => roleLow.includes(k))) serviceNodes.push(nid);
      else if (!["doc", "test", "container", "kubernetes", "infrastructure"].some((k) => roleLow.includes(k))) otherNodes.push(nid);
    });
    lines.push("    end");
    if (infra.length) {
      lines.push('    subgraph Infra["外部存储与中间件"]');
      infra.slice(0, 6).forEach((inf, i) => lines.push(`        INF${i}[("${inf}")]`));
      lines.push("    end");
    }
    let addedRealEdge = false;
    for (const pe of pkgEdges) {
      const m = reMatch("`([^`]+)`\\s*➔\\s*`([^`]+)`", pe);
      const src = m ? nodeMap.get(m.g(1)) : void 0;
      const dst = m ? nodeMap.get(m.g(2)) : void 0;
      if (src !== void 0 && dst !== void 0) {
        lines.push(`    ${src} --> ${dst}`);
        addedRealEdge = true;
      }
    }
    if (!addedRealEdge) {
      if (clientNodes.length && serviceNodes.length) {
        for (const cn of clientNodes) lines.push(`    ${cn} --> ${serviceNodes[0]}`);
        for (const sn of serviceNodes.slice(1)) lines.push(`    ${serviceNodes[0]} --> ${sn}`);
      } else if (serviceNodes.length >= 2) {
        for (const sn of serviceNodes.slice(1)) lines.push(`    ${serviceNodes[0]} --> ${sn}`);
      } else if (serviceNodes.length && otherNodes.length) {
        for (const on of otherNodes.slice(0, 3)) lines.push(`    ${serviceNodes[0]} --> ${on}`);
      }
    }
    const primaryService = serviceNodes[0] ?? clientNodes[0] ?? (subsystems.length ? "M0" : "");
    if (infra.length && primaryService) {
      for (let i = 0; i < Math.min(infra.length, 6); i++) lines.push(`    ${primaryService} -.-> INF${i}`);
    }
    lines.push("```");
    return lines.join("\n");
  }
  lines.push('    subgraph Clients["终端与接入层"]');
  if (hasWeb) lines.push('        WEB["Web 前端 (Next.js / React)"]');
  if (hasDesktop) lines.push('        DESK["桌面客户端 (Electron)"]');
  if (hasMcp) lines.push('        MCP["Memento MCP Server (Claude/Antigravity/Codex)"]');
  lines.push("    end", "");
  if (hasDaemon) {
    lines.push('    subgraph Devices["物理设备守护层"]', '        DAEMON["@memento/daemon (节点执行器 / 文件与会话采集)"]', "    end", "");
  }
  if (hasServer || hasEmb) {
    lines.push('    subgraph CoreBackend["后端中枢与智能计算"]');
    if (hasServer) {
      lines.push('        API["FastAPI 异步主服务 (REST / SSE / WS)"]', '        CELERY["Celery 异步 Worker (会话整理 / 梦境提炼 / 任务收割)"]');
    }
    if (hasEmb) lines.push('        EMB["向量推理服务 (Embedding Pipeline)"]');
    lines.push("    end", "");
  }
  lines.push(
    '    subgraph Storage["数据持久化与缓存集群"]',
    '        PG[("PostgreSQL 向量与全量知识库 (JSONB + pgvector)")]',
    '        REDIS[("Redis 缓存 / 分布式锁 / 任务总线")]',
    "    end",
    ""
  );
  if (hasWeb && hasServer) lines.push("    WEB -->|HTTP / SSE / WebSocket| API");
  if (hasDesktop && hasServer) lines.push("    DESK -->|HTTP / 自动更新通道| API");
  if (hasMcp && hasServer) lines.push("    MCP -->|API RPC 查询 / 蓝图与规则注入| API");
  if (hasDaemon && hasServer) lines.push("    DAEMON -->|长连接心跳 / 采集数据流推入 / 远程任务回传| API");
  if (hasServer) {
    lines.push(
      "    API -->|读写会话、实体、向量| PG",
      "    API -->|缓存会话字典、租约分发| REDIS",
      "    CELERY -->|异步任务编排| REDIS",
      "    CELERY -->|离线提炼、梦境知识归纳| PG"
    );
  }
  if (hasServer && hasEmb) lines.push("    API -->|文本向量化| EMB", "    CELERY -->|离线图嵌入| EMB");
  lines.push("```");
  return lines.join("\n");
}
function repoName(root) {
  let name = pname(root);
  const pjson = pjoin(root, "package.json");
  if (exists(pjson)) {
    try {
      const data = loads(readTextIgnore(pjson));
      if (!isDict(data)) throw new TypeError("'get' on a non-dict");
      const n = pyGet(data, "name");
      if (typeof n === "string" && n) {
        const parts = n.split("/");
        name = parts[parts.length - 1];
      }
    } catch {
    }
  }
  return name;
}
function gitBranch(root) {
  let branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], root) || "main";
  if (branch === "HEAD") {
    const tagName = runGit(["describe", "--tags", "--exact-match"], root);
    const containsOut = runGit(["branch", "--contains", "HEAD", "--format=%(refname:short)"], root);
    const branchLines = pySplitlines(containsOut).filter((b) => pyStrip(b) && !pyStrip(b).startsWith("(")).map((b) => pyStrip(b));
    branch = tagName || (branchLines[0] ?? "detached-HEAD");
  }
  return branch;
}
function buildBlueprintContent(root) {
  clearRepoFileCache(root);
  const name = repoName(root);
  const branch = gitBranch(root);
  const commit = runGit(["rev-parse", "--short", "HEAD"], root) || "unknown";
  const date = runGit(["log", "-1", "--format=%as"], root) || "recent";
  const stack = detectTechStack(root);
  const about = detectProjectAbout(root);
  const subsystems = scanSubsystems(root);
  const frontendRoutes = scanFrontendRoutes(root);
  const routes = scanApiRoutes(root);
  const { models, relations, unique_constraints: uniqueConstraints } = scanDataModels(root);
  const erDiagram = generateErDiagram(relations);
  const { services, schedules } = scanServicesAndSchedules(root);
  const { mcp_tools: mcpTools, ws_events: wsEvents, rpc_contracts: rpcContracts } = scanMcpAndWsProtocols(root);
  const cicdItems = scanCicdAndDeploy(root);
  const { hotspots, test_suites: testSuites } = scanHotspotsAndTests(root);
  const { package_edges: pkgEdges, call_edges: callEdges } = scanAstCallGraphAndDeps(root);
  const dtoSchemas = scanOpenapiAndDtoSchemas(root);
  const cliEntries = scanCliAndEntrypoints(root);
  const infraList = scanExternalInfra(root);
  const envVars = scanEnvVariables(root);
  const mermaidDiagram = generateMermaidDiagram(subsystems, stack, infraList, pkgEdges);
  const evolutionList = getGitEvolution(root, 6);
  const doc = [
    `# Project Blueprint: ${name}`,
    "",
    "> [!NOTE]",
    `> **Living Blueprint Auto-Generated** · Branch: \`${branch}\` · Commit: \`${commit}\` · Updated: \`${date}\``,
    "> An architectural map of the codebase for AI coding agents (Claude Code, Codex, Antigravity, Cursor, ...).",
    "> Read section 0 first; open other sections by the line ranges it lists instead of reading the whole file.",
    "",
    "## 1. Project Overview & Tech Stack",
    "",
    ...about ? [`- **About**: ${about}`] : [],
    `- **Project Type**: ${stack.project_type}`,
    `- **Core Languages**: ${stack.languages.length ? stack.languages.join(", ") : "Generic"}`,
    `- **Key Frameworks**: ${stack.frameworks.length ? stack.frameworks.join(", ") : "None detected"}`,
    `- **Infrastructure & Middleware**: ${infraList.length ? infraList.join(", ") : "Standard local runtime"}`,
    "",
    "## 2. High-Level Architecture Topology",
    "",
    mermaidDiagram,
    "",
    "## 3. Subsystem Breakdown & Responsibilities",
    "",
    "| Subsystem / Path | Category | Role & Purpose |",
    "| :--- | :--- | :--- |"
  ];
  for (const s of subsystems) doc.push(`| [\`${s.name}\`](${s.path}) | ${s.type} | ${s.description} |`);
  doc.push("");
  if (frontendRoutes.length || routes.length || models.length || relations.length || uniqueConstraints.length) {
    doc.push("## 4. Key Entry Points & API Endpoints", "");
  }
  if (frontendRoutes.length) {
    doc.push("### Frontend Pages & App Router", "");
    for (const f of frontendRoutes) doc.push(`- \`${f}\``);
    doc.push("");
  }
  if (routes.length) {
    doc.push("### Registered API Routers & Endpoints", "");
    for (const r of routes) {
      const rfile = r.file || `${r.name}.py`;
      doc.push(`#### \`${r.prefix}\` (${rfile})`);
      if (r.endpoints.length) {
        doc.push("");
        for (const ep of r.endpoints) doc.push(`- ${ep}`);
        if (r.total > r.endpoints.length) doc.push(`- _... (${r.total - r.endpoints.length} more endpoints)_`);
      }
      doc.push("");
    }
  }
  if (models.length) {
    doc.push("### Core Database Models (`models.py`)", "", models.map((m) => `\`${m}\``).join(", "), "");
  }
  if (relations.length) {
    doc.push("#### Key Entity Relationships (Foreign Keys)", "");
    if (erDiagram) doc.push(erDiagram, "");
    for (const rel2 of relations) doc.push(`- ${rel2}`);
    doc.push("");
  }
  if (uniqueConstraints.length) {
    doc.push("#### Deduplication & Uniqueness Constraints", "");
    for (const uq of uniqueConstraints) doc.push(`- ${uq}`);
    doc.push("");
  }
  if (services.length || schedules.length) {
    doc.push("## 5. Core Domain Services & Background Schedules", "");
    if (schedules.length) {
      doc.push("### Scheduled Background Jobs (Celery Beat / Cron)", "", "| Job Name | Target Task | Schedule |", "| :--- | :--- | :--- |");
      for (const sch of schedules) doc.push(`| \`${sch.name}\` | \`${sch.task}\` | \`${sch.schedule}\` |`);
      doc.push("");
    }
    if (services.length) {
      doc.push("### Core Service Layer Modules", "", "| Service Module | Path | Responsibility |", "| :--- | :--- | :--- |");
      for (const svc of services) doc.push(`| \`${svc.name}\` | [\`${svc.path}\`](${svc.path}) | ${svc.summary} |`);
      doc.push("");
    }
  }
  if (mcpTools.length || wsEvents.length || rpcContracts.length) {
    doc.push("## 6. MCP Tools, RPC Contracts & Real-Time WebSocket Protocols", "");
    if (mcpTools.length) {
      doc.push("### Registered MCP Server Tools", "", "| Tool Name | Purpose |", "| :--- | :--- |");
      for (const mt of mcpTools) doc.push(`| \`${mt.name}\` | ${mt.description} |`);
      doc.push("");
    }
    if (rpcContracts.length) {
      doc.push("### gRPC & GraphQL Service Contracts", "");
      for (const rc of rpcContracts) doc.push(`- ${rc}`);
      doc.push("");
    }
    if (wsEvents.length) {
      doc.push("### WebSocket Control & Data Plane Events", "", wsEvents.map((ev) => `\`${ev}\``).join(", "), "");
    }
  }
  if (pkgEdges.length || callEdges.length || dtoSchemas.length || cliEntries.length) {
    doc.push("## 6.5. AST Call Graph, DTO Schemas & CLI Entrypoints", "");
    if (pkgEdges.length) {
      doc.push("### Workspace Package Dependency Graph", "");
      for (const pe of pkgEdges) doc.push(`- ${pe}`);
      doc.push("");
    }
    if (callEdges.length) {
      doc.push("### AST Cross-Layer Call & Import Graph (Entry ➔ Service / Store)", "");
      for (const ce of callEdges) doc.push(`- ${ce}`);
      doc.push("");
    }
    if (dtoSchemas.length) {
      doc.push(
        "### Key Request / Response DTO & OpenAPI Schemas",
        "",
        "| Schema Name | Type | Source File | Core Fields |",
        "| :--- | :--- | :--- | :--- |"
      );
      for (const ds of dtoSchemas) doc.push(`| \`${ds.name}\` | ${ds.kind} | [\`${ds.source}\`](${ds.source}) | ${ds.fields} |`);
      doc.push("");
    }
    if (cliEntries.length) {
      doc.push("### CLI Binaries & Automation Entrypoints", "", "| Command / Script | Category | Path / Target |", "| :--- | :--- | :--- |");
      for (const ce of cliEntries) doc.push(`| \`${ce.name}\` | ${ce.kind} | \`${ce.path}\` |`);
      doc.push("");
    }
  }
  if (cicdItems.length || hotspots.length || testSuites.length) {
    doc.push("## 7. CI/CD Pipelines, Code Hotspots & Test Suites", "");
    if (cicdItems.length) {
      doc.push("### CI/CD Workflows & Deployment Manifests", "", "| Category | Name | Path | Details |", "| :--- | :--- | :--- | :--- |");
      for (const ci of cicdItems) doc.push(`| ${ci.kind} | \`${ci.name}\` | [\`${ci.path}\`](${ci.path}) | ${ci.details} |`);
      doc.push("");
    }
    if (testSuites.length) {
      doc.push("### Automated Test Suite Matrix", "", "| Suite | Directory | Files | Sample Tests |", "| :--- | :--- | :--- | :--- |");
      for (const ts of testSuites) doc.push(`| ${ts.suite} | [\`${ts.dir}\`](${ts.dir}) | ${ts.count} | ${ts.samples} |`);
      doc.push("");
    }
    if (hotspots.length) {
      doc.push("### Architectural Hotspots (Top Modified Files in Recent 40 Commits)", "");
      for (const hs of hotspots) doc.push(`- [\`${hs.path}\`](${hs.path}) (${hs.commits} commits)`);
      doc.push("");
    }
  }
  doc.push(
    "## 8. Development & Verification Commands",
    "",
    "```bash",
    ...detectVerificationCommands(root),
    "```",
    "",
    "## 9. Recent Architectural Evolutions",
    ""
  );
  if (evolutionList.length) doc.push(...evolutionList);
  else doc.push("- Initial project baseline established.");
  if (envVars.length) {
    doc.push("", "## 10. Key Environment Variables & Configuration", "", "| Variable | Default / Status | Description |", "| :--- | :--- | :--- |");
    for (const ev of envVars.slice(0, 20)) doc.push(`| \`${ev.name}\` | \`${ev.default}\` | ${ev.description} |`);
  }
  const business = checkBusinessBlueprint(root);
  if (business) doc.push("", ...projectBlueprintSection(business));
  doc.push(
    "",
    "---",
    `${GENERATED_MARK} (v${BLUEPRINT_SCRIPT_VERSION}) & \`.git/hooks/(post-commit, post-merge, post-checkout)\`. Updates automatically on code modifications, pulls, and branch switches._`,
    ""
  );
  const summary = quickSummary({
    stack,
    infra: infraList,
    subsystems,
    routes,
    frontendRoutes,
    models,
    services,
    schedules,
    testSuites,
    commands: detectVerificationCommands(root),
    evolution: evolutionList,
    about,
    business
  });
  return withSummaryAndIndex(doc, summary);
}
function quickSummary(x) {
  const langs = x.stack.languages.join(", ") || "Generic";
  const frameworks = x.stack.frameworks.slice(0, 8).join(", ");
  const lines = [
    ...x.about ? [`- 简介 (About): ${x.about}`] : [],
    `- 类型 (Type): ${x.stack.project_type || "Generic"}`,
    `- 技术栈 (Stack): ${langs}` + (frameworks ? ` · ${frameworks}` : "")
  ];
  if (x.infra.length) lines.push(`- 基础设施 (Infra): ${x.infra.slice(0, 8).join(", ")}`);
  const scale = [`${x.subsystems.length} 个子系统`];
  if (x.routes.length) {
    const endpoints = x.routes.reduce((n, r) => n + (r.total || 0), 0);
    scale.push(`${x.routes.length} 组 API 路由 / ${endpoints} 个接口`);
  }
  if (x.frontendRoutes.length) scale.push(`${x.frontendRoutes.length} 个前端页面`);
  if (x.models.length) scale.push(`${x.models.length} 个数据模型`);
  if (x.services.length) scale.push(`${x.services.length} 个服务模块`);
  if (x.schedules.length) scale.push(`${x.schedules.length} 个定时任务`);
  const tests = x.testSuites.reduce((n, ts) => n + (ts.count || 0), 0);
  if (tests) scale.push(`${tests} 个测试文件`);
  lines.push(`- 规模 (Scale): ${scale.join(" · ")}`);
  const names = x.subsystems.filter((s) => s.name).map((s) => s.name).slice(0, 12);
  if (names.length) lines.push(`- 子系统 (Subsystems): ${names.map((n) => `\`${n}\``).join(", ")}`);
  const runnable = x.commands.filter((c) => pyStrip(c) && !pyLstrip(c).startsWith("#")).map((c) => pyStrip(c)).slice(0, 4);
  if (runnable.length) lines.push(`- 自测命令 (Verify): ${runnable.map((c) => `\`${c}\``).join(" ; ")}`);
  if (x.evolution.length) lines.push(`- 最近改动 (Latest): ${pySlice(pyStrip(pyLstrip(x.evolution[0], "- ")), 0, 160)}`);
  if (x.business) {
    const b = x.business;
    const touched = [...new Set(b.impact.slice(0, 3).flatMap((it) => it.ids))].slice(0, 8);
    lines.push(
      `- 业务蓝图 (Business): \`${BUSINESS_FILE}\` · ${summaryLine(b)}${b.fails ? ` · ❌ ${b.fails} 条失效/违规` : ""}` + (touched.length ? ` · 最近提交碰到 ${touched.map((id) => `\`${id}\``).join(", ")}` : "")
    );
  }
  return lines;
}
function withSummaryAndIndex(docLines, summary) {
  const doc = docLines.join("\n").split("\n");
  let first = doc.findIndex((line) => line.startsWith("## "));
  if (first < 0) first = doc.length;
  const headings = doc.slice(first).filter((line) => line.startsWith("## ")).length;
  const block = [
    "## 0. 速览与章节索引 (Quick Summary & Section Index)",
    "",
    "> 先读这一节定位全局；要细节时按下表行号只读对应章节（Read 的 offset/limit，或 `sed -n 'A,Bp' PROJECT_BLUEPRINT.md`），不必整份读入。",
    "",
    ...summary,
    "",
    "| 章节 (Section) | 行号 (Lines) |",
    "| :--- | :--- |"
  ];
  const rowsAt = first + block.length;
  for (let i = 0; i < headings; i++) block.push("");
  block.push("");
  const out = [...doc.slice(0, first), ...block, ...doc.slice(first)];
  const starts = [];
  for (let i = rowsAt + headings; i < out.length; i++) if (out[i].startsWith("## ")) starts.push(i);
  let footer = out.lastIndexOf("---");
  if (footer < 0) footer = out.length;
  starts.forEach((start, n) => {
    let end = (n + 1 < starts.length ? starts[n + 1] : footer) - 1;
    while (end > start && !pyStrip(out[end])) end--;
    const title = reSub("^##\\s+", "", out[start]);
    out[rowsAt + n] = `| ${title} | L${start + 1}-L${end + 1} |`;
  });
  return out.join("\n");
}

// packages/daemon/src/blueprint/repo.ts
import fs2 from "node:fs";
import { fileURLToPath } from "node:url";
var EXCLUDE_MARK = "# memento:blueprint (generated locally, not tracked)";
var ANCHOR_MARKER = "<!-- memento:blueprint-anchor -->";
function gitPath(root, flag) {
  const out = runGit(["rev-parse", flag], root);
  if (out) {
    const p = toPosix(out);
    return resolvePath(/^(?:[A-Za-z]:)?\//.test(p) ? p : pjoin(root, p));
  }
  const dotGit = pjoin(root, ".git");
  return isDir(dotGit) ? dotGit : null;
}
function isTracked(root) {
  return gitOk(["ls-files", "--error-unmatch", "--", BLUEPRINT_FILE], root);
}
function isGenerated(p) {
  let text;
  try {
    text = readTextIgnore(p);
  } catch {
    return false;
  }
  return text.startsWith("# Project Blueprint:") && (text.includes(GENERATED_MARK) || text.includes(LEGACY_GENERATED_MARK));
}
function stateDir() {
  return pjoin(homeDir(), ".memento", "blueprint_repos");
}
function stateFile(root) {
  return pjoin(stateDir(), `${sha1Hex(toNative(resolvePath(root))).slice(0, 16)}.json`);
}
function loadState(root) {
  try {
    const data = loads(readTextStrict(stateFile(root)));
    return isDict(data) ? data : /* @__PURE__ */ new Map();
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function recordState(root, changes) {
  const state = loadState(root);
  state.set("root", toNative(resolvePath(root)));
  for (const [key, value] of Object.entries(changes)) {
    if (Array.isArray(value)) {
      const prev = state.get(key);
      const merged = /* @__PURE__ */ new Set([...pyIter(truthy(prev) ? prev : []), ...value]);
      const items = [...merged];
      if (items.some((x) => typeof x !== "string")) throw new TypeError("'<' not supported between mixed types");
      state.set(key, items.sort(cmpStr));
    } else {
      state.set(key, value);
    }
  }
  try {
    const path = stateFile(root);
    fs2.mkdirSync(toNative(pparent(path)), { recursive: true });
    atomicWrite(path, dumps(state) + "\n");
  } catch {
  }
}
var GUIDANCE_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".clinerules", ".github/copilot-instructions.md"];
function ensureAgentGuidanceAnchor(root) {
  const anchorSnippet = `${ANCHOR_MARKER}
> [!TIP]
> **架构心智指引**：新会话或全局重构前，先读根目录活体代码蓝图 [PROJECT_BLUEPRINT.md](PROJECT_BLUEPRINT.md) 开头的「0. 速览与章节索引」，再按行号只读需要的章节，避免重复 grep 扫描。
${ANCHOR_MARKER}

`;
  const modified = [];
  for (const rel2 of GUIDANCE_FILES) {
    const gf = pjoin(root, rel2);
    if (!exists(gf)) continue;
    try {
      const text = readTextIgnore(gf);
      if (text.includes(BLUEPRINT_FILE)) continue;
      const lines = pySplitlines(text, true);
      const newText = lines.length && lines[0].startsWith("#") ? lines[0] + "\n" + anchorSnippet + lines.slice(1).join("") : anchorSnippet + text;
      atomicWrite(gf, newText);
      modified.push(rel2);
    } catch {
    }
  }
  if (modified.length) recordState(root, { anchors: modified });
  return modified;
}
function removeAgentGuidanceAnchor(root, files) {
  const snippet = String.raw`${reEscape(ANCHOR_MARKER)}\n[\s\S]*?${reEscape(ANCHOR_MARKER)}\n\n?`;
  for (const rel2 of files) {
    const gf = pjoin(root, rel2);
    let text;
    try {
      text = readTextStrict(gf);
    } catch {
      continue;
    }
    if (!text.includes(ANCHOR_MARKER)) continue;
    let [cleaned, n] = reSubn(String.raw`^(#[^\n]*\n)\n${snippet}`, String.raw`\1`, text, 1);
    if (!n) [cleaned, n] = reSubn(`^${snippet}`, "", text, 1);
    if (!n) cleaned = reSub(snippet, "", text, 1);
    atomicWrite(gf, cleaned);
  }
}
function recordBlueprintHead(root) {
  const gitDir = gitPath(root, "--git-dir");
  if (!gitDir) return;
  try {
    const sha = runGit(["rev-parse", "--short", "HEAD"], root);
    if (sha) atomicWrite(pjoin(gitDir, HEAD_MARKER), pyStrip(sha) + "\n");
  } catch {
  }
}
function ensureExcluded(root) {
  const common = gitPath(root, "--git-common-dir");
  if (!common) return false;
  const exclude = pjoin(common, "info", "exclude");
  try {
    const text = exists(exclude) ? readTextStrict(exclude) : "";
    if (text.includes(EXCLUDE_MARK)) return true;
    if (gitOk(["check-ignore", "-q", "--", BLUEPRINT_FILE], root)) return false;
    fs2.mkdirSync(toNative(pparent(exclude)), { recursive: true });
    const sep = !text || text.endsWith("\n") ? "" : "\n";
    atomicWrite(exclude, `${text}${sep}${EXCLUDE_MARK}
/${BLUEPRINT_FILE}
`);
    return true;
  } catch (e) {
    if (!isOSError(e)) throw e;
    return false;
  }
}
function removeExcluded(root) {
  const common = gitPath(root, "--git-common-dir");
  const exclude = common ? pjoin(common, "info", "exclude") : null;
  if (!exclude || !isFile(exclude)) return;
  let text;
  try {
    text = readTextStrict(exclude);
  } catch {
    return;
  }
  if (text.includes(EXCLUDE_MARK)) {
    atomicWrite(exclude, reSub(String.raw`(?m)^${reEscape(EXCLUDE_MARK)}\n(?:/${reEscape(BLUEPRINT_FILE)}\n?)?`, "", text));
  }
}
function writeBlueprint(root, outPath = null) {
  const target = outPath ?? pjoin(root, BLUEPRINT_FILE);
  if (outPath === null && isFile(target) && !isGenerated(target)) return [target, false];
  const changed = atomicWrite(target, buildBlueprintContent(root));
  if (samePath(resolvePath(target), resolvePath(pjoin(root, BLUEPRINT_FILE)))) {
    try {
      refreshBusinessBlueprint(root);
    } catch {
    }
    recordBlueprintHead(root);
    const untracked = !isTracked(root);
    const excluded = untracked ? ensureExcluded(root) : false;
    recordState(root, { generated_untracked: untracked, ...excluded ? { excluded: true } : {} });
  }
  return [target, changed];
}
var scriptCandidates = [
  ["", `scripts/${SCRIPT_NAME}`],
  ["$MEMENTO_HOME", `$MEMENTO_HOME/scripts/${SCRIPT_NAME}`],
  ["", `$HOME/.memento/scripts/${SCRIPT_NAME}`],
  ["$USERPROFILE", `$USERPROFILE/.memento/scripts/${SCRIPT_NAME}`]
];
var HOOK_TEMPLATE = [
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
    return `    ${i === 0 ? "if" : "elif"} ${test}; then
        BP_SCRIPT="${path}"`;
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
  "            # BUSINESS_BLUEPRINT.md is staged with its refreshed check only when it has no unstaged edits of its own",
  '            BP_BIZ=""',
  "            if git ls-files --error-unmatch BUSINESS_BLUEPRINT.md >/dev/null 2>&1 && git diff --quiet -- BUSINESS_BLUEPRINT.md 2>/dev/null; then BP_BIZ=1; fi",
  '            ELECTRON_RUN_AS_NODE=1 "$BP_NODE" "$BP_SCRIPT" --root . --quiet >/dev/null 2>&1 && git add PROJECT_BLUEPRINT.md >/dev/null 2>&1 && { [ -z "$BP_BIZ" ] || git add BUSINESS_BLUEPRINT.md >/dev/null 2>&1; }',
  "        else",
  '            git rev-parse --short HEAD > "$GIT_DIR_PATH/.memento_blueprint_head" 2>/dev/null',
  "        fi",
  '    elif [ "$HOOK_NAME" != "pre-commit" ]; then',
  "        # Untracked: refreshed in the background so the git command returns at once",
  '        (ELECTRON_RUN_AS_NODE=1 "$BP_NODE" "$BP_SCRIPT" --root . --quiet </dev/null >/dev/null 2>&1 &)',
  "    fi",
  ") || true",
  "(exit $__memento_rc)",
  HOOK_MARKER_END
].join("\n");
var SH_SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
var SHEBANG_ONLY = /* @__PURE__ */ new Set(["", "#!/bin/sh", "#!/bin/bash", "#!/usr/bin/env sh", "#!/usr/bin/env bash"]);
function progName(word) {
  return pname(toPosix(word));
}
function hookIsShell(content) {
  const stripped = pyLstrip(content, "\uFEFF");
  if (!pyStrip(stripped)) return true;
  const first = pyStrip(pySplitlines(stripped)[0]);
  if (!first.startsWith("#!")) return true;
  const parts = pySplitWs(first.slice(2));
  if (!parts.length) return true;
  let prog = progName(parts[0]);
  if (prog === "env") {
    const args = parts.slice(1).filter((p) => !p.startsWith("-"));
    prog = args.length ? progName(args[0]) : "";
  }
  return SH_SHELLS.has(prog);
}
function cleanHookContent(content) {
  let cleaned = reSub(String.raw`\n*${reEscape(HOOK_MARKER_START)}[\s\S]*?${reEscape(HOOK_MARKER_END)}\n?`, "\n", content);
  cleaned = reSub(
    String.raw`# Auto-update PROJECT_BLUEPRINT\.md[^\n]*\n(?:[^\n]*\n)*?python3[^\n]*project_blueprint\.py[^\n]*\n(?:fi\n)?`,
    "",
    cleaned
  );
  const cleanLines = pySplitlines(cleaned).filter(
    (line) => !(line.includes("project_blueprint.py") && line.includes("python")) && !line.includes("# Auto-update PROJECT_BLUEPRINT.md")
  );
  const nonTrivial = cleanLines.filter((line) => pyStrip(line) && !pyStrip(line).startsWith("#!") && pyStrip(line) !== "fi");
  if (!nonTrivial.length) return "";
  return pyStrip(cleanLines.join("\n"));
}
function currentScript() {
  try {
    const p = toPosix(fileURLToPath(import.meta.url));
    return pname(p) === SCRIPT_NAME ? resolvePath(p) : null;
  } catch {
    return null;
  }
}
function syncGlobalScript() {
  try {
    const current = currentScript();
    const globalScript = pjoin(homeDir(), ".memento", "scripts", SCRIPT_NAME);
    if (!current || !isFile(current) || samePath(current, resolvePath(globalScript))) return;
    const curContent = readTextStrict(current);
    const existing = exists(globalScript) ? readTextStrict(globalScript) : "";
    if (existing === curContent || scriptVersionOf(existing) > BLUEPRINT_SCRIPT_VERSION) return;
    fs2.mkdirSync(toNative(pparent(globalScript)), { recursive: true });
    atomicWrite(globalScript, curContent);
    chmodExec(globalScript);
  } catch {
  }
}
function installGitHook(root) {
  if (!gitOk(["rev-parse", "--git-dir"], root)) {
    process.stderr.write(`Error: ${toNative(root)} is not a git repository.
`);
    return false;
  }
  syncGlobalScript();
  if (runGit(["config", "--get", "core.hooksPath"], root)) return true;
  const common = gitPath(root, "--git-common-dir");
  if (!common) return false;
  const hooksDir = pjoin(common, "hooks");
  try {
    fs2.mkdirSync(toNative(hooksDir), { recursive: true });
  } catch {
    return false;
  }
  const installed = [];
  let allOk = true;
  for (const hname of MANAGED_GIT_HOOKS) {
    const hookFile = pjoin(hooksDir, hname);
    if (isSymlink(hookFile)) continue;
    let existing;
    try {
      existing = exists(hookFile) ? readTextIgnore(hookFile) : "";
    } catch {
      allOk = false;
      continue;
    }
    if (!hookIsShell(existing)) continue;
    const cleaned = cleanHookContent(existing);
    const newContent = SHEBANG_ONLY.has(pyStrip(cleaned)) ? `#!/bin/sh

${HOOK_TEMPLATE}
` : `${pyRstrip(cleaned)}

${HOOK_TEMPLATE}
`;
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
function uninstallGitHook(root) {
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
        fs2.unlinkSync(toNative(hookFile));
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
function hasOurTraces(root) {
  if (exists(stateFile(root))) return true;
  const common = gitPath(root, "--git-common-dir");
  if (!common) return false;
  for (const hname of MANAGED_GIT_HOOKS) {
    try {
      if (readTextIgnore(pjoin(common, "hooks", hname)).includes(HOOK_MARKER_START)) return true;
    } catch {
    }
  }
  try {
    return readTextIgnore(pjoin(common, "info", "exclude")).includes(EXCLUDE_MARK);
  } catch {
    return false;
  }
}
function uninstallRepo(root) {
  const state = loadState(root);
  let ok = uninstallGitHook(root);
  const dirs = [];
  for (const d of [gitPath(root, "--git-dir"), gitPath(root, "--git-common-dir"), pjoin(root, ".git")]) {
    if (d && !dirs.some((x) => samePath(x, d))) dirs.push(d);
  }
  for (const d of dirs) {
    const marker = pjoin(d, HEAD_MARKER);
    if (isFile(marker)) {
      try {
        fs2.unlinkSync(toNative(marker));
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
      fs2.unlinkSync(toNative(bp));
    } catch {
      ok = false;
    }
  }
  try {
    fs2.rmSync(toNative(stateFile(root)), { force: true });
    if (!iterdir(stateDir()).length) fs2.rmdirSync(toNative(stateDir()));
  } catch {
  }
  return ok;
}
var DISCOVERY_BASES = ["dev", "Desktop/dev", "WorkBuddy", "projects", "workspace", "code", "repos"];
function childDirs(d) {
  return iterdir(d).filter((child) => isDir(child));
}
function discoverGitRoots() {
  const home = homeDir();
  const roots = [];
  const add = (p) => {
    const r = resolvePath(p);
    if (!roots.some((x) => samePath(x, r))) roots.push(r);
  };
  const visit = (d, depth) => {
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
    }
  };
  for (const rel2 of DISCOVERY_BASES) {
    const base = pjoin(home, rel2);
    if (!isDir(base)) continue;
    try {
      for (const child of childDirs(base)) visit(child, 1);
    } catch {
    }
  }
  return roots;
}
function uninstallAll(quiet = false) {
  const roots = [];
  const add = (r) => {
    if (!roots.some((x) => samePath(x, r))) roots.push(r);
  };
  const dir = stateDir();
  if (isDir(dir)) {
    for (const f of pglob(dir, "*.json")) {
      let root;
      try {
        const data = loads(readTextStrict(f));
        root = isDict(data) ? pyGet(data, "root") : void 0;
      } catch {
        root = void 0;
      }
      if (typeof root === "string" && isDir(toPosix(root))) add(toPosix(root));
      else fs2.rmSync(toNative(f), { force: true });
    }
  }
  for (const r of discoverGitRoots()) if (hasOurTraces(r)) add(r);
  let failed = 0;
  for (const r of sortedPaths(roots)) {
    if (uninstallRepo(r)) {
      if (!quiet) process.stdout.write(`Removed living blueprint & hooks from: ${toNative(r)}
`);
    } else {
      failed++;
      if (!quiet) process.stderr.write(`Could not fully clean ${toNative(r)}
`);
    }
  }
  try {
    if (isDir(dir) && !iterdir(dir).length) fs2.rmdirSync(toNative(dir));
  } catch {
  }
  return failed ? 1 : 0;
}
function bootstrapDiscoveredProjects(quiet = false, anchor = false) {
  const home = homeDir();
  const roots = [];
  const add = (r) => {
    if (!roots.some((x) => samePath(x, r))) roots.push(r);
  };
  for (const pf of [
    pjoin(home, ".claude", "CLAUDE.md"),
    pjoin(home, ".codex", "AGENTS.md"),
    pjoin(home, ".gemini", "GEMINI.md"),
    pjoin(home, ".memento", "mind_snapshot.json")
  ]) {
    if (!exists(pf)) continue;
    try {
      const text = readTextIgnore(pf);
      for (const m of reFinditer("####\\s+[^\\s（(]+[（(]`([^`]+)`[）)]", text)) {
        const cand = toPosix(pyStrip(m.g(1)));
        if (exists(pjoin(cand, ".git"))) add(resolvePath(cand));
      }
    } catch {
    }
  }
  for (const r of discoverGitRoots()) add(r);
  for (const r of sortedPaths(roots)) {
    try {
      installGitHook(r);
      if (anchor) ensureAgentGuidanceAnchor(r);
      writeBlueprint(r);
      if (!quiet) process.stdout.write(`Bootstrapped living blueprint & hooks for: ${toNative(r)}
`);
    } catch (e) {
      if (!quiet) process.stderr.write(`Skipped ${toNative(r)}: ${e instanceof Error ? e.message : String(e)}
`);
    }
  }
  return 0;
}

// packages/daemon/src/blueprint/cli.ts
var OPTIONS = [
  { flag: "--root", dest: "root", value: "ROOT", help: "Project root directory (default: current directory)" },
  { flag: "--output", dest: "output", value: "OUTPUT", help: "Output markdown path (default: <root>/PROJECT_BLUEPRINT.md)" },
  { flag: "--install-hook", dest: "install_hook", help: "Install the git hooks that keep the blueprint current" },
  { flag: "--uninstall-hook", dest: "uninstall_hook", help: "Remove the git hooks only" },
  { flag: "--uninstall", dest: "uninstall", help: "Take back everything done in --root (hooks, markers, generated file)" },
  { flag: "--uninstall-all", dest: "uninstall_all", help: "--uninstall for every repo this script touched" },
  { flag: "--anchor", dest: "anchor", help: "Also add a read-the-blueprint hint to the repo's CLAUDE.md / AGENTS.md / ..." },
  { flag: "--bootstrap-discovered", dest: "bootstrap_discovered", help: "Discover and install blueprint & hooks across all local git projects" },
  { flag: "--check", dest: "check", help: "Check if current PROJECT_BLUEPRINT.md is up-to-date" },
  { flag: "--business", dest: "business", help: "Check BUSINESS_BLUEPRINT.md against the code, refresh its generated regions, exit 1 on broken anchors or broken rules" },
  { flag: "--business-init", dest: "business_init", help: "Write a starting BUSINESS_BLUEPRINT.md (layout and one example of each entry kind) when there is none" },
  { flag: "--quiet", dest: "quiet", help: "Suppress stdout messages" }
];
var DESCRIPTION = "Generate and maintain living PROJECT_BLUEPRINT.md for AI agents.";
var BUSINESS_HELP = [
  "BUSINESS_BLUEPRINT.md (业务蓝图) entries are `### <ID> <title>` headings; the ID's letter is the kind:",
  "  T- term (术语)  F- flow (流程, numbered steps)  R- rule (规则)  S- state (状态归属)",
  "with list fields under them:",
  "  - 来源: 用户 2026-11-14「原话」            who asked for it (rules)",
  "  - 代码: `path#symbol`, `path`               where the code decides it (symbol found by name)",
  "  - 测试: `test/x.test.ts#test title`         the test that proves it",
  "  - 禁止: `text` @ `dir/`; `/regex/` @ `f`    must not appear there (how the bug looked)",
  "  - 要求: `text` @ `path`                     must appear there (what keeps it fixed)",
  "  - 事实源 / 副本 / 同步: …                    (states) their `path#symbol` are checked too",
  "The generator keeps an index after the title and the check results at the end (between memento markers)."
].join("\n");
var UsageError = class extends Error {
};
var HelpRequested = class extends Error {
};
function terminalColumns() {
  const env = Number.parseInt(process.env.COLUMNS ?? "", 10);
  if (env > 0) return env;
  return process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : 80;
}
var WORDSEP_RE = /([\t\n\x0b\x0c\r ]+|(?<=[\w!"'&.,?])-{2,}(?=\w)|[^\t\n\x0b\x0c\r ]+?(?:-(?:(?<=[^\d\W]{2}-)|(?<=[^\d\W]-[^\d\W]-))(?=[^\d\W]-?[^\d\W])|(?=[\t\n\x0b\x0c\r ]|$)|(?<=[\w!"'&.,?])(?=-{2,}\w)))/;
function wrap(text, width) {
  const chunks = text.split(WORDSEP_RE).filter((c) => c).reverse();
  const lines = [];
  while (chunks.length) {
    const line = [];
    let len = 0;
    if (lines.length && !chunks[chunks.length - 1].trim()) chunks.pop();
    while (chunks.length) {
      const l = chunks[chunks.length - 1].length;
      if (len + l > width) break;
      line.push(chunks.pop());
      len += l;
    }
    if (chunks.length && chunks[chunks.length - 1].length > width) {
      const spaceLeft = width < 1 ? 1 : width - len;
      const chunk = chunks[chunks.length - 1];
      let cut = spaceLeft;
      const hyphen = chunk.lastIndexOf("-", spaceLeft - 1);
      if (chunk.length > spaceLeft && hyphen > 0 && /[^-]/.test(chunk.slice(0, hyphen))) cut = hyphen + 1;
      line.push(chunk.slice(0, cut));
      chunks[chunks.length - 1] = chunk.slice(cut);
    }
    if (line.length && !line[line.length - 1].trim()) line.pop();
    if (line.length) lines.push(line.join(""));
  }
  return lines;
}
function squash(text) {
  return text.replace(/\s+/g, " ").trim();
}
function usageText(prog, width) {
  const prefix = "usage: ";
  const parts = ["[-h]", ...OPTIONS.map((o) => o.value ? `[${o.flag} ${o.value}]` : `[${o.flag}]`)];
  const oneLine = [prog, ...parts].join(" ");
  if (prefix.length + oneLine.length <= width) return prefix + oneLine;
  const getLines = (items, indent, withPrefix) => {
    const lines2 = [];
    let line = [];
    let lineLen = (withPrefix ? prefix.length : indent.length) - 1;
    for (const part of items) {
      if (lineLen + 1 + part.length > width && line.length) {
        lines2.push(indent + line.join(" "));
        line = [];
        lineLen = indent.length - 1;
      }
      line.push(part);
      lineLen += part.length + 1;
    }
    if (line.length) lines2.push(indent + line.join(" "));
    if (withPrefix) lines2[0] = lines2[0].slice(indent.length);
    return lines2;
  };
  let lines;
  if (prefix.length + prog.length <= 0.75 * width) {
    const indent = " ".repeat(prefix.length + prog.length + 1);
    lines = getLines([prog, ...parts], indent, true);
  } else {
    lines = [prog, ...getLines(parts, " ".repeat(prefix.length), false)];
  }
  return prefix + lines.join("\n");
}
function usage(prog) {
  return usageText(prog, terminalColumns() - 2) + "\n";
}
function help(prog) {
  const width = terminalColumns() - 2;
  const rows = [["-h, --help", "show this help message and exit"], ...OPTIONS.map((o) => [o.value ? `${o.flag} ${o.value}` : o.flag, o.help])];
  const maxHelpPosition = Math.min(24, Math.max(width - 20, 4));
  const helpPosition = Math.min(Math.max(...rows.map(([name]) => name.length + 2)) + 2, maxHelpPosition);
  const helpWidth = Math.max(width - helpPosition, 11);
  const actionWidth = helpPosition - 2 - 2;
  const body = [];
  for (const [name, text] of rows) {
    const lines = wrap(squash(text), helpWidth);
    if (name.length <= actionWidth) {
      body.push(`  ${name.padEnd(actionWidth)}  ${lines[0] ?? ""}`);
    } else {
      body.push(`  ${name}`);
      if (lines.length) body.push(" ".repeat(helpPosition) + lines[0]);
    }
    for (const l of lines.slice(1)) body.push(" ".repeat(helpPosition) + l);
  }
  const description = wrap(squash(DESCRIPTION), Math.max(width, 11)).join("\n");
  return `${usageText(prog, width)}

${description}

options:
${body.join("\n")}

${BUSINESS_HELP}
`;
}
function looksLikeOption(word) {
  return word.startsWith("-") && word !== "-" && !/^-\d+$|^-\d*\.\d+$/.test(word);
}
function matchOption(word) {
  const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
  if (name === "-h" || name === "--help") return "help";
  const exact = OPTIONS.find((o) => o.flag === name);
  if (exact) return exact;
  if (!name.startsWith("--") || name.length < 3) return null;
  const hits = OPTIONS.filter((o) => o.flag.startsWith(name));
  if ("--help".startsWith(name)) {
    if (!hits.length) return "help";
    throw new UsageError(`ambiguous option: ${name} could match --help, ${hits.map((o) => o.flag).join(", ")}`);
  }
  if (hits.length > 1) throw new UsageError(`ambiguous option: ${name} could match ${hits.map((o) => o.flag).join(", ")}`);
  return hits[0] ?? null;
}
function parseArgs(argv) {
  const args = {
    root: ".",
    output: "",
    install_hook: false,
    uninstall_hook: false,
    uninstall: false,
    uninstall_all: false,
    anchor: false,
    bootstrap_discovered: false,
    check: false,
    business: false,
    business_init: false,
    quiet: false
  };
  const extras = [];
  let i = 0;
  while (i < argv.length) {
    const word = argv[i++];
    if (word === "--") {
      extras.push(...argv.slice(i));
      break;
    }
    if (!looksLikeOption(word)) {
      extras.push(word);
      continue;
    }
    const opt = matchOption(word);
    if (opt === null) {
      extras.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const explicit = eq >= 0 ? word.slice(eq + 1) : null;
    if (opt === "help") {
      if (explicit !== null) throw new UsageError(`argument -h/--help: ignored explicit argument '${explicit}'`);
      throw new HelpRequested();
    }
    if (!opt.value) {
      if (explicit !== null) throw new UsageError(`argument ${opt.flag}: ignored explicit argument '${explicit}'`);
      args[opt.dest] = true;
      continue;
    }
    let value = explicit;
    if (value === null) {
      const next2 = argv[i];
      if (next2 === void 0 || looksLikeOption(next2) || next2 === "--") throw new UsageError(`argument ${opt.flag}: expected one argument`);
      value = next2;
      i++;
    }
    args[opt.dest] = value;
  }
  if (extras.length) throw new UsageError(`unrecognized arguments: ${extras.join(" ")}`);
  return args;
}
function say(line) {
  process.stdout.write(line + "\n");
}
function main(argv = process.argv.slice(2), prog = SCRIPT_NAME) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof HelpRequested) {
      process.stdout.write(help(prog));
      return 0;
    }
    if (e instanceof UsageError) {
      process.stderr.write(`${usage(prog)}${prog}: error: ${e.message}
`);
      return 2;
    }
    throw e;
  }
  if (args.uninstall_all) return uninstallAll(args.quiet);
  if (args.bootstrap_discovered) return bootstrapDiscoveredProjects(args.quiet, args.anchor);
  const root = resolvePath(args.root);
  const outPath = args.output ? resolvePath(args.output) : null;
  if (args.uninstall) {
    const ok2 = uninstallRepo(root);
    if (!args.quiet) say(ok2 ? `Removed living blueprint & hooks from: ${toNative(root)}` : `Could not fully clean ${toNative(root)}`);
    return ok2 ? 0 : 1;
  }
  if (args.uninstall_hook) {
    const ok2 = uninstallGitHook(root);
    if (!args.quiet) say("Git hooks uninstalled.");
    return ok2 ? 0 : 1;
  }
  if (args.business_init) {
    const file = pjoin(root, BUSINESS_FILE);
    if (exists(file)) {
      if (!args.quiet) say(`${BUSINESS_FILE} already exists.`);
      return 0;
    }
    atomicWrite(file, businessSkeleton(pname(root)));
    if (!args.quiet) say(`Wrote ${toNative(file)}`);
    return 0;
  }
  if (args.business) {
    if (!exists(pjoin(root, BUSINESS_FILE))) {
      if (!args.quiet) say(`${BUSINESS_FILE} is missing (--business-init writes a starting one).`);
      return 1;
    }
    const report = refreshBusinessBlueprint(root);
    if (!report) {
      if (!args.quiet) say(`${BUSINESS_FILE} has no entries (### T-/F-/R-/S- headings).`);
      return 1;
    }
    if (!args.quiet) say(formatReport(report));
    return report.fails ? 1 : 0;
  }
  if (args.check) {
    const target2 = outPath ?? pjoin(root, BLUEPRINT_FILE);
    if (!exists(target2)) {
      if (!args.quiet) say(`${pname(target2)} is missing.`);
      return 1;
    }
    const current = readTextIgnore(target2);
    if (pyStrip(current) !== pyStrip(buildBlueprintContent(root))) {
      if (!args.quiet) say(`${pname(target2)} is outdated.`);
      return 1;
    }
    if (!args.quiet) say(`${pname(target2)} is up to date.`);
    return 0;
  }
  let ok = true;
  if (args.install_hook) ok = installGitHook(root);
  if (args.anchor) ensureAgentGuidanceAnchor(root);
  let target;
  let changed;
  try {
    [target, changed] = writeBlueprint(root, outPath);
  } catch (e) {
    process.stderr.write(`Failed to generate blueprint for ${toNative(root)}: ${e instanceof Error ? e.message : String(e)}
`);
    return 1;
  }
  if (!args.quiet) {
    if (args.install_hook) say(ok ? "Git hooks installed." : "Failed to install git hooks.");
    say(`${changed ? "Generated" : "Unchanged"} living blueprint at: ${toNative(target)}`);
  }
  return ok ? 0 : 1;
}

// packages/daemon/src/blueprint/main.ts
process.exitCode = main();
