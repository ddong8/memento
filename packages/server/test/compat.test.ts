// What must match the Python server byte for byte: tokens, password hashes, settings parsing.
import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import { createAccessToken, decodeToken } from "../src/auth/jwt";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { clientIp, normalizeIp } from "../src/client-ip";
import { loadSettings, parseBool, plainDatabaseUrl, validateProduction } from "../src/config";

const SECRET = "test-secret-for-compat";
// Made by python-jose (server/server/middleware/auth.py create_access_token) with SECRET
const PY_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3YWViYWNhMC02NWFiLTQ1ZjYtOTk0Ny03OWI1ZDk2ZDExNDEiLCJyb2xlIjoib3duZXIiLCJleHAiOjQwNzA5MDg4MDB9.56eehPJQfUkPRUZruGCHG3D5qCL0QFB-OK9_lKD4j2s";
const PY_EXPIRED =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3YWViYWNhMC02NWFiLTQ1ZjYtOTk0Ny03OWI1ZDk2ZDExNDEiLCJyb2xlIjoib3duZXIiLCJleHAiOjE1Nzc4MzY4MDB9.Kr7gY6pMi0Aum91RpevNeTWaNIcROTnGeCKGoKDOBUs";
// Made by Python's bcrypt.hashpw(b"E2e-test-pass-123", bcrypt.gensalt())
const PY_HASH = "$2b$12$isl6Lww/Ap3oKy1YiUBdI..pgSBlOp4l8mroc38OXzhimLGbRT/7y";

describe("access tokens", () => {
  it("a token the Python server made is accepted, so nobody is signed out by the switch", async () => {
    const claims = await decodeToken(PY_TOKEN, SECRET);
    expect(claims).toMatchObject({ sub: "7aebaca0-65ab-45f6-9947-79b5d96d1141", role: "owner", exp: 4070908800 });
  });

  it("an expired or foreign token is refused with the Python server's message", async () => {
    await expect(decodeToken(PY_EXPIRED, SECRET)).rejects.toMatchObject({ status: 401, detail: "Invalid token" });
    await expect(decodeToken(PY_TOKEN, "another-secret")).rejects.toMatchObject({ status: 401 });
  });

  it("tokens made here have python-jose's shape: HS256/JWT header, sub + role + integer exp", async () => {
    const t = await createAccessToken("u-1", "viewer", SECRET, 60);
    expect(decodeProtectedHeader(t)).toEqual({ alg: "HS256", typ: "JWT" });
    const p = decodeJwt(t);
    expect(Object.keys(p).sort()).toEqual(["exp", "role", "sub"]);
    expect(Number.isInteger(p.exp)).toBe(true);
    expect(p.exp! - Date.now() / 1000).toBeGreaterThan(3500);
    expect(await decodeToken(t, SECRET)).toMatchObject({ sub: "u-1", role: "viewer" });
  });
});

describe("passwords", () => {
  it("checks hashes Python's bcrypt wrote, and writes ones it can check", () => {
    expect(verifyPassword("E2e-test-pass-123", PY_HASH)).toBe(true);
    expect(verifyPassword("wrong", PY_HASH)).toBe(false);
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    const h = hashPassword("新密码-123");
    expect(h).toMatch(/^\$2[aby]\$12\$/);
    expect(verifyPassword("新密码-123", h)).toBe(true);
  });
});

describe("client address", () => {
  it("prefers X-Real-IP, then the first X-Forwarded-For, then the socket; normalizes like ipaddress", () => {
    expect(clientIp(new Headers({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }), "9.9.9.9")).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": " 5.6.7.8 , 10.0.0.1" }), "9.9.9.9")).toBe("5.6.7.8");
    expect(clientIp(new Headers({ "x-real-ip": "garbage" }), "9.9.9.9")).toBe("9.9.9.9");
    expect(clientIp(new Headers(), null)).toBeNull();
    expect(normalizeIp("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
  });
});

describe("settings", () => {
  it("reads the same MEMENTO_* variables and defaults as config.py", () => {
    const s = loadSettings({ MEMENTO_DATABASE_URL: "postgresql+asyncpg://u:p@db:5432/memento", MEMENTO_PASSWORD_LOGIN: "False", MEMENTO_PORT: "9000" });
    expect(s.databaseUrl).toBe("postgres://u:p@db:5432/memento");
    expect(s.passwordLogin).toBe(false);
    expect(s.port).toBe(9000);
    expect(s.registrationMode).toBe("open");
    expect(s.accessTokenExpireMinutes).toBe(60 * 24 * 365 * 10);
    expect(s.oidcDisplayName).toBe("企业账号");
    expect(plainDatabaseUrl("postgresql://a@b/c")).toBe("postgres://a@b/c");
    expect(parseBool("on", false)).toBe(true);
    expect(() => parseBool("maybe", false)).toThrow();
  });

  it("refuses to start on development secrets unless debug is on", () => {
    expect(() => validateProduction(loadSettings({}))).toThrow(/MEMENTO_SECRET_KEY/);
    expect(() => validateProduction(loadSettings({ MEMENTO_DEBUG: "1" }))).not.toThrow();
  });
});
