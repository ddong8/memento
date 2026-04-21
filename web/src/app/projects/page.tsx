"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Glass, TopBar, SectionLabel, Chip } from "@/components/aurora/primitives";

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

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [filterTool, setFilterTool] = useState("");
  const { t } = useI18n();

  useEffect(() => {
    const url = filterTool
      ? `${getApiBase()}/api/projects?tool_id=${filterTool}`
      : `${getApiBase()}/api/projects`;
    authFetch(url).then((r) => r.json()).then(setProjects).catch(console.error);
  }, [filterTool]);

  const byTool: Record<string, ProjectItem[]> = {};
  for (const p of projects) (byTool[p.tool_id] ??= []).push(p);

  return (
    <div className="max-w-6xl mx-auto">
      <TopBar
        title={t.projectPage.title}
        subtitle={`${projects.length} ${t.projects}`}
        right={
          <label className="aurora-input" style={{ padding: "8px 14px", minWidth: 180 }}>
            <Icon name="grid" size={14} style={{ color: "var(--aurora-fg3)" }} />
            <select value={filterTool} onChange={(e) => setFilterTool(e.target.value)}>
              <option value="">{t.all}</option>
              <option value="claude_code">Claude Code</option>
              <option value="openclaw">OpenClaw</option>
              <option value="codex">Codex</option>
              <option value="obsidian">Obsidian</option>
              <option value="cursor">Cursor</option>
            </select>
          </label>
        }
      />

      {projects.length === 0 ? (
        <Glass padding={40} radius={22} style={{ textAlign: "center" }}>
          <p style={{ color: "var(--aurora-fg4)", fontSize: 13 }}>{t.projectPage.noProjects}</p>
        </Glass>
      ) : (
        Object.entries(byTool).map(([toolId, toolProjects]) => (
          <div key={toolId} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 4px 12px" }}>
              <ToolGlyph id={toolId} size={26} />
              <SectionLabel style={{ margin: 0 }}>
                {toolId.replace("_", " ")} <span style={{ textTransform: "none", color: "var(--aurora-fg4)", fontWeight: 400 }}>({toolProjects.length})</span>
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
                        fontFamily: "ui-monospace,monospace",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        marginBottom: 12,
                      }}
                    >
                      {p.source_path}
                    </div>
                  </Link>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <Chip>{p.document_count} {t.files}</Chip>
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
