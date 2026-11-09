import { homedir } from "node:os";

/**
 * The file a request names, spelled the way this device's file system wants it. Agents on Windows report
 * paths the way Git Bash, Cygwin, WSL or a file:// URL writes them ("/c/Users/a/x.md", "/cygdrive/c/...",
 * "/mnt/c/...", "/C:/..."), and the workbench passes them on unchanged; Node would read those as folders
 * under the current drive's root. "~" is the user's home folder on every platform.
 */
export function deviceFilePath(raw: string, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\/(?:localhost(?=\/))?/i, "");
    try {
      p = decodeURIComponent(p);
    } catch {
      // a literal "%" in the name: keep it as it is
    }
  }
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = home + p.slice(1);
  if (platform !== "win32") return p;
  if (/^\/[a-zA-Z]:(?:[/\\]|$)/.test(p)) return p.slice(1);
  const drive = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?=\/|$)/.exec(p);
  const letter = drive?.[1];
  if (drive && letter) return `${letter.toUpperCase()}:/${p.slice(drive[0].length + 1)}`;
  return p;
}
