// Bundles the server entry (dist/main.mjs) and standalone migration CLI (dist/migrate.mjs),
// copying db/schema.sql beside them so empty-DB bootstrap works inside Docker and desktop installers.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rel = (p) => fileURLToPath(new URL(p, import.meta.url));

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["@node-rs/jieba", "@node-rs/jieba/*", "@node-rs/jieba-*"],
  // ioredis/postgres/jieba use require() in places: give the ESM bundle one
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [rel("../src/main.ts")],
    outfile: rel("../dist/main.mjs"),
  }),
  build({
    ...common,
    entryPoints: [rel("../src/db/migrate-cli.ts")],
    outfile: rel("../dist/migrate.mjs"),
  }),
]);

copyFileSync(rel("../db/schema.sql"), rel("../dist/schema.sql"));
