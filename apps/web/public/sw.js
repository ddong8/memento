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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

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
