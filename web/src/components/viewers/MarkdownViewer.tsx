"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.min.css";
import { useEffect } from "react";
import {
  detectMediaType,
  VideoPlayer,
  AudioPlayer,
  ImagePreview,
  MediaAttachmentCard,
  getFilenameFromUrl,
  isLocalFilePath,
  resolveMediaUrl,
} from "./MediaPreview";
import { useMediaInspector, extractMediaFromMarkdown } from "./MediaInspectorContext";

interface MarkdownViewerProps {
  content: string;
  className?: string;
}

export default function MarkdownViewer({ content, className = "" }: MarkdownViewerProps) {
  return (
    <div className={`prose prose-sm max-w-full min-w-0 break-words overflow-wrap-anywhere overflow-hidden ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          img: ({ node, src, alt, ...props }: any) => {
            if (!src) return null;
            const type = detectMediaType(src);
            if (type === "video") {
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
