// Installs the BGE-M3 embedding server as a host-side background service (`./install.sh embedding
// --native`). On the host rather than in Docker because macOS Docker Desktop can't reach the MPS GPU;
// NVIDIA on Linux and Windows works the same way.
//
// Service managers: launchd on macOS, systemd on Linux (user units, or system units when run as root),
// a Scheduled Task on Windows. The server itself is Python (torch), so this path still needs Python 3.11+.
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_LINUX, IS_MAC, IS_WINDOWS, REPO_ROOT, detectAccelerator, errorText, findPython, info, ok, run, warn } from "./platform.mts";

export const VENV_DIR = join(REPO_ROOT, ".venv-embedding");
const TEMPLATE_DIR = join(REPO_ROOT, "scripts", "templates");
const DEFAULT_MODEL = "BAAI/bge-m3";

const venvPython = () => (IS_WINDOWS ? join(VENV_DIR, "Scripts", "python.exe") : join(VENV_DIR, "bin", "python"));
const venvPythonw = () => (IS_WINDOWS ? join(VENV_DIR, "Scripts", "pythonw.exe") : venvPython());
/** A Python string literal (JSON's escapes are valid Python). */
const pyStr = (s: string) => JSON.stringify(s);

export function createVenv(): string {
  if (existsSync(venvPython())) {
    ok(`Embedding venv already present at ${VENV_DIR}`);
    return venvPython();
  }
  info(`Creating venv at ${VENV_DIR}…`);
  run(findPython(), ["-m", "venv", VENV_DIR], { check: true });
  // upgrade pip so wheel installs don't warn
  run(venvPython(), ["-m", "pip", "install", "-U", "pip", "wheel", "setuptools"], { check: true });
  ok("Venv created.");
  return venvPython();
}

export function installTorchAndTransformers(): void {
  const py = venvPython();
  const accel = detectAccelerator();
  info(`Detected accelerator: ${accel}`);
  // torch>=2.6: since CVE-2025-32434 transformers 5.x refuses torch.load on anything older, and
  // BGE-M3's pytorch_model.bin only loads through torch.load, so an older torch fails on the very last
  // step after a 2.27 GB download.
  const torchSpec = "torch>=2.6";
  if (accel === "cuda") {
    // Default PyPI ships CUDA torch wheels from 2.6 on (CUDA libs arrive as nvidia-cuda-* deps); the old
    // cu121 index caps at 2.5.1, which trips the torch.load guard above.
    info("Installing torch with CUDA support (default PyPI)…");
  } else if (accel === "mps") {
    info("Installing torch (MPS is built into the standard wheel on arm64 macOS)…");
  } else {
    warn("No GPU detected — embedding will run on CPU and will be slow.");
  }
  run(py, ["-m", "pip", "install", torchSpec], { check: true });
  info("Installing sentence-transformers + fastapi/uvicorn + modelscope…");
  run(py, ["-m", "pip", "install", "sentence-transformers>=3.0", "fastapi", "uvicorn", "modelscope"], { check: true });
  ok("Python dependencies installed.");
}

/**
 * Pre-fetches the model and returns what the server should load: the local path ModelScope cached it
 * at, or the HF id when a HuggingFace path worked. Sources in order: ModelScope (best from inside
 * China), HuggingFace direct, hf-mirror.com.
 */
export function predownloadModel(model = DEFAULT_MODEL): string {
  const py = venvPython();
  info(`Pre-downloading ${model} (~1.3GB, may take minutes)…`);

  const ms = run(py, ["-c", `from modelscope import snapshot_download;p = snapshot_download(${pyStr(model)});print(p, end='')`], {
    capture: true,
    timeoutMs: 1_800_000,
  });
  if ((ms.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    warn("ModelScope download timed out — falling back to HuggingFace…");
  } else if (ms.error || ms.status !== 0) {
    warn(`ModelScope download failed (${ms.stderr.slice(0, 300).trim()}) — falling back to HuggingFace…`);
  } else {
    const localPath = ms.stdout.trim();
    if (localPath && existsSync(localPath)) {
      // Smoke test: sentence-transformers must be able to load it
      const verify = run(py, ["-c", `from sentence_transformers import SentenceTransformer;SentenceTransformer(${pyStr(localPath)})`]);
      if (!verify.error && verify.status === 0) {
        ok(`Model downloaded via ModelScope → ${localPath}`);
        return localPath;
      }
      warn("ModelScope download failed () — falling back to HuggingFace…");
    }
  }

  const hfCode = `from sentence_transformers import SentenceTransformer;SentenceTransformer(${pyStr(model)})`;
  const hf = run(py, ["-c", hfCode]);
  if (!hf.error && hf.status === 0) {
    ok("Model downloaded via HuggingFace.");
    return model;
  }
  warn("HuggingFace direct download failed — retrying via hf-mirror.com…");
  run(py, ["-c", hfCode], { check: true, env: { ...process.env, HF_ENDPOINT: "https://hf-mirror.com" } });
  ok("Model downloaded via hf-mirror.com.");
  return model;
}

/** `{name}` substitution; the templates have no other braces. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`template variable {${name}} not provided`);
    return v;
  });
}

const template = (name: string) => readFileSync(join(TEMPLATE_DIR, name), "utf8");
const pathEnv = () => process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
const uid = () => process.getuid?.() ?? 0;

function installMacos(model: string): void {
  const agents = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  // Migrate: unload + remove the legacy com.dailyreport.embedding plist
  const legacy = join(agents, "com.dailyreport.embedding.plist");
  if (existsSync(legacy)) {
    run("launchctl", ["bootout", `gui/${uid()}/com.dailyreport.embedding`], { capture: true });
    run("launchctl", ["unload", legacy], { capture: true });
    unlinkSync(legacy);
    info("Migrated: removed legacy com.dailyreport.embedding.plist");
  }
  const label = "com.memento.embedding";
  const plistPath = join(agents, `${label}.plist`);
  const logdir = join(homedir(), "Library", "Logs", "memento");
  mkdirSync(logdir, { recursive: true });
  writeFileSync(
    plistPath,
    render(template("memento-embedding.plist.tmpl"), { python: venvPython(), repo: REPO_ROOT, logdir, path: pathEnv(), model }),
  );
  // Unload a previous copy if there is one, then bootstrap (newer macOS) or load (older)
  run("launchctl", ["bootout", `gui/${uid()}/${label}`], { capture: true });
  const r = run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath], { capture: true });
  if (r.error || r.status !== 0) run("launchctl", ["load", plistPath], { check: true });
  ok(`launchd service installed: ${label}.plist`);
}

const LINUX_SCOPES: [dir: string, ctl: string[]][] = [
  [join(homedir(), ".config", "systemd", "user"), ["systemctl", "--user"]],
  ["/etc/systemd/system", ["systemctl"]],
];

function installLinux(model: string): void {
  // By effective uid: user units for desktops; root (headless servers) gets a system unit, because root
  // usually has no user dbus session and `systemctl --user daemon-reload` fails to connect to the bus.
  const isSystem = process.geteuid?.() === 0;
  const unitDir = isSystem ? "/etc/systemd/system" : join(homedir(), ".config", "systemd", "user");
  const ctl = isSystem ? ["systemctl"] : ["systemctl", "--user"];
  const wantedBy = isSystem ? "multi-user.target" : "default.target";
  const logdir = isSystem ? "/var/log/memento" : join(homedir(), ".local", "share", "memento", "logs");
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(logdir, { recursive: true });

  // Migrate: the legacy dr-embedding.service from both scopes (upgrades may have switched scope)
  for (const [dir, legacyCtl] of LINUX_SCOPES) {
    const legacy = join(dir, "dr-embedding.service");
    if (!existsSync(legacy)) continue;
    run(legacyCtl[0]!, [...legacyCtl.slice(1), "disable", "--now", "dr-embedding"], { capture: true });
    try {
      unlinkSync(legacy);
      info(`Migrated: removed legacy ${legacy}`);
    } catch {
      // not ours to remove (system scope without root)
    }
  }

  const unitPath = join(unitDir, "memento-embedding.service");
  writeFileSync(
    unitPath,
    render(template("memento-embedding.service.tmpl"), {
      python: venvPython(),
      repo: REPO_ROOT,
      logdir,
      path: pathEnv(),
      model,
      wanted_by: wantedBy,
    }),
  );
  run(ctl[0]!, [...ctl.slice(1), "daemon-reload"], { check: true });
  run(ctl[0]!, [...ctl.slice(1), "enable", "--now", "memento-embedding"], { check: true });
  ok(`systemd ${isSystem ? "system" : "user"} service installed: ${unitPath}`);

  if (!isSystem) {
    // Lingering keeps a user service running after logout (headless use); system units start at boot
    const user = process.env.USER ?? "";
    const r = run("loginctl", ["show-user", user, "--property=Linger"], { capture: true });
    if (r.stdout.includes("Linger=no")) {
      warn(`Service will stop when you log out. To keep it running headless, run:\n    sudo loginctl enable-linger ${process.env.USER ?? "$USER"}`);
    }
  }
}

function installWindows(model: string): void {
  // Migrate: the legacy DailyReportEmbedding task
  run("schtasks", ["/Delete", "/TN", "DailyReportEmbedding", "/F"], { capture: true });
  mkdirSync(join(process.env.LOCALAPPDATA ?? homedir(), "memento", "logs"), { recursive: true });
  const body = render(template("memento-embedding-task.xml.tmpl"), { pythonw: venvPythonw(), repo: REPO_ROOT, model });
  // schtasks wants the XML in UTF-16 (with a byte order mark) on disk
  const xml = join(tmpdir(), "memento-embedding-task.xml");
  writeFileSync(xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body.replace(/\r?\n/g, "\r\n"), "utf16le")]));
  run("schtasks", ["/Delete", "/TN", "MementoEmbedding", "/F"], { capture: true });
  run("schtasks", ["/Create", "/TN", "MementoEmbedding", "/XML", xml, "/F"], { check: true });
  run("schtasks", ["/Run", "/TN", "MementoEmbedding"]);
  ok("Task Scheduler task 'MementoEmbedding' installed and started.");
}

/** venv → deps → model → platform service. */
export function install(): void {
  createVenv();
  installTorchAndTransformers();
  const modelId = predownloadModel();
  if (IS_MAC) installMacos(modelId);
  else if (IS_LINUX) installLinux(modelId);
  else if (IS_WINDOWS) installWindows(modelId);
  else throw new Error(`Unsupported platform: ${process.platform}`);
  console.log();
  ok("Embedding service running on http://localhost:8002");
}

/** Removes the platform service, optionally the venv and the model caches. */
export function uninstall(removeModelCache = false, removeVenv = false): void {
  if (IS_MAC) {
    const agents = join(homedir(), "Library", "LaunchAgents");
    for (const label of ["com.memento.embedding", "com.dailyreport.embedding"]) {
      run("launchctl", ["bootout", `gui/${uid()}/${label}`], { capture: true });
      const plist = join(agents, `${label}.plist`);
      if (existsSync(plist)) {
        unlinkSync(plist);
        ok(`Removed launchd plist: ${label}.plist`);
      }
    }
    // launchd logs from the legacy and the current location
    for (const dir of ["memento", "daily_report"]) {
      for (const name of ["embedding_stdout.log", "embedding_stderr.log"]) rmSync(join(homedir(), "Library", "Logs", dir, name), { force: true });
    }
  } else if (IS_LINUX) {
    // Both scopes: the install may have switched between user and system across upgrades
    for (const [dir, ctl] of LINUX_SCOPES) {
      for (const name of ["memento-embedding", "dr-embedding"]) {
        run(ctl[0]!, [...ctl.slice(1), "disable", "--now", name], { capture: true });
        const unit = join(dir, `${name}.service`);
        if (!existsSync(unit)) continue;
        try {
          unlinkSync(unit);
          ok(`Removed systemd unit: ${unit}`);
        } catch (e) {
          warn(`Couldn't remove ${unit}: ${errorText(e)}`);
        }
      }
    }
  } else if (IS_WINDOWS) {
    for (const task of ["MementoEmbedding", "DailyReportEmbedding"]) run("schtasks", ["/Delete", "/TN", task, "/F"], { capture: true });
    ok("Removed Scheduled Task.");
  }

  if (removeVenv && existsSync(VENV_DIR)) {
    rmSync(VENV_DIR, { recursive: true, force: true });
    ok("Removed embedding venv .venv-embedding/");
  }
  if (removeModelCache) {
    // BGE-M3 lives in whichever cache the download fell through to
    const caches = [join(homedir(), ".cache", "huggingface", "hub"), ...(process.env.HF_HOME ? [join(process.env.HF_HOME, "hub")] : [])];
    for (const root of caches) {
      const dir = join(root, "models--BAAI--bge-m3");
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        ok(`Removed model cache ${dir}`);
      }
    }
    const ms = join(homedir(), ".cache", "modelscope", "hub", "BAAI", "bge-m3");
    if (existsSync(ms)) {
      rmSync(ms, { recursive: true, force: true });
      ok(`Removed model cache ${ms}`);
    }
  }
}
