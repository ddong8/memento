"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ConversationMeta, ExportDiagnostics } from "@/lib/api-client";
import { fmt, useI18n } from "@/lib/i18n";
import ConversationViewer from "@/components/viewers/ConversationViewer";
import { ToolGlyph } from "@/components/aurora/Icon";
import { Chip } from "@/components/aurora/primitives";

interface RelatedPlan {
  id: string;
  title: string;
  relative_path: string;
  category: string;
  content_type: string;
  content: string | null;
  file_size_bytes: number;
  synced_at: string;
}

interface ConversationMetaWithPlans extends ConversationMeta {
  related_plans?: RelatedPlan[];
}

export default function ConversationPage() {
  const params = useParams();
  const docId = params.id as string;
  const [meta, setMeta] = useState<ConversationMetaWithPlans | null>(null);
  const { t, locale } = useI18n();

  useEffect(() => { api.getConversation(docId).then(setMeta).catch(console.error); }, [docId]);

  if (!meta) return <div className="text-gray-400 mt-20 text-center">{t.loading}</div>;

  const plans = meta.related_plans || [];
  const diagnostics = (meta.metadata?.export_diagnostics as ExportDiagnostics | undefined) || null;
  const hasDiagnostics = meta.tool_id === "antigravity" && diagnostics && Object.keys(diagnostics).length > 0;

  return (
    <div className="max-w-4xl mx-auto">
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <ToolGlyph id={meta.tool_id} size={32} />
          <h2 style={{ margin: 0, fontSize: "clamp(20px, 3vw, 26px)", fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.02em" }}>
            {meta.title || meta.relative_path}
          </h2>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 12, color: "var(--aurora-fg3)" }}>
          <Chip>{meta.tool_id}</Chip>
          <span>{meta.message_count} {t.conversation.messages}</span>
          {plans.length > 0 && <Chip tone="warn">{plans.length} artifacts</Chip>}
          {hasDiagnostics && diagnostics.step_fetch_failed && <Chip tone="danger">{t.conversation.stepFetchFailed}</Chip>}
          <span>{t.synced}: {new Date(meta.synced_at).toLocaleString(locale)}</span>
        </div>
      </div>
      {hasDiagnostics && diagnostics && (
        <div style={{ marginBottom: 18, borderRadius: 16, border: "1px solid rgba(251,191,36,0.25)", background: "rgba(251,191,36,0.08)", padding: 14 }}>
          <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600, color: "#92400E" }}>{t.conversation.diagnostics}</div>
          <div style={{ marginBottom: 10, fontSize: 11, color: "#B45309" }}>{t.conversation.diagnosticsHelp}</div>
          <div className="flex flex-wrap gap-2 text-xs">
            <DiagChip
              label={t.conversation.plannerResponses}
              value={diagnostics.assistant_response_count ?? 0}
            />
            <DiagChip
              label={t.conversation.thinkingOnly}
              value={diagnostics.assistant_thinking_only_count ?? 0}
            />
            <DiagChip
              label={t.conversation.metadataRecovered}
              value={diagnostics.assistant_fallback_count ?? 0}
            />
            <DiagChip
              label={t.conversation.transcriptRecovered}
              value={(diagnostics.transcript_messages ?? 0) + (diagnostics.offline_pb_transcript_messages ?? 0)}
            />
            <DiagChip
              label={t.conversation.offlineVscdbRecovered}
              value={diagnostics.offline_vscdb_messages ?? 0}
            />
            <DiagChip
              label={t.conversation.chatExportRecovered}
              value={diagnostics.chat_export_messages ?? 0}
            />
            <DiagChip
              label={t.conversation.offlinePbRecovered}
              value={diagnostics.offline_pb_total_messages ?? 0}
            />
            <DiagChip
              label={t.conversation.brainArtifacts}
              value={diagnostics.brain_file_count ?? 0}
            />
            <DiagChip
              label={t.conversation.browserFrames}
              value={diagnostics.browser_recording_frame_count ?? 0}
            />
            <DiagChip
              label={t.conversation.browserHighlights}
              value={diagnostics.browser_recording_highlight_count ?? 0}
            />
            <DiagFlag
              label={t.conversation.stepFetchFailed}
              enabled={Boolean(diagnostics.step_fetch_failed)}
            />
            <DiagFlag
              label={t.conversation.pbShellOnly}
              enabled={Boolean(diagnostics.pb_shell_only)}
            />
            <DiagFlag
              label={t.conversation.truncated}
              enabled={Boolean(diagnostics.messages_truncated)}
            />
            {typeof diagnostics.endpoint_count === "number" && (
              <DiagChip label="endpoints" value={diagnostics.endpoint_count} />
            )}
            {typeof diagnostics.step_count === "number" && (
              <DiagChip label="steps" value={diagnostics.step_count} />
            )}
          </div>
        </div>
      )}
      <ConversationViewer documentId={docId} totalMessages={meta.message_count} artifacts={plans} />
    </div>
  );
}

function DiagChip({ label, value }: { label: string; value: number }) {
  return (
    <span
      style={{
        borderRadius: 9999,
        border: "1px solid rgba(251,191,36,0.25)",
        background: "var(--aurora-surface-solid)",
        padding: "3px 10px",
        color: "#92400E",
      }}
    >
      {fmt("{label}: {value}", { label, value })}
    </span>
  );
}

function DiagFlag({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <span
      style={{
        borderRadius: 9999,
        padding: "3px 10px",
        border: enabled ? "1px solid rgba(244,63,94,0.4)" : "1px solid var(--aurora-border)",
        background: enabled ? "rgba(244,63,94,0.12)" : "var(--aurora-surface-solid)",
        color: enabled ? "#BE123C" : "var(--aurora-fg4)",
      }}
    >
      {label}
    </span>
  );
}
