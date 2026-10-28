import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { homeDir, type CollectorConfig } from "./config.js";
import { cleanPath, decodeClaudeDir, isInvalidProjectName, type DiscoveredTool } from "./discovery.js";
import { getAntigravitySessionInfo, healAntigravitySession, healAllAntigravitySessions, isJunkAntigravityTitle } from "./antigravity.js";
import type { IngestClient, IngestDocument } from "./ingest.js";
import { contentHash } from "./sanitizer.js";

const MAX_BATCH = 512 * 1024; // bytes per upload
const MAX_LINE = 128 * 1024; // a longer line (a pasted screenshot, a huge tool output) is shrunk to this
// A line longer than a batch is read whole before it goes up; past this it keeps only its head and tail
const MAX_WHOLE_LINE = 64 * 1024 * 1024;
// A last line without its newline is still being written, unless the file has been this quiet
const PARTIAL_LINE_QUIET_MS = 30_000;
const HEAD_BYTES = 64 * 1024; // where a session log says which folder it was started in
const DEBOUNCE_MS = 2000;
// A large session log is rewritten whole on the server for every upload (5 MB, every few seconds while an
// agent works): upload it at most this often, and on a timer that writes to it don't keep pushing back
const LARGE_FILE_BYTES = 1024 * 1024;
const LARGE_FILE_GAP_MS = 15_000;
const RESCAN_MS = 60_000;
// Files sent whole (a subagent's .meta.json, a memory note) go up together, this many to a request
const WHOLE_BATCH_FILES = 50;
const WHOLE_BATCH_BYTES = 1024 * 1024;

const isJsonl = (file: string) => extname(file).toLowerCase() === ".jsonl";

type Log = (message: string) => void;

/** Which directory of each tool holds its sessions. */
function watchTargets(tools: Record<string, DiscoveredTool>, extraDirs: string[]): Map<string, string> {
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
function isWatchedFile(filePath: string, toolId: string): boolean {
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
function relativePathFor(filePath: string, toolId: string, extraDirs: string[] = []): string {
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

/** Whether the file hasn't been written to for PARTIAL_LINE_QUIET_MS. */
async function isQuiet(handle: Awaited<ReturnType<typeof open>>): Promise<boolean> {
  return Date.now() - (await handle.stat()).mtimeMs >= PARTIAL_LINE_QUIET_MS;
}

/** The first lines of a log, whole lines only. */
async function readHead(handle: Awaited<ReturnType<typeof open>>): Promise<string[]> {
  const buf = Buffer.alloc(HEAD_BYTES);
  const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
  let text = buf.subarray(0, bytesRead).toString("utf8");
  if (bytesRead === HEAD_BYTES) {
    const nl = text.lastIndexOf("\n");
    if (nl > 0) text = text.slice(0, nl);
  }
  return text.trim() ? cleanLines(text) : [];
}

/** Lines of a slice, giant lines shrunk to MAX_LINE. */
export function cleanLines(raw: string): string[] {
  const out: string[] = [];
  for (let line of raw.split("\n")) {
    if (!line) continue;
    if (line.length > MAX_LINE) line = shrinkLine(line);
    out.push(line);
  }
  return out;
}

/**
 * A line over MAX_LINE, still one JSON object: its long strings (base64 images, file dumps) are cut
 * down until it fits, so the server still parses the message and keeps the text around them. Cutting
 * the raw line into head and tail left neither part parseable and the whole message, the user's own
 * words included, was dropped. Only a line that isn't JSON still gets that.
 */
function shrinkLine(line: string): string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    value = undefined;
  }
  if (value !== undefined && typeof value === "object" && value !== null) {
    for (const limit of [16 * 1024, 4 * 1024, 1024, 256]) {
      const out = JSON.stringify(shrinkStrings(value, limit));
      if (out.length <= MAX_LINE) return out;
    }
  }
  return `${line.slice(0, 64 * 1024)}\n...[TRUNCATED: line exceeded 128KB limit]...\n${line.slice(-32 * 1024)}`;
}

function shrinkStrings(v: unknown, limit: number): unknown {
  if (typeof v === "string") {
    if (v.length <= limit) return v;
    const head = Math.floor(limit * 0.75);
    const tail = Math.floor(limit * 0.2);
    return `${v.slice(0, head)}…[已截断 ${v.length - head - tail} 字]…${v.slice(v.length - tail)}`;
  }
  if (Array.isArray(v)) return v.map((x) => shrinkStrings(x, limit));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = shrinkStrings(x, limit);
    return o;
  }
  return v;
}

/**
 * The line that starts at `offset` and runs past a batch, read to its newline (or with `toEof` to the
 * end of the file, for a last line that is final without one): `bytes` to parse, `consumed` to move
 * the offset by. null while its end isn't written yet. Past MAX_WHOLE_LINE only its head and tail are
 * kept (the line still counts whole for the offset).
 */
async function readLongLine(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  size: number,
  toEof = false,
): Promise<{ bytes: Buffer; consumed: number } | null> {
  const chunks: Buffer[] = [];
  let kept = 0;
  let pos = offset;
  let tail: Buffer = Buffer.alloc(0);
  while (pos < size) {
    const buf = Buffer.alloc(Math.min(4 * MAX_BATCH, size - pos));
    const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
    if (!bytesRead) break;
    const part = buf.subarray(0, bytesRead);
    const nl = part.indexOf(10);
    const piece = nl === -1 ? part : part.subarray(0, nl + 1);
    if (kept + piece.length <= MAX_WHOLE_LINE) {
      chunks.push(piece);
      kept += piece.length;
    } else {
      tail = Buffer.concat([tail, piece]).subarray(-32 * 1024);
    }
    pos += piece.length;
    if (nl !== -1) break;
  }
  const ended = chunks.length > 0 && (chunks[chunks.length - 1]!.at(-1) === 10 || tail.at(-1) === 10);
  if (!ended && !(toEof && pos > offset)) return null;
  const bytes = tail.length ? Buffer.concat([chunks[0]!.subarray(0, MAX_LINE), Buffer.from("\n"), tail]) : Buffer.concat(chunks);
  return { bytes, consumed: pos - offset };
}

/**
 * Files of the agents themselves (Antigravity's brain, step outputs, logs): a path in there is
 * never a project, though sessions mention them all the time.
 */
export function isAgentInternalPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return /\/\.(gemini|antigravity|claude|codex|codebuddy|workbuddy)(\/|$)/.test(p) || p.includes("/.system_generated/");
}

/** A workspace path quoted in a transcript, cut where the quoting ends (a JSON string keeps going). */
function quotedPath(raw: string): string {
  return raw
    .split(/(?<!\\)\\[nrt]|["\r\n]/)[0]!
    .replace(/\\\\/g, "\\")
    .trim()
    .replace(/[\\/]+$/, "");
}

/**
 * Session id, title and project a slice of a session log belongs to. The title comes from the slice
 * (the latest one wins); the project from `head`, the start of the whole log, so the session stays in
 * the folder it was started in: the agent changing directory later (cd server) used to move it.
 */
function sessionMetadata(
  filePath: string,
  toolId: string,
  relPath: string,
  lines: string[],
  home = homeDir(),
  head: string[] = lines,
): Record<string, unknown> {
  let sessionId = basename(filePath, extname(filePath));
  let title: string | undefined;
  let cwd: string | undefined;
  let project: string | undefined;
  const setProject = (candidate: string) => {
    if (!candidate || /["\r\n]/.test(candidate) || isAgentInternalPath(candidate)) return false;
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
      if (summary.title && !isJunkAntigravityTitle(summary.title, sessionId)) {
        title = summary.title;
      }
      if (summary.workspacePath) setProject(cleanPath(summary.workspacePath));
    }

    // 2. Legacy fallbacks
    if (!title) {
      try {
        const ann = readFileSync(join(home, ".gemini", "antigravity", "annotations", `${sessionId}.pbtxt`), "utf8");
        const t = /title:\s*"([^"]+)"/.exec(ann)?.[1]?.trim();
        if (t && !t.endsWith(".pbtxt") && !isJunkAntigravityTitle(t, sessionId)) {
          title = t;
        }
      } catch {
        // no annotation
      }
    }

    // 3. Auto-heal: If title is still missing or junk, extract from transcript and auto write back to Antigravity
    if (!title && sessionId) {
      const healed = healAntigravitySession(sessionId, lines.length ? lines : filePath, undefined, home);
      if (healed) title = healed;
    }

    if (!cwd) {
      try {
        const db = readFileSync(join(home, ".gemini", "antigravity", "conversations", `${sessionId}.db`)).toString("utf8");
        // The first folder it mentions outside Antigravity's own files: the db also names files the agent
        // wrote (brain/<id>/.system_generated/steps/2/output.txt became a project "output.txt")
        for (const ws of db.matchAll(/file:\/\/(\/[a-zA-Z]:\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*|\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)/g)) {
          let raw = ws[1]!;
          if (/^\/[a-zA-Z]:/.test(raw)) raw = raw.slice(1);
          const candidate = cleanPath(raw);
          if (/\.[a-zA-Z0-9]{1,8}$/.test(basename(candidate))) continue; // a file, not a workspace
          if (setProject(candidate)) break;
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
    for (const line of head.slice(0, 10)) {
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

  if (head.length) {
    // Codex puts the working directory in its session_meta line.
    try {
      const first = JSON.parse(head[0]!) as { payload?: { cwd?: unknown } };
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
      const top = head.slice(0, 50).join("\n");
      // Inside a JSON string the line breaks are "\\n": the path ends there, not at the end of the line
      const user = /Active Workspaces:\s*(?:\\n|\n)\s*-\s*((?:[a-zA-Z]:[/\\]|\/)[^\r\n]+)/.exec(top)
        ?? /Command Working Directory:\s*((?:[a-zA-Z]:[/\\]|\/)[^\r\n]+)/.exec(top)
        ?? /<user_information>[\s\S]*?((?:[a-zA-Z]:[/\\]|\/)[a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)*)\s*->/.exec(top);
      if (user) setProject(cleanPath(quotedPath(user[1]!)));
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
 * Offsets live in ~/.memento/offsets.json. Other files go up whole when their modification time
 * changes; the times sent are kept in ~/.memento/synced-mtimes.json, so a restart doesn't send them
 * all again (on 2026-10-28 each restart of a Windows collector sent its 1,600 again).
 */
export class FileWatcher {
  private readonly offsets = new Map<string, number>();
  private readonly mtimes = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly lastUpload = new Map<string, number>();
  private readonly queue: [string, string][] = [];
  private readonly queued = new Set<string>();
  private readonly watchers: FSWatcher[] = [];
  private rescan: NodeJS.Timeout | undefined;
  private saveOffsetsTimer: NodeJS.Timeout | undefined;
  private targets = new Map<string, string>();
  private processing = false;
  private disposed = false;
  private readonly offsetsPath: string;
  private readonly mtimesPath: string;
  private mtimesDirty = false;

  constructor(
    private readonly config: CollectorConfig,
    private readonly ingest: IngestClient,
    private readonly log: Log = () => {},
    private readonly home: string = homeDir(),
  ) {
    this.offsetsPath = join(home, ".memento", "offsets.json");
    this.mtimesPath = join(home, ".memento", "synced-mtimes.json");
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
    void healAllAntigravitySessions().catch(() => {});
    // Catch anything missed while offline or during a watcher hiccup.
    this.rescan = setInterval(() => {
      for (const [dir, toolId] of targets) void this.scan(dir, toolId);
      void healAllAntigravitySessions().catch(() => {});
    }, RESCAN_MS);
    this.rescan.unref?.();
  }

  /** Forget what was uploaded and send everything again (the server's "resync" command). */
  async resync(): Promise<void> {
    this.offsets.clear();
    this.mtimes.clear();
    this.mtimesDirty = true;
    this.failures.clear();
    await this.saveOffsets(true);
    this.log("Resync: re-uploading all watched files");
    for (const [dir, toolId] of this.targets) void this.scan(dir, toolId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.rescan) clearInterval(this.rescan);
    if (this.saveOffsetsTimer) {
      clearTimeout(this.saveOffsetsTimer);
      this.saveOffsetsTimer = undefined;
    }
    for (const t of this.debounce.values()) clearTimeout(t);
    for (const w of this.watchers) w.close();
    this.queue.length = 0;
    this.queued.clear();
    await this.saveOffsets(true);
  }

  /** Upload a changed file after it settles; a large one at most every LARGE_FILE_GAP_MS. */
  private schedule(file: string, toolId: string): void {
    const large = (this.offsets.get(file) ?? 0) >= LARGE_FILE_BYTES;
    const pending = this.debounce.get(file);
    if (pending && large) return; // already due: it reads up to the end when it runs
    clearTimeout(pending);
    const sinceLast = Date.now() - (this.lastUpload.get(file) ?? 0);
    const delay = large ? Math.max(DEBOUNCE_MS, LARGE_FILE_GAP_MS - sinceLast) : DEBOUNCE_MS;
    this.debounce.set(
      file,
      setTimeout(() => {
        this.debounce.delete(file);
        this.enqueue(file, toolId);
      }, delay),
    );
  }

  private watchDir(dir: string, toolId: string): void {
    try {
      const w = watch(dir, { recursive: true, persistent: false }, (_event, file) => {
        if (this.disposed || !file) return;
        const full = join(dir, file.toString());
        if (!isWatchedFile(full, toolId)) return;
        this.schedule(full, toolId);
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
      await sleep(0); // a scan enqueues its files in one go: let it finish, so they can go up together
      while (this.queue.length && !this.disposed) {
        const [file, toolId] = this.queue.shift()!;
        this.queued.delete(file);
        let uploaded = false;
        try {
          uploaded = isJsonl(file) ? await this.syncFile(file, toolId) : await this.syncWholeFiles(this.takeWholeFiles([file, toolId]));
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
    if (!isJsonl(file)) return this.syncWholeFiles([[file, toolId]]);
    return this.syncJsonl(file, toolId, relativePathFor(file, toolId, this.config.extraWatchDirs));
  }

  /** `first` and up to a batch more of the queued files that go up whole. */
  private takeWholeFiles(first: [string, string]): [string, string][] {
    const group = [first];
    for (let i = 0; i < this.queue.length && group.length < WHOLE_BATCH_FILES; ) {
      const item = this.queue[i]!;
      if (isJsonl(item[0])) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.queued.delete(item[0]);
      group.push(item);
    }
    return group;
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
        // Whole lines only: half of a line goes up now and the rest with the next slice, neither half
        // parses, and the server loses that message for good
        let slice: Buffer = buf.subarray(0, bytesRead);
        let consumed = bytesRead;
        const reachesEnd = offset + bytesRead >= size;
        const nl = slice.lastIndexOf(10);
        if (nl === -1 && !reachesEnd) {
          // One line longer than a batch: read on to its end
          const long =
            (await readLongLine(handle, offset, size)) ??
            ((await isQuiet(handle)) ? await readLongLine(handle, offset, size, true) : null);
          if (!long) break; // its end isn't written yet
          slice = long.bytes;
          consumed = long.consumed;
        } else if (nl !== slice.length - 1) {
          // At the end of the file the last line may still be being written: it waits for its newline.
          // One that never gets it goes once the file is quiet (the rescan comes back for it).
          const lastLineFinal = reachesEnd && (await isQuiet(handle));
          if (!lastLineFinal) {
            if (nl === -1) break;
            slice = slice.subarray(0, nl + 1);
            consumed = slice.length;
          }
        }
        const raw = slice.toString("utf8");
        const lines = raw.trim() ? cleanLines(raw) : [];
        // A later slice still belongs to the folder the session was started in
        const head = offset > 0 ? await readHead(handle) : lines;
        if (!lines.length) {
          offset += consumed;
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
          metadata: sessionMetadata(file, toolId, relPath, lines, this.home, head),
        } as const;
        let ok = await this.ingest.ingestDocument(doc);
        if (!ok && !this.disposed) {
          await sleep(500);
          ok = await this.ingest.ingestDocument(doc);
        }
        uploaded = true;
        if (ok) {
          this.lastUpload.set(file, Date.now());
          this.failures.delete(file);
          offset += consumed;
          this.offsets.set(file, offset);
          await this.saveOffsets(false);
        } else {
          const fails = (this.failures.get(file) ?? 0) + 1;
          this.failures.set(file, fails);
          this.log(`Upload failed for ${relPath} at offset ${offset} (attempt ${fails}), retaining offset to retry`);
          await this.saveOffsets(true);
          break;
        }
        if (offset < size) await sleep(50);
        else break;
      }
      await this.saveOffsets(true);
    } finally {
      await handle.close();
    }
    return uploaded;
  }

  /** Uploads the files that changed since they last went up, several to a request; whether any did. */
  private async syncWholeFiles(items: [string, string][]): Promise<boolean> {
    let group: { file: string; mtime: number; doc: IngestDocument }[] = [];
    let bytes = 0;
    let attempted = false;
    const flush = async () => {
      if (!group.length) return;
      const batch = group;
      group = [];
      bytes = 0;
      attempted = true;
      const ok = batch.length === 1 ? [await this.ingest.ingestDocument(batch[0]!.doc)] : await this.ingest.ingestBatch(batch.map((g) => g.doc));
      batch.forEach((g, i) => {
        if (!ok[i]) return;
        this.mtimes.set(g.file, g.mtime);
        this.mtimesDirty = true;
      });
    };
    for (const [file, toolId] of items) {
      if (this.disposed) break;
      let s: Awaited<ReturnType<typeof stat>>;
      let content: string;
      try {
        if (!existsSync(file)) continue;
        s = await stat(file);
        if (this.mtimes.get(file) === s.mtimeMs) continue;
        if (s.size > 20 * 1024 * 1024) {
          this.log(`Skipping ${file}: larger than 20MB (${s.size} bytes)`);
          continue;
        }
        content = await readFile(file, "utf8");
      } catch (e) {
        this.log(`Error syncing ${file}: ${e instanceof Error ? e.message : e}`); // the next scan tries it again
        continue;
      }
      const relPath = relativePathFor(file, toolId, this.config.extraWatchDirs);
      this.log(`Syncing updated file: ${relPath} (${toolId})`);
      const size = Buffer.byteLength(content);
      if (group.length && (group.length >= WHOLE_BATCH_FILES || bytes + size > WHOLE_BATCH_BYTES)) await flush();
      group.push({
        file,
        mtime: s.mtimeMs,
        doc: {
          toolId,
          category: toolId === "obsidian" ? "notes" : "conversation",
          contentType: extname(file).replace(".", ""),
          relativePath: relPath,
          content,
          contentHash: contentHash(content),
          fileSize: s.size,
          mode: "full",
          offset: 0,
        },
      });
      bytes += size;
    }
    await flush();
    if (attempted) await this.saveOffsets(false);
    return attempted;
  }

  private async loadOffsets(): Promise<void> {
    try {
      const map = JSON.parse(await readFile(this.offsetsPath, "utf8")) as Record<string, unknown>;
      this.offsets.clear();
      for (const [k, v] of Object.entries(map)) if (typeof v === "number") this.offsets.set(k, Math.trunc(v));
    } catch {
      // first run
    }
    try {
      const map = JSON.parse(await readFile(this.mtimesPath, "utf8")) as Record<string, unknown>;
      this.mtimes.clear();
      // A file since deleted is dropped (with the next save)
      for (const [k, v] of Object.entries(map)) if (typeof v === "number" && existsSync(k)) this.mtimes.set(k, v);
    } catch {
      // first run, or a collector from before these were kept: everything goes up once more
    }
  }

  private async saveOffsets(immediate = false): Promise<void> {
    if (immediate) {
      if (this.saveOffsetsTimer) {
        clearTimeout(this.saveOffsetsTimer);
        this.saveOffsetsTimer = undefined;
      }
      await this.flushOffsets();
      return;
    }
    if (!this.saveOffsetsTimer) {
      this.saveOffsetsTimer = setTimeout(() => {
        this.saveOffsetsTimer = undefined;
        void this.flushOffsets();
      }, 500);
      this.saveOffsetsTimer.unref?.();
    }
  }

  private async flushOffsets(): Promise<void> {
    try {
      await mkdir(dirname(this.offsetsPath), { recursive: true });
      await writeFile(this.offsetsPath, JSON.stringify(Object.fromEntries(this.offsets)));
      if (this.mtimesDirty) {
        this.mtimesDirty = false;
        await writeFile(this.mtimesPath, JSON.stringify(Object.fromEntries(this.mtimes)));
      }
    } catch {
      this.mtimesDirty = true; // try again on the next slice
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
