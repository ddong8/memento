// /api/system/update: desktop client auto-update distribution (server/server/api/updates.py).
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono, type Context } from "hono";

import type { Settings } from "../config";
import type { AppEnv } from "../context";
import { HttpError, queryRequiredString } from "../http";

export const updateRoutes = new Hono<AppEnv>();

interface ReleaseAsset {
  name?: string;
  size?: number;
  digest?: string;
  url?: string;
  browser_download_url?: string;
}

interface ReleaseData {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  assets?: ReleaseAsset[];
}

const releaseCache: { time: number; data: ReleaseData | null } = { time: 0, data: null };
const yamlCache = new Map<string, { time: number; bytes: Uint8Array }>();

function updatesDirOf(settings: Settings): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    settings.updatesDir || "",
    "/app/data/updates",
    resolve(process.cwd(), "data/updates"),
    resolve(here, "../../../../data/updates"),
    resolve(here, "../../../data/updates"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1]!;
}

export function compareSemver(target: string, current: string): boolean {
  if (!target || !current) return false;
  const tNums = (target.match(/\d+/g) ?? ["0"]).map(Number);
  const cNums = (current.match(/\d+/g) ?? ["0"]).map(Number);
  const len = Math.max(tNums.length, cNums.length);
  for (let i = 0; i < len; i++) {
    const a = tNums[i] ?? 0;
    const b = cNums[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function isWindows(plat: string): boolean {
  return /^win(?:dows|32|64)?\b/.test(plat.trim().toLowerCase());
}

function globToRegex(pat: string): RegExp {
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`);
}

async function findPlatformAsset(dir: string, platform: string): Promise<{ name: string; path: string; size: number } | null> {
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const plat = platform.toLowerCase();
  const patterns = isWindows(plat)
    ? ["*windows*.zip", "*win*.zip", "*win*.exe", "*.msi", "*.exe"]
    : plat.includes("mac") || plat.includes("darwin")
      ? ["*macos*.zip", "*mac*.zip", "*.dmg", "*.pkg"]
      : plat.includes("linux")
        ? ["*linux*.tar.gz", "*linux*.zip", "*.AppImage", "*.deb"]
        : [`*${plat}*`];

  for (const pat of patterns) {
    const re = globToRegex(pat);
    for (const name of names) {
      if (!re.test(name) || name.endsWith(".json") || name.endsWith(".part")) continue;
      const full = resolve(dir, name);
      try {
        const st = await stat(full);
        if (st.isFile()) return { name, path: full, size: st.size };
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function localAssetName(localMeta: Record<string, unknown>, platform: string, localFile: { name: string } | null): string | null {
  if (localFile) return localFile.name;
  const platforms = localMeta.platforms;
  if (platforms && typeof platforms === "object") {
    const pm = (platforms as Record<string, unknown>)[platform.toLowerCase()];
    if (pm && typeof pm === "object" && typeof (pm as Record<string, unknown>).asset_name === "string") {
      return (pm as Record<string, unknown>).asset_name as string;
    }
  }
  return null;
}

function assetIsForVersion(name: string | null, version: string): boolean {
  if (!name) return false;
  const m = /(\d+\.\d+\.\d+)/.exec(name);
  return m === null || m[1] === version;
}

export function matchGithubAsset(assets: ReleaseAsset[], platform: string): ReleaseAsset | null {
  const plat = platform.toLowerCase();
  if (isWindows(plat)) {
    for (const a of assets) {
      const n = (a.name ?? "").toLowerCase();
      if ((n.includes("win") || n.includes("windows")) && n.endsWith(".zip")) return a;
    }
    for (const a of assets) {
      const n = (a.name ?? "").toLowerCase();
      if ((n.includes("win") || n.includes("windows")) && (n.endsWith("setup.exe") || n.endsWith(".exe") || n.endsWith(".msi"))) return a;
    }
  } else if (plat.includes("mac") || plat.includes("darwin")) {
    for (const a of assets) {
      const n = (a.name ?? "").toLowerCase();
      if ((n.includes("mac") || n.includes("darwin")) && n.endsWith(".zip")) return a;
    }
    for (const a of assets) {
      const n = (a.name ?? "").toLowerCase();
      if ((n.includes("mac") || n.includes("darwin")) && n.endsWith(".dmg")) return a;
    }
  } else if (plat.includes("linux")) {
    for (const a of assets) {
      const n = (a.name ?? "").toLowerCase();
      if (n.includes("linux") && (n.endsWith(".tar.gz") || n.endsWith(".zip"))) return a;
    }
    for (const a of assets) {
      const n = (a.name ?? "").toLowerCase();
      if (n.includes("linux") && (n.endsWith(".deb") || n.endsWith(".appimage"))) return a;
    }
  }
  for (const a of assets) {
    const n = (a.name ?? "").toLowerCase();
    if (n.includes(plat) && !n.endsWith(".txt") && !n.endsWith(".sha256")) return a;
  }
  return null;
}

async function fetchLatestGithubRelease(settings: Settings, forceRefresh = false): Promise<ReleaseData | null> {
  const now = Date.now() / 1000;
  if (!forceRefresh && releaseCache.data && now - releaseCache.time < settings.updateCacheTtl) {
    return releaseCache.data;
  }
  const urls = [
    `https://api.github.com/repos/${settings.githubRepo}/releases/latest`,
    `https://mirror.ghproxy.com/https://api.github.com/repos/${settings.githubRepo}/releases/latest`,
  ];
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Memento-Server-Updater/1.0",
  };
  if (settings.githubToken) headers.Authorization = `Bearer ${settings.githubToken}`;

  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const data = (await resp.json()) as ReleaseData;
        if (data && typeof data === "object" && "tag_name" in data) {
          releaseCache.time = now;
          releaseCache.data = data;
          return data;
        }
      }
    } catch {
      /* try next mirror */
    }
  }
  return releaseCache.data;
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function localYamlIsCurrent(settings: Settings, path: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return false;
  }
  const m = /^version:\s*['"]?[vV]?([0-9][^\s'"]*)/m.exec(text);
  if (!m) return false;
  const gh = await fetchLatestGithubRelease(settings);
  const ghVer = String(gh?.tag_name ?? "").trim().replace(/^[vV]+/, "");
  return !compareSemver(ghVer, m[1]!);
}

async function synthesizeFallbackYaml(dir: string, safeName: string): Promise<Uint8Array | null> {
  const meta = await readJsonFile(resolve(dir, "version.json"));
  const ver = String(meta.version ?? "").trim().replace(/^[vV]+/, "");
  if (!ver) return null;
  const low = safeName.toLowerCase();
  const platKey = low.includes("mac") ? "macos" : low.includes("linux") ? "linux" : "windows";
  const platforms = (meta.platforms as Record<string, Record<string, unknown>> | undefined) ?? {};
  const pm = platforms[platKey] ?? {};
  const assetName = String(pm.asset_name || `Memento-${ver}-win-x64.exe`);
  const size = Number(pm.size || 0);
  const sha256Val = String(pm.sha256 || "");
  const sha512Val = String(pm.sha512 || "");

  const fileLines = [`  - url: ${assetName}`];
  if (sha512Val) fileLines.push(`    sha512: ${sha512Val}`);
  if (sha256Val) fileLines.push(`    sha2: ${sha256Val}`);
  fileLines.push(`    size: ${size}`);

  const topShaLines: string[] = [];
  if (sha512Val) topShaLines.push(`sha512: ${sha512Val}`);
  if (sha256Val) topShaLines.push(`sha2: ${sha256Val}`);
  const topShaStr = topShaLines.length ? `${topShaLines.join("\n")}\n` : "";

  const yaml =
    `version: ${ver}\n` +
    `files:\n` +
    `${fileLines.join("\n")}\n` +
    `path: ${assetName}\n` +
    `${topShaStr}` +
    `releaseDate: '${String(meta.published_at || "2026-10-09T00:00:00.000Z")}'\n`;
  return new TextEncoder().encode(yaml);
}

updateRoutes.get("/check", async (c) => {
  const { settings } = c.var.deps;
  const platform = c.req.query("platform") ?? "windows";
  const version = c.req.query("version") ?? "1.0.0";
  const platLower = platform.toLowerCase();

  if (["ios", "iphone", "ipad", "android", "mobile"].some((m) => platLower.includes(m))) {
    return c.json({
      has_update: false,
      latest_version: version,
      current_version: version,
      title: "Memento",
      release_notes: "移动端请在 GitHub Release 发布页查看安装说明。",
      published_at: null,
      download_url: null,
      upstream_url: null,
      asset_name: null,
      asset_size: null,
      sha256: null,
    });
  }

  const dir = updatesDirOf(settings);
  const localMeta = await readJsonFile(resolve(dir, "version.json"));
  const localVer = String(localMeta.version ?? "").trim().replace(/^[vV]+/, "");
  const localPlatformAsset = await findPlatformAsset(dir, platform);
  const ghRelease = await fetchLatestGithubRelease(settings);

  let ghVer = "";
  let ghAsset: ReleaseAsset | null = null;
  if (ghRelease) {
    ghVer = String(ghRelease.tag_name ?? "").trim().replace(/^[vV]+/, "");
    if (Array.isArray(ghRelease.assets)) ghAsset = matchGithubAsset(ghRelease.assets, platform);
  }

  let useGithub = false;
  let latestVer = "";
  if (ghVer && localVer) {
    if (
      compareSemver(ghVer, localVer) ||
      (ghVer === localVer && Boolean(ghAsset)) ||
      (compareSemver(localVer, ghVer) && !assetIsForVersion(localAssetName(localMeta, platform, localPlatformAsset), localVer))
    ) {
      latestVer = ghVer;
      useGithub = true;
    } else {
      latestVer = localVer;
      useGithub = false;
    }
  } else if (ghVer) {
    latestVer = ghVer;
    useGithub = true;
  } else if (localVer) {
    latestVer = localVer;
    useGithub = false;
  } else if (localPlatformAsset) {
    const m = /(\d+\.\d+\.\d+)/.exec(localPlatformAsset.name);
    if (m) latestVer = m[1]!;
  }

  if (!latestVer && !localPlatformAsset) {
    return c.json({
      has_update: false,
      latest_version: "",
      current_version: version,
      title: "",
      release_notes: "服务端暂未托管更新包",
      published_at: null,
      download_url: null,
      upstream_url: null,
      asset_name: null,
      asset_size: null,
      sha256: null,
    });
  }

  const cleanCurrent = version.trim().replace(/^[vV]+/, "");
  const hasUpdate = latestVer ? compareSemver(latestVer, cleanCurrent) : localPlatformAsset !== null;

  let title = `Memento v${latestVer}`;
  let releaseNotes = "修复已知问题并提升稳定性。";
  let publishedAt: string | null = null;
  let assetName: string | null = null;
  let assetSize: number | null = null;
  let sha256Val: string | null = null;

  const platforms = (localMeta.platforms as Record<string, Record<string, unknown>> | undefined) ?? {};
  const platMeta = platforms[platLower];

  if (useGithub && ghRelease) {
    title = String(ghRelease.name || title);
    const ghBody = String(ghRelease.body || "").trim();
    if (ghBody && !ghBody.startsWith("**Full Changelog**")) releaseNotes = ghBody;
    else if (typeof localMeta.release_notes === "string" && localMeta.release_notes) releaseNotes = localMeta.release_notes;
    else releaseNotes = ghBody || releaseNotes;
    publishedAt = ghRelease.published_at ?? null;
    if (ghAsset) {
      assetName = ghAsset.name ?? null;
      assetSize = ghAsset.size ?? null;
      const rawDigest = String(ghAsset.digest ?? "");
      if (rawDigest.startsWith("sha256:")) sha256Val = rawDigest.slice("sha256:".length).trim();
    }
    if (!sha256Val && localVer === latestVer && platMeta && platMeta.asset_name === assetName) {
      sha256Val = (platMeta.sha256 as string | undefined) ?? null;
    }
  } else {
    title = (localMeta.title as string | undefined) ?? title;
    releaseNotes = (localMeta.release_notes as string | undefined) ?? releaseNotes;
    publishedAt = (localMeta.published_at as string | undefined) ?? null;
    if (platMeta && typeof platMeta === "object") {
      assetName = (platMeta.asset_name as string | undefined) ?? null;
      assetSize = (platMeta.size as number | undefined) ?? null;
      sha256Val = (platMeta.sha256 as string | undefined) ?? null;
    }
    if (localPlatformAsset) {
      assetName = localPlatformAsset.name;
      assetSize = localPlatformAsset.size;
    } else if (ghRelease && ghVer === latestVer && Array.isArray(ghRelease.assets)) {
      const exact = assetName ? ghRelease.assets.find((a) => a.name === assetName) ?? null : null;
      const matched = exact ?? ghAsset;
      if (matched && matched.size) {
        assetSize = matched.size;
        if (!assetName) assetName = matched.name ?? null;
        ghAsset = matched;
      }
    }
  }

  let downloadUrl: string | null = null;
  if (assetName) {
    const vParam = latestVer ? `&version=${latestVer}` : "";
    downloadUrl = `/api/system/update/download?file=${assetName}${vParam}`;
  }

  let upstreamUrl: string | null = null;
  if (settings.githubToken && downloadUrl) {
    upstreamUrl = downloadUrl;
  } else if (ghAsset && ghVer === latestVer) {
    upstreamUrl = ghAsset.browser_download_url ?? null;
  } else if (latestVer && assetName) {
    const tagPrefix = latestVer.startsWith("v") ? latestVer : `v${latestVer}`;
    upstreamUrl = `https://github.com/${settings.githubRepo}/releases/download/${tagPrefix}/${assetName}`;
  }

  return c.json({
    has_update: hasUpdate,
    latest_version: latestVer || version,
    current_version: version,
    title,
    release_notes: releaseNotes,
    published_at: publishedAt,
    download_url: downloadUrl,
    upstream_url: upstreamUrl,
    asset_name: assetName,
    asset_size: assetSize,
    sha256: sha256Val,
  });
});

async function handleDownload(c: Context<AppEnv>, file: string, version: string | null) {
  const { settings } = c.var.deps;
  const safeName = basename(file);
  if (!/^[\w.-]+$/.test(safeName)) throw new HttpError(400, "Invalid filename");

  const dir = updatesDirOf(settings);
  const filePath = resolve(dir, safeName);
  const isYaml = safeName.endsWith(".yml");
  const isHead = c.req.method === "HEAD";

  if (existsSync(filePath)) {
    try {
      const st = await stat(filePath);
      if (st.isFile() && (!isYaml || (await localYamlIsCurrent(settings, filePath)))) {
        const headers: Record<string, string> = {
          "content-type": isYaml ? "text/yaml; charset=utf-8" : "application/octet-stream",
          "cache-control": isYaml ? "no-cache, no-store, must-revalidate" : "public, max-age=600",
          "content-disposition": `attachment; filename="${safeName}"`,
          "content-length": String(st.size),
        };
        if (isYaml) {
          headers.pragma = "no-cache";
          headers.expires = "0";
        }
        return new Response(isHead ? null : await readFile(filePath), { status: 200, headers });
      }
    } catch {
      /* fall through to GitHub */
    }
  }

  let tag = (version ?? "").trim();
  if (!tag) {
    const m = /[vV]?(\d+\.\d+\.\d+)/.exec(safeName);
    if (m) tag = m[1]!;
  }
  const ghRelease = await fetchLatestGithubRelease(settings);
  if (!tag) {
    const meta = await readJsonFile(resolve(dir, "version.json"));
    const localVer = String(meta.version ?? "").trim().replace(/^[vV]+/, "");
    const ghVer = String(ghRelease?.tag_name ?? "").trim().replace(/^[vV]+/, "");
    if (ghVer && localVer) tag = compareSemver(ghVer, localVer) ? ghVer : localVer;
    else tag = ghVer || localVer;
  }
  const tagName = tag.startsWith("v") ? tag : tag ? `v${tag}` : "v1.0.66";
  const matchedAsset = Array.isArray(ghRelease?.assets) ? ghRelease!.assets!.find((a) => a.name === safeName) ?? null : null;

  if (isYaml) {
    const yamlHeaders: Record<string, string> = {
      "content-type": "text/yaml; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      pragma: "no-cache",
      expires: "0",
    };
    const now = Date.now() / 1000;
    const ck = `${tagName}:${safeName}`;
    const cached = yamlCache.get(ck);
    if (cached && now - cached.time < settings.updateCacheTtl) {
      return new Response(isHead ? null : new Uint8Array(cached.bytes), { status: 200, headers: yamlHeaders });
    }
    if (matchedAsset?.url) {
      try {
        const headers: Record<string, string> = { Accept: "application/octet-stream", "User-Agent": "Memento-Server-Updater/1.0" };
        if (settings.githubToken) headers.Authorization = `Bearer ${settings.githubToken}`;
        const resp = await fetch(matchedAsset.url, { headers, signal: AbortSignal.timeout(10_000) });
        if (resp.ok) {
          const bytes = new Uint8Array(await resp.arrayBuffer());
          if (bytes.length) {
            yamlCache.set(ck, { time: now, bytes });
            return new Response(isHead ? null : new Uint8Array(bytes), { status: 200, headers: yamlHeaders });
          }
        }
      } catch {
        /* fall back */
      }
    }
    const fallbackYaml = await synthesizeFallbackYaml(dir, safeName);
    if (fallbackYaml) {
      return new Response(isHead ? null : new Uint8Array(fallbackYaml), { status: 200, headers: yamlHeaders });
    }
  }

  if (matchedAsset?.url && settings.githubToken) {
    try {
      const resp = await fetch(matchedAsset.url, {
        redirect: "manual",
        headers: {
          Accept: "application/octet-stream",
          Authorization: `Bearer ${settings.githubToken}`,
          "User-Agent": "Memento-Server-Updater/1.0",
        },
        signal: AbortSignal.timeout(8000),
      });
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const loc = resp.headers.get("location");
        if (loc) return c.redirect(loc, 302);
      }
    } catch {
      /* fall back */
    }
  }

  return c.redirect(`https://github.com/${settings.githubRepo}/releases/download/${tagName}/${safeName}`, 302);
}

updateRoutes.on(["GET", "HEAD"], "/download", async (c) => {
  const file = queryRequiredString(c, "file");
  const version = c.req.query("version") ?? null;
  return handleDownload(c, file, version);
});

updateRoutes.on(["GET", "HEAD"], "/:filename", async (c) => {
  const filename = c.req.param("filename");
  const version = c.req.query("version") ?? null;
  return handleDownload(c, filename, version);
});
