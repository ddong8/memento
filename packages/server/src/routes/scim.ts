// /api/scim/v2: SCIM 2.0 user provisioning (RFC 7643 / 7644) (server/server/api/scim.py).
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { and, asc, count, eq, ne, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { record as recordAudit } from "../audit";
import type { UserRow } from "../auth/current-user";
import { auditRequest, type AppEnv } from "../context";
import type { Db } from "../db/client";
import { users } from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, queryInt } from "../http";
import { pgToIso } from "../pytime";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const MEDIA = "application/scim+json";

const FILTER_RE = /^\s*(userName|emails(?:\.value)?|externalId|id)\s+eq\s+"([^"]*)"\s*$/i;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function scimError(status: number, detail: string, scimType?: string): HttpError {
  const body: Record<string, unknown> = { schemas: [ERROR_SCHEMA], status: String(status), detail };
  if (scimType) body.scimType = scimType;
  return new HttpError(status as ContentfulStatusCode, body);
}

function requireScim(c: Context<AppEnv>): void {
  const token = c.var.deps.settings.scimToken;
  if (!token) throw new HttpError(404, "SCIM not enabled");
  const auth = c.req.header("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7).trim(), token)) {
    throw scimError(401, "invalid token");
  }
}

function scimResp(c: Context<AppEnv>, body: unknown, status: ContentfulStatusCode = 200) {
  return c.body(JSON.stringify(body), status, { "content-type": MEDIA });
}

function toScim(u: UserRow, c: Context<AppEnv>) {
  const name = u.name || "";
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host;
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    userName: u.email,
    displayName: name,
    name: { formatted: name },
    emails: [{ value: u.email, primary: true, type: "work" }],
    active: u.status === "active",
    meta: {
      resourceType: "User",
      created: pgToIso(u.createdAt),
      lastModified: pgToIso(u.updatedAt ?? u.createdAt),
      location: `${proto}://${host}/api/scim/v2/Users/${u.id}`,
    },
  };
}

function emailOf(body: Record<string, unknown>): string {
  let email = String(body.userName ?? "").trim();
  if (!email.includes("@")) {
    const emails = Array.isArray(body.emails) ? body.emails : [];
    for (const e of emails) {
      if (e && typeof e === "object" && String((e as { value?: unknown }).value ?? "").includes("@")) {
        email = String((e as { value: string }).value).trim();
        if ((e as { primary?: boolean }).primary) break;
      }
    }
  }
  return email.toLowerCase();
}

function nameOf(body: Record<string, unknown>): string | null {
  const n = (body.name && typeof body.name === "object" ? body.name : {}) as Record<string, unknown>;
  const disp = typeof body.displayName === "string" && body.displayName ? body.displayName : "";
  const fmt = typeof n.formatted === "string" && n.formatted ? n.formatted : "";
  const parts = [n.givenName, n.familyName].filter((x): x is string => typeof x === "string" && Boolean(x)).join(" ");
  return disp || fmt || parts || null;
}

function toBool(v: unknown): boolean {
  return typeof v === "boolean" ? v : String(v ?? "").trim().toLowerCase() === "true";
}

async function setActive(db: Db, c: Context<AppEnv>, u: UserRow, active: boolean): Promise<UserRow> {
  if (u.role === "owner" && !active) {
    const [other] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "owner"), eq(users.status, "active"), ne(users.id, u.id)))
      .limit(1);
    if (!other) throw scimError(400, "cannot deactivate the only owner");
  }
  const before = u.status;
  const nextStatus = active ? "active" : "disabled";
  const nextRole = active && u.role === "pending" ? "viewer" : u.role;
  const nextToken = active && !u.collectorToken ? randomBytes(32).toString("hex") : u.collectorToken;
  const [updated] = await db
    .update(users)
    .set({ status: nextStatus, role: nextRole, collectorToken: nextToken, updatedAt: new Date().toISOString() })
    .where(eq(users.id, u.id))
    .returning();
  if (before !== nextStatus) {
    await recordAudit(db, null, active ? "scim.user.activate" : "scim.user.deactivate", auditRequest(c), {
      targetUserId: u.id,
      detail: { email: u.email },
    });
  }
  return updated ?? u;
}

async function loadScimUser(db: Db, userId: string): Promise<UserRow> {
  const uid = normalizeUuid(userId);
  if (!uid) throw scimError(404, "user not found");
  const [u] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  if (!u) throw scimError(404, "user not found");
  return u;
}

export const scimRoutes = new Hono<AppEnv>();

scimRoutes.get("/ServiceProviderConfig", (c) => {
  requireScim(c);
  return scimResp(c, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", primary: true }],
  });
});

scimRoutes.get("/ResourceTypes", (c) => {
  requireScim(c);
  return scimResp(c, {
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: USER_SCHEMA,
      },
    ],
  });
});

scimRoutes.get("/Users", async (c) => {
  requireScim(c);
  const { db } = c.var.deps;
  const filter = c.req.query("filter");
  const start = Math.max(1, queryInt(c, "startIndex", 1));
  const cnt = Math.max(0, Math.min(queryInt(c, "count", 100), 200));

  let where: SQL | undefined;
  if (filter) {
    const m = FILTER_RE.exec(filter);
    if (!m) throw scimError(400, 'only `userName eq "..."` style filters are supported', "invalidFilter");
    const attr = m[1]!.toLowerCase();
    const val = m[2]!;
    if (attr === "id") {
      const uid = normalizeUuid(val);
      where = uid ? eq(users.id, uid) : sql`false`;
    } else {
      where = sql`lower(${users.email}) = ${val.toLowerCase()}`;
    }
  }

  const [[tot], rows] = await Promise.all([
    db.select({ n: count() }).from(users).where(where),
    db.select().from(users).where(where).orderBy(asc(users.createdAt)).offset(start - 1).limit(cnt),
  ]);

  return scimResp(c, {
    schemas: [LIST_SCHEMA],
    totalResults: Number(tot?.n ?? 0),
    startIndex: start,
    itemsPerPage: rows.length,
    Resources: rows.map((u) => toScim(u, c)),
  });
});

scimRoutes.get("/Users/:user_id", async (c) => {
  requireScim(c);
  const u = await loadScimUser(c.var.deps.db, c.req.param("user_id"));
  return scimResp(c, toScim(u, c));
});

scimRoutes.post("/Users", async (c) => {
  requireScim(c);
  const { db } = c.var.deps;
  const body = await parseJsonObject(c);
  const email = emailOf(body);
  if (!email.includes("@")) throw scimError(400, "userName or emails must hold an email address", "invalidValue");
  const [dup] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (dup) throw scimError(409, "user already exists", "uniqueness");

  const active = toBool(body.active ?? true);
  const [created] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      email,
      name: nameOf(body) || email.split("@")[0]!,
      hashedPassword: null,
      role: "viewer",
      status: active ? "active" : "disabled",
      collectorToken: randomBytes(32).toString("hex"),
    })
    .returning();
  await recordAudit(db, null, "scim.user.create", auditRequest(c), {
    targetUserId: created!.id,
    detail: { email, active },
  });
  return scimResp(c, toScim(created!, c), 201);
});

scimRoutes.put("/Users/:user_id", async (c) => {
  requireScim(c);
  const { db } = c.var.deps;
  let u = await loadScimUser(db, c.req.param("user_id"));
  const body = await parseJsonObject(c);
  const nm = nameOf(body);
  if (nm) {
    const [upd] = await db.update(users).set({ name: nm, updatedAt: new Date().toISOString() }).where(eq(users.id, u.id)).returning();
    u = upd ?? u;
  }
  if ("active" in body) u = await setActive(db, c, u, toBool(body.active));
  return scimResp(c, toScim(u, c));
});

scimRoutes.patch("/Users/:user_id", async (c) => {
  requireScim(c);
  const { db } = c.var.deps;
  let u = await loadScimUser(db, c.req.param("user_id"));
  const body = await parseJsonObject(c);
  const ops = Array.isArray(body.Operations) ? body.Operations : [];
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const o = op as Record<string, unknown>;
    const kind = String(o.op ?? "").toLowerCase();
    if (kind !== "replace" && kind !== "add") continue;
    const path = String(o.path ?? "").trim();
    const val = o.value;
    const changes: Record<string, unknown> = path ? { [path]: val } : val && typeof val === "object" ? (val as Record<string, unknown>) : {};
    for (const [key, v] of Object.entries(changes)) {
      const k = key.toLowerCase();
      if (k === "active") {
        u = await setActive(db, c, u, toBool(v));
      } else if ((k === "displayname" || k === "name.formatted") && v) {
        const [upd] = await db.update(users).set({ name: String(v), updatedAt: new Date().toISOString() }).where(eq(users.id, u.id)).returning();
        u = upd ?? u;
      } else if (k === "name" && v && typeof v === "object") {
        const nm = nameOf({ name: v });
        if (nm) {
          const [upd] = await db.update(users).set({ name: nm, updatedAt: new Date().toISOString() }).where(eq(users.id, u.id)).returning();
          u = upd ?? u;
        }
      }
    }
  }
  return scimResp(c, toScim(u, c));
});

scimRoutes.delete("/Users/:user_id", async (c) => {
  requireScim(c);
  const u = await loadScimUser(c.var.deps.db, c.req.param("user_id"));
  await setActive(c.var.deps.db, c, u, false);
  return c.body(null, 204);
});
