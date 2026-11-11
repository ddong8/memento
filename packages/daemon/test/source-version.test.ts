import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sourceVersion } from "../src/ingest.js";

describe("a daemon run from source", () => {
  it("reports the client version of the repo it was built in, not node-0.1.0", () => {
    const repo = mkdtempSync(join(tmpdir(), "memento-src-"));
    mkdirSync(join(repo, "apps/desktop"), { recursive: true });
    mkdirSync(join(repo, "packages/daemon/dist"), { recursive: true });
    const self = pathToFileURL(join(repo, "packages/daemon/dist/ingest.js")).href;
    expect(sourceVersion(self)).toBeUndefined();
    writeFileSync(join(repo, "apps/desktop/package.json"), JSON.stringify({ version: "1.0.105" }));
    expect(sourceVersion(self)).toBe("1.0.105");
    writeFileSync(join(repo, "apps/desktop/package.json"), JSON.stringify({ version: "dev" }));
    expect(sourceVersion(self)).toBeUndefined();
  });
});
