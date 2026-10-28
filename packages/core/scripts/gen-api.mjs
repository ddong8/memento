// Regenerates src/api.gen.ts from the Python server's OpenAPI schema, so every
// client gets the server's request and response types without a copy by hand.
//   npm run gen:api            (needs server/.venv, see server/README)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const server = join(repo, "server");
const python = process.env.MEMENTO_PYTHON ?? join(server, ".venv", "bin", "python");

const spec = execFileSync(
  python,
  ["-c", "import json; from server.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))"],
  { cwd: server, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
// A route serving several methods (api_route(..., methods=["GET", "HEAD"])) gets one operationId for
// all of them from FastAPI, ending in whichever method its set yields first (not the same every run),
// and the generated types then declare it twice: each gets its own method instead
const schema = JSON.parse(spec);
const ops = Object.values(schema.paths ?? {}).flatMap((byMethod) => Object.entries(byMethod));
const count = new Map();
for (const [, op] of ops) if (op?.operationId) count.set(op.operationId, (count.get(op.operationId) ?? 0) + 1);
for (const [method, op] of ops) {
  if (!op?.operationId || count.get(op.operationId) < 2) continue;
  op.operationId = `${op.operationId.replace(/_(get|head|post|put|patch|delete|options)$/, "")}_${method}`;
}
const out = join(here, "..", "openapi.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(schema));

execFileSync(
  process.execPath,
  [join(repo, "node_modules", "openapi-typescript", "bin", "cli.js"), out, "-o", join(here, "..", "src", "api.gen.ts")],
  { stdio: "inherit" },
);
console.log("wrote src/api.gen.ts");
