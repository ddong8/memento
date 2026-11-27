import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildPersonalEnv, dockerCandidates, dockerPath, isolatedDockerConfig, localServerUrl, parseEnv, pluginDirs } from "../src/local-server";

const enterprise = join(__dirname, "../../../deploy/enterprise");
const example = readFileSync(join(enterprise, ".env.example"), "utf8");
const personal = readFileSync(join(enterprise, "personal.env"), "utf8");

describe("单机模式 .env", () => {
  const env = parseEnv(buildPersonalEnv(example, personal, (n) => "x".repeat(n * 2)));

  it("listens on this computer only, over HTTP, on the multi-arch images", () => {
    expect(env.get("MEMENTO_HTTP_PORT")).toBe("127.0.0.1:8770");
    expect(env.get("MEMENTO_HTTPS_PORT")).toMatch(/^127\.0\.0\.1:/);
    expect(env.get("MEMENTO_SITE")).toBe(":80");
    expect(env.get("MEMENTO_TLS")).toBe("");
    expect(env.get("MEMENTO_SERVER_TAG")).toBe("stable");
    expect(env.get("MEMENTO_WEB_TAG")).toBe("stable");
    expect(localServerUrl(buildPersonalEnv(example, personal))).toBe("http://localhost:8770");
  });

  it("only the first account can register, and no outside model service is set", () => {
    expect(env.get("MEMENTO_REGISTRATION_MODE")).toBe("closed");
    expect(env.get("MEMENTO_AI_FALLBACK_BASE_URL")).toBe("");
    expect(env.get("MEMENTO_AI_FALLBACK_API_KEY")).toBe("");
  });

  it("every secret is generated, none left empty or at a known default", () => {
    for (const key of ["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD", "MEMENTO_SECRET_KEY", "MEMENTO_COLLECTOR_TOKEN", "MEMENTO_DATA_KEY"]) {
      expect(env.get(key)?.length).toBeGreaterThanOrEqual(48);
    }
    const a = parseEnv(buildPersonalEnv(example, personal));
    const b = parseEnv(buildPersonalEnv(example, personal));
    expect(a.get("MEMENTO_SECRET_KEY")).not.toBe(b.get("MEMENTO_SECRET_KEY"));
  });

  it("the CORS regex keeps its backslashes", () => {
    expect(env.get("MEMENTO_CORS_ALLOW_ORIGIN_REGEX")).toBe("^http://(localhost|127\\.0\\.0\\.1)(:\\d+)?$");
  });

  it.skipIf(process.platform === "win32")("memento.sh init --personal writes the same settings (the command-line install)", () => {
    const dir = mkdtempSync(join(tmpdir(), "memento-personal-"));
    try {
      for (const f of ["memento.sh", "personal.env", ".env.example"]) cpSync(join(enterprise, f), join(dir, f));
      execFileSync("bash", ["memento.sh", "init", "--personal"], { cwd: dir, stdio: "pipe" });
      const sh = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
      for (const [key, value] of parseEnv(personal)) expect(sh.get(key), key).toBe(value);
      expect(sh.get("MEMENTO_SECRET_KEY")?.length).toBeGreaterThanOrEqual(48);
      expect(statSync(join(dir, ".env")).mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("finding docker", () => {
  it("looks where Docker Desktop puts it, not only on PATH (apps opened from the Dock don't get the shell's)", () => {
    expect(dockerCandidates("darwin")).toContain("/Applications/Docker.app/Contents/Resources/bin/docker");
    expect(dockerCandidates("win32")).toContain("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe");
    expect(dockerPath("/Applications/Docker.app/Contents/Resources/bin/docker", "darwin", "/usr/bin").split(":")[0]).toBe("/Applications/Docker.app/Contents/Resources/bin");
  });
});

describe("the docker config the personal stack runs with", () => {
  it("has no credential store (public images; Docker Desktop's helper can hang on the keychain) and keeps the plugin folders", () => {
    const cfg = JSON.parse(isolatedDockerConfig("darwin", "/Users/u", undefined));
    expect(cfg.credsStore).toBeUndefined();
    expect(cfg.auths).toBeUndefined();
    expect(cfg.cliPluginsExtraDirs).toContain("/Users/u/.docker/cli-plugins");
    expect(cfg.cliPluginsExtraDirs).toContain("/Applications/Docker.app/Contents/Resources/cli-plugins");
  });
  it("a custom DOCKER_CONFIG's plugins come first", () => {
    expect(pluginDirs("linux", "/home/u", "/opt/dc")[0]).toBe("/opt/dc/cli-plugins");
    expect(pluginDirs("linux", "/home/u", undefined)).toContain("/usr/libexec/docker/cli-plugins");
  });
});
