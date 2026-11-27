// Times the way the Python server writes them, so responses stay byte-compatible.
// The pool runs with TimeZone=UTC (db/client.ts): timestamptz text is "YYYY-MM-DD HH:MM:SS[.f]+00".

/** Postgres timestamptz text -> Python datetime.isoformat() of the UTC value asyncpg returns:
 * "2026-11-27T05:00:00.120000+00:00"; the fraction padded to 6 digits, left out when it is zero. */
export function pgToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:([+-]\d{2})(?::?(\d{2}))?|Z)?$/.exec(value.trim());
  if (!m) return new Date(value).toISOString().replace("Z", "+00:00");
  const [, date, time, frac, tzh, tzm] = m;
  if (tzh && (tzh !== "+00" || (tzm && tzm !== "00"))) {
    // Not UTC text (a session that wasn't set to UTC): go through Date, losing only sub-millisecond digits
    return utcIso(new Date(value.replace(" ", "T")), frac);
  }
  const f = frac ? frac.padEnd(6, "0").slice(0, 6) : "";
  return `${date}T${time}${f && !/^0+$/.test(f) ? "." + f : ""}+00:00`;
}

function utcIso(d: Date, frac?: string): string {
  const ms = frac ? frac.padEnd(6, "0").slice(0, 6) : String(d.getUTCMilliseconds() * 1000).padStart(6, "0");
  const base = d.toISOString().slice(0, 19);
  return `${base}${/^0+$/.test(ms) ? "" : "." + ms}+00:00`;
}

/** The calendar date of a timestamptz in UTC+8 (the server's LOCAL_TZ, China has no DST): "2026-11-27". */
export function localDate(value: string | null | undefined, offsetHours = 8): string | null {
  if (!value) return null;
  const t = Date.parse(value.includes("T") ? value : value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  if (Number.isNaN(t)) return null;
  return new Date(t + offsetHours * 3600_000).toISOString().slice(0, 10);
}

/** Midnight of the given local day in UTC+8, as Python's datetime.combine(d, time.min, LOCAL_TZ).isoformat(). */
export function localMidnight(isoDate: string): string {
  return `${isoDate}T00:00:00+08:00`;
}

const DAYS_IN_MONTH = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Python 3.12 date.fromisoformat on the first 10 characters: YYYY-MM-DD, YYYYMMDD, YYYY-Www[-D], YYYYWww[D]. */
export function pyDateFromIso(raw: string): string | null {
  const s = raw.slice(0, 10);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > DAYS_IN_MONTH(y, mo)) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = /^(\d{4})-W(\d{2})(?:-(\d))?$/.exec(s) ?? /^(\d{4})W(\d{2})(\d)?$/.exec(s);
  if (m) {
    const [y, w, d] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)];
    if (w < 1 || d < 1 || d > 7) return null;
    // ISO week 1 contains Jan 4th
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const week1Monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400_000);
    const day = new Date(week1Monday.getTime() + ((w - 1) * 7 + (d - 1)) * 86400_000);
    // Weeks past the year's last ISO week are an error in Python
    const lastWeek = new Date(Date.UTC(y, 11, 28));
    const lastWeekNo = Math.ceil(((lastWeek.getTime() - week1Monday.getTime()) / 86400_000 + 1) / 7);
    if (w > lastWeekNo) return null;
    return day.toISOString().slice(0, 10);
  }
  return null;
}
