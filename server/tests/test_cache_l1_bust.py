"""Every api replica keeps its own L1 copy: a delete has to drop the others' too (2026-11-14: a deleted
conversation came back in the list from the other replica's L1)."""

import pytest

from server.services import cache
from server.services.cluster import cluster


@pytest.mark.asyncio
async def test_delete_prefix_tells_the_other_replicas(monkeypatch):
    sent = []
    monkeypatch.setattr(cluster, "publish", lambda channel, message: sent.append((channel, message)))

    async def no_flush(timeout=2.0):
        return None

    monkeypatch.setattr(cluster, "flush", no_flush)
    monkeypatch.setattr(cache, "redis_client", lambda: None)
    cache.l1_cache_set("ask_conv_list:u1:all:500:0", [{"id": "gone"}], 15)

    await cache.cache_delete_prefix("ask_conv_list:u1")

    assert cache.l1_cache_get("ask_conv_list:u1:all:500:0") is None
    assert sent == [(cache._L1_BUST_CHANNEL, {"prefix": "ask_conv_list:u1"})]


def test_a_bust_from_another_replica_drops_this_ones_copy():
    cache.l1_cache_set("ask_conv_list:u2:all:500:0", [{"id": "gone"}], 15)
    cache.l1_cache_set("ask_conv_list:u3:all:500:0", [{"id": "kept"}], 15)

    # As the cluster listener delivers it
    cluster._channels[cache._L1_BUST_CHANNEL](cache._L1_BUST_CHANNEL, {"prefix": "ask_conv_list:u2", "origin": "other-pod"})

    assert cache.l1_cache_get("ask_conv_list:u2:all:500:0") is None
    assert cache.l1_cache_get("ask_conv_list:u3:all:500:0") == [{"id": "kept"}]
