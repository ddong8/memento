// FastAPI's error shape, so clients can't tell which server answered: {"detail": "..."} with the status.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly detail: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

export function errorResponse(c: Context, err: unknown) {
  if (err instanceof HttpError) {
    for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    return c.json({ detail: err.detail }, err.status);
  }
  console.error("unhandled error", c.req.method, c.req.path, err);
  return c.text("Internal Server Error", 500);
}

/** A missing or wrongly typed body field, as pydantic reports it (422). */
export interface FieldError {
  type: string;
  loc: (string | number)[];
  msg: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

const UUID_RE = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

/** Normalize a UUID string (with or without dashes) to canonical lowercase hyphenated form, or null. */
export function normalizeUuid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = UUID_RE.exec(raw.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase();
}

/** Parse a FastAPI UUID path parameter, raising 422 uuid_parsing if invalid. */
export function pathUuid(c: Context, name: string): string {
  const raw = c.req.param(name) ?? "";
  const norm = normalizeUuid(raw);
  if (!norm) {
    throw new HttpError(422, [
      {
        type: "uuid_parsing",
        loc: ["path", name],
        msg: "Input should be a valid UUID, invalid length: expected length 32 for simple format, found " + raw.length,
        input: raw,
      },
    ]);
  }
  return norm;
}

/** Parse a JSON object body (required), raising FastAPI-compatible 422 on invalid JSON or non-object. */
export async function parseJsonObject(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    const pos = Number(/position (\d+)/.exec(String((e as Error).message))?.[1] ?? 0);
    throw new HttpError(422, [{ type: "json_invalid", loc: ["body", pos], msg: "JSON decode error", input: {}, ctx: { error: String((e as Error).message) } }]);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(422, [{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", input: body }]);
  }
  return body as Record<string, unknown>;
}

/** Parse an optional JSON object body (empty body -> null). */
export async function parseOptionalJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (!text.trim()) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    const pos = Number(/position (\d+)/.exec(String((e as Error).message))?.[1] ?? 0);
    throw new HttpError(422, [{ type: "json_invalid", loc: ["body", pos], msg: "JSON decode error", input: {}, ctx: { error: String((e as Error).message) } }]);
  }
  if (body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(422, [{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", input: body }]);
  }
  return body as Record<string, unknown>;
}

/** Read a JSON object body with the given string fields (required or optional), 422 like FastAPI otherwise. */
export async function jsonBody<R extends string, O extends string>(
  c: Context,
  required: readonly R[],
  optional: readonly O[] = [],
): Promise<Record<R, string> & Partial<Record<O, string | null>>> {
  const b = await parseJsonObject(c);
  const errors: FieldError[] = [];
  const out: Record<string, string | null> = {};
  for (const k of required) {
    if (!(k in b)) errors.push({ type: "missing", loc: ["body", k], msg: "Field required", input: b });
    else if (typeof b[k] !== "string") errors.push({ type: "string_type", loc: ["body", k], msg: "Input should be a valid string", input: b[k] });
    else out[k] = b[k] as string;
  }
  for (const k of optional) {
    if (!(k in b) || b[k] === null) continue;
    if (typeof b[k] !== "string") errors.push({ type: "string_type", loc: ["body", k], msg: "Input should be a valid string", input: b[k] });
    else out[k] = b[k] as string;
  }
  if (errors.length) throw new HttpError(422, errors);
  return out as Record<R, string> & Partial<Record<O, string | null>>;
}

/** An integer query parameter with FastAPI's Query(default, ge=, le=) checks and 422s. */
export function queryInt(c: Context, name: string, fallback: number, bounds: { ge?: number; le?: number } = {}): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["query", name], msg: "Input should be a valid integer, unable to parse string as an integer", input: raw }]);
  }
  const n = Number(raw.trim());
  if (bounds.ge !== undefined && n < bounds.ge) {
    throw new HttpError(422, [{ type: "greater_than_equal", loc: ["query", name], msg: `Input should be greater than or equal to ${bounds.ge}`, input: raw, ctx: { ge: bounds.ge } }]);
  }
  if (bounds.le !== undefined && n > bounds.le) {
    throw new HttpError(422, [{ type: "less_than_equal", loc: ["query", name], msg: `Input should be less than or equal to ${bounds.le}`, input: raw, ctx: { le: bounds.le } }]);
  }
  return n;
}

/** Optional integer query parameter: undefined when absent, 422 when non-integer. */
export function queryOptionalInt(c: Context, name: string): number | null {
  const raw = c.req.query(name);
  if (raw === undefined) return null;
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["query", name], msg: "Input should be a valid integer, unable to parse string as an integer", input: raw }]);
  }
  return Number(raw.trim());
}

/** Required string query parameter with FastAPI Query(..., min_length=, max_length=) 422s. */
export function queryRequiredString(c: Context, name: string, bounds: { minLength?: number; maxLength?: number } = {}): string {
  const raw = c.req.query(name);
  if (raw === undefined) {
    throw new HttpError(422, [{ type: "missing", loc: ["query", name], msg: "Field required", input: null }]);
  }
  if (bounds.minLength !== undefined && raw.length < bounds.minLength) {
    throw new HttpError(422, [{ type: "string_too_short", loc: ["query", name], msg: `String should have at least ${bounds.minLength} character`, input: raw, ctx: { min_length: bounds.minLength } }]);
  }
  if (bounds.maxLength !== undefined && raw.length > bounds.maxLength) {
    throw new HttpError(422, [{ type: "string_too_long", loc: ["query", name], msg: `String should have at most ${bounds.maxLength} characters`, input: raw, ctx: { max_length: bounds.maxLength } }]);
  }
  return raw;
}

/** Required header parameter with FastAPI Header(...) 422 when missing. */
export function requiredHeader(c: Context, name: string): string {
  const val = c.req.header(name);
  if (val === undefined) {
    throw new HttpError(422, [{ type: "missing", loc: ["header", name.toLowerCase()], msg: "Field required", input: null }]);
  }
  return val;
}
