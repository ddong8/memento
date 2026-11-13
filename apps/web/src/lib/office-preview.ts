/**
 * Word / PowerPoint / Excel files (the Office Open XML ones: docx, pptx, potx, xlsx) read in the page.
 * A browser can't show them: put in an iframe they are downloaded (the desktop app asked where to save
 * them, the user saw a file dialog pop up), and Office's online viewer can't reach a file on the user's
 * devices. So the workbench unzips them (fflate) and reads their XML here into plain structures the
 * viewer renders: a document's paragraphs, headings, lists, tables and pictures; a workbook's sheets; a
 * deck's slides with each shape where it is on the slide. Pure functions, no DOM: they run in tests too.
 */
import { unzipSync } from "fflate";

// ---------- XML ----------

export interface XNode {
  /** The tag without its namespace prefix (`w:p` → `p`). */
  name: string;
  attrs: Record<string, string>;
  children: XChild[];
}
export type XChild = XNode | string;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e] ?? m;
  });
}

const local = (name: string) => name.slice(name.indexOf(":") + 1);

/** A small XML reader: elements, attributes (keys without prefix) and text; enough for Office parts. */
export function parseXml(xml: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      pushText(stack[stack.length - 1], xml.slice(i));
      break;
    }
    if (lt > i) pushText(stack[stack.length - 1], xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      stack[stack.length - 1].children.push(xml.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const end = xml.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = tagEnd(xml, lt);
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag[0] === "/") {
      const name = local(tag.slice(1).trim());
      // Close up to the matching element (tolerates a stray close tag)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const sp = body.search(/\s/);
    const name = local(sp < 0 ? body : body.slice(0, sp));
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m: RegExpExecArray | null;
      const rest = body.slice(sp);
      while ((m = re.exec(rest))) attrs[local(m[1])] = decodeEntities(m[3] ?? m[4] ?? "");
    }
    const node: XNode = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/** Where the tag opened at lt ends (a `>` inside a quoted attribute doesn't end it). */
function tagEnd(xml: string, lt: number): number {
  let q = "";
  for (let k = lt + 1; k < xml.length; k++) {
    const c = xml[k];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return k;
  }
  return xml.length;
}

function pushText(node: XNode, raw: string) {
  if (raw) node.children.push(decodeEntities(raw));
}

const isNode = (c: XChild): c is XNode => typeof c !== "string";
export const kids = (n: XNode | undefined, name?: string): XNode[] =>
  n ? n.children.filter((c): c is XNode => isNode(c) && (!name || c.name === name)) : [];
export const kid = (n: XNode | undefined, name: string): XNode | undefined => kids(n, name)[0];

/** The first descendant with this name (depth first). */
export function find(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (!isNode(c)) continue;
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

export function findAll(n: XNode | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (!isNode(c)) continue;
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

/** All the text under n. */
export function textOf(n: XNode | undefined): string {
  if (!n) return "";
  let s = "";
  for (const c of n.children) s += typeof c === "string" ? c : textOf(c);
  return s;
}

// ---------- package ----------

export type OfficeFiles = Record<string, Uint8Array>;

export function unzipOffice(data: Uint8Array): OfficeFiles {
  return unzipSync(data);
}

const utf8 = new TextDecoder("utf-8");
function xmlPart(files: OfficeFiles, path: string): XNode | undefined {
  const bytes = files[path];
  return bytes ? parseXml(utf8.decode(bytes)) : undefined;
}

/** A part path from a relationship target, relative to the part that has the relationship. */
export function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = fromPart.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** A part's relationships: id → the target part (external links keep their URL, `external: true`). */
function relsOf(files: OfficeFiles, part: string): Record<string, { target: string; type: string; external: boolean }> {
  const slash = part.lastIndexOf("/");
  const relsPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
  const out: Record<string, { target: string; type: string; external: boolean }> = {};
  for (const r of findAll(xmlPart(files, relsPath), "Relationship")) {
    const external = r.attrs.TargetMode === "External";
    out[r.attrs.Id] = {
      target: external ? r.attrs.Target : resolvePart(part, r.attrs.Target ?? ""),
      type: (r.attrs.Type ?? "").split("/").pop() ?? "",
      external,
    };
  }
  return out;
}

/** Pictures a browser can show (emf/wmf can't be). */
export function imageMime(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  return (ext && map[ext]) || null;
}

const EMU_PER_PX = 9525;

// ---------- Word ----------

export interface DocRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  href?: string;
}
export type DocBlock =
  | { kind: "p"; runs: DocRun[]; heading?: number; list?: { level: number; ordered: boolean; number?: number }; align?: string }
  | { kind: "image"; part: string; width?: number; height?: number }
  | { kind: "table"; rows: DocBlock[][][] };

export interface DocxModel {
  blocks: DocBlock[];
}

export function parseDocx(files: OfficeFiles): DocxModel {
  const main = "word/document.xml";
  const doc = xmlPart(files, main);
  if (!doc) throw new Error("不是有效的 Word 文档（缺少 word/document.xml）");
  const rels = relsOf(files, main);

  // Style id → heading level, from the style's name ("heading 1", "Title")
  const headingOf: Record<string, number> = {};
  // Style id → the list its paragraphs are in ("List Number", "List Bullet" carry their numbering)
  const styleNum: Record<string, { numId: string; ilvl: number }> = {};
  for (const s of findAll(xmlPart(files, "word/styles.xml"), "style")) {
    const id = s.attrs.styleId;
    const sNum = kid(kid(s, "pPr"), "numPr");
    const sNumId = kid(sNum, "numId")?.attrs.val;
    if (id && sNumId) styleNum[id] = { numId: sNumId, ilvl: Number(kid(sNum, "ilvl")?.attrs.val ?? 0) };
    const name = (kid(s, "name")?.attrs.val ?? "").toLowerCase();
    const m = /^heading\s*(\d)$/.exec(name);
    if (id && m) headingOf[id] = Number(m[1]);
    else if (id && name === "title") headingOf[id] = 1;
    else if (id && name === "subtitle") headingOf[id] = 2;
  }
  // numId → whether its levels are numbered (decimal …) or bullets
  const ordered = numberingKinds(xmlPart(files, "word/numbering.xml"));

  const body = find(doc, "body");
  return { blocks: docBlocks(body, { rels, headingOf, styleNum, ordered, counters: {} }) };
}

function numberingKinds(numbering: XNode | undefined): Record<string, boolean> {
  const abs: Record<string, boolean> = {};
  for (const a of findAll(numbering, "abstractNum")) {
    const lvl0 = kids(a, "lvl").find((l) => l.attrs.ilvl === "0") ?? kid(a, "lvl");
    const fmt = kid(lvl0, "numFmt")?.attrs.val ?? "bullet";
    abs[a.attrs.abstractNumId] = fmt !== "bullet" && fmt !== "none";
  }
  const out: Record<string, boolean> = {};
  for (const num of findAll(numbering, "num")) {
    const absId = kid(num, "abstractNumId")?.attrs.val;
    if (num.attrs.numId && absId !== undefined) out[num.attrs.numId] = abs[absId] ?? false;
  }
  return out;
}

type Rels = ReturnType<typeof relsOf>;
interface DocCtx {
  rels: Rels;
  headingOf: Record<string, number>;
  styleNum: Record<string, { numId: string; ilvl: number }>;
  ordered: Record<string, boolean>;
  /** numId → the count at each level so far (numbered lists number on across the document). */
  counters: Record<string, number[]>;
}

function docBlocks(container: XNode | undefined, ctx: DocCtx): DocBlock[] {
  const out: DocBlock[] = [];
  for (const el of kids(container)) {
    if (el.name === "p") out.push(...docParagraph(el, ctx));
    else if (el.name === "tbl") {
      const rows = kids(el, "tr").map((tr) => kids(tr, "tc").map((tc) => docBlocks(tc, ctx)));
      out.push({ kind: "table", rows });
    } else if (el.name === "sdt") out.push(...docBlocks(kid(el, "sdtContent"), ctx));
  }
  return out;
}

function docParagraph(p: XNode, ctx: DocCtx): DocBlock[] {
  const { rels, headingOf, ordered } = ctx;
  const pPr = kid(p, "pPr");
  const styleId = kid(pPr, "pStyle")?.attrs.val ?? "";
  let heading = headingOf[styleId];
  if (heading === undefined) {
    const m = /^(?:heading|标题)\s*(\d)$/i.exec(styleId);
    if (m) heading = Number(m[1]);
  }
  const outline = kid(pPr, "outlineLvl")?.attrs.val;
  if (heading === undefined && outline !== undefined && Number(outline) < 6) heading = Number(outline) + 1;
  const numPr = kid(pPr, "numPr");
  const fromStyle = ctx.styleNum[styleId];
  const numId = kid(numPr, "numId")?.attrs.val ?? fromStyle?.numId;
  let list: { level: number; ordered: boolean; number?: number } | undefined;
  if (numId && numId !== "0") {
    const ilvl = kid(numPr, "ilvl")?.attrs.val;
    const level = ilvl !== undefined ? Number(ilvl) : (fromStyle?.ilvl ?? 0);
    const counts = (ctx.counters[numId] ??= []);
    counts[level] = (counts[level] ?? 0) + 1;
    counts.length = level + 1; // a deeper level starts over after this item
    list = { level, ordered: ordered[numId] ?? false, number: counts[level] };
  }
  const jc = kid(pPr, "jc")?.attrs.val;
  const align = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : undefined;

  const runs: DocRun[] = [];
  const images: DocBlock[] = [];
  const walk = (node: XNode, href?: string) => {
    for (const c of kids(node)) {
      if (c.name === "r") docRun(c, href, runs, images, rels);
      else if (c.name === "hyperlink") {
        const rel = c.attrs.id ? rels[c.attrs.id] : undefined;
        walk(c, rel?.external ? rel.target : href);
      } else if (c.name === "ins" || c.name === "smartTag" || c.name === "sdt" || c.name === "sdtContent" || c.name === "fldSimple") walk(c, href);
    }
  };
  walk(p);
  const out: DocBlock[] = [];
  if (runs.some((r) => r.text) || !images.length) out.push({ kind: "p", runs, heading, list, align });
  out.push(...images);
  return out;
}

function docRun(r: XNode, href: string | undefined, runs: DocRun[], images: DocBlock[], rels: Rels) {
  const rPr = kid(r, "rPr");
  const on = (name: string) => {
    const el = kid(rPr, name);
    return !!el && el.attrs.val !== "0" && el.attrs.val !== "false" && el.attrs.val !== "none";
  };
  const color = kid(rPr, "color")?.attrs.val;
  const style: Omit<DocRun, "text"> = {
    bold: on("b") || undefined,
    italic: on("i") || undefined,
    underline: on("u") || undefined,
    strike: on("strike") || undefined,
    color: color && /^[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== "000000" ? `#${color}` : undefined,
    href,
  };
  let text = "";
  for (const c of kids(r)) {
    if (c.name === "t") text += textOf(c);
    else if (c.name === "tab") text += "\t";
    else if (c.name === "br" || c.name === "cr") text += "\n";
    else if (c.name === "drawing" || c.name === "pict") {
      const blip = find(c, "blip") ?? find(c, "imagedata");
      const id = blip?.attrs.embed ?? blip?.attrs.id;
      const rel = id ? rels[id] : undefined;
      if (rel && !rel.external) {
        const ext = find(c, "extent");
        images.push({
          kind: "image",
          part: rel.target,
          width: ext ? Math.round(Number(ext.attrs.cx) / EMU_PER_PX) : undefined,
          height: ext ? Math.round(Number(ext.attrs.cy) / EMU_PER_PX) : undefined,
        });
      }
    }
  }
  if (text) runs.push({ text, ...style });
}

// ---------- Excel ----------

export interface SheetModel {
  name: string;
  /** rows[r][c], from A1; empty cells are "". */
  rows: string[][];
  /** The sheet had more rows than were read. */
  truncated: boolean;
}
export interface XlsxModel {
  sheets: SheetModel[];
}

export const MAX_SHEET_ROWS = 5000;
const MAX_SHEET_COLS = 200;

/** Column letters → index (A → 0, AA → 26). */
export function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Built-in number formats that are dates (14–22, 45–47), and custom ones with day/month/year parts. */
function dateStyles(styles: XNode | undefined): Set<number> {
  const customDate = new Set<string>();
  for (const f of findAll(kid(find(styles, "styleSheet") ?? styles, "numFmts"), "numFmt")) {
    const code = (f.attrs.formatCode ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
    if (/[dy]|m{1,4}(?![^;]*[hs])/i.test(code) && !/^[#0.,%\s]+$/.test(code)) customDate.add(f.attrs.numFmtId);
  }
  const out = new Set<number>();
  kids(find(styles, "cellXfs"), "xf").forEach((xf, i) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || customDate.has(String(id))) out.add(i);
  });
  return out;
}

/** An Excel serial date as yyyy-mm-dd (with the time when it has one). */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

export function parseXlsx(files: OfficeFiles): XlsxModel {
  const wbPath = "xl/workbook.xml";
  const wb = xmlPart(files, wbPath);
  if (!wb) throw new Error("不是有效的 Excel 工作簿（缺少 xl/workbook.xml）");
  const rels = relsOf(files, wbPath);
  const shared = findAll(xmlPart(files, "xl/sharedStrings.xml"), "si").map((si) =>
    findAll(si, "t")
      .filter((t) => !isInPhonetic(si, t))
      .map(textOf)
      .join(""),
  );
  const dates = dateStyles(xmlPart(files, "xl/styles.xml"));

  const sheets: SheetModel[] = [];
  for (const s of findAll(wb, "sheet")) {
    const rel = s.attrs.id ? rels[s.attrs.id] : undefined;
    if (!rel || rel.external) continue;
    const sheet = xmlPart(files, rel.target);
    if (!sheet) continue;
    const rows: string[][] = [];
    let truncated = false;
    let nextRow = 0;
    for (const row of kids(find(sheet, "sheetData"), "row")) {
      const r = row.attrs.r ? Number(row.attrs.r) - 1 : nextRow;
      nextRow = r + 1;
      if (r >= MAX_SHEET_ROWS) {
        truncated = true;
        break;
      }
      const cells: string[] = [];
      let nextCol = 0;
      for (const c of kids(row, "c")) {
        const col = c.attrs.r ? colIndex(c.attrs.r) : nextCol;
        nextCol = col + 1;
        if (col < 0 || col >= MAX_SHEET_COLS) continue;
        const t = c.attrs.t;
        const v = textOf(kid(c, "v"));
        let value: string;
        if (t === "s") value = shared[Number(v)] ?? "";
        else if (t === "inlineStr") value = textOf(kid(c, "is"));
        else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (t === "str" || t === "e") value = v;
        else if (v !== "" && dates.has(Number(c.attrs.s ?? -1)) && Number.isFinite(Number(v))) value = excelDate(Number(v));
        else value = v;
        cells[col] = value;
      }
      rows[r] = Array.from(cells, (x) => x ?? "");
    }
    const filled = Array.from(rows, (x) => x ?? []);
    // Every row as wide as the widest one, trailing empty rows dropped
    while (filled.length && filled[filled.length - 1].every((x) => !x)) filled.pop();
    const width = filled.reduce((w, r) => Math.max(w, r.length), 0);
    sheets.push({ name: s.attrs.name ?? `Sheet${sheets.length + 1}`, rows: filled.map((r) => [...r, ...Array(width - r.length).fill("")]), truncated });
  }
  return { sheets };
}

function isInPhonetic(si: XNode, t: XNode): boolean {
  return kids(si, "rPh").some((ph) => findAll(ph, "t").includes(t));
}

// ---------- PowerPoint ----------

export interface SlideRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Points. */
  size?: number;
  color?: string;
}
export interface SlideParagraph {
  runs: SlideRun[];
  level: number;
  bullet: boolean;
  align?: "left" | "center" | "right";
}
/** Positions are fractions of the slide (0–1). */
export interface SlideBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type SlideShape =
  | { kind: "text"; box: SlideBox; paragraphs: SlideParagraph[]; title: boolean; fill?: string; anchor?: "top" | "middle" | "bottom" }
  | { kind: "image"; box: SlideBox; part: string }
  | { kind: "table"; box: SlideBox; rows: string[][] }
  | { kind: "rect"; box: SlideBox; fill: string };

export interface SlideModel {
  shapes: SlideShape[];
  background?: string;
  notes?: string;
}
export interface PptxModel {
  /** Points. */
  width: number;
  height: number;
  slides: SlideModel[];
}

const EMU_PER_PT = 12700;

interface Xfrm {
  x: number;
  y: number;
  w: number;
  h: number;
}

function xfrmOf(spPr: XNode | undefined): Xfrm | undefined {
  const xfrm = kid(spPr, "xfrm");
  const off = kid(xfrm, "off");
  const ext = kid(xfrm, "ext");
  if (!off || !ext) return undefined;
  return { x: Number(off.attrs.x) || 0, y: Number(off.attrs.y) || 0, w: Number(ext.attrs.cx) || 0, h: Number(ext.attrs.cy) || 0 };
}

function srgb(n: XNode | undefined): string | undefined {
  const fill = kid(n, "solidFill");
  const c = kid(fill, "srgbClr")?.attrs.val;
  return c && /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : undefined;
}

/** A placeholder's key: its type (body when not given) and its index. */
function phOf(sp: XNode): { type: string; idx?: string } | undefined {
  const nv = kids(sp).find((c) => c.name.startsWith("nv"));
  const ph = find(kid(nv, "nvPr"), "ph");
  return ph ? { type: ph.attrs.type ?? "body", idx: ph.attrs.idx } : undefined;
}

/** Positions of a layout's (or master's) placeholders, so a slide's placeholder without one gets its own. */
function placeholderBoxes(part: XNode | undefined): { byIdx: Record<string, Xfrm>; byType: Record<string, Xfrm> } {
  const byIdx: Record<string, Xfrm> = {};
  const byType: Record<string, Xfrm> = {};
  for (const sp of findAll(part, "sp")) {
    const ph = phOf(sp);
    const x = xfrmOf(kid(sp, "spPr"));
    if (!ph || !x) continue;
    if (ph.idx !== undefined) byIdx[ph.idx] = x;
    byType[ph.type] ??= x;
  }
  return { byIdx, byType };
}

const TITLE_TYPES = new Set(["title", "ctrTitle"]);

export function parsePptx(files: OfficeFiles): PptxModel {
  const presPath = "ppt/presentation.xml";
  const pres = xmlPart(files, presPath);
  if (!pres) throw new Error("不是有效的 PowerPoint 文件（缺少 ppt/presentation.xml）");
  const sz = find(pres, "sldSz");
  const cx = Number(sz?.attrs.cx) || 12192000;
  const cy = Number(sz?.attrs.cy) || 6858000;
  const rels = relsOf(files, presPath);
  let slidePaths = kids(find(pres, "sldIdLst"), "sldId")
    .map((s) => (s.attrs.id ? rels[s.attrs.id] : undefined))
    .filter((r): r is NonNullable<typeof r> => !!r && !r.external)
    .map((r) => r.target);
  if (!slidePaths.length) {
    // A template (potx) may list none: take the slides in the package, in number order
    slidePaths = Object.keys(files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => Number(/\d+/.exec(a.slice(11))?.[0]) - Number(/\d+/.exec(b.slice(11))?.[0]));
  }

  const slides = slidePaths.map((path) => parseSlide(files, path, cx, cy));
  return { width: cx / EMU_PER_PT, height: cy / EMU_PER_PT, slides };
}

function parseSlide(files: OfficeFiles, path: string, cx: number, cy: number): SlideModel {
  const slide = xmlPart(files, path);
  const rels = relsOf(files, path);
  const layoutRel = Object.values(rels).find((r) => r.type === "slideLayout");
  const layout = layoutRel ? xmlPart(files, layoutRel.target) : undefined;
  const masterRel = layoutRel ? Object.values(relsOf(files, layoutRel.target)).find((r) => r.type === "slideMaster") : undefined;
  const master = masterRel ? xmlPart(files, masterRel.target) : undefined;
  const fromLayout = placeholderBoxes(layout);
  const fromMaster = placeholderBoxes(master);

  const boxFor = (sp: XNode, own: Xfrm | undefined): Xfrm | undefined => {
    if (own) return own;
    const ph = phOf(sp);
    if (!ph) return undefined;
    const type = ph.type === "ctrTitle" ? "title" : ph.type === "subTitle" ? "body" : ph.type;
    return (
      (ph.idx !== undefined ? fromLayout.byIdx[ph.idx] : undefined) ??
      fromLayout.byType[ph.type] ??
      fromLayout.byType[type] ??
      fromMaster.byType[ph.type] ??
      fromMaster.byType[type]
    );
  };
  const frac = (x: Xfrm): SlideBox => ({ x: x.x / cx, y: x.y / cy, w: x.w / cx, h: x.h / cy });

  const shapes: SlideShape[] = [];
  // A group places its children in its own coordinates: map them back onto the slide
  type Map = (x: Xfrm) => Xfrm;
  const walk = (tree: XNode | undefined, map: Map) => {
    for (const el of kids(tree)) {
      if (el.name === "sp") {
        const own = xfrmOf(kid(el, "spPr"));
        const box = boxFor(el, own);
        const body = kid(el, "txBody");
        const ph0 = phOf(el);
        // A body placeholder's paragraphs are bulleted unless they say not (the master's body style)
        const bulleted = !!ph0 && (ph0.type === "body" || ph0.type === "obj") && ph0.idx !== undefined;
        const paragraphs = body ? slideParagraphs(body, bulleted) : [];
        const fill = srgb(kid(el, "spPr"));
        if (!box) continue;
        const ph = phOf(el);
        if (paragraphs.some((p) => p.runs.some((r) => r.text.trim()))) {
          const anchor = kid(body, "bodyPr")?.attrs.anchor;
          shapes.push({
            kind: "text",
            box: frac(map(box)),
            paragraphs,
            title: !!ph && TITLE_TYPES.has(ph.type),
            fill,
            anchor: anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : ph && TITLE_TYPES.has(ph.type) ? "middle" : "top",
          });
        } else if (fill) shapes.push({ kind: "rect", box: frac(map(box)), fill });
      } else if (el.name === "pic") {
        const box = xfrmOf(kid(el, "spPr"));
        const id = find(kid(el, "blipFill"), "blip")?.attrs.embed;
        const rel = id ? rels[id] : undefined;
        if (box && rel && !rel.external) shapes.push({ kind: "image", box: frac(map(box)), part: rel.target });
      } else if (el.name === "graphicFrame") {
        const tbl = find(el, "tbl");
        const x = kid(el, "xfrm");
        const off = kid(x, "off");
        const ext = kid(x, "ext");
        if (tbl && off && ext) {
          const box = { x: Number(off.attrs.x) || 0, y: Number(off.attrs.y) || 0, w: Number(ext.attrs.cx) || 0, h: Number(ext.attrs.cy) || 0 };
          const rows = kids(tbl, "tr").map((tr) => kids(tr, "tc").map((tc) => findAll(tc, "p").map((p) => findAll(p, "t").map(textOf).join("")).join("\n")));
          shapes.push({ kind: "table", box: frac(map(box)), rows });
        }
      } else if (el.name === "grpSp") {
        const gx = kid(kid(el, "grpSpPr"), "xfrm");
        const off = kid(gx, "off");
        const ext = kid(gx, "ext");
        const chOff = kid(gx, "chOff");
        const chExt = kid(gx, "chExt");
        let inner: Map = map;
        if (off && ext && chOff && chExt) {
          const sx = (Number(ext.attrs.cx) || 1) / (Number(chExt.attrs.cx) || 1);
          const sy = (Number(ext.attrs.cy) || 1) / (Number(chExt.attrs.cy) || 1);
          const ox = Number(off.attrs.x) || 0;
          const oy = Number(off.attrs.y) || 0;
          const cox = Number(chOff.attrs.x) || 0;
          const coy = Number(chOff.attrs.y) || 0;
          inner = (b) => map({ x: ox + (b.x - cox) * sx, y: oy + (b.y - coy) * sy, w: b.w * sx, h: b.h * sy });
        }
        walk(el, inner);
      } else if (el.name === "AlternateContent") {
        walk(kid(el, "Fallback") ?? kid(el, "Choice"), map);
      }
    }
  };
  walk(find(slide, "spTree"), (x) => x);

  const bg = find(slide, "bg");
  const background = srgb(kid(bg, "bgPr"));

  const notesRel = Object.values(rels).find((r) => r.type === "notesSlide");
  let notes: string | undefined;
  if (notesRel) {
    const ns = xmlPart(files, notesRel.target);
    const bodies = findAll(ns, "sp").filter((sp) => phOf(sp)?.type === "body");
    notes = bodies
      .map((sp) => findAll(sp, "p").map((p) => findAll(p, "t").map(textOf).join("")).join("\n"))
      .join("\n")
      .trim() || undefined;
  }
  return { shapes, background, notes };
}

function slideParagraphs(body: XNode, bulleted = false): SlideParagraph[] {
  return kids(body, "p").map((p) => {
    const pPr = kid(p, "pPr");
    const algn = pPr?.attrs.algn;
    const runs: SlideRun[] = [];
    for (const c of kids(p)) {
      if (c.name === "r" || c.name === "fld") {
        const rPr = kid(c, "rPr");
        const sz = rPr?.attrs.sz ? Number(rPr.attrs.sz) / 100 : undefined;
        runs.push({
          text: textOf(kid(c, "t")),
          bold: rPr?.attrs.b === "1" || undefined,
          italic: rPr?.attrs.i === "1" || undefined,
          underline: (rPr?.attrs.u && rPr.attrs.u !== "none") || undefined,
          size: sz,
          color: srgb(rPr),
        });
      } else if (c.name === "br") runs.push({ text: "\n" });
    }
    return {
      runs,
      level: Number(pPr?.attrs.lvl ?? 0),
      bullet: !!kid(pPr, "buChar") || !!kid(pPr, "buAutoNum") || (bulleted && !kid(pPr, "buNone") && runs.some((r) => r.text.trim() !== "")),
      align: algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "l" ? "left" : undefined,
    };
  });
}

// ---------- which ----------

export type OfficeKind = "docx" | "pptx" | "xlsx";

/** The formats read here; the older binary ones (doc, ppt, xls, key …) aren't. */
export function officeKind(ext: string): OfficeKind | null {
  const e = ext.toLowerCase();
  if (e === "docx" || e === "docm" || e === "dotx") return "docx";
  if (e === "pptx" || e === "pptm" || e === "potx" || e === "ppsx") return "pptx";
  if (e === "xlsx" || e === "xlsm" || e === "xltx") return "xlsx";
  return null;
}
