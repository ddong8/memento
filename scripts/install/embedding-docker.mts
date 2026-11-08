// Docker-based install path for the BGE-M3 embedding server (the default).
//
// It removes the three flakiest steps of the host venv install:
//   1. Host Python + pip resolution of torch, sentence-transformers, modelscope, fastapi and uvicorn
//      (the image pins them once at build time).
//   2. A 1.3 GB model download mid-install with no clean retry (the Dockerfile bakes the model in and
//      tries 3 mirrors during build).
//   3. Service manager registration (launchd / systemd / Task Scheduler): `restart: unless-stopped`
//      replaces it.
//
// The `embedding` compose profile keeps the service off unless the user opts in.
import { setEnvValue } from "./env-file.mts";
import { REPO_ROOT, dockerAvailable, dockerStartHint, info, ok, run, warn } from "./platform.mts";

const compose = (...extra: string[]) => ["compose", "--profile", "embedding", ...extra];

/** Builds and starts the embedding container. First build takes 5–15 min, later runs start in seconds. */
export async function install(): Promise<void> {
  if (!dockerAvailable()) throw new Error(`Docker is not running. ${dockerStartHint()}`);

  info("Building embedding image (first time: 5–15 min for torch + model)…");
  run("docker", compose("build", "embedding"), { check: true, cwd: REPO_ROOT });
  ok("Embedding image built.");

  info("Starting embedding container…");
  run("docker", compose("up", "-d", "embedding"), { check: true, cwd: REPO_ROOT });

  // The api / celery containers keep the MEMENTO_EMBEDDING_SERVER_URL they started with, possibly the
  // old host.docker.internal:8002 default that nothing answers on Linux Docker. Recreate them so they
  // pick up http://embedding:8002 and the new network alias; a value left in .env by an earlier
  // `--native` install would still win over the compose default, so write this path's address.
  await setEnvValue("MEMENTO_EMBEDDING_SERVER_URL", "http://embedding:8002");
  info("Recreating api + celery containers so they discover the embedding service…");
  run("docker", ["compose", "up", "-d", "--no-deps", "--force-recreate", "api", "celery-worker", "celery-beat"], {
    check: true,
    cwd: REPO_ROOT,
  });

  await waitHealthy(300);
  ok("Embedding server is ready.");
}

/** Stops the embedding container; with removeImage also deletes the image and its model layer (~3 GB). */
export function uninstall(removeImage = false): void {
  if (!dockerAvailable()) {
    warn("Docker not running — nothing to stop.");
    return;
  }
  run("docker", compose("rm", "-sf", "embedding"), { cwd: REPO_ROOT });
  if (removeImage) run("docker", ["image", "rm", "memento-embedding"]);
  ok("Embedding container removed.");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls the container's healthcheck: the default compose config doesn't publish 8002 to the host. */
async function waitHealthy(timeoutS: number): Promise<void> {
  info(`Waiting for embedding to report healthy (up to ${timeoutS}s)…`);
  const deadline = performance.now() + timeoutS * 1000;
  let last = "";
  while (performance.now() < deadline) {
    const status = run("docker", ["inspect", "-f", "{{.State.Health.Status}}", "memento_embedding"], { capture: true }).stdout.trim();
    if (status === "healthy") return;
    if (status && status !== last) {
      info(`  embedding status: ${status}`);
      last = status;
    }
    await sleep(3000);
  }
  throw new Error(`Embedding did not become healthy within ${timeoutS}s. Check \`docker compose logs embedding\`.`);
}
