const VERSION = "forge-pwa-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

// Network requests are intentionally not cached. Forge stores user data in
// the application itself, so this worker only enables app installation and
// lifecycle updates without risking stale recipes or authentication state.
self.addEventListener("message", event => {
  if (event.data === "GET_VERSION") {
    event.source?.postMessage({ type: "SW_VERSION", version: VERSION });
  }
});
