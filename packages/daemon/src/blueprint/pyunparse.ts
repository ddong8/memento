// ast.unparse for expressions: a port of CPython 3.14's Lib/_ast_unparse.py (expression visitors
// only, since the blueprint generator unparses class bases and field annotations). Output matches
// the Python implementation character for character, quirks included; it throws where Python
// raises (huge int literals, f-string parts it cannot quote).
import type { N } from "./pyparse.js";
import { pyChars, pyCodePoint, pyFloatRepr, pyIsPrintable, pyStrRepr } from "./py.js";

// _Precedence
const NAMED_EXPR = 1;
const TUPLE = 2;
const YIELD = 3;
const TEST = 4;
const OR = 5;
const AND = 6;
const NOT = 7;
const CMP = 8;
const EXPR = 9;
const BOR = 9;
const BXOR = 10;
const BAND = 11;
const SHIFT = 12;
const ARITH = 13;
const TERM = 14;
const FACTOR = 15;
const POWER = 16;
const AWAIT = 17;
const ATOM = 18;
const next = (p: number): number => Math.min(p + 1, ATOM);

const BINOP_PRECEDENCE: Record<string, number> = {
  "+": ARITH, "-": ARITH, "*": TERM, "@": TERM, "/": TERM, "%": TERM, "<<": SHIFT, ">>": SHIFT,
  "|": BOR, "^": BXOR, "&": BAND, "//": TERM, "**": POWER,
};

const INFSTR = "1e309";
const MAX_STR_DIGITS = 4300;
const MULTI_QUOTES = ['"""', "'''"];
const ALL_QUOTES = ["'", '"', '"""', "'''"];

const hex = (cp: number, width: number): string => cp.toString(16).padStart(width, "0");

/** c.encode("unicode_escape").decode("ascii") for a backslash or non-printable code point */
function unicodeEscape(c: string): string {
  if (c === "\\") return "\\\\";
  if (c === "\t") return "\\t";
  if (c === "\n") return "\\n";
  if (c === "\r") return "\\r";
  const cp = pyCodePoint(c);
  if (cp < 0x100) return `\\x${hex(cp, 2)}`;
  if (cp < 0x10000) return `\\u${hex(cp, 4)}`;
  return `\\U${hex(cp, 8)}`;
}

function bytesRepr(v: string): string {
  const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
  let out = "b" + quote;
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c >= 0x7f) out += `\\x${hex(c, 2)}`;
    else out += ch;
  }
  return out + quote;
}

/** repr() of a float / imaginary value, with infinities replaced as _write_constant does */
function numberText(cv: string, v: number): string {
  let s = pyFloatRepr(v);
  if (cv === "complex") s = (s.endsWith(".0") ? s.slice(0, -2) : s) + "j";
  return s.replaceAll("inf", INFSTR).replaceAll("nan", `(${INFSTR}-${INFSTR})`);
}

function intText(v: bigint): string {
  const s = v.toString();
  if (s.length - (s.startsWith("-") ? 1 : 0) > MAX_STR_DIGITS) {
    throw new Error(`Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion`);
  }
  return s;
}

/** Unparser._str_literal_helper: (string literal body, usable quote types) */
function strLiteralHelper(string: string, quoteTypes: string[], escapeSpecialWhitespace: boolean): [string, string[]] {
  let escaped = "";
  for (const [c] of pyChars(string)) {
    if (!escapeSpecialWhitespace && (c === "\n" || c === "\t")) escaped += c;
    else if (c === "\\" || !pyIsPrintable(c)) escaped += unicodeEscape(c);
    else escaped += c;
  }
  let possible = quoteTypes;
  if (escaped.includes("\n")) possible = possible.filter((q) => MULTI_QUOTES.includes(q));
  possible = possible.filter((q) => !escaped.includes(q));
  if (!possible.length) {
    const s = pyStrRepr(string);
    const quote = quoteTypes.find((q) => q.includes(s[0]!)) ?? s[0]!;
    return [s.slice(1, -1), [quote]];
  }
  if (escaped) {
    const last = escaped[escaped.length - 1]!;
    possible = [...possible.filter((q) => q[0] !== last), ...possible.filter((q) => q[0] === last)];
    if (possible[0]![0] === last) escaped = escaped.slice(0, -1) + "\\" + last;
  }
  return [escaped, possible];
}

class Unparser {
  private out: string[] = [];
  private readonly precedences = new Map<N, number>();

  visit(node: N): string {
    this.out = [];
    this.traverse(node);
    return this.out.join("");
  }

  setPrecedence(p: number, ...nodes: (N | null | undefined)[]): void {
    for (const n of nodes) if (n) this.precedences.set(n, p);
  }

  private write(...text: string[]): void {
    this.out.push(...text);
  }

  private buffered(fn: () => void): string[] {
    const saved = this.out;
    this.out = [];
    try {
      fn();
      return this.out;
    } finally {
      this.out = saved;
    }
  }

  private requireParens(p: number, node: N, body: () => void): void {
    const parens = (this.precedences.get(node) ?? TEST) > p;
    if (parens) this.write("(");
    body();
    if (parens) this.write(")");
  }

  private interleave<T>(sep: string, f: (x: T) => void, seq: T[]): void {
    seq.forEach((x, i) => {
      if (i) this.write(sep);
      f(x);
    });
  }

  private itemsView(items: N[]): void {
    if (items.length === 1) {
      this.traverse(items[0]!);
      this.write(",");
    } else {
      this.interleave(", ", (n: N) => this.traverse(n), items);
    }
  }

  private traverse(node: N): void {
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
        this.interleave(", ", (n: N) => this.traverse(n), node.elts);
        return this.write("]");
      case "ListComp":
      case "GeneratorExp":
      case "SetComp": {
        const [open, close] = node._t === "ListComp" ? ["[", "]"] : node._t === "SetComp" ? ["{", "}"] : ["(", ")"];
        this.write(open!);
        this.traverse(node.elt);
        for (const g of node.generators) this.traverse(g);
        return this.write(close!);
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
        this.interleave(", ", (n: N) => this.traverse(n), node.elts);
        return this.write("}");
      case "Dict":
        this.write("{");
        this.interleave(
          ", ",
          (i: number) => {
            const k = node.keys[i] as N | null;
            const v = node.values[i] as N;
            if (k === null) {
              this.write("**");
              this.setPrecedence(EXPR, v);
            } else {
              this.traverse(k);
              this.write(": ");
            }
            this.traverse(v);
          },
          node.keys.map((_: unknown, i: number) => i),
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
        const p = BINOP_PRECEDENCE[node.op]!;
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
          (node.ops as string[]).forEach((o, i) => {
            this.write(` ${o} `);
            this.traverse(node.comparators[i]);
          });
        });
      case "BoolOp": {
        // the parens check sees the operator's own level; each operand then gets a higher one
        let p = node.op === "and" ? AND : OR;
        return this.requireParens(p, node, () => {
          this.interleave(
            ` ${node.op} `,
            (v: N) => {
              p = next(p);
              this.setPrecedence(p, v);
              this.traverse(v);
            },
            node.values,
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
        this.interleave(", ", (n: N) => this.traverse(n), [...node.args, ...node.keywords]);
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

  private constant(node: N): void {
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

  private args(node: N): void {
    let first = true;
    const sep = (): void => {
      if (first) first = false;
      else this.write(", ");
    };
    const all = [...node.posonlyargs, ...node.args] as N[];
    const defaults = [...Array<null>(all.length - node.defaults.length).fill(null), ...node.defaults] as (N | null)[];
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
    (node.kwonlyargs as N[]).forEach((a, i) => {
      this.write(", ");
      this.traverse(a);
      const d = node.kw_defaults[i] as N | null;
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

  private ftstring(values: N[], prefix: string): void {
    this.write(prefix);
    const parts = values.map((v): [string, boolean] => [this.buffered(() => this.ftstringInner(v, false)).join(""), v._t === "Constant"]);
    this.ftstringHelper(parts);
  }

  private ftstringInner(node: N, isFormatSpec: boolean): void {
    if (node._t === "JoinedStr") {
      for (const v of node.values) this.ftstringInner(v, isFormatSpec);
    } else if (node._t === "Constant" && node.cv === "str") {
      let value = (node.v as string).replaceAll("{", "{{").replaceAll("}", "}}");
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

  private interpolation(node: N, useStrAttr: boolean): void {
    this.write("{");
    let expr: string;
    if (useStrAttr) {
      expr = node.str;
    } else {
      const inner = new Unparser();
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

  private ftstringHelper(parts: [string, boolean][]): void {
    const newParts: string[] = [];
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
    this.write(quoteTypes[0]!, newParts.join(""), quoteTypes[0]!);
  }
}

/** ast.unparse(node) for an expression node from pyparse.ts */
export function unparse(node: N): string {
  return new Unparser().visit(node);
}
