import { describe, expect, it } from "vitest";
import { hasConfiguredServer, isSameLocalOrigin, resolveDefaultDesktopRoute, resolveStartupMode } from "../src/helpers";

describe("desktop standalone-by-default startup", () => {
  const EMBEDDED = "http://127.0.0.1:8770";

  it("starts fresh new-user installs in zero-Docker standalone mode by default", () => {
    expect(
      resolveStartupMode({
        embeddedAvailable: true,
        hasSavedServerConfig: false,
        configServerUrl: "https://mem.ihasy.com",
        embeddedUrl: EMBEDDED,
      }),
    ).toBe("embedded-fresh");
  });

  it("stays in standalone mode when config points to local embedded server (127.0.0.1 or localhost)", () => {
    expect(
      resolveStartupMode({
        embeddedAvailable: true,
        hasSavedServerConfig: true,
        configServerUrl: "http://localhost:8770",
        embeddedUrl: EMBEDDED,
      }),
    ).toBe("embedded-existing");
    expect(isSameLocalOrigin("http://localhost:8770", "http://127.0.0.1:8770")).toBe(true);
    expect(isSameLocalOrigin("https://mem.ihasy.com", "http://127.0.0.1:8770")).toBe(false);
  });

  it("uses server mode only when user explicitly switched to a remote server, managed IT policy, or env override", () => {
    expect(
      resolveStartupMode({
        embeddedAvailable: true,
        hasSavedServerConfig: true,
        configServerUrl: "https://mem.ihasy.com",
        embeddedUrl: EMBEDDED,
      }),
    ).toBe("server");

    expect(
      resolveStartupMode({
        embeddedAvailable: true,
        managedServerUrl: "https://corp.example.com",
        hasSavedServerConfig: false,
        embeddedUrl: EMBEDDED,
      }),
    ).toBe("server");

    expect(
      resolveStartupMode({
        embeddedAvailable: true,
        envServerUrl: "https://custom.example.com",
        hasSavedServerConfig: false,
        embeddedUrl: EMBEDDED,
      }),
    ).toBe("server");
  });

  it("treats empty or broken config files as fresh installs rather than server mode", () => {
    expect(hasConfiguredServer(undefined)).toBe(false);
    expect(hasConfiguredServer("")).toBe(false);
    expect(hasConfiguredServer("{}")).toBe(false);
    expect(hasConfiguredServer('{"glass_enabled":true}')).toBe(false);
    expect(hasConfiguredServer('{"server_url":"https://mem.ihasy.com"}')).toBe(true);
    expect(hasConfiguredServer('{"token":"tok_123"}')).toBe(true);
    expect(hasConfiguredServer('url = "https://mem.ihasy.com"\n')).toBe(true);
  });

  it("routes unauthenticated desktop launches to /auth/login (never the marketing landing page)", () => {
    expect(resolveDefaultDesktopRoute({ hasToken: false })).toBe("/auth/login");
    expect(resolveDefaultDesktopRoute({ hasToken: false, lastRoute: "/ask" })).toBe("/auth/login");
    expect(resolveDefaultDesktopRoute({ hasToken: true })).toBe("/ask");
    expect(resolveDefaultDesktopRoute({ hasToken: true, lastRoute: "/" })).toBe("/ask");
    expect(resolveDefaultDesktopRoute({ hasToken: true, lastRoute: "/memory" })).toBe("/memory");
    expect(resolveDefaultDesktopRoute({ hasToken: false, target: "/auth/register" })).toBe("/auth/register");
  });
});
