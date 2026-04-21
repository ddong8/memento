"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.min.css";

export default function MarkdownViewer({ content }: { content: string }) {
  return (
    <div
      className={[
        "prose prose-sm max-w-none",
        // Headings
        "prose-headings:font-semibold prose-headings:text-gray-900",
        // Code blocks — dark background for all pre tags
        "prose-pre:bg-[#1e1e1e] prose-pre:text-gray-100 prose-pre:rounded-lg prose-pre:border-0",
        "prose-pre:text-sm prose-pre:leading-relaxed prose-pre:shadow-md",
        "[&_pre]:bg-[#1e1e1e] [&_pre]:text-gray-100 [&_pre]:rounded-lg [&_pre]:shadow-md [&_pre]:overflow-x-auto",
        "[&_pre_code]:bg-transparent [&_pre_code]:text-inherit [&_pre_code]:p-0",
        // Inline code — light background (keep readable in white bubbles)
        "prose-code:before:content-none prose-code:after:content-none",
        "prose-code:bg-gray-100 prose-code:text-pink-600",
        "prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded",
        "prose-code:text-[0.85em] prose-code:font-mono",
        // Tables
        "prose-table:border-collapse prose-th:bg-gray-50",
        "prose-td:border prose-td:border-gray-200 prose-td:px-3 prose-td:py-1.5",
        "prose-th:border prose-th:border-gray-200 prose-th:px-3 prose-th:py-1.5",
        // Word break for long URLs and paths
        "break-words overflow-wrap-anywhere",
        // Links
        "prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline prose-a:break-all",
        // Lists
        "prose-li:my-0.5",
        // Blockquote
        "prose-blockquote:border-l-blue-400 prose-blockquote:bg-blue-50 prose-blockquote:py-1 prose-blockquote:rounded-r",
        // Images
        "prose-img:rounded-lg prose-img:shadow-sm",
      ].join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
