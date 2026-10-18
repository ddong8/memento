// Fails when a web page's path is one the proxies send to the API instead
// (deploy/k8s/ingress.yaml and the nginx proxy in deploy/setup-aliyun-proxy.sh):
// such a page can never be reached — /health once showed the API's
// {"status":"ok"} instead of the health page.
//   node scripts/check-web-routes.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Path prefixes the proxies route to the API service. */
function apiPaths() {
  const paths = new Set();
  const ingress = readFileSync(join(root, "deploy/k8s/ingress.yaml"), "utf8");
  for (const m of ingress.matchAll(/- path: (\S+)\s+pathType: \w+\s+backend: \{ service: \{ name: api\b/g)) paths.add(m[1]);
  const nginx = readFileSync(join(root, "deploy/setup-aliyun-proxy.sh"), "utf8");
  for (const m of nginx.matchAll(/location\s+(?:\^~\s+|=\s+)?(\/[^\s{]*)\s*\{[^}]*API_PORT/g)) paths.add(m[1]);
  paths.delete("/");
  return [...paths];
}

/** First path segment of every page under apps/web/src/app (route groups and dynamic segments skipped). */
function webRoutes(dir = join(root, "apps/web/src/app")) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^[(_[@]/.test(e.name))
    .map((e) => `/${e.name}`);
}

const api = apiPaths();
const clashes = webRoutes().filter((route) => api.some((p) => route === p || route.startsWith(`${p}/`) || p.startsWith(`${route}/`)));
if (clashes.length) {
  console.error(`These web pages are shadowed by API routes in the proxies: ${clashes.join(", ")}`);
  console.error(`API paths: ${api.join(", ")}`);
  process.exit(1);
}
console.log(`web routes OK (API paths: ${api.join(", ")})`);
