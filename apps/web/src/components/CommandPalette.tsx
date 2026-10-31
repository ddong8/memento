"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchHit, getApiBase, authFetch, openServerSwitchModal, invalidateApiCache } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { useDevice } from "@/lib/device-context";
import { useTheme } from "@/lib/theme-context";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";

const RECENT_KEY = "dr_recent_searches";
const MAX_RECENT = 6;
const DEBOUNCE_MS = 220;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function pushRecent(q: string) {
  try {
    const next = [q, ...loadRecent().filter((x) => x !== q)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

interface PaletteAction {
  id: string;
  category: "action" | "jump";
  title: string;
  subtitle: string;
  icon: string;
  badge?: string;
  keywords: string[];
  run: () => void;
}

/**
 * Raycast-style Hierarchical Command Palette (Cmd/Ctrl + K):
 * - Tier 1: 快捷动作 Actions（新建对话、切换设备、一键清缓存、切换主题）
 * - Tier 2: 快捷直达 Jump to（认知大脑、作息节律、工作待办、个人画像、认知星云）
 * - Tier 3: 语义与文档历史搜索（Hybrid keyword + BGE-M3 语义向量融合检索）
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [semanticUsed, setSemanticUsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [cacheClearedTip, setCacheClearedTip] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);

  const router = useRouter();
  const { t, locale } = useI18n();
  const { selectedDeviceId } = useDevice();
  const { theme, toggleTheme } = useTheme();
  const isZh = locale === "zh-CN";

  /* ── open/close on Cmd+K ─────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onCustomOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("memento:open-search", onCustomOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("memento:open-search", onCustomOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setRecent(loadRecent());
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
      setHits([]);
      setActive(0);
      setSemanticUsed(false);
      setCacheClearedTip(false);
    }
  }, [open]);

  const go = useCallback(
    (href: string) => {
      const q = query.trim();
      if (q) pushRecent(q);
      setOpen(false);
      router.push(href);
    },
    [query, router]
  );

  /* ── Tier 1 Actions & Tier 2 Jump-to Definitions ──────────────────────── */
  const staticActions = useMemo<PaletteAction[]>(() => {
    return [
      // Tier 1: 快捷动作 Actions
      {
        id: "action_new_chat",
        category: "action",
        title: isZh ? "新建会话" : "New Chat",
        subtitle: isZh ? "开启全新 AI 执事对话，重置上下文" : "Start a fresh AI conversation session",
        icon: "plus",
        badge: "⌘N",
        keywords: ["new", "chat", "ask", "新建", "对话", "会话", "提问"],
        run: () => {
          go("/ask");
          window.dispatchEvent(new CustomEvent("memento:new-chat"));
        },
      },
      {
        id: "action_switch_device",
        category: "action",
        title: isZh ? "切换物理设备 / 服务器节点" : "Switch Device / Server",
        subtitle: isZh ? "在云端服务、本地物理机与多机集群之间切换" : "Switch between cloud node, local machines, and cluster",
        icon: "server",
        badge: "Node",
        keywords: ["server", "device", "node", "切换", "设备", "服务器", "节点", "集群"],
        run: () => {
          setOpen(false);
          openServerSwitchModal();
        },
      },
      {
        id: "action_clear_cache",
        category: "action",
        title: isZh ? "一键清空全局缓存" : "Clear All Caches",
        subtitle: isZh ? "清理前端 ETag / 内存响应缓存与过期会话状态" : "Invalidate client memory response cache and ETag storage",
        icon: "refresh",
        badge: "Cache",
        keywords: ["clear", "cache", "clean", "purge", "刷新", "清理", "缓存", "重置"],
        run: () => {
          invalidateApiCache();
          try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
              const key = localStorage.key(i);
              if (key && (key.startsWith("dr_recent") || key.startsWith("memento_cache") || key.startsWith("ask_cache_"))) {
                localStorage.removeItem(key);
              }
            }
          } catch {}
          setCacheClearedTip(true);
          setTimeout(() => setCacheClearedTip(false), 2400);
        },
      },
      {
        id: "action_toggle_theme",
        category: "action",
        title: theme === "dark" ? (isZh ? "切换为明亮晨曦模式" : "Switch to Light Mode") : (isZh ? "切换为极夜暗黑模式" : "Switch to Dark Mode"),
        subtitle: isZh ? `当前处于 ${theme === "dark" ? "Dark 极夜暗黑" : "Light 极光晨曦"} 质感主题` : `Current theme: ${theme}`,
        icon: theme === "dark" ? "sun" : "moon",
        badge: "Theme",
        keywords: ["theme", "dark", "light", "color", "主题", "暗黑", "明亮", "白天", "黑夜", "夜间"],
        run: () => {
          toggleTheme();
        },
      },

      // Tier 2: 快捷直达 Jump to
      {
        id: "jump_ask",
        category: "jump",
        title: isZh ? "认知大脑 / AI 执事" : "Cognitive Brain / AI Deacon",
        subtitle: isZh ? "多智能体协同、物理机实时交互与前置心领神会" : "Multi-agent orchestration, live execution & resonance",
        icon: "terminal",
        badge: "/ask",
        keywords: ["ask", "brain", "agent", "claude", "antigravity", "codex", "大脑", "执事", "对话"],
        run: () => go("/ask"),
      },
      {
        id: "jump_daily",
        category: "jump",
        title: isZh ? "作息节律 / 梦境日报" : "Circadian Rhythm / Daily Reports",
        subtitle: isZh ? "每日自动化总结、心智进化记录与工作时间线" : "Nightly dreaming summaries & daily activity timeline",
        icon: "calendar",
        badge: "/daily",
        keywords: ["daily", "rhythm", "dream", "timeline", "作息", "节律", "日报", "梦境", "时间线"],
        run: () => go("/daily"),
      },
      {
        id: "jump_tasks",
        category: "jump",
        title: isZh ? "工作待办 / 跨机任务" : "Work Tasks / Multi-Device Jobs",
        subtitle: isZh ? "多机分布式任务追踪、资产沉淀与工作待跟进" : "Distributed tasks tracking & work follow-ups",
        icon: "check",
        badge: "/tasks",
        keywords: ["task", "tasks", "inbox", "todo", "工作", "待办", "任务", "调度"],
        run: () => go("/tasks"),
      },
      {
        id: "jump_profile",
        category: "jump",
        title: isZh ? "个人画像 / 常驻偏好" : "Personal Profile / Iron Rules",
        subtitle: isZh ? "性别形象设定、开发者心智模型与终身铁律" : "Avatar settings, developer mental model & iron rules",
        icon: "user",
        badge: "/profile",
        keywords: ["profile", "persona", "rules", "avatar", "画像", "个人", "偏好", "铁律", "设置"],
        run: () => go("/profile"),
      },
      {
        id: "jump_memory_nebula",
        category: "jump",
        title: isZh ? "认知星云 / 知识图谱" : "Cognitive Nebula / Knowledge Graph",
        subtitle: isZh ? "3D 记忆实体网络、历史踩坑防线与知识拓扑" : "3D memory galaxy, entity network & failure defense",
        icon: "brain",
        badge: "/memory",
        keywords: ["memory", "nebula", "galaxy", "graph", "entity", "星云", "图谱", "记忆", "实体", "星系"],
        run: () => go("/memory"),
      },
    ];
  }, [isZh, theme, toggleTheme, go]);

  /* ── Filter actions & jump items based on query ───────────────────────── */
  const cleanQ = query.trim().toLowerCase();

  const matchingActions = useMemo(() => {
    if (!cleanQ) return staticActions.filter((a) => a.category === "action");
    return staticActions
      .filter((a) => a.category === "action")
      .filter(
        (a) =>
          a.title.toLowerCase().includes(cleanQ) ||
          a.subtitle.toLowerCase().includes(cleanQ) ||
          a.keywords.some((k) => k.includes(cleanQ))
      );
  }, [cleanQ, staticActions]);

  const matchingJumps = useMemo(() => {
    if (!cleanQ) return staticActions.filter((a) => a.category === "jump");
    return staticActions
      .filter((a) => a.category === "jump")
      .filter(
        (a) =>
          a.title.toLowerCase().includes(cleanQ) ||
          a.subtitle.toLowerCase().includes(cleanQ) ||
          a.keywords.some((k) => k.includes(cleanQ))
      );
  }, [cleanQ, staticActions]);

  /* ── debounced search for Tier 3 ─────────────────────────────────────── */
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, offset: "0", limit: "6" });
        if (selectedDeviceId) params.set("device_id", selectedDeviceId);
        const res = await authFetch(`${getApiBase()}/api/search?${params}`);
        const data = await res.json();
        if (seq !== seqRef.current) return;
        setHits(data.results ?? []);
        setSemanticUsed(Boolean(data.semantic_used));
        setActive(0);
      } catch {
        if (seq === seqRef.current) setHits([]);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, selectedDeviceId]);

  /* ── Flat selectable items for 1:1 arrow keyboard navigation ─────────── */
  interface FlatItem {
    id: string;
    onExecute: () => void;
  }

  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];

    // 1. Actions
    for (const a of matchingActions) {
      items.push({ id: a.id, onExecute: a.run });
    }

    // 2. Jump to
    for (const j of matchingJumps) {
      items.push({ id: j.id, onExecute: j.run });
    }

    // 3. Ask AI Prompt (when query is present)
    if (cleanQ) {
      items.push({
        id: "ask_ai_card",
        onExecute: () => go(`/ask?q=${encodeURIComponent(query.trim())}`),
      });
    }

    // 4. Hits
    for (const h of hits) {
      items.push({
        id: `hit_${h.id}`,
        onExecute: () => go(`/documents/${h.id}`),
      });
    }

    // 5. View all footer
    if (cleanQ && (hits.length > 0 || matchingActions.length + matchingJumps.length > 0)) {
      items.push({
        id: "view_all_footer",
        onExecute: () => go(`/ask?q=${encodeURIComponent(query.trim())}`),
      });
    }

    return items;
  }, [matchingActions, matchingJumps, cleanQ, hits, go, query]);

  /* ── keyboard nav within the flattened list ──────────────────────────── */
  const onInputKey = (e: React.KeyboardEvent) => {
    const max = flatItems.length;
    if (max === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % max);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + max) % max);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flatItems[active]) {
        flatItems[active].onExecute();
      } else if (query.trim()) {
        go(`/ask?q=${encodeURIComponent(query.trim())}`);
      }
    }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-flat-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const showRecent = !query.trim() && recent.length > 0;
  let runningFlatIndex = 0;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(0,0,0,0.52)",
        backdropFilter: "blur(5px)",
        WebkitBackdropFilter: "blur(5px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "10vh 16px 16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="aurora-card"
        style={{
          width: "100%",
          maxWidth: 680,
          borderRadius: 20,
          overflow: "hidden",
          padding: 0,
          maxHeight: "76vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 64px -12px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--aurora-border)",
          background: "var(--aurora-surface)",
        }}
      >
        {/* Search Input Bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "16px 18px",
            borderBottom: "1px solid var(--aurora-border)",
          }}
        >
          <Icon name="search" size={18} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            placeholder={isZh ? "输入命令、搜索记忆、直达功能或向 AI 提问..." : "Type a command, jump to, or ask memory..."}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 15.5,
              color: "var(--aurora-fg1)",
            }}
          />
          {cacheClearedTip && (
            <span
              style={{
                fontSize: 11.5,
                color: "#10b981",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                borderRadius: 6,
                background: "rgba(16, 185, 129, 0.12)",
                border: "1px solid rgba(16, 185, 129, 0.25)",
              }}
            >
              <Icon name="check" size={12} />
              {isZh ? "缓存已清空" : "Cache Cleared"}
            </span>
          )}
          {loading && (
            <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>{t.palette.searching}</span>
          )}
          {!loading && semanticUsed && (
            <span
              title={t.searchPage.semanticOn}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                padding: "2px 7px",
                borderRadius: 6,
                background: "var(--aurora-accent-soft)",
                color: "var(--aurora-accent)",
                fontWeight: 500,
              }}
            >
              <Icon name="sparkles" size={12} />
              {isZh ? "语义向量激活" : "Semantic"}
            </span>
          )}
        </div>

        {/* Scrollable Command & Result List */}
        <div ref={listRef} style={{ overflowY: "auto", flex: 1, padding: "8px 0" }}>
          {/* Recent searches pills (when empty query) */}
          {showRecent && (
            <div style={{ padding: "8px 18px 12px 18px", borderBottom: "1px solid var(--aurora-border)" }}>
              <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 8, fontWeight: 500, letterSpacing: "0.02em" }}>
                {t.palette.recent}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {recent.map((r) => (
                  <button
                    key={r}
                    onClick={() => {
                      setQuery(r);
                      setActive(0);
                    }}
                    style={{
                      border: "1px solid var(--aurora-border)",
                      background: "var(--aurora-surface-solid)",
                      borderRadius: 999,
                      padding: "4px 10px",
                      fontSize: 12,
                      color: "var(--aurora-fg2)",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <Icon name="clock" size={11} style={{ opacity: 0.6 }} />
                    {r}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tier 1: 快捷动作 Actions */}
          {matchingActions.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--aurora-fg4)",
                  padding: "8px 18px 4px 18px",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                {isZh ? "快捷动作 · Actions" : "Actions"}
              </div>
              {matchingActions.map((action) => {
                const idx = runningFlatIndex++;
                const isSelected = active === idx;
                return (
                  <div
                    key={action.id}
                    data-flat-idx={idx}
                    onClick={action.run}
                    onMouseEnter={() => setActive(idx)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "9px 18px",
                      cursor: "pointer",
                      background: isSelected ? "var(--aurora-accent-soft)" : "transparent",
                      transition: "background 0.1s ease",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: isSelected ? "var(--aurora-accent)" : "var(--aurora-chip)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        color: isSelected ? "#fff" : "var(--aurora-fg2)",
                        transition: "all 0.12s ease",
                      }}
                    >
                      <Icon name={action.icon as any} size={15} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, color: "var(--aurora-fg1)", fontWeight: 500 }} className="truncate">
                        {action.title}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--aurora-fg4)" }} className="truncate">
                        {action.subtitle}
                      </div>
                    </div>
                    {action.badge && (
                      <span
                        style={{
                          fontSize: 11,
                          padding: "2px 7px",
                          borderRadius: 6,
                          background: "var(--aurora-surface)",
                          border: "1px solid var(--aurora-border)",
                          color: "var(--aurora-fg3)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {action.badge}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Tier 2: 快捷直达 Jump to */}
          {matchingJumps.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--aurora-fg4)",
                  padding: "8px 18px 4px 18px",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                {isZh ? "快捷直达 · Jump to" : "Jump to"}
              </div>
              {matchingJumps.map((jump) => {
                const idx = runningFlatIndex++;
                const isSelected = active === idx;
                return (
                  <div
                    key={jump.id}
                    data-flat-idx={idx}
                    onClick={jump.run}
                    onMouseEnter={() => setActive(idx)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "9px 18px",
                      cursor: "pointer",
                      background: isSelected ? "var(--aurora-accent-soft)" : "transparent",
                      transition: "background 0.1s ease",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: isSelected ? "var(--aurora-accent)" : "var(--aurora-chip)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        color: isSelected ? "#fff" : "var(--aurora-fg2)",
                        transition: "all 0.12s ease",
                      }}
                    >
                      <Icon name={jump.icon as any} size={15} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, color: "var(--aurora-fg1)", fontWeight: 500 }} className="truncate">
                        {jump.title}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--aurora-fg4)" }} className="truncate">
                        {jump.subtitle}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 7px",
                        borderRadius: 6,
                        background: "var(--aurora-surface)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg4)",
                        fontFamily: "monospace",
                      }}
                    >
                      {jump.badge}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Ask AI Prompt Card (when query typed) */}
          {cleanQ && (
            <div style={{ margin: "4px 0 8px 0" }}>
              {(() => {
                const idx = runningFlatIndex++;
                const isSelected = active === idx;
                return (
                  <div
                    data-flat-idx={idx}
                    onClick={() => go(`/ask?q=${encodeURIComponent(query.trim())}`)}
                    onMouseEnter={() => setActive(idx)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "11px 18px",
                      cursor: "pointer",
                      background: isSelected ? "rgba(124, 58, 237, 0.16)" : "rgba(124, 58, 237, 0.08)",
                      borderTop: "1px solid var(--aurora-border)",
                      borderBottom: "1px solid var(--aurora-border)",
                      transition: "background .12s",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: "var(--aurora-brand-grad)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        boxShadow: "0 2px 8px -1px rgba(124,58,237,0.4)",
                      }}
                    >
                      <Icon name="sparkles" size={14} style={{ color: "#fff" }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, color: "var(--aurora-fg1)", fontWeight: 500 }} className="truncate">
                        {isZh ? "向 AI 执事提问：" : "Ask AI Deacon: "}
                        <span style={{ color: "var(--aurora-brand-from)" }}>"{query.trim()}"</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--aurora-fg4)" }}>
                        {isZh ? "结合多智能体与记忆库进行心领神会与深度推理" : "Reason with core memories and multi-agent context"}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 6,
                        background: "var(--aurora-surface)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isZh ? "问记忆 ↵" : "Ask ↵"}
                    </span>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Tier 3: 语义与文档历史搜索 Hits */}
          {hits.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--aurora-fg4)",
                  padding: "8px 18px 4px 18px",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                {isZh ? "文档与会话记忆 · Search Results" : "Documents & Memories"}
              </div>
              {hits.map((h) => {
                const idx = runningFlatIndex++;
                const isSelected = active === idx;
                return (
                  <div
                    key={h.id}
                    data-flat-idx={idx}
                    onClick={() => go(`/documents/${h.id}`)}
                    onMouseEnter={() => setActive(idx)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      padding: "9px 18px",
                      cursor: "pointer",
                      background: isSelected ? "var(--aurora-accent-soft)" : "transparent",
                    }}
                  >
                    <ToolGlyph id={h.tool_id} size={22} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          color: "var(--aurora-fg1)",
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h.title || h.relative_path}
                      </div>
                      {h.snippet && (
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--aurora-fg3)",
                            lineHeight: 1.5,
                            maxHeight: 34,
                            overflow: "hidden",
                          }}
                        >
                          {h.snippet.slice(0, 160)}
                        </div>
                      )}
                    </div>
                    {h.matched_semantically && (
                      <span
                        title={isZh ? "向量语义召回" : "Semantic vector match"}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 10.5,
                          color: "var(--aurora-accent)",
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "var(--aurora-accent-soft)",
                          marginTop: 2,
                        }}
                      >
                        <Icon name="sparkles" size={11} />
                        {isZh ? "语义" : "Vector"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* No results banner */}
          {cleanQ && !loading && hits.length === 0 && matchingActions.length === 0 && matchingJumps.length === 0 && (
            <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 13, color: "var(--aurora-fg4)" }}>
              {t.palette.noResults}
            </div>
          )}

          {/* View all search results footer */}
          {cleanQ && (hits.length > 0 || matchingActions.length + matchingJumps.length > 0) && (
            (() => {
              const idx = runningFlatIndex++;
              const isSelected = active === idx;
              return (
                <div
                  data-flat-idx={idx}
                  onClick={() => go(`/ask?q=${encodeURIComponent(query.trim())}`)}
                  onMouseEnter={() => setActive(idx)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 18px",
                    cursor: "pointer",
                    borderTop: "1px solid var(--aurora-border)",
                    fontSize: 12.5,
                    color: "var(--aurora-fg2)",
                    background: isSelected ? "var(--aurora-accent-soft)" : "transparent",
                  }}
                >
                  <Icon name="grid" size={13} />
                  {t.palette.viewAll}
                </div>
              );
            })()
          )}
        </div>

        {/* Footer shortcuts helper */}
        <div
          style={{
            padding: "9px 18px",
            borderTop: "1px solid var(--aurora-border)",
            fontSize: 11,
            color: "var(--aurora-fg4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>{t.palette.hint}</span>
          <span style={{ opacity: 0.7 }}>Raycast 风格分层指令中心 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
