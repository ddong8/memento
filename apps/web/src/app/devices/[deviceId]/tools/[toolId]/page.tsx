"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { getApiBase, authFetch } from "@/lib/api-client";
import { Icon, ToolGlyph, CategoryIcon } from "@/components/aurora/Icon";
import { Chip, Glass, SectionLabel, TopBar } from "@/components/aurora/primitives";

interface ProjectItem { id: string; title: string; slug: string; file_count: number; last_sync: string | null; }
interface FileItem { id: string; title: string; relative_path: string; category: string; content_type: string; file_size_bytes: number; synced_at: string; }

export default function DeviceToolPage() {
  const params = useParams();
  const deviceId = params.deviceId as string;
  const toolId = params.toolId as string;
  const { t, locale } = useI18n();
  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [totalFiles, setTotalFiles] = useState(0);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<Record<string, number>>({});
  const [discovery, setDiscovery] = useState<{ root?: string; projects?: { path: string }[] } | null>(null);

  useEffect(() => {
    authFetch(`${getApiBase()}/api/hierarchy/devices/${deviceId}/tools/${toolId}/projects`)
      .then((r) => r.json()).then(setProjects).catch(() => {});
    authFetch(`${getApiBase()}/api/tools/${toolId}?_=1&device_id=${deviceId}`)
      .then((r) => r.json()).then((d) => setCategories(d.categories || {})).catch(() => {});
    authFetch(`${getApiBase()}/api/devices`)
      .then((r) => r.json())
      .then((devices: { id: string; device_id: string }[]) => {
        const dev = devices.find((d) => d.device_id === deviceId);
        if (dev) {
          authFetch(`${getApiBase()}/api/devices/${dev.id}/discovery`)
            .then((r) => r.json())
            .then((d) => setDiscovery(d.tools?.[toolId] || null))
            .catch(() => {});
        }
      }).catch(() => {});
  }, [deviceId, toolId]);

  useEffect(() => {
    const catParam = activeCategory ? `&category=${activeCategory}` : "";
    authFetch(`${getApiBase()}/api/hierarchy/devices/${deviceId}/tools/${toolId}/files?limit=50${catParam}`)
      .then((r) => r.json()).then((d) => { setFiles(d.files); setTotalFiles(d.total); }).catch(() => {});
  }, [deviceId, toolId, activeCategory]);

  const toolName = toolId.replace("_", " ");

  return (
    <div className="max-w-6xl mx-auto">
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--aurora-fg4)", marginBottom: 8 }}>
        <Link href="/devices" style={{ color: "var(--aurora-fg4)" }}>{t.nav.devices}</Link>
        <Icon name="chevron_right" size={12} />
        <span style={{ color: "var(--aurora-fg3)" }}>{deviceId.slice(0, 8)}</span>
        <Icon name="chevron_right" size={12} />
        <span style={{ color: "var(--aurora-fg2)", textTransform: "capitalize" }}>{toolName}</span>
      </div>

      <TopBar
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
            <ToolGlyph id={toolId} size={44} />
            <span style={{ textTransform: "capitalize" }}>{toolName}</span>
          </span>
        }
        subtitle={discovery?.root}
      />

      {discovery?.root && (
        <Glass padding={12} radius={14} style={{ marginBottom: 18, background: "var(--aurora-chip)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
            <span style={{ fontWeight: 500, color: "var(--aurora-fg3)" }}>Root</span>
            <code
              style={{
                background: "var(--aurora-surface-solid)",
                padding: "3px 10px",
                borderRadius: 8,
                border: "1px solid var(--aurora-border)",
                color: "var(--aurora-fg2)",
                fontFamily: "ui-monospace,monospace",
              }}
            >
              {discovery.root}
            </code>
          </div>
        </Glass>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 sm:gap-6">
        <div className="lg:col-span-1 space-y-4">
          {Object.keys(categories).length > 0 && (
            <Glass padding={6} radius={18}>
              <div style={{ padding: "8px 12px" }}>
                <SectionLabel style={{ margin: 0 }}>{t.tools.categories}</SectionLabel>
              </div>
              <CatButton label={t.all} count={totalFiles} active={!activeCategory} onClick={() => setActiveCategory(null)} />
              {Object.entries(categories).map(([cat, cnt]) => (
                <CatButton
                  key={cat}
                  icon={cat}
                  label={(t.category as Record<string, string>)[cat] || cat}
                  count={cnt}
                  active={activeCategory === cat}
                  onClick={() => setActiveCategory(cat)}
                />
              ))}
            </Glass>
          )}

          {projects.length > 0 && (
            <Glass padding={6} radius={18}>
              <div style={{ padding: "8px 12px" }}>
                <SectionLabel style={{ margin: 0 }}>{t.projects}</SectionLabel>
              </div>
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/devices/${deviceId}/tools/${toolId}/projects/${p.id}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 12px",
                    borderRadius: 12,
                    fontSize: 13,
                    color: "var(--aurora-fg2)",
                    textDecoration: "none",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                  <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>{p.file_count}</span>
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

function CatButton({
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
