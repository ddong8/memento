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
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, MASK.has(k) && typeof x === "string" ? `<${x.split(".").length}-part token>` : k === "input" ? "<input>" : normalize(x)]),
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
console.log(failed ? `\n${failed} of ${cases.length} differ` : `\nall ${cases.length} cases match`);
process.exit(failed ? 1 : 0);
