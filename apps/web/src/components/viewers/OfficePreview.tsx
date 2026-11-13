"use client";

import React, { useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/api-client";
import { directFetch, viaRelay } from "@/lib/p2p";
import {
  colName,
  imageMime,
  officeKind,
  parseDocx,
  parsePptx,
  parseXlsx,
  unzipOffice,
  type DocBlock,
  type DocxModel,
  type OfficeFiles,
  type PptxModel,
  type SlideShape,
  type XlsxModel,
} from "@/lib/office-preview";
import { resolveMediaUrl } from "./MediaPreview";

/**
 * A Word / PowerPoint / Excel file shown in the workbench, read in the page (see lib/office-preview):
 * no iframe on the file (that downloads it, and the desktop app popped a save dialog), no online
 * viewer (it can't reach the user's devices). The file comes the way other workbench files do: this
 * computer's disk in the desktop app, else its device through the server relay.
 */

type Model = { kind: "docx"; doc: DocxModel } | { kind: "pptx"; deck: PptxModel } | { kind: "xlsx"; book: XlsxModel };

async function fetchBytes(url: string): Promise<Uint8Array> {
  const resolved = resolveMediaUrl(url);
  // Straight from its device over WebRTC when a direct path exists (the server's relay is slow)
  if (viaRelay(resolved)) {
    const direct = await directFetch(resolved.relayUrl);
    if (direct) return direct;
  }
  const tries = [resolved.playUrl, resolved.relayUrl].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
  let last = "";
  for (const u of tries) {
    try {
      const external = /^https?:\/\//.test(u) && !resolved.isLocal;
      const res = external ? await fetch(u, { credentials: "omit" }) : await authFetch(u);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(last || "读取文件失败");
}

export function canPreviewOffice(ext: string): boolean {
  return officeKind(ext) !== null;
}

export function OfficePreview({ url, ext, fullscreen = false }: { url: string; ext: string; fullscreen?: boolean }) {
  const kind = officeKind(ext);
  const [files, setFiles] = useState<OfficeFiles | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setFiles(null);
    setModel(null);
    setError(null);
    (async () => {
      try {
        const bytes = await fetchBytes(url);
        const f = unzipOffice(bytes);
        const m: Model =
          kind === "docx" ? { kind, doc: parseDocx(f) } : kind === "pptx" ? { kind, deck: parsePptx(f) } : { kind: "xlsx", book: parseXlsx(f) };
        if (active) {
          setFiles(f);
          setModel(m);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [url, kind]);

  // Pictures in the package as object URLs, made once per file
  const images = useMemo(() => {
    const out: Record<string, string> = {};
    if (!files) return out;
    for (const [path, data] of Object.entries(files)) {
      const mime = imageMime(path);
      if (mime && /\/media\//.test(path)) out[path] = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
    }
    return out;
  }, [files]);
  useEffect(() => () => Object.values(images).forEach((u) => URL.revokeObjectURL(u)), [images]);

  if (error) {
    return (
      <div className="p-6 text-center text-xs text-red-400 bg-red-500/10 rounded-xl border border-red-500/20">
        <p className="font-semibold mb-1">文档读取失败</p>
        <p className="opacity-80 font-mono text-[11px]">{error}</p>
      </div>
    );
  }
  if (!model) {
    return (
      <div className="p-8 text-center text-xs text-[var(--aurora-fg3)] flex flex-col items-center justify-center gap-2 min-h-[220px]">
        <div className="w-5 h-5 border-2 border-[var(--aurora-accent)] border-t-transparent rounded-full animate-spin" />
        <span>正在读取文档…</span>
      </div>
    );
  }
  const height = fullscreen ? "h-full" : "max-h-[640px]";
  if (model.kind === "docx") return <DocxView doc={model.doc} images={images} className={height} />;
  if (model.kind === "pptx") return <PptxView deck={model.deck} images={images} className={height} />;
  return <XlsxView book={model.book} className={height} />;
}

// ---------- Word ----------

function DocxView({ doc, images, className }: { doc: DocxModel; images: Record<string, string>; className: string }) {
  return (
    <div className={`w-full overflow-auto rounded-xl border border-[var(--aurora-border)] bg-neutral-100 ${className}`}>
      <article className="mx-auto my-4 max-w-[760px] bg-white text-neutral-900 shadow-md px-6 sm:px-12 py-10 text-[14px] leading-[1.75] select-text">
        {doc.blocks.length ? doc.blocks.map((b, i) => <DocBlockView key={i} block={b} images={images} />) : <p className="text-neutral-400">（空文档）</p>}
      </article>
    </div>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-[24px] font-bold mt-6 mb-3",
  2: "text-[20px] font-bold mt-5 mb-2.5",
  3: "text-[17px] font-semibold mt-4 mb-2",
  4: "text-[15px] font-semibold mt-3 mb-1.5",
};

function DocBlockView({ block, images }: { block: DocBlock; images: Record<string, string> }) {
  if (block.kind === "image") {
    const src = images[block.part];
    if (!src) return null;
    return (
      <p className="my-3 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" style={{ width: block.width ? `${block.width}px` : undefined, maxWidth: "100%", height: "auto" }} className="inline-block" />
      </p>
    );
  }
  if (block.kind === "table") {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="border-collapse w-full text-[13px]">
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className="border border-neutral-300 px-2 py-1 align-top">
                    {cell.map((b, k) => (
                      <DocBlockView key={k} block={b} images={images} />
                    ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const runs = block.runs.map((r, i) => {
    const style: React.CSSProperties = {
      fontWeight: r.bold ? 700 : undefined,
      fontStyle: r.italic ? "italic" : undefined,
      textDecoration: [r.underline && "underline", r.strike && "line-through"].filter(Boolean).join(" ") || undefined,
      color: r.color,
      whiteSpace: "pre-wrap",
    };
    return r.href ? (
      <a key={i} href={r.href} target="_blank" rel="noopener noreferrer" style={style} className="text-blue-600 underline">
        {r.text}
      </a>
    ) : (
      <span key={i} style={style}>
        {r.text}
      </span>
    );
  });
  const align = block.align ? { textAlign: block.align as React.CSSProperties["textAlign"] } : undefined;
  if (block.heading) {
    const Tag = `h${Math.min(block.heading, 6)}` as "h1";
    return (
      <Tag className={HEADING_CLASS[block.heading] ?? "font-semibold mt-3 mb-1"} style={align}>
        {runs}
      </Tag>
    );
  }
  if (block.list) {
    return (
      <p className="my-1 flex gap-2" style={{ paddingLeft: `${block.list.level * 1.5 + 0.5}em`, ...align }}>
        <span className="shrink-0 text-neutral-500">{block.list.ordered ? `${block.list.number ?? 1}.` : ["•", "◦", "▪"][block.list.level % 3]}</span>
        <span>{runs}</span>
      </p>
    );
  }
  return (
    <p className="my-1.5 min-h-[1em]" style={align}>
      {runs}
    </p>
  );
}

// ---------- PowerPoint ----------

function PptxView({ deck, images, className }: { deck: PptxModel; images: Record<string, string>; className: string }) {
  return (
    <div className={`w-full overflow-auto rounded-xl border border-[var(--aurora-border)] bg-neutral-800/60 p-3 flex flex-col gap-4 ${className}`}>
      {deck.slides.length === 0 && <p className="text-center text-xs text-[var(--aurora-fg3)] py-8">（没有幻灯片）</p>}
      {deck.slides.map((s, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div
            className="relative w-full overflow-hidden rounded-md shadow-lg select-text"
            style={{ aspectRatio: `${deck.width} / ${deck.height}`, background: s.background ?? "#fff", containerType: "inline-size" }}
          >
            {s.shapes.map((sh, k) => (
              <SlideShapeView key={k} shape={sh} images={images} slideWidth={deck.width} />
            ))}
          </div>
          <div className="flex items-start justify-between gap-3 text-[11px] text-[var(--aurora-fg3)] px-0.5">
            <span className="shrink-0 font-mono">
              {i + 1} / {deck.slides.length}
            </span>
            {s.notes && <span className="text-right whitespace-pre-wrap line-clamp-3" title={s.notes}>备注：{s.notes}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SlideShapeView({ shape, images, slideWidth }: { shape: SlideShape; images: Record<string, string>; slideWidth: number }) {
  const pos: React.CSSProperties = {
    position: "absolute",
    left: `${shape.box.x * 100}%`,
    top: `${shape.box.y * 100}%`,
    width: `${shape.box.w * 100}%`,
    height: `${shape.box.h * 100}%`,
  };
  // Points on the slide → a share of its width, so text scales with the preview
  const pt = (size: number) => `${(size / slideWidth) * 100}cqw`;
  if (shape.kind === "rect") return <div style={{ ...pos, background: shape.fill }} />;
  if (shape.kind === "image") {
    const src = images[shape.part];
    if (!src) return null;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" style={{ ...pos, objectFit: "contain" }} />;
  }
  if (shape.kind === "table") {
    return (
      <div style={{ ...pos, fontSize: pt(12), overflow: "hidden" }}>
        <table className="w-full h-full border-collapse text-neutral-900">
          <tbody>
            {shape.rows.map((row, r) => (
              <tr key={r}>
                {row.map((c, k) => (
                  <td key={k} className={`border border-neutral-400 px-[0.4em] py-[0.2em] whitespace-pre-wrap ${r === 0 ? "font-semibold bg-neutral-100" : ""}`}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const base = shape.title ? 32 : 18;
  return (
    <div
      style={{
        ...pos,
        background: shape.fill,
        display: "flex",
        flexDirection: "column",
        justifyContent: shape.anchor === "middle" ? "center" : shape.anchor === "bottom" ? "flex-end" : "flex-start",
        padding: `${pt(4)} ${pt(7)}`,
        overflow: "hidden",
        color: "#1f2937",
        lineHeight: 1.2,
      }}
    >
      {shape.paragraphs.map((p, i) => (
        <div
          key={i}
          style={{
            textAlign: p.align,
            paddingLeft: pt(p.level * 18 + (p.bullet ? 14 : 0)),
            textIndent: p.bullet ? pt(-14) : undefined,
            fontWeight: shape.title ? 700 : undefined,
            minHeight: "0.6em",
            marginBottom: pt(3),
            whiteSpace: "pre-wrap",
          }}
        >
          {p.bullet && <span style={{ display: "inline-block", width: pt(14), textIndent: 0 }}>•</span>}
          {p.runs.map((r, k) => (
            <span
              key={k}
              style={{
                fontSize: pt(r.size ?? base),
                fontWeight: r.bold ? 700 : undefined,
                fontStyle: r.italic ? "italic" : undefined,
                textDecoration: r.underline ? "underline" : undefined,
                color: r.color,
              }}
            >
              {r.text}
            </span>
          ))}
          {p.runs.length === 0 && <span style={{ fontSize: pt(base) }}>{" "}</span>}
        </div>
      ))}
    </div>
  );
}

// ---------- Excel ----------

const PAGE = 300;

function XlsxView({ book, className }: { book: XlsxModel; className: string }) {
  const [sheet, setSheet] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const [query, setQuery] = useState("");
  useEffect(() => setShown(PAGE), [sheet, query]);
  const s = book.sheets[sheet];
  const rows = useMemo(() => {
    if (!s) return [] as Array<{ n: number; cells: string[] }>;
    const all = s.rows.map((cells, i) => ({ n: i + 1, cells }));
    const q = query.trim().toLowerCase();
    return q ? all.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q))) : all;
  }, [s, query]);
  if (!s) return <p className="text-center text-xs text-[var(--aurora-fg3)] py-8">（没有工作表）</p>;
  const width = s.rows.reduce((w, r) => Math.max(w, r.length), 0);
  return (
    <div className={`w-full flex flex-col rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] overflow-hidden text-xs ${className}`}>
      <div className="flex items-center gap-2 p-2 border-b border-[var(--aurora-border)] shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索表格内容…"
          className="flex-1 min-w-0 px-2.5 py-1 bg-[var(--aurora-chip)]/40 border border-[var(--aurora-border)] rounded-lg text-xs text-[var(--aurora-fg1)] placeholder-[var(--aurora-fg4)] focus:outline-none focus:border-[var(--aurora-accent)]"
        />
        <span className="text-[11px] text-[var(--aurora-fg3)] shrink-0">
          {rows.length} 行{s.truncated ? "（只读了前面的行）" : ""}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-[var(--aurora-chip)]">
            <tr>
              <th className="px-2 py-1 border-r border-b border-[var(--aurora-border)] text-[10px] text-[var(--aurora-fg4)] w-10" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} className="px-2 py-1 border-r border-b border-[var(--aurora-border)] text-[10px] font-mono text-[var(--aurora-fg3)] text-center min-w-[64px]">
                  {colName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r) => (
              <tr key={r.n} className="hover:bg-[var(--aurora-chip)]/30">
                <td className="px-2 py-1 border-r border-b border-[var(--aurora-border)]/60 text-[10px] font-mono text-[var(--aurora-fg4)] text-center select-none">{r.n}</td>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c} className="px-2 py-1 border-r border-b border-[var(--aurora-border)]/60 text-[var(--aurora-fg2)] whitespace-pre-wrap max-w-[280px] break-words align-top">
                    {r.cells[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > shown && (
          <button type="button" onClick={() => setShown((n) => n + PAGE)} className="w-full py-2 text-[11px] text-[var(--aurora-accent)] hover:bg-[var(--aurora-chip)]/40 cursor-pointer">
            再显示 {Math.min(PAGE, rows.length - shown)} 行（还有 {rows.length - shown} 行）
          </button>
        )}
      </div>
      {book.sheets.length > 1 && (
        <div className="flex items-center gap-1 p-1.5 border-t border-[var(--aurora-border)] overflow-x-auto shrink-0">
          {book.sheets.map((sh, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSheet(i)}
              className={`px-2.5 py-1 rounded-md text-[11px] whitespace-nowrap cursor-pointer ${
                i === sheet ? "bg-[var(--aurora-accent)] text-white font-semibold" : "text-[var(--aurora-fg2)] hover:bg-[var(--aurora-chip)]"
              }`}
            >
              {sh.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
