"""Conversation images are served from signed, expiring links (they used to be open to anyone)."""

from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

from server.api import media
from server.main import app
from server.services.ask_store import sanitize_turns_for_response
from server.services.storage_service import MEDIA_URL_PERIOD, media_signature_ok, sign_media_url

STORED = "/api/media/image/images/ab/abcdef.png"
NOW = 1_800_000_000.0


def _parts(url: str):
    q = parse_qs(urlsplit(url).query)
    return urlsplit(url).path, int(q["exp"][0]), q["sig"][0]


def test_signed_link_lasts_one_to_two_weeks_and_is_stable_within_a_week():
    path, exp, sig = _parts(sign_media_url(STORED, now=NOW))
    assert path == STORED
    assert MEDIA_URL_PERIOD <= exp - NOW <= 2 * MEDIA_URL_PERIOD
    assert sign_media_url(STORED, now=NOW + 60) == sign_media_url(STORED, now=NOW)
    key = path[len("/api/media/image/"):]
    assert media_signature_ok(key, exp, sig, now=NOW)
    assert not media_signature_ok(key, exp, sig, now=exp + 1)
    assert not media_signature_ok(key, exp + 1, sig, now=NOW)
    assert not media_signature_ok("images/ab/other.png", exp, sig, now=NOW)
    # the key with or without the images/ prefix is the same image
    assert media_signature_ok("ab/abcdef.png", exp, sig, now=NOW)


def test_other_values_are_left_alone():
    for v in ("data:image/png;base64,AAAA", "https://example.com/x.png", None, 3):
        assert sign_media_url(v) == v


def test_turns_sent_to_clients_carry_signed_links():
    out = sanitize_turns_for_response([{"role": "user", "content": "看图", "images": [STORED]}])
    assert out[0]["images"][0].startswith(STORED + "?exp=")


def _get(url: str, **headers):
    with patch.object(media, "get_bytes", AsyncMock(return_value=(b"PNG", "image/png"))):
        return TestClient(app).get(url, headers=headers)


def test_route_needs_a_valid_signature_or_a_signed_in_user():
    r = _get(sign_media_url(STORED))
    assert r.status_code == 200 and r.content == b"PNG"
    assert "private" in r.headers["cache-control"]
    assert _get(STORED).status_code == 403
    path, exp, _ = _parts(sign_media_url(STORED))
    assert _get(f"{path}?exp={exp}&sig=00000000000000000000000000000000").status_code == 403
    assert _get(STORED, Authorization="Bearer not-a-token").status_code == 401
