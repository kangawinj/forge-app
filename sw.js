const VERSION = "forge-pwa-v3.0.805";
const CACHE = "forge-static-v1";      // change the number to make every device drop what it saved
const SLOW_MS = 4000;                  // how long a saved copy waits for the network before being used

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// The app's own files (pages, scripts, styles, images) are kept after every successful load. They are always asked
// for from the network first, so a good connection always gets the newest version; on a slow or broken connection the
// saved copy is used after SLOW_MS instead of leaving a blank page. The Firebase and library files come from fixed,
// versioned addresses, so those are simply served from the saved copy once they have been fetched once.
// Nothing else is touched: Firestore / sign-in traffic, uploads and the calendar feed always go straight to the network,
// so recipes and accounts are never served from a saved copy.
const FIXED_HOSTS = [
  [/^https:\/\/www\.gstatic\.com\/firebasejs\//, true],
  [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\//, true]
];

self.addEventListener("fetch", event => {
  const req = event.request;
  if(req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if(url.origin === self.location.origin){
    if(url.pathname.startsWith("/calendarFeed") || url.pathname.startsWith("/__/")) return;
    event.respondWith(networkFirst(event, req));
    return;
  }
  if(FIXED_HOSTS.some(([re]) => re.test(req.url))) event.respondWith(cacheFirst(event, req));
});

async function store(cache, req, res){
  if(res && (res.ok || res.type === "opaque")) { try{ await cache.put(req, res.clone()); }catch(e){ /* storage full: just skip */ } }
  return res;
}
async function networkFirst(event, req){
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req);
  const net = fetch(req).then(res => { const out = res.clone(); event.waitUntil(store(cache, req, out)); return res; });
  if(!saved) return net;
  event.waitUntil(net.catch(() => {}));
  return Promise.race([
    net.catch(() => saved),
    new Promise(resolve => setTimeout(() => resolve(saved), SLOW_MS))
  ]);
}
async function cacheFirst(event, req){
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req);
  if(saved) return saved;
  const res = await fetch(req);
  event.waitUntil(store(cache, req, res.clone()));
  return res;
}

self.addEventListener("message", event => {
  if (event.data === "GET_VERSION") {
    event.source?.postMessage({ type: "SW_VERSION", version: VERSION });
  }
});
