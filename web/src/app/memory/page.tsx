"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBase, authFetch } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Glass, GhostInput, StatCard, TopBar } from "@/components/aurora/primitives";

interface GraphNode {
  id: string;
  name: string;
  type: string;
  summary: string | null;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  strength: number;
}

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
  outgoing_relations: { target_name: string; target_type: string; relation: string }[];
  incoming_relations: { source_name: string; source_type: string; relation: string }[];
}

const TYPE_COLORS: Record<string, string> = {
  project: "#f97316",
  tool: "#8b5cf6",
  technology: "#3b82f6",
  concept: "#10b981",
  person: "#ec4899",
  file: "#6b7280",
};

export default function MemoryPage() {
  const { t } = useI18n();
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<EntityDetail | null>(null);
  const [filterType, setFilterType] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);

  // Load stats + graph
  useEffect(() => {
    authFetch(`${getApiBase()}/api/memory/stats`).then((r) => r.json()).then(setStats).catch(() => {});
    loadGraph();
  }, [filterType]); // eslint-disable-line

  const loadGraph = useCallback(() => {
    const params = filterType ? `?entity_type=${filterType}&limit=200` : "?limit=200";
    authFetch(`${getApiBase()}/api/memory/graph${params}`)
      .then((r) => r.json())
      .then((data) => {
        // Initialize positions randomly
        const w = 800, h = 600;
        const initialized = data.nodes.map((n: GraphNode, i: number) => ({
          ...n,
          x: w / 2 + (Math.random() - 0.5) * w * 0.8,
          y: h / 2 + (Math.random() - 0.5) * h * 0.8,
          vx: 0,
          vy: 0,
        }));
        setNodes(initialized);
        setEdges(data.edges || []);
        // Run force simulation
        simulateForce(initialized, data.edges || []);
      })
      .catch(() => {});
  }, [filterType]);

  // Simple force-directed layout simulation
  const simulateForce = (initialNodes: GraphNode[], edgeList: GraphEdge[]) => {
    const ns = [...initialNodes];
    const nodeMap = new Map(ns.map((n) => [n.id, n]));

    for (let iter = 0; iter < 100; iter++) {
      // Repulsion between all nodes
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const dx = (ns[i].x || 0) - (ns[j].x || 0);
          const dy = (ns[i].y || 0) - (ns[j].y || 0);
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const force = 2000 / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          ns[i].vx = (ns[i].vx || 0) + fx;
          ns[i].vy = (ns[i].vy || 0) + fy;
          ns[j].vx = (ns[j].vx || 0) - fx;
          ns[j].vy = (ns[j].vy || 0) - fy;
        }
      }
      // Attraction along edges
      for (const e of edgeList) {
        const s = nodeMap.get(e.source);
        const t = nodeMap.get(e.target);
        if (!s || !t) continue;
        const dx = (t.x || 0) - (s.x || 0);
        const dy = (t.y || 0) - (s.y || 0);
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (dist - 120) * 0.01;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        s.vx = (s.vx || 0) + fx;
        s.vy = (s.vy || 0) + fy;
        t.vx = (t.vx || 0) - fx;
        t.vy = (t.vy || 0) - fy;
      }
      // Center gravity
      for (const n of ns) {
        n.vx = (n.vx || 0) + (400 - (n.x || 400)) * 0.001;
        n.vy = (n.vy || 0) + (300 - (n.y || 300)) * 0.001;
      }
      // Apply velocity with damping
      for (const n of ns) {
        n.x = (n.x || 0) + (n.vx || 0) * 0.3;
        n.y = (n.y || 0) + (n.vy || 0) * 0.3;
        n.vx = (n.vx || 0) * 0.8;
        n.vy = (n.vy || 0) * 0.8;
        // Bounds
        n.x = Math.max(30, Math.min(770, n.x || 0));
        n.y = Math.max(30, Math.min(570, n.y || 0));
      }
    }
    setNodes([...ns]);
  };

  const handleNodeClick = async (nodeId: string) => {
    try {
      const resp = await authFetch(`${getApiBase()}/api/memory/entities/${nodeId}`);
      const detail = await resp.json();
      setSelectedEntity(detail);
    } catch {
      // ignore
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    try {
      const resp = await authFetch(`${getApiBase()}/api/memory/search?q=${encodeURIComponent(searchQuery)}`);
      setSearchResults(await resp.json());
    } catch {
      // ignore
    }
  };

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="max-w-6xl mx-auto space-y-4 sm:space-y-6">
      <TopBar title={t.nav.memory || "Memory"} subtitle="Knowledge graph — entities, relations, observations" />

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <StatCard label="Entities" value={stats.entities} />
          <StatCard label="Relations" value={stats.relations} />
          <StatCard label="Observations" value={stats.observations} />
          <StatCard label="Embeddings" value={stats.embeddings} />
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label className="aurora-input" style={{ minWidth: 200 }}>
          <Icon name="grid" size={15} style={{ color: "var(--aurora-fg3)" }} />
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">All Types</option>
            {stats && Object.entries(stats.entity_types).map(([type, count]) => (
              <option key={type} value={type}>{type} ({count})</option>
            ))}
          </select>
        </label>
        <GhostInput
          type="text"
          placeholder="Search entities & observations…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          icon="search"
          wrapStyle={{ flex: 1, minWidth: 260 }}
        />
        <Btn onClick={handleSearch} icon="search">Search</Btn>
      </div>

      {searchResults.length > 0 && (
        <Glass padding={16} radius={18}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>
            Search Results
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {searchResults.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13 }}>
                <div
                  style={{
                    width: 18, height: 18, borderRadius: 9999,
                    background: TYPE_COLORS[r.entity_type || r.type] || "#6b7280",
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 500, color: "var(--aurora-fg1)" }}>{r.name}</span>
                  <span style={{ fontSize: 11, color: "var(--aurora-fg4)", marginLeft: 8 }}>{r.entity_type || r.type}</span>
                  {r.summary && <p style={{ fontSize: 12, color: "var(--aurora-fg3)", marginTop: 2 }}>{r.summary}</p>}
                  {r.content && <p style={{ fontSize: 12, color: "var(--aurora-fg3)", marginTop: 2 }}>{r.content.slice(0, 150)}</p>}
                </div>
              </div>
            ))}
          </div>
        </Glass>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        <div className="lg:col-span-2 aurora-card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: 14, borderBottom: "1px solid var(--aurora-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Knowledge Graph
            </h3>
            <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
              {nodes.length} nodes · {edges.length} edges
            </span>
          </div>
          {nodes.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13 }}>
              No entities yet. Memory builds automatically as you use AI tools.
            </div>
          ) : (
            <svg
              ref={svgRef}
              viewBox="0 0 800 600"
              className="w-full h-[400px] sm:h-[500px]"
            >
              {/* Edges */}
              {edges.map((e, i) => {
                const s = nodeMap.get(e.source);
                const t = nodeMap.get(e.target);
                if (!s || !t) return null;
                return (
                  <g key={`e-${i}`}>
                    <line
                      x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                      stroke="var(--aurora-border-strong)" strokeWidth={Math.min(e.strength, 3)}
                    />
                    <text
                      x={((s.x || 0) + (t.x || 0)) / 2}
                      y={((s.y || 0) + (t.y || 0)) / 2 - 4}
                      fill="var(--aurora-fg4)" fontSize="8" textAnchor="middle"
                    >
                      {e.type}
                    </text>
                  </g>
                );
              })}
              {/* Nodes */}
              {nodes.map((n) => (
                <g
                  key={n.id}
                  transform={`translate(${n.x || 0},${n.y || 0})`}
                  onClick={() => handleNodeClick(n.id)}
                  className="cursor-pointer"
                >
                  <circle
                    r={12}
                    fill={TYPE_COLORS[n.type] || "#6b7280"}
                    opacity={0.85}
                    stroke={selectedEntity?.id === n.id ? "var(--aurora-accent)" : "var(--aurora-surface-solid)"}
                    strokeWidth={selectedEntity?.id === n.id ? 3 : 1.5}
                  />
                  <text
                    dy={24} textAnchor="middle"
                    fill="var(--aurora-fg2)" fontSize="10" fontWeight="500"
                  >
                    {n.name.length > 15 ? n.name.slice(0, 15) + "..." : n.name}
                  </text>
                </g>
              ))}
            </svg>
          )}
          <div style={{ padding: 12, borderTop: "1px solid var(--aurora-border)", display: "flex", flexWrap: "wrap", gap: 12 }}>
            {Object.entries(TYPE_COLORS).map(([type, color]) => (
              <div key={type} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--aurora-fg3)" }}>
                <span style={{ width: 10, height: 10, borderRadius: 9999, background: color }} />
                {type}
              </div>
            ))}
          </div>
        </div>

        <Glass padding={20} radius={20}>
          {selectedEntity ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <div
                  style={{
                    width: 32, height: 32, borderRadius: 10,
                    background: (TYPE_COLORS[selectedEntity.type] || "#6b7280") + "22",
                    color: TYPE_COLORS[selectedEntity.type] || "#6b7280",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Icon name="target" size={16} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.01em" }}>
                    {selectedEntity.name}
                  </h3>
                  <span
                    style={{
                      display: "inline-block",
                      marginTop: 2,
                      fontSize: 10.5,
                      padding: "2px 8px",
                      borderRadius: 9999,
                      background: (TYPE_COLORS[selectedEntity.type] || "#6b7280") + "22",
                      color: TYPE_COLORS[selectedEntity.type] || "#6b7280",
                      fontWeight: 500,
                    }}
                  >
                    {selectedEntity.type}
                  </span>
                </div>
              </div>
              {selectedEntity.summary && (
                <p style={{ fontSize: 13, color: "var(--aurora-fg3)", marginBottom: 14, lineHeight: 1.5 }}>
                  {selectedEntity.summary}
                </p>
              )}
              {(selectedEntity.outgoing_relations.length > 0 || selectedEntity.incoming_relations.length > 0) && (
                <div style={{ marginBottom: 14 }}>
                  <h4 style={{ fontSize: 10.5, fontWeight: 600, color: "var(--aurora-fg4)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                    Relations
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {selectedEntity.outgoing_relations.map((r, i) => (
                      <div key={`o-${i}`} style={{ fontSize: 12, color: "var(--aurora-fg3)" }}>
                        → <span style={{ color: "var(--aurora-accent)", fontWeight: 500 }}>{r.relation}</span> → <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{r.target_name}</span>
                      </div>
                    ))}
                    {selectedEntity.incoming_relations.map((r, i) => (
                      <div key={`i-${i}`} style={{ fontSize: 12, color: "var(--aurora-fg3)" }}>
                        <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{r.source_name}</span> → <span style={{ color: "var(--aurora-accent)", fontWeight: 500 }}>{r.relation}</span> →
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {selectedEntity.observations.length > 0 && (
                <div>
                  <h4 style={{ fontSize: 10.5, fontWeight: 600, color: "var(--aurora-fg4)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                    Observations ({selectedEntity.observations.length})
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflowY: "auto" }}>
                    {selectedEntity.observations.map((o, i) => (
                      <div key={i} style={{ fontSize: 12, color: "var(--aurora-fg3)", borderLeft: "2px solid var(--aurora-border-strong)", paddingLeft: 8 }}>
                        <p style={{ margin: 0 }}>{o.content}</p>
                        {o.observed_at && (
                          <span style={{ fontSize: 10.5, color: "var(--aurora-fg4)" }}>{new Date(o.observed_at).toLocaleDateString()}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ textAlign: "center", color: "var(--aurora-fg4)", fontSize: 13, padding: "32px 0" }}>
              Click a node to view details
            </div>
          )}
        </Glass>
      </div>
    </div>
  );
}
