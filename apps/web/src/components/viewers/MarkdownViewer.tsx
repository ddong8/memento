"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import "highlight.js/styles/github-dark.min.css";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import { triggerHapticFeedback } from "@/lib/native-notify";

interface MarkdownViewerProps {
  content: string;
  className?: string;
  compactMedia?: boolean;
  compactText?: boolean;
  isStreaming?: boolean;
}

function PreBlock({ children, ...props }: any) {
  const [copied, setCopied] = useState(false);
  const [copiedApply, setCopiedApply] = useState(false);
  const [isWrap, setIsWrap] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const codeElement = Array.isArray(children) ? children[0] : children;
  const langMatch = codeElement?.props?.className?.match(/language-([a-zA-Z0-9_-]+)/);
  const lang = (langMatch ? langMatch[1] : "").toLowerCase();

  const codeText = useMemo(() => {
    if (typeof codeElement?.props?.children === "string") {
      return codeElement.props.children;
    }
    return "";
  }, [codeElement]);

  const lineCount = useMemo(() => {
    if (!codeText) return 0;
    return codeText.trim().split("\n").length;
  }, [codeText]);

  const isDiff = useMemo(() => {
    return (
      lang === "diff" ||
      lang === "patch" ||
      codeText.startsWith("diff --git") ||
      (codeText.includes("--- ") && codeText.includes("+++ "))
    );
  }, [lang, codeText]);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const text = codeText || (preRef.current ? preRef.current.innerText || "" : "");
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        triggerHapticFeedback(12);
        setTimeout(() => setCopied(false), 2000);
      }).catch(() => {});
    }
  };

  const handleCopyApply = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const text = codeText || (preRef.current ? preRef.current.innerText || "" : "");
    if (!text) return;
    const cmd = `git apply << 'EOF'\n${text.trim()}\nEOF`;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopiedApply(true);
      triggerHapticFeedback(12);
      setTimeout(() => setCopiedApply(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="not-prose relative group/code my-3 rounded-xl overflow-hidden border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/90 shadow-md">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-white/5 border-b border-white/5 text-[11px] text-[var(--aurora-fg3)] font-mono select-none">
        <div className="flex items-center gap-2">
          {isDiff ? (
            <span className="font-semibold text-emerald-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              DIFF / PATCH
            </span>
          ) : (
            <span className="font-semibold">{lang ? lang.toUpperCase() : "CODE"}</span>
          )}
          {lineCount > 1 && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/5 text-[var(--aurora-fg4)]">
              {lineCount} lines
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isDiff && (
            <button
              type="button"
              onClick={handleCopyApply}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 border border-emerald-500/20 transition-colors cursor-pointer"
              title="复制 git apply 命令，可直接在终端粘贴执行应用改动"
            >
              {copiedApply ? "✓ 已复制命令" : "⚡ 复制 git apply"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsWrap((w) => !w)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg2)] hover:bg-white/5 transition-colors cursor-pointer"
            title={isWrap ? "切换为横向滚动" : "自动换行"}
          >
            {isWrap ? "↩ 换行" : "↔ 单行"}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/10 transition-colors cursor-pointer"
            title="复制代码"
          >
            {copied ? "✓ 已复制" : "复制"}
          </button>
        </div>
      </div>
      <pre
        ref={preRef}
        className={`p-3.5 text-[13px] font-mono leading-relaxed select-text ${
          isWrap ? "whitespace-pre-wrap break-all overflow-x-hidden" : "overflow-x-auto whitespace-pre"
        }`}
        {...props}
      >
        {children}
      </pre>
    </div>
  );
}

function StatusStepItem({ icon, text }: { icon: string; text: string }) {
  let badgeStyle = "border-[var(--aurora-border)] bg-[var(--aurora-chip)] text-[var(--aurora-fg2)]";
  let iconStyle = "text-[var(--aurora-fg3)]";

  if (icon === "⚡") {
    badgeStyle = "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300";
    iconStyle = "text-amber-500 dark:text-amber-400";
  } else if (icon === "⏳") {
    badgeStyle = "border-cyan-500/30 bg-cyan-500/10 text-cyan-900 dark:text-cyan-300";
    iconStyle = "text-cyan-500 dark:text-cyan-400 animate-pulse";
  } else if (icon === "✅") {
    badgeStyle = "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300";
    iconStyle = "text-emerald-500 dark:text-emerald-400";
  } else if (icon.startsWith("⏹") || icon === "🈳") {
    badgeStyle = "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
    iconStyle = "text-slate-400";
  } else if (icon === "❌") {
    badgeStyle = "border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-300";
    iconStyle = "text-rose-500 dark:text-rose-400";
  }

  return (
    <div className="not-prose my-1.5 flex items-center">
      <div
        className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-md border text-xs font-mono max-w-full ${badgeStyle} shadow-xs select-none`}
        title={text}
      >
        <span className={`shrink-0 text-[13px] ${iconStyle} leading-none`}>{icon}</span>
        <span className="truncate max-w-[620px] font-medium leading-relaxed">{text}</span>
      </div>
    </div>
  );
}

function extractPlainText(children: any): string {
  if (children == null) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractPlainText).join("");
  if (typeof children === "object" && children.props?.children) {
    return extractPlainText(children.props.children);
  }
  return "";
}

/**
 * 彻底过滤并剥离回复正文首尾夹带的瞬态执行进度与保活心跳提示（如后台任务启动/终止、模型思考用时等），
 * 当且仅当剥离后存在真正的回答正文时，予以干净纯化；若纯粹为等待中的单条心跳则予以保留。
 */
export function stripTransientStatusPrefix(text: string): string {
  if (!text) return "";
  let content = text;

  if (content.includes("<think>")) {
    content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
  }

  const leadingStatusRegex =
    /^(?:(?:⚡|⏳|✅|⏹\uFE0F?|❌|🈳)\s*\[(?:后台任务|模型思考|等待用户|工具|任务在后台)[^\]]*\]|\[(?:STATUS_STILL_RUNNING|Checking|Verifying|Deploying|Building|Starting|Testing)[^\]]*\])\s*/u;

  let cleaned = content.trim();
  while (true) {
    const m = cleaned.match(leadingStatusRegex);
    if (m) {
      cleaned = cleaned.slice(m[0].length).trimStart();
    } else {
      break;
    }
  }

  if (cleaned.length > 0) {
    // 同时也剥离尾部因保护中断可能追加的纯心跳/STATUS_STILL_RUNNING
    cleaned = cleaned.replace(
      /\s*(?:\[STATUS_STILL_RUNNING:[^\]]*\]|(?:⚡|⏳|✅|⏹\uFE0F?|❌|🈳)\s*\[(?:后台任务|模型思考|等待用户|任务在后台)[^\]]*\])\s*$/u,
      ""
    );
    return cleaned.trim();
  }
  return content.trim();
}

function normalizeMarkdownContent(content: string): string {
  if (!content) return "";
  // 保护主线程：若单篇文本超过 80,000 字符（~2000行），跳过昂贵的多次正则全量扫描，防止正则回溯锁死 JS 主线程
  if (content.length > 80_000) {
    return content;
  }

  // 先过滤首部堆积的瞬态心跳或执行日志
  const sanitized = stripTransientStatusPrefix(content);

  // 分离代码块与普通文本，避免误伤代码块内部的格式
  const parts = sanitized.split(/(```[\s\S]*?```)/g);

  return parts
    .map((part, i) => {
      // 奇数项为代码块，保持原样
      if (i % 2 === 1) return part;

      let text = part;

      // 0. 去除代码块外的 Markdown 加粗符号 **（保留代码块内部语法与标点）
      text = text.replace(/\*\*([^\n*]+?)\*\*/g, "$1");

      // 1. 规范化 Unicode 圆点列表符 (• 或 · 或 ⁃ 或 ‣) 为标准 Markdown 列表符 (- )，保留已有行首缩进深度
      text = text.replace(/(^|\n)([ \t]*)[•·⁃‣][ \t]+/g, "$1$2- ");

      // 2. 保持 1) 2) 3) 序号为标准统一列表项，严禁随意将序号转为 ### 标题导致字号忽大忽小
      // （移除历史遗留的将 2~40 字编号行强转为 ### 标题的错误逻辑）

      // 3. 剥离执行步骤行前误加的 blockquote 引用符 "> "，保留已有缩进
      text = text.replace(/(^|\n)([ \t]*)>[ \t]*(?=(?:⚡|⏳|✅|⏹\uFE0F?|❌|🈳)\s*\[)/gu, "$1$2");

      // 4. 将被连在同一行或紧邻的执行步骤/思考进度标记切分为独立段落（强制独立换行）
      // 例如 "⚡ [Action] ⏳ [Thinking...]" -> 强制拆成独立段落，彻底消除横向粘连
      text = text.replace(
        /((?:⚡|⏳|✅|⏹\uFE0F?|❌|🈳)\s*\[[^\]]+\]|\[(?:Checking|Verifying|Deploying|Building|Starting|Testing)[^\]]*\])/gu,
        "\n\n$1\n\n"
      );

      // 5. 消除连续换行中的残留多余空格，并规范化为双换行段落分隔
      text = text.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n");

      // 6. 防止分割线 (--- 或 ===) 与前一行普通正文紧贴，导致被 CommonMark 误解析为巨大的 Setext 二级/一级大标题 (<h2>/<h1>)
      text = text.replace(/([^\n])\n(-{3,}|={3,})\s*(?:\n|$)/g, "$1\n\n$2\n\n");

      // 6. 执行进度与保活心跳去重：消除连续刷屏的重复心跳（如重复的 "⏳ [后台任务 ... 执行中]"）
      const lines = text.split("\n");
      const filteredLines: string[] = [];
      let lastHeartbeatTask = "";

      for (const line of lines) {
        const trimmed = line.trim();
        // 匹配类似: ⏳ [后台任务 task-30627 执行中，请稍候...] 或 ⏳ [模型思考推理中（已用时 25s），请稍候...]
        const hbMatch = trimmed.match(/^⏳\s*\[(?:后台任务\s+(\S+)\s+(?:执行中|持续执行|启动)|模型思考推理中)/u);
        if (hbMatch) {
          const taskKey = hbMatch[1] || "thinking";
          if (taskKey === lastHeartbeatTask) {
            // 连续出现相同任务/思考的心跳提示，只保留最新的一条，杜绝横向或纵向刷屏
            filteredLines[filteredLines.length - 1] = line;
            continue;
          }
          lastHeartbeatTask = taskKey;
        } else if (trimmed) {
          lastHeartbeatTask = "";
        }
        filteredLines.push(line);
      }

      return filteredLines.join("\n");
    })
    .join("");
}

const MarkdownViewer = memo(function MarkdownViewer({
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

  // 流式渲染节流：在 SSE 高频传输时将 DOM 重构频率约束在 50ms 一次，大幅降低主线程 CPU 开销
  const [throttledContent, setThrottledContent] = useState<string>(content);
  const pendingContentRef = useRef<string>(content);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pendingContentRef.current = content;
    if (!isStreaming) {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      setThrottledContent(content);
      return;
    }

    if (!throttleTimerRef.current) {
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null;
        setThrottledContent(pendingContentRef.current);
      }, 50);
    }
  }, [content, isStreaming]);

  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
    };
  }, []);

  const activeContent = isStreaming ? throttledContent : content;
  const formattedContent = useMemo(() => normalizeMarkdownContent(activeContent), [activeContent]);

  const baseProse = compactText ? "prose-compact" : "prose";
  const remarkPlugins = useMemo(() => [remarkGfm], []);
  const shouldHighlight = !isStreaming && content.length <= 60_000;
  const rehypePlugins = useMemo(() => {
    const plugins: any[] = [rehypeRaw];
    if (shouldHighlight) {
      plugins.push(rehypeHighlight);
    }
    return plugins;
  }, [shouldHighlight]);

  const components = useMemo(
    () => ({
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
            return <ImagePreview src={src} alt={alt} className={compactText ? "my-1.5" : "my-2.5"} />;
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

              // 仅在桌面端大屏三栏模式下（width >= 1024 且 inspector 处于常驻分栏环境）统一收敛为徽章；
              // 在移动端（如 iOS/Android）因无侧边分栏，在消息气泡中直接呈现内嵌播放器，让用户在手机上即刻看到并播放视频
              const isDesktopDocked = typeof window !== "undefined" && window.innerWidth >= 1024;
              if ((isDesktopDocked && inspector) || compactMedia || isDuplicate) {
                return (
                  <div className="not-prose my-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-chip)] text-xs text-[var(--aurora-fg1)] transition-colors hover:border-[var(--aurora-accent)]">
                    <span className="text-[var(--aurora-accent)] font-semibold">🎬</span>
                    <span className="font-medium truncate max-w-[240px]" title={label}>{label}</span>
                    {isCurrentlyInspected && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">
                        已在视窗展示
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
                      {isCurrentlyInspected ? "对焦视窗 ↗" : isDesktopDocked ? "在右侧独立视窗播放 ↗" : "在视窗中打开 ↗"}
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
            if (
              type === "presentation" ||
              type === "spreadsheet" ||
              type === "document" ||
              type === "pdf"
            ) {
              const label = typeof children === "string" ? children : getFilenameFromUrl(href);
              const cleanHref = safeDecodePath(href);
              const isCurrentlyInspected = Boolean(
                inspector?.isOpen &&
                inspector?.activeMedia &&
                (safeDecodePath(inspector.activeMedia.url) === cleanHref ||
                 inspector.activeMedia.title === label)
              );
              const iconEmoji =
                type === "presentation"
                  ? "📽️"
                  : type === "spreadsheet"
                  ? "📊"
                  : type === "pdf"
                  ? "📕"
                  : "📝";
              const typeDesc =
                type === "presentation"
                  ? "演示文稿"
                  : type === "spreadsheet"
                  ? "电子表格"
                  : type === "pdf"
                  ? "PDF 文档"
                  : "办公文档";

              if (!inspector) {
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
                    {iconEmoji} {label} ↗
                  </a>
                );
              }

              return (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    inspector?.openMediaByUrl(href, label);
                  }}
                  className="not-prose my-2 inline-flex items-center gap-2.5 px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-chip)] text-xs text-[var(--aurora-fg1)] transition-all hover:border-[var(--aurora-accent)] hover:shadow-md active:scale-[0.98] cursor-pointer select-none group/doc max-w-full text-left"
                  title={`点击在工作台独立视窗中查看${typeDesc}`}
                >
                  <span className="text-base shrink-0">{iconEmoji}</span>
                  <span className="font-semibold truncate max-w-[200px] sm:max-w-[280px] text-[var(--aurora-fg1)] group-hover/doc:text-[var(--aurora-accent)] transition-colors" title={label}>
                    {label}
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white/5 text-[var(--aurora-fg3)] uppercase shrink-0">
                    {href.split(".").pop() || type}
                  </span>
                  {isCurrentlyInspected ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium shrink-0">
                      已在工作台打开
                    </span>
                  ) : (
                    <span className="text-[11px] text-[var(--aurora-accent)] font-semibold shrink-0 flex items-center gap-0.5 whitespace-nowrap">
                      在工作台查看 ↗
                    </span>
                  )}
                </button>
              );
            }
            if (type === "subtitle") {
              const label = typeof children === "string" ? children : getFilenameFromUrl(href);
              return (
                <div className="not-prose my-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--aurora-border)] bg-[var(--aurora-chip)]/40 text-xs text-[var(--aurora-fg2)]">
                  <span className="font-bold text-indigo-400">CC</span>
                  <span className="font-mono text-[11px] truncate max-w-[200px]" title={label}>{label}</span>
                  <span className="text-[10px] px-1 py-0.2 rounded bg-indigo-500/15 text-indigo-400">同步伴随字幕</span>
                </div>
              );
            }
            if (type === "markdown") {
              const label = typeof children === "string" ? children : getFilenameFromUrl(href);
              const cleanHref = safeDecodePath(href);
              const isCurrentlyInspected = Boolean(
                inspector?.isOpen &&
                inspector?.activeMedia &&
                (safeDecodePath(inspector.activeMedia.url) === cleanHref ||
                 inspector.activeMedia.title === label)
              );

              if (!inspector) {
                return (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--aurora-accent)] hover:underline underline-offset-2 break-all font-medium transition-colors"
                    {...props}
                  >
                    📄 {label} ↗
                  </a>
                );
              }

              return (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    inspector?.openMediaByUrl(href, label);
                  }}
                  className="not-prose my-2 inline-flex items-center gap-2.5 px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-chip)] text-xs text-[var(--aurora-fg1)] transition-all hover:border-[var(--aurora-accent)] hover:shadow-md active:scale-[0.98] cursor-pointer select-none group/doc max-w-full text-left"
                  title="点击在工作台独立视窗中打开预览"
                >
                  <span className="text-amber-400 font-semibold text-sm shrink-0">📄</span>
                  <span className="font-semibold truncate max-w-[200px] sm:max-w-[280px] text-[var(--aurora-fg1)] group-hover/doc:text-[var(--aurora-accent)] transition-colors" title={label}>
                    {label}
                  </span>
                  {isCurrentlyInspected ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium shrink-0">
                      已在工作台打开
                    </span>
                  ) : (
                    <span className="text-[11px] text-[var(--aurora-accent)] font-semibold shrink-0 flex items-center gap-0.5 whitespace-nowrap">
                      在工作台预览 ↗
                    </span>
                  )}
                </button>
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
          blockquote: ({ node, children, ...props }: any) => {
            const text = extractPlainText(children).trim();
            // 如果引用块内部实际上是执行状态或进度提示，直接展开子元素，不再嵌套大块紫色引用框
            if (/^(?:⚡|⏳|✅|⏹️|❌)/.test(text)) {
              return <div className="my-1">{children}</div>;
            }
            return (
              <blockquote
                className="w-full box-border my-2.5 border-l-4 border-[var(--aurora-accent)] bg-[var(--aurora-accent-soft)] px-3.5 py-2 rounded-r-lg text-[var(--aurora-fg2)]"
                {...props}
              >
                {children}
              </blockquote>
            );
          },
          code: ({ node, className, children, ...props }: any) => {
            const isCodeBlock = Boolean(className && (className.includes("hljs") || className.includes("language-")));
            if (isCodeBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }

            const rawText = Array.isArray(children)
              ? children.map((c) => (typeof c === "string" ? c : "")).join("").trim()
              : typeof children === "string"
              ? children.trim()
              : "";

            const mediaType = detectMediaType(rawText);
            const isPath = (rawText.includes("/") || rawText.includes("\\")) && isLocalFilePath(rawText);

            if (mediaType !== "unknown" && isPath && inspector) {
              const label = getFilenameFromUrl(rawText);
              const cleanHref = safeDecodePath(rawText);
              const isCurrentlyInspected = Boolean(
                inspector.isOpen &&
                inspector.activeMedia &&
                (safeDecodePath(inspector.activeMedia.url) === cleanHref ||
                 inspector.activeMedia.title === label)
              );
              const iconEmoji =
                mediaType === "presentation"
                  ? "📽️"
                  : mediaType === "spreadsheet"
                  ? "📊"
                  : mediaType === "pdf"
                  ? "📕"
                  : mediaType === "video"
                  ? "🎬"
                  : mediaType === "audio"
                  ? "🎵"
                  : "📝";
              const typeDesc =
                mediaType === "presentation"
                  ? "PPT 演示文稿"
                  : mediaType === "spreadsheet"
                  ? "Excel 电子表格"
                  : mediaType === "pdf"
                  ? "PDF 文档"
                  : mediaType === "video"
                  ? "视频"
                  : mediaType === "audio"
                  ? "音频"
                  : "办公文档";

              return (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    inspector.openMediaByUrl(rawText, label);
                  }}
                  className="not-prose my-1.5 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-chip)] hover:border-[var(--aurora-accent)] hover:shadow-md active:scale-[0.98] transition-all cursor-pointer select-none group/code max-w-full text-left"
                  title={`点击在 Memento 应用内打开${typeDesc}视窗：${label}`}
                >
                  <span className="text-sm shrink-0">{iconEmoji}</span>
                  <span className="font-semibold text-xs truncate max-w-[200px] sm:max-w-[280px] text-[var(--aurora-fg1)] group-hover/code:text-[var(--aurora-accent)] transition-colors" title={label}>
                    {label}
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white/5 text-[var(--aurora-fg3)] uppercase shrink-0">
                    {label.split(".").pop() || mediaType}
                  </span>
                  {isCurrentlyInspected ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium shrink-0">
                      已在视窗展示
                    </span>
                  ) : (
                    <span className="text-[11px] text-[var(--aurora-accent)] font-semibold shrink-0 flex items-center gap-0.5 whitespace-nowrap">
                      在工作台打开 ↗
                    </span>
                  )}
                </button>
              );
            }

            return (
              <code
                className="px-1.5 py-0.5 rounded text-[0.85em] font-mono bg-[var(--aurora-chip)] text-[var(--aurora-fg1)] border border-[var(--aurora-border)] break-words [overflow-wrap:anywhere] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
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
          p: ({ node, children, ...props }: any) => {
            const textContent = extractPlainText(children).trim();
            const statusMatch = textContent.match(/^(⚡|⏳|✅|⏹\uFE0F?|❌|🈳)\s*(?:\[([^\]]+)\]|(.*))$/u);
            if (statusMatch && (statusMatch[2] || statusMatch[3])) {
              const icon = statusMatch[1];
              const text = (statusMatch[2] || statusMatch[3]).trim();
              if (text.length > 0 && text.length < 240) {
                return <StatusStepItem icon={icon} text={text} />;
              }
            }

            return (
              <p className={compactText ? "text-[12px] leading-relaxed my-1 first:mt-0 last:mb-0 text-[var(--aurora-fg1)]" : "text-[13.5px] leading-relaxed my-1.5 first:mt-0 last:mb-0 text-[var(--aurora-fg1)]"} {...props}>
                {children}
              </p>
            );
          },
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
            <li className={compactText ? "text-[12px] leading-relaxed break-words" : "text-[13.5px] leading-relaxed break-words"} {...props}>
              {children}
            </li>
          ),
          hr: (props: any) => <hr className="my-2.5 border-[var(--aurora-border)]" {...props} />,
          div: ({ node, align, className, children, style, ...props }: any) => {
            const mergedStyle = align === "center" ? { textAlign: "center" as const, ...style } : style;
            return (
              <div className={className} style={mergedStyle} {...props}>
                {children}
              </div>
            );
          },
          details: ({ node, children, className, ...props }: any) => (
            <details className={`my-2 p-3 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface)]/50 ${className || ""}`} {...props}>
              {children}
            </details>
          ),
          summary: ({ node, children, className, ...props }: any) => (
            <summary className={`font-semibold cursor-pointer select-none text-[var(--aurora-fg1)] hover:text-[var(--aurora-accent)] transition-colors ${className || ""}`} {...props}>
              {children}
            </summary>
          ),
          kbd: ({ node, children, className, ...props }: any) => (
            <kbd className={`px-1.5 py-0.5 text-[11px] font-mono rounded bg-white/10 border border-white/10 text-[var(--aurora-fg2)] shadow-sm ${className || ""}`} {...props}>
              {children}
            </kbd>
          ),
    }),
    [compactMedia, compactText, inspector]
  );

  return (
    <div className={`${baseProse} max-w-full min-w-0 break-words overflow-wrap-anywhere overflow-hidden ${className}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {formattedContent}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownViewer;
