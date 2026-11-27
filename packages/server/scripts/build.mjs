// One bundled file, dependencies included (native @node-rs/jieba stays external): dist/main.mjs.
import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  outfile: new URL("../dist/main.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["@node-rs/jieba", "@node-rs/jieba/*", "@node-rs/jieba-*"],
  // ioredis/postgres/jieba use require() in places: give the ESM bundle one
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
