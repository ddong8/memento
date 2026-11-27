// Load the built pgvector into embedded Postgres 16 and check what memento needs from it:
//   node verify.mjs <out/<platform> dir>      (run where `embedded-postgres` is installed)
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const built = process.argv[2];
if (!built || !existsSync(join(built, "lib"))) {
  console.error("usage: node verify.mjs <out/<platform>>");
  process.exit(2);
}
const require = createRequire(join(process.cwd(), "package.json"));
// A file:// URL: Windows absolute paths (D:\\...) aren't valid import specifiers
const { default: EmbeddedPostgres } = await import(pathToFileURL(require.resolve("embedded-postgres")).href);
const platPkg = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
// The platform package exports no package.json: find it next to embedded-postgres in node_modules
const nodeModules = require.resolve("embedded-postgres").split(/[\\/]node_modules[\\/]/)[0] + "/node_modules";
const native = join(nodeModules, platPkg, "native");
const pkglib = existsSync(join(native, "lib", "postgresql")) ? join(native, "lib", "postgresql") : join(native, "lib");
// share/postgresql/extension on macOS and Linux, share/extension in the Windows layout
const extDir = existsSync(join(native, "share", "postgresql", "extension")) ? join(native, "share", "postgresql", "extension") : join(native, "share", "extension");
for (const f of readdirSync(join(built, "lib"))) cpSync(join(built, "lib", f), join(pkglib, f));
for (const f of readdirSync(join(built, "extension"))) cpSync(join(built, "extension", f), join(extDir, f));
console.log("installed into", native);

const dir = mkdtempSync(join(tmpdir(), "pgv-"));
const pg = new EmbeddedPostgres({
  databaseDir: join(dir, "data"),
  user: "postgres",
  password: "pw",
  port: 54329,
  persistent: false,
  // SQL_ASCII (the default) keeps Chinese out of the full-text index
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});
let failed = false;
const expect = (name, ok, got) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)})`}`);
  if (!ok) failed = true;
};
await pg.initialise();
// Windows refuses to run postgres under an administrator account (and many users are one): pg_ctl starts it
// with a restricted token instead. The single installer has to start it the same way (P7).
const pgCtl = join(native, "bin", process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
const viaPgCtl = process.platform === "win32" || process.env.VIA_PG_CTL === "1";
if (viaPgCtl) {
  const { execFileSync } = await import("node:child_process");
  execFileSync(pgCtl, ["-D", join(dir, "data"), "-o", "-p 54329", "-w", "-l", join(dir, "pg.log"), "start"], { stdio: "inherit" });
} else {
  await pg.start();
}
const { default: pgLib } = await import(pathToFileURL(require.resolve("pg")).href);
const c = new pgLib.Client({ host: "localhost", port: 54329, user: "postgres", password: "pw", database: "postgres" });
await c.connect();
try {
  const q = async (s) => (await c.query(s)).rows;
  console.log((await q("select version()"))[0].version);
  await q("create extension vector");
  const [{ extversion }] = await q("select extversion from pg_extension where extname = 'vector'");
  expect("vector extension loads", !!extversion, extversion);
  await q("create table d (id serial primary key, emb vector(3), half halfvec(3), tsv tsvector, meta jsonb)");
  await q("create index on d using hnsw (emb vector_cosine_ops)");
  await q("create index on d using hnsw (half halfvec_cosine_ops)");
  await q("create index on d using gin (tsv)");
  await q(`insert into d (emb, half, tsv, meta) values
    ('[1,0,0]', '[1,0,0]', to_tsvector('simple', '单机 模式 安装包'), '{"a":1}'),
    ('[0,1,0]', '[0,1,0]', to_tsvector('simple', '服务端 迁移'), '{"a":2}')`);
  await q("set enable_seqscan = off");
  const [near] = await q("select id from d order by emb <=> '[0.9,0.1,0]' limit 1");
  expect("nearest by cosine (HNSW)", near?.id === 1, near);
  const [nearHalf] = await q("select id from d order by half <=> '[0.1,0.9,0]'::halfvec limit 1");
  expect("halfvec HNSW", nearHalf?.id === 2, nearHalf);
  const zh = await q("select id from d where tsv @@ to_tsquery('simple', '迁移') and meta->>'a' = '2'");
  expect("Chinese full-text + jsonb", zh.length === 1 && zh[0].id === 2, zh);
} finally {
  await c.end();
  if (viaPgCtl) {
    const { execFileSync } = await import("node:child_process");
    execFileSync(pgCtl, ["-D", join(dir, "data"), "-m", "fast", "-w", "stop"], { stdio: "inherit" });
  } else {
    await pg.stop();
  }
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
