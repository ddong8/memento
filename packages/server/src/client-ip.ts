// The address the entrance saw (services/rate_limit.py client_ip): X-Real-IP is set by our proxy and can't
// be forged; the first X-Forwarded-For entry and the socket address are fallbacks. null when none is an IP.
import { isIP } from "node:net";

/** Python's str(ipaddress.ip_address(x)): IPv4 as is, IPv6 lower-cased and compressed. */
export function normalizeIp(candidate: string | null | undefined): string | null {
  const v = (candidate ?? "").trim();
  const kind = isIP(v);
  if (kind === 4) return v;
  if (kind === 6) {
    try {
      return new URL(`http://[${v}]/`).hostname.slice(1, -1);
    } catch {
      return v.toLowerCase();
    }
  }
  return null;
}

export function clientIp(headers: Headers, socketAddress?: string | null): string | null {
  const xff = headers.get("x-forwarded-for");
  for (const cand of [headers.get("x-real-ip"), xff ? xff.split(",")[0] : null, socketAddress]) {
    const ip = normalizeIp(cand);
    if (ip) return ip;
  }
  return null;
}
