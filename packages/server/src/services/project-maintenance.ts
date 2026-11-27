// Background maintenance helpers for projects: deduplication, consolidation & document reconciliation
// (server/server/services/project_maintenance.py).
import { randomUUID } from "node:crypto";

import { and, count, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client";
import { documents, machines, projects } from "../db/pulled/schema";
import { cluster } from "./cluster";
import {
  IGNORE_PROJECT_NAMES,
  isInvalidProjectName,
  isJunkOrUuidTitle,
  isJunkProject,
  prettifyProjectName,
} from "./ingest-service";

const lastReconcileTime = new Map<string, number>();
const RECONCILE_COOLDOWN_SEC = 120;
let lastConsolidationTime = 0;
const CONSOLIDATION_INTERVAL_SEC = 600;

export async function consolidateProjectsIfNeeded(db: Db, force = false): Promise<void> {
  const now = Date.now() / 1000;
  if (!force && now - lastConsolidationTime < CONSOLIDATION_INTERVAL_SEC) return;
  lastConsolidationTime = now;
  if (!force && !(await cluster.tryLock("project-consolidation-due", CONSOLIDATION_INTERVAL_SEC))) return;
  const running = await cluster.mutex("project-consolidation");
  if (!running) return;
  try {
    const allProjects = await db.select().from(projects);
    for (const p of allProjects) {
      const rawName = p.slug.includes("/") ? p.slug.split("/").pop()! : p.slug;
      const stripAll = (s: string) => s.replace(/^[-_./\\"'` ]+|[-_./\\"'` ]+$/g, "");
      if (
        isInvalidProjectName(rawName) ||
        isInvalidProjectName(p.title) ||
        IGNORE_PROJECT_NAMES.has(p.title) ||
        !stripAll(p.title) ||
        !stripAll(rawName)
      ) {
        await db.update(documents).set({ projectId: null }).where(eq(documents.projectId, p.id));
        await db.delete(projects).where(eq(projects.id, p.id));
        continue;
      }

      const cleanName = rawName.replace(/^[-"'` ]+|[-"'` ]+$/g, "");
      const prettified = prettifyProjectName(cleanName).replace(/^[-"'` ]+|[-"'` ]+$/g, "");
      const cleanTitle = (p.title || "").replace(/^[-"'` ]+|[-"'` ]+$/g, "");
      const isDirty =
        prettified !== rawName ||
        p.title !== cleanTitle ||
        (p.title || "").includes('"') ||
        (p.title || "").includes("'") ||
        p.slug.includes('"') ||
        p.slug.includes("'");

      if (isDirty && !isInvalidProjectName(prettified)) {
        const canonicalSlug = `${p.toolId}/${prettified}`;
        const [canonical] = await db.select().from(projects).where(eq(projects.slug, canonicalSlug)).limit(1);
        if (canonical && canonical.id !== p.id) {
          await db.update(documents).set({ projectId: canonical.id }).where(eq(documents.projectId, p.id));
          await db.delete(projects).where(eq(projects.id, p.id));
        } else {
          await db.update(projects).set({ slug: canonicalSlug, title: prettified }).where(eq(projects.id, p.id));
        }
      }
    }

    // Deduplicate hyphen vs underscore equivalents
    const curProjs = await db.select().from(projects);
    const projBySlug = new Map(curProjs.map((p) => [p.slug, p]));
    const byEquiv = new Map<string, (typeof curProjs)[number][]>();
    for (const p of curProjs) {
      const k = `${p.toolId}|${(p.slug.split("/").pop() || "").replaceAll("-", "_").toLowerCase()}`;
      const list = byEquiv.get(k) ?? [];
      list.push(p);
      byEquiv.set(k, list);
    }

    for (const plist of byEquiv.values()) {
      if (plist.length <= 1) continue;
      const pids = plist.map((x) => x.id);
      const cntRows = await db
        .select({ pid: documents.projectId, n: count(documents.id) })
        .from(documents)
        .where(inArray(documents.projectId, pids))
        .groupBy(documents.projectId);
      const cntMap = new Map(cntRows.map((r) => [r.pid, Number(r.n ?? 0)]));
      const sorted = [...plist].sort((a, b) => (cntMap.get(b.id) ?? 0) - (cntMap.get(a.id) ?? 0));
      const canon = sorted[0]!;
      for (const redundant of sorted.slice(1)) {
        await db.update(documents).set({ projectId: canon.id }).where(eq(documents.projectId, redundant.id));
        await db.delete(projects).where(eq(projects.id, redundant.id));
        projBySlug.delete(redundant.slug);
      }
    }

    // Adopt orphaned conversation docs
    const orphaned = await db
      .select({ id: documents.id, toolId: documents.toolId, metadata: documents.metadata, relativePath: documents.relativePath })
      .from(documents)
      .where(and(isNull(documents.projectId), eq(documents.category, "conversation")));
    for (const od of orphaned) {
      const md = od.metadata && typeof od.metadata === "object" ? (od.metadata as Record<string, unknown>) : null;
      let pCand = typeof md?.project_hash === "string" ? md.project_hash : "";
      if (!pCand && od.relativePath.startsWith("projects/")) {
        const parts = od.relativePath.split("/");
        if (parts.length >= 3) pCand = parts[1]!;
      }
      if (pCand) {
        const prettified = prettifyProjectName(pCand);
        if (!isInvalidProjectName(prettified)) {
          const canon = projBySlug.get(`${od.toolId}/${prettified}`);
          if (canon) {
            await db.update(documents).set({ projectId: canon.id }).where(eq(documents.id, od.id));
          }
        }
      }
    }

    // Auto-heal misassigned conversation documents
    const misassigned = await db
      .select({
        docId: documents.id,
        docToolId: documents.toolId,
        metadata: documents.metadata,
        curProjId: projects.id,
        curProjSlug: projects.slug,
        curProjTitle: projects.title,
      })
      .from(documents)
      .innerJoin(projects, eq(documents.projectId, projects.id))
      .where(and(eq(documents.category, "conversation"), isNotNull(documents.metadata)));

    for (const row of misassigned) {
      const md = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null;
      if (!md) continue;
      let pCand = typeof md.project_hash === "string" ? md.project_hash : "";
      if (!pCand && typeof md.project_path === "string" && md.project_path) {
        pCand = md.project_path.replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop() || "";
      }
      if (!pCand) continue;
      const prettified = prettifyProjectName(String(pCand)).replace(/^[-"'` ]+|[-"'` ]+$/g, "");
      if (!prettified || isInvalidProjectName(prettified) || isJunkProject(prettified, typeof md.project_path === "string" ? md.project_path : null)) {
        continue;
      }
      const curSlugName = (row.curProjSlug.split("/").pop() || "").toLowerCase();
      const candLower = prettified.toLowerCase();
      if (candLower !== row.curProjTitle.toLowerCase() && candLower !== curSlugName) {
        const correct = projBySlug.get(`${row.docToolId}/${prettified}`);
        if (correct && correct.id !== row.curProjId) {
          await db.update(documents).set({ projectId: correct.id }).where(eq(documents.id, row.docId));
        }
      }
    }

    // Auto-heal NULL machine_id
    const allMachines = await db.select().from(machines);
    const macMini = allMachines.find((m) => (m.name || "").toLowerCase().includes("mac-mini") || (m.name || "").toLowerCase().includes("mini"));
    const macbook = allMachines.find((m) => (m.name || "").toLowerCase().includes("macbook"));
    const winM = allMachines.find((m) => (m.name || "").toLowerCase().includes("windows"));

    if (macMini) {
      await db
        .update(documents)
        .set({ machineId: macMini.id })
        .where(
          and(
            isNull(documents.machineId),
            or(ilike(documents.relativePath, "%haixingdong%"), sql`${documents.metadata}->>'project_path' ILIKE '%haixingdong%'`),
          ),
        );
    }
    if (macbook) {
      await db
        .update(documents)
        .set({ machineId: macbook.id })
        .where(
          and(
            isNull(documents.machineId),
            or(ilike(documents.relativePath, "%donghaixing%"), sql`${documents.metadata}->>'project_path' ILIKE '%donghaixing%'`),
          ),
        );
    }
    if (winM) {
      await db
        .update(documents)
        .set({ machineId: winM.id })
        .where(
          and(
            isNull(documents.machineId),
            or(
              sql`${documents.metadata}->>'project_path' ILIKE '%d:/%'`,
              sql`${documents.metadata}->>'project_path' ILIKE '%c:/%'`,
              sql`${documents.metadata}->>'project_path' ILIKE '%d:\\%'`,
              sql`${documents.metadata}->>'project_path' ILIKE '%c:\\%'`,
            ),
          ),
        );
    }
  } catch (e) {
    console.warn("[projects] consolidation error:", (e as Error).message);
  } finally {
    await running.release();
  }
}

export async function reconcileProjectDocuments(
  db: Db,
  targetProject: typeof projects.$inferSelect,
  targetMid: string | null = null,
  force = false,
): Promise<number> {
  const now = Date.now() / 1000;
  const last = lastReconcileTime.get(targetProject.id) ?? 0;
  if (!force && now - last < RECONCILE_COOLDOWN_SEC) return 0;
  lastReconcileTime.set(targetProject.id, now);
  if (!force && !(await cluster.tryLock(`reconcile:${targetProject.id}`, RECONCILE_COOLDOWN_SEC))) return 0;

  try {
    const toolId = targetProject.toolId;
    if (!toolId) return 0;
    const rawSlugName = targetProject.slug.includes("/") ? targetProject.slug.split("/").pop()! : targetProject.slug;
    const cleanTitle = prettifyProjectName(targetProject.title || rawSlugName);
    if (isInvalidProjectName(cleanTitle)) return 0;

    const candTitles = [...new Set([cleanTitle, cleanTitle.replaceAll("_", "-"), cleanTitle.replaceAll("-", "_")])].filter(
      (t) => t && !isInvalidProjectName(t),
    );
    const fragConds: SQL[] = [inArray(projects.slug, [`${toolId}/d:`, `${toolId}/c:`, `${toolId}/d`, `${toolId}/c`])];
    for (const ct of candTitles) {
      fragConds.push(
        ilike(projects.slug, `%-${ct}`),
        ilike(projects.slug, `%/${ct}`),
        ilike(projects.title, `%-${ct}`),
        ilike(projects.title, ct),
        ilike(projects.slug, `${toolId}/${ct}`),
      );
    }

    const fragRows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.toolId, toolId), ne(projects.id, targetProject.id), or(...fragConds)));
    const fragIds = fragRows.map((fp) => fp.id);

    const docConds: SQL[] = [];
    for (const ct of candTitles) {
      docConds.push(
        ilike(documents.relativePath, `%/${ct}/%`),
        ilike(documents.relativePath, `%-${ct}/%`),
        sql`${documents.metadata}->>'project_hash' = ${ct}`,
        sql`${documents.metadata}->>'project_path' ILIKE ${`%${ct}`}`,
        sql`${documents.metadata}->>'project_path' ILIKE ${`%${ct}/%`}`,
        sql`${documents.metadata}->>'project_path' ILIKE ${`%${ct}\\%`}`,
      );
      if (toolId === "antigravity") {
        docConds.push(
          ilike(documents.content, `%Active Workspaces:%/${ct}%`),
          ilike(documents.content, `%Command Working Directory:%/${ct}%`),
          ilike(documents.content, `%"cwd"%/${ct}%`),
          ilike(documents.content, `%"Cwd"%/${ct}%`),
        );
      }
    }
    let adoptCond = or(...docConds)!;
    if (fragIds.length) adoptCond = or(adoptCond, inArray(documents.projectId, fragIds))!;

    const matchWhere: SQL[] = [
      eq(documents.toolId, toolId),
      eq(documents.category, "conversation"),
      fragIds.length ? or(isNull(documents.projectId), inArray(documents.projectId, fragIds))! : isNull(documents.projectId),
      adoptCond,
    ];
    if (targetMid) matchWhere.push(or(eq(documents.machineId, targetMid), isNull(documents.machineId))!);

    const docsToAdopt = await db
      .select({ id: documents.id, machineId: documents.machineId, metadata: documents.metadata })
      .from(documents)
      .where(and(...matchWhere));

    let adoptedCount = docsToAdopt.length;
    if (docsToAdopt.length) {
      for (const d of docsToAdopt) {
        const patch: Partial<typeof documents.$inferInsert> = { projectId: targetProject.id };
        if (targetMid && !d.machineId) patch.machineId = targetMid;
        await db.update(documents).set(patch).where(eq(documents.id, d.id));
      }
      const sids = docsToAdopt
        .map((d) => (d.metadata && typeof d.metadata === "object" ? (d.metadata as Record<string, unknown>).session_id : null))
        .filter((s): s is string => typeof s === "string" && Boolean(s));
      if (sids.length) {
        await db
          .update(documents)
          .set({ projectId: targetProject.id })
          .where(
            and(
              eq(documents.toolId, toolId),
              isNull(documents.projectId),
              sql`${documents.metadata}->>'session_id' = ANY(${sql.raw(`ARRAY[${sids.map((s) => `'${s.replaceAll("'", "''")}'`).join(",")}]`)})`,
            ),
          );
      }
    }

    // Materialize missing parent conversation docs for subagents
    const subWhere: SQL[] = [
      eq(documents.projectId, targetProject.id),
      eq(documents.category, "conversation"),
      ilike(documents.relativePath, "%/subagents/%"),
    ];
    if (targetMid) subWhere.push(eq(documents.machineId, targetMid));
    const subRows = await db
      .select({
        id: documents.id,
        relativePath: documents.relativePath,
        title: documents.title,
        machineId: documents.machineId,
        syncedAt: documents.syncedAt,
        sourceModifiedAt: documents.sourceModifiedAt,
      })
      .from(documents)
      .where(and(...subWhere));

    const parentToSubs = new Map<string, typeof subRows>();
    for (const s of subRows) {
      const rp = s.relativePath || "";
      if (rp.includes("/subagents/")) {
        const parentBase = `${rp.split("/subagents/")[0]}.jsonl`;
        const list = parentToSubs.get(parentBase) ?? [];
        list.push(s);
        parentToSubs.set(parentBase, list);
      }
    }

    for (const [parentBase, sDocs] of parentToSubs) {
      const [existing] = await db
        .select({ id: documents.id, projectId: documents.projectId })
        .from(documents)
        .where(eq(documents.relativePath, parentBase))
        .limit(1);
      if (!existing) {
        const firstSub = sDocs[0]!;
        const sessionId = parentBase.split("/").pop()!.replace(/\.jsonl$/, "");
        let parentTitle = "";
        const [memDoc] = await db
          .select({ title: documents.title })
          .from(documents)
          .where(and(eq(documents.projectId, targetProject.id), eq(documents.category, "memory"), ilike(documents.content, `%${sessionId}%`)))
          .limit(1);
        if (memDoc?.title) parentTitle = memDoc.title.trim().replaceAll("-", " ");
        else if (firstSub.title && !isJunkOrUuidTitle(firstSub.title, sessionId)) parentTitle = firstSub.title;
        if (!parentTitle || isJunkOrUuidTitle(parentTitle, sessionId)) parentTitle = `${cleanTitle} 会话`;

        await db.insert(documents).values({
          id: randomUUID(),
          projectId: targetProject.id,
          machineId: firstSub.machineId,
          toolId,
          category: "conversation",
          contentType: "jsonl",
          relativePath: parentBase,
          title: parentTitle,
          fileSizeBytes: 0,
          content: "",
          contentHash: `synthetic-${sessionId.slice(0, 8)}`,
          metadata: { session_id: sessionId, is_subagent: false, project_hash: cleanTitle, synthetic: true },
          visibility: "private",
          needsReview: false,
          embeddingStatus: "pending",
          embeddingAttempts: 0,
          knowledgeStatus: "pending",
          knowledgeAttempts: 0,
          syncedAt: firstSub.syncedAt,
          sourceModifiedAt: firstSub.sourceModifiedAt,
        });
        adoptedCount++;
      } else if (existing.projectId !== targetProject.id) {
        await db.update(documents).set({ projectId: targetProject.id }).where(eq(documents.id, existing.id));
        adoptedCount++;
      }
    }

    for (const fp of fragRows) {
      const [rem] = await db.select({ n: count(documents.id) }).from(documents).where(eq(documents.projectId, fp.id));
      if (!Number(rem?.n ?? 0)) {
        await db.delete(projects).where(eq(projects.id, fp.id));
      }
    }
    return adoptedCount;
  } catch {
    return 0;
  }
}
