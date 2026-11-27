// One bundled file, dependencies included (no node_modules in the image): dist/main.mjs.
import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  outfile: new URL("../dist/main.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // ioredis/postgres use require() in places: give the ESM bundle one
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
