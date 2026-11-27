// Chat images persisted in object storage under /tmp/memento_images/<conv>/<name> (server/server/services/chat_images.py).
import { randomUUID } from "node:crypto";

import { eq, like, or } from "drizzle-orm";

import type { Settings } from "../config";
import type { Db } from "../db/client";
import { machines } from "../db/pulled/schema";
import { getBytes, uploadBytes } from "./storage";
import { normalizeDeviceName } from "./user-filter";

export const NAMED_IMAGES_FROM: readonly [number, number, number] = [1, 0, 125];

const PATH_RE = /^(?:\/tmp\/memento_images|\/data2\/memento\/images)\/([A-Za-z0-9_-]{1,80})\/(image_[A-Za-z0-9_]{1,40}\.(?:png|jpe?g|webp|gif|bmp|avif))$/i;
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  avif: "image/avif",
};

function parseVersion(v: string | null | undefined): number[] {
  return (v ?? "").match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
}

function versionGte(a: number[], b: readonly number[]): boolean {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export async function deviceNamesImages(db: Db, deviceId: string | null | undefined): Promise<boolean> {
  if (!deviceId || deviceId === "auto" || deviceId === "all" || deviceId === "ask_only") return false;
  const base = normalizeDeviceName(deviceId);
  try {
    const rows = await db
      .select({ collectorVersion: machines.collectorVersion })
      .from(machines)
      .where(
        or(
          eq(machines.collectorTokenHash, deviceId),
          eq(machines.name, deviceId),
          eq(machines.name, base),
          like(machines.name, `${base} (%`),
        ),
      );
    const versions = rows.map((r) => r.collectorVersion).filter((v): v is string => Boolean(v));
    return versions.length > 0 && versions.every((v) => versionGte(parseVersion(v), NAMED_IMAGES_FROM));
  } catch {
    return false;
  }
}

export function imageNames(exts: string[], unique: boolean): string[] {
  if (!unique) return exts.map((ext, i) => `image_${i + 1}.${ext}`);
  const tag = `${Math.floor(Date.now() / 1000).toString(16)}${randomUUID().replaceAll("-", "").slice(0, 4)}`;
  return exts.map((ext, i) => `image_${tag}_${i + 1}.${ext}`);
}

export function agentPath(convId: string, name: string): string {
  return `/tmp/memento_images/${convId}/${name}`;
}

export function storageKey(userId: string, path: string): string | null {
  const m = PATH_RE.exec(path || "");
  return m ? `chat-images/${userId}/${m[1]}/${m[2]!.toLowerCase()}` : null;
}

export async function keepChatImage(settings: Settings, userId: string, convId: string, name: string, data: Buffer): Promise<boolean> {
  const key = storageKey(userId, agentPath(convId, name));
  if (!key) return false;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (await uploadBytes(settings, key, data, MIME[ext] ?? "application/octet-stream")) !== null;
}

export async function loadChatImage(settings: Settings, userId: string, path: string): Promise<[Buffer, string] | null> {
  const key = storageKey(userId, path);
  if (!key) return null;
  const [data, contentType] = await getBytes(settings, key);
  if (!data || !data.length) return null;
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return [data, contentType.startsWith("image/") ? contentType : (MIME[ext] ?? "application/octet-stream")];
}

const DATA_URL_IMG_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s;

export async function storeImages(
  settings: Settings,
  userId: string,
  convId: string,
  images: string[],
): Promise<string[]> {
  if (!images.length) return [];
  const out: string[] = [];
  const tag = `${Math.floor(Date.now() / 1000).toString(16)}${randomUUID().replaceAll("-", "").slice(0, 4)}`;
  for (let i = 0; i < images.length; i++) {
    const raw = images[i] ?? "";
    const m = DATA_URL_IMG_RE.exec(raw);
    if (!m) {
      if (raw) out.push(raw);
      continue;
    }
    const extRaw = m[1]!.toLowerCase().replace("jpeg", "jpg");
    const ext = ["png", "jpg", "webp", "gif", "bmp", "avif"].includes(extRaw) ? extRaw : "png";
    const name = `image_${tag}_${i + 1}.${ext}`;
    const buf = Buffer.from(m[2]!, "base64");
    const ok = await keepChatImage(settings, userId, convId, name, buf).catch(() => false);
    out.push(ok ? agentPath(convId, name) : raw);
  }
  return out;
}
