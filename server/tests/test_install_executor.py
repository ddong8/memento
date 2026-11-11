"""The executor setup script comes back with the address it was fetched from as its default server."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.api.install_bootstrap import router


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_the_script_defaults_to_the_public_address_behind_the_ingress():
    r = _client().get("/install/executor.sh", headers={"x-forwarded-proto": "https", "x-forwarded-host": "mem.example.com"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/x-shellscript")
    assert 'SERVER="${MEMENTO_SERVER:-https://mem.example.com}"' in r.text
    assert "__MEMENTO_SERVER__" not in r.text


def test_a_strange_host_header_doesnt_get_into_the_script():
    r = _client().get("/install/executor.sh", headers={"host": "evil$(id)`x`"})
    assert 'SERVER="${MEMENTO_SERVER:-http://evilidx}"' in r.text


def test_without_a_host_the_script_asks_for_server():
    r = _client().get("/install/executor.sh", headers={"x-forwarded-proto": "gopher", "x-forwarded-host": "a"})
    assert 'SERVER="${MEMENTO_SERVER:-__MEMENTO_SERVER__}"' in r.text
