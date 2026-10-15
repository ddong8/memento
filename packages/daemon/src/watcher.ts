import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { homeDir, type CollectorConfig } from "./config.js";
import { cleanPath, decodeClaudeDir, isInvalidProjectName, type DiscoveredTool } from "./discovery.js";
import { getAntigravitySessionInfo } from "./antigravity.js";
import type { IngestClient } from "./ingest.js";
import { contentHash } from "./sanitizer.js";

const MAX_BATCH = 512 * 1024; // bytes per upload
const MAX_LINE = 128 * 1024; // a longer line (base64 dump) keeps its head and tail
const DEBOUNCE_MS = 2000;
const RESCAN_MS = 60_000;

type Log = (message: string) => void;

/** Which directory of each tool holds its sessions. */
export function watchTargets(tools: Record<string, DiscoveredTool>, extraDirs: string[]): Map<string, string> {
  const targets = new Map<string, string>(); // dir -> tool id
  const add = (dir: string, tool: string) => existsSync(dir) && targets.set(dir, tool);
  for (const tool of Object.values(tools)) {
    switch (tool.id) {
      case "claude_code":
        add(join(tool.root, "projects"), "claude_code");
        add(join(tool.root, "plans"), "claude_code");
        break;
      case "codex":
        add(join(tool.root, "sessions"), "codex");
        break;
      case "antigravity":
        add(join(tool.root, "brain"), "antigravity");
        break;
      case "workbuddy": {
        add(join(tool.root, "projects"), "workbuddy");
        const altRoot = tool.root.includes(".codebuddy")
          ? tool.root.replace(/\.codebuddy$/, ".workbuddy")
          : tool.root.replace(/\.workbuddy$/, ".codebuddy");
        add(join(altRoot, "projects"), "workbuddy");
        break;
      }
      case "cursor":
        add(join(tool.root, "projects"), "cursor");
        break;
      case "windsurf":
        add(join(tool.root, "cascade"), "windsurf");
        break;
      case "cline":
        add(join(tool.root, "tasks"), "cline");
        break;
    }
  }
  for (const dir of extraDirs) add(dir, "obsidian");
  return targets;
}

/** Whether a file under a watched directory is something to upload. */
export function isWatchedFile(filePath: string, toolId: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const name = basename(normalized);
  if (
    ["/.git/", "/node_modules/", "/build/", "/.dart_tool/", "/__pycache__/", "/.memento/", "/.system_generated/steps/", "/.system_generated/tasks/"].some(
      (seg) => normalized.includes(seg),
    ) ||
    name.startsWith(".") ||
    name.endsWith(".tmp") ||
    name.endsWith(".lock") ||
    name.startsWith("polling-lease-") ||
    name === "output.txt" ||
    name === "read.json"
  ) {
    return false;
  }
  switch (toolId) {
    case "antigravity":
      // transcript_full.jsonl repeats the conversation with raw base64 images.
      return name === "transcript.jsonl";
    case "claude_code":
      if (!name.endsWith(".jsonl") && !name.endsWith(".meta.json") && !name.endsWith(".md")) return false;
      return !name.includes("lease") && !name.includes("storage") && !name.includes("prefs");
    case "workbuddy":
      if (normalized.includes("/subagents/")) return false;
      return name.endsWith(".jsonl") && !name.includes("lease") && !name.includes("storage") && !name.includes("prefs");
    case "codex":
    case "cursor":
      return name.endsWith(".jsonl") || name.endsWith(".json");
    case "obsidian":
      return name.endsWith(".md");
    default:
      return [".md", ".json", ".jsonl", ".txt"].includes(extname(name).toLowerCase());
  }
}

/** The path the server files a document under. */
export function relativePathFor(filePath: string, toolId: string, extraDirs: string[] = []): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (toolId === "antigravity") {
    const m = /\/brain\/([^/]+)\//.exec(normalized);
    if (m) return `antigravity/brain/${m[1]}/transcript.jsonl`;
  } else if (toolId === "claude_code" || toolId === "workbuddy") {
    for (const seg of ["/projects/", "/plans/"]) {
      const i = normalized.indexOf(seg);
      if (i !== -1) return normalized.slice(i + 1);
    }
  } else if (toolId === "codex") {
    const i = normalized.indexOf("/sessions/");
    if (i !== -1) return normalized.slice(i + 1);
  } else if (toolId === "obsidian") {
    for (const dir of extraDirs) {
      const d = dir.replace(/\\/g, "/");
      if (normalized.startsWith(d)) return normalized.slice(d.length).replace(/^\//, "");
    }
  }
  return basename(filePath);
}

/** Lines of a slice, with giant lines cut down to their head and tail. */
export function cleanLines(raw: string): string[] {
  const out: string[] = [];
  for (let line of raw.split("\n")) {
    if (!line) continue;
    if (line.length > MAX_LINE) {
      line = `${line.slice(0, 64 * 1024)}\n...[TRUNCATED: line exceeded 128KB limit]...\n${line.slice(-32 * 1024)}`;
    }
    out.push(line);
  }
  return out;
}

/** Session id, title and project a slice of a session log belongs to. */
export function sessionMetadata(
  filePath: string,
  toolId: string,
  relPath: string,
  lines: string[],
  home = homeDir(),
): Record<string, unknown> {
  let sessionId = basename(filePath, extname(filePath));
  let title: string | undefined;
  let cwd: string | undefined;
  let project: string | undefined;
  const setProject = (candidate: string) => {
    const name = basename(candidate);
    if (!isInvalidProjectName(name)) {
      cwd = candidate;
      project = name;
      return true;
    }
    return false;
  };

  if (toolId === "antigravity") {
    const brain = /[/\\]brain[/\\]([^/\\]+)[/\\]/.exec(filePath);
    if (brain) sessionId = brain[1]!;

    // 1. Direct from official SQLite conversation_summaries.db
    const summary = getAntigravitySessionInfo(sessionId, home);
    if (summary) {
      if (summary.title) title = summary.title;
      if (summary.workspacePath) setProject(cleanPath(summary.workspacePath));
    }

    // 2. Legacy fallbacks
    if (!title) {
      try {
        const ann = readFileSync(join(home, ".gemini", "antigravity", "annotations", `${sessionId}.pbtxt`), "utf8");
        const t = /title:\s*"([^"]+)"/.exec(ann)?.[1]?.trim();
        if (t && !t.endsWith(".pbtxt")) title = t;
      } catch {
        // no annotation
      }
    }
    if (!cwd) {
      try {
        const db = readFileSync(join(home, ".gemini", "antigravity", "conversations", `${sessionId}.db`)).toString("utf8");
        const ws = /file:\/\/(\/[a-zA-Z]:\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*|\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)/.exec(db);
        if (ws) {
          let raw = ws[1]!;
          if (/^\/[a-zA-Z]:/.test(raw)) raw = raw.slice(1);
          setProject(cleanPath(raw));
        }
      } catch {
        // no conversation db
      }
    }
  }

  if (toolId === "claude_code" || toolId === "workbuddy") {
    const parts = relPath.split("/");
    if (parts.length >= 2 && parts[0] === "projects") {
      const [name, realPath] = decodeClaudeDir(parts[1]!);
      cwd = cleanPath(realPath);
      if (!isInvalidProjectName(name)) project = name;
    }
    for (const line of lines.slice(0, 10)) {
      if (!line.includes('"cwd"')) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: unknown };
        if (typeof obj.cwd === "string" && obj.cwd.trim()) {
          setProject(cleanPath(obj.cwd));
          break;
        }
      } catch {
        // ignore
      }
    }
    if (toolId === "workbuddy" && cwd && /[/\\]WorkBuddy[/\\]\d{4}[-_]?\d{2}/i.test(cwd)) {
      cwd = dirname(cwd);
      project = "WorkBuddy";
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.includes('"aiTitle"')) {
        const t = /"aiTitle"\s*:\s*"([^"]+)"/.exec(line)?.[1]?.trim();
        if (t) {
          title = t;
          break;
        }
      }
      if (!title && line.includes('"summary"')) {
        const s = /"summary"\s*:\s*"([^"]+)"/.exec(line)?.[1]?.trim();
        if (s) title = s;
      }
    }
    if (!title && toolId === "workbuddy") {
      for (const line of lines) {
        if (!line.includes("<user_query>")) continue;
        const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(line);
        if (m?.[1]) {
          const firstLine = m[1].replace(/\\n/g, "\n").trim().split("\n")[0]?.trim();
          if (firstLine) {
            title = firstLine.slice(0, 60);
            break;
          }
        }
      }
    }
  }

  if (lines.length) {
    // Codex puts the working directory in its session_meta line.
    try {
      const first = JSON.parse(lines[0]!) as { payload?: { cwd?: unknown } };
      if (first?.payload?.cwd != null) {
        const c = cleanPath(String(first.payload.cwd));
        if (c) {
          cwd = c;
          const name = basename(c);
          if (!isInvalidProjectName(name)) project = name;
        }
      }
    } catch {
      // not JSON
    }
    if (cwd === undefined && toolId === "antigravity") {
      const top = lines.slice(0, 50).join("\n");
      const user = /Active Workspaces:\s*\n\s*-\s*((?:[a-zA-Z]:[/\\]|\/)[^\r\n]+)/.exec(top)
        ?? /Command Working Directory:\s*((?:[a-zA-Z]:[/\\]|\/)[^\r\n]+)/.exec(top)
        ?? /<user_information>[\s\S]*?((?:[a-zA-Z]:[/\\]|\/)[a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)*)\s*->/.exec(top);
      if (user) setProject(cleanPath(user[1]!));
      if (cwd === undefined) {
        const m = /"(?:[Cc]wd|DirectoryPath|AbsolutePath)"\s*:\s*"?\\?"?((?:[a-zA-Z]:[/\\]|\/)[a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)*)/.exec(top);
        if (m) {
          let cand = cleanPath(m[1]!);
          if (/\.(md|json|py|ts|dart)$/.test(cand)) cand = dirname(cand);
          if (!cand.includes(".gemini")) setProject(cand);
        }
      }
    }
  }

  return {
    session_id: sessionId,
    ...(title ? { title } : {}),
    ...(cwd !== undefined ? { project_path: cwd } : {}),
    ...(project !== undefined ? { project_hash: project } : {}),
  };
}

/**
 * Watches the tools' session directories and uploads what changes. Session logs
 * (.jsonl) go up incrementally from a saved byte offset, in slices that end on a
 * line boundary, so logs of any size sync without re-sending what the server has.
 * Offsets live in ~/.memento/offsets.json, shared with the Flutter collector.
 */
export class FileWatcher {
  private readonly offsets = new Map<string, number>();
  private readonly mtimes = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly queue: [string, string][] = [];
  private readonly queued = new Set<string>();
  private readonly watchers: FSWatcher[] = [];
  private rescan: NodeJS.Timeout | undefined;
  private targets = new Map<string, string>();
  private processing = false;
  private disposed = false;
  private readonly offsetsPath: string;

  constructor(
    private readonly config: CollectorConfig,
    private readonly ingest: IngestClient,
    private readonly log: Log = () => {},
    home = homeDir(),
  ) {
    this.offsetsPath = join(home, ".memento", "offsets.json");
  }

  async start(tools: Record<string, DiscoveredTool>): Promise<void> {
    await this.loadOffsets();
    const targets = watchTargets(tools, this.config.extraWatchDirs);
    this.targets = targets;
    this.log(`Watching ${targets.size} tool data directories`);
    for (const [dir, toolId] of targets) {
      this.watchDir(dir, toolId);
      void this.scan(dir, toolId);
    }
    // Catch anything missed while offline or during a watcher hiccup.
    this.rescan = setInterval(() => {
      for (const [dir, toolId] of targets) void this.scan(dir, toolId);
    }, RESCAN_MS);
    this.rescan.unref?.();
  }

  /** Forget what was uploaded and send everything again (the server's "resync" command). */
  async resync(): Promise<void> {
    this.offsets.clear();
    this.mtimes.clear();
    this.failures.clear();
    await this.saveOffsets();
    this.log("Resync: re-uploading all watched files");
    for (const [dir, toolId] of this.targets) void this.scan(dir, toolId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.rescan) clearInterval(this.rescan);
    for (const t of this.debounce.values()) clearTimeout(t);
    for (const w of this.watchers) w.close();
    this.queue.length = 0;
    this.queued.clear();
    await this.saveOffsets();
  }

  private watchDir(dir: string, toolId: string): void {
    try {
      const w = watch(dir, { recursive: true, persistent: false }, (_event, file) => {
        if (this.disposed || !file) return;
        const full = join(dir, file.toString());
        if (!isWatchedFile(full, toolId)) return;
        clearTimeout(this.debounce.get(full));
        this.debounce.set(
          full,
          setTimeout(() => this.enqueue(full, toolId), DEBOUNCE_MS),
        );
      });
      w.on("error", (e) => this.log(`Watch error on ${dir}: ${e.message}`));
      this.watchers.push(w);
    } catch (e) {
      this.log(`Failed to watch ${dir}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async scan(dir: string, toolId: string): Promise<void> {
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      for (const e of entries) {
        if (this.disposed) return;
        if (!e.isFile()) continue;
        const full = join(e.parentPath, e.name);
        if (isWatchedFile(full, toolId)) this.enqueue(full, toolId);
      }
    } catch (e) {
      this.log(`Scan note on ${dir}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private enqueue(file: string, toolId: string): void {
    if (this.disposed || this.queued.has(file)) return;
    this.queued.add(file);
    this.queue.push([file, toolId]);
    void this.process();
  }

  private async process(): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;
    try {
      while (this.queue.length && !this.disposed) {
        const [file, toolId] = this.queue.shift()!;
        this.queued.delete(file);
        let uploaded = false;
        try {
          uploaded = await this.syncFile(file, toolId);
        } catch (e) {
          this.log(`Error syncing ${file}: ${e instanceof Error ? e.message : e}`);
        }
        if (uploaded && this.queue.length) await sleep(100);
      }
    } finally {
      this.processing = false;
    }
  }

  /** Sync one file now (also used by tests). */
  async syncFile(file: string, toolId: string): Promise<boolean> {
    if (!existsSync(file)) return false;
    const relPath = relativePathFor(file, toolId, this.config.extraWatchDirs);
    if (extname(file).toLowerCase() === ".jsonl") return this.syncJsonl(file, toolId, relPath);
    return this.syncWhole(file, toolId, relPath);
  }

  private async syncJsonl(file: string, toolId: string, relPath: string): Promise<boolean> {
    let offset = this.offsets.get(file) ?? 0;
    const size0 = (await stat(file)).size;
    if (size0 < offset) {
      this.log(`File shrunk (${size0} < ${offset}), starting over: ${relPath}`);
      offset = 0;
      this.offsets.set(file, 0);
    }
    if (size0 === offset) return false;

    let uploaded = false;
    const handle = await open(file, "r");
    try {
      while (!this.disposed) {
        const size = (await handle.stat()).size;
        if (size <= offset) break;
        const want = Math.min(MAX_BATCH, size - offset);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await handle.read(buf, 0, want, offset);
        if (!bytesRead) break;
        let valid = bytesRead;
        // End on a line boundary unless this slice reaches the end of the file.
        if (offset + bytesRead < size) {
          const nl = buf.lastIndexOf(10, bytesRead - 1);
          if (nl !== -1) valid = nl + 1;
        }
        const slice = buf.subarray(0, valid);
        const raw = slice.toString("utf8");
        const lines = raw.trim() ? cleanLines(raw) : [];
        if (!lines.length) {
          offset += slice.length;
          this.offsets.set(file, offset);
          continue;
        }
        const batch = lines.join("\n");
        const mode = offset > 0 ? "delta" : "full";
        this.log(`Syncing ${relPath} (${toolId}) ${offset > 0 ? `delta: ${slice.length}B at offset ${offset}` : `initial: ${slice.length}B`} (file size: ${size}B)`);
        const doc = {
          toolId,
          category: "conversation",
          contentType: "jsonl",
          relativePath: relPath,
          content: batch,
          contentHash: contentHash(batch),
          fileSize: size,
          offset,
          mode,
          metadata: sessionMetadata(file, toolId, relPath, lines),
        } as const;
        let ok = await this.ingest.ingestDocument(doc);
        if (!ok && !this.disposed) {
          await sleep(500);
          ok = await this.ingest.ingestDocument(doc);
        }
        uploaded = true;
        if (ok) {
          this.failures.delete(file);
          offset += slice.length;
          this.offsets.set(file, offset);
          await this.saveOffsets();
        } else {
          const fails = (this.failures.get(file) ?? 0) + 1;
          this.failures.set(file, fails);
          this.log(`Upload failed for ${relPath} at offset ${offset} (attempt ${fails}), retaining offset to retry`);
          break;
        }
        if (offset < size) await sleep(50);
        else break;
      }
    } finally {
      await handle.close();
    }
    return uploaded;
  }

  private async syncWhole(file: string, toolId: string, relPath: string): Promise<boolean> {
    const s = await stat(file);
    if (this.mtimes.get(file) === s.mtimeMs) return false;
    if (s.size > 20 * 1024 * 1024) {
      this.log(`Skipping ${file}: larger than 20MB (${s.size} bytes)`);
      return false;
    }
    const content = await readFile(file, "utf8");
    this.log(`Syncing updated file: ${relPath} (${toolId})`);
    const ok = await this.ingest.ingestDocument({
      toolId,
      category: toolId === "obsidian" ? "notes" : "conversation",
      contentType: extname(file).replace(".", ""),
      relativePath: relPath,
      content,
      contentHash: contentHash(content),
      fileSize: s.size,
      mode: "full",
      offset: 0,
    });
    if (ok) this.mtimes.set(file, s.mtimeMs);
    return true;
  }

  private async loadOffsets(): Promise<void> {
    try {
      const map = JSON.parse(await readFile(this.offsetsPath, "utf8")) as Record<string, unknown>;
      this.offsets.clear();
      for (const [k, v] of Object.entries(map)) if (typeof v === "number") this.offsets.set(k, Math.trunc(v));
    } catch {
      // first run
    }
  }

  private async saveOffsets(): Promise<void> {
    try {
      await mkdir(dirname(this.offsetsPath), { recursive: true });
      await writeFile(this.offsetsPath, JSON.stringify(Object.fromEntries(this.offsets)));
    } catch {
      // try again on the next slice
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
