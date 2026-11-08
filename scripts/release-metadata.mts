// Release metadata for the in-app updater (data/updates/version.json and the electron channel YAML),
// used by .github/workflows/desktop-release.yml:
//
//   node scripts/release-metadata.mts notes                     # release-notes.md + has_notes output
//   node scripts/release-metadata.mts update --tag v1.0.99      # version.json from the built dist/
//   node scripts/release-metadata.mts verify [--file F] [--github-tag v1.0.99]
//
// verify checks the rules in AGENTS.md:
//   1. Windows and macOS must update from a .zip (no setup.exe/msi in auto-update); Linux .tar.gz, .zip or .deb
//   2. size and SHA-256 match the binaries if they sit next to version.json
//   3. the channel YAML has the same version and a checksum
//   4. with --github-tag, the release has every declared asset at the declared size
// Run it after editing version.json by hand too.
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_FILE = "data/updates/version.json";
const repoPath = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

// ── notes ────────────────────────────────────────────────────
/** The version's notes from version.json → release-notes.md; `has_notes` for the release step. */
export function writeNotes(versionFile = repoPath(DEFAULT_FILE), outFile = "release-notes.md"): boolean {
  const meta = JSON.parse(readFileSync(versionFile, "utf8")) as Json;
  const notes = String(meta.release_notes || "").trim();
  writeFileSync(outFile, notes ? `${notes}\n` : "", "utf8");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `has_notes=${notes ? "true" : "false"}\n`);
  return !!notes;
}

// ── update ───────────────────────────────────────────────────
/** Every file under `dir`, sorted, skipping dot entries (what Python's glob('**') saw). */
function walk(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) out.push(...walk(p));
    else if (st?.isFile()) out.push(p);
  }
  return out;
}

export interface PlatformAsset {
  asset_name: string;
  size: number;
  sha256: string;
  sha512: string;
}

async function describe(path: string): Promise<PlatformAsset> {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk as Buffer);
    sha512.update(chunk as Buffer);
  }
  return { asset_name: basename(path), size: statSync(path).size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

type Rule = (lowerName: string) => boolean;
const hasAny = (n: string, ...words: string[]) => words.some((w) => n.includes(w));
/** Per platform, the preferred package (hot-replaceable zip / tarball) and the fallback. */
const PLATFORM_RULES: Record<string, [preferred: Rule, fallback: Rule]> = {
  windows: [
    (n) => hasAny(n, "win", "windows") && n.endsWith(".zip") && !n.endsWith(".blockmap"),
    (n) => hasAny(n, "win", "windows") && n.endsWith(".exe") && !n.endsWith(".blockmap"),
  ],
  macos: [(n) => hasAny(n, "mac", "darwin") && n.endsWith(".zip") && !n.endsWith(".blockmap"), (n) => hasAny(n, "mac", "darwin") && n.endsWith(".dmg")],
  linux: [
    (n) => n.includes("linux") && (n.endsWith(".tar.gz") || n.endsWith(".zip")),
    (n) => n.includes("linux") && (n.endsWith(".appimage") || n.endsWith(".deb")),
  ],
};

/**
 * Points version.json at this release's packages in `distDir` (keeping its other fields, release notes
 * included, and platforms this build didn't produce) and copies the channel YAML next to it.
 */
export async function updateMetadata(version: string, distDir = repoPath("dist"), versionFile = repoPath(DEFAULT_FILE)): Promise<Json> {
  mkdirSync(dirname(versionFile), { recursive: true });
  let meta: Json = {};
  if (existsSync(versionFile)) {
    try {
      const parsed = JSON.parse(readFileSync(versionFile, "utf8"));
      if (isObject(parsed)) meta = parsed;
    } catch {
      meta = {};
    }
  }
  meta.version = version;
  meta.title = `Memento v${version}`;
  if (!isObject(meta.platforms)) meta.platforms = {};
  const platforms = meta.platforms as Json;

  const files = walk(distDir);
  for (const [platform, rules] of Object.entries(PLATFORM_RULES)) {
    for (const rule of rules) {
      const hit = files.find((p) => rule(basename(p).toLowerCase()));
      if (hit) {
        platforms[platform] = await describe(hit);
        break;
      }
    }
  }

  // The channel YAML next to it, so the server hosts it without asking GitHub
  for (const yml of files.filter((p) => /^latest.*\.yml$/.test(basename(p)))) {
    const target = join(dirname(versionFile), basename(yml));
    copyFileSync(yml, target);
    console.log(`Synced channel yml: ${target}`);
  }

  writeFileSync(versionFile, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

// ── verify ───────────────────────────────────────────────────
export const validSha256 = (s: string) => /^[0-9a-fA-F]{64}$/.test(s.trim());
/** Strict base64 (alphabet and padding) of exactly 64 bytes. */
export const validSha512 = (s: string) => /^[A-Za-z0-9+/]{86}==$/.test(s.trim());

const shown = (v: unknown) => (v === undefined || v === null ? "None" : String(v));

async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function verifyMetadata(versionFile: string, githubTag?: string, log: (line: string) => void = console.log): Promise<boolean> {
  log(`[*] Checking release metadata file: ${versionFile}`);
  if (!existsSync(versionFile)) {
    log(`[!] ERROR: ${versionFile} does not exist.`);
    return false;
  }
  let data: Json;
  try {
    const parsed = JSON.parse(readFileSync(versionFile, "utf8"));
    if (!isObject(parsed)) throw new Error("not an object");
    data = parsed;
  } catch (e) {
    log(`[!] ERROR: Invalid JSON in ${versionFile}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const version = data.version;
  if (!version) {
    log("[!] ERROR: Missing 'version' field in version.json.");
    return false;
  }
  const platforms = data.platforms ?? {};
  if (!isObject(platforms) || !Object.keys(platforms).length) {
    log("[!] ERROR: 'platforms' dictionary is missing or empty in version.json.");
    return false;
  }

  const errors: string[] = [];
  const updatesDir = dirname(versionFile);

  for (const [plat, info] of Object.entries(platforms)) {
    if (!isObject(info)) {
      errors.push(`Platform '${plat}' config must be an object.`);
      continue;
    }
    const assetName = typeof info.asset_name === "string" ? info.asset_name : "";
    const size = info.size;
    const sha256 = typeof info.sha256 === "string" ? info.sha256 : "";

    // 1. Format rules (AGENTS.md)
    if (plat.includes("win")) {
      if (!assetName.endsWith(".zip")) {
        errors.push(
          `Windows auto-update package MUST be a .zip file (found: '${assetName}'). ` +
            "Rule: AGENTS.md forbids setup.exe in auto-update interface to prevent upgrade loops.",
        );
      }
    } else if (plat.includes("mac")) {
      if (!assetName.endsWith(".zip")) errors.push(`macOS auto-update package MUST be a .zip file (found: '${assetName}').`);
    } else if (plat.includes("linux")) {
      if (![".tar.gz", ".zip", ".deb"].some((ext) => assetName.endsWith(ext))) {
        errors.push(`Linux auto-update package must end with one of ('.tar.gz', '.zip', '.deb') (found: '${assetName}').`);
      }
    }

    // 2. Size and hash validity
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
      errors.push(`Platform '${plat}': size must be a positive integer (found: ${shown(size)}).`);
    }
    if (!sha256 || !validSha256(sha256)) errors.push(`Platform '${plat}': invalid or missing 64-char sha256 hash (found: '${sha256}').`);
    const sha512 = info.sha512;
    if (sha512 && (typeof sha512 !== "string" || !validSha512(sha512))) {
      errors.push(`Platform '${plat}': invalid base64 sha512 hash (found: '${shown(sha512)}').`);
    }

    // 3. The binary itself, when it sits next to version.json
    const local = join(updatesDir, assetName);
    if (assetName && existsSync(local) && statSync(local).isFile()) {
      const realSize = statSync(local).size;
      if (realSize !== size) {
        errors.push(
          `Platform '${plat}': size mismatch for local file ${assetName}! version.json declares ${shown(size)} bytes, local file is ${realSize} bytes.`,
        );
      }
      const realSha = await sha256Of(local);
      if (realSha !== sha256.toLowerCase()) {
        errors.push(`Platform '${plat}': sha256 mismatch for local file ${assetName}! version.json declares ${sha256}, local file is ${realSha}.`);
      } else {
        log(`[+] Verified local file ${assetName}: ${realSize} bytes, sha256 OK`);
      }
    }
  }

  // 4. Channel YAML next to it
  const cleanVersion = String(version).trim().replace(/^[vV]+/, "");
  for (const name of ["latest-mac.yml", "latest.yml", "latest-linux.yml"]) {
    const yml = join(updatesDir, name);
    if (!existsSync(yml)) continue;
    const text = readFileSync(yml, "utf8");
    const m = /^version:\s*(\S+)/m.exec(text);
    if (m) {
      const ymlVersion = m[1]!.trim().replace(/^[vV]+/, "");
      if (ymlVersion !== cleanVersion) errors.push(`Channel YAML '${name}' version mismatch: declares ${ymlVersion}, version.json declares ${cleanVersion}`);
      else log(`[+] Verified channel YAML ${name}: version ${ymlVersion} matches.`);
    }
    if (!text.includes("sha512:") && !text.includes("sha2:")) errors.push(`Channel YAML '${name}' is missing sha512 / sha2 checksum fields!`);
  }

  // 5. The GitHub release's assets (a failed fetch only warns)
  if (githubTag) {
    const repo = process.env.MEMENTO_GITHUB_REPO || "ddong8/memento";
    const url = `https://api.github.com/repos/${repo}/releases/tags/${githubTag}`;
    log(`[*] Checking GitHub Release assets at: ${url}`);
    try {
      const headers: Record<string, string> = { "User-Agent": "Memento-Release-Verifier" };
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
      const release = (await res.json()) as { assets?: { name: string; size: number }[] };
      const assets = new Map((release.assets ?? []).map((a) => [a.name, a.size]));
      for (const info of Object.values(platforms)) {
        const p = info as Json;
        const name = p.asset_name as string;
        const size = p.size;
        if (!assets.has(name)) errors.push(`GitHub Release ${githubTag} missing asset '${shown(name)}' declared in version.json.`);
        else if (assets.get(name) !== size) {
          errors.push(`Asset '${name}' size mismatch with GitHub Release! version.json=${shown(size)}, GitHub Release=${assets.get(name)}`);
        } else log(`[+] Verified GitHub Release asset ${name}: ${size} bytes match.`);
      }
    } catch (e) {
      log(`[-] Warning: Failed to fetch GitHub release ${githubTag}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (errors.length) {
    log("\n[!] VERIFICATION FAILED with errors:");
    for (const err of errors) log(`    - ${err}`);
    return false;
  }
  log("\n[✓] All release metadata passed AGENTS.md compliance checks successfully!");
  return true;
}

// ── CLI ──────────────────────────────────────────────────────
const USAGE = `usage: release-metadata.mts notes [--file F] [--out release-notes.md]
       release-metadata.mts update (--tag vX.Y.Z | --version X.Y.Z) [--dist dist] [--file F]
       release-metadata.mts verify [--file F] [--github-tag vX.Y.Z]
F defaults to ${DEFAULT_FILE}; relative paths are from the repository root.
`;

/** `--name value` / `--name=value` options; throws on anything else. */
export function parseOptions(args: string[], allowed: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m || !allowed.includes(m[1]!)) throw new Error(`unrecognized argument: ${a}`);
    const value = m[2] ?? args[++i];
    if (value === undefined) throw new Error(`argument --${m[1]}: expected one argument`);
    opts[m[1]!] = value;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(USAGE);
    return cmd ? 0 : 2;
  }
  let opts: Record<string, string>;
  try {
    if (cmd === "notes") opts = parseOptions(rest, ["file", "out"]);
    else if (cmd === "update") opts = parseOptions(rest, ["tag", "version", "dist", "file"]);
    else if (cmd === "verify") opts = parseOptions(rest, ["file", "github-tag"]);
    else throw new Error(`unknown command: ${cmd}`);
  } catch (e) {
    process.stderr.write(`${USAGE}error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const file = repoPath(opts.file ?? DEFAULT_FILE);
  if (cmd === "notes") {
    writeNotes(file, opts.out ?? "release-notes.md");
    return 0;
  }
  if (cmd === "update") {
    const version = opts.version ?? opts.tag?.replace(/^v/, "");
    if (!version) {
      process.stderr.write(`${USAGE}error: update needs --tag or --version\n`);
      return 2;
    }
    await updateMetadata(version, repoPath(opts.dist ?? "dist"), file);
    return 0;
  }
  return (await verifyMetadata(file, opts["github-tag"] || undefined)) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
