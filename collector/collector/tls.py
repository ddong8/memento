"""Process-wide TLS trust store, built once at import.

The desktop app ships this package inside a PyInstaller *one-file* binary,
whose bootloader unpacks the bundle — including certifi's ``cacert.pem`` —
into ``/var/folders/.../T/_MEIxxxxxx``. macOS periodically reaps files under
``/var/folders`` that haven't been read for a few days, and the collector is
meant to stay up for weeks.

Building an ``httpx`` client per request re-reads ``cacert.pem`` every single
time, so once the reaper deletes it every request raises a bare
``FileNotFoundError: [Errno 2] No such file or directory`` (no filename — it
surfaces from OpenSSL, not Python's ``open``). That is especially nasty in
``_poll_commands``, which swallows exceptions: the collector would keep
running and syncing via its long-lived client while silently going deaf to
every server command (resync / update) with nothing in the log.

Reading the bundle into memory here touches the file exactly once, at startup,
while it is still guaranteed to exist.
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
