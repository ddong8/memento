"use client";

import { useRef, useState } from "react";
import { api, type AgentQuotasResponse } from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import { BrandMark } from "@/components/aurora/BrandMark";
import { Btn } from "@/components/aurora/primitives";
import { useMediaInspector } from "@/components/viewers/MediaInspectorContext";
import { resolveConversationAgent } from "@/components/ask/HistoryDrawer";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/lib/theme-context";
import { hasNativeMenu, popupNativeMenu, type NativeMenuItem } from "@/lib/native-menu";
import type { ExecutionMode } from "@/lib/ask/turns";

/**
 * The bar over the conversation: history, which agent it runs on and the title, the workbench and quota
 * buttons, new chat, select / export / share / clear (in a "more" menu on narrow screens).
 */
export function AskTopBar({
  conversationCount,
  turnCount,
  activeConversationId,
  title,
  agent,
  agentColor,
  executionMode,
  selectedDevice,
  quotasData,
  selecting,
  onOpenHistory,
  onOpenQuota,
  onNewChat,
  onToggleSelectTurns,
  onExportMarkdown,
  onShare,
}: {
  conversationCount: number;
  turnCount: number;
  activeConversationId: string | null;
  title: string;
  agent: ReturnType<typeof resolveConversationAgent>;
  agentColor: string;
  executionMode: ExecutionMode;
  selectedDevice: string;
  quotasData: AgentQuotasResponse | null;
  /** Picking turns to share or export */
  selecting: boolean;
  onOpenHistory: () => void;
  onOpenQuota: () => void;
  onNewChat: () => void;
  onToggleSelectTurns: () => void;
  onExportMarkdown: () => void;
  onShare: () => void;
}) {
  const { t, locale } = useI18n();
  const isZh = locale.startsWith("zh");
  const inspector = useMediaInspector();
  const { theme, toggleTheme } = useTheme();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  // The desktop app shows this menu as the system's own menu; a browser and the mobile app get the page's
  const openMoreMenu = async () => {
    if (!hasNativeMenu()) {
      setMoreMenuOpen((v) => !v);
      return;
    }
    const narrow = window.innerWidth < 640; // the bar's own buttons are hidden then (sm)
    const items: NativeMenuItem[] = [];
    if (narrow) {
      if (inspector && inspector.mediaList.length > 0) {
        items.push({ id: "workbench", label: inspector.isOpen ? (isZh ? "折叠工作台视窗" : "Close Workbench") : (isZh ? "展开工作台视窗" : "Open Workbench") });
      }
      items.push({ id: "quota", label: isZh ? "AI 额度监控" : "AI Quotas" });
      items.push({ id: "theme", label: isZh ? "外观主题切换" : "Toggle Theme" });
      items.push({ type: "separator" });
    }
    if (activeConversationId) {
      items.push({ id: "select", label: isZh ? "批量多选消息" : "Select messages", checked: selecting });
      items.push({ id: "export", label: isZh ? "导出 Markdown" : "Export Markdown" });
      items.push({ id: "share", label: isZh ? "分享完整会话" : "Share conversation" });
    }
    if (!items.some((it) => !("type" in it))) return;
    const id = await popupNativeMenu(items, moreRef.current);
    if (id === undefined) {
      setMoreMenuOpen((v) => !v);
      return;
    }
    if (id === "workbench") inspector?.toggleInspector();
    else if (id === "quota") onOpenQuota();
    else if (id === "theme") toggleTheme();
    else if (id === "select") onToggleSelectTurns();
    else if (id === "export") onExportMarkdown();
    else if (id === "share") onShare();
  };

  return (
    <header className="px-2 sm:px-4 py-0 sm:py-2.5 border-b border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/95 sm:bg-[var(--aurora-surface-solid)]/75 sm:backdrop-blur-md flex items-center justify-between gap-1 sm:gap-2.5 shrink-0 select-none relative z-20 min-h-[34px] sm:min-h-[46px]">
      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1 mr-1 sm:mr-2 overflow-hidden">
        {/* 移动端侧边菜单开关 (在移动端下充当主侧边栏汉堡按钮) */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("memento_toggle_sidebar"))}
          aria-label="打开侧边导航"
          title={isZh ? "打开侧边栏" : "Open sidebar"}
          className="sm:hidden p-1.5 -ml-1 rounded-lg text-[var(--aurora-fg2)] active:bg-[var(--aurora-chip)] shrink-0 transition-colors"
        >
          <Icon name="menu" size={19} />
        </button>

        {/* 当前会话标题与智能体图标徽章 */}
        <div className="min-w-0 flex-1 flex items-center gap-1.5 overflow-hidden">
          {agent.brandId ? (
            <div
              className="w-5 h-5 rounded-md flex items-center justify-center shrink-0"
              style={{
                background: agentColor + "18",
                border: `1px solid ${agentColor}35`,
              }}
              title={agent.name}
            >
              <BrandMark id={agent.brandId} size={13} colored />
            </div>
          ) : (
            <div
              className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 bg-[var(--aurora-accent-soft)] border border-[var(--aurora-border)]"
              title={agent.name || "AI 执事"}
            >
              <Icon
                name={agent.id === "shell" ? "terminal" : "sparkles"}
                size={11.5}
                style={{ color: agentColor }}
              />
            </div>
          )}
          <h1
            className="text-[13.5px] sm:text-sm font-semibold text-[var(--aurora-fg1)] truncate"
            title={title}
          >
            {title}
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-1 sm:gap-1.5 shrink-0 relative">
        {/* 工作台独立视窗快捷开关 (桌面端展示；移动端收拢至更多菜单) */}
        {inspector && inspector.mediaList.length > 0 && (
          <div className="hidden sm:inline-flex shrink-0">
            <Btn
              variant={inspector.isOpen ? "primary" : "glass"}
              size="sm"
              icon="sidebar"
              onClick={inspector.toggleInspector}
              title={inspector.isOpen ? (isZh ? "折叠工作台视窗" : "Collapse workbench inspector") : (isZh ? "展开工作台预览" : "Open workbench inspector")}
            >
              <span className="flex items-center gap-1 sm:gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span className="font-medium">
                  {inspector.isOpen ? (
                    <span className="hidden 2xl:inline">{isZh ? "工作台" : "Desk"}</span>
                  ) : (
                    <>
                      <span className="hidden xl:inline">
                        {inspector.mediaList.some((m) => m.type === "markdown") ? (isZh ? "工作台预览" : "Workbench") : (isZh ? "媒体视窗" : "Media")}
                      </span>
                      <span className="hidden md:inline xl:hidden">{isZh ? "工作台" : "Desk"}</span>
                    </>
                  )}
                </span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/20 font-mono font-bold">
                  {inspector.mediaList.length}
                </span>
              </span>
            </Btn>
          </div>
        )}

        {/* AI 订阅与额度监控入口 (桌面端展示；移动端收拢至更多菜单，杜绝挤压标题) */}
        <div className="hidden sm:inline-flex shrink-0">
          <Btn
            variant="glass"
            size="sm"
            icon="activity"
            onMouseEnter={() => {
              void api.getAgentQuotas(selectedDevice);
            }}
            onClick={() => onOpenQuota()}
            title={isZh ? "查看各个 AI 订阅工具额度 (Antigravity/Claude/Codex/WorkBuddy)" : "View AI Subscriptions & Quotas"}
          >
            <span className="flex items-center gap-1">
              <span className="hidden 2xl:inline-block w-1.5 h-1.5 rounded-full bg-cyan-400" />
              <span className="hidden 2xl:inline text-xs font-medium">AI 额度</span>
              {(() => {
                const targetTool = executionMode === "claude"
                  ? quotasData?.tools?.claude_code
                  : executionMode === "codex"
                  ? quotasData?.tools?.codex
                  : executionMode === "workbuddy"
                  ? quotasData?.tools?.workbuddy
                  : quotasData?.tools?.antigravity;
                const percent = targetTool?.remaining_percent;
                if (percent != null) {
                  return (
                    <span
                      className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded-full tabular-nums ${
                        percent > 30 ? "quota-badge-teal" : "quota-badge-amber"
                      }`}
                    >
                      {Math.round(percent)}%
                    </span>
                  );
                }
                if (targetTool?.tier) {
                  return (
                    <span className="quota-badge-neutral text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                      {targetTool.tier}
                    </span>
                  );
                }
                return (
                  <span
                    className={`text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full ${
                      targetTool?.available ? "quota-badge-emerald" : "quota-badge-neutral"
                    }`}
                  >
                    {targetTool?.available ? "可用" : "未启动"}
                  </span>
                );
              })()}
            </span>
          </Btn>
        </div>

        {/* 历史对话按钮 (全端统一常驻展示于新增会话旁) */}
        <Btn
          variant="glass"
          size="sm"
          icon="clock"
          onClick={onOpenHistory}
          title={isZh ? "查看历史对话" : "View history"}
          className="shrink-0"
        >
          <span className={inspector?.isOpen ? "hidden 2xl:inline" : "hidden md:inline"}>{t.ask.historyTitle}</span>
          {conversationCount > 0 && (
            <span
              style={{
                fontSize: 10.5,
                padding: "1px 5px",
                borderRadius: 999,
                background: "var(--aurora-chip)",
                color: "var(--aurora-fg3)",
                marginLeft: 2,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {conversationCount}
            </span>
          )}
        </Btn>

        {/* 新建会话按钮 */}
        <Btn
          variant="glass"
          size="sm"
          icon="plus"
          onClick={onNewChat}
          title={t.ask.newChat}
          className="shrink-0"
        >
          <span className={inspector?.isOpen ? "hidden 2xl:inline" : "hidden xl:inline"}>{t.ask.newChat}</span>
        </Btn>

        {/* 桌面大屏幕且未展开工作台视窗时平铺操作按钮 (>= xl 屏幕) */}
        {activeConversationId && turnCount > 0 && !inspector?.isOpen && (
          <div className="hidden xl:flex items-center gap-1 sm:gap-1.5">
            <Btn
              variant={selecting ? "primary" : "glass"}
              size="sm"
              icon="layers"
              onClick={() => {
                onToggleSelectTurns();
              }}
              title={isZh ? "多选消息/问答分享" : "Select messages to share"}
              className="shrink-0"
            >
              <span className="hidden 2xl:inline">{isZh ? "多选" : "Select"}</span>
            </Btn>
            <Btn
              variant="glass"
              size="sm"
              icon="download"
              onClick={onExportMarkdown}
              title={isZh ? "导出 Markdown" : "Export Markdown report"}
              className="shrink-0"
            >
              <span className="hidden 2xl:inline">{isZh ? "导出" : "Export"}</span>
            </Btn>
            <Btn
              variant="glass"
              size="sm"
              icon="share"
              onClick={() => onShare()}
              title={isZh ? "分享整场对话" : "Share full conversation"}
              className="shrink-0"
            >
              <span className="hidden 2xl:inline">{isZh ? "分享" : "Share"}</span>
            </Btn>
          </div>
        )}
        {/* 更多菜单：移动端常驻，大屏收纳 */}
        <div ref={moreRef} className={`relative shrink-0 ${inspector?.isOpen ? "block" : "block xl:hidden"}`}>
          <Btn
            variant={selecting ? "primary" : "glass"}
            size="sm"
            icon="more"
            onClick={() => void openMoreMenu()}
            title={isZh ? "更多会话操作" : "More actions"}
            className="shrink-0"
          />

          {moreMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMoreMenuOpen(false)}
              />
              <div
                className="absolute right-0 top-10 z-50 min-w-[200px] py-1.5 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)]/98 backdrop-blur-xl shadow-2xl flex flex-col gap-0.5 animate-in fade-in zoom-in-95 duration-100"
              >
                {/* 移动端专属：工作台媒体/研报视窗 */}
                {inspector && inspector.mediaList.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      inspector.toggleInspector();
                    }}
                    className="px-3 py-2 text-xs flex items-center justify-between hover:bg-[var(--aurora-chip)] transition-colors text-left text-[var(--aurora-fg1)] sm:hidden"
                  >
                    <span className="flex items-center gap-2">
                      <Icon name="sidebar" size={14} className="text-emerald-400" />
                      <span>{inspector.isOpen ? (isZh ? "折叠工作台视窗" : "Close Workbench") : (isZh ? "展开工作台视窗" : "Open Workbench")}</span>
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-mono font-bold">
                      {inspector.mediaList.length}
                    </span>
                  </button>
                )}

                {/* 移动端专属：AI 额度查看 */}
                <button
                  type="button"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    onOpenQuota();
                  }}
                  className="px-3 py-2 text-xs flex items-center justify-between hover:bg-[var(--aurora-chip)] transition-colors text-left text-[var(--aurora-fg1)] sm:hidden"
                >
                  <span className="flex items-center gap-2">
                    <Icon name="activity" size={14} className="text-cyan-400" />
                    <span>AI 额度监控</span>
                  </span>
                  {(() => {
                    const targetTool = executionMode === "claude"
                      ? quotasData?.tools?.claude_code
                      : executionMode === "codex"
                      ? quotasData?.tools?.codex
                      : executionMode === "workbuddy"
                      ? quotasData?.tools?.workbuddy
                      : quotasData?.tools?.antigravity;
                    const percent = targetTool?.remaining_percent;
                    if (percent != null) {
                      return (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full quota-badge-teal">
                          {Math.round(percent)}%
                        </span>
                      );
                    }
                    return null;
                  })()}
                </button>

                {/* 移动端专属：主题切换 */}
                <button
                  type="button"
                  onClick={() => {
                    toggleTheme();
                    setMoreMenuOpen(false);
                  }}
                  className="px-3 py-2 text-xs flex items-center justify-between hover:bg-[var(--aurora-chip)] transition-colors text-left text-[var(--aurora-fg1)] sm:hidden"
                >
                  <span className="flex items-center gap-2">
                    <Icon name={theme === "dark" ? "sun" : "moon"} size={14} className="text-amber-400" />
                    <span>{isZh ? "外观主题切换" : "Toggle Theme"}</span>
                  </span>
                  <span className="text-[10px] text-[var(--aurora-fg3)] capitalize">{theme}</span>
                </button>

                <div className="my-1 border-t border-[var(--aurora-border)] sm:hidden" />

                {activeConversationId && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onToggleSelectTurns();
                        setMoreMenuOpen(false);
                      }}
                      className={`px-3 py-2 text-xs flex items-center gap-2.5 hover:bg-[var(--aurora-chip)] transition-colors text-left ${
                        selecting ? "text-[var(--aurora-accent)] font-semibold" : "text-[var(--aurora-fg1)]"
                      }`}
                    >
                      <Icon name="layers" size={14} />
                      <span>{selecting ? (isZh ? "退出多选模式" : "Exit selection") : (isZh ? "批量多选消息" : "Select messages")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onExportMarkdown();
                        setMoreMenuOpen(false);
                      }}
                      className="px-3 py-2 text-xs flex items-center gap-2.5 text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors text-left"
                    >
                      <Icon name="download" size={14} />
                      <span>{isZh ? "导出 Markdown" : "Export Markdown"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onShare();
                        setMoreMenuOpen(false);
                      }}
                      className="px-3 py-2 text-xs flex items-center gap-2.5 text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors text-left"
                    >
                      <Icon name="share" size={14} />
                      <span>{isZh ? "分享完整会话" : "Share conversation"}</span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
