import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildEmbeddedEnv, buildPgExecEnv, hasPgvectorInstalled, installBundledPgvector, locateEmbeddedPgNative, locateEmbeddedWebDir, migrateServerData } from "../src/embedded-server";
import { parseEnv } from "../src/local-server";

describe("embedded single-installer server helpers", () => {
  const tmpRoots: string[] = [];
  const mkTmp = () => {
    const d = mkdtempSync(join(tmpdir(), "memento-emb-"));
    tmpRoots.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  });

  it("builds persistent single-process standalone env without Docker or Redis", () => {
    const dir = mkTmp();
    const text = buildEmbeddedEnv({ port: 8770, pgPort: 54329, webPort: 38770, dataDir: dir, rand: (n) => "a".repeat(n * 2) });
    const env = parseEnv(text);
    expect(env.get("MEMENTO_REDIS_URL")).toBe("none");
    expect(env.get("MEMENTO_ENABLE_SCHEDULER")).toBe("true");
    expect(env.get("MEMENTO_HOST")).toBe("127.0.0.1");
    expect(env.get("MEMENTO_PORT")).toBe("8770");
    expect(env.get("MEMENTO_WEB_UPSTREAM")).toBe("http://127.0.0.1:38770");
    expect(env.get("MEMENTO_STORAGE_DIR")).toBe(join(dir, "storage"));
    expect(env.get("MEMENTO_DATABASE_URL")).toContain("127.0.0.1:54329");
    expect(env.get("MEMENTO_SECRET_KEY")?.length).toBe(64);
    expect(env.get("MEMENTO_DATA_KEY")?.length).toBe(64);

    // Preserves existing secrets on restart
    const text2 = buildEmbeddedEnv({ port: 8770, pgPort: 54329, webPort: 38770, dataDir: dir, existing: env, rand: (n) => "b".repeat(n * 2) });
    const env2 = parseEnv(text2);
    expect(env2.get("MEMENTO_SECRET_KEY")).toBe(env.get("MEMENTO_SECRET_KEY"));
    expect(env2.get("POSTGRES_PASSWORD")).toBe(env.get("POSTGRES_PASSWORD"));
  });

  it("locates embedded postgres native tree, web standalone dir, and prebuilt pgvector files", () => {
    const bundle = mkTmp();
    const pgBin = join(bundle, "embedded-pg", "native", "bin");
    const pgLib = join(bundle, "embedded-pg", "native", "lib", "postgresql");
    const pgExt = join(bundle, "embedded-pg", "native", "share", "postgresql", "extension");
    const webEntryDir = join(bundle, "web", "apps", "web");
    mkdirSync(pgBin, { recursive: true });
    mkdirSync(pgLib, { recursive: true });
    mkdirSync(pgExt, { recursive: true });
    mkdirSync(webEntryDir, { recursive: true });
    writeFileSync(join(pgBin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl"), "");
    writeFileSync(join(webEntryDir, "server.js"), "");

    const found = locateEmbeddedPgNative(bundle);
    expect(found).toBe(join(bundle, "embedded-pg", "native"));
    expect(locateEmbeddedWebDir(bundle)).toBe(join(bundle, "web"));
    expect(hasPgvectorInstalled(found!)).toBe(false);

    mkdirSync(join(bundle, "pgvector", "lib"), { recursive: true });
    mkdirSync(join(bundle, "pgvector", "extension"), { recursive: true });
    writeFileSync(join(bundle, "pgvector", "lib", "vector.so"), "bin");
    writeFileSync(join(bundle, "pgvector", "extension", "vector.control"), "ctrl");

    expect(installBundledPgvector(bundle, found!)).toBe(true);
    expect(hasPgvectorInstalled(found!)).toBe(true);
    expect(existsSync(join(pgLib, "vector.so"))).toBe(true);
    expect(existsSync(join(pgExt, "vector.control"))).toBe(true);
  });

  it("all embedded packaging scripts pass verbatimSymlinks: true whenever dereference: false is used", () => {
    const scripts = [
      join(__dirname, "..", "scripts", "build.mjs"),
      join(__dirname, "..", "..", "..", "packages", "server", "embedded", "stage-embedded.mjs"),
      join(__dirname, "..", "..", "..", "packages", "server", "scripts", "pack-standalone.mjs"),
    ];
    for (const file of scripts) {
      const src = readFileSync(file, "utf8");
      const lines = src.split(/\r?\n/).filter((l) => l.includes("dereference: false"));
      expect(lines.length, `${file} should preserve symlinks`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `${file} must set verbatimSymlinks: true to avoid absolute build-runner symlinks`).toContain("verbatimSymlinks: true");
      }
    }
    // Linux @embedded-postgres packages rely on postinstall + pg-symlinks.json to create libicuuc.so.60 etc.
    const stageSrc = readFileSync(join(__dirname, "..", "..", "..", "packages", "server", "embedded", "stage-embedded.mjs"), "utf8");
    expect(stageSrc).not.toContain('"--ignore-scripts"');
    expect(stageSrc).toContain("pg-symlinks.json");
  });

  it("builds Windows PG exec env with LC_MESSAGES=C and case-safe COMSPEC shim when cmd-noautorun.exe is present", () => {
    const nativeDir = mkTmp();
    mkdirSync(join(nativeDir, "bin"), { recursive: true });
    const shimPath = join(nativeDir, "bin", "cmd-noautorun.exe");
    writeFileSync(shimPath, "shim");

    const winEnv = buildPgExecEnv(nativeDir, { ComSpec: "C:\\Windows\\System32\\cmd.exe", COMSPEC: "C:\\legacy\\cmd.exe", PATH: "x" }, "win32");
    expect(winEnv.LC_MESSAGES).toBe("C");
    expect(winEnv.ComSpec).toBe(shimPath);
    expect(winEnv.COMSPEC).toBeUndefined();
    expect(Object.keys(winEnv).filter((k) => k.toLowerCase() === "comspec")).toEqual(["ComSpec"]);

    const macEnv = buildPgExecEnv(nativeDir, { PATH: "/usr/bin" }, "darwin");
    expect(macEnv.LC_MESSAGES).toBe("C");
    expect(macEnv.ComSpec).toBeUndefined();
  });

  it("migrates account data between two servers while keeping a local backup ZIP", async () => {
    const fakeZip = Buffer.from("PK\x03\x04fake-export-payload");
    let importedSize = 0;
    let sawFullParam = false;

    const src = createServer((req, res) => {
      if (req.url?.startsWith("/api/data/export")) {
        sawFullParam = req.url.includes("include_full=1");
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(fakeZip);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const dst = createServer((req, res) => {
      if (req.url === "/api/data/import" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
          importedSize = Buffer.concat(chunks).byteLength;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, counts: { documents: 12, user_memories: 5 }, warnings: [] }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((r) => src.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => dst.listen(0, "127.0.0.1", () => r()));
    try {
      const srcPort = (src.address() as { port: number }).port;
      const dstPort = (dst.address() as { port: number }).port;
      const backupDir = mkTmp();
      const res = await migrateServerData({
        fromUrl: `http://127.0.0.1:${srcPort}`,
        fromToken: "tok-src",
        toUrl: `http://127.0.0.1:${dstPort}`,
        toToken: "tok-dst",
        backupDir,
      });
      expect(res.ok).toBe(true);
      expect(sawFullParam).toBe(true);
      expect(importedSize).toBeGreaterThan(fakeZip.byteLength);
      expect(res.counts?.documents).toBe(12);
      expect(res.counts?.user_memories).toBe(5);
      expect(res.backupPath && existsSync(res.backupPath)).toBe(true);
      expect(readFileSync(res.backupPath!).equals(fakeZip)).toBe(true);
    } finally {
      src.close();
      dst.close();
    }
  });
});
