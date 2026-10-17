#!/usr/bin/env python3
"""Download the city-level GeoIP database that gives share views a location.

    python3 scripts/fetch_geoip.py [DEST] [YYYY-MM]

With MAXMIND_LICENSE_KEY set it fetches MaxMind GeoLite2-City; otherwise the
free DB-IP city-lite database (CC BY 4.0, credited in the share dialog),
falling back to the previous month while the new one isn't published yet.
DEST defaults to server/data/geoip/GeoLite2-City.mmdb, which docker-compose
mounts at /data/geoip; the server image gets it at build time (GEOIP_MONTH).
"""

from __future__ import annotations

import datetime
import gzip
import io
import os
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_DEST = Path(__file__).resolve().parents[1] / "server" / "data" / "geoip" / "GeoLite2-City.mmdb"
MMDB_MARKER = b"\xab\xcd\xefMaxMind.com"  # metadata section marker every .mmdb ends with


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "memento-geoip-fetch"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        return resp.read()


def _months(month: str) -> list[str]:
    first = datetime.date.fromisoformat(f"{month}-01") if month else datetime.date.today().replace(day=1)
    previous = (first - datetime.timedelta(days=1)).replace(day=1)
    return [first.strftime("%Y-%m"), previous.strftime("%Y-%m")]


def _dbip(month: str) -> bytes:
    for ym in _months(month):
        url = f"https://download.db-ip.com/free/dbip-city-lite-{ym}.mmdb.gz"
        try:
            data = gzip.decompress(_fetch(url))
            print(f"DB-IP city-lite {ym}")
            return data
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            print(f"{ym} not published yet")
    raise SystemExit("no DB-IP database available for the last two months")


def _maxmind(key: str) -> bytes:
    url = f"https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key={key}&suffix=tar.gz"
    with tarfile.open(fileobj=io.BytesIO(_fetch(url))) as tar:
        member = next(m for m in tar.getmembers() if m.name.endswith("GeoLite2-City.mmdb"))
        print("MaxMind GeoLite2-City")
        return tar.extractfile(member).read()


def main() -> None:
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DEST
    month = sys.argv[2] if len(sys.argv) > 2 else ""
    key = os.environ.get("MAXMIND_LICENSE_KEY")
    data = _maxmind(key) if key else _dbip(month)
    if len(data) < 10_000_000 or MMDB_MARKER not in data[-200_000:]:
        raise SystemExit(f"downloaded file doesn't look like a city .mmdb ({len(data)} bytes)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    print(f"wrote {dest} ({len(data) // 1_000_000} MB)")


if __name__ == "__main__":
    main()
