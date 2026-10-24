import pytest
from httpx import ASGITransport, AsyncClient
from server.main import app


@pytest.mark.asyncio
async def test_etag_header_generated_on_get():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health")
        assert res.status_code == 200
        etag = res.headers.get("etag")
        assert etag is not None
        assert etag.startswith('"') and etag.endswith('"')

        # Conditional GET with matching ETag should return 304 Not Modified
        res_304 = await client.get("/health", headers={"if-none-match": etag})
        assert res_304.status_code == 304
        assert res_304.text == ""
        assert res_304.headers.get("etag") == etag

        # Conditional GET with non-matching ETag should return 200 OK
        res_200 = await client.get("/health", headers={"if-none-match": '"non_matching_etag"'})
        assert res_200.status_code == 200
        assert res_200.json().get("status") == "ok"
