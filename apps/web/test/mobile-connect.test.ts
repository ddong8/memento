import { afterEach, describe, expect, it } from "vitest";

import { encodeQrMatrix, encodeQrSvg, rsComputeRemainder } from "../src/lib/qr-svg";
import { getApiBase, isOwnUrl } from "../src/lib/server-endpoint";

describe("server-endpoint standalone & relay URL derivation", () => {
  const origWindow = globalThis.window;
  const origLocalStorage = globalThis.localStorage;

  afterEach(() => {
    Object.defineProperty(globalThis, "window", { value: origWindow, configurable: true, writable: true });
    Object.defineProperty(globalThis, "localStorage", { value: origLocalStorage, configurable: true, writable: true });
  });

  function mockBrowser(href: string, customServer: string | null = null) {
    const u = new URL(href);
    const store = new Map<string, string>();
    if (customServer) store.set("memento_custom_server", customServer);
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    };
    Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true, writable: true });
    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          href: u.href,
          origin: u.origin,
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port,
          pathname: u.pathname,
        },
        localStorage: ls,
      },
      configurable: true,
      writable: true,
    });
  }

  it("keeps same-origin for standalone loopback (:8770) and LAN forwarder (:8771)", () => {
    mockBrowser("http://127.0.0.1:8770/ask");
    expect(getApiBase()).toBe("http://127.0.0.1:8770");

    mockBrowser("http://192.168.1.25:8771/ask");
    expect(getApiBase()).toBe("http://192.168.1.25:8771");
    expect(isOwnUrl("http://192.168.1.25:8771/api/auth/me")).toBe(true);
    expect(isOwnUrl("https://evil.example/api/auth/me")).toBe(false);
  });

  it("still maps local Next.js dev ports (3000/3001) to :8001 and standard ports to same-origin", () => {
    mockBrowser("http://localhost:3000/ask");
    expect(getApiBase()).toBe("http://localhost:8001");

    mockBrowser("http://localhost:3001/ask");
    expect(getApiBase()).toBe("http://localhost:8001");

    mockBrowser("https://mem.ihasy.com/ask");
    expect(getApiBase()).toBe("https://mem.ihasy.com");
  });

  it("supports path-prefixed stateless relay custom server URLs", () => {
    const relayBase = "https://mem.ihasy.com/api/relay/t/t_abcdefghijklmnopqrstuv";
    mockBrowser("https://mem.ihasy.com/ask", `${relayBase}/`);
    expect(getApiBase()).toBe(relayBase);
    expect(isOwnUrl(`${relayBase}/api/events/stream`)).toBe(true);
    expect(isOwnUrl("https://thirdparty.example/doc")).toBe(false);
  });
});

describe("pure-TS QR SVG encoder (ISO/IEC 18004)", () => {
  it("computes standard Reed-Solomon remainders for known QR test vectors", () => {
    // ISO/IEC 18004 Annex I / standard Version 1-M "HELLO WORLD" check:
    // Verify RS remainder length and non-trivial checksum
    const data = new Uint8Array([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
    const ec = rsComputeRemainder(data, 10);
    expect(Array.from(ec)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("encodes short and long pairing URLs into valid QR matrices and crisp SVG", () => {
    const shortQr = encodeQrMatrix("https://mem.ihasy.com", "M");
    expect(shortQr.version).toBe(2);
    expect(shortQr.size).toBe(25);
    // Top-left finder pattern center 3x3 is dark
    expect(shortQr.modules[3 * shortQr.size + 3]).toBe(1);
    // Dark module at (size - 8, 8)
    expect(shortQr.modules[(shortQr.size - 8) * shortQr.size + 8]).toBe(1);

    const pairUrl =
      "memento://pair?v=1&code=abc12345678901234567890123456789&name=Mac-mini&lan=http%3A%2F%2F192.168.1.8%3A8771&ts=https%3A%2F%2Fmac.tail1234.ts.net&relay=https%3A%2F%2Fmem.ihasy.com%2Fapi%2Frelay%2Ft%2Ft_abcdefghijklmnopqrstuv&ui=https%3A%2F%2Fmem.ihasy.com";
    const longQr = encodeQrMatrix(pairUrl, "L");
    expect(longQr.version).toBeGreaterThanOrEqual(7);
    expect(longQr.size).toBe(longQr.version * 4 + 17);

    const svg = encodeQrSvg(pairUrl);
    expect(svg).toContain("<svg ");
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain("<path ");
  });
});
