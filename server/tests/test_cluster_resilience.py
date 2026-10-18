"""Tests for cluster connection resilience and transient error retry."""

import asyncio
from unittest.mock import AsyncMock
import pytest
import redis.asyncio as aioredis

from server.services.cluster import Cluster


@pytest.mark.asyncio
async def test_cluster_publisher_retries_on_transient_connection_error():
    """Verify that cluster._publisher retries when redis raises a transient ConnectionError."""
    cluster = Cluster(redis_factory=lambda: None, pod_id="test-pod")
    cluster.available = True
    cluster._outbox = asyncio.Queue()

    mock_redis = AsyncMock()
    # Fail on first call with ConnectionError, then succeed
    mock_redis.publish.side_effect = [
        aioredis.ConnectionError("Connection lost"),
        1,  # success (number of receivers)
    ]
    cluster._r = mock_redis

    pub_task = asyncio.create_task(cluster._publisher())

    # Enqueue a message
    cluster.publish("test_channel", {"action": "hello"})

    # Wait for the queue to drain
    await asyncio.wait_for(cluster.flush(timeout=2.0), timeout=3.0)

    pub_task.cancel()
    await asyncio.gather(pub_task, return_exceptions=True)

    # Verify publish was called twice (initial failed + 1 successful retry)
    assert mock_redis.publish.call_count == 2
