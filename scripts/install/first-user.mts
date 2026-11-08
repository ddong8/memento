// First-user registration: prompt email/password, POST /api/auth/register.
//
// The first registrant is auto-promoted to 'owner' by the server and receives a `collector_token`,
// saved to .env.local so re-runs skip the prompt.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, ask, askHidden, info, ok, warn } from "./platform.mts";

export const ENV_LOCAL = join(REPO_ROOT, ".env.local");
const API_BASE = "http://localhost:8001";

function parseEnvLocal(): Record<string, string> {
  if (!existsSync(ENV_LOCAL)) return {};
  const result: Record<string, string> = {};
  for (const raw of readFileSync(ENV_LOCAL, "utf8").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 0) continue;
    result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return result;
}

function writeEnvLocal(values: Record<string, string>): void {
  const lines = ["# Local-only values written by ./install.sh (never commit)", ...Object.entries(values).map(([k, v]) => `${k}=${v}`)];
  writeFileSync(ENV_LOCAL, `${lines.join("\n")}\n`, "utf8");
  try {
    chmodSync(ENV_LOCAL, 0o600);
  } catch {
    // Windows
  }
}

export const validEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

async function postJson(url: string, payload: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${body}`);
  return JSON.parse(body) as Record<string, unknown>;
}

async function promptCredentials(interactive: boolean): Promise<[email: string, password: string, name: string | undefined]> {
  if (!interactive || !process.stdin.isTTY) {
    throw new Error(
      "No TTY and no pre-seeded credentials. Re-run ./install.sh in an interactive terminal, " +
        "or register manually at http://localhost:3001/auth/register.",
    );
  }
  console.log();
  console.log("Create the first user (auto-promoted to owner):");
  let email: string;
  for (;;) {
    email = (await ask("  Email: ")).trim();
    if (validEmail(email)) break;
    warn("Invalid email, try again.");
  }
  const name = (await ask("  Display name [optional]: ")).trim() || undefined;
  for (;;) {
    const pw1 = await askHidden("  Password (≥8 chars): ");
    if (pw1.length < 8) {
      warn("Too short. Try again.");
      continue;
    }
    const pw2 = await askHidden("  Confirm password: ");
    if (pw1 !== pw2) {
      warn("Did not match. Try again.");
      continue;
    }
    return [email, pw1, name];
  }
}

/** The owner's collector token: the one in .env.local, else registers the first user and saves it. */
export async function ensureFirstUser(interactive = true): Promise<string> {
  const existing = parseEnvLocal().MEMENTO_COLLECTOR_TOKEN;
  if (existing) {
    ok("Owner user already registered (token in .env.local).");
    return existing;
  }
  const [email, password, name] = await promptCredentials(interactive);
  info(`Registering ${email} with the API…`);
  const data = await postJson(`${API_BASE}/api/auth/register`, name ? { email, password, name } : { email, password });
  const token = data.collector_token;
  if (typeof token !== "string" || !token) {
    throw new Error(
      "Server did not return a collector_token. You may not be the first user. " +
        "Register at http://localhost:3001/auth/register and copy the token from your profile page.",
    );
  }
  writeEnvLocal({ MEMENTO_OWNER_EMAIL: email, MEMENTO_COLLECTOR_TOKEN: token });
  ok(`Registered ${email} (role=${String(data.role ?? "None")}). Token saved to .env.local.`);
  return token;
}
