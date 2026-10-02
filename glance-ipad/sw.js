/* Offline cache for Glance for iPad. Bump VERSION when shell files change. */
const VERSION = 'glance-ipad-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/face-api.js',
  'vendor/models/tiny_face_detector_model-weights_manifest.json',
  'vendor/models/tiny_face_detector_model.bin',
  'vendor/models/face_landmark_68_model-weights_manifest.json',
  'vendor/models/face_landmark_68_model.bin',
  'vendor/models/face_recognition_model-weights_manifest.json',
  'vendor/models/face_recognition_model.bin',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('glance-ipad-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});
// Cache-first for the shell and models; network fallback. Same-origin GETs only.
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
