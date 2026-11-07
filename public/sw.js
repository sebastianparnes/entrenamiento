// Service worker: app usable sin conexión + caché de mapas y rutas.
const VERSION = 'pedal-v7';
const SHELL = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest',
  '/js/app.js', '/js/util.js', '/js/store.js', '/js/routes.js', '/js/recorder.js', '/js/stats.js', '/js/gpx.js', '/js/share.js', '/js/native.js', '/js/nav.js', '/js/maneuvers.js',
  '/vendor/capacitor.js', '/vendor/leaflet.js', '/vendor/leaflet.css', '/vendor/gifenc.esm.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];
const TILE_HOSTS = /fonts\.(googleapis|gstatic)\.com$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'tiles' && k !== 'api') await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.test(url.hostname) || (url.origin === self.location.origin && url.pathname.startsWith('/tiles/'))) {
    e.respondWith((async () => {
      const c = await caches.open('tiles');
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); if (Math.random() < 0.05) trim('tiles', 1500); }
      return res;
    })());
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/sync') return;
    // red primero; si no hay señal, lo último que tengamos
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (url.pathname === '/api/route' || url.pathname === '/api/weather')) {
          const c = await caches.open('api'); c.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        if (hit) return hit;
        return new Response(JSON.stringify({ error: 'Sin conexión' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // app: devolvemos lo cacheado y actualizamos en segundo plano
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? '/index.html' : req;
    const hit = await c.match(key);
    const net = fetch(req).then(res => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Sin conexión', { status: 503 });
  })());
});
