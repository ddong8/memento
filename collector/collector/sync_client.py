"""HTTP sync client — uploads queued items to the server, with chunked upload for large files."""

from __future__ import annotations

import json
import logging
import threading
import time

import httpx

from .config import CollectorConfig
from .queue import QueueItem, SyncQueue

logger = logging.getLogger("collector.sync")

CHUNK_SIZE = 2 * 1024 * 1024  # 2MB per chunk


class SyncClient:
    """Background worker that drains the queue and uploads to the server."""

    def __init__(self, queue: SyncQueue, config: CollectorConfig) -> None:
        self._queue = queue
        self._config = config
        self._running = False
        self._thread: threading.Thread | None = None
        try:
            from importlib.metadata import version
            collector_version = version("memento-brain-collector")
        except Exception:
            collector_version = "dev"

        from concurrent.futures import ThreadPoolExecutor
        # 10 concurrent uploads: network upload is IO-bound, doubling worker
        # count roughly halves drain time on big resyncs. Server-side 24-slot
        # ingest semaphore + 32 DB pool keep headroom for 2-3 devices each at 10.
        self._pool = ThreadPoolExecutor(max_workers=10)
        self._client = httpx.Client(
            base_url=config.server.url,
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            headers={
                "X-Collector-Token": config.server.token,
                "X-Device-Id": config.device_id,
                "X-Device-Name": config.device_name,
                "X-Device-Platform": config.platform,
                "X-Collector-Version": collector_version,
            },
        )

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="sync-worker")
        self._thread.start()
        logger.info("Sync client started (server: %s)", self._config.server.url)

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=10)
        self._pool.shutdown(wait=False)
        self._client.close()
        logger.info("Sync client stopped")

    def _run(self) -> None:
        from concurrent.futures import as_completed
        backoff = 1.0
        while self._running:
            try:
                items = self._queue.peek_batch(self._config.batch_size)
                if not items:
                    time.sleep(self._config.sync_interval)
                    backoff = 1.0
                    continue

                # Upload items concurrently (reuse persistent thread pool)
                synced = 0
                futures = {
                    self._pool.submit(self._upload, item): item
                    for item in items
                    if self._running
                }
                for future in as_completed(futures):
                    item = futures[future]
                    try:
                        if future.result():
                            self._queue.mark_synced(item.id)
                            synced += 1
                        else:
                            self._queue.mark_failed(item.id)
                    except Exception:
                        self._queue.mark_failed(item.id)

                if synced == 0 and items:
                    time.sleep(min(backoff, 30.0))
                    backoff = min(backoff * 2, 30.0)
                else:
                    backoff = 1.0

                self._queue.cleanup_synced()

            except Exception:
                logger.exception("Sync worker error")
                time.sleep(min(backoff, 60.0))
                backoff *= 2

    def _upload(self, item: QueueItem) -> bool:
        """Upload a single queue item. Auto-selects strategy based on size."""
        payload = {
            "tool": item.tool_name,
            "category": item.category,
            "content_type": item.content_type,
            "relative_path": item.relative_path,
            "hash": item.content_hash,
            "mode": "delta" if item.is_partial else "full",
            "offset": item.offset,
            "file_size": item.file_size,
            "sync_strategy": item.sync_strategy,
            "metadata": item.metadata,
            "timestamp": item.created_at,
        }

        try:
            content_bytes = item.content.encode("utf-8")
            size = len(content_bytes)

            if size <= self._config.large_file_threshold:
                # Small file: JSON payload
                payload["content"] = item.content
                return self._upload_json(payload)
            elif size <= CHUNK_SIZE:
                # Medium file: single multipart upload
                return self._upload_multipart(payload, content_bytes)
            else:
                # Large file: chunked upload
                return self._upload_chunked(payload, content_bytes)

        except httpx.ConnectError:
            logger.warning("Server unreachable, will retry later")
            return False
        except httpx.TimeoutException:
            logger.warning("Upload timeout for %s/%s (%d bytes)",
                           item.tool_name, item.relative_path, item.file_size)
            return False
        except Exception:
            logger.exception("Upload error for %s/%s", item.tool_name, item.relative_path)
            return False

    def _upload_json(self, payload: dict) -> bool:
        resp = self._client.post("/api/ingest/file", json=payload)
        if resp.status_code in (200, 201):
            return True
        logger.warning("Server %s for %s/%s: %s",
                        resp.status_code, payload["tool"], payload["relative_path"], resp.text[:200])
        return False

    def _upload_multipart(self, payload: dict, content_bytes: bytes) -> bool:
        resp = self._client.post(
            "/api/ingest/file/upload",
            data={"metadata": json.dumps(payload)},
            files={"content": ("content.txt", content_bytes, "text/plain")},
        )
        if resp.status_code in (200, 201):
            return True
        logger.warning("Server %s for multipart %s/%s",
                        resp.status_code, payload["tool"], payload["relative_path"])
        return False

    def _upload_chunked(self, payload: dict, content_bytes: bytes) -> bool:
        """Upload large files in chunks. Server reassembles."""
        total_size = len(content_bytes)
        total_chunks = (total_size + CHUNK_SIZE - 1) // CHUNK_SIZE
        upload_id = f"{payload['tool']}/{payload['relative_path']}/{payload['hash'][:8]}"

        logger.info("Chunked upload: %s (%d bytes, %d chunks)",
                     payload["relative_path"], total_size, total_chunks)

        for i in range(total_chunks):
            if not self._running:
                return False

            start = i * CHUNK_SIZE
            end = min(start + CHUNK_SIZE, total_size)
            chunk = content_bytes[start:end]

            chunk_meta = {
                **payload,
                "chunk_index": i,
                "total_chunks": total_chunks,
                "upload_id": upload_id,
            }

            resp = self._client.post(
                "/api/ingest/file/chunk",
                data={"metadata": json.dumps(chunk_meta)},
                files={"content": (f"chunk_{i}.txt", chunk, "text/plain")},
            )

            if resp.status_code not in (200, 201):
                logger.warning("Chunk %d/%d failed (%s) for %s",
                                i + 1, total_chunks, resp.status_code, payload["relative_path"])
                return False

        logger.info("Chunked upload complete: %s", payload["relative_path"])
        return True

    @property
    def is_connected(self) -> bool:
        try:
            resp = self._client.get("/api/ingest/status", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False
