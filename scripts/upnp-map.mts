// Zero-config UPnP / IGD port mapper for Memento: finds the home router over SSDP multicast and asks
// it to forward the port to this machine. Node built-ins only.
//
//   node scripts/upnp-map.mts [port]      # default 8001
import { createSocket } from "node:dgram";
import { pathToFileURL } from "node:url";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;

/** This machine's LAN address: the source a UDP "connection" to a public resolver would use (nothing is sent). */
export function localIp(): Promise<string> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    const done = (ip: string) => {
      sock.close();
      resolve(ip);
    };
    sock.once("error", () => done("127.0.0.1"));
    sock.connect(80, "223.5.5.5", () => {
      try {
        done(sock.address().address);
      } catch {
        done("127.0.0.1");
      }
    });
  });
}

/** The LOCATION header of an SSDP response. */
export function ssdpLocation(response: string): string | undefined {
  for (const line of response.split(/\r\n|\r|\n/)) {
    if (line.toLowerCase().startsWith("location:")) return line.slice(line.indexOf(":") + 1).trim();
  }
  return undefined;
}

/** The router's description URL, from the first gateway that answers within 3 seconds of quiet. */
function discoverLocation(): Promise<string | undefined> {
  const request = Buffer.from(
    "M-SEARCH * HTTP/1.1\r\n" +
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      'MAN: "ssdp:discover"\r\n' +
      "MX: 2\r\n" +
      "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n" +
      "\r\n",
  );
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    let timer: NodeJS.Timeout | undefined;
    const done = (location?: string) => {
      clearTimeout(timer);
      sock.close();
      resolve(location);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => done(), 3000);
    };
    sock.on("message", (data) => {
      const location = ssdpLocation(data.toString("utf8"));
      if (location) done(location);
      else arm();
    });
    sock.once("error", (e) => {
      console.log(`[-] SSDP 组播发现异常: ${e.message}`);
      done();
    });
    sock.send(request, SSDP_PORT, SSDP_ADDR, (e) => {
      if (e) {
        console.log(`[-] SSDP 组播发现异常: ${e.message}`);
        done();
      } else arm();
    });
  });
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** The WANIPConnection / WANPPPConnection control URL in a device description, resolved against its location. */
export function controlUrlFrom(xml: string, location: string): string | undefined {
  for (const [, body] of xml.matchAll(/<(?:[\w.-]+:)?service(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?service>/g)) {
    const field = (name: string) => unescapeXml(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)<`).exec(body!)?.[1]?.trim() ?? "");
    const type = field("serviceType");
    if (!type.includes("WANIPConnection") && !type.includes("WANPPPConnection")) continue;
    const control = field("controlURL");
    return control.startsWith("http") ? control : new URL(control, location).href;
  }
  return undefined;
}

async function parseControlUrl(location: string): Promise<string | undefined> {
  try {
    const res = await fetch(location, { headers: { "User-Agent": "MementoUPnP" }, signal: AbortSignal.timeout(3000) });
    if (res.status >= 400) throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
    return controlUrlFrom(await res.text(), location);
  } catch (e) {
    console.log(`[-] 解析路由器设备描述失败: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

export function soapBody(port: number, ip: string, service = "WANIPConnection"): string {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:${service}:1">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>${port}</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>
      <NewInternalPort>${port}</NewInternalPort>
      <NewInternalClient>${ip}</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>Memento-Direct</NewPortMappingDescription>
      <NewLeaseDuration>0</NewLeaseDuration>
    </u:AddPortMapping>
  </s:Body>
</s:Envelope>`;
}

async function addMapping(controlUrl: string, port: number, ip: string, service: string): Promise<boolean> {
  const res = await fetch(controlUrl, {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"urn:schemas-upnp-org:service:${service}:1#AddPortMapping"` },
    body: soapBody(port, ip, service),
    signal: AbortSignal.timeout(4000),
  });
  await res.body?.cancel();
  if (res.status >= 400) throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
  return res.status === 200 || res.status === 204;
}

/** AddPortMapping as a WANIPConnection, then as a WANPPPConnection if the router rejects that. */
export async function addPortMapping(controlUrl: string, port: number, ip: string): Promise<boolean> {
  try {
    return await addMapping(controlUrl, port, ip, "WANIPConnection");
  } catch (e) {
    try {
      return await addMapping(controlUrl, port, ip, "WANPPPConnection");
    } catch {
      // report the first failure
    }
    console.log(`[-] UPnP 映射通知响应: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const port = argv[0] === undefined ? 8001 : Number(argv[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`usage: upnp-map.mts [port]  (got: ${argv[0]})`);
    return 2;
  }
  const ip = await localIp();
  console.log(`[*] 检测到本机局域网 IP: ${ip}，目标端口: ${port}`);
  console.log("[*] 正在向家庭局域网组播嗅探主路由器 (UPnP/SSDP)...");
  const location = await discoverLocation();
  const controlUrl = location ? await parseControlUrl(location) : undefined;
  if (!controlUrl) {
    console.log("[-] 未在局域网发现支持 UPnP 的路由器（路由器可能未开启 UPnP 或处于全桥接）。");
    console.log("[+] 系统已切换为纯内网 mDNS + 动态 IPv6 嗅探模式，无需担心。");
    return 0;
  }
  console.log(`[+] 发现路由器 UPnP 控制端点: ${controlUrl}`);
  console.log(`[*] 正在请求路由器自动放行端口 ${port} -> ${ip}:${port} ...`);
  if (await addPortMapping(controlUrl, port, ip)) {
    console.log(`[✓] 成功！主路由器已自动完成端口映射 (${port})，外部无需手动配置防火墙！`);
  } else {
    console.log("[-] 路由器拒绝了 UPnP 自动打洞，系统将使用自动 IPv6 直连通道与云端中继。");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
