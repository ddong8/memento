"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BacklinksResult, api } from "@/lib/api-client";
import { useI18n, fmt } from "@/lib/i18n";
import { Icon, ToolGlyph } from "@/components/aurora/Icon";
import { Chip, Glass, SectionLabel } from "@/components/aurora/primitives";

/**
 * Obsidian-style backlinks, derived from the knowledge graph rather than
 * hand-authored links: document → entities it was observed in → other
 * documents observed in those same entities.
 *
 * Renders nothing at all when the graph has no edges for this document —
 * an empty panel on every un-extracted doc would be pure noise.
 */
export default function BacklinksPanel({ docId }: { docId: string }) {
  const [data, setData] = useState<BacklinksResult | null>(null);
  const [loading, setLoading] = useState(true);
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    // No synchronous setLoading(true) here: `loading` already starts true, and
    // setting state in the effect body triggers a cascading render (and trips
    // react-hooks/set-state-in-effect). On a docId change we reset inside the
    // async callbacks instead, which run after the effect body.
    api
      .getBacklinks(docId)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  if (loading || !data) return null;
  if (!data.entities.length && !data.related_documents.length) return null;

  return (
    <Glass padding={18} radius={18} style={{ marginTop: 16 }}>
      <SectionLabel style={{ marginBottom: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name="link" size={13} />
          {t.backlinks.title}
        </span>
      </SectionLabel>

      {data.entities.length > 0 && (
        <div style={{ marginBottom: data.related_documents.length ? 16 : 0 }}>
          <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 7 }}>
            {t.backlinks.entities}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.entities.map((e) => (
              <Chip key={e.id} tone="accent">
                {e.name}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {data.related_documents.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 7 }}>
            {t.backlinks.related}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.related_documents.map((d) => (
              <Link
                key={d.id}
                href={`/documents/${d.id}`}
                style={{ textDecoration: "none" }}
              >
                <div
                  className="aurora-card-hover"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "8px 10px",
                    borderRadius: 12,
                    border: "1px solid var(--aurora-border)",
                  }}
                >
                  <ToolGlyph id={d.tool_id} size={20} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--aurora-fg1)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {d.title || d.relative_path}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>
                      {d.shared_entities === 1
                        ? t.backlinks.sharedOne
                        : fmt(t.backlinks.sharedMany, { n: d.shared_entities })}
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </Glass>
  );
}
