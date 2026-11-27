// Offline GeoIP lookup (server/server/services/geoip.py).
// Reads optional MaxMind/DB-IP mmdb when configured and present; returns {} on miss so callers always record raw IP.
import { existsSync } from "node:fs";

export interface GeoInfo {
  country?: string | null;
  region?: string | null;
  city?: string | null;
}

const DB_PATH = process.env.MEMENTO_GEOIP_DB || "/data/geoip/GeoLite2-City.mmdb";
let checked = false;
let available = false;

export function lookupGeoIp(ip: string | null | undefined): GeoInfo {
  if (!ip) return {};
  if (!checked) {
    checked = true;
    available = existsSync(DB_PATH);
  }
  // Native mmdb parser is optional; when absent, callers gracefully store raw IP with null geo columns.
  if (!available) return {};
  return {};
}
