// json.loads / json.dumps as the Python generator used them: objects keep their key order (Maps, so
// numeric keys don't move to the front), integers stay exact (bigint) and are told apart from floats,
// NaN / Infinity are accepted, and the same documents are rejected.
import type { PyDict, PyValue } from "./py.js";
import { pyFloatRepr } from "./py.js";

class JSONDecodeError extends Error {}

const WS = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const HEX4 = /^[0-9a-fA-F]{4}$/;

class Scanner {
  i = 0;
  constructor(private readonly s: string) {}

  private ws(): void {
    while (this.i < this.s.length && WS.has(this.s[this.i]!)) this.i++;
  }

  private fail(msg: string): never {
    throw new JSONDecodeError(`${msg}: char ${this.i}`);
  }

  value(): PyValue {
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
      if (m[1] !== undefined || m[2] !== undefined) return Number(m[0]);
      const digits = m[0].replace("-", "");
      if (digits.length > 4300) throw new RangeError("Exceeds the limit (4300 digits) for integer string conversion");
      return BigInt(m[0]);
    }
    this.fail("Expecting value");
  }

  private str(): string {
    const s = this.s;
    let out = "";
    for (;;) {
      let j = this.i;
      while (j < s.length) {
        const ch = s.charCodeAt(j);
        if (ch === 0x22 || ch === 0x5c || ch < 0x20) break;
        j++;
      }
      out += s.slice(this.i, j);
      this.i = j;
      if (j >= s.length) this.fail("Unterminated string starting at");
      const c = s[j]!;
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c !== "\\") this.fail("Invalid control character at");
      const e = s[j + 1];
      if (e === undefined) this.fail("Unterminated string starting at");
      if (e !== "u") {
        const rep = ESCAPES[e];
        if (rep === undefined) this.fail("Invalid \\escape");
        out += rep;
        this.i = j + 2;
        continue;
      }
      const hex = s.slice(j + 2, j + 6);
      if (!HEX4.test(hex)) this.fail("Invalid \\uXXXX escape");
      let cp = parseInt(hex, 16);
      this.i = j + 6;
      if (cp >= 0xd800 && cp <= 0xdbff && s[this.i] === "\\" && s[this.i + 1] === "u") {
        const hex2 = s.slice(this.i + 2, this.i + 6);
        if (HEX4.test(hex2)) {
          const lo = parseInt(hex2, 16);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
            this.i += 6;
          }
        }
      }
      out += String.fromCodePoint(cp);
    }
  }

  private obj(): PyDict {
    const s = this.s;
    const out: PyDict = new Map();
    this.i++;
    this.ws();
    if (s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
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

  private arr(): PyValue[] {
    const s = this.s;
    const out: PyValue[] = [];
    this.i++;
    this.ws();
    if (s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = s[this.i];
      this.i++;
      if (c === "]") return out;
      if (c !== ",") this.fail("Expecting ',' delimiter");
      this.ws();
    }
  }

  document(): PyValue {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i !== this.s.length) this.fail("Extra data");
    return v;
  }
}

/** json.loads(text) */
export function loads(text: string): PyValue {
  if (text.startsWith("﻿")) throw new JSONDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)");
  return new Scanner(text).document();
}

function dumpStr(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const c = ch.charCodeAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function dumpValue(v: unknown, level: number, indent: number): string {
  if (v === null || v === undefined) return "null";
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
  const entries: [string, unknown][] = v instanceof Map ? Array.from(v) : Object.entries(v as object);
  if (!entries.length) return "{}";
  return `{${inner}${entries.map(([k, x]) => `${dumpStr(k)}: ${dumpValue(x, level + 1, indent)}`).join(`,${inner}`)}${outer}}`;
}

/**
 * json.dumps(value, ensure_ascii=False, indent=2). JS numbers that are whole are written as ints: the
 * generator only writes state it built itself (strings, booleans and lists of strings).
 */
export function dumps(value: unknown, indent = 2): string {
  return dumpValue(value, 0, indent);
}
