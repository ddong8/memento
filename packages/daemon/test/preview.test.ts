import { describe, expect, it } from "vitest";
import { fetchLocal, parseLsof, parseSs, parseWindows } from "../src/preview.js";

describe("previewing local web servers", () => {
  it("reads listening ports from lsof, ss and PowerShell", () => {
    const lsof = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 4242 me 22u IPv6 0x1 0t0 TCP *:5173 (LISTEN)\nnode 4242 me 23u IPv4 0x2 0t0 TCP 127.0.0.1:5173 (LISTEN)\nPython 99 me 3u IPv4 0x3 0t0 TCP *:8000 (LISTEN)";
    expect(parseLsof(lsof)).toEqual([{ port: 5173, process: "node", pid: 4242 }, { port: 8000, process: "Python", pid: 99 }]);
    expect(parseSs('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("next-server",pid=77,fd=19))')).toEqual([{ port: 3000, process: "next-server", pid: 77 }]);
    expect(parseWindows('{"LocalPort":8080,"OwningProcess":12,"Name":"node"}')).toEqual([{ port: 8080, process: "node", pid: 12 }]);
    expect(parseWindows("not json")).toEqual([]);
  });

  it("fetches only from loopback and never forwards the user's sign-in", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response("<h1>hi</h1>", { status: 200, headers: { "content-type": "text/html", "content-encoding": "gzip" } });
    }) as unknown as typeof fetch;
    const res = await fetchLocal({ port: 5173, method: "GET", path: "/app?x=1", headers: { accept: "text/html", authorization: "Bearer secret", cookie: "s=1" } }, fake);
    expect(seen!.url).toBe("http://127.0.0.1:5173/app?x=1");
    expect(seen!.headers).toEqual({ accept: "text/html" });
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(res.headers!["content-encoding"]).toBeUndefined();
    expect(Buffer.from(res.body_b64!, "base64").toString()).toBe("<h1>hi</h1>");
    expect((await fetchLocal({ port: 0, method: "GET", path: "/" }, fake)).ok).toBe(false);
    expect((await fetchLocal({ port: 5173, method: "GET", path: "http://evil.example/" }, fake)).ok).toBe(true);
    expect(seen!.url).toBe("http://127.0.0.1:5173/");
  });
});
