// /api/admin: user management, invites, permissions, sync status & audit log (server/server/api/admin.py).
import { randomBytes, randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { record as recordAudit } from "../audit";
import { currentUser, requireRole } from "../auth/current-user";
import { auditRequest, type AppEnv } from "../context";
import {
  accessLogs,
  conversationMessages,
  documentEmbeddings,
  documents,
  documentVersions,
  inviteCodes,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  permissions,
  projects,
  syncState,
  tools,
  users,
} from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, pathUuid, queryInt } from "../http";
import { pgToIso } from "../pytime";
import { seesAll } from "../services/visibility";

const VALID_ROLES = new Set(["pending", "viewer", "admin", "owner"]);
const VALID_STATUSES = new Set(["pending", "active", "disabled"]);

export const adminRoutes = new Hono<AppEnv>();

// ---- Users ----
adminRoutes.get("/users", async (c) => {
  const caller = await currentUser(c);
  requireRole(caller, "admin", "owner");
  const { db, settings } = c.var.deps;
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  const canSeeTokens = seesAll(caller, settings);
  return c.json(
    rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      collector_token: canSeeTokens || u.id === caller.id ? u.collectorToken : null,
      created_at: pgToIso(u.createdAt),
    })),
  );
});

adminRoutes.post("/users/:user_id/approve", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const { db, settings } = c.var.deps;
  const uid = pathUuid(c, "user_id");
  const [user] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  if (!user) throw new HttpError(404, "Not Found");
  const nextRole = user.role === "pending" ? "viewer" : user.role;
  const nextToken = user.collectorToken || randomBytes(32).toString("hex");
  const [updated] = await db
    .update(users)
    .set({ status: "active", role: nextRole, collectorToken: nextToken, updatedAt: new Date().toISOString() })
    .where(eq(users.id, uid))
    .returning();
  const u = updated ?? user;
  await recordAudit(db, admin, "admin.user.approve", auditRequest(c), { targetUserId: u.id, detail: { email: u.email } });
  return c.json({
    status: "approved",
    user_id: u.id,
    collector_token: seesAll(admin, settings) ? u.collectorToken : null,
    role: u.role,
  });
});

adminRoutes.put("/users/:user_id", async (c) => {
  const caller = await currentUser(c);
  requireRole(caller, "admin", "owner");
  const { db } = c.var.deps;
  const uid = pathUuid(c, "user_id");
  const body = await parseJsonObject(c);
  const role = typeof body.role === "string" && body.role ? body.role : null;
  const status = typeof body.status === "string" && body.status ? body.status : null;
  if (role && !VALID_ROLES.has(role)) throw new HttpError(400, `role must be one of ${JSON.stringify([...VALID_ROLES].sort())}`);
  if (status && !VALID_STATUSES.has(status)) throw new HttpError(400, `status must be one of ${JSON.stringify([...VALID_STATUSES].sort())}`);
  if (role === "owner" && caller.role !== "owner") throw new HttpError(403, "only owner can promote to owner");

  const [user] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  if (!user) throw new HttpError(404, "Not Found");

  if (status === "disabled" && user.role === "owner") {
    const [other] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "owner"), eq(users.status, "active"), ne(users.id, uid)))
      .limit(1);
    if (!other) throw new HttpError(400, "cannot disable the last active owner");
  }

  const before = { role: user.role, status: user.status };
  const [updated] = await db
    .update(users)
    .set({ role: role ?? user.role, status: status ?? user.status, updatedAt: new Date().toISOString() })
    .where(eq(users.id, uid))
    .returning();
  const u = updated ?? user;
  await recordAudit(db, caller, "admin.user.update", auditRequest(c), {
    targetUserId: u.id,
    detail: { email: u.email, before, after: { role: u.role, status: u.status } },
  });
  return c.json({ status: "updated", user_id: u.id, role: u.role, user_status: u.status });
});

adminRoutes.post("/users/:user_id/rotate-collector-token", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const { db, settings } = c.var.deps;
  const uid = pathUuid(c, "user_id");
  const [user] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  if (!user) throw new HttpError(404, "Not Found");
  const nextToken = randomBytes(32).toString("hex");
  await db.update(users).set({ collectorToken: nextToken, updatedAt: new Date().toISOString() }).where(eq(users.id, uid));
  await recordAudit(db, admin, "admin.user.rotate_token", auditRequest(c), { targetUserId: uid, detail: { email: user.email } });
  return c.json({ status: "rotated", user_id: uid, collector_token: seesAll(admin, settings) ? nextToken : null });
});

adminRoutes.post("/users/:user_id/transfer-ownership", async (c) => {
  const caller = await currentUser(c);
  requireRole(caller, "owner");
  const { db } = c.var.deps;
  const uid = pathUuid(c, "user_id");
  const keepSelfAs = c.req.query("keep_self_as") || "admin";
  if (!["owner", "admin", "viewer"].includes(keepSelfAs)) throw new HttpError(400, "keep_self_as must be owner / admin / viewer");
  if (uid === caller.id) throw new HttpError(400, "cannot transfer to yourself");

  const [target] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  if (!target) throw new HttpError(404, "Not Found");
  if (target.status !== "active") throw new HttpError(400, "target user must be active");

  await db.update(users).set({ role: "owner", updatedAt: new Date().toISOString() }).where(eq(users.id, uid));
  await db.update(users).set({ role: keepSelfAs, updatedAt: new Date().toISOString() }).where(eq(users.id, caller.id));
  await recordAudit(db, caller, "admin.owner.transfer", auditRequest(c), {
    targetUserId: target.id,
    detail: { email: target.email, caller_role: keepSelfAs },
  });
  return c.json({ status: "transferred", new_owner: target.id, caller_role: keepSelfAs });
});

adminRoutes.delete("/users/:user_id", async (c) => {
  const caller = await currentUser(c);
  requireRole(caller, "owner");
  const { db } = c.var.deps;
  const uid = pathUuid(c, "user_id");
  if (uid === caller.id) throw new HttpError(400, "cannot delete yourself");

  const [user] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  if (!user) throw new HttpError(404, "Not Found");
  if (user.role === "owner") {
    const [other] = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "owner"), ne(users.id, uid))).limit(1);
    if (!other) throw new HttpError(400, "cannot delete the only owner");
  }

  const machineIds = (await db.select({ id: machines.id }).from(machines).where(eq(machines.userId, uid))).map((r) => r.id);
  let docsDeleted = 0;
  if (machineIds.length) {
    const docIds = (await db.select({ id: documents.id }).from(documents).where(inArray(documents.machineId, machineIds))).map((r) => r.id);
    docsDeleted = docIds.length;
    for (let i = 0; i < docIds.length; i += 500) {
      const batch = docIds.slice(i, i + 500);
      await db.delete(accessLogs).where(inArray(accessLogs.documentId, batch));
      await db.delete(conversationMessages).where(inArray(conversationMessages.documentId, batch));
      await db.delete(documentVersions).where(inArray(documentVersions.documentId, batch));
      await db.delete(documentEmbeddings).where(inArray(documentEmbeddings.documentId, batch));
      await db.delete(knowledgeObservations).where(inArray(knowledgeObservations.sourceDocumentId, batch));
      await db.delete(documents).where(inArray(documents.id, batch));
    }
    await db.delete(syncState).where(inArray(syncState.machineId, machineIds));
    await db.delete(machines).where(inArray(machines.id, machineIds));
  }

  const entIds = (await db.select({ id: knowledgeEntities.id }).from(knowledgeEntities).where(eq(knowledgeEntities.userId, uid))).map((r) => r.id);
  if (entIds.length) {
    await db.delete(knowledgeRelations).where(or(inArray(knowledgeRelations.sourceId, entIds), inArray(knowledgeRelations.targetId, entIds)));
    await db.delete(knowledgeObservations).where(inArray(knowledgeObservations.entityId, entIds));
    await db.delete(knowledgeEntities).where(inArray(knowledgeEntities.id, entIds));
  }

  const linkedPids = (
    await db.selectDistinct({ pid: documents.projectId }).from(documents).where(isNotNull(documents.projectId))
  )
    .map((r) => r.pid)
    .filter((x): x is string => Boolean(x));
  const orphanProjects = linkedPids.length
    ? (await db.select({ id: projects.id }).from(projects).where(notInArray(projects.id, linkedPids))).map((r) => r.id)
    : (await db.select({ id: projects.id }).from(projects)).map((r) => r.id);
  if (orphanProjects.length) await db.delete(projects).where(inArray(projects.id, orphanProjects));

  await db.update(accessLogs).set({ userId: null }).where(eq(accessLogs.userId, uid));
  await db.update(inviteCodes).set({ createdBy: null }).where(eq(inviteCodes.createdBy, uid));
  await db.update(permissions).set({ grantedBy: null }).where(eq(permissions.grantedBy, uid));
  await recordAudit(db, caller, "admin.user.delete", auditRequest(c), {
    targetUserId: uid,
    detail: { email: user.email, machines: machineIds.length, documents: docsDeleted },
  });
  await db.delete(users).where(eq(users.id, uid));

  return c.json({
    status: "deleted",
    user_id: uid,
    machines_deleted: machineIds.length,
    documents_deleted: docsDeleted,
    knowledge_entities_deleted: entIds.length,
    orphaned_projects_deleted: orphanProjects.length,
  });
});

// ---- Invites ----
adminRoutes.get("/invites", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const rows = await c.var.deps.db.select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt));
  return c.json(
    rows.map((r) => ({
      id: r.id,
      code: r.code,
      max_uses: r.maxUses,
      use_count: r.useCount,
      expires_at: pgToIso(r.expiresAt),
      role_on_accept: r.roleOnAccept,
      note: r.note,
      created_by: r.createdBy,
      created_at: pgToIso(r.createdAt),
    })),
  );
});

adminRoutes.post("/invites", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const { db } = c.var.deps;
  const body = await parseJsonObject(c);
  const roleOnAccept = typeof body.role_on_accept === "string" ? body.role_on_accept : "viewer";
  const maxUses = body.max_uses === undefined ? 1 : Number(body.max_uses);
  if (roleOnAccept !== "viewer" && roleOnAccept !== "admin") throw new HttpError(400, "role_on_accept must be viewer or admin");
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) throw new HttpError(400, "max_uses out of range (1..1000)");
  const expiresDays = typeof body.expires_days === "number" ? body.expires_days : null;
  const expiresAt = expiresDays !== null ? new Date(Date.now() + expiresDays * 86400_000).toISOString() : null;

  const [invite] = await db
    .insert(inviteCodes)
    .values({
      id: randomUUID(),
      code: randomBytes(12).toString("base64url"),
      maxUses,
      useCount: 0,
      roleOnAccept,
      expiresAt,
      note: typeof body.note === "string" ? body.note : null,
      createdBy: admin.id,
    })
    .returning();
  await recordAudit(db, admin, "admin.invite.create", auditRequest(c), {
    detail: { invite_id: invite!.id, role_on_accept: invite!.roleOnAccept, max_uses: invite!.maxUses },
  });
  return c.json({
    id: invite!.id,
    code: invite!.code,
    max_uses: invite!.maxUses,
    expires_at: pgToIso(invite!.expiresAt),
    role_on_accept: invite!.roleOnAccept,
  });
});

adminRoutes.delete("/invites/:invite_id", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const iid = pathUuid(c, "invite_id");
  const [inv] = await c.var.deps.db.select().from(inviteCodes).where(eq(inviteCodes.id, iid)).limit(1);
  if (!inv) throw new HttpError(404, "Not Found");
  await c.var.deps.db.delete(inviteCodes).where(eq(inviteCodes.id, iid));
  await recordAudit(c.var.deps.db, admin, "admin.invite.revoke", auditRequest(c), { detail: { invite_id: iid } });
  return c.json({ status: "revoked" });
});

// ---- Permissions ----
adminRoutes.get("/permissions", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const rows = await c.var.deps.db.select().from(permissions).orderBy(desc(permissions.createdAt));
  return c.json(
    rows.map((p) => ({
      id: p.id,
      user_id: p.userId,
      project_id: p.projectId,
      tool_id: p.toolId,
      permission: p.permission,
      created_at: pgToIso(p.createdAt),
    })),
  );
});

adminRoutes.post("/permissions/grant", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const { db } = c.var.deps;
  const body = await parseJsonObject(c);
  const permLevel = typeof body.permission === "string" ? body.permission : "read";
  const projectId = typeof body.project_id === "string" && body.project_id ? normalizeUuid(body.project_id) : null;
  const toolId = typeof body.tool_id === "string" && body.tool_id ? body.tool_id : null;
  const targetUid = normalizeUuid(typeof body.user_id === "string" ? body.user_id : "");
  if (!targetUid) throw new HttpError(422, [{ type: "uuid_parsing", loc: ["body", "user_id"], msg: "invalid user_id", input: body.user_id }]);
  if (permLevel !== "read" && permLevel !== "write") throw new HttpError(400, "permission must be read or write");
  if (!projectId && !toolId) throw new HttpError(400, "project_id or tool_id required");

  const [perm] = await db
    .insert(permissions)
    .values({
      id: randomUUID(),
      userId: targetUid,
      projectId,
      toolId,
      permission: permLevel,
      grantedBy: admin.id,
    })
    .returning();
  await recordAudit(db, admin, "admin.permission.grant", auditRequest(c), {
    targetUserId: perm!.userId,
    detail: { permission_id: perm!.id, project_id: projectId, tool_id: toolId, permission: permLevel },
  });
  return c.json({ status: "granted", permission_id: perm!.id });
});

adminRoutes.delete("/permissions/:perm_id", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const pid = pathUuid(c, "perm_id");
  const [perm] = await c.var.deps.db.select().from(permissions).where(eq(permissions.id, pid)).limit(1);
  if (!perm) throw new HttpError(404, "Not Found");
  await c.var.deps.db.delete(permissions).where(eq(permissions.id, pid));
  await recordAudit(c.var.deps.db, admin, "admin.permission.revoke", auditRequest(c), {
    targetUserId: perm.userId,
    detail: { permission_id: pid },
  });
  return c.json({ status: "revoked" });
});

// ---- Sync status ----
adminRoutes.get("/sync/status", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const { db } = c.var.deps;
  const toolRows = await db.select().from(tools).orderBy(asc(tools.displayName));
  const latestRows = (await db.execute(sql`
    SELECT tool_id, relative_path FROM (
      SELECT tool_id, relative_path,
             row_number() OVER (PARTITION BY tool_id ORDER BY last_synced_at DESC) AS rn
      FROM sync_state
    ) s WHERE rn = 1
  `)) as unknown as { tool_id: string; relative_path: string }[];
  const latestByTool = new Map(latestRows.map((r) => [r.tool_id, r.relative_path]));

  return c.json(
    toolRows.map((t) => ({
      tool_id: t.id,
      display_name: t.displayName,
      total_files: t.totalFiles,
      last_sync_at: pgToIso(t.lastSyncAt),
      latest_file: latestByTool.get(t.id) ?? null,
    })),
  );
});

// ---- Audit log ----
adminRoutes.get("/audit-log", async (c) => {
  const admin = await currentUser(c);
  requireRole(admin, "admin", "owner");
  const { db } = c.var.deps;
  const limit = Math.max(1, Math.min(queryInt(c, "limit", 100), 500));
  const offset = Math.max(0, queryInt(c, "offset", 0));
  const userIdRaw = c.req.query("user_id");
  const action = c.req.query("action");
  const auditOnly = (c.req.query("audit_only") ?? "").toLowerCase() === "true" || c.req.query("audit_only") === "1";

  const conds: SQL[] = [];
  if (auditOnly) conds.push(sql`${accessLogs.metadata}->>'audit' = 'true'`);
  if (userIdRaw) {
    const uid = normalizeUuid(userIdRaw);
    if (!uid) throw new HttpError(422, [{ type: "uuid_parsing", loc: ["query", "user_id"], msg: "invalid uuid", input: userIdRaw }]);
    conds.push(eq(accessLogs.userId, uid));
  }
  if (action) conds.push(eq(accessLogs.action, action));

  const rows = await db
    .select()
    .from(accessLogs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(accessLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    items: rows.map((l) => ({
      id: Number(l.id),
      user_id: l.userId,
      document_id: l.documentId,
      action: l.action,
      ip_address: l.ipAddress,
      user_agent: l.userAgent,
      metadata: l.metadata ?? {},
      created_at: pgToIso(l.createdAt),
    })),
    limit,
    offset,
  });
});
