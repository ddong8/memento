// Bundles the server entry (dist/main.mjs) and standalone migration CLI (dist/migrate.mjs),
// copying db/schema.sql beside them so empty-DB bootstrap works inside Docker and desktop installers.
import { copyFileSync } from "node:fs";
import { build } from "esbuild";

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
    entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
    outfile: new URL("../dist/main.mjs", import.meta.url).pathname,
  }),
  build({
    ...common,
    entryPoints: [new URL("../src/db/migrate-cli.ts", import.meta.url).pathname],
    outfile: new URL("../dist/migrate.mjs", import.meta.url).pathname,
  }),
]);

copyFileSync(
  new URL("../db/schema.sql", import.meta.url).pathname,
  new URL("../dist/schema.sql", import.meta.url).pathname,
);
