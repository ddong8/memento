"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, DocumentDetail } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import ConfigViewer from "@/components/viewers/ConfigViewer";
import { ToolGlyph, CategoryIcon } from "@/components/aurora/Icon";
import { Chip, Glass } from "@/components/aurora/primitives";

export default function DocumentPage() {
  const params = useParams();
  const docId = params.id as string;
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const { t, locale } = useI18n();

  useEffect(() => { api.getDocument(docId).then(setDoc).catch(console.error); }, [docId]);

  if (!doc) return <div style={{ color: "var(--aurora-fg4)", marginTop: 80, textAlign: "center" }}>{t.loading}</div>;

  const dateFmt = locale === "zh-CN" ? "zh-CN" : "en-US";

  return (
    <div className="max-w-4xl mx-auto">
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <ToolGlyph id={doc.tool_id} size={32} />
          <h2 style={{ margin: 0, fontSize: "clamp(20px, 3vw, 26px)", fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.02em" }}>
            {doc.title || doc.relative_path}
          </h2>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 12, color: "var(--aurora-fg3)" }}>
          <Chip>{doc.tool_id}</Chip>
          <Chip tone="accent"><CategoryIcon category={doc.category} size={11} /> {doc.category}</Chip>
          <span>{(doc.file_size_bytes / 1024).toFixed(1)} KB</span>
          <span>{t.synced}: {new Date(doc.synced_at).toLocaleString(dateFmt)}</span>
        </div>
      </div>

      {doc.ai_summary && (
        <Glass padding={18} radius={18} style={{ marginBottom: 18, border: "1px solid var(--aurora-accent-soft)", background: "var(--aurora-accent-soft)" }}>
          <Chip tone="accent" icon="sparkles" style={{ marginBottom: 8 }}>{t.document.aiSummary}</Chip>
          <div className="prose prose-sm max-w-none">
            <MarkdownViewer content={doc.ai_summary} />
          </div>
        </Glass>
      )}

      <Glass padding={22} radius={20}>
        {doc.content ? (
          doc.content_type === "markdown" ? <MarkdownViewer content={doc.content} />
            : <ConfigViewer content={doc.content} language={doc.content_type} />
        ) : (
          <div style={{ color: "var(--aurora-fg4)", textAlign: "center", padding: 32 }}>{t.document.contentInS3}</div>
        )}
      </Glass>

      {doc.metadata && Object.keys(doc.metadata).length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: "var(--aurora-fg3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
            {t.document.metadata}
          </h3>
          <Glass padding={16} radius={18}>
            <ConfigViewer content={JSON.stringify(doc.metadata, null, 2)} />
          </Glass>
        </div>
      )}
    </div>
  );
}
