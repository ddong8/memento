"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.min.css";
import { useEffect, useRef } from "react";
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
}

export default function MarkdownViewer({
  content,
  className = "",
  compactMedia = false,
  compactText = false,
}: MarkdownViewerProps) {
  const inspector = useMediaInspector();
  const renderedVideos = useRef<Set<string>>(new Set<string>());
  // Clear rendered video tracker for this render pass
  renderedVideos.current.clear();

  const baseProse = compactText ? "prose-compact" : "prose";

  return (
    <div className={`${baseProse} max-w-full min-w-0 break-words overflow-wrap-anywhere overflow-hidden ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
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
        {content}
      </ReactMarkdown>
    </div>
  );
}
