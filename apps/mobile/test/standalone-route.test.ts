import { describe, expect, it } from "vitest";

import {
  claimPairingCode,
  DEFAULT_UI_ORIGIN,
  parsePairingUrl,
  resolveBestStandaloneRoute,
  routeModeLabel,
} from "../src/lib/standalone-route";

function okHealth() {
  return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
}

function failHealth(status = 502) {
  return Promise.resolve(new Response(JSON.stringify({ detail: "offline" }), { status }));
}

describe("mobile standalone pairing & 3-channel auto-routing", () => {
  it("parses compact memento://pair links and rejects invalid payloads", () => {
    const raw =
      "memento://pair?v=1&code=code_1234567890abcdef1234&name=Mac-mini&lan=http%3A%2F%2F192.168.1.10%3A8771&ts=https%3A%2F%2Fmac.tail.ts.net&relay=https%3A%2F%2Fmem.ihasy.com%2Fapi%2Frelay%2Ft%2Ft_abcdefghijklmnopqrstuv&ui=https%3A%2F%2Fmem.ihasy.com";
    const parsed = parsePairingUrl(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.code).toBe("code_1234567890abcdef1234");
    expect(parsed!.profile).toEqual({
      deviceName: "Mac-mini",
      lanUrl: "http://192.168.1.10:8771",
      tsUrl: "https://mac.tail.ts.net",
      relayApiUrl: "https://mem.ihasy.com/api/relay/t/t_abcdefghijklmnopqrstuv",
      uiOrigin: DEFAULT_UI_ORIGIN,
    });

    expect(parsePairingUrl("memento://ask?id=123")).toBeNull();
    expect(parsePairingUrl("memento://pair?code=short&lan=http://192.168.1.1:8771")).toBeNull();
    expect(parsePairingUrl("memento://pair?code=code_1234567890abcdef1234")).toBeNull();
  });

  it("picks LAN > Tailscale > Stateless Blind Relay in strict priority order", async () => {
    const profile = {
      deviceName: "Mac-mini",
      lanUrl: "http://192.168.1.10:8771",
      tsUrl: "https://mac.tail.ts.net",
      relayApiUrl: "https://mem.ihasy.com/api/relay/t/t_abcdefghijklmnopqrstuv",
      uiOrigin: DEFAULT_UI_ORIGIN,
    };

    // 1) All healthy -> prefers LAN
    const rLan = await resolveBestStandaloneRoute(profile, { fetchImpl: () => okHealth() });
    expect(rLan).toEqual({
      mode: "lan",
      webOrigin: "http://192.168.1.10:8771",
      apiBase: "http://192.168.1.10:8771",
      customApiBase: null,
    });

    // 2) LAN unreachable (away on 4G/5G), Tailscale healthy -> prefers Tailscale
    const rTs = await resolveBestStandaloneRoute(profile, {
      fetchImpl: (url) => (url.startsWith("http://192.168.") ? Promise.reject(new Error("timeout")) : okHealth()),
    });
    expect(rTs).toEqual({
      mode: "tailscale",
      webOrigin: "https://mac.tail.ts.net",
      apiBase: "https://mac.tail.ts.net",
      customApiBase: null,
    });

    // 3) LAN + Tailscale unreachable, Relay healthy -> uses mem.ihasy.com UI shell + blind relay customApiBase
    const rRelay = await resolveBestStandaloneRoute(profile, {
      fetchImpl: (url) => (url.includes("/api/relay/t/") ? okHealth() : failHealth(502)),
    });
    expect(rRelay).toEqual({
      mode: "relay",
      webOrigin: DEFAULT_UI_ORIGIN,
      apiBase: profile.relayApiUrl,
      customApiBase: profile.relayApiUrl,
    });
    expect(routeModeLabel(rRelay.mode)).toBe("无状态盲隧道");
  });

  it("falls back to Relay when LAN fails during claimPairingCode (e.g. first-time iOS Local Network prompt)", async () => {
    const profile = {
      deviceName: "Mac-mini",
      lanUrl: "http://192.168.1.10:8771",
      relayApiUrl: "https://mem.ihasy.com/api/relay/t/t_abcdefghijklmnopqrstuv",
      uiOrigin: DEFAULT_UI_ORIGIN,
    };
    const calls: string[] = [];
    const fetchMock = (url: string) => {
      calls.push(url);
      if (url === "http://192.168.1.10:8771/health") return okHealth();
      if (url === "http://192.168.1.10:8771/api/auth/pair/claim") return Promise.reject(new Error("Local network denied"));
      if (url.endsWith("/api/auth/pair/claim")) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "jwt-standalone-ok" }), { status: 200 }));
      }
      return okHealth();
    };

    const res = await claimPairingCode(profile, "code_1234567890abcdef1234", fetchMock);
    expect(res.accessToken).toBe("jwt-standalone-ok");
    expect(res.route.mode).toBe("relay");
    expect(calls).toContain("http://192.168.1.10:8771/api/auth/pair/claim");
    expect(calls).toContain("https://mem.ihasy.com/api/relay/t/t_abcdefghijklmnopqrstuv/api/auth/pair/claim");
  });
});
