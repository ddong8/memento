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
}

/** Read a JSON object body with the given string fields (required or optional), 422 like FastAPI otherwise. */
export async function jsonBody<R extends string, O extends string>(
  c: Context,
  required: readonly R[],
  optional: readonly O[] = [],
): Promise<Record<R, string> & Partial<Record<O, string | null>>> {
  let body: unknown;
  const text = await c.req.text();
  try {
    body = JSON.parse(text);
  } catch (e) {
    // pydantic reports where parsing stopped and the parser's own message (which differs between languages)
    const pos = Number(/position (\d+)/.exec(String((e as Error).message))?.[1] ?? 0);
    throw new HttpError(422, [{ type: "json_invalid", loc: ["body", pos], msg: "JSON decode error", input: {}, ctx: { error: String((e as Error).message) } }]);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(422, [{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", input: body }]);
  }
  const b = body as Record<string, unknown>;
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
