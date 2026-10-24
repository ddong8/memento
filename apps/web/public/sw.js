// Memento PWA Service Worker — High performance cache-first for static assets
const CACHE_NAME = "memento-static-v1";
const STATIC_EXTENSIONS = /\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|ico)$/i;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

// Files the page fetches straight from a device over WebRTC (src/lib/p2p.ts): the page holds the data
// channel, so each read is handed to it and its bytes come back as the response (206 for ranges).
function askClient(client, msg) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 30000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    client.postMessage(msg, [channel.port2]);
  });
}

async function directResponse(event, url) {
  const key = url.pathname.split("/")[3] || "";
  const own = event.clientId ? await self.clients.get(event.clientId) : null;
  const clients = own ? [own] : await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    const res = await askClient(client, { type: "memento-p2p-read", key, range: event.request.headers.get("range") || "" });
    if (!res || res.missing) continue;
    if (res.error) return new Response(res.error, { status: 502 });
    return new Response(res.body, { status: res.status, headers: res.headers });
  }
  return new Response("direct transfer gone", { status: 404 });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin === self.location.origin && url.pathname.startsWith("/p2p/media/")) {
    event.respondWith(directResponse(event, url));
    return;
  }

  // 1. Strict Bypass: Never cache API endpoints, SSE streams, or non-GET requests
  if (
    event.request.method !== "GET" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    url.protocol.startsWith("chrome-extension")
  ) {
    return;
  }

  // 2. Cache-First for static assets (Next.js chunks, fonts, artwork, webp)
  if (STATIC_EXTENSIONS.test(url.pathname) || url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
          }
          return response;
        });
      })
    );
  }
});
