// Python 3.14 tokenizer (a port of CPython's Parser/lexer/lexer.c) for the ast.parse subset the
// blueprint generator needs: it accepts and rejects the same sources as CPython, and decodes
// string / f-string / t-string literals the way the parser actions do, so ast.unparse can be
// reproduced. Every tokenizer and literal-decoding error in CPython is fatal for the whole parse,
// so all of it runs eagerly here and throws PySyntaxError.
import { isPySpace, surrogateStandIn } from "./py.js";

export class PySyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PySyntaxError";
  }
}

export function syntaxError(message: string): never {
  throw new PySyntaxError(message);
}

export const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

export type TokType = "NAME" | "NUMBER" | "STRING" | "FSTRING" | "OP" | "NEWLINE" | "INDENT" | "DEDENT" | "END";

export type NumVal = { k: "int"; v: bigint } | { k: "float"; v: number } | { k: "complex"; v: number };

/** A replacement field of an f-string / t-string. */
export interface FField {
  /** Expression tokens, terminated by END (parsed later as annotated_rhs). */
  toks: Tok[];
  /** Text of a `{expr=}` debug field (the Constant put before the value), else null. */
  debug: string | null;
  /** Interpolation.str */
  str: string;
  /** -1 or the conversion character code */
  conv: number;
  /** Format spec parts, or null when there is no `:` */
  spec: FPart[] | null;
  /** Top-level field of a t-string: an Interpolation rather than a FormattedValue */
  interp: boolean;
  /** Parsed expression, filled in by the parser */
  node?: unknown;
}

export type FPart = { lit: string } | { field: FField };

export interface Tok {
  t: TokType;
  /** NAME: NFKC-normalised identifier; OP: the operator */
  v: string;
  /** Source offsets */
  s: number;
  e: number;
  /** NAME: the identifier as written (keywords and soft keywords match on this) */
  raw?: string;
  kw?: boolean;
  num?: NumVal;
  /** STRING */
  bytes?: boolean;
  u?: boolean;
  sv?: string;
  /** FSTRING */
  tstr?: boolean;
  parts?: FPart[];
}

const MAXINDENT = 100;
const MAXLEVEL = 200;
const MAXFSTRINGLEVEL = 150;
const MAX_EXPR_NESTING = 3;
const MAX_STR_DIGITS = 4300;

const THREE = new Set(["**=", "...", "//=", "<<=", ">>="]);
const TWO = new Set([
  "!=", "%=", "&=", "**", "*=", "+=", "-=", "->", "//", "/=", ":=", "<<", "<=", "<>", "==", ">=", ">>",
  "@=", "^=", "|=",
]);
const ONE = new Set([..."!%&()*+,-./:;<=>@[]^{|}~"]);
const CLOSER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const IDENT_RE = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined): boolean =>
  c !== undefined && ((c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"));
const isOct = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "7";
const isBin = (c: string | undefined): boolean => c === "0" || c === "1";

/** is_potential_identifier_start: CPython looks at UTF-8 bytes, so every non-ASCII char counts */
function identStart(c: string | undefined): boolean {
  if (c === undefined) return false;
  const k = c.charCodeAt(0);
  return (k >= 97 && k <= 122) || (k >= 65 && k <= 90) || k === 95 || k >= 128;
}

function identChar(c: string | undefined): boolean {
  return identStart(c) || isDigit(c);
}

interface FCtx {
  quote: string;
  size: number;
  raw: boolean;
  tstr: boolean;
}

/** Decode the body of a string literal (unicode_escape / bytes escape semantics). */
export function decodeLiteral(body: string, raw: boolean, bytes: boolean): string {
  if (bytes) {
    for (let i = 0; i < body.length; i++) {
      if (body.charCodeAt(i) >= 0x80) syntaxError("bytes can only contain ASCII literal characters");
    }
  }
  if (raw || !body.includes("\\")) return body;
  let out = "";
  const n = body.length;
  let i = 0;
  while (i < n) {
    const c = body[i]!;
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    i++;
    if (i >= n) {
      // A trailing backslash (an f-string part ending right before a brace) stays literal
      out += "\\";
      break;
    }
    const e = body[i]!;
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
        out += "\t";
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
        out += bytes ? String.fromCharCode(v & 0xff) : String.fromCodePoint(v);
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
        const hex = body.slice(i, i + len);
        if (hex.length !== len || ![...hex].every((h) => isHex(h))) {
          syntaxError(`(unicode error) truncated \\${e}${"X".repeat(len)} escape`);
        }
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) syntaxError("(unicode error) illegal Unicode character");
        out += cp >= 0xd800 && cp <= 0xdfff ? surrogateStandIn(cp) : String.fromCodePoint(cp);
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
        // No Unicode name database in JS: accept well-formed names, value U+FFFD
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

/** The expression text of a replacement field with comments removed (lexer.c set_ftstring_expr). */
function stripFieldComments(s: string): string {
  let hash = false;
  let inStr = false;
  let q = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
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
    const ch = s[i]!;
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

/** _strip_interpolation_expr: drop trailing whitespace and '=' */
function stripInterpolationExpr(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "=" || isPySpace(s[end - 1]!))) end--;
  return s.slice(0, end);
}

class Lexer {
  readonly src: string;
  i = 0;
  parens: string[] = [];
  fdepth = 0;

  constructor(src: string) {
    this.src = src;
  }

  run(): Tok[] {
    const src = this.src;
    const toks: Tok[] = [];
    const ind = [0];
    const alt = [0];
    let atbol = true;
    let blank = false;
    const push = (t: TokType, s: number, e: number = s) => toks.push({ t, v: "", s, e });
    for (;;) {
      if (atbol) {
        atbol = false;
        let col = 0;
        let altcol = 0;
        let cont = 0;
        for (;;) {
          const c = src[this.i];
          if (c === " ") {
            col++;
            altcol++;
          } else if (c === "\t") {
            col = (Math.floor(col / 8) + 1) * 8;
            altcol++;
          } else if (c === "\f") {
            col = altcol = 0;
          } else if (c === "\\") {
            cont = cont || col;
            this.continuation();
            continue;
          } else break;
          this.i++;
        }
        const c = src[this.i];
        blank = c === "#" || c === "\n";
        if (!blank && this.parens.length === 0) {
          if (cont) col = altcol = cont;
          const top = ind.length - 1;
          if (col === ind[top]) {
            if (altcol !== alt[top]) syntaxError("inconsistent use of tabs and spaces in indentation");
          } else if (col > ind[top]!) {
            if (top + 1 >= MAXINDENT) syntaxError("too many levels of indentation");
            if (altcol <= alt[top]!) syntaxError("inconsistent use of tabs and spaces in indentation");
            ind.push(col);
            alt.push(altcol);
            push("INDENT", this.i);
          } else {
            while (ind.length > 1 && col < ind[ind.length - 1]!) {
              ind.pop();
              alt.pop();
              push("DEDENT", this.i);
            }
            if (col !== ind[ind.length - 1]) syntaxError("unindent does not match any outer indentation level");
            if (altcol !== alt[alt.length - 1]) syntaxError("inconsistent use of tabs and spaces in indentation");
          }
        }
      }
      while (src[this.i] === " " || src[this.i] === "\t" || src[this.i] === "\f") this.i++;
      if (src[this.i] === "#") {
        while (this.i < src.length && src[this.i] !== "\n") this.i++;
      }
      const c = src[this.i];
      if (c === undefined) {
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
  private continuation(): void {
    if (this.src[this.i + 1] !== "\n") syntaxError("unexpected character after line continuation character");
    this.i += 2;
    if (this.i >= this.src.length) syntaxError("unexpected EOF while parsing");
  }

  /** One token starting at this.i (whitespace and comments already skipped). */
  private scanToken(): Tok {
    const src = this.src;
    const start = this.i;
    const c = src[start]!;
    if (identStart(c)) {
      let b = false;
      let r = false;
      let u = false;
      let f = false;
      let t = false;
      let j = start;
      for (;;) {
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
    if (isDigit(c) || (c === "." && isDigit(src[start + 1]))) return this.number();
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
      if (open === undefined) syntaxError(`unmatched '${c}'`);
      if (open !== CLOSER[c]) syntaxError(`closing parenthesis '${c}' does not match opening parenthesis '${open}'`);
    }
    this.i = start + 1;
    return { t: "OP", v: c, s: start, e: this.i };
  }

  private number(): Tok {
    const src = this.src;
    const start = this.i;
    let p = start;
    const nextc = (): string | undefined => {
      const ch = src[p];
      if (ch !== undefined) p++;
      return ch;
    };
    const backup = (ch: string | undefined): void => {
      if (ch !== undefined) p--;
    };
    const decimalTail = (): string | undefined => {
      let ch: string | undefined;
      for (;;) {
        do ch = nextc();
        while (isDigit(ch));
        if (ch !== "_") break;
        ch = nextc();
        if (!isDigit(ch)) syntaxError("invalid decimal literal");
      }
      return ch;
    };
    const verifyEnd = (ch: string | undefined, kind: string): void => {
      const look = (s: string) => src.startsWith(s, p) && !identChar(src[p + s.length]);
      let ok = false;
      if (ch === "a") ok = look("nd");
      else if (ch === "e") ok = look("lse");
      else if (ch === "f") ok = look("or");
      else if (ch === "i") ok = src[p] === "f" || src[p] === "n" || src[p] === "s";
      else if (ch === "o") ok = look("r");
      else if (ch === "n") ok = look("ot");
      if (ok) return; // CPython only warns here
      if (ch !== undefined && ch.charCodeAt(0) < 128 && identChar(ch)) syntaxError(`invalid ${kind} literal`);
    };
    const radix = (isD: (c: string | undefined) => boolean, kind: string, checkDigit: boolean): void => {
      let ch = nextc();
      do {
        if (ch === "_") ch = nextc();
        if (!isD(ch)) {
          if (checkDigit && isDigit(ch)) syntaxError(`invalid digit '${ch}' in ${kind} literal`);
          syntaxError(`invalid ${kind} literal`);
        }
        do ch = nextc();
        while (isD(ch));
      } while (ch === "_");
      if (checkDigit && isDigit(ch)) syntaxError(`invalid digit '${ch}' in ${kind} literal`);
      verifyEnd(ch, kind);
      backup(ch);
    };

    let c = nextc();
    let stage: "fraction" | "postfrac" | "exponent" | "imag" | "done";
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
      for (;;) {
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

  private numberTok(start: number, end: number): Tok {
    this.i = end;
    const text = this.src.slice(start, end).replace(/_/g, "");
    let num: NumVal;
    const last = text[text.length - 1];
    if (last === "j" || last === "J") num = { k: "complex", v: Number(text.slice(0, -1)) };
    else if (/^0[xXoObB]/.test(text)) num = { k: "int", v: BigInt(`0${text[1]!.toLowerCase()}${text.slice(2)}`) };
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
  private string(start: number, q: number, isBytes: boolean, isRaw: boolean): Tok {
    const src = this.src;
    const quote = src[q]!;
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
      if (c === undefined || (size === 1 && c === "\n")) {
        syntaxError(size === 3 ? "unterminated triple-quoted string literal" : "unterminated string literal");
      }
      p++;
      if (c === quote) endq++;
      else {
        endq = 0;
        if (c === "\\" && src[p] !== undefined) p++;
      }
    }
    this.i = p;
    const sv = decodeLiteral(src.slice(bodyStart, p - size), isRaw, isBytes);
    return { t: "STRING", v: "", bytes: isBytes, u: src[start] === "u", sv, s: start, e: p };
  }

  private fstring(start: number, q: number, isRaw: boolean, isT: boolean): Tok {
    if (this.fdepth + 1 >= MAXFSTRINGLEVEL) syntaxError("too many nested f-strings");
    this.fdepth++;
    const src = this.src;
    const quote = src[q]!;
    const size = src.startsWith(quote.repeat(3), q) ? 3 : 1;
    const ctx: FCtx = { quote, size, raw: isRaw, tstr: isT };
    const { parts, p } = this.fbody(q + size, ctx, false, 0);
    this.fdepth--;
    this.i = p;
    return { t: "FSTRING", v: "", tstr: isT, parts, s: start, e: p };
  }

  /**
   * The literal part of an f-string body, or of a format spec (inSpec). Returns at the end of
   * the string (after the closing quotes) or, in a spec, at the '}' that closes the field.
   */
  private fbody(p0: number, ctx: FCtx, inSpec: boolean, fieldDepth: number): { parts: FPart[]; p: number } {
    const src = this.src;
    const parts: FPart[] = [];
    const closing = ctx.quote.repeat(ctx.size);
    let lit = "";
    let p = p0;
    let uni = false;
    const flush = () => {
      if (lit) parts.push({ lit: decodeLiteral(lit, ctx.raw, false) });
      lit = "";
    };
    for (;;) {
      const c = src[p];
      if (c === undefined) syntaxError("unterminated f-string literal");
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
        if (peek === undefined) {
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
  private skipFieldSpace(): void {
    const src = this.src;
    for (;;) {
      const c = src[this.i];
      if (c === " " || c === "\t" || c === "\f" || c === "\n") this.i++;
      else if (c === "#") {
        while (this.i < src.length && src[this.i] !== "\n") this.i++;
      } else if (c === "\\") this.continuation();
      else return;
    }
  }

  /** A replacement field; p0 is at its '{'. Returns just after the closing '}'. */
  private field(p0: number, ctx: FCtx, fieldDepth: number): { field: FField; p: number } {
    if (fieldDepth >= MAX_EXPR_NESTING) syntaxError("f-string: expressions nested too deeply");
    if (this.parens.length >= MAXLEVEL) syntaxError("too many nested parentheses");
    const src = this.src;
    this.parens.push("{");
    const base = this.parens.length;
    const exprStart = p0 + 1;
    this.i = exprStart;
    const toks: Tok[] = [];
    // CPython's last_expr_end: a '!' at field level (even of '!=') moves where the text stops
    let bang = -1;
    let term: string;
    for (;;) {
      this.skipFieldSpace();
      const c = src[this.i];
      if (c === undefined) syntaxError("f-string: expecting '}'");
      if (this.parens.length === base) {
        if (c === "}" || c === ":" || (c === "!" && src[this.i + 1] !== "=")) {
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
          src[this.i] === "}" || src[this.i] === ":"
            ? "f-string: missing conversion character"
            : "f-string: conversion type must come right after the exclamation mark",
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
    let spec: FPart[] | null = null;
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
    const field: FField = {
      toks,
      debug: debug ? meta : null,
      str: stripInterpolationExpr(meta),
      conv,
      spec,
      interp: ctx.tstr && fieldDepth === 0,
    };
    return { field, p: this.i };
  }
}

/** Tokenize a module source (as compile() does for a str: newlines normalised, final newline added). */
export function tokenize(source: string): Tok[] {
  if (source.includes("\0")) syntaxError("source code string cannot contain null bytes");
  let src = source.replace(/\r\n?/g, "\n");
  if (src.length > 0 && !src.endsWith("\n")) src += "\n";
  return new Lexer(src).run();
}
