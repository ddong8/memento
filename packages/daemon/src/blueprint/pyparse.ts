// Python 3.14 parser for the blueprint generator: a recursive-descent port of CPython's PEG grammar
// (Grammar/python.gram) over the tokens from pylex.ts. It accepts and rejects the same modules as
// ast.parse and builds the expression nodes ast.unparse needs; statements keep only what the
// generator reads (bodies, ImportFrom, ClassDef bases, AnnAssign).
//
// PEG semantics are kept where they change the result: ordered choice, no backtracking into a
// group or repetition once it has matched, and left-recursive rules growing to the longest match.
// Like CPython's first parser pass, invalid_* rules are left out (they only pick error messages).
import { tokenize, PySyntaxError, syntaxError, type FField, type FPart, type Tok } from "./pylex.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = { _t: string; [k: string]: any };

export interface PyImportFrom {
  module: string | null;
  names: string[];
  level: number;
}

export interface PyClass {
  name: string;
  /** Positional class arguments (Starred included), as ast.ClassDef.bases */
  bases: N[];
  /** Annotated assignments to a plain name in the class body */
  fields: { name: string; annotation: N }[];
}

export interface PyModule {
  /** Every ImportFrom, in ast.walk (breadth-first) order */
  imports: PyImportFrom[];
  /** Top-level classes */
  classes: PyClass[];
}

interface Shared {
  /** from __future__ import barry_as_FLUFL has been seen */
  flufl: boolean;
}

interface CallArgs {
  args: N[];
  keywords: N[];
}

const AUGASSIGN = new Set(["+=", "-=", "*=", "@=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "**=", "//="]);
const SUM_OPS = new Set(["+", "-"]);
const TERM_OPS = new Set(["*", "/", "//", "%", "@"]);
const SHIFT_OPS = new Set(["<<", ">>"]);
const OR_OPS = new Set(["|"]);
const XOR_OPS = new Set(["^"]);
const AND_OPS = new Set(["&"]);
const SIMPLE_CMP = new Set(["==", "<=", "<", ">=", ">"]);

const FUTURE_FEATURES = new Set([
  "nested_scopes", "generators", "division", "absolute_import", "with_statement", "print_function",
  "unicode_literals", "barry_as_FLUFL", "generator_stop", "annotations",
]);

const strConst = (v: string, kind: string | null = null): N => ({ _t: "Constant", cv: "str", v, kind });
const nameNode = (id: string): N => ({ _t: "Name", id });
const tupleNode = (elts: N[]): N => ({ _t: "Tuple", elts });

/** Fold runs of string constants (kind of the first one wins) and optionally drop empty ones. */
function foldConstants(flat: N[], dropEmpty: boolean): N[] {
  const out: N[] = [];
  for (let i = 0; i < flat.length; i++) {
    let el = flat[i]!;
    if (el._t === "Constant") {
      if (i + 1 < flat.length && flat[i + 1]!._t === "Constant") {
        let v = "";
        let j = i;
        for (; j < flat.length && flat[j]!._t === "Constant"; j++) v += flat[j]!.v as string;
        el = strConst(v, el.kind as string | null);
        i = j - 1;
      }
      if (dropEmpty && el.v === "") continue;
    }
    out.push(el);
  }
  return out;
}

class Parser {
  private readonly toks: Tok[];
  private p = 0;
  private readonly sh: Shared;
  private readonly memos = new Map<string, Map<number, { r: unknown; e: number }>>();

  constructor(toks: Tok[], sh: Shared) {
    this.toks = toks;
    this.sh = sh;
  }

  // ---------------------------------------------------------------- token helpers

  private get tok(): Tok {
    return this.toks[this.p]!;
  }

  private at(k: number): Tok {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)]!;
  }

  private isOp(v: string, k = 0): boolean {
    const t = this.at(k);
    return t.t === "OP" && t.v === v;
  }

  private op(v: string): boolean {
    if (!this.isOp(v)) return false;
    this.p++;
    return true;
  }

  private isKw(w: string, k = 0): boolean {
    const t = this.at(k);
    return t.t === "NAME" && t.kw === true && t.raw === w;
  }

  private kw(w: string): boolean {
    if (!this.isKw(w)) return false;
    this.p++;
    return true;
  }

  private isSoft(w: string): boolean {
    const t = this.tok;
    return t.t === "NAME" && !t.kw && t.raw === w;
  }

  /** NAME (not a keyword): the normalised identifier */
  private name(): string | null {
    const t = this.tok;
    if (t.t !== "NAME" || t.kw) return null;
    this.p++;
    return t.v;
  }

  private tLookahead(): boolean {
    return this.isOp("(") || this.isOp("[") || this.isOp(".");
  }

  private mem<T>(key: string, fn: () => T | null): T | null {
    let tab = this.memos.get(key);
    if (!tab) this.memos.set(key, (tab = new Map()));
    const start = this.p;
    const hit = tab.get(start);
    if (hit) {
      this.p = hit.e;
      return hit.r as T | null;
    }
    const r = fn();
    if (r === null) this.p = start;
    tab.set(start, { r, e: this.p });
    return r;
  }

  /** item (sep item)*: a separator is only taken when an item follows it */
  private gather<T>(item: () => T | null, sep = ","): T[] | null {
    const first = item();
    if (first === null) return null;
    const out = [first];
    for (;;) {
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

  private many<T>(item: () => T | null): T[] {
    const out: T[] = [];
    for (let it = item(); it !== null; it = item()) out.push(it);
    return out;
  }

  // ---------------------------------------------------------------- statements

  file(): N {
    const body = this.statements() ?? [];
    if (this.tok.t !== "END") syntaxError("invalid syntax");
    return { _t: "Module", body };
  }

  private statements(): N[] | null {
    const out: N[] = [];
    for (;;) {
      const s = this.statement();
      if (!s) break;
      out.push(...s);
    }
    return out.length ? out : null;
  }

  private statement(): N[] | null {
    const c = this.compoundStmt();
    if (c) return [c];
    return this.simpleStmts();
  }

  private simpleStmts(): N[] | null {
    const m = this.p;
    const first = this.simpleStmt();
    if (!first) return null;
    if (!this.isOp(";") && this.tok.t === "NEWLINE") {
      this.p++;
      return [first];
    }
    const out = [first];
    for (;;) {
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

  private simpleStmt(): N | null {
    return this.mem("simple_stmt", () => {
      const a = this.assignment();
      if (a) return a;
      if (this.isSoft("type")) {
        const t = this.typeAlias();
        if (t) return t;
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
  private optAssignValue(): N | null {
    const q = this.p;
    if (this.op("=")) {
      const v = this.annotatedRhs();
      if (v) return v;
      this.p = q;
    }
    return null;
  }

  private assignment(): N | null {
    const m = this.p;
    // NAME ':' expression ['=' annotated_rhs]
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
    // ('(' single_target ')' | single_subscript_attribute_target) ':' expression ['=' annotated_rhs]
    let target: N | null = null;
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
    // (star_targets '=')+ annotated_rhs !'='
    const targets: N[] = [];
    for (;;) {
      const q = this.p;
      const st = this.starTargets();
      if (!st || !this.op("=")) {
        this.p = q;
        break;
      }
      targets.push(st);
    }
    if (targets.length) {
      const value = this.annotatedRhs();
      if (value && !this.isOp("=")) return { _t: "Assign", targets, value };
    }
    this.p = m;
    // single_target augassign ~ annotated_rhs
    const st = this.singleTarget();
    if (st && this.tok.t === "OP" && AUGASSIGN.has(this.tok.v)) {
      this.p++;
      const value = this.annotatedRhs();
      if (value) return { _t: "AugAssign", target: st, value };
    }
    this.p = m;
    return null;
  }

  private annotatedRhs(): N | null {
    return this.yieldExpr() ?? this.starExpressions();
  }

  private typeAlias(): N | null {
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

  private returnStmt(): N {
    this.p++;
    return { _t: "Return", value: this.starExpressions() };
  }

  private raiseStmt(): N {
    this.p++;
    const exc = this.expression();
    if (exc) {
      const q = this.p;
      if (this.kw("from") && !this.expression()) this.p = q;
    }
    return { _t: "Raise" };
  }

  private globalStmt(): N | null {
    const m = this.p;
    this.p++;
    const names = this.gather(() => this.name());
    if (!names) {
      this.p = m;
      return null;
    }
    return { _t: "Global" };
  }

  private assertStmt(): N | null {
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

  private delStmt(): N | null {
    const m = this.p;
    this.p++;
    const targets = this.delTargets();
    if (targets && (this.isOp(";") || this.tok.t === "NEWLINE")) return { _t: "Delete" };
    this.p = m;
    return null;
  }

  private importStmt(): N | null {
    if (this.isKw("import")) {
      const m = this.p;
      this.p++;
      if (this.gather(() => this.dottedAsName())) return { _t: "Import" };
      this.p = m;
      return null;
    }
    return this.importFrom();
  }

  private dottedAsName(): string | null {
    const n = this.dottedName();
    if (n === null) return null;
    const q = this.p;
    if (this.kw("as") && this.name() === null) this.p = q;
    return n;
  }

  private dottedName(): string | null {
    let n = this.name();
    if (n === null) return null;
    for (;;) {
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

  private importFrom(): N | null {
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

  private importFromTargets(): string[] | null {
    const m = this.p;
    if (this.op("(")) {
      const names = this.importFromAsNames();
      if (names) {
        this.op(",");
        if (this.op(")")) return names;
      }
      this.p = m;
    }
    const names = this.importFromAsNames();
    if (names && !this.isOp(",")) return names;
    this.p = m;
    if (this.op("*")) return ["*"];
    return null;
  }

  private importFromAsNames(): string[] | null {
    return this.gather(() => {
      const n = this.name();
      if (n === null) return null;
      const q = this.p;
      if (this.kw("as") && this.name() === null) this.p = q;
      return n;
    });
  }

  // ---------------------------------------------------------------- compound statements

  private compoundStmt(): N | null {
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

  private block(): N[] | null {
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

  private decorators(): boolean {
    let any = false;
    for (;;) {
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

  private functionDef(): N | null {
    const m = this.p;
    this.decorators();
    const f = this.functionDefRaw();
    if (!f) this.p = m;
    return f;
  }

  private functionDefRaw(): N | null {
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

  private classDef(): N | null {
    const m = this.p;
    this.decorators();
    if (this.kw("class")) {
      const n = this.name();
      if (n !== null) {
        this.typeParams();
        let bases: N[] = [];
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

  private typeParams(): boolean {
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

  private typeParam(): true | null {
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

  private ifStmt(): N | null {
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

  private elifStmt(): N | null {
    if (!this.isKw("elif")) return null;
    return this.ifStmt();
  }

  private elseBlock(): N[] | null {
    const m = this.p;
    if (!this.kw("else")) return null;
    if (!this.op(":")) syntaxError("expected ':'");
    const b = this.block();
    if (!b) this.p = m;
    return b;
  }

  private whileStmt(): N | null {
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

  private forStmt(): N | null {
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

  private withStmt(): N | null {
    const m = this.p;
    const isAsync = this.kw("async");
    if (!this.kw("with")) {
      this.p = m;
      return null;
    }
    const t = isAsync ? "AsyncWith" : "With";
    const afterWith = this.p;
    if (this.op("(")) {
      const items = this.gather(() => this.withItem());
      if (items) {
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

  private withItem(): true | null {
    if (!this.expression()) return null;
    const q = this.p;
    if (this.kw("as") && this.starTarget() && (this.isOp(",") || this.isOp(")") || this.isOp(":"))) return true;
    this.p = q;
    return true;
  }

  private tryStmt(): N | null {
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

  private finallyBlock(): N[] | null {
    const m = this.p;
    if (!this.kw("finally")) return null;
    if (!this.op(":")) syntaxError("expected ':'");
    const b = this.block();
    if (!b) this.p = m;
    return b;
  }

  private exceptBlock(star: boolean): N | null {
    const m = this.p;
    if (!this.kw("except") || (star && !this.op("*"))) {
      this.p = m;
      return null;
    }
    const handler = (): N | null => {
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

  private matchStmt(): N | null {
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

  private subjectExpr(): N | null {
    const m = this.p;
    const v = this.starNamedExpression();
    if (v && this.op(",")) return tupleNode([v, ...(this.starNamedExpressions() ?? [])]);
    this.p = m;
    return this.namedExpression();
  }

  private caseBlock(): N | null {
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

  private patterns(): boolean {
    const m = this.p;
    if (this.openSequencePattern()) return true;
    this.p = m;
    return this.pattern();
  }

  private pattern(): boolean {
    return this.asPattern() || this.orPattern();
  }

  private asPattern(): boolean {
    const m = this.p;
    if (this.orPattern() && this.kw("as") && this.patternCaptureTarget()) return true;
    this.p = m;
    return false;
  }

  private orPattern(): boolean {
    return this.gather(() => this.closedPattern(), "|") !== null;
  }

  private closedPattern(): true | null {
    return this.mem("closed_pattern", () => {
      const ok =
        this.literalPattern() ||
        this.patternCaptureTarget() ||
        this.wildcardPattern() ||
        this.valuePattern() ||
        this.groupPattern() ||
        this.sequencePattern() ||
        this.mappingPattern() ||
        this.classPattern();
      return ok ? true : null;
    });
  }

  /** literal_pattern and literal_expr accept the same tokens */
  private literalPattern(): boolean {
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

  private signedNumber(): boolean {
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

  private complexNumber(): boolean {
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

  private realNumber(): boolean {
    const t = this.tok;
    if (t.t !== "NUMBER") return false;
    if (t.num?.k === "complex") syntaxError("real number required in complex literal");
    this.p++;
    return true;
  }

  private imaginaryNumber(): boolean {
    const t = this.tok;
    if (t.t !== "NUMBER") return false;
    if (t.num?.k !== "complex") syntaxError("imaginary number required in complex literal");
    this.p++;
    return true;
  }

  /** !"_" NAME !('.' | '(' | '=') */
  private patternCaptureTarget(): boolean {
    if (this.isSoft("_")) return false;
    const m = this.p;
    if (this.name() !== null && !this.isOp(".") && !this.isOp("(") && !this.isOp("=")) return true;
    this.p = m;
    return false;
  }

  private wildcardPattern(): boolean {
    if (!this.isSoft("_")) return false;
    this.p++;
    return true;
  }

  private valuePattern(): boolean {
    const m = this.p;
    if (this.attr() && !this.isOp(".") && !this.isOp("(") && !this.isOp("=")) return true;
    this.p = m;
    return false;
  }

  /** NAME ('.' NAME)+ */
  private attr(): boolean {
    const m = this.p;
    if (this.name() === null) return false;
    let dots = 0;
    for (;;) {
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

  private groupPattern(): boolean {
    const m = this.p;
    if (this.op("(") && this.pattern() && this.op(")")) return true;
    this.p = m;
    return false;
  }

  private sequencePattern(): boolean {
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

  private openSequencePattern(): boolean {
    const m = this.p;
    if (this.maybeStarPattern() && this.op(",")) {
      this.maybeSequencePattern();
      return true;
    }
    this.p = m;
    return false;
  }

  private maybeSequencePattern(): boolean {
    if (!this.gather(() => (this.maybeStarPattern() ? true : null))) return false;
    this.op(",");
    return true;
  }

  private maybeStarPattern(): boolean {
    return this.starPattern() || this.pattern();
  }

  private starPattern(): boolean {
    const m = this.p;
    if (this.op("*") && (this.patternCaptureTarget() || this.wildcardPattern())) return true;
    this.p = m;
    return false;
  }

  private mappingPattern(): boolean {
    const m = this.p;
    if (!this.op("{")) return false;
    if (this.op("}")) return true;
    const afterBrace = this.p;
    if (this.doubleStarPattern()) {
      this.op(",");
      if (this.op("}")) return true;
    }
    this.p = afterBrace;
    const items = this.gather(() => (this.keyValuePattern() ? true : null));
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

  private keyValuePattern(): boolean {
    const m = this.p;
    if ((this.literalPattern() || this.attr()) && this.op(":") && this.pattern()) return true;
    this.p = m;
    return false;
  }

  private doubleStarPattern(): boolean {
    const m = this.p;
    if (this.op("**") && this.patternCaptureTarget()) return true;
    this.p = m;
    return false;
  }

  private classPattern(): boolean {
    const m = this.p;
    if (this.dottedName() === null || !this.op("(")) {
      this.p = m;
      return false;
    }
    if (this.op(")")) return true;
    const afterParen = this.p;
    const positional = () => this.gather(() => (this.pattern() ? true : null));
    const keywords = () =>
      this.gather(() => {
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
  private params(lambda: boolean): N | null {
    const m = this.p;
    const term = lambda ? ":" : ")";
    const endOk = (): boolean => this.op(",") || this.isOp(term);
    const param = (): N | null => {
      const n = this.name();
      if (n === null) return null;
      let annotation: N | null = null;
      if (!lambda) {
        const q = this.p;
        if (this.op(":")) {
          annotation = this.expression();
          if (!annotation) this.p = q;
        }
      }
      return { _t: "arg", arg: n, annotation };
    };
    const dflt = (): N | null => {
      const q = this.p;
      if (!this.op("=")) return null;
      const e = this.expression();
      if (!e) this.p = q;
      return e;
    };
    const noDefault = (): N | null => {
      const q = this.p;
      const a = param();
      if (a && endOk()) return a;
      this.p = q;
      return null;
    };
    const withDefault = (): [N, N] | null => {
      const q = this.p;
      const a = param();
      if (a) {
        const d = dflt();
        if (d && endOk()) return [a, d];
      }
      this.p = q;
      return null;
    };
    const maybeDefault = (): [N, N | null] | null => {
      const q = this.p;
      const a = param();
      if (a) {
        const d = dflt();
        if (endOk()) return [a, d];
      }
      this.p = q;
      return null;
    };
    const starAnnotated = (): N | null => {
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
    const kwds = (): N | null => {
      const q = this.p;
      if (this.op("**")) {
        const a = noDefault();
        if (a) return a;
      }
      this.p = q;
      return null;
    };
    interface StarEtc {
      vararg: N | null;
      kwonly: [N, N | null][];
      kwarg: N | null;
    }
    const starEtc = (): StarEtc | null => {
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
    const slash = (): boolean => {
      if (this.op("/")) {
        if (this.op(",") || this.isOp(term)) return true;
      }
      return false;
    };
    const make = (posonly: N[], posonlyDefaults: N[], plain: N[], withDefs: [N, N][], se: StarEtc | null): N => ({
      _t: "arguments",
      posonlyargs: posonly,
      args: [...plain, ...withDefs.map((d) => d[0])],
      defaults: [...posonlyDefaults, ...withDefs.map((d) => d[1])],
      vararg: se?.vararg ?? null,
      kwonlyargs: se?.kwonly.map((d) => d[0]) ?? [],
      kw_defaults: se?.kwonly.map((d) => d[1]) ?? [],
      kwarg: se?.kwarg ?? null,
    });

    // slash_no_default param_no_default* param_with_default* [star_etc]
    {
      const a = this.many(noDefault);
      if (a.length && slash()) {
        const b = this.many(noDefault);
        const c = this.many(withDefault);
        return make(a, [], b, c, starEtc());
      }
      this.p = m;
    }
    // slash_with_default param_with_default* [star_etc]
    {
      const a = this.many(noDefault);
      const b = this.many(withDefault);
      if (b.length && slash()) {
        const c = this.many(withDefault);
        return make([...a, ...b.map((d) => d[0])], b.map((d) => d[1]), [], c, starEtc());
      }
      this.p = m;
    }
    // param_no_default+ param_with_default* [star_etc]
    {
      const a = this.many(noDefault);
      if (a.length) return make([], [], a, this.many(withDefault), starEtc());
    }
    // param_with_default+ [star_etc]
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

  private expressions(): N | null {
    const a = this.expression();
    if (!a) return null;
    if (!this.isOp(",")) return a;
    const elts = [a];
    for (;;) {
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

  private expression(): N | null {
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

  private lambdef(): N | null {
    if (!this.isKw("lambda")) return null;
    const m = this.p;
    this.p++;
    const args = this.params(true) ?? {
      _t: "arguments", posonlyargs: [], args: [], defaults: [], vararg: null, kwonlyargs: [], kw_defaults: [], kwarg: null,
    };
    if (this.op(":")) {
      const body = this.expression();
      if (body) return { _t: "Lambda", args, body };
    }
    this.p = m;
    return null;
  }

  private yieldExpr(): N | null {
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

  private starExpressions(): N | null {
    const a = this.starExpression();
    if (!a) return null;
    if (!this.isOp(",")) return a;
    const elts = [a];
    for (;;) {
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

  private starExpression(): N | null {
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

  private starNamedExpressions(): N[] | null {
    const items = this.gather(() => this.starNamedExpression());
    if (items) this.op(",");
    return items;
  }

  private starNamedExpression(): N | null {
    if (this.isOp("*")) {
      const m = this.p;
      this.p++;
      const v = this.bitwiseOr();
      if (v) return { _t: "Starred", value: v };
      this.p = m;
    }
    return this.namedExpression();
  }

  private assignmentExpression(): N | null {
    const t = this.tok;
    if (t.t !== "NAME" || t.kw || !this.isOp(":=", 1)) return null;
    const m = this.p;
    this.p += 2;
    const value = this.expression();
    if (value) return { _t: "NamedExpr", target: nameNode(t.v), value };
    this.p = m;
    return null;
  }

  private namedExpression(): N | null {
    const a = this.assignmentExpression();
    if (a) return a;
    const m = this.p;
    const e = this.expression();
    if (e && !this.isOp(":=")) return e;
    this.p = m;
    return null;
  }

  /** assignment_expression | expression !':=' */
  private namedOrPlain(): N | null {
    return this.namedExpression();
  }

  private disjunction(): N | null {
    return this.mem("disjunction", () => this.boolOp("or", () => this.conjunction()));
  }

  private conjunction(): N | null {
    return this.mem("conjunction", () => this.boolOp("and", () => this.inversion()));
  }

  private boolOp(word: string, sub: () => N | null): N | null {
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

  private inversion(): N | null {
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

  private comparison(): N | null {
    const left = this.bitwiseOr();
    if (!left) return null;
    const ops: string[] = [];
    const comparators: N[] = [];
    for (;;) {
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

  private compareOp(): string | null {
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

  private binLoop(sub: () => N | null, ops: Set<string>): N | null {
    let left = sub();
    if (!left) return null;
    for (;;) {
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

  private bitwiseOr(): N | null {
    return this.mem("bitwise_or", () => this.binLoop(() => this.bitwiseXor(), OR_OPS));
  }

  private bitwiseXor(): N | null {
    return this.binLoop(() => this.bitwiseAnd(), XOR_OPS);
  }

  private bitwiseAnd(): N | null {
    return this.binLoop(() => this.shiftExpr(), AND_OPS);
  }

  private shiftExpr(): N | null {
    return this.binLoop(() => this.sum(), SHIFT_OPS);
  }

  private sum(): N | null {
    return this.binLoop(() => this.term(), SUM_OPS);
  }

  private term(): N | null {
    return this.binLoop(() => this.factor(), TERM_OPS);
  }

  private factor(): N | null {
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

  private power(): N | null {
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

  private awaitPrimary(): N | null {
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

  private primary(): N | null {
    return this.mem("primary", () => {
      let a = this.atom();
      if (!a) return null;
      for (let b = this.trailer(a, false); b; b = this.trailer(a, false)) a = b;
      return a;
    });
  }

  /** One '.' NAME / genexp / '(' [arguments] ')' / '[' slices ']' step of primary or t_primary. */
  private trailer(a: N, lookahead: boolean): N | null {
    const q = this.p;
    const ok = (): boolean => !lookahead || this.tLookahead();
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

  private slices(): N | null {
    const m = this.p;
    const a = this.slice();
    if (a && !this.isOp(",")) return a;
    this.p = m;
    const items = this.gather(() => this.slice() ?? this.starredExpression());
    if (!items) return null;
    this.op(",");
    return tupleNode(items);
  }

  private slice(): N | null {
    const m = this.p;
    const lower = this.expression();
    if (this.op(":")) {
      const upper = this.expression();
      let step: N | null = null;
      if (this.op(":")) step = this.expression();
      return { _t: "Slice", lower, upper, step };
    }
    this.p = m;
    return this.namedExpression();
  }

  private starredExpression(): N | null {
    if (!this.isOp("*")) return null;
    const m = this.p;
    this.p++;
    const value = this.expression();
    if (value) return { _t: "Starred", value };
    this.p = m;
    return null;
  }

  private atom(): N | null {
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
          const n = t.num!;
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

  private tuple(): N | null {
    const m = this.p;
    this.p++;
    let elts: N[] = [];
    const q = this.p;
    const a = this.starNamedExpression();
    if (a && this.op(",")) elts = [a, ...(this.starNamedExpressions() ?? [])];
    else this.p = q;
    if (this.op(")")) return tupleNode(elts);
    this.p = m;
    return null;
  }

  private group(): N | null {
    const m = this.p;
    this.p++;
    const e = this.yieldExpr() ?? this.namedExpression();
    if (e && this.op(")")) return e;
    this.p = m;
    return null;
  }

  /** '(' (assignment_expression | expression !':=') for_if_clauses ')' */
  private genexp(): N | null {
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

  private list(): N | null {
    const m = this.p;
    this.p++;
    const elts = this.starNamedExpressions() ?? [];
    if (this.op("]")) return { _t: "List", elts };
    this.p = m;
    return null;
  }

  private listcomp(): N | null {
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

  private dict(): N | null {
    const m = this.p;
    this.p++;
    const keys: (N | null)[] = [];
    const values: N[] = [];
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

  private doubleStarredKvpair(): [N | null, N] | null {
    if (this.isOp("**")) {
      const m = this.p;
      this.p++;
      const v = this.bitwiseOr();
      if (v) return [null, v];
      this.p = m;
    }
    return this.kvpair();
  }

  private kvpair(): [N, N] | null {
    const m = this.p;
    const k = this.expression();
    if (k && this.op(":")) {
      const v = this.expression();
      if (v) return [k, v];
    }
    this.p = m;
    return null;
  }

  private set(): N | null {
    const m = this.p;
    this.p++;
    const elts = this.starNamedExpressions();
    if (elts && this.op("}")) return { _t: "Set", elts };
    this.p = m;
    return null;
  }

  private dictcomp(): N | null {
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

  private setcomp(): N | null {
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

  private forIfClauses(): N[] | null {
    const out = this.many(() => this.forIfClause());
    return out.length ? out : null;
  }

  private forIfClause(): N | null {
    const m = this.p;
    const isAsync = this.isKw("async") && this.isKw("for", 1);
    if (isAsync) this.p++;
    if (this.kw("for")) {
      const target = this.starTargets();
      if (target && this.kw("in")) {
        const iter = this.disjunction();
        if (iter) {
          const ifs: N[] = [];
          for (;;) {
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

  private arguments(): CallArgs | null {
    return this.mem("arguments", () => {
      const a = this.args();
      if (a) {
        this.op(",");
        if (this.isOp(")")) return a;
      }
      return null;
    });
  }

  private args(): CallArgs | null {
    const m = this.p;
    const positional = (): N | null => {
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
      let kw: N[] | null = null;
      if (this.op(",")) {
        kw = this.kwargs();
        if (!kw) this.p = q;
      }
      return this.splitArgs(pos, kw ?? []);
    }
    this.p = m;
    const kw = this.kwargs();
    return kw ? this.splitArgs([], kw) : null;
  }

  private splitArgs(pos: N[], kw: N[]): CallArgs {
    return {
      args: [...pos, ...kw.filter((k) => k._t === "Starred")],
      keywords: kw.filter((k) => k._t === "keyword"),
    };
  }

  private kwargs(): N[] | null {
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
  private kwarg(double: boolean): N | null {
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

  private starTargets(): N | null {
    const a = this.starTarget();
    if (!a) return null;
    if (!this.isOp(",")) return a;
    const elts = [a];
    for (;;) {
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

  private starTarget(): N | null {
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

  private targetWithStarAtom(): N | null {
    return this.mem("target_with_star_atom", () => this.subscriptAttributeTarget() ?? this.starAtom());
  }

  private starAtom(): N | null {
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

  private starTargetsTupleSeq(): N[] | null {
    const m = this.p;
    const a = this.starTarget();
    if (!a) return null;
    const out = [a];
    for (;;) {
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

  private singleTarget(): N | null {
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
  private subscriptAttributeTarget(): N | null {
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

  private tPrimary(): N | null {
    return this.mem("t_primary", () => {
      let a = this.atom();
      if (!a || !this.tLookahead()) return null;
      for (let b = this.trailer(a, true); b; b = this.trailer(a, true)) a = b;
      return a;
    });
  }

  private delTargets(): N[] | null {
    const items = this.gather(() => this.delTarget());
    if (items) this.op(",");
    return items;
  }

  private delTarget(): N | null {
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

  private strings(): N | null {
    return this.mem("strings", () => {
      const toks: Tok[] = [];
      while (this.tok.t === "STRING" || this.tok.t === "FSTRING") toks.push(this.toks[this.p++]!);
      if (!toks.length) return null;
      const isT = toks.some((t) => t.tstr);
      if (isT && toks.some((t) => !t.tstr)) syntaxError("cannot mix t-string literals with string or bytes literals");
      const hasF = toks.some((t) => t.t === "FSTRING");
      if (toks.some((t) => t.bytes) && toks.some((t) => !t.bytes)) syntaxError("cannot mix bytes and nonbytes literals");
      const first = toks[0]!;
      if (first.bytes) return { _t: "Constant", cv: "bytes", v: toks.map((t) => t.sv).join(""), kind: null };
      if (!hasF && toks.length === 1) return strConst(first.sv!, first.u ? "u" : null);
      const flat: N[] = [];
      for (const t of toks) {
        if (t.t === "STRING") flat.push(strConst(t.sv!, t.u ? "u" : null));
        else this.ftParts(t.parts!, flat);
      }
      const values = foldConstants(flat, hasF);
      if (!hasF) return values[0]!;
      return { _t: isT ? "TemplateStr" : "JoinedStr", values };
    });
  }

  private ftParts(parts: FPart[], out: N[]): void {
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

  private fieldNode(f: FField): N {
    const sub = new Parser(f.toks, this.sh);
    const value = sub.annotatedRhs();
    if (!value || sub.tok.t !== "END") syntaxError("f-string: expecting '=', or '!', or ':', or '}'");
    let format_spec: N | null = null;
    if (f.spec) {
      const flat: N[] = [];
      this.ftParts(f.spec, flat);
      format_spec = { _t: "JoinedStr", values: foldConstants(flat, true) };
    }
    if (f.interp) return { _t: "Interpolation", value, str: f.str, conversion: f.conv, format_spec };
    return { _t: "FormattedValue", value, conversion: f.conv, format_spec };
  }
}

/** future.c: future statements may only follow the docstring and other future statements */
function checkFuture(mod: N): void {
  const body = mod.body as N[];
  let i = 0;
  const doc = body[0];
  if (doc && doc._t === "Expr" && doc.value._t === "Constant" && doc.value.cv === "str") i = 1;
  for (; i < body.length; i++) {
    const s = body[i]!;
    if (s._t !== "ImportFrom" || s.level !== 0 || s.module !== "__future__") return;
    for (const feature of s.names as string[]) {
      if (FUTURE_FEATURES.has(feature)) continue;
      if (feature === "braces") syntaxError("not a chance");
      syntaxError(`future feature ${feature} is not defined`);
    }
  }
}

function stmtChildren(n: N): N[] {
  switch (n._t) {
    case "Module":
    case "FunctionDef":
    case "AsyncFunctionDef":
    case "ClassDef":
    case "With":
    case "AsyncWith":
    case "ExceptHandler":
    case "match_case":
      return n.body as N[];
    case "If":
    case "For":
    case "AsyncFor":
    case "While":
      return [...(n.body as N[]), ...(n.orelse as N[])];
    case "Try":
    case "TryStar":
      return [...(n.body as N[]), ...(n.handlers as N[]), ...(n.orelse as N[]), ...(n.finalbody as N[])];
    case "Match":
      return n.cases as N[];
  }
  return [];
}

/** ast.parse(source) reduced to what the blueprint generator reads. Throws PySyntaxError. */
export function parseModule(source: string): PyModule {
  let mod: N;
  try {
    mod = new Parser(tokenize(source), { flufl: false }).file();
  } catch (e) {
    // CPython gives up on deeply nested sources too ("too complex" / RecursionError)
    if (e instanceof RangeError) throw new PySyntaxError("source too complex to parse");
    throw e;
  }
  checkFuture(mod);
  const imports: PyImportFrom[] = [];
  const queue: N[] = [mod];
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi]!;
    if (n._t === "ImportFrom") imports.push({ module: n.module, names: n.names, level: n.level });
    queue.push(...stmtChildren(n));
  }
  const classes: PyClass[] = [];
  for (const s of mod.body as N[]) {
    if (s._t !== "ClassDef") continue;
    const fields: PyClass["fields"] = [];
    for (const st of s.body as N[]) {
      if (st._t === "AnnAssign" && st.target._t === "Name") fields.push({ name: st.target.id, annotation: st.annotation });
    }
    classes.push({ name: s.name, bases: s.bases, fields });
  }
  return { imports, classes };
}
