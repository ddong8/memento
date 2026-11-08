// release-metadata.mts: notes, update from a fake dist/, and every verify rule (temp dirs, stubbed GitHub).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { parseOptions, updateMetadata, validSha256, validSha512, verifyMetadata, writeNotes } from "../release-metadata.mts";

const tmp = mkdtempSync(join(tmpdir(), "memento-release-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = join(tmp, `case-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const write = (path: string, text: string | Buffer) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const sha512 = (b: string | Buffer) => createHash("sha512").update(b).digest("base64");

/** A fake electron-builder dist/: the update packages, installers, blockmaps and channel YAML. */
function fakeDist(version: string): string {
  const dist = freshDir();
  for (const name of [
    `Memento-${version}-win-x64.exe`,
    `Memento-${version}-win-x64.zip`,
    `Memento-${version}-win-x64.zip.blockmap`,
    `Memento-${version}-mac-arm64.dmg`,
    `Memento-${version}-mac-arm64.zip`,
    `Memento-${version}-mac-arm64.zip.blockmap`,
    `Memento-${version}-linux-x86_64.AppImage`,
    `Memento-${version}-linux-x64.tar.gz`,
  ]) {
    write(join(dist, name), `${name} contents`);
  }
  write(join(dist, "latest-mac.yml"), `version: ${version}\nfiles:\n  - url: Memento-${version}-mac-arm64.zip\n    sha512: x\n`);
  write(join(dist, ".icon-set", "latest.yml"), "skipped: dot dirs");
  return dist;
}

describe("notes", () => {
  const saved = process.env.GITHUB_OUTPUT;
  afterEach(() => {
    if (saved === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = saved;
  });

  test("writes the release notes and has_notes", () => {
    const d = freshDir();
    write(join(d, "version.json"), JSON.stringify({ version: "1.0.99", release_notes: "  修复若干问题\n" }));
    process.env.GITHUB_OUTPUT = join(d, "out");
    write(process.env.GITHUB_OUTPUT, "earlier=1\n");
    assert.equal(writeNotes(join(d, "version.json"), join(d, "notes.md")), true);
    assert.equal(readFileSync(join(d, "notes.md"), "utf8"), "修复若干问题\n");
    assert.equal(readFileSync(process.env.GITHUB_OUTPUT, "utf8"), "earlier=1\nhas_notes=true\n");
  });

  test("no notes", () => {
    const d = freshDir();
    write(join(d, "version.json"), JSON.stringify({ version: "1.0.99" }));
    process.env.GITHUB_OUTPUT = join(d, "out");
    assert.equal(writeNotes(join(d, "version.json"), join(d, "notes.md")), false);
    assert.equal(readFileSync(join(d, "notes.md"), "utf8"), "");
    assert.equal(readFileSync(process.env.GITHUB_OUTPUT, "utf8"), "has_notes=false\n");
  });
});

describe("update", () => {
  test("points each platform at its update package and keeps the rest", async () => {
    const dist = fakeDist("1.0.99");
    const file = join(freshDir(), "updates", "version.json");
    write(file, JSON.stringify({ version: "1.0.98", release_notes: "说明", platforms: { freebsd: { asset_name: "keep" } } }));
    const meta = await updateMetadata("1.0.99", dist, file);
    assert.equal(meta.version, "1.0.99");
    assert.equal(meta.title, "Memento v1.0.99");
    assert.equal(meta.release_notes, "说明");
    const platforms = meta.platforms as Record<string, { asset_name: string; size: number; sha256: string; sha512: string }>;
    assert.deepEqual(Object.keys(platforms), ["freebsd", "windows", "macos", "linux"]);
    assert.equal(platforms.windows!.asset_name, "Memento-1.0.99-win-x64.zip");
    assert.equal(platforms.macos!.asset_name, "Memento-1.0.99-mac-arm64.zip");
    assert.equal(platforms.linux!.asset_name, "Memento-1.0.99-linux-x64.tar.gz");
    const body = "Memento-1.0.99-win-x64.zip contents";
    assert.deepEqual(platforms.windows, { asset_name: "Memento-1.0.99-win-x64.zip", size: body.length, sha256: sha256(body), sha512: sha512(body) });
    // written as-is (no trailing newline, like json.dump), channel YAML copied next to it, dot dirs skipped
    assert.equal(readFileSync(file, "utf8"), JSON.stringify(meta, null, 2));
    assert.equal(readFileSync(join(dirname(file), "latest-mac.yml"), "utf8"), readFileSync(join(dist, "latest-mac.yml"), "utf8"));
    assert.throws(() => readFileSync(join(dirname(file), "latest.yml")));
  });

  test("falls back to the installer when there is no zip", async () => {
    const dist = freshDir();
    write(join(dist, "Memento-1.0.99-win-x64.exe"), "exe");
    write(join(dist, "Memento-1.0.99-linux-x86_64.AppImage"), "appimage");
    const meta = await updateMetadata("1.0.99", dist, join(freshDir(), "version.json"));
    const platforms = meta.platforms as Record<string, { asset_name: string }>;
    assert.equal(platforms.windows!.asset_name, "Memento-1.0.99-win-x64.exe");
    assert.equal(platforms.linux!.asset_name, "Memento-1.0.99-linux-x86_64.AppImage");
    assert.equal(platforms.macos, undefined);
  });
});

describe("verify", () => {
  /** A release directory that passes: version.json, the packages beside it, the channel YAML. */
  async function goodRelease(): Promise<string> {
    const dist = fakeDist("1.0.99");
    const file = join(freshDir(), "version.json");
    const meta = await updateMetadata("1.0.99", dist, file);
    for (const p of Object.values(meta.platforms as Record<string, { asset_name: string }>)) {
      copyFileSync(join(dist, p.asset_name), join(dirname(file), p.asset_name));
    }
    return file;
  }
  async function check(file: string, tag?: string): Promise<{ passed: boolean; out: string }> {
    const lines: string[] = [];
    const passed = await verifyMetadata(file, tag, (l) => lines.push(l));
    return { passed, out: lines.join("\n") };
  }
  const edit = (file: string, fn: (meta: Record<string, any>) => void) => {
    const meta = JSON.parse(readFileSync(file, "utf8"));
    fn(meta);
    writeFileSync(file, JSON.stringify(meta, null, 2));
  };

  test("a good release passes, checking the local files and the YAML", async () => {
    const { passed, out } = await check(await goodRelease());
    assert.ok(passed, out);
    assert.match(out, /\[\+\] Verified local file Memento-1\.0\.99-win-x64\.zip: \d+ bytes, sha256 OK/);
    assert.match(out, /\[\+\] Verified channel YAML latest-mac\.yml: version 1\.0\.99 matches\./);
    assert.match(out, /\[✓\] All release metadata passed/);
  });

  test("the file itself: missing, not JSON, no version, no platforms", async () => {
    const d = freshDir();
    assert.match((await check(join(d, "none.json"))).out, /does not exist/);
    write(join(d, "bad.json"), "{");
    assert.match((await check(join(d, "bad.json"))).out, /Invalid JSON/);
    write(join(d, "nover.json"), JSON.stringify({ platforms: { macos: {} } }));
    assert.match((await check(join(d, "nover.json"))).out, /Missing 'version'/);
    write(join(d, "noplat.json"), JSON.stringify({ version: "1", platforms: {} }));
    assert.match((await check(join(d, "noplat.json"))).out, /'platforms' dictionary is missing or empty/);
  });

  test("format, size and hash rules", async () => {
    const file = join(freshDir(), "version.json");
    write(
      file,
      JSON.stringify({
        version: "1.0.99",
        platforms: {
          windows: { asset_name: "Memento-setup.exe", size: 10, sha256: "a".repeat(64) },
          macos: { asset_name: "Memento.dmg", size: 0, sha256: "zz" },
          linux: { asset_name: "Memento.AppImage", size: 1.5, sha256: "b".repeat(64), sha512: "not-base64" },
          other: "x",
        },
      }),
    );
    const { passed, out } = await check(file);
    assert.ok(!passed);
    assert.match(out, /Windows auto-update package MUST be a \.zip file \(found: 'Memento-setup\.exe'\)/);
    assert.match(out, /macOS auto-update package MUST be a \.zip file/);
    assert.match(out, /Linux auto-update package must end with one of/);
    assert.match(out, /Platform 'macos': size must be a positive integer \(found: 0\)/);
    assert.match(out, /Platform 'linux': size must be a positive integer \(found: 1\.5\)/);
    assert.match(out, /Platform 'macos': invalid or missing 64-char sha256 hash \(found: 'zz'\)/);
    assert.match(out, /Platform 'linux': invalid base64 sha512 hash/);
    assert.match(out, /Platform 'other' config must be an object/);
  });

  test("local file size / sha256 mismatch", async () => {
    const file = await goodRelease();
    edit(file, (m) => {
      m.platforms.windows.size += 1;
      m.platforms.macos.sha256 = "0".repeat(64);
    });
    const { passed, out } = await check(file);
    assert.ok(!passed);
    assert.match(out, /Platform 'windows': size mismatch for local file/);
    assert.match(out, /Platform 'macos': sha256 mismatch for local file/);
  });

  test("channel YAML: other version, no checksum", async () => {
    const file = await goodRelease();
    write(join(dirname(file), "latest-mac.yml"), "version: v1.0.98\nsha512: x\n");
    write(join(dirname(file), "latest.yml"), "version: 1.0.99\npath: x.zip\n");
    const { passed, out } = await check(file);
    assert.ok(!passed);
    assert.match(out, /Channel YAML 'latest-mac\.yml' version mismatch: declares 1\.0\.98, version\.json declares 1\.0\.99/);
    assert.match(out, /Channel YAML 'latest\.yml' is missing sha512 \/ sha2 checksum fields!/);
  });

  test("GitHub release assets (stubbed API)", async (t) => {
    const file = await goodRelease();
    const meta = JSON.parse(readFileSync(file, "utf8"));
    const requested: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      requested.push(url);
      return Response.json({
        assets: [
          { name: meta.platforms.windows.asset_name, size: meta.platforms.windows.size },
          { name: meta.platforms.macos.asset_name, size: 1 },
        ],
      });
    });
    const { passed, out } = await check(file, "v1.0.99");
    assert.ok(!passed);
    assert.equal(requested[0], "https://api.github.com/repos/ddong8/memento/releases/tags/v1.0.99");
    assert.match(out, /\[\+\] Verified GitHub Release asset Memento-1\.0\.99-win-x64\.zip/);
    assert.match(out, /Asset 'Memento-1\.0\.99-mac-arm64\.zip' size mismatch with GitHub Release!/);
    assert.match(out, /GitHub Release v1\.0\.99 missing asset 'Memento-1\.0\.99-linux-x64\.tar\.gz'/);
  });

  test("an unreachable GitHub only warns", async (t) => {
    const file = await goodRelease();
    t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }));
    const { passed, out } = await check(file, "v1.0.99");
    assert.ok(passed, out);
    assert.match(out, /\[-\] Warning: Failed to fetch GitHub release v1\.0\.99: HTTP Error 503: Service Unavailable/);
  });
});

describe("helpers", () => {
  test("hash formats", () => {
    assert.ok(validSha256("A".repeat(64)));
    assert.ok(!validSha256("g".repeat(64)));
    assert.ok(validSha512(sha512("x")));
    assert.ok(!validSha512(`${sha512("x").slice(0, -2)}=`));
    assert.ok(!validSha512(sha512("x").replace(/.$/, "A")));
  });

  test("parseOptions", () => {
    assert.deepEqual(parseOptions(["--tag", "v1", "--file=x.json"], ["tag", "file"]), { tag: "v1", file: "x.json" });
    assert.throws(() => parseOptions(["--nope", "1"], ["tag"]), /unrecognized argument: --nope/);
    assert.throws(() => parseOptions(["--tag"], ["tag"]), /expected one argument/);
    assert.throws(() => parseOptions(["stray"], ["tag"]), /unrecognized argument: stray/);
  });
});
