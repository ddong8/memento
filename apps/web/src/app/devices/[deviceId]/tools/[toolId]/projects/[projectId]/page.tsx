"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { Icon, CategoryIcon } from "@/components/aurora/Icon";
import { Btn, Glass, SectionLabel, TopBar } from "@/components/aurora/primitives";

interface FileItem { id: string; title: string; relative_path: string; category: string; content_type: string; file_size_bytes: number; synced_at: string; }
interface ProjectInfo { id: string; slug: string; title: string; tool_id: string; source_path: string; }

export default function DeviceToolProjectPage() {
  const params = useParams();
  const { deviceId, toolId, projectId } = params as { deviceId: string; toolId: string; projectId: string };
  const { t, locale } = useI18n();
  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  const [files, setFiles] = useState<FileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [project, setProject] = useState<ProjectInfo | null>(null);

  useEffect(() => {
    authFetch(`${getApiBase()}/api/hierarchy/devices/${deviceId}/tools/${toolId}/files?project_id=${projectId}&limit=100`)
      .then((r) => r.json()).then((d) => { setFiles(d.files); setTotal(d.total); }).catch(() => {});
    if (projectId !== "none") {
      authFetch(`${getApiBase()}/api/projects/${projectId}`)
        .then((r) => r.json()).then(setProject).catch(() => {});
    }
  }, [deviceId, toolId, projectId]);

  const byCategory: Record<string, FileItem[]> = {};
  for (const f of files) (byCategory[f.category] ??= []).push(f);

  return (
    <div className="max-w-5xl mx-auto">
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--aurora-fg4)", marginBottom: 8, flexWrap: "wrap" }}>
        <Link href="/devices" style={{ color: "var(--aurora-fg4)" }}>{t.nav.devices}</Link>
        <Icon name="chevron_right" size={12} />
        <span>{deviceId.slice(0, 8)}</span>
        <Icon name="chevron_right" size={12} />
        <Link href={`/devices/${deviceId}/tools/${toolId}`} style={{ color: "var(--aurora-fg4)", textTransform: "capitalize" }}>
          {toolId.replace("_", " ")}
        </Link>
        <Icon name="chevron_right" size={12} />
        <span style={{ color: "var(--aurora-fg2)" }}>{t.projects}</span>
      </div>

      <TopBar
        title={project?.title || (projectId === "none" ? "(No Project)" : projectId.slice(0, 8))}
        subtitle={
          project?.source_path
            ? `${project.source_path} · ${total} ${t.files}`
            : `${total} ${t.files}`
        }
        right={
          project && (
            <Link href={`/projects/${project.id}/timeline`} style={{ textDecoration: "none" }}>
              <Btn size="sm" icon="target">{t.timeline.title}</Btn>
            </Link>
          )
        }
      />

      {Object.entries(byCategory).map(([cat, catFiles]) => (
        <div key={cat} style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 4px 12px" }}>
            <CategoryIcon category={cat} size={14} />
            <SectionLabel style={{ margin: 0 }}>
              {(t.category as Record<string, string>)[cat] || cat} <span style={{ textTransform: "none", color: "var(--aurora-fg4)", fontWeight: 400 }}>({catFiles.length})</span>
            </SectionLabel>
          </div>
          <Glass padding={6} radius={18}>
            {catFiles.map((f) => {
              const href = f.category === "conversation" ? `/conversations/${f.id}` : `/documents/${f.id}`;
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
                    <CategoryIcon category={cat} size={14} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--aurora-fg1)", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.title || f.relative_path.split("/").pop()}
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
            })}
          </Glass>
        </div>
      ))}

      {files.length === 0 && (
        <Glass padding={40} radius={20} style={{ textAlign: "center" }}>
          <p style={{ color: "var(--aurora-fg4)", fontSize: 13 }}>{t.noData}</p>
        </Glass>
      )}
    </div>
  );
}
