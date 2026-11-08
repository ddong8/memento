// The repository scans behind each blueprint section. A line-by-line port of the Python generator:
// the same files are read in the same order, the same regexes applied, the same exceptions end a
// file's scan early, so the blueprint comes out byte-for-byte the same.
import {
  IGNORED_DIRS,
  exists,
  isDir,
  isFile,
  iterRepoFiles,
  iterdir,
  normPath,
  pglob,
  pjoin,
  pname,
  pparent,
  pparts,
  psuffix,
  pstem,
  readCode,
  readTextIgnore,
  relTo,
  runGit,
  samePath,
  sortedPaths,
  toNative,
  uniqPaths,
  withoutSuffix,
  IS_WIN,
} from "./files.js";
import {
  cmpStr,
  endsWithAny,
  isDict,
  mergeDicts,
  orDict,
  pyCapitalize,
  pyGet,
  pyIn,
  pyIslower,
  pyLen,
  pyLstrip,
  pyRstrip,
  pySlice,
  pySplit,
  pySplitlines,
  pyStr,
  pyStrip,
  reEscape,
  reFindall,
  reFinditer,
  reMatch,
  reSearch,
  reSub,
  sortedStr,
  startsWithAny,
  truthy,
  uniq,
  type PyDict,
  type PyValue,
} from "./py.js";
import { loads } from "./pyjson.js";
import { parseModule } from "./pyparse.js";
import { unparse } from "./pyunparse.js";

// ---------------------------------------------------------------- shared helpers

/** str(path): the OS form (backslashes on Windows), as Python printed paths. */
const rs = toNative;

/** str(p.relative_to(root)) */
export function rel(p: string, root: string): string {
  return toNative(relTo(p, root));
}

function pathKey(p: string): string {
  const n = normPath(p);
  return IS_WIN ? n.toLowerCase() : n;
}

/** set[Path] */
class PathSet {
  private readonly s = new Set<string>();
  has(p: string): boolean {
    return this.s.has(pathKey(p));
  }
  add(p: string): void {
    this.s.add(pathKey(p));
  }
}

/** `p in list_of_paths` */
function pathIn(list: string[], p: string): boolean {
  return list.some((x) => samePath(x, p));
}

/** str.replace(old, new): every occurrence */
function replaceAll(s: string, from: string, to: string): string {
  return s.split(from).join(to);
}

/** s.split(sep)[-1] */
function lastPart(s: string, sep: string): string {
  const parts = s.split(sep);
  return parts[parts.length - 1]!;
}

/** splitlines()[0]: IndexError (thrown) when there are no lines */
function firstLine(s: string): string {
  const lines = pySplitlines(s);
  if (!lines.length) throw new RangeError("list index out of range");
  return lines[0]!;
}

const R = String.raw;

// ---------------------------------------------------------------- tech stack

export interface TechStack {
  project_type: string;
  is_monorepo: boolean;
  languages: string[];
  frameworks: string[];
}

export function detectTechStack(root: string): TechStack {
  const stack: string[] = [];
  const frameworks: string[] = [];
  let projectType = "Standard Repository";

  const pJson = pjoin(root, "package.json");
  const pnpmWs = pjoin(root, "pnpm-workspace.yaml");
  let isMonorepo = false;

  // 1. Node / TypeScript / Frontend / Desktop manifests (root + subdirectories)
  const pkgFiles = exists(pJson) ? [pJson] : [];
  for (const subPj of iterRepoFiles(root, "**/package.json", 25)) {
    if (!pathIn(pkgFiles, subPj)) pkgFiles.push(subPj);
  }

  if (pkgFiles.length > 1 || exists(pnpmWs) || (isDir(pjoin(root, "backend")) && isDir(pjoin(root, "frontend")))) {
    projectType = "Multi-Service / Full-Stack Repository";
  }

  for (const pj of pkgFiles) {
    try {
      const data = loads(readCode(pj));
      if (samePath(pj, pJson) && (truthy(pyGet(data, "workspaces")) || exists(pnpmWs))) {
        isMonorepo = true;
        projectType = "Monorepo (Workspaces)";
      }
      const deps = mergeDicts(orDict(pyGet(data, "dependencies")), orDict(pyGet(data, "devDependencies")));
      const depKeys = new Set(Array.from(deps.keys(), (k) => k.toLowerCase()));
      if (depKeys.has("next")) frameworks.push("Next.js");
      if (depKeys.has("react") || depKeys.has("react-dom")) frameworks.push("React");
      if (depKeys.has("vue") || depKeys.has("nuxt")) frameworks.push("Vue / Nuxt");
      if (depKeys.has("electron")) frameworks.push("Electron");
      if (depKeys.has("@tauri-apps/api") || depKeys.has("@tauri-apps/cli")) frameworks.push("Tauri");
      if (depKeys.has("vite")) frameworks.push("Vite");
      if (depKeys.has("tailwindcss")) frameworks.push("TailwindCSS");
      if (depKeys.has("express")) frameworks.push("Express");
      if (depKeys.has("fastify")) frameworks.push("Fastify");
      if (depKeys.has("socket.io") || depKeys.has("socket.io-client")) frameworks.push("Socket.IO");
      if (depKeys.has("@modelcontextprotocol/sdk")) frameworks.push("Model Context Protocol (MCP)");
      stack.push("TypeScript/JavaScript");
    } catch {
      // not a readable manifest
    }
  }

  // 2. Python manifests & source files (root + subdirectories)
  const pyManifests = [
    ...(exists(pjoin(root, "pyproject.toml")) ? [pjoin(root, "pyproject.toml")] : []),
    ...(exists(pjoin(root, "requirements.txt")) ? [pjoin(root, "requirements.txt")] : []),
    ...iterRepoFiles(root, "**/pyproject.toml", 15),
    ...iterRepoFiles(root, "**/requirements*.txt", 15),
  ];
  const pyFiles = iterRepoFiles(root, "**/*.py", 20);
  if (pyManifests.length || pyFiles.length) {
    stack.push("Python");
    let pyBlob = uniqPaths(pyManifests)
      .map((m) => readCode(m, 50_000).toLowerCase())
      .join("\n");
    if (pyLen(pyBlob) < 200 && pyFiles.length) {
      pyBlob += "\n" + pyFiles.slice(0, 8).map((pf) => readCode(pf, 8_000).toLowerCase()).join("\n");
    }
    if (pyBlob.includes("fastapi")) frameworks.push("FastAPI");
    if (pyBlob.includes("flask")) frameworks.push("Flask");
    if (pyBlob.includes("django")) frameworks.push("Django");
    if (pyBlob.includes("sqlalchemy") || pyBlob.includes("sqlmodel")) frameworks.push("SQLAlchemy");
    if (pyBlob.includes("celery")) frameworks.push("Celery");
    if (pyBlob.includes("pydantic")) frameworks.push("Pydantic");
    if (pyBlob.includes("alembic")) frameworks.push("Alembic");
    if (pyBlob.includes("tqsdk")) frameworks.push("TqSdk (Futures Quant)");
    if (pyBlob.includes("rdkit")) frameworks.push("RDKit (Cheminformatics)");
    if (pyBlob.includes("socketio") || pyBlob.includes("engineio")) frameworks.push("Socket.IO");
  }

  // 3. Rust / Tauri / Go / JVM / Shell
  const cargoFiles = [
    ...(exists(pjoin(root, "Cargo.toml")) ? [pjoin(root, "Cargo.toml")] : []),
    ...iterRepoFiles(root, "**/Cargo.toml", 10),
  ];
  if (cargoFiles.length || iterRepoFiles(root, "**/*.rs", 5).length) {
    stack.push("Rust");
    const cargoBlob = cargoFiles.map((cf) => readCode(cf, 30_000).toLowerCase()).join("\n");
    if (cargoBlob.includes("tauri")) frameworks.push("Tauri");
    if (cargoBlob.includes("axum")) frameworks.push("Axum");
    if (cargoBlob.includes("actix-web")) frameworks.push("Actix Web");
  }

  if (exists(pjoin(root, "go.mod")) || iterRepoFiles(root, "**/go.mod", 5).length || iterRepoFiles(root, "**/*.go", 5).length) {
    stack.push("Go");
  }

  if (!stack.length && iterRepoFiles(root, "**/*.[tj]s*", 5).length) stack.push("TypeScript/JavaScript");
  if (iterRepoFiles(root, "**/*.sh", 5).length) stack.push("Shell / Bash");

  // 4. Docker / K8s
  if (
    exists(pjoin(root, "Dockerfile")) ||
    exists(pjoin(root, "docker-compose.yml")) ||
    exists(pjoin(root, "docker-compose.yaml")) ||
    iterRepoFiles(root, "**/Dockerfile*", 10).length ||
    iterRepoFiles(root, "**/dockerfile*", 10).length
  ) {
    frameworks.push("Docker");
  }
  if (isDir(pjoin(root, "deploy", "k8s")) || isDir(pjoin(root, "k8s")) || iterRepoFiles(root, "**/k8s/*.y*ml", 5).length) {
    frameworks.push("Kubernetes / Fleet");
  }

  return {
    project_type: projectType,
    is_monorepo: isMonorepo,
    languages: uniq(stack),
    frameworks: uniq(frameworks),
  };
}

// ---------------------------------------------------------------- about

// Template READMEs that say nothing about the project itself
export const README_BOILERPLATE = [
  "this template should help get you started",
  "getting started with create react app",
  "a new flutter project",
  "welcome to your new",
  "bootstrapped with",
  "create-next-app",
  "react + typescript + vite",
  "vue 3 + typescript + vite",
  "recommended ide setup",
];
const README_NAMES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "README.zh-CN.md",
  "README_zh.md",
  "README.markdown",
  "README.rst",
  "README.txt",
  "README",
];
export const ABOUT_MAX_CHARS = 200;

/** One markdown line as plain text: links keep their text, images, emphasis and inline code marks go. */
export function plainMarkdown(line: string): string {
  let text = reSub(R`!\[[^\]]*\]\([^)]*\)`, "", line);
  text = reSub(R`\[([^\]]*)\]\([^)]*\)`, R`\1`, text);
  text = reSub(R`<[^>]+>`, "", text);
  text = reSub(R`(\*\*|__|\*|${"`"})`, "", text);
  return pyStrip(reSub(R`\s+`, " ", text));
}

const SENTENCE_ENDS = ["。", "！", "？", ".", "!", "?", "；", ";"];

/** The README's opening prose (tagline and first paragraph), skipping titles, badges, nav and lists. */
export function readmeAbout(text: string): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const raw of pySplitlines(text)) {
    let line = pyStrip(raw);
    if (startsWithAny(line, ["```", "~~~"])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith(">")) {
      line = pyStrip(pyLstrip(line, "> "));
      if (line.startsWith("[!")) line = "";
    }
    const skip =
      !line ||
      startsWithAny(line, ["#", "<", "|", "![", "[![", "- ", "* ", "+ ", "===", "---", "***"]) ||
      reMatch(R`^\d+[.)]\s`, line) !== null ||
      reFindall(R`\]\(`, line).length >= 2; // a row of links: badges, nav, language switch
    const plain = skip ? "" : plainMarkdown(line);
    if (!plain || pyLen(reSub(R`[\W_]`, "", plain)) < 4) {
      if (current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      if (line.startsWith("#") && paragraphs.length) break; // the intro ends at the first section heading after it
      continue;
    }
    const low = plain.toLowerCase();
    if (README_BOILERPLATE.some((bp) => low.includes(bp))) return "";
    current.push(plain);
    if (paragraphs.length >= 2) break;
  }
  if (current.length) paragraphs.push(current.join(" "));
  let about = "";
  for (const para of paragraphs.slice(0, 2)) {
    if (about && pyLen(about) >= 60) break;
    const sep = !about ? "" : endsWithAny(about, SENTENCE_ENDS) ? "" : "。";
    about = about ? `${about}${sep}${para}` : para;
  }
  return about;
}

/** Cut at the last sentence end within the limit, or at the limit with an ellipsis. */
export function clipSentence(text: string, limit = ABOUT_MAX_CHARS): string {
  if (pyLen(text) <= limit) return text;
  const head = pySlice(text, 0, limit);
  const cpIndex = (unitIndex: number) => (unitIndex < 0 ? -1 : pyLen(head.slice(0, unitIndex)));
  const cut = Math.max(...["。", "！", "？", "；", ". ", "! ", "? "].map((ch) => cpIndex(head.lastIndexOf(ch))));
  if (cut >= Math.floor(limit / 2)) return pyRstrip(pySlice(head, 0, cut + 1));
  return pyRstrip(head) + "…";
}

const DESCRIPTION_RE = R`^description\s*=\s*["\']([^"\']+)["\']`;

/** What the project is, in its authors' words: README intro, else the manifest description, else docs/. */
export function detectProjectAbout(root: string): string {
  for (const name of README_NAMES) {
    const rm = pjoin(root, name);
    if (isFile(rm)) {
      const about = readmeAbout(readCode(rm, 8_000));
      if (about) return clipSentence(sanitizeBlueprintText(about));
      break;
    }
  }
  const pj = pjoin(root, "package.json");
  if (isFile(pj)) {
    try {
      const desc = pyGet(loads(readCode(pj, 50_000)), "description");
      if (typeof desc === "string" && pyStrip(desc)) return clipSentence(sanitizeBlueprintText(plainMarkdown(desc)));
    } catch {
      // not a readable manifest
    }
  }
  for (const [manifest, section] of [
    ["pyproject.toml", "project"],
    ["pyproject.toml", "tool.poetry"],
    ["Cargo.toml", "package"],
  ] as const) {
    const mf = pjoin(root, manifest);
    if (!isFile(mf)) continue;
    const body = reSearch(R`^\[${reEscape(section)}\]\s*$([\s\S]*?)(?=^\[|\Z)`, readCode(mf, 50_000), { m: true });
    const m = body ? reSearch(DESCRIPTION_RE, body.g(1), { m: true }) : null;
    if (m && pyStrip(m.g(1))) return clipSentence(sanitizeBlueprintText(pyStrip(m.g(1))));
  }
  // No README or manifest at the root (e.g. a backend/ + frontend/ repo): its overview doc
  for (const name of ["README.md", "overview.md", "architecture.md", "index.md", "intro.md"]) {
    const doc = pjoin(root, "docs", name);
    if (isFile(doc)) {
      const about = readmeAbout(readCode(doc, 8_000));
      if (about) return clipSentence(sanitizeBlueprintText(about));
    }
  }
  return "";
}

// ---------------------------------------------------------------- subsystems

const ROLE_MAP: Record<string, [string, string]> = {
  backend: ["Backend API Service", "Backend API server, domain business logic, and data access layer"],
  server: ["Backend API Service", "Backend service, HTTP/WebSocket handlers, and persistence"],
  api: ["API Layer", "REST / RPC API routers and request handlers"],
  src: ["Core Source Package", "Primary application source code, API handlers, and domain engines"],
  frontend: ["Frontend Web App", "Web frontend user interface, state management, and components"],
  web: ["Frontend Web App", "Browser web interface, interactive views, and client assets"],
  mobile: ["Mobile Application", "Cross-platform mobile client application"],
  client: ["Frontend Client", "Client-side application views and API integration"],
  desktop: ["Desktop Application", "Cross-platform desktop client application (Electron / Tauri)"],
  "src-tauri": ["Rust Native Core", "Tauri Rust native backend, system tray, and OS integration"],
  quant: ["Quant Trading Core", "Quantitative strategy execution, market data feed, and order routing"],
  research: ["Quant Research & Alpha", "Factor mining, backtesting experiments, and quantitative research scripts"],
  market_data: ["Market Data Pipeline", "Historical and real-time market quote ingestion and storage"],
  engineio: ["Real-Time Transport", "Socket.IO / Engine.IO bidirectional real-time event transport"],
  scripts: ["Automation & CLI Scripts", "Data loading, maintenance, operational CLI, and automation utilities"],
  "ci-scripts": ["CI/CD Automation", "Continuous integration build, packaging, and verification scripts"],
  docker: ["Container Infrastructure", "Dockerfiles, container entrypoints, and environment build configs"],
  deploy: ["Infrastructure & Deployment", "Kubernetes manifests, GitOps configs, and service deployment definitions"],
  k8s: ["Kubernetes Manifests", "Kubernetes Deployments, Services, Ingresses, and ConfigMaps"],
  docs: ["Architecture & Docs", "Technical specifications, runbooks, and design documentation"],
  tests: ["Test Suites", "Automated unit, integration, and end-to-end verification suites"],
  test: ["Test Suites", "Automated unit and integration verification suites"],
};

const DOCSTRING_RE = R`^(?:#![^\n]*\n)?\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')`;

/** Infer semantic category and human-readable description for a project subdirectory. */
function inferDirRoleAndDesc(d: string): [string, string] {
  const name = pname(d);
  const nameLow = name.toLowerCase();
  const [role, defaultDesc] = Object.prototype.hasOwnProperty.call(ROLE_MAP, nameLow)
    ? ROLE_MAP[nameLow]!
    : ["Core Module", `${name} domain module`];

  const pj = pjoin(d, "package.json");
  if (exists(pj)) {
    try {
      const pdata = loads(readCode(pj, 20_000));
      const desc = pyGet(pdata, "description");
      if (typeof desc === "string" && pyStrip(desc)) return [role, pySlice(pyStrip(desc), 0, 120)];
    } catch {
      // not a readable manifest
    }
  }

  const pp = pjoin(d, "pyproject.toml");
  if (exists(pp)) {
    const m = reSearch(DESCRIPTION_RE, readCode(pp, 20_000), { m: true });
    if (m && pyStrip(m.g(1))) return [role, pySlice(pyStrip(m.g(1)), 0, 120)];
  }

  for (const rmName of ["README.md", "readme.md"]) {
    const rm = pjoin(d, rmName);
    if (exists(rm)) {
      for (const line of pySplitlines(readCode(rm, 4_000))) {
        const sline = pyStrip(line);
        if (sline && !startsWithAny(sline, ["#", "!", "[", ">", "`", "-"])) {
          const low = sline.toLowerCase();
          if (README_BOILERPLATE.some((bp) => low.includes(bp))) break;
          return [role, pySlice(sline, 0, 120)];
        }
      }
    }
  }

  const entryCandidates = [
    pjoin(d, "main.py"),
    pjoin(d, "app.py"),
    pjoin(d, "server.py"),
    pjoin(d, "__init__.py"),
    pjoin(d, "app", "main.py"),
    pjoin(d, "src", "index.ts"),
    pjoin(d, "src", "main.ts"),
  ];
  if (nameLow === "src") {
    for (const child of sortedPaths(iterdir(d))) {
      if (isDir(child) && !startsWithAny(pname(child), ["_", "."])) {
        entryCandidates.push(pjoin(child, "__init__.py"), pjoin(child, "main.py"), pjoin(child, "cli.py"), pjoin(child, "api", "app.py"));
      }
    }
  }

  for (const ep of entryCandidates) {
    if (isFile(ep)) {
      const txt = readCode(ep, 3_000);
      const dm = reMatch(DOCSTRING_RE, txt);
      if (dm && pyStrip(dm.g(1))) {
        const first = pyStrip(firstLine(pyStrip(dm.g(1))));
        if (first) return [role, pySlice(first, 0, 120)];
      }
    }
  }

  return [role, defaultDesc];
}

export interface Subsystem {
  name: string;
  path: string;
  type: string;
  description: string;
}

const IDE_TAGS = [
  "@time",
  "@author",
  "@file",
  "@software",
  "@project",
  "@date",
  "@version",
  "@contact",
  "@license",
  "copyright",
  "coding:",
  "-*-",
  "do have a faith",
  "all rights reserved",
];
const IDE_HEADER_TAGS = ["@time", "@author", "@file", "@software"];

/** The one-line description of a root-level script: its docstring or leading comment. */
function rootFileDoc(txt: string): string {
  let doc = "";
  const dm = reMatch(DOCSTRING_RE, txt);
  if (dm && pyStrip(dm.g(1))) {
    const rawBlock = pyStrip(dm.g(1));
    const lowBlock = rawBlock.toLowerCase();
    const isIdeHeader = IDE_HEADER_TAGS.some((t) => lowBlock.includes(t));
    for (const dline of pySplitlines(rawBlock)) {
      let sd = pyLstrip(pyStrip(dline), "*#- ");
      if (!sd || startsWithAny(sd.toLowerCase(), IDE_TAGS)) continue;
      if (startsWithAny(sd.toLowerCase(), ["@description", "@desc"])) {
        sd = pyStrip(reSub(R`^@[a-zA-Z]+\s*[:：]?\s*`, "", sd));
        if (pyLen(sd) > 4) doc = sd;
        break;
      }
      if (!isIdeHeader && pyLen(sd) > 4) {
        doc = sd;
        break;
      }
    }
  }
  if (!doc) {
    const head = pySlice(txt, 0, 600).toLowerCase();
    const hasIdeComments = IDE_HEADER_TAGS.some((t) => head.includes(t));
    for (const cline of pySplitlines(txt).slice(0, 12)) {
      const scline = pyStrip(cline);
      const low = scline.toLowerCase();
      if (scline.startsWith("#!") || IDE_TAGS.some((tag) => low.includes(tag))) continue;
      if (startsWithAny(scline, ["#", "//"])) {
        let cand = pyStrip(pyLstrip(scline, "#/ "));
        if (startsWithAny(cand.toLowerCase(), ["@description", "@desc"])) {
          cand = pyStrip(reSub(R`^@[a-zA-Z]+\s*[:：]?\s*`, "", cand));
          if (pyLen(cand) > 4) doc = cand;
          break;
        }
        if (!hasIdeComments && pyLen(cand) > 4 && !startsWithAny(cand.toLowerCase(), IDE_TAGS)) {
          doc = cand;
          break;
        }
      }
    }
  }
  return doc;
}

const SUPPORT_NAMES = new Set(["docs", "doc", "scripts", "script", "tests", "test", "docker", "deploy", "k8s", "ci-scripts", "ci"]);
const SUPPORT_TYPES = new Set([
  "Architecture & Docs",
  "Automation & CLI Scripts",
  "Test Suites",
  "Container Infrastructure",
  "Infrastructure & Deployment",
  "CI/CD & Build Scripts",
  "Documentation",
  "Data / Config Asset",
]);

function subPriority(s: Subsystem): number {
  const sname = s.name.toLowerCase();
  if (SUPPORT_NAMES.has(sname) || SUPPORT_TYPES.has(s.type)) return 2;
  if (["research", "notebooks", "examples", "benchmarks"].includes(sname) || s.type.includes("Research") || s.description.startsWith("Root-level ")) {
    return 1;
  }
  return 0;
}

/** Scan top-level apps, packages, core directories, and root-level primary modules. */
export function scanSubsystems(root: string): Subsystem[] {
  const subsystems: Subsystem[] = [];
  const seenPaths = new Set<string>();

  const appsDir = pjoin(root, "apps");
  const pkgsDir = pjoin(root, "packages");
  if (isDir(appsDir) || isDir(pkgsDir)) {
    for (const [dir, prefix, type, suffix] of [
      [appsDir, "apps", "Application", "application"],
      [pkgsDir, "packages", "Package / Service", "package"],
    ] as const) {
      if (!isDir(dir)) continue;
      for (const d of sortedPaths(iterdir(dir))) {
        const dn = pname(d);
        if (isDir(d) && !IGNORED_DIRS.has(dn) && !dn.startsWith(".")) {
          const [, desc] = inferDirRoleAndDesc(d);
          const relPath = rel(d, root);
          seenPaths.add(relPath);
          subsystems.push({
            name: `${prefix}/${dn}`,
            path: relPath,
            type,
            description: desc !== `${dn} domain module` ? desc : `${dn} ${suffix}`,
          });
        }
      }
    }

    for (const [fixedName, fixedType, fixedDesc] of [
      ["server", "Backend API Service", "FastAPI backend services, database models, background Celery workers"],
      ["embedding", "Embedding Microservice", "Vector embedding & semantic indexing service"],
      ["deploy", "Infrastructure & Deployment", "Kubernetes kustomization manifests, Fleet GitOps configs, systemd services"],
    ] as const) {
      if (isDir(pjoin(root, fixedName)) && !seenPaths.has(fixedName)) {
        seenPaths.add(fixedName);
        subsystems.push({ name: fixedName, path: fixedName, type: fixedType, description: fixedDesc });
      }
    }
    return subsystems;
  }

  const skipDirs = new Set([...IGNORED_DIRS, "backups", "uploads", "templates", "assets", "public", "static", "results", "output", "outputs", "artifacts"]);
  const entries = sortedPaths(iterdir(root));
  for (const d of entries) {
    const dn = pname(d);
    if (isDir(d) && !skipDirs.has(dn) && !dn.startsWith(".")) {
      const [role, desc] = inferDirRoleAndDesc(d);
      subsystems.push({ name: dn, path: dn, type: role, description: desc });
      if (isDir(pjoin(d, "src-tauri"))) {
        const [tRole, tDesc] = inferDirRoleAndDesc(pjoin(d, "src-tauri"));
        subsystems.push({ name: `${dn}/src-tauri`, path: `${dn}/src-tauri`, type: tRole, description: tDesc });
      }
    }
  }

  for (const f of sortedPaths(iterdir(root))) {
    const fn = pname(f);
    if (
      isFile(f) &&
      [".py", ".ts", ".js"].includes(psuffix(f)) &&
      !startsWithAny(fn, ["_", "test_"]) &&
      fn !== "setup.py" &&
      fn !== "conftest.py" &&
      !endsWithAny(fn, [".config.js", ".config.ts"])
    ) {
      const doc = rootFileDoc(readCode(f, 3_000));
      const stem = pstem(f);
      const role = ["server", "app", "main", "api"].includes(stem) ? "Backend / Web Entrypoint" : "Core Engine Module";
      subsystems.push({
        name: fn,
        path: fn,
        type: role,
        description: doc ? pySlice(doc, 0, 110) : `Root-level ${role.toLowerCase()} (${fn})`,
      });
    }
  }

  // Fallback for data/playlist/configuration repositories with no subdirectories or code scripts
  if (!subsystems.length) {
    for (const f of sortedPaths(iterdir(root))) {
      const fn = pname(f);
      if (isFile(f) && !fn.startsWith(".") && !["PROJECT_BLUEPRINT.md", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(fn)) {
        const role = fn.toLowerCase().startsWith("readme") ? "Documentation" : "Data / Config Asset";
        subsystems.push({ name: fn, path: fn, type: role, description: `Repository ${role.toLowerCase()} (${fn})` });
      }
    }
  }

  return subsystems
    .map((s, i) => ({ s, i, p: subPriority(s), n: s.name.toLowerCase() }))
    .sort((a, b) => a.p - b.p || cmpStr(a.n, b.n) || a.i - b.i)
    .map((x) => x.s);
}

// ---------------------------------------------------------------- routes

/** Web page routes across Next.js (App & Pages Router), Nuxt/Vue Router, React Router, SvelteKit, and Remix. */
export function scanFrontendRoutes(root: string): string[] {
  const routes: string[] = [];
  // 1. Next.js App Router
  const candidates = [pjoin(root, "apps", "web", "src", "app"), pjoin(root, "web", "src", "app"), pjoin(root, "src", "app"), pjoin(root, "app")];
  const appDir = candidates.find((c) => isDir(c));
  if (appDir) {
    for (const pageFile of sortedPaths(pglob(appDir, "**/page.[tj]s*"))) {
      const r = rs(relTo(pparent(pageFile), appDir));
      let routePath = r === "." ? "/" : `/${r}`;
      routePath = reSub(R`/\([^)]+\)`, "", routePath) || "/";
      routes.push(routePath);
    }
  }

  // 2. Next.js Pages Router / Nuxt Pages (`pages/**/*.{tsx,vue}`)
  for (const pagesCand of [pjoin(root, "apps", "web", "src", "pages"), pjoin(root, "src", "pages"), pjoin(root, "pages")]) {
    if (!isDir(pagesCand)) continue;
    for (const pf of [...sortedPaths(pglob(pagesCand, "**/*.[tvj]s*")), ...sortedPaths(pglob(pagesCand, "**/*.vue"))]) {
      if (pstem(pf).startsWith("_") || pname(pparent(pf)) === "api") continue;
      const r = rs(withoutSuffix(relTo(pf, pagesCand)));
      const rpath = "/" + pyLstrip(replaceAll(r, "/index", ""), "/");
      routes.push(rpath || "/");
    }
  }

  // 3. Vue Router / React Router explicit path declarations
  if (!routes.length) {
    for (const rf of [...iterRepoFiles(root, "**/*router*.[tj]s*", 15), ...iterRepoFiles(root, "**/*routes*.[tj]s*", 15)]) {
      try {
        const content = readTextIgnore(rf);
        for (const pm of reFinditer(R`\bpath\s*:\s*["\'](/[^"\']*)["\']`, content)) routes.push(pm.g(1));
      } catch {
        // unreadable
      }
    }
  }

  return sortedStr(uniq(routes));
}

export interface ApiRoute {
  name: string;
  file: string;
  prefix: string;
  endpoints: string[];
  total: number;
}

function route(name: string, file: string, prefix: string, endpoints: string[]): ApiRoute {
  return { name, file, prefix, endpoints: endpoints.slice(0, 5), total: endpoints.length };
}

/** `f"{a.rstrip('/')}/{b.lstrip('/')}".rstrip('/') or "/"` */
function joinRoute(prefix: string, sub: string): string {
  return pyRstrip(`${pyRstrip(prefix, "/")}/${pyLstrip(sub, "/")}`, "/") || "/";
}

/** Backend HTTP routers across Python, Next.js, Node, Go, JVM, Rust and Electron IPC. */
export function scanApiRoutes(root: string): ApiRoute[] {
  const routes: ApiRoute[] = [];
  const seenFiles = new PathSet();

  // 0. Collect include_router(xxx_router, prefix="/...") mount prefixes from aggregator files
  const mountedPrefixes = new Map<string, string>();
  for (const initCand of [...iterRepoFiles(root, "**/api/**/*.py", 40), ...iterRepoFiles(root, "**/routers/**/*.py", 40)]) {
    const initTxt = readCode(initCand, 30_000);
    if (!initTxt.includes("include_router(")) continue;
    const varToMod = new Map<string, string>();
    for (const im of reFinditer(R`from\s+\.?([a-zA-Z0-9_.]+)\s+import\s+router\s+as\s+([a-zA-Z0-9_]+)`, initTxt)) {
      varToMod.set(im.g(2), lastPart(im.g(1), "."));
    }
    for (const im2 of reFinditer(R`from\s+\.?([a-zA-Z0-9_.]+)\s+import\s+([a-zA-Z0-9_]+)`, initTxt)) {
      if (!varToMod.has(im2.g(2))) varToMod.set(im2.g(2), lastPart(im2.g(1), "."));
    }
    for (const inc of reFinditer(R`include_router\(\s*([a-zA-Z0-9_.]+)\s*[^)]*?prefix\s*=\s*["\']([^"\']+)["\']`, initTxt)) {
      const rvar = inc.g(1);
      const pfx = inc.g(2);
      const modName = rvar.includes(".") ? rvar.split(".")[0]! : (varToMod.get(rvar) ?? replaceAll(rvar, "_router", ""));
      if (modName && pfx) mountedPrefixes.set(modName, pfx);
    }
  }

  // 1. Python FastAPI / Flask / Django Ninja
  const pyApiFiles: string[] = [];
  for (const rootPy of ["server.py", "app.py", "main.py", "api.py"]) {
    const rp = pjoin(root, rootPy);
    if (isFile(rp)) pyApiFiles.push(rp);
  }
  for (const d of [
    pjoin(root, "server", "server", "api"),
    pjoin(root, "api"),
    pjoin(root, "app", "api"),
    pjoin(root, "src", "api"),
    pjoin(root, "backend", "app", "api"),
  ]) {
    if (isDir(d)) pyApiFiles.push(...sortedPaths(pglob(d, "*.py")));
  }
  for (const pf of [
    ...iterRepoFiles(root, "**/api/**/*.py", 40),
    ...iterRepoFiles(root, "**/routers/**/*.py", 40),
    ...iterRepoFiles(root, "**/*route*.py", 30),
    ...iterRepoFiles(root, "**/views*.py", 25),
  ]) {
    if (!pathIn(pyApiFiles, pf)) pyApiFiles.push(pf);
  }

  for (const pyFile of pyApiFiles) {
    if (pname(pyFile).startsWith("_") || seenFiles.has(pyFile)) continue;
    seenFiles.add(pyFile);
    const name = pstem(pyFile);
    const content = readCode(pyFile);
    if (!reSearch(R`@(?:router|app|bp|api)\.(get|post|put|delete|patch|route|websocket)\b`, content) && !content.includes("APIRouter")) continue;
    const m = reSearch(R`(?:router|bp)\s*=\s*(?:APIRouter|Blueprint)\([^)]*(?:prefix|url_prefix)=["\']([^"\']+)["\']`, content);
    const explicitPrefix = m ? m.g(1) : (mountedPrefixes.get(name) ?? "");
    const isRootApp = ["server", "app", "main"].includes(name);
    const displayPrefix = explicitPrefix || (isRootApp ? "/" : `/${name}`);

    const endpoints: string[] = [];
    for (const em of reFinditer(R`@(?:router|app|bp|api)\.(get|post|put|delete|patch|route|websocket)\(\s*["\']([^"\']*)["\']`, content)) {
      const rawM = em.g(1).toUpperCase();
      const method = rawM === "WEBSOCKET" ? "WS" : rawM;
      const subpath = em.g(2);
      let fullP: string;
      if (explicitPrefix) {
        if (subpath === explicitPrefix || subpath.startsWith(pyRstrip(explicitPrefix, "/") + "/")) fullP = subpath;
        else fullP = joinRoute(explicitPrefix, subpath);
      } else if (subpath.startsWith("/") && pyLen(subpath) > 1) {
        if (!isRootApp && !subpath.startsWith(`/${name}`)) fullP = joinRoute(displayPrefix, subpath);
        else fullP = pyRstrip(subpath, "/");
      } else {
        fullP = joinRoute(displayPrefix, subpath);
      }
      endpoints.push(`\`${method} ${fullP}\``);
    }
    if (endpoints.length) routes.push(route(name, pname(pyFile), displayPrefix, endpoints));
  }

  // 2. Next.js App Router API Route Handlers (app/api/**/route.ts)
  for (const appCand of [pjoin(root, "apps", "web", "src", "app", "api"), pjoin(root, "src", "app", "api"), pjoin(root, "app", "api")]) {
    if (!isDir(appCand)) continue;
    for (const routeFile of sortedPaths(pglob(appCand, "**/route.[tj]s*"))) {
      const prefix = `/${rs(relTo(pparent(routeFile), pparent(appCand)))}`;
      const content = readCode(routeFile);
      const methods = reFindall(R`export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\b`, content);
      routes.push(route(pname(pparent(routeFile)), pname(routeFile), prefix, uniq(methods).map((mm) => `\`${mm} ${prefix}\``)));
    }
  }

  // 3. Node/TS Express, Fastify, Hono & NestJS Controllers
  for (const tsFile of uniqPaths([
    ...iterRepoFiles(root, "**/*.controller.ts", 30),
    ...iterRepoFiles(root, "**/routes/**/*.[tj]s", 30),
    ...iterRepoFiles(root, "server/src/**/*.[tj]s", 20),
  ])) {
    const content = readCode(tsFile);
    const endpoints: string[] = [];
    const ctrlM = reSearch(R`@Controller\(\s*["\']?([^"\')\s]*)["\']?\s*\)`, content);
    const prefix = ctrlM && ctrlM.g(1) ? "/" + pyStrip(ctrlM.g(1), "/") : `/${replaceAll(pstem(tsFile), ".controller", "")}`;
    for (const nm of reFinditer(R`@(Get|Post|Put|Delete|Patch)\(\s*["\']?([^"\')\s]*)["\']?\s*\)`, content)) {
      endpoints.push(`\`${nm.g(1).toUpperCase()} ${joinRoute(prefix, nm.g(2))}\``);
    }
    for (const exm of reFinditer(R`\b(?:app|router|server)\.(get|post|put|delete|patch)\(\s*["\']([^"\']+)["\']`, content)) {
      endpoints.push(`\`${exm.g(1).toUpperCase()} ${exm.g(2)}\``);
    }
    if (endpoints.length) routes.push(route(pstem(tsFile), pname(tsFile), prefix, endpoints));
  }

  // 4. Go (Gin / Echo / Chi / Fiber / net/http)
  for (const goFile of iterRepoFiles(root, "**/*.go", 40)) {
    if (pname(goFile).endsWith("_test.go")) continue;
    const content = readCode(goFile);
    const endpoints: string[] = [];
    for (const gm of reFinditer(R`\.\s*(GET|POST|PUT|DELETE|PATCH|HandleFunc)\(\s*"([^"]+)"`, content)) {
      endpoints.push(`\`${gm.g(1) === "HandleFunc" ? "ANY" : gm.g(1)} ${gm.g(2)}\``);
    }
    if (endpoints.length) routes.push(route(pstem(goFile), pname(goFile), `/${pstem(goFile)}`, endpoints));
  }

  // 5. Java / Kotlin Spring Boot (@RestController) & Rust (Axum / Actix / Tauri) & Electron IPC
  for (const jkFile of [...iterRepoFiles(root, "**/*Controller.java", 25), ...iterRepoFiles(root, "**/*Controller.kt", 25)]) {
    const content = readCode(jkFile);
    const reqM = reSearch(R`@RequestMapping\(\s*(?:value\s*=\s*)?["\']([^"\']+)["\']`, content);
    const prefix = reqM ? reqM.g(1) : `/${replaceAll(pstem(jkFile), "Controller", "").toLowerCase()}`;
    const endpoints: string[] = [];
    for (const sm of reFinditer(R`@(Get|Post|Put|Delete|Patch)Mapping(?:\(\s*(?:value\s*=\s*)?["\']([^"\']*)["\'])?`, content)) {
      endpoints.push(`\`${sm.g(1).toUpperCase()} ${joinRoute(prefix, sm.group(2) || "")}\``);
    }
    if (endpoints.length) routes.push(route(pstem(jkFile), pname(jkFile), prefix, endpoints));
  }

  for (const rsFile of iterRepoFiles(root, "**/*.rs", 30)) {
    const content = readCode(rsFile);
    const endpoints: string[] = [];
    for (const tm of reFinditer(R`#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)`, content)) {
      endpoints.push(`\`IPC tauri:${tm.g(1)}\``);
    }
    for (const am of reFinditer(R`#\[(get|post|put|delete|patch)\(\s*"([^"]+)"`, content)) {
      endpoints.push(`\`${am.g(1).toUpperCase()} ${am.g(2)}\``);
    }
    if (endpoints.length) routes.push(route(pstem(rsFile), pname(rsFile), `ipc://${pstem(rsFile)}`, endpoints));
  }

  for (const elFile of [...iterRepoFiles(root, "**/main.ts", 15), ...iterRepoFiles(root, "**/ipc*.ts", 15)]) {
    const content = readCode(elFile);
    if (!content.includes("ipcMain.handle")) continue;
    const endpoints = Array.from(reFinditer(R`ipcMain\.handle\(\s*["\']([^"\']+)["\']`, content), (im) => `\`IPC ${im.g(1)}\``);
    if (endpoints.length) routes.push(route(pstem(elFile), pname(elFile), "ipc://electron", endpoints));
  }

  return routes;
}

// ---------------------------------------------------------------- data models

export interface DataModels {
  models: string[];
  relations: string[];
  unique_constraints: string[];
}

/** Multi-language ORM / schema models, foreign key relations and unique constraints. */
export function scanDataModels(root: string): DataModels {
  const models: string[] = [];
  const relations: string[] = [];
  const uniqueConstraints: string[] = [];
  const addModel = (name: string) => {
    if (name && !models.includes(name)) models.push(name);
  };
  const addRel = (r: string) => {
    if (r && !relations.includes(r)) relations.push(r);
  };
  const addUnique = (uq: string) => {
    if (uq && !uniqueConstraints.includes(uq)) uniqueConstraints.push(uq);
  };
  const files = (pattern: string, limit = 80) => iterRepoFiles(root, pattern, limit);

  // 1. Python (SQLAlchemy / Django / SQLModel / Pydantic)
  const pyCandidates: string[] = [];
  const defaultPy = pjoin(root, "server", "server", "db", "models.py");
  if (exists(defaultPy)) pyCandidates.push(defaultPy);
  for (const cand of [...files("**/models.py", 30), ...files("**/models/*.py", 30)]) {
    if (!pathIn(pyCandidates, cand) && !pname(cand).startsWith("_")) pyCandidates.push(cand);
  }

  for (const modelsFile of pyCandidates) {
    let content: string;
    try {
      content = readTextIgnore(modelsFile);
    } catch {
      continue;
    }
    let currentClass: string | null = null;
    for (const line of pySplitlines(content)) {
      const cm = reMatch(R`^class\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*:`, line);
      if (cm) {
        const cname = cm.g(1);
        const bases = cm.g(2);
        if (["Base", "Model", "BaseModel", "SQLModel", "Table", "Document"].some((b) => bases.includes(b))) {
          addModel(cname);
          currentClass = cname;
        } else {
          currentClass = null;
        }
        continue;
      }
      if (!currentClass) continue;
      // SQLAlchemy / SQLModel ForeignKey("table.col")
      if (line.includes("ForeignKey(")) {
        const fkm = reSearch(R`([a-zA-Z0-9_]+)\s*[:=][^;]*ForeignKey\(\s*["\']([^"\']+)["\']`, line);
        if (fkm) addRel(`\`${currentClass}.${fkm.g(1)}\` ➔ \`${fkm.g(2)}\``);
      }
      if (line.includes("UniqueConstraint(")) {
        const uqm = reSearch(R`UniqueConstraint\(([^)]+)\)`, line);
        if (uqm) {
          const cols = uqm
            .g(1)
            .split(",")
            .filter((c) => !c.includes("name=") && pyStrip(c))
            .map((c) => pyStrip(pyStrip(c), "\"'"));
          if (cols.length) addUnique(`\`${currentClass}\`: unique(${cols.join(", ")})`);
        }
      } else if (line.includes("unique=True")) {
        const ufm = reSearch(R`^\s*([a-zA-Z0-9_]+)\s*[:=]`, line);
        if (ufm) addUnique(`\`${currentClass}.${ufm.g(1)}\` (unique)`);
      }
      // Django models.ForeignKey / OneToOneField / ManyToManyField("Target" or Target)
      const dj = reSearch(R`([a-zA-Z0-9_]+)\s*=\s*(?:models\.)?(?:ForeignKey|OneToOneField|ManyToManyField)\(\s*["\']?([A-Za-z0-9_.]+)["\']?`, line);
      if (dj && dj.g(2) !== "self" && dj.g(2) !== "settings") addRel(`\`${currentClass}.${dj.g(1)}\` ➔ \`${dj.g(2)}\``);
    }
  }

  // 2. Prisma (schema.prisma)
  for (const prismaFile of files("**/*.prisma", 20)) {
    let content: string;
    try {
      content = readTextIgnore(prismaFile);
    } catch {
      continue;
    }
    let currentModel: string | null = null;
    for (const line of pySplitlines(content)) {
      const mm = reMatch(R`^\s*model\s+([A-Za-z0-9_]+)\s*\{`, line);
      if (mm) {
        currentModel = mm.g(1);
        addModel(currentModel);
        continue;
      }
      if (currentModel && reMatch(R`^\s*\}`, line)) {
        currentModel = null;
        continue;
      }
      if (currentModel && line.includes("@relation")) {
        const rm = reSearch(
          R`^\s*([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\??\s+.*@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*references:\s*\[([^\]]+)\]`,
          line,
        );
        if (rm) addRel(`\`${currentModel}.${pyStrip(rm.g(3))}\` ➔ \`${rm.g(2)}.${pyStrip(rm.g(4))}\``);
      }
    }
  }

  // 3. TypeScript / JS (Drizzle ORM & TypeORM)
  for (const tsFile of uniqPaths([
    ...files("**/schema.ts", 30),
    ...files("**/schema/*.ts", 30),
    ...files("**/entities/*.ts", 30),
    ...files("**/*.entity.ts", 30),
  ])) {
    let content: string;
    try {
      content = readTextIgnore(tsFile);
    } catch {
      continue;
    }
    // Drizzle ORM: export const users = pgTable("users", { ... })
    for (const dm of reFinditer(R`(?:pgTable|mysqlTable|sqliteTable)\(\s*["\']([a-zA-Z0-9_]+)["\']\s*,\s*\{([\s\S]*?)\}\s*[,)]`, content)) {
      const tname = dm.g(1);
      addModel(tname);
      for (const rfm of reFinditer(R`([a-zA-Z0-9_]+)\s*:[^\n,]*?\.references\(\s*\(\)\s*=>\s*([a-zA-Z0-9_.]+)`, dm.g(2))) {
        addRel(`\`${tname}.${rfm.g(1)}\` ➔ \`${rfm.g(2)}\``);
      }
    }
    // TypeORM: @Entity() export class User
    if (content.includes("@Entity")) {
      let currentEntity: string | null = null;
      let pendingTarget: string | null = null;
      for (const line of pySplitlines(content)) {
        const em = reSearch(R`class\s+([A-Za-z0-9_]+)`, line);
        if (em) {
          currentEntity = em.g(1);
          addModel(currentEntity);
          continue;
        }
        const relDec = reSearch(R`@(?:ManyToOne|OneToOne|ManyToMany)\(\s*\(\)\s*=>\s*([A-Za-z0-9_]+)`, line);
        if (relDec) {
          pendingTarget = relDec.g(1);
          continue;
        }
        if (currentEntity && pendingTarget) {
          const prop = reMatch(R`^\s*([a-zA-Z0-9_]+)\??\s*:`, line);
          if (prop && !pyStrip(line).startsWith("@")) {
            addRel(`\`${currentEntity}.${prop.g(1)}\` ➔ \`${pendingTarget}\``);
            pendingTarget = null;
          }
        }
      }
    }
  }

  // 4. Go (GORM structs)
  for (const goFile of files("**/*.go", 40)) {
    if (pname(goFile).endsWith("_test.go")) continue;
    let content: string;
    try {
      content = readTextIgnore(goFile);
    } catch {
      continue;
    }
    if (!content.includes("gorm:") && !content.includes("db:")) continue;
    for (const sm of reFinditer(R`type\s+([A-Za-z0-9_]+)\s+struct\s*\{([\s\S]*?)\}`, content)) {
      const sname = sm.g(1);
      const sbody = sm.g(2);
      if (!sbody.includes("gorm:") && !sbody.includes("db:")) continue;
      addModel(sname);
      for (const line of pySplitlines(sbody)) {
        const fkm = reSearch(R`^\s*([A-Za-z0-9_]+)\s+\*?([A-Za-z0-9_]+)\s+${"`"}[^${"`"}]*gorm:"[^"]*foreignKey:([A-Za-z0-9_]+)`, line);
        if (fkm) {
          addRel(`\`${sname}.${fkm.g(3)}\` ➔ \`${fkm.g(2)}\``);
        } else if (reSearch(R`^\s*([A-Za-z0-9_]+)ID\s+(?:uint|int|string|uuid\.UUID)\b`, line)) {
          const idm = reSearch(R`^\s*([A-Za-z0-9_]+)ID\s+`, line);
          if (idm && idm.g(1) !== sname) addRel(`\`${sname}.${idm.g(1)}ID\` ➔ \`${idm.g(1)}.ID\``);
        }
      }
    }
  }

  // 5. Rust (SeaORM / Diesel)
  for (const rsFile of files("**/*.rs", 40)) {
    let content: string;
    try {
      content = readTextIgnore(rsFile);
    } catch {
      continue;
    }
    if (content.includes("sea_orm")) {
      const tm = reSearch(R`#\[sea_orm\(\s*table_name\s*=\s*"([^"]+)"`, content);
      const tname = tm ? tm.g(1) : pstem(rsFile);
      addModel(tname);
      for (const bm of reFinditer(R`#\[sea_orm\([^\]]*belongs_to\s*=\s*"([^"]+)"[^\]]*from\s*=\s*"([^"]+)"[^\]]*to\s*=\s*"([^"]+)"`, content)) {
        const parts = bm.g(1).split("::");
        const target = bm.g(1).includes("::") ? parts[parts.length - 2]! : bm.g(1);
        addRel(`\`${tname}.${lastPart(bm.g(2), "::")}\` ➔ \`${target}.${lastPart(bm.g(3), "::")}\``);
      }
    }
    if (content.includes("#[diesel(")) {
      for (const dm of reFinditer(R`#\[diesel\(table_name\s*=\s*([a-zA-Z0-9_]+)\)\]`, content)) {
        const tname = dm.g(1);
        addModel(tname);
        for (const bm of reFinditer(R`#\[diesel\(belongs_to\(([A-Za-z0-9_]+)\)\)\]`, content)) addRel(`\`${tname}\` ➔ \`${bm.g(1)}\``);
      }
    }
  }

  // 6. Java / Kotlin (JPA / Hibernate @Entity)
  for (const jvmFile of [...files("**/*.java", 30), ...files("**/*.kt", 30)]) {
    let content: string;
    try {
      content = readTextIgnore(jvmFile);
    } catch {
      continue;
    }
    if (!content.includes("@Entity") && !content.includes("@Table")) continue;
    const cm = reSearch(R`\bclass\s+([A-Za-z0-9_]+)`, content);
    if (!cm) continue;
    const cname = cm.g(1);
    addModel(cname);
    let pendingRel = false;
    for (const line of pySplitlines(content)) {
      if (reSearch(R`@(?:ManyToOne|OneToOne|ManyToMany|JoinColumn)\b`, line)) {
        pendingRel = true;
        continue;
      }
      if (pendingRel && !pyStrip(line).startsWith("@")) {
        // Java: private User user; or Kotlin: val user: User
        const jm = reSearch(R`(?:private|protected|public)\s+([A-Za-z0-9_]+)\s+([a-zA-Z0-9_]+)\s*[;=]`, line);
        const km = reSearch(R`(?:val|var)\s+([a-zA-Z0-9_]+)\s*:\s*([A-Za-z0-9_]+)`, line);
        if (jm) {
          addRel(`\`${cname}.${jm.g(2)}\` ➔ \`${jm.g(1)}\``);
          pendingRel = false;
        } else if (km) {
          addRel(`\`${cname}.${km.g(1)}\` ➔ \`${km.g(2)}\``);
          pendingRel = false;
        }
      }
    }
  }

  // 7. SQL DDL / Migrations (*.sql)
  const q = '["`]?';
  for (const sqlFile of files("**/*.sql", 30)) {
    let content: string;
    try {
      content = readTextIgnore(sqlFile);
    } catch {
      continue;
    }
    for (const ctm of reFinditer(R`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${q}([a-zA-Z0-9_.]+)${q}\s*\(([\s\S]*?)\);`, content, { i: true })) {
      const tname = ctm.g(1);
      const tbody = ctm.g(2);
      addModel(tname);
      for (const fkm of reFinditer(
        R`FOREIGN\s+KEY\s*\(\s*${q}([a-zA-Z0-9_]+)${q}\s*\)\s*REFERENCES\s+${q}([a-zA-Z0-9_.]+)${q}\s*\(\s*${q}([a-zA-Z0-9_]+)${q}\s*\)`,
        tbody,
        { i: true },
      )) {
        addRel(`\`${tname}.${fkm.g(1)}\` ➔ \`${fkm.g(2)}.${fkm.g(3)}\``);
      }
      for (const inm of reFinditer(
        R`^\s*${q}([a-zA-Z0-9_]+)${q}\s+[A-Za-z0-9_()]+[^,\n]*?\bREFERENCES\s+${q}([a-zA-Z0-9_.]+)${q}\s*\(\s*${q}([a-zA-Z0-9_]+)${q}\s*\)`,
        tbody,
        { i: true, m: true },
      )) {
        if (inm.g(1).toUpperCase() !== "FOREIGN") addRel(`\`${tname}.${inm.g(1)}\` ➔ \`${inm.g(2)}.${inm.g(3)}\``);
      }
    }
  }

  return { models, relations: relations.slice(0, 25), unique_constraints: uniqueConstraints.slice(0, 20) };
}

/** A compact Mermaid erDiagram from extracted foreign-key relations. */
export function generateErDiagram(relations: string[]): string {
  if (!relations.length) return "";
  const edges: string[] = [];
  const seenEdges = new Set<string>();
  for (const r of relations.slice(0, 18)) {
    const m = reMatch(R`${"`"}([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)${"`"}\s*➔\s*${"`"}([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?${"`"}`, r);
    if (!m) continue;
    const srcEntity = m.g(1);
    const srcField = m.g(2);
    let srcNode = reSub(R`[^A-Za-z0-9_]`, "_", srcEntity).toUpperCase();
    let dstNode = reSub(R`[^A-Za-z0-9_]`, "_", m.g(3)).toUpperCase();
    if (dstNode.endsWith("IES") && !srcNode.endsWith("IES")) dstNode = dstNode.slice(0, -3) + "Y";
    else if (dstNode.endsWith("ES") && ["SES", "XES", "ZES", "CHES", "SHES"].some((s) => dstNode.endsWith(s))) dstNode = dstNode.slice(0, -2);
    else if (dstNode.endsWith("S") && !dstNode.endsWith("SS") && dstNode.length > 3) dstNode = dstNode.slice(0, -1);
    if (srcNode.endsWith("S") && !srcNode.endsWith("SS") && srcNode.length > 3 && pyIslower(srcEntity)) srcNode = srcNode.slice(0, -1);
    const edgeKey = `${dstNode}->${srcNode}:${srcField}`;
    if (!seenEdges.has(edgeKey)) {
      seenEdges.add(edgeKey);
      edges.push(`    ${dstNode} ||--o{ ${srcNode} : "${srcField}"`);
    }
  }
  if (!edges.length) return "";
  return ["```mermaid", "erDiagram", ...edges, "```"].join("\n");
}

// ---------------------------------------------------------------- services & schedules

export interface ServiceInfo {
  name: string;
  path: string;
  summary: string;
}

export interface ScheduleInfo {
  name: string;
  task: string;
  schedule: string;
}

/** Core domain service modules and background/scheduled tasks. */
export function scanServicesAndSchedules(root: string): { services: ServiceInfo[]; schedules: ScheduleInfo[] } {
  const services: ServiceInfo[] = [];
  const schedules: ScheduleInfo[] = [];

  // 1. Core service / domain modules across any directory layout
  const svcFiles: string[] = [];
  for (const sdir of [pjoin(root, "server", "server", "services"), pjoin(root, "src", "services"), pjoin(root, "services"), pjoin(root, "app", "services")]) {
    if (isDir(sdir)) {
      svcFiles.push(...sortedPaths(pglob(sdir, "*.py")), ...sortedPaths(pglob(sdir, "*.ts")), ...sortedPaths(pglob(sdir, "*.go")));
    }
  }
  for (const cand of [...iterRepoFiles(root, "**/services/*.[ptg]*", 40), ...iterRepoFiles(root, "**/*service*.[ptg]*", 30)]) {
    if (!pathIn(svcFiles, cand)) svcFiles.push(cand);
  }

  const seenSvc = new PathSet();
  for (const f of svcFiles) {
    const fn = pname(f);
    if (seenSvc.has(f) || fn.startsWith("_") || fn.includes(".test.") || fn.includes(".spec.") || fn.endsWith("_test.go")) continue;
    seenSvc.add(f);
    try {
      const text = readCode(f, 4000);
      let doc = "";
      const dm = reMatch(R`^\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')`, text);
      if (dm) {
        doc = pyStrip(firstLine(pyStrip(dm.g(1))));
      } else {
        const cm = reMatch(R`^\s*(?://+|#+|/\*\*?)\s*([^\n*]+)`, text);
        if (cm) doc = pyStrip(cm.g(1));
      }
      services.push({
        name: pstem(f),
        path: rel(f, root),
        summary: doc ? sanitizeBlueprintText(pySlice(doc, 0, 110)) : "Core domain service module",
      });
    } catch {
      // an empty docstring (IndexError) or a path outside the root
    }
  }

  // 2. Scheduled background jobs across Python (Celery / APScheduler), TS (node-cron / @Cron), Go (cron)
  for (const pyF of iterRepoFiles(root, "**/*.py", 60)) {
    const content = readCode(pyF);
    if (content.includes("beat_schedule")) {
      for (const bm of reFinditer(R`"([a-zA-Z0-9_-]+)"\s*:\s*\{\s*"task"\s*:\s*"([^"]+)"\s*,\s*"schedule"\s*:\s*([^\n]+)`, content)) {
        schedules.push({ name: bm.g(1), task: bm.g(2), schedule: pyStrip(pyRstrip(bm.g(3), ",")) });
      }
    }
    if (content.includes("add_job(") || content.includes("scheduled_job(")) {
      for (const aj of reFinditer(R`(?:add_job|scheduled_job)\(\s*([a-zA-Z0-9_.]+)\s*,\s*["\']([^"\']+)["\']`, content)) {
        schedules.push({ name: aj.g(1), task: `${pstem(pyF)}.${aj.g(1)}`, schedule: aj.g(2) });
      }
    }
  }

  for (const tsF of iterRepoFiles(root, "**/*.[tj]s", 50)) {
    const content = readCode(tsF);
    try {
      if (content.includes("cron.schedule")) {
        for (const cm of reFinditer(R`cron\.schedule\(\s*["\']([^"\']+)["\']`, content)) {
          schedules.push({ name: pstem(tsF), task: rel(tsF, root), schedule: `cron(${cm.g(1)})` });
        }
      }
      if (content.includes("@Cron")) {
        for (const nm of reFinditer(R`@Cron\(\s*["\']([^"\']+)["\']\s*\)[\s\S]{1,120}?\b([a-zA-Z0-9_]+)\s*\(`, content)) {
          schedules.push({ name: nm.g(2), task: `${pstem(tsF)}.${nm.g(2)}`, schedule: `@Cron(${nm.g(1)})` });
        }
      }
    } catch {
      // a path outside the root
    }
  }

  return { services: services.slice(0, 35), schedules: schedules.slice(0, 25) };
}

// ---------------------------------------------------------------- protocols

export interface McpTool {
  name: string;
  description: string;
}

/** MCP tools (TS & Python FastMCP), WebSocket events, gRPC Protobuf services, and GraphQL operations. */
export function scanMcpAndWsProtocols(root: string): { mcp_tools: McpTool[]; ws_events: string[]; rpc_contracts: string[] } {
  const mcpTools: McpTool[] = [];
  const wsEvents: string[] = [];
  const rpcContracts: string[] = [];

  for (const mf of iterRepoFiles(root, "**/*.[tp][sy]", 60)) {
    const content = readCode(mf);
    try {
      if (content.includes("registerTool") || content.includes("@mcp.tool")) {
        for (const tm of reFinditer(R`registerTool\(\s*["\']([a-zA-Z0-9_-]+)["\']\s*,\s*\{[\s\S]*?description:\s*\n?\s*["\']([^"\']+)["\']`, content)) {
          mcpTools.push({ name: tm.g(1), description: pySlice(pyStrip(tm.g(2)), 0, 100) });
        }
        for (const pm of reFinditer(R`@mcp\.tool\([^)]*\)\s*(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?:->[^:]+)?:\s*(?:"""([^"]+)""")?`, content)) {
          mcpTools.push({ name: pm.g(1), description: pySlice(firstLine(pyStrip(pm.group(2) || "Python MCP tool")), 0, 100) });
        }
      }
      if (content.includes("WebSocket") || pstem(mf).toLowerCase().includes("ws") || content.includes("socket.on(") || content.includes("@sio.on(")) {
        for (const cm of reFinditer(R`(?:case|socket\.on\(|@sio\.on\()\s*["\']([a-zA-Z0-9_:-]+)["\']`, content)) {
          const ev = cm.g(1);
          if (!wsEvents.includes(ev) && ev.length > 2) wsEvents.push(ev);
        }
        for (const pm of reFinditer(R`msg_type\s*==\s*["\']([a-zA-Z0-9_:-]+)["\']`, content)) {
          const ev = pm.g(1);
          if (!wsEvents.includes(ev)) wsEvents.push(ev);
        }
      }
    } catch {
      // an empty MCP tool docstring (IndexError) ends this file
    }
  }

  // gRPC .proto & GraphQL .graphql/.gql contracts
  for (const pf of iterRepoFiles(root, "**/*.proto", 20)) {
    let content: string;
    try {
      content = readTextIgnore(pf);
    } catch {
      continue;
    }
    for (const sm of reFinditer(R`service\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}`, content)) {
      const sname = sm.g(1);
      for (const rm of reFinditer(
        R`rpc\s+([A-Za-z0-9_]+)\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)`,
        sm.g(2),
      )) {
        rpcContracts.push(`gRPC \`${sname}.${rm.g(1)}(${rm.g(2)}) ➔ ${rm.g(3)}\``);
      }
    }
  }

  for (const gf of [...iterRepoFiles(root, "**/*.graphql", 20), ...iterRepoFiles(root, "**/*.gql", 20)]) {
    let content: string;
    try {
      content = readTextIgnore(gf);
    } catch {
      continue;
    }
    for (const tm of reFinditer(R`type\s+(Query|Mutation|Subscription)\s*\{([\s\S]*?)\}`, content)) {
      const kind = tm.g(1);
      for (const fm of reFinditer(R`^\s*([a-zA-Z0-9_]+)\s*(?:\([^)]*\))?\s*:\s*([A-Za-z0-9_\[\]!]+)`, tm.g(2), { m: true })) {
        rpcContracts.push(`GraphQL \`${kind}.${fm.g(1)} ➔ ${fm.g(2)}\``);
      }
    }
  }

  return { mcp_tools: mcpTools.slice(0, 25), ws_events: wsEvents.slice(0, 25), rpc_contracts: rpcContracts.slice(0, 20) };
}

// ---------------------------------------------------------------- CI/CD

export interface CicdItem {
  kind: string;
  name: string;
  path: string;
  details: string;
}

/** GitHub Actions workflows and Kubernetes / Docker deployment manifests. */
export function scanCicdAndDeploy(root: string): CicdItem[] {
  const items: CicdItem[] = [];
  const wfDir = pjoin(root, ".github", "workflows");
  if (isDir(wfDir)) {
    for (const wf of sortedPaths(pglob(wfDir, "*.y*ml"))) {
      try {
        const content = readCode(wf, 50_000);
        const nm = reSearch(R`^name:\s*(.+)$`, content, { m: true });
        const wname = nm ? pyStrip(pyStrip(nm.g(1)), "\"'") : pstem(wf);
        const jm = reSearch(R`^jobs:\s*\n([\s\S]*)`, content, { m: true });
        const jobs = jm ? reFindall(R`^  ([a-zA-Z0-9_-]+):\s*(?:#.*)?$`, jm.g(1), { m: true }) : [];
        items.push({
          kind: "GitHub Actions",
          name: wname,
          path: rel(wf, root),
          details: jobs.length ? `Jobs: ${jobs.slice(0, 6).join(", ")}` : "CI/CD pipeline",
        });
      } catch {
        // a path outside the root
      }
    }
  }

  const gitlabCi = pjoin(root, ".gitlab-ci.yml");
  if (isFile(gitlabCi)) {
    const content = readCode(gitlabCi, 50_000);
    const stagesM = reSearch(R`^stages:\s*\n((?:\s*-\s*[^\n]+\n)+)`, content, { m: true });
    const stages = stagesM
      ? pySplitlines(stagesM.g(1))
          .filter((s) => pyStrip(s))
          .map((s) => pyStrip(pyLstrip(pyStrip(s), "-")))
      : [];
    items.push({
      kind: "GitLab CI",
      name: ".gitlab-ci.yml",
      path: ".gitlab-ci.yml",
      details: stages.length ? `Stages: ${stages.slice(0, 6).join(", ")}` : "GitLab CI/CD pipeline",
    });
  }

  for (const deployDir of [pjoin(root, "deploy"), pjoin(root, "k8s")]) {
    if (!isDir(deployDir)) continue;
    for (const ym of sortedPaths(pglob(deployDir, "**/*.y*ml")).slice(0, 12)) {
      try {
        const content = readCode(ym, 30_000);
        const kinds = uniq(reFindall(R`^kind:\s*([A-Za-z0-9]+)`, content, { m: true }));
        if (kinds.length) {
          items.push({ kind: "K8s / GitOps", name: pname(ym), path: rel(ym, root), details: `Resources: ${kinds.slice(0, 5).join(", ")}` });
        }
      } catch {
        // a path outside the root
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------- hotspots & tests

export interface Hotspot {
  path: string;
  commits: number;
}

export interface TestSuite {
  suite: string;
  dir: string;
  count: number;
  samples: string;
}

const HOTSPOT_SKIP_SUFFIXES = [".lock", ".json", ".min.js", ".map", "pnpm-lock.yaml", "package-lock.json", "Cargo.lock", "uv.lock", "poetry.lock"];

/** High-frequency changed source files from git log, and the test suites. */
export function scanHotspotsAndTests(root: string): { hotspots: Hotspot[]; test_suites: TestSuite[] } {
  const hotspots: Hotspot[] = [];
  const out = runGit(["log", "-n", "60", "--grep=\\[skip ci\\]", "--invert-grep", "--pretty=format:", "--name-only"], root);
  if (out) {
    const counts = new Map<string, number>();
    for (const line of pySplitlines(out)) {
      const p = pyStrip(line);
      if (!p || p === "PROJECT_BLUEPRINT.md" || p === "deploy/k8s/kustomization.yaml" || endsWithAny(p, HOTSPOT_SKIP_SUFFIXES)) continue;
      if (pparts(p).some((part) => IGNORED_DIRS.has(part))) continue;
      if (!isFile(pjoin(root, p))) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const ranked = Array.from(counts).sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]));
    for (const [pathStr, cnt] of ranked.slice(0, 10)) hotspots.push({ path: pathStr, commits: cnt });
  }

  const testSuites: TestSuite[] = [];
  const allTestFiles = [
    ...iterRepoFiles(root, "**/test_*.py", 150),
    ...iterRepoFiles(root, "**/*_test.py", 100),
    ...iterRepoFiles(root, "**/*.test.[tj]s*", 150),
    ...iterRepoFiles(root, "**/*.spec.[tj]s*", 100),
    ...iterRepoFiles(root, "**/*_test.go", 100),
    ...iterRepoFiles(root, "**/*Test.java", 100),
    ...iterRepoFiles(root, "**/*Test.kt", 100),
  ];
  const grouped = new Map<string, string[]>();
  for (const tf of uniqPaths(allTestFiles)) {
    const relDir = rel(pparent(tf), root);
    const list = grouped.get(relDir);
    if (list) list.push(pname(tf));
    else grouped.set(relDir, [pname(tf)]);
  }

  const ranked = Array.from(grouped).sort((a, b) => b[1].length - a[1].length || cmpStr(a[0], b[0]));
  for (const [relDir, tfiles] of ranked.slice(0, 10)) {
    const sfiles = sortedStr(uniq(tfiles));
    const runner = sfiles.some((n) => n.endsWith(".py"))
      ? "pytest"
      : sfiles.some((n) => n.endsWith(".go"))
        ? "go test"
        : sfiles.some((n) => endsWithAny(n, [".java", ".kt"]))
          ? "JUnit"
          : "vitest / jest";
    testSuites.push({
      suite: `${relDir} (${runner})`,
      dir: relDir,
      count: sfiles.length,
      samples: sfiles
        .slice(0, 5)
        .map((n) => `\`${n}\``)
        .join(", "),
    });
  }
  return { hotspots, test_suites: testSuites };
}

// ---------------------------------------------------------------- call graph

/** Cross-module dependency and call graph from package manifests, Python imports and TS/Go imports. */
export function scanAstCallGraphAndDeps(root: string): { package_edges: string[]; call_edges: string[] } {
  const pkgEdges: string[] = [];
  const callEdges: string[] = [];
  const rootPj = pjoin(root, "package.json");

  // 1. Monorepo workspace package dependencies (package.json / Cargo.toml)
  const workspacePkgs = new Map<string, string>();
  for (const pj of iterRepoFiles(root, "**/package.json", 40)) {
    if (samePath(pj, rootPj)) continue;
    try {
      const data = loads(readTextIgnore(pj));
      const name = pyGet(data, "name");
      const relDir = rel(pparent(pj), root);
      if (typeof name === "string" && name) workspacePkgs.set(name, relDir);
    } catch {
      // not a readable manifest
    }
  }

  for (const pj of iterRepoFiles(root, "**/package.json", 40)) {
    if (samePath(pj, rootPj)) continue;
    try {
      const data = loads(readTextIgnore(pj));
      const srcDir = rel(pparent(pj), root);
      const deps = mergeDicts(orDict(pyGet(data, "dependencies")), orDict(pyGet(data, "devDependencies")));
      for (const depName of deps.keys()) {
        const target = workspacePkgs.get(depName);
        if (target !== undefined && target !== srcDir) {
          const edge = `\`${srcDir}\` ➔ \`${target}\` (\`${depName}\`)`;
          if (!pkgEdges.includes(edge)) pkgEdges.push(edge);
        }
      }
    } catch {
      // not a readable manifest
    }
  }

  // 2. Python AST cross-layer call & dependency graph (API / Tasks ➔ Services / DB)
  const pyFiles = [
    ...iterRepoFiles(root, "**/api/*.py", 35),
    ...iterRepoFiles(root, "**/tasks/*.py", 25),
    ...iterRepoFiles(root, "**/routers/*.py", 25),
    ...iterRepoFiles(root, "**/*.py", 40),
  ];
  const seenPy = new PathSet();
  for (const pf of pyFiles) {
    if (seenPy.has(pf) || pname(pf).startsWith("_") || pparts(pf).includes("test")) continue;
    seenPy.add(pf);
    let imports;
    try {
      imports = parseModule(readCode(pf)).imports;
    } catch {
      continue;
    }
    const parent = pparent(pf);
    const srcLabel = !samePath(parent, root) ? `${pname(parent)}/${pstem(pf)}` : pstem(pf);
    for (const node of imports) {
      const mod = node.module;
      if (!mod) continue;
      if (!(mod.includes("services") || mod.includes("db") || mod.includes("tasks"))) continue;
      const parts = mod.split(".");
      const last = parts[parts.length - 1]!;
      if (["services", "db", "tasks", "models", "core"].includes(last)) {
        for (const alias of node.names) {
          const targetMod = `${last}/${alias}`;
          const edge = `\`${srcLabel}\` ➔ \`${targetMod}\``;
          if (!callEdges.includes(edge) && srcLabel !== targetMod) callEdges.push(edge);
        }
      } else {
        const targetMod = parts.length >= 2 ? parts.slice(-2).join("/") : last;
        const edge = `\`${srcLabel}\` ➔ \`${targetMod}\``;
        if (!callEdges.includes(edge) && srcLabel !== targetMod) callEdges.push(edge);
      }
    }
  }

  // 3. TypeScript / Go internal module imports when Python edges are absent
  if (callEdges.length < 10) {
    for (const tf of iterRepoFiles(root, "**/*.[tg][so]*", 45)) {
      const tn = pname(tf);
      if (tn.includes(".test.") || tn.includes(".spec.") || tn.endsWith("_test.go")) continue;
      const content = readCode(tf);
      const srcLabel = `${pname(pparent(tf))}/${pstem(tf)}`;
      for (const im of reFinditer(R`from\s+["\'](?:\.\.?/|@/)([a-zA-Z0-9_/-]+)["\']`, content)) {
        const edge = `\`${srcLabel}\` ➔ \`${pyRstrip(im.g(1), "/")}\``;
        if (!callEdges.includes(edge) && callEdges.length < 25) callEdges.push(edge);
      }
    }
  }

  return { package_edges: pkgEdges.slice(0, 15), call_edges: callEdges.slice(0, 20) };
}

// ---------------------------------------------------------------- DTO schemas

export interface DtoSchema {
  name: string;
  kind: string;
  source: string;
  fields: string;
}

/** OpenAPI/Swagger specs, Pydantic BaseModel DTOs and TypeScript interfaces. */
export function scanOpenapiAndDtoSchemas(root: string): DtoSchema[] {
  const schemas: DtoSchema[] = [];
  const seen = new Set<string>();
  const key = (name: string, src: string) => `${name}\u0000${src}`;

  // 1. OpenAPI / Swagger JSON files
  for (const oaFile of uniqPaths([...iterRepoFiles(root, "**/*openapi*.json", 5), ...iterRepoFiles(root, "**/*swagger*.json", 5)])) {
    try {
      const data = loads(readCode(oaFile, 100_000));
      const components = pyGet(data, "components");
      const fromComponents = pyGet(truthy(components) ? components : new Map(), "schemas");
      let compSchemas: PyValue | undefined = fromComponents;
      if (!truthy(compSchemas)) compSchemas = pyGet(data, "definitions");
      if (!truthy(compSchemas)) compSchemas = new Map();
      if (!isDict(compSchemas)) throw new TypeError("'items' on a non-dict");
      const srcRel = rel(oaFile, root);
      for (const [sname, sdef] of Array.from(compSchemas as PyDict).slice(0, 15)) {
        if (isDict(sdef) && !seen.has(key(sname, srcRel))) {
          seen.add(key(sname, srcRel));
          const propsRaw = pyGet(sdef, "properties");
          const propsDict = truthy(propsRaw) ? propsRaw : new Map();
          if (!isDict(propsDict)) throw new TypeError("'keys' on a non-dict");
          const props = Array.from(propsDict.keys()).slice(0, 6);
          schemas.push({
            name: sname,
            kind: "OpenAPI Schema",
            source: srcRel,
            fields: props.length ? props.map((p) => `\`${p}\``).join(", ") : "object",
          });
        }
      }
    } catch {
      // not a readable spec
    }
  }

  // 2. Python Pydantic Request/Response DTOs (via the parser)
  for (const pyFile of uniqPaths([...iterRepoFiles(root, "**/api/*.py", 30), ...iterRepoFiles(root, "**/schemas*.py", 20)])) {
    try {
      const { classes } = parseModule(readCode(pyFile));
      const srcRel = rel(pyFile, root);
      for (const node of classes) {
        if (seen.has(key(node.name, srcRel))) continue;
        const bases = node.bases.map((b) => unparse(b));
        if (!bases.some((b) => b.includes("BaseModel") || b.includes("Schema"))) continue;
        const fields: string[] = [];
        for (const f of node.fields) {
          if (f.name.startsWith("_")) continue;
          const ftype = replaceAll(unparse(f.annotation), "|", "\\|");
          fields.push(ftype ? `${f.name}: ${ftype}` : f.name);
        }
        if (fields.length) {
          seen.add(key(node.name, srcRel));
          schemas.push({
            name: node.name,
            kind: "Pydantic DTO",
            source: srcRel,
            fields: fields
              .slice(0, 6)
              .map((f) => `\`${f}\``)
              .join(", "),
          });
        }
      }
    } catch {
      // a syntax error, or an annotation that can't be written back
    }
  }

  // 3. TypeScript exported interfaces / Zod schemas
  if (schemas.length < 20) {
    for (const tsFile of uniqPaths([...iterRepoFiles(root, "**/types*.ts", 15), ...iterRepoFiles(root, "**/*dto*.ts", 15)])) {
      try {
        const content = readCode(tsFile);
        const srcRel = rel(tsFile, root);
        if (!content.includes("interface ")) continue;
        for (const im of reFinditer(R`export\s+interface\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}`, content)) {
          const iname = im.g(1);
          if (seen.has(key(iname, srcRel))) continue;
          const props = reFindall(R`^\s*([a-zA-Z0-9_]+)\??\s*:`, im.g(2), { m: true });
          if (props.length) {
            seen.add(key(iname, srcRel));
            schemas.push({
              name: iname,
              kind: "TS Interface",
              source: srcRel,
              fields: props
                .slice(0, 6)
                .map((p) => `\`${p}\``)
                .join(", "),
            });
          }
        }
      } catch {
        // a path outside the root
      }
    }
  }

  return schemas.slice(0, 25);
}

// ---------------------------------------------------------------- CLI entrypoints

export interface CliEntry {
  name: string;
  kind: string;
  path: string;
}

/** CLI binaries, pyproject scripts, Go cmd/*, Rust src/bin/*, and repository utility scripts. */
export function scanCliAndEntrypoints(root: string): CliEntry[] {
  const entries: CliEntry[] = [];

  // 1. package.json bin entries
  for (const pj of iterRepoFiles(root, "**/package.json", 30)) {
    try {
      const data = loads(readTextIgnore(pj));
      const bins = pyGet(data, "bin");
      if (isDict(bins)) {
        for (const [bname, bpath] of bins) {
          entries.push({ name: bname, kind: "Node CLI Binary", path: rel(pjoin(pparent(pj), pyStr(bpath)), root) });
        }
      } else if (typeof bins === "string" && truthy(pyGet(data, "name"))) {
        entries.push({ name: pyStr(pyGet(data, "name")), kind: "Node CLI Binary", path: rel(pjoin(pparent(pj), bins), root) });
      }
    } catch {
      // not a readable manifest, or a bin outside the root
    }
  }

  // 2. pyproject.toml [project.scripts]
  for (const pp of iterRepoFiles(root, "**/pyproject.toml", 15)) {
    let content: string;
    try {
      content = readTextIgnore(pp);
    } catch {
      continue;
    }
    const sm = reSearch(R`\[project\.scripts\]([\s\S]*?)(?:\n\[|\Z)`, content);
    if (!sm) continue;
    for (const line of pySplitlines(sm.g(1))) {
      if (line.includes("=") && !pyStrip(line).startsWith("#")) {
        const [k, v] = pySplit(line, "=", 1) as [string, string];
        entries.push({ name: pyStrip(k), kind: "Python CLI Script", path: pyStrip(pyStrip(v), "\"'") });
      }
    }
  }

  // 3. Go cmd/*/main.go & Rust src/bin/*.rs
  for (const gm of iterRepoFiles(root, "cmd/*/main.go", 15)) {
    entries.push({ name: pname(pparent(gm)), kind: "Go Command", path: rel(gm, root) });
  }
  for (const rb of iterRepoFiles(root, "**/src/bin/*.rs", 15)) {
    entries.push({ name: pstem(rb), kind: "Rust Binary", path: rel(rb, root) });
  }

  // 4. Repository scripts/ directory
  const scriptsDir = pjoin(root, "scripts");
  if (isDir(scriptsDir)) {
    for (const sf of sortedPaths(iterdir(scriptsDir))) {
      if (isFile(sf) && !pname(sf).startsWith("_") && [".py", ".sh", ".mjs", ".ts", ".js"].includes(psuffix(sf))) {
        entries.push({ name: pname(sf), kind: "Automation Script", path: rel(sf, root) });
      }
    }
  }

  return entries.slice(0, 20);
}

// ---------------------------------------------------------------- infra & env

const INFRA_RULES: [string, string[]][] = [
  ["PostgreSQL", ["postgres", "asyncpg", "psycopg", "pgvector", '"pg"', "pgx"]],
  ["pgvector (Vector DB)", ["pgvector"]],
  ["Redis", ["redis", "ioredis", "bullmq"]],
  ["MySQL / MariaDB", ["mysql", "pymysql", "mariadb"]],
  ["SQLite", ["sqlite", "aiosqlite", "better-sqlite3"]],
  ["MongoDB", ["mongodb", "mongoose", "pymongo", "motor"]],
  ["MinIO / S3 Object Storage", ["minio", "s3", "boto3", "@aws-sdk/client-s3"]],
  ["Celery Task Queue", ["celery"]],
  ["Kafka", ["kafka", "confluent-kafka", "kafkajs"]],
  ["RabbitMQ", ["rabbitmq", "amqp", "pika"]],
  ["Elasticsearch / OpenSearch", ["elasticsearch", "opensearch"]],
];

/** External databases, caches, queues, and object storage used by the project. */
export function scanExternalInfra(root: string): string[] {
  const manifestTexts: string[] = [];
  for (const fname of ["docker-compose.yml", "docker-compose.yaml", ".env.example", "pyproject.toml", "package.json", "go.mod", "Cargo.toml"]) {
    const p = pjoin(root, fname);
    if (exists(p)) {
      try {
        manifestTexts.push(readTextIgnore(p).toLowerCase());
      } catch {
        // unreadable
      }
    }
  }
  for (const subM of [...iterRepoFiles(root, "**/pyproject.toml", 10), ...iterRepoFiles(root, "**/package.json", 15)]) {
    try {
      manifestTexts.push(readTextIgnore(subM).toLowerCase());
    } catch {
      // unreadable
    }
  }
  const blob = manifestTexts.join("\n");
  return INFRA_RULES.filter(([, keywords]) => keywords.some((kw) => blob.includes(kw))).map(([label]) => label);
}

/** Mask private network IP ranges or sensitive internal addresses. */
export function sanitizeBlueprintText(text: string): string {
  let t = reSub(R`192\.168\.\d{1,3}\.[a-zA-Z0-9_.-]+`, "<internal-ip>", text);
  t = reSub(R`10\.\d{1,3}\.\d{1,3}\.[a-zA-Z0-9_.-]+`, "<internal-ip>", t);
  t = reSub(R`172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.[a-zA-Z0-9_.-]+`, "<internal-ip>", t);
  return t;
}

export interface EnvVar {
  name: string;
  default: string;
  description: string;
}

/** Environment variables declared in .env.example / .env.sample. */
export function scanEnvVariables(root: string): EnvVar[] {
  const vars: EnvVar[] = [];
  let envExample = pjoin(root, ".env.example");
  if (!exists(envExample)) envExample = pjoin(root, ".env.sample");
  if (!exists(envExample)) return vars;
  let content: string;
  try {
    content = readTextIgnore(envExample);
  } catch {
    return vars;
  }
  let currentComment = "";
  for (const line of pySplitlines(content)) {
    const sline = pyStrip(line);
    if (!sline) {
      currentComment = "";
      continue;
    }
    if (sline.startsWith("#")) {
      const cleaned = sanitizeBlueprintText(pyStrip(pyLstrip(sline, "#")));
      if (cleaned && !reMatch(R`^[-=_─*#\s]+$`, cleaned)) currentComment = cleaned;
      continue;
    }
    if (sline.includes("=")) {
      const [rawK, v] = pySplit(sline, "=", 1) as [string, string];
      const k = pyStrip(rawK);
      if (k && !k.startsWith("#")) {
        const cleanVal = sanitizeBlueprintText(pyStrip(v));
        vars.push({ name: k, default: cleanVal || "(required secret)", description: currentComment || "Environment configuration" });
        currentComment = "";
      }
    }
  }
  return vars;
}

// ---------------------------------------------------------------- git & commands

/** Recent commits, skipping the CI bot's deploy bumps. */
export function getGitEvolution(root: string, limit = 5): string[] {
  const out = runGit(["log", `-n${limit * 3}`, "--pretty=format:%h|%s|%as"], root);
  if (!out) return [];
  const evos: string[] = [];
  for (const line of pySplitlines(out)) {
    const parts = pySplit(line, "|", 2);
    if (parts.length !== 3) continue;
    const [sha, msg, date] = parts as [string, string, string];
    // Skip CI automated deployment commits
    if (msg.includes("[skip ci]") || msg.includes("ci(deploy):")) continue;
    evos.push(`- \`${sha}\` (${date}): ${msg}`);
    if (evos.length >= limit) break;
  }
  return evos;
}

/** `scripts = pdata.get("scripts", {})` followed by `"x" in scripts` checks. */
function manifestScripts(pdata: PyValue): PyValue {
  const sc = pyGet(pdata, "scripts");
  return sc === undefined ? new Map() : sc;
}

/** Project-specific verification, test, and typecheck commands. */
export function detectVerificationCommands(root: string): string[] {
  const commands: string[] = [];

  // 1. Specialized detection for Memento Monorepo
  if (isDir(pjoin(root, "packages", "daemon")) && isDir(pjoin(root, "server", "server"))) {
    commands.push(
      "# Backend Tests (Python)",
      "cd server && uv run pytest -W error::RuntimeWarning",
      "",
      "# Backend Lint",
      "uvx ruff check --isolated --select F server/server",
      "",
      "# Frontend Tests & Typecheck (Next.js)",
      "cd apps/web && npx tsc --noEmit && npm test",
      "",
      "# Daemon Tests",
      "cd packages/daemon && npm test",
      "",
      "# Desktop Tests & Typecheck (Electron)",
      "npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test",
    );
    return commands;
  }

  // 2. General Python project (root or backend/)
  const pyproject = pjoin(root, "pyproject.toml");
  const hasPython = exists(pyproject) || exists(pjoin(root, "requirements.txt")) || exists(pjoin(root, "setup.py")) || pglob(root, "*.py").length > 0;
  if (hasPython) {
    if (exists(pjoin(root, "pytest.ini")) || isDir(pjoin(root, "tests")) || isDir(pjoin(root, "test"))) commands.push("# Python Tests", "pytest");
    if (exists(pjoin(root, "ruff.toml")) || (exists(pyproject) && readCode(pyproject, 20_000).includes("ruff"))) commands.push("# Python Lint", "ruff check .");
  } else if (isDir(pjoin(root, "backend")) && (exists(pjoin(root, "backend", "requirements.txt")) || exists(pjoin(root, "backend", "pyproject.toml")))) {
    if (isDir(pjoin(root, "backend", "tests")) || exists(pjoin(root, "backend", "pytest.ini"))) commands.push("# Backend Python Tests", "cd backend && pytest");
  }

  // 3. General Node / TypeScript project (root or frontend/ / desktop/ / client/)
  const pjsonPath = pjoin(root, "package.json");
  if (exists(pjsonPath)) {
    try {
      const scripts = manifestScripts(loads(readCode(pjsonPath, 20_000)));
      if (pyIn("test", scripts)) commands.push("# Unit Tests", "npm test");
      if (pyIn("typecheck", scripts) || exists(pjoin(root, "tsconfig.json"))) commands.push("# Typecheck", "npx tsc --noEmit");
      if (pyIn("lint", scripts)) commands.push("# Code Lint", "npm run lint");
      if (pyIn("build", scripts)) commands.push("# Build Package", "npm run build");
    } catch {
      // not a readable manifest
    }
  } else {
    for (const subNode of ["frontend", "desktop", "client", "web"]) {
      const subPj = pjoin(root, subNode, "package.json");
      if (!exists(subPj)) continue;
      try {
        const scripts = manifestScripts(loads(readCode(subPj, 20_000)));
        if (pyIn("test", scripts)) commands.push(`# ${pyCapitalize(subNode)} Tests`, `cd ${subNode} && npm test`);
        if (pyIn("build", scripts)) commands.push(`# ${pyCapitalize(subNode)} Build`, `cd ${subNode} && npm run build`);
      } catch {
        // not a readable manifest
      }
    }
  }

  // 4. Rust project
  if (exists(pjoin(root, "Cargo.toml"))) commands.push("# Cargo Tests", "cargo test", "", "# Cargo Clippy", "cargo clippy");

  // 5. Go project
  if (exists(pjoin(root, "go.mod"))) commands.push("# Go Tests", "go test ./...");

  // Fallback default
  if (!commands.length) commands.push("# Project Status & Integrity Check", "git status -s");

  return commands;
}
