"""Process-wide TLS trust store, built once at import.

The desktop app ships this package inside a PyInstaller *one-file* binary,
whose bootloader unpacks the bundle — including certifi's ``cacert.pem`` —
into ``/var/folders/.../T/_MEIxxxxxx``. macOS periodically reaps files under
``/var/folders`` that haven't been read for a few days, and an MCP server
process attached to an editor stays up far longer than that.

Building an ``httpx`` client per request re-reads ``cacert.pem`` every single
time, so the moment the reaper deletes it every request starts failing with a
bare ``FileNotFoundError: [Errno 2] No such file or directory`` (no filename —
it surfaces from OpenSSL, not Python's ``open``). Symptom: the MCP tools work
for days, then abruptly return "Failed to list projects: [Errno 2] ...".

Reading the bundle into memory here touches the file exactly once, at startup,
while it is still guaranteed to exist. Every client we hand out afterwards
verifies against the in-memory copy and never goes back to disk.
"""

from __future__ import annotations

import ssl


def _build_ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        with open(certifi.where(), encoding="ascii") as fh:
            # `cadata=` keeps the trust store in memory. Passing it also stops
            # create_default_context() from calling load_default_certs().
            return ssl.create_default_context(cadata=fh.read())
    except Exception:
        # No certifi, or the bundle is already gone — fall back to whatever
        # the platform trusts. Worse than certifi, still better than dying.
        return ssl.create_default_context()


SSL_CONTEXT: ssl.SSLContext = _build_ssl_context()
