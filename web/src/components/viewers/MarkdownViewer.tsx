"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.min.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  detectMediaType,
  VideoPlayer,
  AudioPlayer,
  ImagePreview,
  MediaAttachmentCard,
  getFilenameFromUrl,
  isLocalFilePath,
  resolveMediaUrl,
  safeDecodePath,
} from "./MediaPreview";
import { useMediaInspector, extractMediaFromMarkdown } from "./MediaInspectorContext";

interface MarkdownViewerProps {
  content: string;
  className?: string;
  compactMedia?: boolean;
  compactText?: boolean;
  isStreaming?: boolean;
}

function PreBlock({ children, ...props }: any) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const codeElement = Array.isArray(children) ? children[0] : children;
  const langMatch = codeElement?.props?.className?.match(/language-([a-zA-Z0-9_-]+)/);
  const lang = langMatch ? langMatch[1] : "";

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (preRef.current) {
      const text = preRef.current.innerText || "";
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch(() => {});
    }
  };

  return (
    <div className="not-prose relative group/code my-3 rounded-xl overflow-hidden border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/90 shadow-md">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-white/5 border-b border-white/5 text-[11px] text-[var(--aurora-fg3)] font-mono select-none">
        <span>{lang ? lang.toUpperCase() : "CODE"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/10 transition-colors cursor-pointer"
          title="复制代码"
        >
          {copied ? "✓ 已复制" : "复制代码"}
        </button>
      </div>
      <pre ref={preRef} className="p-3.5 overflow-x-auto text-[13px] font-mono leading-relaxed select-text" {...props}>
        {children}
      </pre>
    </div>
  );
}

export function normalizeMarkdownContent(content: string): string {
  if (!content) return "";

  // 分离代码块与普通文本，避免误伤代码块内部的格式
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts
    .map((part, i) => {
      // 奇数项为代码块，保持原样
      if (i % 2 === 1) return part;

      let text = part;

      // 1. 规范化 Unicode 圆点列表符 (• 或 · 或 ⁃ 或 ‣) 为标准 Markdown 列表符 (- )
      text = text.replace(/(^|\n)[ \t]*[•·⁃‣][ \t]+/g, "$1- ");

      // 2. 规范化以 1) 2) 3) 等编号开头的独立单行标题为 ### 标题
      // 匹配以数字加括号开头，长度在 2~40 字之间，且不以标点结尾的独立单行
      text = text.replace(
        /(^|\n\n|\n)([0-9]+[）\)])\s*([^\n:：。！？\r]{2,40})(?=\n|$)/g,
        (match, prefix, num, title) => {
          if (title.trim().startsWith("#")) return match;
          return `${prefix}\n### ${num} ${title.trim()}\n`;
        }
      );

      // 3. 规范化执行步骤指示行 (⚡ [xxx] 或 [Checking/Verifying/Deploying xxx]) 为高亮引用块
      text = text.replace(
        /(^|\n)(⚡\s*\[[^\]]+\][^\n]*|\[(?:Checking|Verifying|Deploying|Building|Starting|Testing)[^\]]*\][^\n]*)/gi,
        "$1> $2"
      );

      return text;
    })
    .join("");
}

export default function MarkdownViewer({
  content,
  className = "",
  compactMedia = false,
  compactText = false,
  isStreaming = false,
}: MarkdownViewerProps) {
  const inspector = useMediaInspector();
  const renderedVideos = useRef<Set<string>>(new Set<string>());
  // Clear rendered video tracker for this render pass
  renderedVideos.current.clear();

  const formattedContent = useMemo(() => normalizeMarkdownContent(content), [content]);

  const baseProse = compactText ? "prose-compact" : "prose";
  const remarkPlugins = useMemo(() => [remarkGfm], []);
  const rehypePlugins = useMemo(() => (isStreaming ? [] : [rehypeHighlight]), [isStreaming]);

  return (
    <div className={`${baseProse} max-w-full min-w-0 break-words overflow-wrap-anywhere overflow-hidden ${className}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          pre: PreBlock,
          img: ({ node, src, alt, ...props }: any) => {
            if (!src) return null;
            const type = detectMediaType(src);
            if (type === "video") {
              const cleanHref = safeDecodePath(src);
              const isDuplicate = renderedVideos.current.has(cleanHref);
              renderedVideos.current.add(cleanHref);
              const isCurrentlyInspected = Boolean(
                inspector?.isOpen &&
                inspector?.activeMedia &&
                (safeDecodePath(inspector.activeMedia.url) === cleanHref ||
                 getFilenameFromUrl(inspector.activeMedia.url) === getFilenameFromUrl(cleanHref))
              );
              if (inspector || compactMedia || isDuplicate || isCurrentlyInspected) {
                const label = alt || getFilenameFromUrl(src);
                return (
                  <div className="not-prose my-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-chip)] text-xs text-[var(--aurora-fg1)] transition-colors hover:border-[var(--aurora-accent)]">
                    <span className="text-[var(--aurora-accent)] font-semibold">🎬</span>
                    <span className="font-medium truncate max-w-[240px]" title={label}>{label}</span>
                    {isCurrentlyInspected && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">
                        已在右侧视窗展示
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        inspector?.openMediaByUrl(src, label);
                      }}
                      className="ml-1 text-[var(--aurora-accent)] hover:underline font-semibold cursor-pointer whitespace-nowrap"
                    >
                      {isCurrentlyInspected ? "对焦视窗 ↗" : "在右侧独立视窗播放 ↗"}
                    </button>
                  </div>
                );
              }
              return <VideoPlayer src={src} title={alt} />;
            }
            if (type === "audio") {
              return <AudioPlayer src={src} title={alt} />;
            }
            return <ImagePreview src={src} alt={alt} />;
          },
          a: ({ node, children, href, ...props }: any) => {
            if (!href) return <span {...props}>{children}</span>;
            const type = detectMediaType(href);

            // If the link directly points to video/audio/pdf media, render an inline preview
            if (type === "video") {
              const label = typeof children === "string" ? children : getFilenameFromUrl(href);
              const cleanHref = safeDecodePath(href);
              const isDuplicate = renderedVideos.current.has(cleanHref);
              renderedVideos.current.add(cleanHref);
              const isCurrentlyInspected = Boolean(
                inspector?.isOpen &&
                inspector?.activeMedia &&
                (safeDecodePath(inspector.activeMedia.url) === cleanHref ||
                 getFilenameFromUrl(inspector.activeMedia.url) === getFilenameFromUrl(cleanHref))
              );

              // 当处于 AskPage 三栏视窗环境（inspector 存在）或设置了 compactMedia / 重复媒体时：
              // 统一渲染精致微章卡片，杜绝在对话气泡中内嵌重复大播放器，把播放完整交给右侧第3栏视窗
              if (inspector || compactMedia || isDuplicate || isCurrentlyInspected) {
                return (
                  <div className="not-prose my-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-chip)] text-xs text-[var(--aurora-fg1)] transition-colors hover:border-[var(--aurora-accent)]">
                    <span className="text-[var(--aurora-accent)] font-semibold">🎬</span>
                    <span className="font-medium truncate max-w-[240px]" title={label}>{label}</span>
                    {isCurrentlyInspected && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">
                        已在右侧视窗展示
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        inspector?.openMediaByUrl(href, label);
                      }}
                      className="ml-1 text-[var(--aurora-accent)] hover:underline font-semibold cursor-pointer whitespace-nowrap"
                    >
                      {isCurrentlyInspected ? "对焦视窗 ↗" : "在右侧独立视窗播放 ↗"}
                    </button>
                  </div>
                );
              }

              return (
                <div className="not-prose my-3">
                  <VideoPlayer src={href} title={label} />
                </div>
              );
            }
            if (type === "audio") {
              const label = typeof children === "string" ? children : getFilenameFromUrl(href);
              return (
                <div className="not-prose my-2">
                  <AudioPlayer src={href} title={label} />
                </div>
              );
            }
            if (type === "pdf") {
              const label = typeof children === "string" ? children : getFilenameFromUrl(href);
              return (
                <div className="not-prose my-2">
                  <MediaAttachmentCard url={href} title={label} />
                </div>
              );
            }

            const isLocal = isLocalFilePath(href);
            const resolvedHref = isLocal ? resolveMediaUrl(href).downloadUrl : href;

            return (
              <a
                href={resolvedHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--aurora-accent)] hover:underline underline-offset-2 break-all font-medium transition-colors"
                {...props}
              >
                {children}
              </a>
            );
          },
          blockquote: ({ node, children, ...props }: any) => (
            <blockquote
              className="my-3 border-l-4 border-[var(--aurora-accent)] bg-[var(--aurora-accent-soft)] px-4 py-2 rounded-r-lg text-[var(--aurora-fg2)]"
              {...props}
            >
              {children}
            </blockquote>
          ),
          code: ({ node, className, children, ...props }: any) => {
            const isCodeBlock = Boolean(className && (className.includes("hljs") || className.includes("language-")));
            if (isCodeBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="px-1.5 py-0.5 rounded text-[0.85em] font-mono bg-[var(--aurora-chip)] text-[var(--aurora-fg1)] border border-[var(--aurora-border)] break-all"
                {...props}
              >
                {children}
              </code>
            );
          },
          h1: ({ node, children, ...props }: any) => (
            <h1 className={compactText ? "text-[13.5px] font-semibold text-[var(--aurora-fg1)] mt-2 mb-1 first:mt-0 tracking-tight" : "text-[18px] font-semibold text-[var(--aurora-fg1)] mt-3.5 mb-1.5 first:mt-0 tracking-tight"} {...props}>
              {children}
            </h1>
          ),
          h2: ({ node, children, ...props }: any) => (
            <h2 className={compactText ? "text-[13px] font-semibold text-[var(--aurora-fg1)] mt-2 mb-1 first:mt-0 tracking-tight" : "text-[16px] font-semibold text-[var(--aurora-fg1)] mt-3 mb-1 first:mt-0 tracking-tight"} {...props}>
              {children}
            </h2>
          ),
          h3: ({ node, children, ...props }: any) => (
            <h3 className={compactText ? "text-[12.5px] font-semibold text-[var(--aurora-fg1)] mt-1.5 mb-0.5 first:mt-0" : "text-[14.5px] font-semibold text-[var(--aurora-fg1)] mt-2.5 mb-1 first:mt-0"} {...props}>
              {children}
            </h3>
          ),
          h4: ({ node, children, ...props }: any) => (
            <h4 className="text-[13px] font-semibold text-[var(--aurora-fg2)] mt-2 mb-0.5 first:mt-0" {...props}>
              {children}
            </h4>
          ),
          h5: ({ node, children, ...props }: any) => (
            <h5 className="text-[12px] font-semibold text-[var(--aurora-fg2)] mt-1.5 mb-0.5 first:mt-0" {...props}>
              {children}
            </h5>
          ),
          h6: ({ node, children, ...props }: any) => (
            <h6 className="text-[11.5px] font-semibold text-[var(--aurora-fg3)] mt-1.5 mb-0.5 first:mt-0 uppercase" {...props}>
              {children}
            </h6>
          ),
          p: ({ node, children, ...props }: any) => (
            <p className={compactText ? "text-[12px] leading-relaxed my-1 first:mt-0 last:mb-0 text-[var(--aurora-fg1)]" : "text-[13.5px] leading-relaxed my-1.5 first:mt-0 last:mb-0 text-[var(--aurora-fg1)]"} {...props}>
              {children}
            </p>
          ),
          ul: ({ node, children, ...props }: any) => (
            <ul className={compactText ? "list-disc pl-4 my-1 space-y-0.5 text-[12px]" : "list-disc pl-5 my-1.5 space-y-1 text-[13.5px]"} {...props}>
              {children}
            </ul>
          ),
          ol: ({ node, children, ...props }: any) => (
            <ol className={compactText ? "list-decimal pl-4 my-1 space-y-0.5 text-[12px]" : "list-decimal pl-5 my-1.5 space-y-1 text-[13.5px]"} {...props}>
              {children}
            </ol>
          ),
          li: ({ node, children, ...props }: any) => (
            <li className={compactText ? "text-[12px] leading-normal" : "text-[13.5px] leading-normal"} {...props}>
              {children}
            </li>
          ),
          hr: (props: any) => <hr className="my-2.5 border-[var(--aurora-border)]" {...props} />,
        }}
      >
        {formattedContent}
      </ReactMarkdown>
    </div>
  );
}
