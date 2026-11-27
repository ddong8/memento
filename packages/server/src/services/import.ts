// Account-level ZIP import with zip-bomb caps and inline FTS indexing (server/server/services/import_service.py).
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { unzipSync } from "fflate";

import type { UserRow } from "../auth/current-user";
import { withoutNul, type Db } from "../db/client";
import {
  accessLogs,
  conversationMessages,
  dailySummaries,
  documents,
  documentSearch,
  documentVersions,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  projects,
  shareLinks,
  tools,
} from "../db/pulled/schema";
import { tokenizeForIndex } from "./tokenize";

const MAX_ENTRY_BYTES = Number(process.env.MEMENTO_IMPORT_MAX_ENTRY_BYTES || 512 * 1024 * 1024);
const MAX_TOTAL_BYTES = Number(process.env.MEMENTO_IMPORT_MAX_TOTAL_BYTES || 2 * 1024 * 1024 * 1024);
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_RATIO = 200;

const ALLOWED_MEMBERS = new Set([
  "manifest.json",
  "machines.jsonl",
  "projects.jsonl",
  "documents.jsonl",
  "conversation_messages.jsonl",
  "document_versions.jsonl",
  "daily_summaries.jsonl",
  "knowledge_entities.jsonl",
  "knowledge_relations.jsonl",
  "knowledge_observations.jsonl",
  "share_links.jsonl",
  "access_logs.jsonl",
]);

const VALID_SHARE_KINDS = new Set(["timeline", "daily", "memory"]);

const TOOL_DEFAULTS: Record<string, string> = {
  claude_code: "Claude Code",
  openclaw: "OpenClaw",
  codex: "Codex",
  antigravity: "Antigravity",
  obsidian: "Obsidian",
  cursor: "Cursor",
  hermes: "Hermes",
};

export class ImportPackageError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ImportPackageError";
  }
}

export interface ImportResult {
  machine_id: string;
  counts: Record<string, number>;
  warnings: string[];
}

function isZipNoise(name: string): boolean {
  return (
    name.endsWith("/") ||
    name.startsWith("__MACOSX/") ||
    name === ".DS_Store" ||
    name.endsWith("/.DS_Store") ||
    name === "Thumbs.db" ||
    name.endsWith("/Thumbs.db")
  );
}

function safeName(name: string): boolean {
  if (!name || name !== name.trim()) return false;
  if (name.includes("\\") || name.includes("\x00")) return false;
  if (name.startsWith("/") || name.split("/").includes("..")) return false;
  return true;
}

function parseJsonl(blob: Uint8Array): Record<string, unknown>[] {
  const dec = new TextDecoder("utf-8");
  const text = dec.decode(blob);
  const out: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      throw new ImportPackageError(`json line too large (cap ${MAX_LINE_BYTES})`);
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
    } catch (e) {
      throw new ImportPackageError(`malformed JSONL line: ${(e as Error).message}`);
    }
  }
  return out;
}

function parseIsoOrNull(v: unknown): string | null {
  if (!v || typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseDateOrNull(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function base32Lower(buf: Buffer): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export async function runImport(db: Db, user: UserRow, zipBytes: Uint8Array): Promise<ImportResult> {
  let totalUncompressed = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes, {
      filter(file) {
        if (isZipNoise(file.name)) return false;
        if (!safeName(file.name)) throw new ImportPackageError(`unsafe member name: ${file.name}`);
        if (!ALLOWED_MEMBERS.has(file.name)) throw new ImportPackageError(`unexpected zip members: ['${file.name}']…`);
        if (file.originalSize > MAX_ENTRY_BYTES) {
          throw new ImportPackageError(`${file.name}: uncompressed size ${file.originalSize} > entry cap ${MAX_ENTRY_BYTES}`);
        }
        if (file.size > 0 && file.originalSize / file.size > MAX_RATIO) {
          throw new ImportPackageError(`${file.name}: compression ratio exceeds cap (zip-bomb defense)`);
        }
        totalUncompressed += file.originalSize;
        if (totalUncompressed > MAX_TOTAL_BYTES) {
          throw new ImportPackageError(`total uncompressed bytes would exceed ${MAX_TOTAL_BYTES} cap`);
        }
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ImportPackageError) throw e;
    throw new ImportPackageError(`not a valid zip: ${(e as Error).message}`);
  }

  if (!entries["manifest.json"]) throw new ImportPackageError("missing manifest.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"])) as Record<string, unknown>;
  } catch (e) {
    throw new ImportPackageError(`manifest.json malformed: ${(e as Error).message}`);
  }
  const fmtVer = String(manifest.format_version ?? "");
  if (fmtVer.split(".")[0] !== "1") {
    throw new ImportPackageError(`unsupported format_version '${fmtVer}'; this server reads major 1.x`);
  }

  const load = (name: string) => (entries[name] ? parseJsonl(entries[name]!) : []);
  const counts: Record<string, number> = {};
  const warnings: string[] = [];

  const now = new Date();
  const tsShort = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")} ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const importName = (orig: unknown): string => {
    let clean = String(orig ?? "").trim();
    while (true) {
      if (clean.startsWith("Imported: ")) {
        clean = clean.slice("Imported: ".length).trimStart();
        continue;
      }
      if (clean.startsWith("Imported on ")) {
        clean = "";
        break;
      }
      break;
    }
    clean = clean.slice(0, 120);
    return clean ? `Imported ${tsShort}: ${clean}` : `Imported ${tsShort}`;
  };

  // Run the whole restore inside one DB transaction so failures roll back cleanly
  const fallbackMachineId = randomUUID();
  await db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;

    // 2) Machines
    await dbTx.insert(machines).values({
      id: fallbackMachineId,
      name: importName(null),
      collectorTokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      collectorVersion: null,
      userId: user.id,
    });
    const machRows = load("machines.jsonl");
    const machineIdMap = new Map<string, string>();
    for (const r of machRows) {
      const oldId = typeof r.id === "string" ? r.id : "";
      if (!oldId) continue;
      const newId = randomUUID();
      await dbTx.insert(machines).values({
        id: newId,
        name: importName(r.name),
        collectorTokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        collectorVersion: typeof r.collector_version === "string" ? r.collector_version : null,
        userId: user.id,
      });
      machineIdMap.set(oldId, newId);
    }
    counts.machines = machineIdMap.size + 1;

    // 3) Tools
    const docsRows = load("documents.jsonl");
    const dsRows = load("daily_summaries.jsonl");
    const distinctTools = new Set<string>();
    for (const r of docsRows) if (typeof r.tool_id === "string" && r.tool_id) distinctTools.add(r.tool_id);
    for (const r of dsRows) if (typeof r.tool_id === "string" && r.tool_id) distinctTools.add(r.tool_id);
    if (distinctTools.size) {
      const existing = new Set((await dbTx.select({ id: tools.id }).from(tools).where(inArray(tools.id, [...distinctTools]))).map((t) => t.id));
      for (const tid of distinctTools) {
        if (existing.has(tid)) continue;
        const displayName = TOOL_DEFAULTS[tid] ?? tid.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
        await dbTx
          .insert(tools)
          .values({ id: tid, displayName, totalFiles: 0, totalSizeBytes: 0 })
          .onConflictDoNothing({ target: tools.id });
      }
    }

    // 4) Projects
    const projRows = load("projects.jsonl");
    const projectIdMap = new Map<string, string>();
    for (const r of projRows) {
      const oldId = typeof r.id === "string" ? r.id : "";
      if (!oldId) continue;
      const newId = randomUUID();
      const short = randomUUID().replaceAll("-", "").slice(0, 8);
      const baseSlug = String(r.slug || "imported").slice(0, 200);
      await dbTx.insert(projects).values(
        withoutNul({
          id: newId,
          slug: `${baseSlug}-imp-${short}`,
          title: String(r.title || "").slice(0, 500) || "Imported project",
          toolId: typeof r.tool_id === "string" ? r.tool_id : null,
          sourcePath: typeof r.source_path === "string" ? r.source_path : null,
          visibility: "private",
        }),
      );
      projectIdMap.set(oldId, newId);
    }
    counts.projects = projectIdMap.size;

    // 5) Documents + inline FTS
    const documentIdMap = new Map<string, string>();
    let insertedDocs = 0;
    for (const r of docsRows) {
      const oldId = typeof r.id === "string" ? r.id : "";
      if (!oldId) continue;
      const toolId = typeof r.tool_id === "string" ? r.tool_id : "";
      if (!toolId) {
        warnings.push(`document ${oldId} missing tool_id; skipped`);
        continue;
      }
      const newId = randomUUID();
      documentIdMap.set(oldId, newId);
      const projId = typeof r.project_id === "string" ? (projectIdMap.get(r.project_id) ?? null) : null;
      const content = String(r.content ?? "");
      const title = typeof r.title === "string" ? r.title : null;
      const tsvInput = tokenizeForIndex(`${title ?? ""} ${content}`);

      await dbTx.insert(documents).values(
        withoutNul({
          id: newId,
          toolId,
          projectId: projId,
          machineId: (typeof r.machine_id === "string" ? machineIdMap.get(r.machine_id) : undefined) ?? fallbackMachineId,
          relativePath: String(r.relative_path || `imported/${newId}`),
          category: String(r.category || "memory"),
          contentType: String(r.content_type || "text"),
          title,
          content,
          contentHash: String(r.content_hash || createHash("sha256").update(content).digest("hex")),
          fileSizeBytes: Number(r.file_size_bytes) || Buffer.byteLength(content, "utf8"),
          metadata: {},
          renderedHtml: null,
          aiSummary: typeof r.ai_summary === "string" ? r.ai_summary : null,
          aiSummaryGeneratedAt: parseIsoOrNull(r.ai_summary_generated_at),
          visibility: "private",
          needsReview: false,
          embeddingStatus: "pending",
          embeddingAttempts: 0,
          knowledgeStatus: "pending",
          knowledgeAttempts: 0,
          sourceModifiedAt: parseIsoOrNull(r.source_modified_at),
          syncedAt: parseIsoOrNull(r.synced_at) ?? new Date().toISOString(),
        }),
      );
      if (tsvInput) {
        await dbTx.insert(documentSearch).values({
          documentId: newId,
          contentTsv: sql`to_tsvector('simple', ${tsvInput})` as unknown as string,
        });
      }
      insertedDocs++;
    }
    counts.documents = insertedDocs;

    // 6) Conversation messages
    const msgRows = load("conversation_messages.jsonl");
    let insertedMsgs = 0;
    const msgBatch: (typeof conversationMessages.$inferInsert)[] = [];
    const flushMsgs = async () => {
      if (!msgBatch.length) return;
      await dbTx.insert(conversationMessages).values(msgBatch);
      insertedMsgs += msgBatch.length;
      msgBatch.length = 0;
    };
    for (const r of msgRows) {
      const newDoc = typeof r.document_id === "string" ? documentIdMap.get(r.document_id) : undefined;
      if (!newDoc) continue;
      msgBatch.push(
        withoutNul({
          documentId: newDoc,
          lineNumber: Number(r.line_number) || 0,
          messageType: typeof r.message_type === "string" ? r.message_type : null,
          role: typeof r.role === "string" ? r.role : null,
          content: String(r.content ?? ""),
          metadata: {},
          timestamp: parseIsoOrNull(r.timestamp),
        }),
      );
      if (msgBatch.length >= 1000) await flushMsgs();
    }
    await flushMsgs();
    counts.conversation_messages = insertedMsgs;

    // 7) Document versions
    const verRows = load("document_versions.jsonl");
    let insertedVers = 0;
    const verBatch: (typeof documentVersions.$inferInsert)[] = [];
    const flushVers = async () => {
      if (!verBatch.length) return;
      await dbTx.insert(documentVersions).values(verBatch);
      insertedVers += verBatch.length;
      verBatch.length = 0;
    };
    for (const r of verRows) {
      const newDoc = typeof r.document_id === "string" ? documentIdMap.get(r.document_id) : undefined;
      if (!newDoc) continue;
      verBatch.push(
        withoutNul({
          documentId: newDoc,
          contentHash: String(r.content_hash ?? ""),
          contentDelta: typeof r.content_delta === "string" ? r.content_delta : null,
          fileSizeBytes: typeof r.file_size_bytes === "number" ? r.file_size_bytes : null,
          syncedAt: parseIsoOrNull(r.synced_at) ?? new Date().toISOString(),
        }),
      );
      if (verBatch.length >= 1000) await flushVers();
    }
    await flushVers();
    counts.document_versions = insertedVers;

    // 8) Daily summaries
    let insertedDs = 0;
    for (const r of dsRows) {
      const sdate = parseDateOrNull(r.summary_date);
      if (!sdate) continue;
      const sdIds = (Array.isArray(r.source_document_ids) ? r.source_document_ids : [])
        .map((x) => (typeof x === "string" ? documentIdMap.get(x) : undefined))
        .filter((x): x is string => Boolean(x));
      await dbTx
        .insert(dailySummaries)
        .values(
          withoutNul({
            id: randomUUID(),
            userId: user.id,
            summaryDate: sdate,
            toolId: typeof r.tool_id === "string" ? r.tool_id : null,
            title: String(r.title || "Daily summary").slice(0, 1000),
            summary: String(r.summary ?? ""),
            highlights: r.highlights && typeof r.highlights === "object" && !Array.isArray(r.highlights) ? r.highlights : null,
            sourceDocumentIds: sdIds,
          }),
        )
        .onConflictDoNothing({ target: [dailySummaries.userId, dailySummaries.summaryDate, dailySummaries.toolId] });
      insertedDs++;
    }
    counts.daily_summaries = insertedDs;

    // 9) Knowledge entities
    const entRows = load("knowledge_entities.jsonl");
    const entityIdMap = new Map<string, string>();
    for (const r of entRows) {
      const oldId = typeof r.id === "string" ? r.id : "";
      const name = typeof r.name === "string" ? r.name : "";
      const etype = typeof r.entity_type === "string" ? r.entity_type : "";
      if (!oldId || !name || !etype) continue;
      const newId = randomUUID();
      const [inserted] = await dbTx
        .insert(knowledgeEntities)
        .values(
          withoutNul({
            id: newId,
            userId: user.id,
            name,
            entityType: etype,
            summary: typeof r.summary === "string" ? r.summary : null,
            aliases: Array.isArray(r.aliases) ? r.aliases : [],
            staleAt: parseIsoOrNull(r.stale_at),
            staleReason: typeof r.stale_reason === "string" ? r.stale_reason : null,
          }),
        )
        .onConflictDoNothing({ target: [knowledgeEntities.userId, knowledgeEntities.name, knowledgeEntities.entityType] })
        .returning({ id: knowledgeEntities.id });
      if (inserted) {
        entityIdMap.set(oldId, inserted.id);
      } else {
        const [ex] = await dbTx
          .select({ id: knowledgeEntities.id })
          .from(knowledgeEntities)
          .where(and(eq(knowledgeEntities.userId, user.id), eq(knowledgeEntities.name, name), eq(knowledgeEntities.entityType, etype)))
          .limit(1);
        if (ex) entityIdMap.set(oldId, ex.id);
      }
    }
    counts.knowledge_entities = entityIdMap.size;

    // 10) Knowledge relations
    const relRows = load("knowledge_relations.jsonl");
    let insertedRel = 0;
    if (relRows.length && entityIdMap.size) {
      const entIds = [...entityIdMap.values()];
      const existing = await dbTx
        .select({ s: knowledgeRelations.sourceId, t: knowledgeRelations.targetId, k: knowledgeRelations.relationType })
        .from(knowledgeRelations)
        .where(and(inArray(knowledgeRelations.sourceId, entIds), inArray(knowledgeRelations.targetId, entIds)));
      const existingPairs = new Set(existing.map((e) => `${e.s}|${e.t}|${e.k}`));
      for (const r of relRows) {
        const sNew = typeof r.source_id === "string" ? entityIdMap.get(r.source_id) : undefined;
        const tNew = typeof r.target_id === "string" ? entityIdMap.get(r.target_id) : undefined;
        const kind = typeof r.relation_type === "string" ? r.relation_type : "";
        if (!sNew || !tNew || !kind) continue;
        const key = `${sNew}|${tNew}|${kind}`;
        if (existingPairs.has(key)) continue;
        existingPairs.add(key);
        await dbTx.insert(knowledgeRelations).values({
          id: randomUUID(),
          sourceId: sNew,
          targetId: tNew,
          relationType: kind,
          strength: Number(r.strength) || 1,
        });
        insertedRel++;
      }
    }
    counts.knowledge_relations = insertedRel;

    // 11) Observations
    const obsRows = load("knowledge_observations.jsonl");
    let insertedObs = 0;
    const obsBatch: (typeof knowledgeObservations.$inferInsert)[] = [];
    const flushObs = async () => {
      if (!obsBatch.length) return;
      await dbTx.insert(knowledgeObservations).values(obsBatch);
      insertedObs += obsBatch.length;
      obsBatch.length = 0;
    };
    for (const r of obsRows) {
      const ent = typeof r.entity_id === "string" ? entityIdMap.get(r.entity_id) : undefined;
      const content = typeof r.content === "string" ? r.content : "";
      if (!ent || !content) continue;
      obsBatch.push(
        withoutNul({
          id: randomUUID(),
          entityId: ent,
          content,
          sourceDocumentId: typeof r.source_document_id === "string" ? (documentIdMap.get(r.source_document_id) ?? null) : null,
          observedAt: parseIsoOrNull(r.observed_at) ?? new Date().toISOString(),
        }),
      );
      if (obsBatch.length >= 1000) await flushObs();
    }
    await flushObs();
    counts.knowledge_observations = insertedObs;

    // 12) Share links
    const slRows = load("share_links.jsonl");
    let insertedSl = 0;
    for (const r of slRows) {
      const kind = typeof r.kind === "string" ? r.kind : "";
      if (!VALID_SHARE_KINDS.has(kind)) {
        warnings.push(`share_link kind '${kind}' unknown; skipped`);
        continue;
      }
      let targetId = String(r.target_id ?? "");
      if (kind === "timeline") {
        const mapped = projectIdMap.get(targetId);
        if (!mapped) {
          warnings.push(`timeline share for project ${targetId} skipped (project not in import)`);
          continue;
        }
        targetId = mapped;
      } else if (kind === "daily") {
        if (targetId.length !== 10) {
          warnings.push(`daily share target_id '${targetId}' invalid; skipped`);
          continue;
        }
      } else if (kind === "memory" && targetId !== "all") {
        warnings.push(`memory share target_id '${targetId}' unsupported; skipped`);
        continue;
      }
      await dbTx.insert(shareLinks).values(
        withoutNul({
          id: randomUUID(),
          token: base32Lower(randomBytes(24)),
          kind,
          targetId,
          ownerUserId: user.id,
          targetUserId: null,
          title: typeof r.title === "string" ? r.title : null,
          expiresAt: parseIsoOrNull(r.expires_at),
          revokedAt: parseIsoOrNull(r.revoked_at),
        }),
      );
      insertedSl++;
    }
    counts.share_links = insertedSl;

    // 13) Access logs
    const alRows = load("access_logs.jsonl");
    let insertedAl = 0;
    const alBatch: (typeof accessLogs.$inferInsert)[] = [];
    const flushAl = async () => {
      if (!alBatch.length) return;
      await dbTx.insert(accessLogs).values(alBatch);
      insertedAl += alBatch.length;
      alBatch.length = 0;
    };
    for (const r of alRows) {
      const action = typeof r.action === "string" ? r.action : "";
      if (!action) continue;
      const oldDoc = typeof r.document_id === "string" ? r.document_id : null;
      const newDoc = oldDoc ? (documentIdMap.get(oldDoc) ?? null) : null;
      let meta = r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata) ? { ...(r.metadata as Record<string, unknown>) } : {};
      if (oldDoc && !newDoc) meta = { ...meta, imported_from_doc: oldDoc };
      alBatch.push(
        withoutNul({
          userId: user.id,
          documentId: newDoc,
          action,
          ipAddress: typeof r.ip_address === "string" ? r.ip_address : null,
          userAgent: typeof r.user_agent === "string" ? r.user_agent : null,
          metadata: meta,
          createdAt: parseIsoOrNull(r.created_at) ?? new Date().toISOString(),
        }),
      );
      if (alBatch.length >= 1000) await flushAl();
    }
    await flushAl();
    counts.access_logs = insertedAl;
  });

  return { machine_id: fallbackMachineId, counts, warnings };
}
