"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getApiBase, authFetch, api, type ProfileState } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Glass, GhostInput, Chip } from "@/components/aurora/primitives";
import { ShareModal } from "@/components/ShareModal";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import DreamingPanel from "@/components/memory/DreamingPanel";
import CognitiveCompass from "@/components/memory/CognitiveCompass";
import type { GalaxyNode, GalaxyEdge } from "@/components/memory/MemoryGalaxy3D";

const MemoryGalaxy3D = dynamic(
  () => import("@/components/memory/MemoryGalaxy3D"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full rounded-3xl bg-[var(--aurora-surface)] border border-[var(--aurora-border)] animate-pulse flex flex-col items-center justify-center gap-3 text-xs text-[var(--aurora-fg3)]">
        <div className="w-10 h-10 rounded-2xl bg-[var(--aurora-accent)]/20 animate-spin border-2 border-transparent border-t-[var(--aurora-accent)]" />
        <span className="font-mono">正在载入 3D 认知星云中枢...</span>
      </div>
    ),
  }
);

interface MemoryStats {
  entities: number;
  relations: number;
  observations: number;
  embeddings: number;
  entity_types: Record<string, number>;
}

interface EntityDetail {
  id: string;
  name: string;
  type: string;
  summary: string | null;
  observations: { content: string; observed_at: string | null }[];
  outgoing_relations: { target_name: string; target_type: string; relation: string; target_id?: string }[];
  incoming_relations: { source_name: string; source_type: string; relation: string; source_id?: string }[];
}

interface MemoryTreeNode {
  id: string;
  name: string;
  title?: string;
  category: string;
  tree_path: string;
  is_folder: boolean;
  key?: string;
  content?: string;
  confidence?: number;
  source?: string;
  children?: MemoryTreeNode[];
}

const TYPE_COLORS: Record<string, string> = {
  project: "#10B981",
  technology: "#38BDF8",
  concept: "#A855F7",
  tool: "#F59E0B",
  rule: "#EF4444",
  person: "#EC4899",
  default: "#94A3B8",
};

const CATEGORY_COLORS: Record<string, string> = {
  project: "#10b981",
  architecture: "#38bdf8",
  rule: "#ef4444",
  rules: "#ef4444",
  tools: "#f59e0b",
  tool: "#f59e0b",
  preference: "#a855f7",
  general: "#64748b",
};

interface SearchResult {
  name: string;
  entity_type?: string;
  type?: string;
  summary?: string | null;
  content?: string;
}

export default function MemoryPage() {
  const { t } = useI18n();

  // Navigation tab for Right Wing
  const [activeTab, setActiveTab] = useState<"tree" | "entity" | "dreaming" | "search" | "markdown">("tree");

  // Profile & stats
  const [profileState, setProfileState] = useState<ProfileState | null>(null);
  const [stats, setStats] = useState<MemoryStats | null>(null);

  // 3D Galaxy Graph State
  const [nodes, setNodes] = useState<GalaxyNode[]>([]);
  const [edges, setEdges] = useState<GalaxyEdge[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<EntityDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>("");
  const [dreamingActive, setDreamingActive] = useState<boolean>(false);

  // Core Memory Tree State
  const [memoryTree, setMemoryTree] = useState<MemoryTreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeFilter, setTreeFilter] = useState("");
  const [selectedDimension, setSelectedDimension] = useState<string | null>(null);
  const [isTreeLoading, setIsTreeLoading] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Markdown Document State
  const [markdownContent, setMarkdownContent] = useState("");
  const [isMarkdownLoading, setIsMarkdownLoading] = useState(false);

  // Search State
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Share & Notice
  const [shareOpen, setShareOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Fullscreen Theater & Panel Collapse State (Default: True for 100% 3D Cognitive Nebula)
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(true);
  const cockpitRef = useRef<HTMLDivElement>(null);

  const togglePhysicalFullscreen = () => {
    if (!document.fullscreenElement) {
      cockpitRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  // 1. Load Tree Data
  const loadMemoryTree = useCallback(async () => {
    setIsTreeLoading(true);
    try {
      const param = selectedDimension ? `?category=${selectedDimension}` : "";
      const res = await authFetch(`${getApiBase()}/api/memory/core/tree${param}`);
      const data = await res.json();
      const tree: MemoryTreeNode[] = data.tree || [];
      setMemoryTree(tree);
      const paths = new Set<string>();
      tree.forEach((r) => {
        if (r.tree_path) paths.add(r.tree_path);
        r.children?.forEach((c) => {
          if (c.tree_path) paths.add(c.tree_path);
        });
      });
      setExpandedPaths(paths);
    } catch {
      // ignore
    } finally {
      setIsTreeLoading(false);
    }
  }, [selectedDimension]);

  // 2. Load Graph Data
  const loadGraph = useCallback(async () => {
    try {
      const params = filterType ? `?entity_type=${filterType}&limit=200` : "?limit=200";
      const res = await authFetch(`${getApiBase()}/api/memory/graph${params}`);
      const data = await res.json();
      const graphNodes: GalaxyNode[] = (data.nodes || []).map((n: GalaxyNode) => ({
        id: String(n.id),
        name: n.name || "未命名节点",
        type: n.type || "default",
        summary: n.summary || null,
      }));
      const graphEdges: GalaxyEdge[] = (data.edges || []).map((e: GalaxyEdge) => ({
        source: String(e.source),
        target: String(e.target),
        type: e.type || "relates_to",
        strength: typeof e.strength === "number" ? e.strength : 1,
      }));
      setNodes(graphNodes);
      setEdges(graphEdges);
    } catch {
      // ignore
    }
  }, [filterType]);

  // 3. Load Markdown
  const loadMemoryMarkdown = useCallback(async () => {
    setIsMarkdownLoading(true);
    try {
      const res = await authFetch(`${getApiBase()}/api/memory/core/markdown`);
      const data = await res.json();
      setMarkdownContent(data.markdown || data || "");
    } catch {
      setMarkdownContent("未能获取 MEMORY.md 全文");
    } finally {
      setIsMarkdownLoading(false);
    }
  }, []);

  // 4. Initial Mount
  useEffect(() => {
    authFetch(`${getApiBase()}/api/memory/stats`).then((r) => r.json()).then(setStats).catch(() => {});
    api.getProfile().then(setProfileState).catch(() => {});
    loadMemoryTree();
    loadGraph();
    loadMemoryMarkdown();
  }, [loadGraph, loadMemoryTree, loadMemoryMarkdown]);

  // 5. Select & Fetch Entity Detail
  const handleSelectNode = async (node: GalaxyNode | null) => {
    if (!node) {
      setSelectedNodeId(null);
      setSelectedEntity(null);
      return;
    }
    setSelectedNodeId(node.id);
    try {
      const resp = await authFetch(`${getApiBase()}/api/memory/entities/${node.id}`);
      const detail: EntityDetail = await resp.json();
      setSelectedEntity(detail);
      setActiveTab("entity");
    } catch {
      setSelectedEntity({
        id: node.id,
        name: node.name,
        type: node.type,
        summary: node.summary,
        observations: [],
        outgoing_relations: [],
        incoming_relations: [],
      });
      setActiveTab("entity");
    }
  };

  // Jump from right-wing relation or search into node
  const handleJumpToEntity = async (entityIdOrName: string) => {
    // Try matching node in current galaxy
    const targetNode = nodes.find(
      (n) => n.id === entityIdOrName || n.name.toLowerCase() === entityIdOrName.toLowerCase()
    );
    if (targetNode) {
      handleSelectNode(targetNode);
    } else {
      try {
        const resp = await authFetch(`${getApiBase()}/api/memory/entities/${entityIdOrName}`);
        const detail: EntityDetail = await resp.json();
        setSelectedEntity(detail);
        setSelectedNodeId(detail.id);
        setActiveTab("entity");
      } catch {
        // ignore
      }
    }
  };

  // 6. Tree Path helpers
  const togglePath = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const copyPath = (path: string) => {
    navigator.clipboard.writeText(path);
    setCopyFeedback(path);
    setTimeout(() => setCopyFeedback(null), 1500);
  };

  // Filter tree
  const filterTree = (treeNodes: MemoryTreeNode[], q: string): MemoryTreeNode[] => {
    if (!q) return treeNodes;
    const query = q.toLowerCase().trim();
    const result: MemoryTreeNode[] = [];

    for (const node of treeNodes) {
      const name = (node.name || "").toLowerCase();
      const title = (node.title || "").toLowerCase();
      const key = (node.key || "").toLowerCase();
      const content = (node.content || "").toLowerCase();
      const treePath = (node.tree_path || "").toLowerCase();

      const selfMatches = name.includes(query) || title.includes(query) || key.includes(query) || content.includes(query) || treePath.includes(query);

      if (node.is_folder) {
        const filteredChildren = filterTree(node.children || [], q);
        if (selfMatches || filteredChildren.length > 0) {
          result.push({
            ...node,
            children: filteredChildren.length > 0 ? filteredChildren : node.children,
          });
        }
      } else if (selfMatches) {
        result.push(node);
      }
    }
    return result;
  };

  const countLeaves = (node: MemoryTreeNode): number => {
    if (!node.is_folder) return 1;
    let sum = 0;
    for (const c of node.children || []) {
      sum += countLeaves(c);
    }
    return sum;
  };

  const effectiveTree = filterTree(memoryTree, treeFilter);
  const totalLeaves = useMemo(() => effectiveTree.reduce((acc, n) => acc + countLeaves(n), 0), [effectiveTree]);

  // 7. Search Handler
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const resp = await authFetch(`${getApiBase()}/api/memory/search?q=${encodeURIComponent(searchQuery)}`);
      setSearchResults(await resp.json());
      setActiveTab("search");
    } catch {
      // ignore
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="h-[calc(100dvh-68px)] max-h-[calc(100dvh-68px)] flex flex-col gap-2 overflow-hidden">
      {/* ─────────────────────────────────────────────────────────────
          1. 统一顶栏 (Ultra-Refined Single-Row Cockpit Header)
          ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 pb-1 border-b border-[var(--aurora-border)] shrink-0 flex-wrap sm:flex-nowrap">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-xl flex items-center justify-center bg-[rgba(56,189,248,0.12)] text-[#38BDF8] shadow-xs shrink-0">
            <Icon name="layers" size={16} />
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            <h1 className="text-xs sm:text-base font-bold text-[var(--aurora-fg1)] tracking-tight truncate">
              长期记忆 · 认知星云
            </h1>
            <span className="text-[10px] px-2 py-0.2 rounded-full font-medium bg-[rgba(16,185,129,0.12)] text-[#10B981] hidden md:flex items-center gap-1 font-mono shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] breathing-glow-emerald" />
              {nodes.length || stats?.entities || 42} 实体 · {edges.length || stats?.relations || 86} 突触
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              setActiveTab("dreaming");
              setNotice("已就绪夜间梦境控制台，可手动唤醒记忆深度蒸馏提炼");
            }}
            className="px-2.5 py-1 rounded-xl text-xs font-medium text-[var(--aurora-fg2)] bg-[var(--aurora-surface-solid)] hover:bg-[var(--aurora-chip)] border border-[var(--aurora-border)] flex items-center gap-1.5 transition-all shadow-2xs"
          >
            <span className="text-amber-400">🌙</span>
            <span>梦境提炼</span>
          </button>
          <button
            onClick={() => setActiveTab("markdown")}
            className="px-2.5 py-1 rounded-xl text-xs font-medium text-[var(--aurora-fg2)] bg-[var(--aurora-surface-solid)] hover:bg-[var(--aurora-chip)] border border-[var(--aurora-border)] flex items-center gap-1.5 transition-all shadow-2xs"
          >
            <Icon name="file_text" size={12} />
            <span>MEMORY.md</span>
          </button>
          <Btn
            variant="glass"
            size="sm"
            icon="external_link"
            onClick={() => setShareOpen(true)}
          >
            分享星云
          </Btn>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          Cognitive Compass Compact Header Bar (36px Height)
          ───────────────────────────────────────────────────────────── */}
      <div className="shrink-0">
        <CognitiveCompass
          currentTab="memory"
          variant="compact"
          summaryStats={{
            memoryCount: totalLeaves || 39,
            syncedTargetsCount: 5,
          }}
        />
      </div>

      {notice && (
        <Glass padding={8} radius={10} className="shrink-0" style={{ color: "var(--aurora-fg2)", fontSize: 11 }}>
          <div className="flex items-center justify-between">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)]">
              <Icon name="close" size={10} />
            </button>
          </div>
        </Glass>
      )}

      {/* ─────────────────────────────────────────────────────────────
          2. 一屏全景双翼驾驶舱 (Unified Single-Screen Twin Cockpit)
          ───────────────────────────────────────────────────────────── */}
      <div ref={cockpitRef} className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-0 overflow-hidden relative">
        {/* ── 左翼: 3D 认知星云主舞台 (支持 100% 满屏沉浸与分屏联动) ── */}
        <div className={`h-full flex flex-col min-h-0 relative rounded-3xl overflow-hidden border border-[var(--aurora-border)] bg-[var(--aurora-surface)] shadow-xl transition-all duration-300 ${
          isPanelCollapsed ? "lg:col-span-12 w-full" : "lg:col-span-5"
        }`}>
          <MemoryGalaxy3D
            nodes={nodes}
            edges={edges}
            selectedNodeId={selectedNodeId}
            onSelectNode={handleSelectNode}
            filterType={filterType}
            onFilterChange={setFilterType}
            dreamingActive={dreamingActive}
            isPanelCollapsed={isPanelCollapsed}
            onToggleCollapse={() => setIsPanelCollapsed(!isPanelCollapsed)}
            onToggleFullscreen={togglePhysicalFullscreen}
            isPaused={!isPanelCollapsed}
            className="w-full h-full"
          />

          {/* ── 3D 场景内全息实体详情视窗 (In-Scene 3D Holographic Inspector) ── */}
          {selectedEntity ? (
            <>
              {/* Mobile Backdrop to prevent touch bleed */}
              <div
                onClick={() => handleSelectNode(null)}
                className="sm:hidden absolute inset-0 z-25 bg-black/60 backdrop-blur-xs animate-in fade-in"
              />
              <div
                onTouchStart={(e) => e.stopPropagation()}
                className="absolute z-30 max-sm:inset-x-2 max-sm:bottom-2 max-sm:max-h-[70vh] sm:top-14 sm:right-3 sm:bottom-3 sm:w-[380px] xl:w-[440px] rounded-2xl bg-black/90 backdrop-blur-2xl border border-white/20 shadow-2xl flex flex-col overflow-hidden animate-in fade-in max-sm:slide-in-from-bottom-6 sm:slide-in-from-right-4 duration-300 pointer-events-auto"
              >
                {/* Mobile Drag Handle */}
                <div className="w-10 h-1 rounded-full bg-white/25 mx-auto my-1.5 sm:hidden shrink-0" />

              {/* 视窗 Header */}
              <div className="p-3 bg-white/5 border-b border-white/10 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 min-w-0 pr-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0 shadow-xs"
                    style={{ backgroundColor: TYPE_COLORS[selectedEntity.type] || "#38BDF8" }}
                  />
                  <h3 className="text-xs sm:text-sm font-bold text-white font-mono truncate">
                    {selectedEntity.name}
                  </h3>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/10 text-white/80 shrink-0">
                    {selectedEntity.type}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleSelectNode(null)}
                    className="p-1 rounded-xl bg-white/10 text-white/60 hover:text-white hover:bg-white/20 transition-all"
                    title="关闭全息详情"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              </div>

              {/* 视窗 Body: 知识摘要、突触关联与观察记录 */}
              <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0 scrollbar-thin text-xs">
                {/* 知识摘要 */}
                {selectedEntity.summary && (
                  <div className="p-2.5 rounded-xl bg-white/5 border border-white/10 text-white/80 leading-relaxed text-xs">
                    {selectedEntity.summary}
                  </div>
                )}

                {/* 突触拓扑互联 (Outgoing) */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-bold text-white/70">
                    <span>指向关联突触 (Outgoing)</span>
                    <span className="text-[10px] font-mono text-white/40">
                      {selectedEntity.outgoing_relations.length} 条
                    </span>
                  </div>
                  {selectedEntity.outgoing_relations.length === 0 ? (
                    <div className="text-[10px] text-white/40 py-1 pl-1">暂无主动突触</div>
                  ) : (
                    <div className="space-y-1">
                      {selectedEntity.outgoing_relations.map((rel, idx) => (
                        <div
                          key={idx}
                          onClick={() => handleJumpToEntity(rel.target_name)}
                          className="p-2 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 cursor-pointer transition-all flex items-center justify-between group"
                          title="在 3D 场景中飞跃对焦该星晶"
                        >
                          <div className="flex items-center gap-1.5 truncate">
                            <span className="text-[10px] font-mono text-[#38BDF8] shrink-0">
                              --[{rel.relation}]--&gt;
                            </span>
                            <span className="font-semibold text-white group-hover:text-[#38BDF8] truncate">
                              {rel.target_name}
                            </span>
                          </div>
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white/10 text-white/60 shrink-0">
                            {rel.target_type}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 突触拓扑互联 (Incoming) */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-bold text-white/70">
                    <span>被指关联突触 (Incoming)</span>
                    <span className="text-[10px] font-mono text-white/40">
                      {selectedEntity.incoming_relations.length} 条
                    </span>
                  </div>
                  {selectedEntity.incoming_relations.length === 0 ? (
                    <div className="text-[10px] text-white/40 py-1 pl-1">暂无被指突触</div>
                  ) : (
                    <div className="space-y-1">
                      {selectedEntity.incoming_relations.map((rel, idx) => (
                        <div
                          key={idx}
                          onClick={() => handleJumpToEntity(rel.source_name)}
                          className="p-2 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 cursor-pointer transition-all flex items-center justify-between group"
                          title="在 3D 场景中飞跃对焦该星晶"
                        >
                          <div className="flex items-center gap-1.5 truncate">
                            <span className="font-semibold text-white group-hover:text-[#38BDF8] truncate">
                              {rel.source_name}
                            </span>
                            <span className="text-[10px] font-mono text-[#38BDF8] shrink-0">
                              --[{rel.relation}]--&gt;
                            </span>
                          </div>
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white/10 text-white/60 shrink-0">
                            {rel.source_type}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 历史会话真实观察记录 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-bold text-white/70">
                    <span>历史会话真实观察记录</span>
                    <span className="text-[10px] font-mono text-white/40">
                      {selectedEntity.observations.length} 条
                    </span>
                  </div>
                  {selectedEntity.observations.length === 0 ? (
                    <div className="text-[10px] text-white/40 py-1 pl-1">
                      暂无底层观察沉淀，该星晶由准则系统直接定义
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {selectedEntity.observations.map((obs, i) => (
                        <div
                          key={i}
                          className="p-2 rounded-xl bg-white/5 border border-white/10 text-[11px] text-white/80 leading-relaxed space-y-1"
                        >
                          <p>{obs.content}</p>
                          {obs.observed_at && (
                            <div className="text-[9px] font-mono text-white/40 text-right">
                              {new Date(obs.observed_at).toLocaleString()}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 视窗 Footer 操作栏 */}
              <div className="p-2.5 bg-white/5 border-t border-white/10 flex items-center justify-between shrink-0 text-[11px] font-mono">
                <span className="text-white/40">知识星晶已锁定 · 突触双向飞跃</span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(selectedEntity.name);
                      setNotice(`已复制实体名称「${selectedEntity.name}」到剪贴板`);
                    }}
                    className="px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white/80 transition-all flex items-center gap-1"
                    title="复制实体名称"
                  >
                    <Icon name="copy" size={10} />
                    <span>复制</span>
                  </button>
                  <button
                    onClick={() => {
                      setIsPanelCollapsed(false);
                      setActiveTab("entity");
                    }}
                    className="px-2 py-1 rounded-lg bg-[var(--aurora-accent)] text-white hover:opacity-90 transition-all flex items-center gap-1 shadow-sm"
                    title="展开右侧完整管理面板"
                  >
                    <Icon name="edit" size={10} />
                    <span>侧边面板</span>
                  </button>
                </div>
              </div>
            </div>
            </>
          ) : (
            <div className="absolute bottom-3 left-3 right-3 pointer-events-none text-center">
              <span className="text-[10px] font-mono text-white/50 bg-black/40 backdrop-blur-xs px-3 py-1 rounded-full border border-white/10 pointer-events-auto">
                按住左键 360° 旋转 · 滚轮缩放 · 点击星晶在 3D 页面直接展开全息详情
              </span>
            </div>
          )}
        </div>

        {/* ── 右翼 (7 列 / 58%): 知识准则树、拓扑与梦境提炼中枢 (移动端自适应全屏抽屉，桌面端双翼分屏) ── */}
        {!isPanelCollapsed && (
          <div className="max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:rounded-none max-lg:border-none lg:col-span-7 h-full flex flex-col min-h-0 bg-[var(--aurora-surface)] rounded-3xl border border-[var(--aurora-border)] shadow-2xl overflow-hidden animate-in fade-in max-lg:slide-in-from-bottom-6 duration-300">
            {/* A. 顶部仪表盘概览与 Tab 导航区 (Sticky Header) */}
            <div className="p-3 bg-gradient-to-r from-[var(--aurora-surface-solid)] via-[var(--aurora-surface)] to-[var(--aurora-chip)] border-b border-[var(--aurora-border)] shrink-0 space-y-2.5">
              {/* Mobile Back Button to 3D */}
              <div className="flex items-center justify-between lg:hidden pb-1 border-b border-white/10">
                <button
                  onClick={() => setIsPanelCollapsed(true)}
                  className="px-2.5 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-semibold flex items-center gap-1.5 shrink-0 text-white"
                >
                  <Icon name="arrow_left" size={14} />
                  <span>返回 3D 认知舞台</span>
                </button>
                <span className="text-[11px] font-mono text-white/50">知识准则管理中枢</span>
              </div>
              {/* 三列高级 KPI 态势磁贴 */}
              <div className="grid grid-cols-3 gap-2">
                {/* Tile 1: 知识准则条数 */}
                <div className="p-2 rounded-xl bg-[var(--aurora-surface)]/80 border border-[var(--aurora-border)] flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-[var(--aurora-fg4)]">长效准则库</div>
                    <div className="text-xs font-bold text-[#10B981] font-mono mt-0.5">
                      {totalLeaves || 39} <span className="text-[10px] font-normal text-[var(--aurora-fg3)]">条</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[rgba(16,185,129,0.1)] text-[#10B981]">
                      分层索引
                    </span>
                  </div>
                </div>

                {/* Tile 2: 星云实体规模 */}
                <div className="p-2 rounded-xl bg-[var(--aurora-surface)]/80 border border-[var(--aurora-border)] flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-[var(--aurora-fg4)]">知识星晶实体</div>
                    <div className="text-xs font-bold text-[#38BDF8] font-mono mt-0.5">
                      {nodes.length || stats?.entities || 42} <span className="text-[10px] font-normal text-[var(--aurora-fg3)]">星晶</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[rgba(56,189,248,0.1)] text-[#38BDF8]">
                      {edges.length || stats?.relations || 86} 突触
                    </span>
                  </div>
                </div>

                {/* Tile 3: 梦境蒸馏进化 */}
                <div className="p-2 rounded-xl bg-[var(--aurora-surface)]/80 border border-[var(--aurora-border)] flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-[var(--aurora-fg4)]">夜间梦境提炼</div>
                    <div className="text-xs font-bold text-[#A855F7] font-mono mt-0.5">
                      持续蒸馏 <span className="text-[10px] font-normal text-[var(--aurora-fg3)]">就绪</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[rgba(168,85,247,0.1)] text-[#A855F7]">
                      去重合并
                    </span>
                  </div>
                </div>
              </div>

              {/* Navigation Tabs Bar with Collapse Action */}
              <div className="flex items-center justify-between gap-2 overflow-x-auto pb-0.5">
                <div className="flex items-center gap-1.5">
                  {[
                    { id: "tree", label: `🌳 知识准则树 (${totalLeaves || 39})`, color: "#10B981" },
                    { id: "entity", label: `🌌 实体拓扑 ${selectedEntity ? `· ${selectedEntity.name}` : ""}`, color: "#38BDF8" },
                    { id: "dreaming", label: "🌙 梦境夜间提炼", color: "#A855F7" },
                    { id: "search", label: "🔍 认知检索", color: "#F59E0B" },
                    { id: "markdown", label: "📜 MEMORY.md", color: "#64748B" },
                  ].map((tb) => (
                    <button
                      key={tb.id}
                      onClick={() => setActiveTab(tb.id as typeof activeTab)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all border ${
                        activeTab === tb.id
                          ? "bg-[var(--aurora-surface-solid)] text-[var(--aurora-fg1)] border-[var(--aurora-border-strong)] shadow-xs font-bold"
                          : "border-transparent text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-surface-solid)]/60"
                      }`}
                    >
                      {tb.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Sub Search or Action */}
                  {activeTab === "tree" && (
                    <div className="relative w-36 shrink-0">
                      <input
                        type="text"
                        value={treeFilter}
                        onChange={(e) => setTreeFilter(e.target.value)}
                        placeholder="过滤准则分支..."
                        className="w-full pl-6 pr-2 py-0.8 text-[11px] rounded-lg bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] text-[var(--aurora-fg1)] placeholder-[var(--aurora-fg4)] focus:outline-hidden focus:border-[var(--aurora-accent)]"
                      />
                      <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--aurora-fg4)]">
                        <Icon name="search" size={10} />
                      </span>
                      {treeFilter && (
                        <button
                          onClick={() => setTreeFilter("")}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)]"
                        >
                          <Icon name="close" size={9} />
                        </button>
                      )}
                    </div>
                  )}

                  {/* 收起面板让 3D 铺满全屏按钮 */}
                  <button
                    onClick={() => setIsPanelCollapsed(true)}
                    className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] border border-[var(--aurora-border)] transition-all shadow-2xs"
                    title="收起右侧面板，3D 星云铺满全屏"
                  >
                    <Icon name="sidebar" size={13} />
                  </button>
                </div>
              </div>

            {/* Tree Dimension HUD Filter Bar */}
            {activeTab === "tree" && (
              <div className="flex items-center gap-1.5 overflow-x-auto pt-1 border-t border-[var(--aurora-border)]/60 text-[10px]">
                {[
                  { id: null, label: "全部维度", color: "var(--aurora-fg2)" },
                  { id: "project", label: "核心工程", color: "#10b981" },
                  { id: "architecture", label: "架构决策", color: "#38bdf8" },
                  { id: "rules", label: "工程铁律", color: "#f59e0b" },
                  { id: "tools", label: "工具中台", color: "#fb923c" },
                  { id: "preference", label: "偏好习惯", color: "#a855f7" },
                ].map((dim) => {
                  const selected = selectedDimension === dim.id;
                  return (
                    <button
                      key={dim.id ?? "all"}
                      onClick={() => setSelectedDimension(selected ? null : dim.id)}
                      style={{
                        borderColor: selected ? dim.color : "var(--aurora-border)",
                        backgroundColor: selected ? `${dim.color}22` : "var(--aurora-surface-solid)",
                      }}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md border font-medium whitespace-nowrap transition-all hover:border-[var(--aurora-border-strong)]"
                    >
                      <span style={{ color: dim.color }}>●</span>
                      <span style={{ color: selected ? "var(--aurora-fg1)" : "var(--aurora-fg3)" }}>
                        {dim.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* B. 内容滚动主视口 (Smooth Inner Scroll Container) */}
          <div className="flex-1 overflow-y-auto p-3.5 space-y-3 min-h-0 scrollbar-thin">
            {/* ── TAB 1: 知识准则树 (Tree View) ── */}
            {activeTab === "tree" && (
              <div className="space-y-2 animate-in fade-in">
                {isTreeLoading ? (
                  <div className="p-8 text-center text-xs text-[var(--aurora-fg3)] flex flex-col items-center justify-center gap-2">
                    <div className="w-5 h-5 rounded-full border-2 border-transparent border-t-[var(--aurora-accent)] animate-spin" />
                    <span>正在索引知识准则分层树...</span>
                  </div>
                ) : effectiveTree.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[var(--aurora-fg4)] bg-[var(--aurora-surface-solid)] rounded-2xl border border-[var(--aurora-border)]">
                    未检索到符合条件的准则分支
                  </div>
                ) : (
                  effectiveTree.map((rootNode) => (
                    <div
                      key={rootNode.id}
                      className="rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] overflow-hidden shadow-2xs"
                    >
                      {/* Tree Root Category Bar */}
                      <div
                        onClick={() => togglePath(rootNode.tree_path)}
                        className="px-3.5 py-2.5 bg-[var(--aurora-chip)]/40 hover:bg-[var(--aurora-chip)] flex items-center justify-between cursor-pointer transition-all border-b border-[var(--aurora-border)]/60"
                      >
                        <div className="flex items-center gap-2">
                          <Icon
                            name={expandedPaths.has(rootNode.tree_path) ? "chevron_down" : "chevron_right"}
                            size={12}
                            className="text-[var(--aurora-fg3)]"
                          />
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: CATEGORY_COLORS[rootNode.category] || "#64748B" }}
                          />
                          <span className="text-xs font-bold text-[var(--aurora-fg1)] font-mono">
                            {rootNode.title || rootNode.name}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-[var(--aurora-surface-solid)] text-[var(--aurora-fg3)] font-mono">
                            {rootNode.tree_path}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-[var(--aurora-fg4)]">
                            {countLeaves(rootNode)} 条准则
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              copyPath(rootNode.tree_path);
                            }}
                            className="text-[10px] text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)]"
                            title="复制路径"
                          >
                            {copyFeedback === rootNode.tree_path ? "已复制" : <Icon name="copy" size={10} />}
                          </button>
                        </div>
                      </div>

                      {/* Tree Node Children */}
                      {expandedPaths.has(rootNode.tree_path) && rootNode.children && (
                        <div className="p-2 space-y-1.5">
                          {rootNode.children.map((child) => (
                            <div
                              key={child.id}
                              onClick={() => {
                                // Double synergy: jump & focus 3D
                                handleJumpToEntity(child.name || child.key || child.tree_path);
                              }}
                              className="p-2 rounded-xl bg-[var(--aurora-surface)] hover:bg-[var(--aurora-chip)]/60 border border-[var(--aurora-border)] cursor-pointer transition-all group flex flex-col justify-between gap-1"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="text-[#38BDF8] text-xs">•</span>
                                  <span className="text-xs font-semibold text-[var(--aurora-fg1)] group-hover:text-[var(--aurora-accent)] transition-colors truncate">
                                    {child.title || child.name}
                                  </span>
                                  {child.key && (
                                    <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-[var(--aurora-chip)] text-[var(--aurora-fg3)] shrink-0">
                                      {child.key}
                                    </span>
                                  )}
                                </div>
                                <span className="text-[9px] font-mono text-[var(--aurora-fg4)] group-hover:text-[var(--aurora-accent)] shrink-0 flex items-center gap-0.5">
                                  <span>对焦星晶</span>
                                  <Icon name="chevron_right" size={9} />
                                </span>
                              </div>

                              {child.content && (
                                <p className="text-[11px] text-[var(--aurora-fg3)] leading-relaxed pl-3 line-clamp-2">
                                  {child.content}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* ── TAB 2: 实体拓扑与突触详情 (Entity Topology View) ── */}
            {activeTab === "entity" && (
              <div className="space-y-3 animate-in fade-in">
                {selectedEntity ? (
                  <div className="space-y-3">
                    {/* Entity Header Banner */}
                    <div className="p-3.5 rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] flex items-start justify-between gap-3 shadow-2xs">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-3 h-3 rounded-full shadow-xs"
                            style={{ backgroundColor: TYPE_COLORS[selectedEntity.type] || "#38BDF8" }}
                          />
                          <h2 className="text-sm font-bold text-[var(--aurora-fg1)] font-mono">
                            {selectedEntity.name}
                          </h2>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[var(--aurora-chip)] text-[var(--aurora-fg2)] font-semibold">
                            {selectedEntity.type}
                          </span>
                        </div>
                        <p className="text-xs text-[var(--aurora-fg3)] leading-relaxed">
                          {selectedEntity.summary || "暂无摘要，已建立跨终端记忆索引"}
                        </p>
                      </div>
                      <button
                        onClick={() => handleSelectNode(null)}
                        className="text-xs text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)] flex items-center gap-1 shrink-0"
                      >
                        <Icon name="close" size={11} />
                        <span>返回实体列表</span>
                      </button>
                    </div>

                    {/* Relations Grid: Outgoing & Incoming Synapses */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      {/* Outgoing Relations */}
                      <div className="p-3 rounded-2xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] space-y-2">
                        <div className="flex items-center justify-between text-xs font-bold text-[var(--aurora-fg2)]">
                          <span>指向关联 (Outgoing)</span>
                          <span className="text-[10px] font-mono text-[var(--aurora-fg4)]">
                            {selectedEntity.outgoing_relations.length} 突触
                          </span>
                        </div>
                        {selectedEntity.outgoing_relations.length === 0 ? (
                          <div className="text-[11px] text-[var(--aurora-fg4)] py-2 text-center">暂无主动突触</div>
                        ) : (
                          <div className="space-y-1.5">
                            {selectedEntity.outgoing_relations.map((rel, idx) => (
                              <div
                                key={idx}
                                onClick={() => handleJumpToEntity(rel.target_name)}
                                className="p-2 rounded-xl bg-[var(--aurora-surface)] hover:bg-[var(--aurora-chip)] border border-[var(--aurora-border)] cursor-pointer transition-all flex items-center justify-between text-xs group"
                              >
                                <div className="flex items-center gap-1.5 truncate">
                                  <span className="text-[10px] font-mono text-[var(--aurora-accent)] shrink-0">
                                    --[{rel.relation}]--&gt;
                                  </span>
                                  <span className="font-semibold text-[var(--aurora-fg1)] group-hover:text-[var(--aurora-accent)] truncate">
                                    {rel.target_name}
                                  </span>
                                </div>
                                <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-[var(--aurora-chip)] text-[var(--aurora-fg4)] shrink-0">
                                  {rel.target_type}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Incoming Relations */}
                      <div className="p-3 rounded-2xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] space-y-2">
                        <div className="flex items-center justify-between text-xs font-bold text-[var(--aurora-fg2)]">
                          <span>被指关联 (Incoming)</span>
                          <span className="text-[10px] font-mono text-[var(--aurora-fg4)]">
                            {selectedEntity.incoming_relations.length} 突触
                          </span>
                        </div>
                        {selectedEntity.incoming_relations.length === 0 ? (
                          <div className="text-[11px] text-[var(--aurora-fg4)] py-2 text-center">暂无入向突触</div>
                        ) : (
                          <div className="space-y-1.5">
                            {selectedEntity.incoming_relations.map((rel, idx) => (
                              <div
                                key={idx}
                                onClick={() => handleJumpToEntity(rel.source_name)}
                                className="p-2 rounded-xl bg-[var(--aurora-surface)] hover:bg-[var(--aurora-chip)] border border-[var(--aurora-border)] cursor-pointer transition-all flex items-center justify-between text-xs group"
                              >
                                <div className="flex items-center gap-1.5 truncate">
                                  <span className="font-semibold text-[var(--aurora-fg1)] group-hover:text-[var(--aurora-accent)] truncate">
                                    {rel.source_name}
                                  </span>
                                  <span className="text-[10px] font-mono text-[var(--aurora-accent)] shrink-0">
                                    --[{rel.relation}]--&gt;
                                  </span>
                                </div>
                                <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-[var(--aurora-chip)] text-[var(--aurora-fg4)] shrink-0">
                                  {rel.source_type}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Observations Timeline */}
                    <div className="p-3.5 rounded-2xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] space-y-2.5">
                      <div className="flex items-center justify-between text-xs font-bold text-[var(--aurora-fg1)]">
                        <div className="flex items-center gap-1.5">
                          <Icon name="clock" size={12} className="text-[var(--aurora-accent)]" />
                          <span>历史会话真实观察记录 (Observations)</span>
                        </div>
                        <span className="text-[10px] font-mono text-[var(--aurora-fg4)]">
                          {selectedEntity.observations.length} 条
                        </span>
                      </div>
                      {selectedEntity.observations.length === 0 ? (
                        <div className="text-[11px] text-[var(--aurora-fg4)] py-3 text-center">
                          暂无底层观察沉淀，该实体由系统规则或准则定义派生
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {selectedEntity.observations.map((obs, i) => (
                            <div
                              key={i}
                              className="p-2.5 rounded-xl bg-[var(--aurora-surface)] border border-[var(--aurora-border)] text-xs text-[var(--aurora-fg2)] leading-relaxed space-y-1"
                            >
                              <p>{obs.content}</p>
                              {obs.observed_at && (
                                <div className="text-[10px] font-mono text-[var(--aurora-fg4)] text-right">
                                  {new Date(obs.observed_at).toLocaleString()}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  /* When no entity selected: show all entities grid for quick selection */
                  <div className="space-y-3">
                    <div className="p-3 rounded-2xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] flex items-center justify-between text-xs">
                      <span className="text-[var(--aurora-fg2)] font-medium">
                        全量知识图谱实体列表（点击飞跃对焦 3D 星晶）
                      </span>
                      <span className="text-[10px] font-mono text-[var(--aurora-fg4)]">
                        共 {nodes.length} 个节点
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {nodes.map((node) => (
                        <div
                          key={node.id}
                          onClick={() => handleSelectNode(node)}
                          className="p-2.5 rounded-xl bg-[var(--aurora-surface-solid)] hover:bg-[var(--aurora-chip)] border border-[var(--aurora-border)] hover:border-[var(--aurora-border-strong)] cursor-pointer transition-all flex flex-col justify-between gap-1 group"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 truncate">
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: TYPE_COLORS[node.type] || "#38BDF8" }}
                              />
                              <span className="text-xs font-bold text-[var(--aurora-fg1)] group-hover:text-[var(--aurora-accent)] truncate">
                                {node.name}
                              </span>
                            </div>
                            <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-[var(--aurora-chip)] text-[var(--aurora-fg3)] shrink-0">
                              {node.type}
                            </span>
                          </div>
                          {node.summary && (
                            <p className="text-[11px] text-[var(--aurora-fg4)] line-clamp-1 leading-normal">
                              {node.summary}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── TAB 3: 梦境夜间提炼 (Dreaming Panel) ── */}
            {activeTab === "dreaming" && (
              <div className="space-y-3 animate-in fade-in">
                <div className="p-3 rounded-2xl bg-gradient-to-r from-[rgba(168,85,247,0.12)] via-[var(--aurora-surface-solid)] to-transparent border border-[var(--aurora-border)] flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-base">🌙</span>
                    <div>
                      <div className="text-xs font-bold text-[var(--aurora-fg1)]">
                        记忆梦境提炼 · 深度自进化
                      </div>
                      <div className="text-[10px] text-[var(--aurora-fg4)]">
                        触发时左翼 3D 星云将同步呈现金色引力坍缩与超新星聚变
                      </div>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#A855F7]/15 text-[#A855F7] font-bold">
                    主动唤醒
                  </span>
                </div>
                <DreamingPanel onDreamingChange={(active) => setDreamingActive(active)} />
              </div>
            )}

            {/* ── TAB 4: 向量检索 (Search View) ── */}
            {activeTab === "search" && (
              <div className="space-y-3 animate-in fade-in">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                      placeholder="输入关键词或自然语言语义检索记忆准则与实体..."
                      className="w-full pl-8 pr-3 py-2 text-xs rounded-xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] text-[var(--aurora-fg1)] placeholder-[var(--aurora-fg4)] focus:outline-hidden focus:border-[var(--aurora-accent)]"
                    />
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--aurora-fg4)]">
                      <Icon name="search" size={13} />
                    </span>
                  </div>
                  <Btn size="sm" onClick={handleSearch} disabled={isSearching || !searchQuery.trim()}>
                    {isSearching ? "检索中..." : "检索"}
                  </Btn>
                </div>

                {searchResults.length > 0 ? (
                  <div className="space-y-2">
                    <div className="text-[11px] font-mono text-[var(--aurora-fg4)]">
                      检索到 {searchResults.length} 条相关记忆实体：
                    </div>
                    {searchResults.map((r, i) => (
                      <div
                        key={i}
                        onClick={() => handleJumpToEntity(r.name)}
                        className="p-3 rounded-xl bg-[var(--aurora-surface-solid)] hover:bg-[var(--aurora-chip)] border border-[var(--aurora-border)] cursor-pointer transition-all space-y-1 group"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-[var(--aurora-fg1)] group-hover:text-[var(--aurora-accent)]">
                            {r.name}
                          </span>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--aurora-chip)] text-[var(--aurora-fg3)]">
                            {r.entity_type || r.type || "entity"}
                          </span>
                        </div>
                        {r.summary && (
                          <p className="text-[11px] text-[var(--aurora-fg3)] leading-relaxed">
                            {r.summary}
                          </p>
                        )}
                        {r.content && (
                          <p className="text-[11px] text-[var(--aurora-fg4)] font-mono leading-relaxed bg-[var(--aurora-surface)] p-2 rounded-lg">
                            {r.content}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 text-center text-xs text-[var(--aurora-fg4)] bg-[var(--aurora-surface-solid)] rounded-2xl border border-[var(--aurora-border)]">
                    输入关键字后回车即可在数万条向量化记忆中精准检索
                  </div>
                )}
              </div>
            )}

            {/* ── TAB 5: MEMORY.md 全文原件 (Markdown View) ── */}
            {activeTab === "markdown" && (
              <div className="space-y-3 animate-in fade-in">
                <div className="p-3 rounded-2xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-[var(--aurora-fg1)]">MEMORY.md 全局规范</span>
                    <span className="text-[10px] font-mono text-[var(--aurora-fg4)]">
                      已自动写入本地各大 Agent 工作空间
                    </span>
                  </div>
                  <Btn
                    variant="glass"
                    size="sm"
                    icon="copy"
                    onClick={() => {
                      navigator.clipboard.writeText(markdownContent);
                      setNotice("已复制 MEMORY.md 全文到剪贴板");
                    }}
                  >
                    复制全文
                  </Btn>
                </div>

                <div className="p-4 rounded-2xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)]">
                  {isMarkdownLoading ? (
                    <div className="p-8 text-center text-xs text-[var(--aurora-fg3)]">正在读取 MEMORY.md...</div>
                  ) : (
                    <div className="prose prose-sm max-w-none text-xs leading-relaxed">
                      <MarkdownViewer content={markdownContent} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

        {/* 当处于全屏铺满模式时，右侧边缘浮动的展开业务中枢悬浮岛 */}
        {isPanelCollapsed && (
          <button
            onClick={() => setIsPanelCollapsed(false)}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-30 px-3.5 py-2 rounded-2xl bg-black/80 hover:bg-black/95 backdrop-blur-2xl border border-white/25 text-white shadow-2xl transition-all flex items-center gap-2 group text-xs font-mono animate-in slide-in-from-right duration-300 hover:scale-105"
            title="展开右侧知识准则中枢"
          >
            <Icon name="chevron_left" size={14} className="text-[#38BDF8] group-hover:-translate-x-0.5 transition-transform" />
            <span className="font-semibold tracking-wide">展开控制台</span>
          </button>
        )}
      </div>

      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        kind="memory"
        targetId="all"
        title="分享 3D 认知星云"
      />
    </div>
  );
}
