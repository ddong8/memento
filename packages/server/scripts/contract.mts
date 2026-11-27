// Contract check: the same requests against the Python server and this one, responses compared field by field.
// Run both against one database and Redis, then:
//   node scripts/contract.mts --py http://127.0.0.1:18001 --ts http://127.0.0.1:18002 --email a@b.c --password ...
// Exit code 1 on any difference. Tokens differ by design (exp to the second): compared by shape, not value.

interface Case {
  name: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Only the status and each error's type must match (the parser's own error text differs by language) */
  loose?: boolean;
}

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const PY = args.get("py")!;
const TS = args.get("ts")!;
const email = args.get("email")!;
const password = args.get("password")!;
if (!PY || !TS || !email || !password) {
  console.error("usage: contract.mts --py <url> --ts <url> --email <e> --password <p>");
  process.exit(2);
}

const MASK = new Set(["access_token"]);
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    // Key order isn't part of the contract (a dict built from GROUP BY rows comes in the database's order)
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, x]) => [k, MASK.has(k) && typeof x === "string" ? `<${x.split(".").length}-part token>` : k === "input" ? "<input>" : normalize(x)]),
    );
  }
  return v;
}

async function call(base: string, c: Case) {
  const res = await fetch(base + c.path, {
    method: c.method,
    headers: { ...(c.body !== undefined ? { "content-type": "application/json" } : {}), ...c.headers },
    body: c.body === undefined ? undefined : typeof c.body === "string" ? c.body : JSON.stringify(c.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, keys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null, ctype: (res.headers.get("content-type") || "").split(";")[0] };
}

const login = await call(PY, { name: "login", method: "POST", path: "/api/auth/login", body: { email, password } });
if (login.status !== 200) {
  console.error("can't sign in on the Python server:", login.status, login.body);
  process.exit(2);
}
const token = (login.body as { access_token: string }).access_token;
const me = (await call(PY, { name: "me", method: "GET", path: "/api/auth/me", headers: { authorization: `Bearer ${token}` } })).body as { collector_token: string; name: string | null };
const auth = { authorization: `Bearer ${token}` };

const cases: Case[] = [
  { name: "registration mode", method: "GET", path: "/api/auth/registration-mode" },
  { name: "login ok", method: "POST", path: "/api/auth/login", body: { email, password } },
  { name: "login wrong password", method: "POST", path: "/api/auth/login", body: { email, password: password + "x" } },
  { name: "login unknown account", method: "POST", path: "/api/auth/login", body: { email: "nobody-" + email, password } },
  { name: "login missing field", method: "POST", path: "/api/auth/login", body: { email } },
  { name: "login not an object", method: "POST", path: "/api/auth/login", body: "[1]" },
  { name: "login broken json", method: "POST", path: "/api/auth/login", body: "{", loose: true },
  { name: "me", method: "GET", path: "/api/auth/me", headers: auth },
  { name: "me without token", method: "GET", path: "/api/auth/me" },
  { name: "me bad token", method: "GET", path: "/api/auth/me", headers: { authorization: "Bearer x.y.z" } },
  { name: "me not bearer", method: "GET", path: "/api/auth/me", headers: { authorization: "Basic abc" } },
  { name: "refresh", method: "POST", path: "/api/auth/refresh", headers: auth },
  { name: "refresh without token", method: "POST", path: "/api/auth/refresh" },
  { name: "token exchange", method: "POST", path: "/api/auth/token-exchange", headers: { "x-collector-token": me.collector_token } },
  { name: "token exchange missing", method: "POST", path: "/api/auth/token-exchange" },
  { name: "token exchange wrong", method: "POST", path: "/api/auth/token-exchange", headers: { "x-collector-token": "nope" } },
  { name: "patch me same name", method: "PATCH", path: "/api/auth/me", headers: auth, body: { name: me.name ?? "" } },
  { name: "patch me bad avatar", method: "PATCH", path: "/api/auth/me", headers: auth, body: { avatar_url: "ftp://x" } },
  { name: "patch me wrong type", method: "PATCH", path: "/api/auth/me", headers: auth, body: { name: 5 } },
  { name: "health", method: "GET", path: "/health" },
];

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`✓ ${name}`);
  else {
    failed++;
    console.log(`✗ ${name}${detail ? "\n  " + detail : ""}`);
  }
};

// ---- the same steps on each server, each with its own fresh account: ids and times compared by shape ----
const ID_KEYS = new Set(["id", "source_doc_id"]);
const TIME_KEYS = new Set(["created_at", "closed_at"]);
function shape(v: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(v)) return v.map((x) => shape(x, ids));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => {
        if (ID_KEYS.has(k) && typeof x === "string") {
          if (!ids.has(x)) ids.set(x, `<id${ids.size + 1}>`);
          return [k, ids.get(x)];
        }
        if (TIME_KEYS.has(k) && typeof x === "string") return [k, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?\+00:00$/.test(x) ? "<time>" : `<bad time ${x}>`];
        return [k, shape(x, ids)];
      }),
    );
  }
  return v;
}

async function account(base: string, tag: string): Promise<Record<string, string>> {
  const e = `${tag}-${Date.now()}@example.com`;
  await call(PY, { name: "register", method: "POST", path: "/api/auth/register", body: { email: e, password: "Contract-pass-123", name: tag } });
  const r = await call(base, { name: "login", method: "POST", path: "/api/auth/login", body: { email: e, password: "Contract-pass-123" } });
  return { authorization: `Bearer ${(r.body as { access_token: string }).access_token}` };
}

type Step = { name: string; method: string; path: string; body?: unknown };
const todoSteps: Step[] = [
  { name: "todos empty list", method: "GET", path: "/api/todos" },
  { name: "todo create", method: "POST", path: "/api/todos", body: { title: "  给 memento  加分页 ", source: "mcp", due: "2026-12-01" } },
  { name: "todo create same title", method: "POST", path: "/api/todos", body: { title: "给memento加分页！", project: "memento", detail: "d" } },
  { name: "todo create no due", method: "POST", path: "/api/todos", body: { title: "第二件事", due: "2026-W53-1" } },
  { name: "todo create empty", method: "POST", path: "/api/todos", body: { title: "   " } },
  { name: "todo create missing title", method: "POST", path: "/api/todos", body: { detail: "x" } },
  { name: "todo create wrong type", method: "POST", path: "/api/todos", body: { title: 5 } },
  { name: "todo edit", method: "PUT", path: "/api/todos/{todo}", body: { title: "改过的标题", detail: "  补充  ", project: "", due: "" } },
  { name: "todo done", method: "PUT", path: "/api/todos/{todo}", body: { status: "done" } },
  { name: "todo bad status", method: "PUT", path: "/api/todos/{todo}", body: { status: "later" } },
  { name: "todo not mine", method: "PUT", path: "/api/todos/00000000-0000-0000-0000-000000000000", body: { title: "x" } },
  { name: "todo bad id", method: "PUT", path: "/api/todos/abc", body: { title: "x" } },
  { name: "todos list after", method: "GET", path: "/api/todos" },
  { name: "todos list by project", method: "GET", path: "/api/todos?project=MEM" },
  { name: "todo reopen", method: "PUT", path: "/api/todos/{todo}", body: { status: "open" } },
];
const runs: Record<string, { status: number; body: unknown }[]> = {};
for (const [side, base] of [["python", PY], ["ts", TS]] as const) {
  const headers = await account(base, `contract-${side}`);
  let todoId = "";
  runs[side] = [];
  for (const st of todoSteps) {
    const r = await call(base, { ...st, path: st.path.replace("{todo}", todoId), headers });
    const id = (r.body as { todo?: { id?: string } })?.todo?.id;
    if (st.name === "todo create" && id) todoId = id;
    runs[side]!.push(r);
  }
}
const idsPy = new Map<string, string>();
const idsTs = new Map<string, string>();
todoSteps.forEach((st, i) => {
  const a = runs.python![i]!;
  const b = runs.ts![i]!;
  const sa = JSON.stringify(normalize(shape(a.body, idsPy)));
  const sb = JSON.stringify(normalize(shape(b.body, idsTs)));
  check(`${st.name} (${a.status})`, a.status === b.status && sa === sb, `python: ${a.status} ${sa}\n  ts:     ${b.status} ${sb}`);
});

// ---- one account, both servers: what one writes the other reads at once (cache busts cross over) ----
{
  const headers = await account(PY, "contract-cross");
  const titles = async (base: string) => ((await call(base, { name: "", method: "GET", path: "/api/todos", headers })).body as { open: { title: string }[] }).open.map((t) => t.title);
  await titles(TS);
  await titles(PY); // both caches warm
  const made = await call(PY, { name: "", method: "POST", path: "/api/todos", headers, body: { title: "python 建的" } });
  const seenOnTs = await titles(TS);
  check("written on python, read on ts at once", seenOnTs.includes("python 建的"), `ts sees ${JSON.stringify(seenOnTs)}`);
  const id = (made.body as { todo: { id: string } }).todo.id;
  await call(TS, { name: "", method: "PUT", path: `/api/todos/${id}`, headers, body: { status: "done" } });
  const seenOnPy = await titles(PY);
  check("closed on ts, gone from python's open list at once", !seenOnPy.includes("python 建的"), `python sees ${JSON.stringify(seenOnPy)}`);
  await call(TS, { name: "", method: "POST", path: "/api/todos", headers, body: { title: "ts 建的" } });
  check("written on ts, read on python at once", (await titles(PY)).includes("ts 建的"));
}

// ---- read-only endpoints over seeded data, as an owner (sees all) and as a viewer (only their devices) ----
const dbUrl = args.get("db");
const redisUrl = args.get("redis");
if (dbUrl && redisUrl) {
  const { default: postgres } = await import("postgres");
  const { Redis } = await import("ioredis");
  const sqlc = postgres(dbUrl.replace(/^postgresql\+[a-z]+:/, "postgres:"), { max: 2, onnotice: () => {} });
  const redis = new Redis(redisUrl);
  const viewerHeaders = await account(PY, "contract-viewer");
  const ownerId = (me as unknown as { id: string }).id;
  const viewerId = ((await call(PY, { name: "", method: "GET", path: "/api/auth/me", headers: viewerHeaders })).body as { id: string }).id;
  await sqlc`INSERT INTO tools (id, display_name, icon, total_files, total_size_bytes, last_sync_at) VALUES
    ('claude_code', 'Claude Code', 'claude', 3, 4096, '2026-11-27 05:00:00.123+00'), ('codex', 'Codex', NULL, 1, 10, NULL)
    ON CONFLICT (id) DO NOTHING`;
  const m1 = "11111111-1111-1111-1111-111111111111";
  const m2 = "22222222-2222-2222-2222-222222222222";
  await sqlc`INSERT INTO machines (id, name, collector_token_hash, user_id) VALUES
    (${m1}, 'owner-mac', 'hash-owner', ${ownerId}), (${m2}, 'viewer-pc', 'hash-viewer', ${viewerId})
    ON CONFLICT (id) DO NOTHING`;
  const doc = (n: number, tool: string, cat: string, m: string, at: string) => sqlc`INSERT INTO documents
    (id, tool_id, relative_path, category, content_type, content_hash, file_size_bytes, metadata, visibility, needs_review,
     embedding_status, embedding_attempts, knowledge_status, knowledge_attempts, machine_id, title, content, ai_summary, synced_at)
    VALUES (${`00000000-0000-0000-0000-00000000000${n}`}, ${tool}, ${`p/${n}.jsonl`}, ${cat}, 'jsonl', ${`h${n}`}, ${n * 100}, '{}', 'private', false,
     'done', 0, 'done', 0, ${m}, ${`标题 ${n}`}, ${`正文 ${n}`}, ${n % 2 ? "摘要" : null}, ${at})
    ON CONFLICT (id) DO NOTHING`;
  await doc(1, "claude_code", "conversation", m1, "2026-11-27 05:00:00.5+00");
  await doc(2, "claude_code", "conversation", m2, "2026-11-27 06:00:00+00");
  await doc(3, "claude_code", "memory", m1, "2026-11-27 07:00:00.000123+00");
  await doc(4, "codex", "conversation", m2, "2026-11-26 07:00:00+00");
  const entId = "33333333-3333-3333-3333-333333333333";
  await sqlc`INSERT INTO knowledge_entities (id, user_id, name, entity_type) VALUES (${entId}, ${ownerId}, 'Memento', 'project') ON CONFLICT (id) DO NOTHING`;
  await sqlc`INSERT INTO knowledge_observations (id, entity_id, content, source_document_id) VALUES
    ('44444444-4444-4444-4444-444444444441', ${entId}, 'obs1', '00000000-0000-0000-0000-000000000001'),
    ('44444444-4444-4444-4444-444444444443', ${entId}, 'obs3', '00000000-0000-0000-0000-000000000003')
    ON CONFLICT (id) DO NOTHING`;
  const ownerAuth = { authorization: `Bearer ${token}` };
  const reads: [string, string][] = [
    ["tools", "/api/tools"],
    ["tools of a device", "/api/tools?device_id=hash-owner"],
    ["tool", "/api/tools/claude_code"],
    ["tool of a device", "/api/tools/claude_code?device_id=hash-viewer"],
    ["unknown tool", "/api/tools/nope"],
    ["tool files", "/api/tools/claude_code/files"],
    ["tool files paged", "/api/tools/claude_code/files?category=conversation&limit=1&offset=1"],
    ["tool files limit 0", "/api/tools/claude_code/files?limit=0"],
    ["tool files limit 201", "/api/tools/claude_code/files?limit=201"],
    ["tool files offset -1", "/api/tools/claude_code/files?offset=-1"],
    ["tool files limit abc", "/api/tools/claude_code/files?limit=abc"],
    ["public stats", "/api/public/stats"],
    ["dashboard default", "/api/dashboard"],
    ["dashboard tz -480", "/api/dashboard?tz_offset=-480"],
    ["dashboard of device", "/api/dashboard?device_id=hash-owner"],
    ["hierarchy devices", "/api/hierarchy/devices"],
    ["hierarchy device tools", "/api/hierarchy/devices/hash-owner/tools"],
    ["hierarchy device tool projects", "/api/hierarchy/devices/hash-owner/tools/claude_code/projects"],
    ["hierarchy device tool files", "/api/hierarchy/devices/hash-owner/tools/claude_code/files?project_id=none&limit=1&offset=0"],
    ["document get", "/api/documents/00000000-0000-0000-0000-000000000001"],
    ["document backlinks", "/api/documents/00000000-0000-0000-0000-000000000001/backlinks"],
    ["document missing", "/api/documents/99999999-9999-9999-9999-999999999999"],
    ["document proxy-fetch ssrf", "/api/documents/proxy-fetch?url=http://127.0.0.1:8000/health"],
    ["document proxy-fetch scheme", "/api/documents/proxy-fetch?url=ftp://example.com/a"],
    ["skills list", "/api/skills"],
    ["plugins list", "/api/plugins"],
    ["media image invalid key", "/api/media/image/..%2Fsecret"],
    ["media image missing auth", "/api/media/image/ab/missing.png"],
    ["media video missing auth", "/api/media/video/ab/missing.mp4"],
    ["updates check mobile", "/api/system/update/check?platform=ios&version=1.0.0"],
    ["updates check macos", "/api/system/update/check?platform=macos&version=1.0.0"],
    ["install.sh", "/install.sh"],
    ["install.ps1", "/install.ps1"],
    ["install executor.sh", "/install/executor.sh"],
  ];
  for (const [who, headers] of [["owner", ownerAuth], ["viewer", viewerHeaders]] as const) {
    for (const [name, path] of reads) {
      // Each server computes it itself: drop the shared cache before each call (and wait out the other's 3 s L1)
      const fresh = async (base: string) => {
        for (const pat of ["tools:list:*", "dashboard:*", "hierarchy:*", "skills:*"]) {
          const keys = await redis.keys(pat);
          if (keys.length) await redis.del(...keys);
        }
        return call(base, { name, method: "GET", path, headers: { "x-forwarded-proto": "https", "x-forwarded-host": "mem.ihasy.com", ...headers } });
      };
      const a = await fresh(PY);
      const b = await fresh(TS);
      const sa = JSON.stringify(normalize(a.body));
      const sb = JSON.stringify(normalize(b.body));
      check(`${who}: ${name} (${a.status})`, a.status === b.status && sa === sb, `python: ${a.status} ${sa}\n  ts:     ${b.status} ${sb}`);
    }
  }
  await sqlc.end();
  redis.disconnect();
}

for (const c of cases) {
  const [a, b] = [await call(PY, c), await call(TS, c)];
  const errTypes = (x: unknown) => JSON.stringify(((x as { detail?: { type?: string }[] })?.detail ?? []).map((d) => d.type));
  const same = c.loose
    ? a.status === b.status && errTypes(a.body) === errTypes(b.body)
    : a.status === b.status && JSON.stringify(normalize(a.body)) === JSON.stringify(normalize(b.body)) && JSON.stringify(a.keys) === JSON.stringify(b.keys) && a.ctype === b.ctype;
  if (same) console.log(`✓ ${c.name} (${a.status})`);
  else {
    failed++;
    console.log(`✗ ${c.name}\n  python: ${a.status} ${a.ctype} ${JSON.stringify(normalize(a.body))}\n  ts:     ${b.status} ${b.ctype} ${JSON.stringify(normalize(b.body))}`);
  }
}
const total = cases.length + todoSteps.length + 3 + (dbUrl && redisUrl ? 68 : 0);
console.log(failed ? `\n${failed} of ${total} differ` : `\nall ${total} cases match`);
process.exit(failed ? 1 : 0);
