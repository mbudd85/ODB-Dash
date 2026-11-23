// Cache the app shell so the dashboard opens instantly; live data always comes from the server.
const CACHE = "obd-dash-v12";
const SHELL = ["./", "index.html", "style.css", "app.js", "dtc-data.js", "dtc.js", "manifest.json", "icon.svg", "map.html", "map.js", "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET" || url.pathname.startsWith("/api") || url.pathname === "/ws") return;
  // Network first, cache as fallback.
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
