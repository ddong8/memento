// /api/data: account-level export & import ZIP endpoints (server/server/api/data_io.py).
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import { parseBool } from "../config";
import type { AppEnv } from "../context";
import { HttpError } from "../http";
import { cluster } from "../services/cluster";
import { buildExport } from "../services/export";
import { ImportPackageError, runImport } from "../services/import";

export const dataIoRoutes = new Hono<AppEnv>();

const MAX_UPLOAD_BYTES = Number(process.env.MEMENTO_IMPORT_MAX_UPLOAD_BYTES || 100 * 1024 * 1024);

dataIoRoutes.get("/export", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  let includeAccessLogs = false;
  const rawFlag = c.req.query("include_access_logs");
  if (rawFlag !== undefined) {
    try {
      includeAccessLogs = parseBool(rawFlag, false);
    } catch {
      throw new HttpError(422, [{ type: "bool_parsing", loc: ["query", "include_access_logs"], msg: "Input should be a valid boolean", input: rawFlag }]);
    }
  }

  let includeFull = false;
  const rawFull = c.req.query("include_full");
  if (rawFull !== undefined) {
    try {
      includeFull = parseBool(rawFull, false);
    } catch {
      throw new HttpError(422, [{ type: "bool_parsing", loc: ["query", "include_full"], msg: "Input should be a valid boolean", input: rawFull }]);
    }
  }

  const lock = await cluster.mutex(`export:${user.id}`);
  if (!lock) throw new HttpError(429, "Another export is already running for this account");

  try {
    const result = await buildExport(db, user, { includeAccessLogs, includeFull });
    const countsHeader = Object.entries(result.counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${result.filename}"`,
        "content-length": String(result.bytes.byteLength),
        "x-accel-buffering": "no",
        "x-memento-counts": countsHeader,
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("uncompressed budget")) throw new HttpError(413, e.message);
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, "export failed; check server logs");
  } finally {
    await lock.release();
  }
});

dataIoRoutes.post("/import", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const clHeader = c.req.header("content-length");
  if (clHeader && Number(clHeader) > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `upload exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MiB cap`);
  }

  const lock = await cluster.mutex(`import:${user.id}`);
  if (!lock) throw new HttpError(429, "Another import is already running for this account");

  try {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || !(file instanceof File)) {
      throw new HttpError(422, [{ type: "missing", loc: ["body", "file"], msg: "Field required", input: null }]);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, `upload exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MiB cap`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, `upload exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MiB cap`);
    }

    try {
      const result = await runImport(db, user, bytes);
      return c.json({ ok: true, machine_id: result.machine_id, counts: result.counts, warnings: result.warnings });
    } catch (e) {
      if (e instanceof ImportPackageError) throw new HttpError(400, e.message);
      throw new HttpError(500, "import failed; check server logs");
    }
  } finally {
    await lock.release();
  }
});
