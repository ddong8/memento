// drizzle-kit pull leaves the types it can't parse as unknown(): tsvector and pgvector's halfvec.
// Run after every pull (npm run db:pull does) so src/db/pulled/schema.ts stays reproducible.
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../src/db/pulled/schema.ts", import.meta.url);
let s = readFileSync(file, "utf8");
s = s.replace(/\t\/\/ TODO: failed to parse database type 'tsvector'\n\t(\w+): unknown\("(\w+)"\)/g, '\t$1: tsvector("$2")');
s = s.replace(/\t\/\/ TODO: failed to parse database type 'halfvec\((\d+)\)'\n\t(\w+): unknown\("(\w+)"\)/g, '\t$2: halfvec("$3", { dimensions: $1 })');
if (/unknown\(/.test(s)) throw new Error("schema.ts still has columns of a type fix-pulled.mjs doesn't know: add it here");
s = s.replace(/^(import \{ )/m, "$1halfvec, ");
s = s.replace(/^(import \{ sql \} from "drizzle-orm")$/m, '$1\nimport { tsvector } from "../types"');
writeFileSync(file, s);
console.log("fixed", file.pathname);
