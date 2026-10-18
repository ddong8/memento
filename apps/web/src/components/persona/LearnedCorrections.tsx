"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { fmt, useI18n } from "@/lib/i18n";
import { Btn, Chip, Glass } from "@/components/aurora/primitives";

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));

/** "project:chembook" -> the project name and kind; null for a general rule. */
function correctionScope(scope: unknown): { kind: "project" | "device"; name: string } | null {
  const [kind, ...rest] = str(scope || "global").split(":");
  const name = rest.join(":");
  if (!name || (kind !== "project" && kind !== "device")) return null;
  return { kind, name };
}

function time(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Corrections picked up from what the user told their AIs, waiting for a yes.
 * Accepting one writes it into the resident profile.
 */
export default function LearnedCorrections({ topics, onChanged }: { topics: Obj[]; onChanged: (notice?: string) => void }) {
  const { t } = useI18n();
  const p = t.persona;
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [general, setGeneral] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!topics.length) return null;

  const scopeText = (scope: unknown) => {
    const s = correctionScope(scope);
    return s ? fmt(s.kind === "project" ? p.scopeProject : p.scopeDevice, { name: s.name }) : null;
  };

  const decide = async (topic: Obj, accept: boolean, statement?: string, makeGeneral = false) => {
    const id = str(topic.id);
    setBusy(id);
    setError(null);
    try {
      if (accept) await api.acceptCorrection(id, { statement, general: makeGeneral });
      else await api.dismissCorrection(id);
      setEditing(null);
      onChanged(accept ? p.acceptedNotice : undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Glass padding="clamp(14px, 3vw, 22px)" radius={18} style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Chip tone="accent" icon="sparkles">{p.learnedTag}</Chip>
        <span style={{ fontSize: 12, color: "var(--aurora-fg3)" }}>{fmt(p.learnedCaption, { n: topics.length })}</span>
      </div>
      {error && <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "#DC2626" }}>{error}</p>}
      {topics.map((topic) => {
        const id = str(topic.id);
        const times = typeof topic.times === "number" ? topic.times : 1;
        const quotes = (Array.isArray(topic.quotes) ? topic.quotes : []).slice(0, 2) as Obj[];
        const disabled = busy !== null;
        const scope = scopeText(topic.scope);
        return (
          <div key={id} style={{ padding: "14px 0 0", marginTop: 12, borderTop: "1px solid var(--aurora-border)" }}>
            <div style={{ fontSize: 14.5, fontWeight: 500, lineHeight: 1.5, color: "var(--aurora-fg1)" }}>{str(topic.statement)}</div>
            <div style={{ fontSize: 12, marginTop: 4, color: times > 1 ? "#B45309" : "var(--aurora-fg3)" }}>
              {[
                fmt(p.saidTimes, { n: times }),
                topic.last_at ? fmt(p.lastAt, { at: time(topic.last_at) }) : "",
                scope ?? fmt(p.putUnder, { heading: str(topic.heading) || p.defaultHeading }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {quotes.map((q, i) => (
              <div
                key={i}
                style={{
                  marginTop: 8,
                  paddingLeft: 10,
                  borderLeft: "2px solid var(--aurora-border-strong)",
                  fontSize: 12.5,
                  lineHeight: 1.45,
                  color: "var(--aurora-fg2)",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {str(q.text)}
              </div>
            ))}
            {editing === id ? (
              <div style={{ marginTop: 10 }}>
                <textarea
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder={p.editHint}
                  style={{
                    width: "100%",
                    fontSize: 13.5,
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid var(--aurora-border-strong)",
                    background: "var(--aurora-surface-solid)",
                    color: "var(--aurora-fg1)",
                    resize: "vertical",
                  }}
                />
                {scope && (
                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8, fontSize: 13, color: "var(--aurora-fg2)", cursor: "pointer" }}>
                    <input type="checkbox" checked={general} onChange={(e) => setGeneral(e.target.checked)} style={{ marginTop: 3 }} />
                    <span>
                      {p.makeGeneral}
                      <span style={{ display: "block", fontSize: 12, color: "var(--aurora-fg3)" }}>{fmt(p.scopeNow, { scope })}</span>
                    </span>
                  </label>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
                  <Btn variant="ghost" size="sm" disabled={disabled} onClick={() => setEditing(null)}>
                    {p.cancel}
                  </Btn>
                  <Btn size="sm" icon="check" disabled={disabled || !draft.trim()} onClick={() => decide(topic, true, draft.trim(), general)}>
                    {p.accept}
                  </Btn>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
                <Btn variant="ghost" size="sm" disabled={disabled} onClick={() => decide(topic, false)}>
                  {p.ignore}
                </Btn>
                <Btn
                  variant="glass"
                  size="sm"
                  icon="edit"
                  disabled={disabled}
                  onClick={() => {
                    setDraft(str(topic.statement));
                    setGeneral(false);
                    setEditing(id);
                  }}
                >
                  {p.editAccept}
                </Btn>
                <Btn size="sm" icon="check" disabled={disabled} onClick={() => decide(topic, true)}>
                  {busy === id ? p.working : p.accept}
                </Btn>
              </div>
            )}
          </div>
        );
      })}
    </Glass>
  );
}
