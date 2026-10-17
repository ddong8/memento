import { DeviceSummary,ProjectSummary,type ProjectDevice } from "@/lib/api-client";

export function isConcreteDevice(deviceId?: string | null): deviceId is string {
  return !!deviceId && !["auto", "ask_only", "all"].includes(deviceId);
}

export function isDeviceOnline(d: DeviceSummary): boolean {
  return d.online ?? (d.last_heartbeat ? Date.now() - new Date(d.last_heartbeat).getTime() < 180_000 : false);
}

/** A project folder as typed into the working-directory field. */
export function cleanProjectPath(raw?: string | null): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const match = s.match(/((?:[a-zA-Z]:[/\\]|\/)[a-zA-Z0-9_.\-]+(?:[/\\][a-zA-Z0-9_.\-]+)*)/);
  if (match) return match[1].replace(/[/\\]+$/, "");
  return s.split(/[\r\n",]/)[0].trim().replace(/[/\\]+$/, "");
}

export function pathWithin(child: string, root: string): boolean {
  const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const c = norm(child);
  const r = norm(root);
  return !!r && (c === r || c.startsWith(`${r}/`));
}

/** The project's folder on a device: never another machine's folder. */
export function projectPathOn(proj: ProjectSummary | undefined, deviceId?: string): string {
  if (!proj) return "";
  if (proj.devices && proj.devices.length > 0) {
    if (!isConcreteDevice(deviceId)) return cleanProjectPath(proj.devices[0].source_path || proj.source_path);
    const here = proj.devices.find((d) => d.device_id === deviceId);
    return here ? cleanProjectPath(here.source_path) : "";
  }
  return cleanProjectPath(proj.source_path);
}

/** In auto mode a project runs where it lives: the device it was most recently worked on, online ones first. */
export function homeDeviceOf(proj: ProjectSummary | undefined, devices: DeviceSummary[]): ProjectDevice | undefined {
  const homes = proj?.devices || [];
  const online = (id: string) => devices.some((d) => d.device_id === id && isDeviceOnline(d));
  return homes.find((h) => online(h.device_id)) || homes[0];
}
