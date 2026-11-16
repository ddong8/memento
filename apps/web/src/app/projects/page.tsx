"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Glass, TopBar, SectionLabel, Skeleton } from "@/components/aurora/primitives";
import { timeAgo } from "@/lib/constants";

interface ProjectItem {
  id: string;
  slug: string;
  title: string;
  tool_id: string;
  source_path: string;
  document_count: number;
  created_at: string;
  updated_at: string | null;
}

const TOOL_NAMES: Record<string, string> = {
  claude_code: "Claude Code", codex: "Codex", antigravity: "Antigravity", workbuddy: "WorkBuddy",
  openclaw: "OpenClaw", obsidian: "Obsidian", cursor: "Cursor", windsurf: "Windsurf", vscode: "VS Code", hermes: "Hermes",
};

/** Directories made by tools, not projects a person works on: executor clones, WorkBuddy's dated task folders, scratch repos. */
function isScratch(p: ProjectItem): boolean {
  const path = (p.source_path || "").replace(/\\/g, "/");
  return (
    /\/\.memento\/workspaces\//.test(path) ||
    /^memento-workspaces-/.test(p.title) ||
    /\/WorkBuddy\/\d{4}-\d{2}-\d{2}-/i.test(path) ||
    /^_repo\d*$/.test(p.title)
  );
}

/** The path as a person reads it: the home directory as ~. */
function shortPath(path: string): string {
  return (path || "")
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, "~");
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filterTool, setFilterTool] = useState("");
  const [filterDevice, setFilterDevice] = useState("");
  const [devices, setDevices] = useState<Array<{ id: string; name: string; device_id: string }>>([]);
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [showScratch, setShowScratch] = useState(false);

  useEffect(() => {
    authFetch(`${getApiBase()}/api/devices`)
      .then((r) => r.json())
      .then((d) => setDevices(d || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filterTool) params.set("tool_id", filterTool);
    if (filterDevice) params.set("device_id", filterDevice);
    const url = params.toString() ? `${getApiBase()}/api/projects?${params}` : `${getApiBase()}/api/projects`;
    authFetch(url)
      .then((r) => r.json())
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoaded(true));
  }, [filterTool, filterDevice]);

  const scratchCount = useMemo(() => projects.filter(isScratch).length, [projects]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .filter((p) => showScratch || !isScratch(p))
      .filter((p) => !q || p.title.toLowerCase().includes(q) || (p.source_path || "").toLowerCase().includes(q))
      // Most recently active first
      .sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime());
  }, [projects, query, showScratch]);
  const byTool: Record<string, ProjectItem[]> = {};
  for (const p of shown) (byTool[p.tool_id] ??= []).push(p);

  return (
    <div className="max-w-6xl mx-auto">
      <TopBar
        title={t.projectPage.title}
        subtitle={`${shown.length} ${t.projects}`}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label className="aurora-input" style={{ padding: "8px 14px", minWidth: 200 }}>
              <Icon name="search" size={14} style={{ color: "var(--aurora-fg3)" }} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索项目名或路径" />
            </label>
            <label className="aurora-input" style={{ padding: "8px 14px", minWidth: 160 }}>
              <Icon name="devices" size={14} style={{ color: "var(--aurora-fg3)" }} />
              <select value={filterDevice} onChange={(e) => setFilterDevice(e.target.value)}>
                <option value="">全部设备</option>
                {devices.map((d) => (
                  <option key={d.device_id} value={d.device_id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="aurora-input" style={{ padding: "8px 14px", minWidth: 160 }}>
              <Icon name="grid" size={14} style={{ color: "var(--aurora-fg3)" }} />
              <select value={filterTool} onChange={(e) => setFilterTool(e.target.value)}>
                <option value="">{t.all}</option>
                <option value="claude_code">Claude Code</option>
                <option value="openclaw">OpenClaw</option>
                <option value="codex">Codex</option>
                <option value="antigravity">Antigravity</option>
                <option value="workbuddy">WorkBuddy</option>
                <option value="obsidian">Obsidian</option>
                <option value="cursor">Cursor</option>
              </select>
            </label>
          </div>
        }
      />

      {scratchCount > 0 && (
        <div style={{ margin: "-6px 4px 14px", fontSize: 12, color: "var(--aurora-fg4)" }}>
          {showScratch ? "已显示" : "已隐藏"} {scratchCount} 个工具自动生成的临时目录（执行机工作区、WorkBuddy 任务目录等）·{" "}
          <button type="button" onClick={() => setShowScratch((v) => !v)} style={{ color: "var(--aurora-accent)", background: "none", border: 0, cursor: "pointer", padding: 0, fontSize: 12 }}>
            {showScratch ? "隐藏" : "显示"}
          </button>
        </div>
      )}

      {!loaded ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3" aria-busy="true">
          {Array.from({ length: 9 }, (_, i) => <Skeleton key={i} height={96} radius={18} />)}
        </div>
      ) : shown.length === 0 ? (
        <Glass padding={40} radius={22} style={{ textAlign: "center" }}>
          <p style={{ color: "var(--aurora-fg4)", fontSize: 13 }}>{t.projectPage.noProjects}</p>
        </Glass>
      ) : (
        Object.entries(byTool).map(([toolId, toolProjects]) => (
          <div key={toolId} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 4px 12px" }}>
              <ToolGlyph id={toolId} size={26} />
              <SectionLabel style={{ margin: 0 }}>
                <span style={{ textTransform: "none" }}>{TOOL_NAMES[toolId] || toolId}</span> <span style={{ textTransform: "none", color: "var(--aurora-fg4)", fontWeight: 400 }}>{toolProjects.length}</span>
              </SectionLabel>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {toolProjects.map((p) => (
                <Glass key={p.id} hover padding={16} radius={18}>
                  <Link href={`/projects/${p.id}`} style={{ textDecoration: "none" }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--aurora-fg1)",
                        letterSpacing: "-0.01em",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.title}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--aurora-fg4)",
                        fontFamily: "var(--font-mono)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        marginBottom: 12,
                      }}
                    >
                      {shortPath(p.source_path)}
                    </div>
                  </Link>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <span style={{ fontSize: 11.5, color: "var(--aurora-fg3)", fontVariantNumeric: "tabular-nums" }}>
                      {p.document_count} {t.files}
                      {(p.updated_at || p.created_at) && <> · {timeAgo(p.updated_at || p.created_at)}</>}
                    </span>
                    <Link
                      href={`/projects/${p.id}/timeline`}
                      style={{
                        fontSize: 11,
                        color: "var(--aurora-accent)",
                        fontWeight: 500,
                        letterSpacing: "-0.005em",
                        textDecoration: "none",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <Icon name="target" size={12} />
                      {t.timeline.title}
                    </Link>
                  </div>
                </Glass>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
