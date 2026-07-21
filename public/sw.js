// Fred service worker: cache-first for static assets, network-first for pages
// with a cached fallback so the last-seen dashboards remain readable offline.
const CACHE = "fred-v2";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;

  // Cloudflare Access's own login/logout endpoints. Never intercept or cache
  // them — the sign-in round trip has to reach the network every time.
  if (url.pathname.startsWith("/cdn-cgi/")) return;

  const isStatic =
    url.pathname.startsWith("/_next/static/") ||
    /\.(png|svg|ico|webmanifest|woff2?)$/.test(url.pathname);

  if (isStatic) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((res) => {
        // Only cache genuine page responses. When an Access session expires,
        // the reply is a redirect to the login screen (an opaque redirect for
        // a navigation); caching that would pin the installed PWA to a stale
        // sign-in page. `res.ok` is false for redirects and for the 401 the
        // proxy returns, and `type === "basic"` excludes cross-origin ones.
        if (res.ok && res.type === "basic" && request.mode === "navigate") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        return hit ?? caches.match("/");
      }),
  );
});
