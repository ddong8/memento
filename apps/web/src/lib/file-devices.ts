import { getApiBase } from "./api-client";

/**
 * Which of the user's devices a file path came from (the task that read, wrote or mentioned it), so the
 * workbench fetches it from that device: through the server relay in a browser or on the phone, and in
 * the desktop app from this computer's disk when it is this computer's file, else through the relay too.
 * Without a device the relay asks every online device in turn ("auto"), which is slow and can pick the
 * wrong one when two devices have the same path.
 */
export interface FileDevice {
  /** The server's id for the device (a task result's device_id). */
  id?: string;
  /** Its name, as tasks and the desktop app report it ("Mac-mini" / "Mac-mini (Darwin)"). */
  name?: string;
}

const MAX_PATHS = 2000;
const owners = new Map<string, FileDevice>();
let localDeviceName: string | null = null;

/** The path as a key: forward slashes, no file://, so "C:\\a\\b.md" and "file:///C:/a/b.md" are one file. */
export function fileKey(path: string): string {
  return path
    .trim()
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/^\/([a-zA-Z]:\/)/, "$1");
}

/** A device's name without the platform the server adds, compared case-insensitively. */
export function baseDeviceName(name: string | null | undefined): string {
  return (name || "").replace(/\s+\((?:Darwin|Windows|Linux)\)$/i, "").trim().toLowerCase();
}

export function rememberFileDevice(path: string | null | undefined, device: FileDevice | null | undefined): void {
  if (!path || !device || (!device.id && !device.name)) return;
  const key = fileKey(path);
  owners.delete(key);
  owners.set(key, { ...(device.id ? { id: device.id } : {}), ...(device.name ? { name: device.name } : {}) });
  if (owners.size > MAX_PATHS) owners.delete(owners.keys().next().value as string);
}

export function fileDevice(path: string | null | undefined): FileDevice | undefined {
  return path ? owners.get(fileKey(path)) : undefined;
}

/** The desktop app's own device name (from its daemon), so its files are read from disk. */
export function setLocalDeviceName(name: string | null | undefined): void {
  localDeviceName = name ? name : null;
}

/** true / false when the file's device is known to be / not to be this computer, null when unknown. */
export function onThisDevice(device: FileDevice | undefined): boolean | null {
  if (!device?.name || !localDeviceName) return null;
  return baseDeviceName(device.name) === baseDeviceName(localDeviceName);
}

/** Whether a path can't be this computer's: a Windows drive path on a Mac or Linux, or a Mac/Linux
 * home or system folder on Windows (Git Bash's "/c/..." and "/tmp/..." can be, so they count as local). */
export function foreignPathStyle(path: string, windows: boolean): boolean {
  const p = fileKey(path);
  if (/^[a-zA-Z]:\//.test(p)) return !windows;
  if (!windows) return false;
  return /^\/(Users|home|Volumes|private|var|opt|root|data\d*|Library|System)\//.test(p);
}

/** The server relay URL that streams a device's file (with Range), authenticated by the page's token. */
export function deviceRelayUrl(path: string, filename: string, device?: FileDevice, token?: string | null): string {
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  const id = encodeURIComponent(device?.id || device?.name || "auto");
  return `${getApiBase()}/api/devices/${id}/files/stream/${encodeURIComponent(filename || "file")}?path=${encodeURIComponent(path)}${tokenParam}`;
}

/** The device fields of a task result or a tool call (result.device_id / device_name, or args.device_id). */
export function deviceOfCall(call: unknown): FileDevice | undefined {
  if (!call || typeof call !== "object") return undefined;
  const c = call as { result?: unknown; args?: unknown; device_id?: unknown; device_name?: unknown };
  const pick = (o: unknown): FileDevice | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const r = o as { device_id?: unknown; device_name?: unknown };
    const id = typeof r.device_id === "string" && r.device_id && !["auto", "all", "ask_only"].includes(r.device_id) ? r.device_id : undefined;
    const name = typeof r.device_name === "string" && r.device_name ? r.device_name : undefined;
    return id || name ? { id, name } : undefined;
  };
  return pick(c.result) ?? pick(c) ?? pick(c.args);
}
