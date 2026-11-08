// upnp-map.mts: the SSDP / device-description parsing and the SOAP fallback, with fetch stubbed (no router is touched).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addPortMapping, controlUrlFrom, soapBody, ssdpLocation } from "../upnp-map.mts";

describe("ssdpLocation", () => {
  test("the LOCATION header, any case and line ending", () => {
    const res = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nLocation: http://192.0.2.1:5000/rootDesc.xml\r\nST: x\r\n\r\n";
    assert.equal(ssdpLocation(res), "http://192.0.2.1:5000/rootDesc.xml");
    assert.equal(ssdpLocation("HTTP/1.1 200 OK\nlocation:http://192.0.2.1/d.xml\n"), "http://192.0.2.1/d.xml");
    assert.equal(ssdpLocation("HTTP/1.1 200 OK\r\nST: x\r\n"), undefined);
  });
});

describe("controlUrlFrom", () => {
  const desc = (services: string) => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device><serviceList>${services}</serviceList></device></root>`;
  const service = (type: string, control: string) =>
    `<service><serviceType>urn:schemas-upnp-org:service:${type}:1</serviceType><serviceId>x</serviceId><controlURL>${control}</controlURL></service>`;
  const location = "http://192.0.2.1:5000/rootDesc.xml";

  test("the first WAN connection service, relative URL resolved", () => {
    const xml = desc(service("Layer3Forwarding", "/l3f") + service("WANIPConnection", "/ctl/IPConn") + service("WANPPPConnection", "/ctl/PPP"));
    assert.equal(controlUrlFrom(xml, location), "http://192.0.2.1:5000/ctl/IPConn");
  });

  test("PPP, absolute URL, entities, prefixed tags", () => {
    assert.equal(controlUrlFrom(desc(service("WANPPPConnection", "http://192.0.2.1:49000/ppp?a=1&amp;b=2")), location), "http://192.0.2.1:49000/ppp?a=1&b=2");
    const prefixed = `<d:root xmlns:d="urn:schemas-upnp-org:device-1-0"><d:service>
      <d:serviceType> urn:schemas-upnp-org:service:WANIPConnection:2 </d:serviceType>
      <d:controlURL>upnp/control/WANIPConn1</d:controlURL></d:service></d:root>`;
    assert.equal(controlUrlFrom(prefixed, "http://192.0.2.1:1900/igd/desc.xml"), "http://192.0.2.1:1900/igd/upnp/control/WANIPConn1");
  });

  test("no WAN connection service", () => {
    assert.equal(controlUrlFrom(desc(service("Layer3Forwarding", "/l3f")), location), undefined);
    assert.equal(controlUrlFrom("<html>not upnp</html>", location), undefined);
  });
});

describe("addPortMapping", () => {
  test("the SOAP request", () => {
    const body = soapBody(8001, "192.0.2.10");
    assert.match(body, /<u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">/);
    assert.match(body, /<NewExternalPort>8001<\/NewExternalPort>/);
    assert.match(body, /<NewInternalPort>8001<\/NewInternalPort>/);
    assert.match(body, /<NewInternalClient>192\.0\.2\.10<\/NewInternalClient>/);
    assert.match(soapBody(8001, "192.0.2.10", "WANPPPConnection"), /service:WANPPPConnection:1/);
  });

  test("accepted as WANIPConnection", async (t) => {
    const calls: RequestInit[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(null, { status: 200 });
    });
    assert.equal(await addPortMapping("http://192.0.2.1/ctl", 8001, "192.0.2.10"), true);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.headers as Record<string, string>).SOAPAction, '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"');
  });

  test("falls back to WANPPPConnection", async (t) => {
    const actions: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const action = (init.headers as Record<string, string>).SOAPAction!;
      actions.push(action);
      assert.ok((init.body as string).includes(action.includes("PPP") ? "WANPPPConnection:1" : "WANIPConnection:1"));
      return action.includes("PPP") ? new Response(null, { status: 204 }) : new Response("fault", { status: 500, statusText: "Internal Server Error" });
    });
    assert.equal(await addPortMapping("http://192.0.2.1/ctl", 8001, "192.0.2.10"), true);
    assert.equal(actions.length, 2);
  });

  test("refused by both", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("fault", { status: 500, statusText: "Internal Server Error" }));
    t.mock.method(console, "log", () => {});
    assert.equal(await addPortMapping("http://192.0.2.1/ctl", 8001, "192.0.2.10"), false);
  });
});
