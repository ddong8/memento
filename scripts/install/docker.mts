// Bring up the Docker Compose stack, verify health.
import { REPO_ROOT, dockerAvailable, dockerStartHint, info, ok, portInUse, run } from "./platform.mts";

// host_port → container_service (for error messages)
export const CHECK_PORTS: Record<number, string> = {
  8001: "api",
  5433: "postgres",
  6380: "redis",
  9000: "minio",
  9001: "minio-console",
  3001: "web",
};

/** Docker daemon + port availability; throws on hard failures. */
export async function preflight(): Promise<void> {
  if (!dockerAvailable()) throw new Error(`Docker is not running. ${dockerStartHint()}`);
  ok("Docker daemon reachable.");
  // Informational only: if our containers are already up the ports answer, and `docker compose up -d`
  // reuses them. The list helps debug a port taken by something else.
  const ports = Object.keys(CHECK_PORTS).map(Number);
  const busy = (await Promise.all(ports.map(async (p) => ((await portInUse(p)) ? p : 0)))).filter(Boolean);
  if (busy.length) info(`Ports in use (expected if stack is already running): ${busy.join(", ")}`);
}

export function composeUp(services: string[] = [], build = true): void {
  const args = ["compose", "up", "-d", ...(build ? ["--build"] : []), ...services];
  info(`Starting containers: docker ${args.join(" ")}`);
  run("docker", args, { check: true, cwd: REPO_ROOT });
}

/** Whether the compose service has a running container. */
export function serviceRunning(service: string): boolean {
  if (!dockerAvailable()) return false;
  const r = run("docker", ["compose", "ps", "-q", "--status", "running", service], { capture: true, cwd: REPO_ROOT });
  return r.status === 0 && !!r.stdout.trim();
}

/** Recreates containers so they pick up a changed .env. */
export function recreate(...services: string[]): void {
  run("docker", ["compose", "up", "-d", "--no-deps", "--force-recreate", ...services], { check: true, cwd: REPO_ROOT });
}

export async function httpOk(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    await r.body?.cancel();
    return r.status >= 200 && r.status < 400;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForApi(timeoutS = 120): Promise<void> {
  info(`Waiting for API to become healthy (up to ${timeoutS}s)…`);
  const deadline = performance.now() + timeoutS * 1000;
  while (performance.now() < deadline) {
    if (await httpOk("http://localhost:8001/health")) {
      ok("API is healthy (http://localhost:8001/health → 200).");
      return;
    }
    await sleep(2000);
  }
  throw new Error(`API did not become healthy within ${timeoutS}s. Check \`docker compose logs api\`.`);
}

export function composeDown(purge = false): void {
  const args = ["compose", "down", ...(purge ? ["-v"] : [])];
  info(`docker ${args.join(" ")}`);
  run("docker", args, { cwd: REPO_ROOT });
}

export type DoctorRow = [name: string, up: boolean, hint: string];

/** (service, up, hint) for status printing. */
export async function doctor(): Promise<DoctorRow[]> {
  return [
    ["docker daemon", dockerAvailable(), dockerStartHint()],
    ["api:8001", await httpOk("http://localhost:8001/health"), "docker compose logs api"],
    ["web:3001", await portInUse(3001), "docker compose logs web"],
    ["postgres:5433", await portInUse(5433), "docker compose logs postgres"],
    ["redis:6380", await portInUse(6380), "docker compose logs redis"],
    ["embedding:8002", await httpOk("http://localhost:8002/health"), "./install.sh embedding to install"],
  ];
}

export function printDoctor(rows: DoctorRow[]): void {
  console.log();
  console.log("  Service             Status");
  console.log("  ─────────────────── ──────");
  for (const [name, up, hint] of rows) {
    console.log(`  ${name.padEnd(19)} ${up ? "✓ up  " : "✗ down"}  ${up ? "" : hint}`);
  }
  console.log();
}
