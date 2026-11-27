import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildEmbeddedEnv, installBundledPgvector, locateEmbeddedPgNative, migrateServerData } from "../src/embedded-server";
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
    const text = buildEmbeddedEnv({ port: 8770, pgPort: 54329, dataDir: dir, rand: (n) => "a".repeat(n * 2) });
    const env = parseEnv(text);
    expect(env.get("MEMENTO_REDIS_URL")).toBe("");
    expect(env.get("MEMENTO_ENABLE_SCHEDULER")).toBe("true");
    expect(env.get("MEMENTO_HOST")).toBe("127.0.0.1");
    expect(env.get("MEMENTO_PORT")).toBe("8770");
    expect(env.get("MEMENTO_STORAGE_DIR")).toBe(join(dir, "storage"));
    expect(env.get("MEMENTO_DATABASE_URL")).toContain("127.0.0.1:54329");
    expect(env.get("MEMENTO_SECRET_KEY")?.length).toBe(64);
    expect(env.get("MEMENTO_DATA_KEY")?.length).toBe(64);

    // Preserves existing secrets on restart
    const text2 = buildEmbeddedEnv({ port: 8770, pgPort: 54329, dataDir: dir, existing: env, rand: (n) => "b".repeat(n * 2) });
    const env2 = parseEnv(text2);
    expect(env2.get("MEMENTO_SECRET_KEY")).toBe(env.get("MEMENTO_SECRET_KEY"));
    expect(env2.get("POSTGRES_PASSWORD")).toBe(env.get("POSTGRES_PASSWORD"));
  });

  it("locates embedded postgres native tree and copies prebuilt pgvector files", () => {
    const bundle = mkTmp();
    const pgBin = join(bundle, "embedded-pg", "native", "bin");
    const pgLib = join(bundle, "embedded-pg", "native", "lib", "postgresql");
    const pgExt = join(bundle, "embedded-pg", "native", "share", "postgresql", "extension");
    mkdirSync(pgBin, { recursive: true });
    mkdirSync(pgLib, { recursive: true });
    mkdirSync(pgExt, { recursive: true });
    writeFileSync(join(pgBin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl"), "");

    const found = locateEmbeddedPgNative(bundle);
    expect(found).toBe(join(bundle, "embedded-pg", "native"));

    mkdirSync(join(bundle, "pgvector", "lib"), { recursive: true });
    mkdirSync(join(bundle, "pgvector", "extension"), { recursive: true });
    writeFileSync(join(bundle, "pgvector", "lib", "vector.so"), "bin");
    writeFileSync(join(bundle, "pgvector", "extension", "vector.control"), "ctrl");

    expect(installBundledPgvector(bundle, found!)).toBe(true);
    expect(existsSync(join(pgLib, "vector.so"))).toBe(true);
    expect(existsSync(join(pgExt, "vector.control"))).toBe(true);
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
