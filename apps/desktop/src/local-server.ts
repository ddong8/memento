// 单机模式：在这台电脑上用 Docker 跑一份只给自己用的 memento 服务端（http://localhost:8770）。
//
// 用的就是企业私有化部署那套 compose（deploy/enterprise，构建时复制进 dist/local-server），按 personal.env
// 生成 .env：只监听本机、HTTP、镜像用多架构的 stable、第一个注册的人是所有者、之后不开放注册。
// 文件放在 ~/.memento/local-server；compose 和 Caddyfile 每次启动按这一版客户端覆盖，.env（密码与密钥）只生成一次。
// 命令行装的（deploy/personal.sh）是同一套东西，只是放在 ~/memento-server。
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LOCAL_PROJECT = "memento-personal";
/** Copied into the install folder on every start; the env template stays in the bundle (as env.example). */
const BUNDLED_FILES = ["docker-compose.yml", "Caddyfile", "personal.env"] as const;
/** Generated once per install; never leave the computer. */
const SECRETS: Record<string, number> = {
  POSTGRES_PASSWORD: 24,
  MINIO_ROOT_PASSWORD: 24,
  MEMENTO_SECRET_KEY: 32,
  MEMENTO_COLLECTOR_TOKEN: 32,
  MEMENTO_DATA_KEY: 32,
};

export type DockerState = "missing" | "stopped" | "ready";

export interface LocalServerStatus {
  docker: DockerState;
  /** Set up on this computer before (.env exists). */
  installed: boolean;
  /** Answers /health right now. */
  running: boolean;
  url: string;
  dir: string;
}

/** `KEY=value` lines of an env file, comments and blank lines skipped (values kept verbatim, backslashes too). */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return out;
}

/**
 * The personal .env: the enterprise template with personal.env's values and fresh secrets put in.
 * Keys are replaced in place (comments stay next to them); keys the template doesn't have are appended.
 */
export function buildPersonalEnv(example: string, overrides: string, rand: (bytes: number) => string = (n) => randomBytes(n).toString("hex")): string {
  const values = parseEnv(overrides);
  for (const [key, bytes] of Object.entries(SECRETS)) values.set(key, rand(bytes));
  const seen = new Set<string>();
  const lines = example.split(/\r?\n/).map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!m || !values.has(m[1]!)) return line;
    seen.add(m[1]!);
    return `${m[1]}=${values.get(m[1]!)}`;
  });
  for (const [key, value] of values) if (!seen.has(key)) lines.push(`${key}=${value}`);
  return lines.join("\n").replace(/\n*$/, "\n");
}

/** Where the server answers, from the .env (MEMENTO_PUBLIC_URL), defaulting to the personal one. */
export function localServerUrl(env: string): string {
  return (parseEnv(env).get("MEMENTO_PUBLIC_URL") || "http://localhost:8770").replace(/\/+$/, "");
}

/** Where the docker CLI may be: an app opened from the Dock / Start menu doesn't get the shell's PATH. */
export function dockerCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return ["docker", "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"];
  }
  if (platform === "darwin") {
    return ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker", join(homedir(), ".docker/bin/docker"), "docker"];
  }
  return ["/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker", "docker"];
}

/** PATH with docker's own folder and the usual bin folders in front (compose looks up docker-credential-* there). */
export function dockerPath(docker: string, platform: NodeJS.Platform = process.platform, current = process.env.PATH || ""): string {
  const sep = platform === "win32" ? ";" : ":";
  const extra = platform === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin"];
  const own = docker.includes("/") || docker.includes("\\") ? [dirname(docker)] : [];
  return [...new Set([...own, ...extra, ...current.split(sep).filter(Boolean)])].join(sep);
}

/** Where the compose plugin may be (an isolated DOCKER_CONFIG would otherwise lose ~/.docker/cli-plugins). */
export function pluginDirs(platform: NodeJS.Platform = process.platform, home = homedir(), dockerConfig = process.env.DOCKER_CONFIG): string[] {
  const own = [join(dockerConfig || join(home, ".docker"), "cli-plugins"), join(home, ".docker", "cli-plugins")];
  const system =
    platform === "win32"
      ? ["C:\\Program Files\\Docker\\cli-plugins", "C:\\Program Files\\Docker\\Docker\\resources\\cli-plugins"]
      : platform === "darwin"
        ? ["/Applications/Docker.app/Contents/Resources/cli-plugins", "/usr/local/lib/docker/cli-plugins", "/opt/homebrew/lib/docker/cli-plugins"]
        : ["/usr/local/lib/docker/cli-plugins", "/usr/libexec/docker/cli-plugins", "/usr/lib/docker/cli-plugins"];
  return [...new Set([...own, ...system])];
}

/**
 * The docker config the personal stack runs with: no credential store, the user's plugin folders.
 * Its images are public, and Docker Desktop's credential helper (docker-credential-desktop) can hang waiting on
 * the keychain, which stalls every pull with no output (seen 2026-11-27: an hour without one layer).
 */
export function isolatedDockerConfig(platform: NodeJS.Platform = process.platform, home = homedir(), dockerConfig = process.env.DOCKER_CONFIG): string {
  return JSON.stringify({ cliPluginsExtraDirs: pluginDirs(platform, home, dockerConfig) }, null, 2) + "\n";
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

export class LocalServer {
  readonly dir: string;
  private docker: string | null = null;
  /** Env for compose: the isolated docker config pointed at the engine the user's context uses. */
  private composeEnv: NodeJS.ProcessEnv | null = null;
  private starting: Promise<{ ok: boolean; url?: string; error?: string; code?: string }> | null = null;

  constructor(
    private readonly bundleDir: string,
    dir = join(homedir(), ".memento", "local-server"),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.dir = dir;
  }

  private envFile(): string {
    return join(this.dir, ".env");
  }

  url(): string {
    try {
      return localServerUrl(readFileSync(this.envFile(), "utf8"));
    } catch {
      return localServerUrl(readFileSync(join(this.bundleDir, "personal.env"), "utf8"));
    }
  }

  private run(args: string[], timeoutMs = 20_000): Promise<{ code: number; out: string }> {
    const docker = this.docker ?? "docker";
    return new Promise((done) => {
      execFile(docker, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: dockerPath(docker, this.platform) } }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        done({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
      });
    });
  }

  /** The first docker CLI that runs; whether its engine answers. */
  async dockerState(): Promise<DockerState> {
    if (!this.docker) {
      for (const cand of dockerCandidates(this.platform)) {
        if ((cand.includes("/") || cand.includes("\\")) && !existsSync(cand)) continue;
        this.docker = cand;
        const v = await this.run(["--version"], 8000);
        if (v.code === 0) break;
        this.docker = null;
      }
      if (!this.docker) return "missing";
    }
    const info = await this.run(["info", "--format", "{{.ServerVersion}}"], 15_000);
    return info.code === 0 && info.out.trim() && !/error|cannot connect/i.test(info.out) ? "ready" : "stopped";
  }

  async healthy(url = this.url()): Promise<boolean> {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json().catch(() => null)) as { status?: string } | null;
      return res.ok && body?.status === "ok";
    } catch {
      return false;
    }
  }

  async status(): Promise<LocalServerStatus> {
    const [docker, running] = await Promise.all([this.dockerState(), this.healthy()]);
    return { docker, installed: existsSync(this.envFile()), running, url: this.url(), dir: this.dir };
  }

  /** Docker Desktop installed but not running: start it and wait for the engine (up to 3 minutes). */
  private async startDockerDesktop(progress: (line: string) => void): Promise<boolean> {
    if (this.platform === "darwin" && existsSync("/Applications/Docker.app")) {
      spawn("open", ["-a", "Docker"], { detached: true, stdio: "ignore" }).unref();
    } else if (this.platform === "win32") {
      const exe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
      if (!existsSync(exe)) return false;
      spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      return false;
    }
    progress("正在启动 Docker Desktop…");
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if ((await this.dockerState()) === "ready") return true;
    }
    return false;
  }

  /** compose / Caddyfile from this app version; .env only the first time. */
  private writeFiles(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const name of BUNDLED_FILES) {
      writeFileSync(join(this.dir, name), readFileSync(join(this.bundleDir, name)));
    }
    if (!existsSync(this.envFile())) {
      const env = buildPersonalEnv(readFileSync(join(this.bundleDir, "env.example"), "utf8"), readFileSync(join(this.bundleDir, "personal.env"), "utf8"));
      writeFileSync(this.envFile(), env, { mode: 0o600 });
      try {
        chmodSync(this.envFile(), 0o600);
      } catch {}
    }
  }

  private async prepareComposeEnv(): Promise<NodeJS.ProcessEnv> {
    const docker = this.docker ?? "docker";
    const base: NodeJS.ProcessEnv = { ...process.env, PATH: dockerPath(docker, this.platform) };
    let host = process.env.DOCKER_HOST?.trim();
    if (!host) {
      const r = await this.run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], 10_000);
      if (r.code === 0) host = r.out.trim().split(/\r?\n/)[0]?.trim();
    }
    // Can't tell where the engine is: keep the user's own config rather than lose the connection
    if (!host || !/^(unix|npipe|tcp|ssh):\/\//.test(host)) return base;
    const cfg = join(this.dir, "docker-config");
    mkdirSync(cfg, { recursive: true, mode: 0o700 });
    writeFileSync(join(cfg, "config.json"), isolatedDockerConfig(this.platform));
    const env: NodeJS.ProcessEnv = { ...base, DOCKER_CONFIG: cfg, DOCKER_HOST: host };
    delete env.DOCKER_CONTEXT;
    return env;
  }

  /** One `docker compose` command in the install folder, its output line by line to `progress`. */
  private compose(args: string[], progress: (line: string) => void, timeoutMs: number): Promise<{ code: number; tail: string }> {
    const docker = this.docker ?? "docker";
    return new Promise((done) => {
      const child = spawn(docker, ["compose", "--ansi", "never", "-p", LOCAL_PROJECT, "--project-directory", this.dir, "-f", join(this.dir, "docker-compose.yml"), ...args], {
        cwd: this.dir,
        windowsHide: true,
        env: this.composeEnv ?? { ...process.env, PATH: dockerPath(docker, this.platform) },
      });
      const tail: string[] = [];
      let last = 0;
      const onData = (buf: Buffer) => {
        for (const raw of stripAnsi(buf.toString()).split(/[\r\n]+/)) {
          const line = raw.trim();
          if (!line) continue;
          tail.push(line);
          if (tail.length > 30) tail.shift();
          // Pull progress repeats many times a second: pass a line on at most ~5 times a second
          const now = Date.now();
          if (now - last > 200 || /error|failed|denied/i.test(line)) {
            last = now;
            progress(line);
          }
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        done({ code: 1, tail: String(e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? 1, tail: tail.slice(-8).join("\n") });
      });
    });
  }

  /** Set up (first time) or update, start, and wait until it answers. One at a time. */
  start(progress: (line: string) => void = () => {}): Promise<{ ok: boolean; url?: string; error?: string; code?: string }> {
    if (!this.starting) {
      this.starting = this.doStart(progress).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async doStart(progress: (line: string) => void) {
    let docker = await this.dockerState();
    if (docker === "missing") return { ok: false, code: "no-docker", error: "这台电脑没有装 Docker" };
    if (docker === "stopped" && !(await this.startDockerDesktop(progress))) {
      return { ok: false, code: "docker-stopped", error: "Docker 没有在运行：先打开 Docker Desktop（Linux 上 sudo systemctl start docker），再试一次" };
    }
    docker = "ready";
    this.writeFiles();
    this.composeEnv = await this.prepareComposeEnv();
    progress("下载最新的镜像（第一次约 1.5 GB）…");
    const pull = await this.compose(["pull", "--ignore-pull-failures"], progress, 40 * 60_000);
    if (pull.code !== 0) progress("部分镜像没下载成功，先用已有的启动");
    progress("启动服务…");
    const up = await this.compose(["up", "-d", "--remove-orphans"], progress, 10 * 60_000);
    if (up.code !== 0) return { ok: false, code: "compose-failed", error: `启动失败：\n${up.tail}` };
    const url = this.url();
    progress("等服务就绪（第一次启动要建库，约一两分钟）…");
    for (let i = 0; i < 150; i++) {
      if (await this.healthy(url)) {
        progress("服务已就绪");
        return { ok: true, url };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, code: "not-healthy", error: `服务启动了但 5 分钟内没有响应，可在 ${this.dir} 里运行 docker compose -p ${LOCAL_PROJECT} logs api 查看原因` };
  }

  async stop(): Promise<{ ok: boolean; error?: string }> {
    if ((await this.dockerState()) !== "ready") return { ok: true };
    this.composeEnv ??= await this.prepareComposeEnv();
    const r = await this.compose(["stop"], () => {}, 120_000);
    return r.code === 0 ? { ok: true } : { ok: false, error: r.tail };
  }
}
