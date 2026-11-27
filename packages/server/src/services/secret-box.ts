// Encrypt secrets users hand us before they go into the database (server/server/services/secret_box.py).
// Wire-compatible with Python cryptography.fernet.Fernet ("enc:v1:" + base64url(0x80 || ts64 || iv16 || aes128cbc || hmac256)).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Settings } from "../config";

export const PREFIX = "enc:v1:";
export const LLM_SECRET_FIELDS = ["api_key", "fallback_api_key"] as const;

function deriveKeys(settings: Pick<Settings, "dataKey" | "secretKey">) {
  const raw = settings.dataKey || settings.secretKey;
  const digest = createHash("sha256").update(`memento-data-key:${raw}`, "utf8").digest();
  return {
    signingKey: digest.subarray(0, 16),
    encryptionKey: digest.subarray(16, 32),
  };
}

/** Python base64.urlsafe_b64encode keeps trailing '=' padding. */
function b64urlEncodePadded(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function b64urlDecode(s: string): Buffer {
  const std = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = std.length % 4 ? "=".repeat(4 - (std.length % 4)) : "";
  return Buffer.from(std + pad, "base64");
}

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function seal(value: string | null | undefined, settings: Pick<Settings, "dataKey" | "secretKey">): string {
  if (!value) return "";
  if (isSealed(value)) return value;
  const { signingKey, encryptionKey } = deriveKeys(settings);
  const version = Buffer.from([0x80]);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
  const body = Buffer.concat([version, ts, iv, ciphertext]);
  const mac = createHmac("sha256", signingKey).update(body).digest();
  return PREFIX + b64urlEncodePadded(Buffer.concat([body, mac]));
}

export function reveal(value: string | null | undefined, settings: Pick<Settings, "dataKey" | "secretKey">): string {
  if (!value) return "";
  if (!isSealed(value)) return value;
  try {
    const { signingKey, encryptionKey } = deriveKeys(settings);
    const raw = b64urlDecode(value.slice(PREFIX.length));
    // Minimum Fernet token: 1 (version) + 8 (ts) + 16 (iv) + 16 (one AES block) + 32 (HMAC) = 73 bytes
    if (raw.length < 73 || raw[0] !== 0x80) return "";
    const body = raw.subarray(0, raw.length - 32);
    const mac = raw.subarray(raw.length - 32);
    const expected = createHmac("sha256", signingKey).update(body).digest();
    if (!timingSafeEqual(mac, expected)) return "";
    const iv = body.subarray(9, 25);
    const ciphertext = body.subarray(25);
    if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return "";
    const decipher = createDecipheriv("aes-128-cbc", encryptionKey, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return "";
  }
}

export function maskSecret(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  if (raw.length <= 6) return "••••";
  return `${raw.slice(0, 3)}••••${raw.slice(-3)}`;
}

export function sealLlmSettings(data: Record<string, unknown> | null | undefined, settings: Pick<Settings, "dataKey" | "secretKey">): Record<string, unknown> {
  const out = { ...(data ?? {}) };
  for (const f of LLM_SECRET_FIELDS) {
    if (out[f]) out[f] = seal(String(out[f]).trim(), settings);
  }
  return out;
}

export function revealLlmSettings(data: Record<string, unknown> | null | undefined, settings: Pick<Settings, "dataKey" | "secretKey">): Record<string, unknown> {
  const out = { ...(data ?? {}) };
  for (const f of LLM_SECRET_FIELDS) {
    if (typeof out[f] === "string" && out[f]) out[f] = reveal(out[f] as string, settings);
  }
  return out;
}
