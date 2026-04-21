"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ToolDetail, DocumentSummary, getApiBase, authFetch } from "@/lib/api-client";
import { useI18n, fmt } from "@/lib/i18n";
import { useDevice } from "@/lib/device-context";
import { ToolGlyph, CategoryIcon } from "@/components/aurora/Icon";
import { Chip, Glass, TopBar, SectionLabel } from "@/components/aurora/primitives";

export default function ToolDetailPage() {
  const params = useParams();
  const toolId = params.tool as string;
  const [tool, setTool] = useState<ToolDetail | null>(null);
  const [files, setFiles] = useState<DocumentSummary[]>([]);
  const [projects, setProjects] = useState<{ id: string; title: string; document_count: number }[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | undefined>();
  const { t, locale } = useI18n();
  const { selectedDeviceId } = useDevice();
  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";
  const dq = selectedDeviceId ? `&device_id=${selectedDeviceId}` : "";

  useEffect(() => {
    authFetch(`${getApiBase()}/api/tools/${toolId}?_=1${dq}`).then((r) => r.json()).then(setTool).catch(() => {
      setTool({ id: toolId, display_name: toolId, icon: null, total_files: 0, total_size_bytes: 0, last_sync_at: null, categories: {} });
    });
    authFetch(`${getApiBase()}/api/projects?tool_id=${toolId}`).then((r) => r.json()).then(setProjects).catch(() => {});
  }, [toolId, dq]);

  useEffect(() => {
    const catParam = activeCategory ? `&category=${activeCategory}` : "";
    authFetch(`${getApiBase()}/api/tools/${toolId}/files?offset=0&limit=50${catParam}${dq}`)
      .then((r) => r.json()).then(setFiles).catch(() => setFiles([]));
  }, [toolId, activeCategory, dq]);

  if (!tool) return <div style={{ color: "var(--aurora-fg4)", marginTop: 80, textAlign: "center" }}>{t.loading}</div>;

  const categories = Object.entries(tool.categories);

  return (
    <div className="max-w-6xl mx-auto">
      <TopBar
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
            <ToolGlyph id={toolId} size={44} />
            <span style={{ textTransform: "capitalize" }}>{tool.display_name}</span>
          </span>
        }
        subtitle={`${fmt(t.tools.filesCount, { count: tool.total_files })} · ${t.tools.lastSync}: ${tool.last_sync_at ? new Date(tool.last_sync_at).toLocaleString(dateFmt) : t.never}`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 sm:gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Glass padding={6} radius={18}>
            <div style={{ padding: "8px 12px" }}>
              <SectionLabel style={{ margin: 0 }}>{t.tools.categories}</SectionLabel>
            </div>
            <CatRow label={t.all} count={tool.total_files} active={!activeCategory} onClick={() => setActiveCategory(undefined)} />
            {categories.map(([cat, count]) => (
              <CatRow
                key={cat}
                icon={cat}
                label={(t.category as Record<string, string>)[cat] || cat}
                count={count}
                active={activeCategory === cat}
                onClick={() => setActiveCategory(cat)}
              />
            ))}
          </Glass>

          {projects.length > 0 && (
            <Glass padding={6} radius={18}>
              <div style={{ padding: "8px 12px" }}>
                <SectionLabel style={{ margin: 0 }}>{t.tools.projectsInTool}</SectionLabel>
              </div>
              {projects.map((p) => (
                <Link key={p.id} href={`/projects/${p.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    borderRadius: 12,
                    fontSize: 13,
                    color: "var(--aurora-fg2)",
                    textDecoration: "none",
                  }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                  <span style={{ fontSize: 11, color: "var(--aurora-fg4)", marginLeft: 8 }}>{p.document_count}</span>
                </Link>
              ))}
            </Glass>
          )}
        </div>

        <div className="lg:col-span-3">
          <Glass padding={6} radius={18}>
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--aurora-border)" }}>
              <SectionLabel style={{ margin: 0 }}>
                {t.tools.fileList} ({files.length})
              </SectionLabel>
            </div>
            {files.length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--aurora-fg4)", padding: 48, fontSize: 13 }}>
                {t.tools.noFiles}
              </div>
            ) : (
              files.map((f) => {
                const href = f.content_type === "jsonl" && f.category === "conversation"
                  ? `/conversations/${f.id}` : `/documents/${f.id}`;
                return (
                  <Link
                    key={f.id}
                    href={href}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 12px",
                      borderRadius: 12,
                      textDecoration: "none",
                    }}
                  >
                    <div
                      style={{
                        width: 32, height: 32, borderRadius: 10, flexShrink: 0,
                        background: "var(--aurora-accent-soft)", color: "var(--aurora-accent)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <CategoryIcon category={f.category} size={14} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--aurora-fg1)", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {f.title || f.relative_path}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--aurora-fg4)", fontFamily: "ui-monospace,monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {f.relative_path}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, color: "var(--aurora-fg4)", flexShrink: 0 }}>{(f.file_size_bytes / 1024).toFixed(1)}KB</span>
                    <span style={{ fontSize: 11, color: "var(--aurora-fg4)", flexShrink: 0 }}>
                      {new Date(f.synced_at).toLocaleString(dateFmt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </Link>
                );
              })
            )}
          </Glass>
        </div>
      </div>
    </div>
  );
}

function CatRow({
  icon, label, count, active, onClick,
}: { icon?: string; label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        borderRadius: 12,
        fontSize: 13,
        cursor: "pointer",
        border: 0,
        background: active ? "var(--aurora-accent-soft)" : "transparent",
        color: active ? "var(--aurora-accent)" : "var(--aurora-fg2)",
        textAlign: "left",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        {icon && <CategoryIcon category={icon} size={13} />}
        {label}
      </span>
      <Chip tone={active ? "accent" : "neutral"} style={{ padding: "2px 8px" }}>{count}</Chip>
    </button>
  );
}
