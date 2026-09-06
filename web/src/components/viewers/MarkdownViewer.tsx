"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.min.css";

interface MarkdownViewerProps {
  content: string;
  className?: string;
}

export default function MarkdownViewer({ content, className = "" }: MarkdownViewerProps) {
  return (
    <div className={`prose prose-sm max-w-none break-words overflow-wrap-anywhere ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          table: ({ node, children, ...props }: any) => (
            <div className="my-3.5 w-full overflow-x-auto rounded-xl border border-[var(--aurora-border-strong)] bg-[var(--aurora-surface-solid)]/70 shadow-xs">
              <table className="w-full min-w-full border-collapse text-left text-sm" {...props}>
                {children}
              </table>
            </div>
          ),
          thead: ({ node, children, ...props }: any) => (
            <thead className="border-b border-[var(--aurora-border-strong)] bg-[var(--aurora-chip)] text-[var(--aurora-fg1)] font-semibold" {...props}>
              {children}
            </thead>
          ),
          tbody: ({ node, children, ...props }: any) => (
            <tbody className="divide-y divide-[var(--aurora-border)] text-[var(--aurora-fg2)]" {...props}>
              {children}
            </tbody>
          ),
          tr: ({ node, children, ...props }: any) => (
            <tr className="transition-colors hover:bg-[var(--aurora-chip)]/40" {...props}>
              {children}
            </tr>
          ),
          th: ({ node, children, style, ...props }: any) => (
            <th
              className="px-4 py-2.5 font-semibold text-xs text-[var(--aurora-fg1)] tracking-wide border-r border-[var(--aurora-border)] last:border-r-0 whitespace-nowrap"
              style={style}
              {...props}
            >
              {children}
            </th>
          ),
          td: ({ node, children, style, ...props }: any) => (
            <td
              className="px-4 py-2.5 text-sm text-[var(--aurora-fg2)] border-r border-[var(--aurora-border)] last:border-r-0 align-top"
              style={style}
              {...props}
            >
              {children}
            </td>
          ),
          a: ({ node, children, href, ...props }: any) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--aurora-accent)] hover:underline underline-offset-2 break-all font-medium transition-colors"
              {...props}
            >
              {children}
            </a>
          ),
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
                className="px-1.5 py-0.5 rounded text-[0.85em] font-mono bg-[var(--aurora-chip)] text-[var(--aurora-fg1)] border border-[var(--aurora-border)]"
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
