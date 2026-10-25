"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTheme } from "@/lib/theme-context";
import { triggerHapticFeedback } from "@/lib/native-notify";
import { Icon } from "@/components/aurora/Icon";

interface MermaidBlockProps {
  code: string;
  className?: string;
}

export function MermaidBlock({ code, className }: MermaidBlockProps) {
  const { theme } = useTheme();
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const diagramId = `mermaid_${rawId || Math.random().toString(36).slice(2, 9)}`;

  const [svgHtml, setSvgHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"diagram" | "code">("diagram");
  const [copied, setCopied] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isCancelled = false;

    async function renderMermaid() {
      if (!code.trim()) {
        setSvgHtml("");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const mermaid = (await import("mermaid")).default;
        const isDark = theme === "dark";

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: isDark ? "dark" : "default",
          themeVariables: isDark
            ? {
                primaryColor: "#7C3AED",
                primaryTextColor: "#F1F1F5",
                primaryBorderColor: "#A78BFA",
                lineColor: "#9CA3AF",
                secondaryColor: "#1E1E2E",
                tertiaryColor: "#181825",
                fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
              }
            : {
                primaryColor: "#8B5CF6",
                primaryTextColor: "#111827",
                primaryBorderColor: "#7C3AED",
                lineColor: "#4B5563",
                secondaryColor: "#F3F4F6",
                tertiaryColor: "#E5E7EB",
                fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
              },
        });

        // Clean any residual elements with this ID from earlier renders
        const existing = document.getElementById(diagramId);
        if (existing) existing.remove();

        const { svg } = await mermaid.render(diagramId, code.trim());
        if (!isCancelled) {
          setSvgHtml(svg);
          setLoading(false);
          setError(null);
        }
      } catch (err: unknown) {
        if (!isCancelled) {
          console.warn("[MermaidBlock] render failed:", err);
          const msg = err instanceof Error ? err.message : String(err || "Mermaid 语法解析失败");
          setError(msg);
          setLoading(false);
        }
      }
    }

    renderMermaid();

    return () => {
      isCancelled = true;
    };
  }, [code, theme, diagramId]);

  const handleCopyCode = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      triggerHapticFeedback(12);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const handleCopySvg = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!svgHtml) return;
    navigator.clipboard.writeText(svgHtml).then(() => {
      setCopied(true);
      triggerHapticFeedback(12);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const handleZoomIn = () => setZoom((z) => Math.min(2.5, +(z + 0.2).toFixed(1)));
  const handleZoomOut = () => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(1)));
  const handleResetZoom = () => setZoom(1);

  return (
    <>
      <div
        className={`not-prose my-3 rounded-2xl overflow-hidden border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/90 shadow-md ${className || ""}`}
      >
        {/* Top Action Bar */}
        <div className="flex items-center justify-between px-3.5 py-2 bg-white/5 border-b border-white/5 text-xs text-[var(--aurora-fg3)] select-none">
          <div className="flex items-center gap-2">
            <span className="font-semibold flex items-center gap-1.5 text-purple-400">
              <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
              MERMAID 图表
            </span>

            {/* View Mode Toggle: Diagram vs Code */}
            <div className="flex items-center bg-white/10 rounded-lg p-0.5 ml-2 border border-white/5">
              <button
                type="button"
                onClick={() => setViewMode("diagram")}
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                  viewMode === "diagram"
                    ? "bg-[var(--aurora-accent)] text-white shadow-sm"
                    : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)]"
                }`}
              >
                图表
              </button>
              <button
                type="button"
                onClick={() => setViewMode("code")}
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                  viewMode === "code"
                    ? "bg-[var(--aurora-accent)] text-white shadow-sm"
                    : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)]"
                }`}
              >
                源码
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {viewMode === "diagram" && !error && svgHtml && (
              <>
                <button
                  type="button"
                  onClick={handleZoomOut}
                  title="缩小"
                  className="px-1.5 py-1 rounded-lg hover:bg-white/10 text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] transition-colors"
                >
                  <Icon name="minus" size={12} />
                </button>
                <button
                  type="button"
                  onClick={handleResetZoom}
                  title="重置缩放"
                  className="px-1.5 py-0.5 text-[10px] font-mono rounded hover:bg-white/10 text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)]"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  title="放大"
                  className="px-1.5 py-1 rounded-lg hover:bg-white/10 text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] transition-colors"
                >
                  <Icon name="plus" size={12} />
                </button>
                <div className="w-px h-3 bg-white/10 mx-1" />
                <button
                  type="button"
                  onClick={() => setIsFullscreen(true)}
                  title="全屏沉浸查看"
                  className="px-2 py-1 rounded-lg hover:bg-white/10 text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] transition-colors flex items-center gap-1 text-[11px]"
                >
                  <Icon name="maximize" size={12} />
                  <span>全屏</span>
                </button>
                <button
                  type="button"
                  onClick={handleCopySvg}
                  title="复制 SVG 代码"
                  className="px-2 py-1 rounded-lg hover:bg-white/10 text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] transition-colors flex items-center gap-1 text-[11px]"
                >
                  <Icon name={copied ? "check" : "copy"} size={12} />
                  <span>{copied ? "已复制" : "复制SVG"}</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={handleCopyCode}
              title="复制 Mermaid 源代码"
              className="px-2 py-1 rounded-lg hover:bg-white/10 text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] transition-colors flex items-center gap-1 text-[11px]"
            >
              <Icon name={copied ? "check" : "copy"} size={12} />
              <span>{copied ? "已复制" : "复制代码"}</span>
            </button>
          </div>
        </div>

        {/* Content Body */}
        {viewMode === "code" || error ? (
          <div className="p-4 bg-black/30 font-mono text-xs overflow-x-auto text-[var(--aurora-fg2)]">
            {error && (
              <div className="mb-3 p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs flex items-center gap-2">
                <span>⚠️ 图表语法未闭合或存在解析异常，已自动切换为源码模式展示：</span>
              </div>
            )}
            <pre className="m-0 leading-relaxed whitespace-pre font-mono">
              <code>{code.trim()}</code>
            </pre>
          </div>
        ) : (
          <div
            ref={containerRef}
            className="p-4 sm:p-6 flex items-center justify-center min-h-[160px] overflow-x-auto bg-black/10 select-none transition-all"
          >
            {loading ? (
              <div className="flex flex-col items-center justify-center gap-2 text-xs text-[var(--aurora-fg3)] py-8">
                <div className="w-5 h-5 border-2 border-[var(--aurora-accent)] border-t-transparent rounded-full animate-spin" />
                <span>正在渲染 Mermaid 架构图...</span>
              </div>
            ) : (
              <div
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: "center center",
                  transition: "transform 0.15s ease",
                }}
                className="mermaid-svg-container max-w-full flex justify-center [&>svg]:max-w-full [&>svg]:h-auto [&>svg]:drop-shadow-sm"
                dangerouslySetInnerHTML={{ __html: svgHtml }}
              />
            )}
          </div>
        )}
      </div>

      {/* Fullscreen Overlay Modal */}
      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-md p-4 sm:p-8 animate-in fade-in"
          onClick={() => setIsFullscreen(false)}
        >
          <div
            className="flex items-center justify-between pb-4 border-b border-white/10 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span className="font-semibold text-purple-400">Mermaid 沉浸图表全屏视窗</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleZoomOut}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs"
              >
                <Icon name="minus" size={14} />
              </button>
              <button
                type="button"
                onClick={handleResetZoom}
                className="px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-mono"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={handleZoomIn}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs"
              >
                <Icon name="plus" size={14} />
              </button>
              <button
                type="button"
                onClick={() => setIsFullscreen(false)}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs ml-2"
                title="关闭全屏"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>
          <div
            className="flex-1 overflow-auto flex items-center justify-center p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: "center center",
                transition: "transform 0.15s ease",
              }}
              className="[&>svg]:max-w-full [&>svg]:h-auto"
              dangerouslySetInnerHTML={{ __html: svgHtml }}
            />
          </div>
        </div>
      )}
    </>
  );
}
