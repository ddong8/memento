// Python semantics the blueprint generator relies on. The generator used to be a Python script and its
// output is kept byte-for-byte the same, so regexes, whitespace, line splitting, string length and
// slicing, sorting and truthiness behave here exactly as they did in CPython 3.14.

/** str.isspace() / the `\s` class of Python's re for str patterns. */
export const PY_WS_CLASS = "\\t-\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WORD_CLASS = "\\p{L}\\p{N}_";
const WS_RE = new RegExp(`[${PY_WS_CLASS}]`, "u");

export function isPySpace(ch: string): boolean {
  return ch.length > 0 && WS_RE.test(ch);
}

// ---------------------------------------------------------------- regex

export interface PyFlags {
  i?: boolean;
  m?: boolean;
  s?: boolean;
}

const JS_SYNTAX = new Set("^$\\.*+?()[]{}|/".split(""));

/** Translate a Python `re` pattern to an equivalent JS (`u` flag) pattern. */
export function translatePyRegex(pattern: string, flags: PyFlags = {}): { source: string; flags: string } {
  let { i = false, m = false, s = false } = flags;
  let pos = 0;
  // Leading global inline flags, e.g. (?m)
  for (;;) {
    const fm = /^\(\?([aiLmsux]+)\)/.exec(pattern.slice(pos));
    if (!fm) break;
    for (const f of fm[1]!) {
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
    const c = pattern[pos]!;
    if (c === "\\") {
      const e = pattern[pos + 1];
      if (e === undefined) throw new Error("bad escape (end of pattern)");
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
      const [cls, next] = translateClass(pattern, pos);
      out += cls;
      pos = next;
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
      if (q && lastWasAtom && (q[1] !== "" || (q[2] === "," && q[3] !== ""))) {
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
        // lazy (Python) — possessive is not used by the generator
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

function translateClass(pattern: string, start: number): [string, number] {
  // [\s\S] and [\W_] are the only classes with a negated shorthand the generator uses
  if (pattern.startsWith("[\\s\\S]", start)) return ["[\\s\\S]", start + 6];
  if (pattern.startsWith("[\\W_]", start)) return ["[^\\p{L}\\p{N}]", start + 5];
  let pos = start + 1;
  let out = "[";
  if (pattern[pos] === "^") {
    out += "^";
    pos += 1;
  }
  let first = true;
  for (;;) {
    const c = pattern[pos];
    if (c === undefined) throw new Error("unterminated character set");
    if (c === "]" && !first) {
      out += "]";
      pos += 1;
      break;
    }
    first = false;
    if (c === "\\") {
      const e = pattern[pos + 1];
      if (e === undefined) throw new Error("bad escape in class");
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

const RX_CACHE = new Map<string, RegExp>();

function compiled(pattern: string, flags: PyFlags, mode: "" | "y" | "g"): RegExp {
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

/** A Python match object: group(n) is null for a group that didn't take part. */
export class PyMatch {
  constructor(private readonly m: RegExpExecArray) {}
  group(n = 0): string | null {
    const v = this.m[n];
    return v === undefined ? null : v;
  }
  /** group(n) where the pattern guarantees the group matched. */
  g(n: number): string {
    return this.m[n] ?? "";
  }
  get index(): number {
    return this.m.index;
  }
  get end(): number {
    return this.m.index + this.m[0].length;
  }
  get groupCount(): number {
    return this.m.length - 1;
  }
}

/** re.match: anchored at the start of the string. */
export function reMatch(pattern: string, text: string, flags: PyFlags = {}): PyMatch | null {
  const rx = compiled(pattern, flags, "y");
  const m = rx.exec(text);
  return m ? new PyMatch(m) : null;
}

export function reSearch(pattern: string, text: string, flags: PyFlags = {}): PyMatch | null {
  const rx = compiled(pattern, flags, "");
  const m = rx.exec(text);
  return m ? new PyMatch(m) : null;
}

export function* reFinditer(pattern: string, text: string, flags: PyFlags = {}): Generator<PyMatch> {
  for (const m of text.matchAll(compiled(pattern, flags, "g"))) yield new PyMatch(m as RegExpExecArray);
}

/** re.findall: whole matches without groups, group 1 with one group (None -> ""), else tuples. */
export function reFindall(pattern: string, text: string, flags: PyFlags = {}): string[] {
  const out: string[] = [];
  for (const m of reFinditer(pattern, text, flags)) {
    if (m.groupCount === 0) out.push(m.g(0));
    else if (m.groupCount === 1) out.push(m.group(1) ?? "");
    else throw new Error("findall with several groups is not used");
  }
  return out;
}

function expandTemplate(template: string, m: PyMatch): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = template[i + 1];
    if (e === undefined) throw new Error("bad escape (end of pattern)");
    if (/[0-9]/.test(e)) {
      let j = i + 1;
      while (j < template.length && j < i + 3 && /[0-9]/.test(template[j]!)) j++;
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
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", a: "\x07", b: "\b", "\\": "\\" };
    if (e in simple) out += simple[e];
    else if (/[A-Za-z]/.test(e)) throw new Error(`bad escape \\${e}`);
    else out += `\\${e}`;
    i += 1;
  }
  return out;
}

/** re.subn with a Python replacement template (\1, \g<1>); count 0 = all. */
export function reSubn(pattern: string, repl: string, text: string, count = 0, flags: PyFlags = {}): [string, number] {
  let out = "";
  let last = 0;
  let n = 0;
  let prevEnd = -1;
  for (const m of reFinditer(pattern, text, flags)) {
    if (count && n >= count) break;
    // Python skips an empty match right after the previous match
    if (m.index === m.end && m.index === prevEnd) continue;
    out += text.slice(last, m.index) + expandTemplate(repl, m);
    last = m.end;
    prevEnd = m.end;
    n++;
  }
  return [out + text.slice(last), n];
}

export function reSub(pattern: string, repl: string, text: string, count = 0, flags: PyFlags = {}): string {
  return reSubn(pattern, repl, text, count, flags)[0];
}

const ESCAPE_SET = new Set("()[]{}?*+-|^$\\.&~# \t\n\r\v\f".split(""));

/** re.escape */
export function reEscape(text: string): string {
  let out = "";
  for (const ch of text) out += ESCAPE_SET.has(ch) ? `\\${ch}` : ch;
  return out;
}

// ---------------------------------------------------------------- strings

function hasSurrogates(s: string): boolean {
  return /[\uD800-\uDFFF]/.test(s);
}

/** len() in code points. */
export function pyLen(s: string): number {
  if (!hasSurrogates(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** s[start:end] in code points (non-negative indices; end undefined = to the end). */
export function pySlice(s: string, start: number, end?: number): string {
  if (!hasSurrogates(s)) return s.slice(start, end);
  const cps = Array.from(s);
  return cps.slice(start, end).join("");
}

/** s[:-k] style slices: negative end counted from the end in code points. */
export function pySliceNeg(s: string, start: number, end: number): string {
  const len = pyLen(s);
  const e = end < 0 ? Math.max(0, len + end) : end;
  return pySlice(s, start, e);
}

function charSet(chars: string | undefined): (ch: string) => boolean {
  if (chars === undefined) return isPySpace;
  const set = new Set(Array.from(chars));
  return (ch) => set.has(ch);
}

export function pyLstrip(s: string, chars?: string): string {
  const test = charSet(chars);
  const cps = Array.from(s);
  let i = 0;
  while (i < cps.length && test(cps[i]!)) i++;
  return i === 0 ? s : cps.slice(i).join("");
}

export function pyRstrip(s: string, chars?: string): string {
  const test = charSet(chars);
  const cps = Array.from(s);
  let j = cps.length;
  while (j > 0 && test(cps[j - 1]!)) j--;
  return j === cps.length ? s : cps.slice(0, j).join("");
}

export function pyStrip(s: string, chars?: string): string {
  return pyRstrip(pyLstrip(s, chars), chars);
}

const LINE_BREAKS = "\n\r\x0b\x0c\x1c\x1d\x1e\x85  ";

/** str.splitlines() (keepends optional). */
export function pySplitlines(s: string, keepends = false): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
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

/** str.split() without arguments: runs of whitespace, no empty parts. */
export function pySplitWs(s: string): string[] {
  const out: string[] = [];
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

/** str.split(sep, maxsplit) */
export function pySplit(s: string, sep: string, maxsplit = -1): string[] {
  if (maxsplit < 0) return s.split(sep);
  const out: string[] = [];
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

/** str.capitalize(): first character title-cased, the rest lower-cased (ASCII use only). */
export function pyCapitalize(s: string): string {
  if (!s) return s;
  const [first, ...rest] = Array.from(s);
  return first!.toUpperCase() + rest.join("").toLowerCase();
}

/** str.islower() for the ASCII identifiers it is used on. */
export function pyIslower(s: string): boolean {
  return /[a-z]/.test(s) && !/[A-Z]/.test(s);
}

/** str.startswith(tuple) */
export function startsWithAny(s: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => s.startsWith(p));
}

export function endsWithAny(s: string, suffixes: readonly string[]): boolean {
  return suffixes.some((p) => s.endsWith(p));
}

/** Code-point order comparison (Python str <), unlike JS which compares UTF-16 units. */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800) x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
    if (y >= 0xd800) y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    return x - y;
  }
  return a.length - b.length;
}

/** sorted() of strings */
export function sortedStr(items: Iterable<string>): string[] {
  return Array.from(items).sort(cmpStr);
}

/** list(dict.fromkeys(items)) */
export function uniq<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}

// ---------------------------------------------------------------- JSON values

/** A value from pyjson.loads: dicts are Maps (key order as in the file), ints are bigints, floats numbers. */
export type PyValue = null | boolean | bigint | number | string | PyValue[] | PyDict;
export type PyDict = Map<string, PyValue>;

export function isDict(v: unknown): v is PyDict {
  return v instanceof Map;
}

/** Python truthiness of a JSON value. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === 0n || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return true;
}

/** obj.get(key): obj must be a dict, else Python raises AttributeError. undefined = missing key. */
export function pyGet(obj: unknown, key: string): PyValue | undefined {
  if (!(obj instanceof Map)) throw new TypeError("'get' on a non-dict");
  return (obj as PyDict).get(key);
}

/** `x or {}` followed by `**x`: the value must end up a dict. */
export function orDict(v: unknown): PyDict {
  const r = truthy(v) ? v : new Map();
  if (!(r instanceof Map)) throw new TypeError("not a mapping");
  return r as PyDict;
}

/** {**a, **b} */
export function mergeDicts(...dicts: PyDict[]): PyDict {
  const out: PyDict = new Map();
  for (const d of dicts) for (const [k, v] of d) out.set(k, v);
  return out;
}

/** `needle in container` for a JSON value container. */
export function pyIn(needle: string, container: unknown): boolean {
  if (typeof container === "string") return container.includes(needle);
  if (Array.isArray(container)) return container.some((v) => v === needle);
  if (container instanceof Map) return container.has(needle);
  throw new TypeError("argument is not iterable");
}

/** iter(x) for a JSON value: characters, items, or keys. */
export function pyIter(v: unknown): PyValue[] {
  if (typeof v === "string") return Array.from(v);
  if (Array.isArray(v)) return v;
  if (v instanceof Map) return Array.from(v.keys());
  throw new TypeError("object is not iterable");
}

/** str(x) for a JSON value. */
export function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  return pyRepr(v);
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return pyFloatRepr(v);
  if (typeof v === "string") return pyStrRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Map) return `{${Array.from(v).map(([k, x]) => `${pyStrRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  return String(v);
}

/** repr(float) */
export function pyFloatRepr(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  // Shortest round-trip digits, then Python's choice of fixed vs exponent notation
  const [mant, expStr] = v.toExponential().split("e");
  const exp = Number(expStr);
  const neg = mant!.startsWith("-");
  const digits = mant!.replace("-", "").replace(".", "");
  let body: string;
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

const PRINTABLE_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\x20]$/u;

/**
 * A surrogate written as an escape ("\ud83d") is a code point of its own in a Python str, but two
 * of them in a JS string are one character. The lexer stores each as two lone low surrogates
 * (DC00 + the offset's top bit, DC00 + its low 10 bits): nothing else puts a lone surrogate in a
 * string and a low surrogate never pairs with its neighbours. pyChars reads them back.
 */
export function surrogateStandIn(cp: number): string {
  const off = cp - 0xd800;
  return String.fromCharCode(0xdc00 | (off >> 10), 0xdc00 | (off & 0x3ff));
}

/** The code points of a Python str, each with the JS text it takes up. */
export function* pyChars(s: string): Generator<[string, number]> {
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff && i + 1 < s.length) {
      yield [s.slice(i, i + 2), 0xd800 + (((c & 0x3ff) << 10) | (s.charCodeAt(i + 1) & 0x3ff))];
      i += 2;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const n = cp > 0xffff ? 2 : 1;
    yield [s.slice(i, i + n), cp];
    i += n;
  }
}

/** The code point a character from pyChars stands for. */
export function pyCodePoint(ch: string): number {
  return pyChars(ch).next().value![1];
}

/** str.isprintable()，单个字符 */
export function pyIsPrintable(ch: string): boolean {
  return PRINTABLE_RE.test(ch);
}

/** repr(str) */
export function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const [ch, cp] of pyChars(s)) {
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (PRINTABLE_RE.test(ch)) out += ch;
    else if (cp < 0x100) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}
