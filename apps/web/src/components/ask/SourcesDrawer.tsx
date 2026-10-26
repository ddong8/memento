"use client";

import Link from "next/link";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { useI18n } from "@/lib/i18n";
import { formatExcerpt, formatRelativeTime, type Source } from "@/lib/ask/turns";

/** The documents an answer drew on, in a drawer from the right. */
export function SourcesDrawer({ sources: selectedSources, onClose }: { sources: Source[]; onClose: () => void }) {
  const { t, locale } = useI18n();
  const isZh = locale.startsWith("zh");
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0, 0, 0, 0.45)",
          backdropFilter: "blur(4px)",
        }}
      />

      {/* Drawer content */}
      <div
        style={{
          position: "relative",
          width: "min(460px, 92vw)",
          height: "100%",
          background: "var(--aurora-surface-solid)",
          borderLeft: "1px solid var(--aurora-border)",
          boxShadow: "-8px 0 32px rgba(0, 0, 0, 0.16)",
          display: "flex",
          flexDirection: "column",
          zIndex: 1,
        }}
      >
        {/* Drawer Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--aurora-border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="book" size={18} style={{ color: "var(--aurora-accent)" }} />
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)" }}>
              {t.ask.sources}
            </span>
            {selectedSources.length > 0 && (
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 7px",
                  borderRadius: 999,
                  background: "rgba(56, 189, 248, 0.15)",
                  color: "var(--aurora-accent)",
                  fontWeight: 600,
                }}
              >
                {selectedSources.length}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "transparent",
              border: "none",
              color: "var(--aurora-fg3)",
              cursor: "pointer",
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Drawer List */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "14px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {selectedSources.map((s, si) => (
            <div
              key={s.id || si}
              style={{
                padding: "14px 16px",
                borderRadius: 12,
                background: "var(--aurora-bg)",
                border: "1px solid var(--aurora-border)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.03)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: "var(--aurora-accent)",
                    }}
                  >
                    [{si + 1}]
                  </span>
                  <ToolGlyph id={s.tool_id} size={16} />
                  {s.category && (
                    <span
                      style={{
                        fontSize: 10.5,
                        padding: "2px 7px",
                        borderRadius: 6,
                        background: "var(--aurora-surface-solid)",
                        border: "1px solid var(--aurora-border)",
                        color: "var(--aurora-fg3)",
                        fontWeight: 500,
                      }}
                    >
                      {s.category}
                    </span>
                  )}
                </div>
                {s.synced_at && (
                  <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                    {formatRelativeTime(s.synced_at, isZh)}
                  </span>
                )}
              </div>

              <Link
                href={`/documents/${s.id}`}
                target="_blank"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--aurora-fg1)",
                  textDecoration: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  lineHeight: 1.4,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.title || s.relative_path}
                </span>
                <Icon name="external_link" size={13} style={{ flexShrink: 0, opacity: 0.6 }} />
              </Link>

              {s.excerpt && (
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: "var(--aurora-fg2)",
                    background: "var(--aurora-surface-solid)",
                    borderRadius: 8,
                    padding: "10px 12px",
                    border: "1px solid var(--aurora-border)",
                    borderLeft: "3px solid var(--aurora-accent)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 180,
                    overflowY: "auto",
                  }}
                >
                  {formatExcerpt(s.excerpt)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
