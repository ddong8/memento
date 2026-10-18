"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { Icon, ToolGlyph, CategoryIcon } from "@/components/aurora/Icon";
import { Btn, Glass, TopBar, SectionLabel } from "@/components/aurora/primitives";

interface ProjectDetail {
  id: string;
  slug: string;
  title: string;
  tool_id: string;
  source_path: string;
  visibility: string;
  documents: { id: string; relative_path: string; category: string; title: string; file_size_bytes: number; synced_at: string }[];
}

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const { t, locale } = useI18n();
  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  useEffect(() => {
    authFetch(`${getApiBase()}/api/projects/${projectId}`).then((r) => r.json()).then(setProject).catch(console.error);
  }, [projectId]);

  // Hit the server's per-project markdown export endpoint and trigger
  // a browser download. authFetch attaches the JWT; we read the body
  // as a Blob and click an off-DOM <a download> — same pattern the
  // account-level export uses on the Profile page.
  const handleExportMarkdown = async (pid: string, slug: string) => {
    try {
      const res = await authFetch(`${getApiBase()}/api/projects/${pid}/export.md`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `memento-context-${slug || "project"}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e: unknown) {
      alert(t.projects_page.exportFailed + ": " + (e instanceof Error ? e.message : String(e)));
    }
  };

  if (!project) return <div style={{ color: "var(--aurora-fg4)", textAlign: "center", marginTop: 80 }}>{t.loading}</div>;

  const byCategory: Record<string, typeof project.documents> = {};
  for (const d of project.documents) (byCategory[d.category] ??= []).push(d);

  return (
    <div className="max-w-5xl mx-auto">
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--aurora-fg4)", marginBottom: 8 }}>
        <Link href="/projects" style={{ color: "var(--aurora-fg4)" }}>{t.projects}</Link>
        <Icon name="chevron_right" size={12} />
        <Link href={`/tools/${project.tool_id}`} style={{ color: "var(--aurora-fg4)", textTransform: "capitalize" }}>
          {project.tool_id.replace("_", " ")}
        </Link>
      </div>

      <TopBar
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
            <ToolGlyph id={project.tool_id} size={34} />
            {project.title}
          </span>
        }
        subtitle={<span style={{ fontFamily: "ui-monospace,monospace" }}>{project.source_path}</span>}
        right={
          <>
            <Btn
              variant="ghost"
              size="sm"
              icon="arrow_down"
              onClick={() => handleExportMarkdown(projectId, project.slug || project.title || "project")}
              title={t.projects_page.exportMdHint}
            >
              {t.projects_page.exportMd}
            </Btn>
            <Link href={`/projects/${projectId}/conversations`} style={{ textDecoration: "none" }}>
              <Btn variant="glass" size="sm" icon="message">{t.conversations}</Btn>
            </Link>
            <Link href={`/projects/${projectId}/timeline`} style={{ textDecoration: "none" }}>
              <Btn size="sm" icon="target">{t.timeline.title}</Btn>
            </Link>
          </>
        }
      />

      {Object.entries(byCategory).map(([cat, docs]) => (
        <div key={cat} style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 4px 12px" }}>
            <CategoryIcon category={cat} size={16} />
            <SectionLabel style={{ margin: 0 }}>
              {(t.category as Record<string, string>)[cat] || cat}{" "}
              <span style={{ textTransform: "none", color: "var(--aurora-fg4)", fontWeight: 400 }}>({docs.length})</span>
            </SectionLabel>
          </div>
          <Glass padding={6} radius={18}>
            {docs.map((d) => {
              const href = cat === "conversation" ? `/conversations/${d.id}` : `/documents/${d.id}`;
              return (
                <DocRow
                  key={d.id}
                  href={href}
                  category={cat}
                  title={d.title || d.relative_path.split("/").pop() || ""}
                  path={d.relative_path}
                  size={`${(d.file_size_bytes / 1024).toFixed(1)}KB`}
                  date={new Date(d.synced_at).toLocaleString(dateFmt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                />
              );
            })}
          </Glass>
        </div>
      ))}

      {project.documents.length === 0 && (
        <Glass padding={40} radius={20} style={{ textAlign: "center" }}>
          <p style={{ color: "var(--aurora-fg4)", fontSize: 13 }}>{t.noData}</p>
        </Glass>
      )}
    </div>
  );
}

function DocRow({
  href, category, title, path, size, date,
}: { href: string; category: string; title: string; path: string; size: string; date: string }) {
  const [h, setH] = useState(false);
  return (
    <Link
      href={href}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 12,
        background: h ? "var(--aurora-chip)" : "transparent",
        transition: "background .15s",
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
        <CategoryIcon category={category} size={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--aurora-fg1)", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: "var(--aurora-fg4)", fontFamily: "ui-monospace,monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {path}
        </div>
      </div>
      <span style={{ fontSize: 11, color: "var(--aurora-fg4)", flexShrink: 0 }}>{size}</span>
      <span style={{ fontSize: 11, color: "var(--aurora-fg4)", flexShrink: 0 }}>{date}</span>
    </Link>
  );
}
