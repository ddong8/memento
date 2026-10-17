"""Offline GeoIP lookup — reads a MaxMind/DB-IP .mmdb file from disk.

Reads ``MEMENTO_GEOIP_DB`` (default ``/data/geoip/GeoLite2-City.mmdb``) at
first use and keeps the reader open in-memory. If the file is missing or
corrupt, ``lookup()`` returns an empty dict — callers treat that as
"country/region/city unknown" and still record the raw IP.

The file format is the same between:
  - MaxMind's GeoLite2-City (free, needs license key to download)
  - db-ip.com's dbip-city-lite (free, no signup)

scripts/fetch_geoip.py downloads either; the code doesn't care which
source you used.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger("geoip")

_DB_PATH = Path(os.environ.get("MEMENTO_GEOIP_DB", "/data/geoip/GeoLite2-City.mmdb"))
_reader: Any = None
_load_attempted = False


def _get_reader():
    """Lazy-load the mmdb reader. Cache success OR failure so we don't
    retry on every request."""
    global _reader, _load_attempted
    if _load_attempted:
        return _reader
    _load_attempted = True

    if not _DB_PATH.exists():
        logger.info("GeoIP DB not found at %s — city/country lookups disabled", _DB_PATH)
        return None
    try:
        import geoip2.database  # type: ignore
    except ImportError:
        logger.warning("geoip2 library not installed — lookups disabled")
        return None
    try:
        _reader = geoip2.database.Reader(str(_DB_PATH))
        logger.info("GeoIP DB loaded from %s", _DB_PATH)
    except Exception as e:
        logger.warning("Failed to open GeoIP DB %s: %s", _DB_PATH, e)
        _reader = None
    return _reader


def lookup(ip: str | None) -> dict:
    """Return {country, region, city} for an IP, or empty dict on miss.

    Safe to call with None / '' / malformed IP / private range — never raises.
    """
    if not ip:
        return {}
    reader = _get_reader()
    if reader is None:
        return {}
    try:
        r = reader.city(ip)
    except Exception:
        return {}  # Private IP, unknown, malformed, etc.

    # Prefer zh-CN names when available; fall back to English.
    def _name(obj):
        if obj is None:
            return None
        names = getattr(obj, "names", {}) or {}
        return names.get("zh-CN") or names.get("en") or getattr(obj, "name", None)

    return {
        "country": _name(r.country),
        "region": _name(r.subdivisions.most_specific) if r.subdivisions else None,
        "city": _name(r.city),
    }
