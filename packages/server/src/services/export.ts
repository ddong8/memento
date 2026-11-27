// Account-level portable ZIP export, wire-compatible with server/server/services/export_service.py.
import { isIP } from "node:net";

import { and, eq, inArray } from "drizzle-orm";
import { zipSync, type Zippable } from "fflate";

import type { UserRow } from "../auth/current-user";
import type { Db } from "../db/client";
import {
  accessLogs,
  askConversations,
  conversationMessages,
  correctionTopics,
  dailySummaries,
  documentPendingDeltas,
  documents,
  documentVersions,
  dreamJournals,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  projects,
  scheduledTasks,
  shareLinks,
  skills,
  todos,
  userMemories,
  userProfiles,
} from "../db/pulled/schema";
import { pgToIso } from "../pytime";
import { withPending } from "./content-staging";

export const FORMAT_VERSION = "1.0";
const MAX_EXPORT_UNCOMPRESSED_BYTES = Number(process.env.MEMENTO_EXPORT_MAX_BYTES || 1024 * 1024 * 1024);

export interface ExportResult {
  bytes: Uint8Array;
  filename: string;
  counts: Record<string, number>;
}

function anonymizeIp(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  const clean = raw.split("/", 1)[0]!;
  const ver = isIP(clean);
  if (ver === 4) {
    const p = clean.split(".");
    return `${p[0]}.${p[1]}.${p[2]}.0`;
  }
  if (ver === 6) {
    const parts = clean.split(":");
    return `${parts.slice(0, 3).join(":")}::`;
  }
  return raw;
}

export async function buildExport(
  db: Db,
  user: UserRow,
  opts: { includeAccessLogs?: boolean; includeFull?: boolean } = {},
): Promise<ExportResult> {
  const includeAccessLogs = Boolean(opts.includeAccessLogs);
  const includeFull = Boolean(opts.includeFull);
  const enc = new TextEncoder();
  const files: Zippable = {};
  const counts: Record<string, number> = {};
  let runningBytes = 0;

  const checkBudget = (extra: number) => {
    runningBytes += extra;
    if (runningBytes > MAX_EXPORT_UNCOMPRESSED_BYTES) {
      throw new Error(
        `export exceeds ${Math.floor(MAX_EXPORT_UNCOMPRESSED_BYTES / (1024 * 1024))}MB uncompressed budget — try export with smaller scope`,
      );
    }
  };

  const addJsonl = (name: string, rows: Record<string, unknown>[]) => {
    const text = rows.length ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
    const data = enc.encode(text);
    checkBudget(data.byteLength);
    files[name] = [data, { level: 6, mtime: new Date(Date.UTC(2025, 0, 1)) }];
    counts[name.split(".")[0]!] = rows.length;
  };

  // 1) Machines (owner's own only)
  const machRows = await db.select().from(machines).where(eq(machines.userId, user.id));
  const machineIds = machRows.map((m) => m.id);
  addJsonl(
    "machines.jsonl",
    machRows.map((m) => ({
      id: m.id,
      name: m.name,
      collector_version: m.collectorVersion,
      last_heartbeat: pgToIso(m.lastHeartbeat),
      created_at: pgToIso(m.createdAt),
    })),
  );

  // 2) Documents
  const docs = machineIds.length ? await db.select().from(documents).where(inArray(documents.machineId, machineIds)) : [];
  const docIds = new Set(docs.map((d) => d.id));
  const stagedIds = new Set<string>();
  if (docs.length) {
    const stagedRows = await db
      .selectDistinct({ docId: documentPendingDeltas.documentId })
      .from(documentPendingDeltas)
      .where(inArray(documentPendingDeltas.documentId, [...docIds]));
    for (const r of stagedRows) stagedIds.add(r.docId);
  }
  const docRows: Record<string, unknown>[] = [];
  for (const d of docs) {
    docRows.push({
      id: d.id,
      tool_id: d.toolId,
      project_id: d.projectId ?? null,
      machine_id: d.machineId ?? null,
      relative_path: d.relativePath,
      category: d.category,
      content_type: d.contentType,
      title: d.title,
      content: stagedIds.has(d.id) ? await withPending(db, d.id, d.content) : d.content,
      content_hash: d.contentHash,
      file_size_bytes: d.fileSizeBytes,
      ai_summary: d.aiSummary,
      ai_summary_generated_at: pgToIso(d.aiSummaryGeneratedAt),
      source_modified_at: pgToIso(d.sourceModifiedAt),
      synced_at: pgToIso(d.syncedAt),
      created_at: pgToIso(d.createdAt),
    });
  }
  addJsonl("documents.jsonl", docRows);

  // 3) Projects
  const projectIds = [...new Set(docs.map((d) => d.projectId).filter((x): x is string => Boolean(x)))];
  const projRows = projectIds.length ? await db.select().from(projects).where(inArray(projects.id, projectIds)) : [];
  addJsonl(
    "projects.jsonl",
    projRows.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      tool_id: p.toolId,
      source_path: p.sourcePath,
      created_at: pgToIso(p.createdAt),
    })),
  );

  // 4) Conversation messages
  const docIdList = [...docIds];
  const msgs = docIdList.length
    ? await db.select().from(conversationMessages).where(inArray(conversationMessages.documentId, docIdList))
    : [];
  addJsonl(
    "conversation_messages.jsonl",
    msgs.map((m) => ({
      document_id: m.documentId,
      line_number: m.lineNumber,
      message_type: m.messageType,
      role: m.role,
      content: m.content,
      timestamp: pgToIso(m.timestamp),
    })),
  );

  // 5) Document versions
  const vers = docIdList.length
    ? await db.select().from(documentVersions).where(inArray(documentVersions.documentId, docIdList))
    : [];
  addJsonl(
    "document_versions.jsonl",
    vers.map((v) => ({
      document_id: v.documentId,
      content_hash: v.contentHash,
      content_delta: v.contentDelta,
      file_size_bytes: v.fileSizeBytes,
      synced_at: pgToIso(v.syncedAt),
    })),
  );

  // 6) Daily summaries
  const dsRows = await db.select().from(dailySummaries).where(eq(dailySummaries.userId, user.id));
  addJsonl(
    "daily_summaries.jsonl",
    dsRows.map((d) => ({
      summary_date: d.summaryDate,
      tool_id: d.toolId,
      title: d.title,
      summary: d.summary,
      highlights: d.highlights,
      source_document_ids: (d.sourceDocumentIds ?? []).filter((x) => docIds.has(x)),
      created_at: pgToIso(d.createdAt),
    })),
  );

  // 7) Knowledge graph
  const entRows = await db.select().from(knowledgeEntities).where(eq(knowledgeEntities.userId, user.id));
  const entIds = entRows.map((e) => e.id);
  addJsonl(
    "knowledge_entities.jsonl",
    entRows.map((e) => ({
      id: e.id,
      name: e.name,
      entity_type: e.entityType,
      summary: e.summary,
      aliases: Array.isArray(e.aliases) ? e.aliases : [],
      stale_at: pgToIso(e.staleAt),
      stale_reason: e.staleReason,
      created_at: pgToIso(e.createdAt),
      updated_at: pgToIso(e.updatedAt),
    })),
  );

  const relRows = entIds.length
    ? await db
        .select()
        .from(knowledgeRelations)
        .where(and(inArray(knowledgeRelations.sourceId, entIds), inArray(knowledgeRelations.targetId, entIds)))
    : [];
  addJsonl(
    "knowledge_relations.jsonl",
    relRows.map((r) => ({
      source_id: r.sourceId,
      target_id: r.targetId,
      relation_type: r.relationType,
      strength: r.strength,
      created_at: pgToIso(r.createdAt),
    })),
  );

  const obsRows = entIds.length
    ? await db.select().from(knowledgeObservations).where(inArray(knowledgeObservations.entityId, entIds))
    : [];
  addJsonl(
    "knowledge_observations.jsonl",
    obsRows.map((o) => ({
      entity_id: o.entityId,
      content: o.content,
      source_document_id: o.sourceDocumentId && docIds.has(o.sourceDocumentId) ? o.sourceDocumentId : null,
      observed_at: pgToIso(o.observedAt),
    })),
  );

  // 8) Share links
  const slRows = await db.select().from(shareLinks).where(eq(shareLinks.ownerUserId, user.id));
  addJsonl(
    "share_links.jsonl",
    slRows.map((s) => ({
      kind: s.kind,
      target_id: s.targetId,
      title: s.title,
      expires_at: pgToIso(s.expiresAt),
      revoked_at: pgToIso(s.revokedAt),
      created_at: pgToIso(s.createdAt),
    })),
  );

  // 9) Access logs (opt-in)
  if (includeAccessLogs) {
    const alRows = await db.select().from(accessLogs).where(eq(accessLogs.userId, user.id));
    addJsonl(
      "access_logs.jsonl",
      alRows.map((a) => ({
        action: a.action,
        ip_address: anonymizeIp(a.ipAddress),
        user_agent: a.userAgent,
        document_id: a.documentId && docIds.has(a.documentId) ? a.documentId : null,
        metadata: a.metadata && typeof a.metadata === "object" ? a.metadata : null,
        created_at: pgToIso(a.createdAt),
      })),
    );
  } else {
    addJsonl("access_logs.jsonl", []);
  }

  // 9b) Full standalone <-> server migration extras (opt-in via include_full=1, backwards-compatible with 1.0)
  if (includeFull) {
    const [memRows, profRows, skillRows, todoRows, askRows, topicRows, dreamRows, schedRows] = await Promise.all([
      db.select().from(userMemories).where(eq(userMemories.userId, user.id)),
      db.select().from(userProfiles).where(eq(userProfiles.userId, user.id)),
      db.select().from(skills).where(eq(skills.userId, user.id)),
      db.select().from(todos).where(eq(todos.userId, user.id)),
      db.select().from(askConversations).where(eq(askConversations.userId, user.id)),
      db.select().from(correctionTopics).where(eq(correctionTopics.userId, user.id)),
      db.select().from(dreamJournals).where(eq(dreamJournals.userId, user.id)),
      db.select().from(scheduledTasks).where(eq(scheduledTasks.userId, user.id)),
    ]);
    addJsonl(
      "user_memories.jsonl",
      memRows.map((m) => ({
        id: m.id,
        category: m.category,
        key: m.key,
        content: m.content,
        confidence: m.confidence,
        source: m.source,
        tree_path: m.treePath,
        is_folder: m.isFolder,
        status: m.status,
        status_reason: m.statusReason,
        recall_count: m.recallCount,
        last_recalled_at: pgToIso(m.lastRecalledAt),
        created_at: pgToIso(m.createdAt),
        updated_at: pgToIso(m.updatedAt),
      })),
    );
    addJsonl(
      "user_profiles.jsonl",
      profRows.map((p) => ({
        status: p.status,
        version: p.version,
        content: p.content,
        stats: p.stats,
        published_at: pgToIso(p.publishedAt),
        created_at: pgToIso(p.createdAt),
        updated_at: pgToIso(p.updatedAt),
      })),
    );
    addJsonl(
      "skills.jsonl",
      skillRows.map((s) => ({
        slug: s.slug,
        title: s.title,
        description: s.description,
        body: s.body,
        project: s.project,
        status: s.status,
        version: s.version,
        evidence: s.evidence,
        times_seen: s.timesSeen,
        edited_by_user: s.editedByUser,
        published_at: pgToIso(s.publishedAt),
        created_at: pgToIso(s.createdAt),
      })),
    );
    addJsonl(
      "todos.jsonl",
      todoRows.map((t) => ({
        title: t.title,
        detail: t.detail,
        project: t.project,
        status: t.status,
        due_at: pgToIso(t.dueAt),
        source: t.source,
        evidence: t.evidence,
        fingerprint: t.fingerprint,
        closed_at: pgToIso(t.closedAt),
        close_evidence: t.closeEvidence,
        created_at: pgToIso(t.createdAt),
      })),
    );
    addJsonl(
      "ask_conversations.jsonl",
      askRows.map((a) => ({
        title: a.title,
        turns: a.turns,
        message_count: a.messageCount,
        device_id: a.deviceId,
        cwd: a.cwd,
        config: a.config,
        created_at: pgToIso(a.createdAt),
        updated_at: pgToIso(a.updatedAt),
      })),
    );
    addJsonl(
      "correction_topics.jsonl",
      topicRows.map((c) => ({
        statement: c.statement,
        category: c.category,
        status: c.status,
        scope: c.scope,
        times: c.times,
        first_at: pgToIso(c.firstAt),
        last_at: pgToIso(c.lastAt),
        accepted_at: pgToIso(c.acceptedAt),
        created_at: pgToIso(c.createdAt),
      })),
    );
    addJsonl(
      "dream_journals.jsonl",
      dreamRows.map((d) => ({
        dream_date: d.dreamDate,
        stage_metrics: d.stageMetrics,
        light_sleep_notes: d.lightSleepNotes,
        rem_reflections: d.remReflections,
        deep_consolidations: d.deepConsolidations,
        report_markdown: d.reportMarkdown,
        created_at: pgToIso(d.createdAt),
      })),
    );
    addJsonl(
      "scheduled_tasks.jsonl",
      schedRows.map((st) => ({
        title: st.title,
        device: st.device,
        agent: st.agent,
        prompt: st.prompt,
        cwd: st.cwd,
        permission_mode: st.permissionMode,
        schedule: st.schedule,
        tz_offset_min: st.tzOffsetMin,
        enabled: st.enabled,
        created_at: pgToIso(st.createdAt),
      })),
    );
    const settingsPayload = enc.encode(
      JSON.stringify(
        {
          notify_settings: user.notifySettings ?? {},
          proactive_settings: user.proactiveSettings ?? {},
          avatar_settings: user.avatarSettings ?? {},
          collect_settings: user.collectSettings ?? {},
        },
        null,
        2,
      ),
    );
    checkBudget(settingsPayload.byteLength);
    files["user_settings.json"] = [settingsPayload, { level: 6, mtime: new Date(Date.UTC(2025, 0, 1)) }];
  }

  // 10) Manifest
  const manifest = {
    format_version: FORMAT_VERSION,
    exported_at: new Date().toISOString().replace("Z", "+00:00"),
    options: { include_access_logs: includeAccessLogs, ...(includeFull ? { include_full: true } : {}) },
    counts,
    compat: { major: 1, min_importer_version: "1.0" },
  };
  files["manifest.json"] = [enc.encode(JSON.stringify(manifest, null, 2)), { level: 6, mtime: new Date(Date.UTC(2025, 0, 1)) }];

  const bytes = zipSync(files);
  const now = new Date();
  const datePart = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;
  const safeEmail = [...(user.email || "user").split("@", 1)[0]!].filter((ch) => /[a-zA-Z0-9_-]/.test(ch)).join("");
  return {
    bytes,
    filename: `memento-export-${safeEmail}-${datePart}.zip`,
    counts,
  };
}
